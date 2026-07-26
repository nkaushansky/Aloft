import * as THREE from 'three';
import { config, cruiseSpeed } from './sim/config';
import { createBirdState, cloneBirdState, lerpBirdState } from './sim/state';
import type { BirdState, FlightInput } from './sim/types';
import { ProceduralTerrain, findLaunchSite } from './sim/terrain';
import { ProceduralBiomes } from './sim/biome';
import { AtmosphereField } from './sim/wind';
import { SkyModel, phaseLabel, phaseDescription } from './sim/sky';
import { stepFlight } from './sim/flight';
import { Flock } from './sim/flock';
import { seedFromString, nameFromSeed } from './sim/noise';
import { clamp01, smoothstep } from './sim/math';

import { Renderer } from './render/renderer';
import { InputManager } from './input';
import { Session } from './game/session';
import type { RunMode } from './game/session';
import { AdaptiveQuality, QUALITY_ORDER, detectQuality, qualityFor } from './game/quality';
import type { QualityTier } from './sim/types';
import { AudioEngine } from './audio';
import { Hud } from './ui/hud';
import { TitleScreen, SummaryScreen } from './ui/screens';
import { TouchControls } from './ui/touchControls';

/**
 * Wiring, and nothing else. Every decision that matters lives in sim/ or in
 * the module it belongs to; this file's whole job is to run the clock in the
 * right order and hand each subsystem the one thing it needs.
 *
 * The loop is a fixed 60 Hz simulation with render interpolation, inherited
 * from the original Aloft: flight feel must not change with framerate, and a
 * 144 Hz display must not get a stuttery bird.
 */

const container = document.getElementById('app') as HTMLElement;
const bootEl = document.getElementById('boot') as HTMLElement;
const bootBar = bootEl.querySelector('.boot-bar i') as HTMLElement;
const bootNote = document.getElementById('boot-note') as HTMLElement;

function boot(pct: number, note?: string): void {
  bootBar.style.width = `${Math.round(clamp01(pct) * 100)}%`;
  if (note) bootNote.textContent = note;
}

// --------------------------------------------------------------- the world

/** A seed in the URL means a shared sky: ?seed=GLASSWING or ?seed=20873. */
function seedFromUrl(): number | null {
  const raw = new URLSearchParams(location.search).get('seed');
  if (!raw) return null;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return seedFromString(raw.toUpperCase());
}

const urlSeed = seedFromUrl();
if (urlSeed !== null) config.seed = urlSeed;

const params = new URLSearchParams(location.search);
/**
 * ?quality=ultra pins a tier and ?noadapt=1 stops the monitor demoting it.
 * Both exist for the screenshot harness: it runs on a software rasteriser, so
 * the adaptive monitor would honestly (and uselessly) drop it to 'low' and
 * every reference frame would be of a game nobody plays.
 */
const forcedTier = params.get('quality') as QualityTier | null;
const noAdapt = params.get('noadapt') === '1';

boot(0.08, 'shaping the ground');

const terrain = new ProceduralTerrain(config);
const biomes = new ProceduralBiomes(config, terrain);
const wind = new AtmosphereField(config, terrain, biomes);
const sky = new SkyModel(config);
const flock = new Flock(config, terrain, wind, config.seed);

boot(0.24, 'reading the air');

const quality = qualityFor(
  forcedTier && QUALITY_ORDER.includes(forcedTier) ? forcedTier : detectQuality(),
);
const renderer = new Renderer(container, config, terrain, biomes, wind, quality);
const input = new InputManager(container, () => mouseFlying);
const audio = new AudioEngine(config);

boot(0.42, 'lighting the sky');

// --------------------------------------------------------------- the shell

const hudLayer = document.createElement('div');
hudLayer.className = 'layer';
hudLayer.id = 'hud';
document.body.appendChild(hudLayer);

const titleLayer = document.createElement('div');
titleLayer.className = 'layer interactive';
titleLayer.id = 'title';
document.body.appendChild(titleLayer);

const summaryLayer = document.createElement('div');
summaryLayer.className = 'layer interactive';
summaryLayer.id = 'summary';
summaryLayer.style.display = 'none';
document.body.appendChild(summaryLayer);

const hud = new Hud(hudLayer, config);

// The wing pads only exist where there is no Shift key to hold.
const isTouch = matchMedia('(pointer: coarse)').matches;
const touchLayer = document.createElement('div');
touchLayer.className = 'layer';
document.body.appendChild(touchLayer);
const touchControls = new TouchControls(touchLayer, input.buttons);
touchControls.setVisible(false);
const title = new TitleScreen(titleLayer);
const summary = new SummaryScreen(summaryLayer);

let mouseFlying = false;

// -------------------------------------------------------------- the session

const session = new Session(config, terrain, {
  onNote: (text) => {
    if (text) hud.note(text);
  },
  onDayPhaseChange: (p) => {
    hud.banner(phaseLabel(p), phaseDescription(p));
    audio.cue('phase');
  },
  onCompanions: (gained, total) => {
    flock.grant(gained);
    audio.cue('companion');
    void total;
  },
  onLanded: (stats) => {
    audio.cue('landing');
    summaryLayer.style.display = '';
    summary.show(stats, session.verdict(), session.runTitle(), session.logbook.all());
    hud.setVisible(false);
    touchControls.setVisible(false);
  },
});

// ----------------------------------------------------------------- the bird

let current: BirdState = createBirdState(config);
let previous: BirdState = cloneBirdState(current);
const drawn: BirdState = cloneBirdState(current);

/** Put the bird on the launch ridge for the current seed. */
function placeAtLaunch(): void {
  const site = findLaunchSite(terrain, config);
  const y = site.groundHeight + config.launchAltitude;
  current = createBirdState(config, site.x, y, site.z);
  // Launch pointed along the ridge, not into it — the first thing you see
  // should be the spine of the range running away under your wing.
  current.yaw = Math.atan2(-site.ridgeDirX, -site.ridgeDirZ);
  previous = cloneBirdState(current);
  renderer.chase.snap(current);
}

// ------------------------------------------------------------- run control

let launchBlend = 0;
let landingFade = 0;

function startRun(mode: RunMode): void {
  sky.setTime(mode === 'drift' ? 0.72 : config.startTimeOfDay);
  sky.setAuto(mode !== 'drift');
  wind.update(0, sky.state);
  flock.reset();
  placeAtLaunch();
  session.begin(current, config.seed, mode);
  // A few birds are already up when you launch — otherwise a flight that never
  // climbs never meets the flock at all.
  flock.grant(config.flockAtLaunch);
  launchBlend = 0;
  landingFade = 0;
  title.hide();
  summaryLayer.style.display = 'none';
  summary.hide();
  hud.setVisible(true);
  touchControls.setVisible(isTouch);
  renderer.setBirdVisible(true);
  renderer.chase.setMode('launch');
  renderer.chase.setBlend(0);
  renderer.setFade(1);
  void audio.start();
  audio.cue('launch');
}

function toTitle(): void {
  session.setPhase('title');
  hud.setVisible(false);
  touchControls.setVisible(false);
  summaryLayer.style.display = 'none';
  summary.hide();
  placeAtLaunch();
  renderer.setBirdVisible(false);
  renderer.setFade(0);
  renderer.chase.setMode('orbit', {
    target: new THREE.Vector3(current.position.x, current.position.y - config.launchAltitude * 0.55, current.position.z),
    radius: 900,
  });
  title.show({
    seed: config.seed,
    seedName: nameFromSeed(config.seed),
    best: session.logbook.best(),
    isTouch,
  });
}

function newSeed(seed?: number): void {
  config.seed = seed ?? 1 + Math.floor(Math.random() * 99999);
  renderer.rebuildWorld();
  flock.reset();
  toTitle();
}

title.onBegin((mode) => startRun(mode));
title.onNewSeed(() => newSeed());
title.onSeedEntry((s) => newSeed(s));
title.onLogbook(() => {
  summaryLayer.style.display = '';
  summary.show(Session.blankStats(config.seed), '', 'Logbook', session.logbook.all());
});
summary.onAgain(() => startRun(session.mode));
summary.onNewWorld(() => {
  newSeed();
  startRun('crossing');
});
summary.onTitle(() => toTitle());

// ------------------------------------------------------------------- keys

input.keyboard.onKey('KeyM', () => audio.setMuted(!audio.muted));
input.keyboard.onKey('KeyR', () => {
  if (session.phase === 'flying' || session.phase === 'launching') startRun(session.mode);
});
input.keyboard.onKey('Escape', () => {
  if (session.phase === 'flying' || session.phase === 'launching') toTitle();
});
input.keyboard.onKey('KeyC', () => {
  mouseFlying = !mouseFlying;
  hud.note(mouseFlying ? 'mouse flying on' : 'mouse flying off');
});
input.keyboard.onKey('KeyH', () => hudLayer.classList.toggle('hidden'));
input.keyboard.onKey('F3', () => perfEl.classList.toggle('hidden'));
input.gamepad.onButton(9, () => {
  if (session.phase === 'title') startRun('crossing');
});

const perfEl = document.createElement('div');
perfEl.className = 'perf hidden';
perfEl.style.display = 'none';
hudLayer.appendChild(perfEl);

// Audio needs a real gesture. Any of these will do.
const wake = (): void => {
  void audio.start();
};
window.addEventListener('pointerdown', wake, { once: true });
window.addEventListener('keydown', wake, { once: true });

// ------------------------------------------------------------------- loop

const SIM_DT = 1 / 60;
/** Never simulate more than this many steps in one frame — a tab that was
 *  backgrounded for a minute must not spend ten seconds catching up. */
const MAX_STEPS = 6;

let accumulator = 0;
let last = performance.now();
let frames = 0;
let fpsAccum = 0;
let fps = 0;

/** Seconds before the boot screen lifts regardless of streaming progress. */
const BOOT_TIMEOUT = 12;
let bootElapsed = 0;

const adaptive = new AdaptiveQuality(quality.tier, (q) => renderer.setQuality(q));
const scratchInput: FlightInput = { pitch: 0, roll: 0, tuck: 0, spread: 0 };
let booted = false;

function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;

  // --- boot gate: hold the curtain until the world under us actually exists
  if (!booted) {
    bootElapsed += dt;
    const worldReady = renderer.worldReady;
    // The curtain comes up on a timer as well as on readiness. A device slow
    // enough to still be streaming after BOOT_TIMEOUT is a device that should
    // be flying in a half-built world rather than staring at a progress bar
    // forever — the terrain keeps filling in behind the title screen anyway.
    const timedOut = bootElapsed > BOOT_TIMEOUT;
    boot(
      worldReady ? 1 : Math.min(0.95, 0.35 + bootElapsed / BOOT_TIMEOUT * 0.6),
      worldReady ? 'ready' : 'building the sky',
    );
    renderer.render(dt, current, sky.state, flock.birds);
    if (worldReady || timedOut) {
      booted = true;
      bootEl.classList.add('gone');
      setTimeout(() => bootEl.remove(), 1300);
      toTitle();
    }
    return;
  }

  const flying = session.phase === 'flying' || session.phase === 'launching' || session.phase === 'landing';

  // --- the day turns even on the title screen, so the menu is never static
  sky.update(session.phase === 'summary' ? dt * 0.15 : dt);
  wind.setFocus(current.position.x, current.position.z);
  wind.update(dt, sky.state);

  // --- input -----------------------------------------------------------
  const controls = flying ? input.update(dt) : zeroInput(input.update(dt));

  // --- fixed-step sim ----------------------------------------------------
  if (flying) {
    accumulator += dt;
    let steps = 0;
    while (accumulator >= SIM_DT && steps < MAX_STEPS) {
      const prev = previous;
      previous = current;
      current = stepFlight(previous, controls, SIM_DT, config, terrain, wind, prev);
      accumulator -= SIM_DT;
      steps++;
    }
    if (steps === MAX_STEPS) accumulator = 0;
  } else {
    accumulator = 0;
    previous = current;
  }

  const alpha = flying ? clamp01(accumulator / SIM_DT) : 1;
  lerpBirdState(previous, current, alpha, drawn);

  // --- the launch sweep ---------------------------------------------------
  if (session.phase === 'launching') {
    launchBlend = Math.min(1, launchBlend + dt / 3.4);
    renderer.chase.setBlend(launchBlend);
    renderer.setFade(1 - smoothstep(0, 0.35, launchBlend));
    if (launchBlend >= 1) {
      renderer.chase.setMode('chase');
      session.setPhase('flying');
    }
  }

  // --- session accounting -------------------------------------------------
  if (flying) {
    session.update(dt, current, sky.state, flock.count);
    flock.update(dt, drawn, sky.state);

    const readiness = session.landingReadiness(drawn);
    if (readiness > 0.4 && session.phase === 'flying') session.setPhase('landing');
    else if (readiness < 0.2 && session.phase === 'landing' && !current.landed) session.setPhase('flying');

    if (current.landed) {
      landingFade = Math.min(1, landingFade + dt / 2.2);
      renderer.chase.setMode('landing');
      renderer.setVignette(0.28 + landingFade * 0.45);
    }

    hud.update(dt, drawn, sky.state, {
      distance: session.stats.distance,
      flock: flock.count,
      landingReadiness: readiness,
    });
  }

  hud.tint(sky.state);
  audio.update(dt, drawn, sky.state, flock.count);
  renderer.render(dt, drawn, sky.state, flock.birds);

  // --- perf ----------------------------------------------------------------
  if (!noAdapt) adaptive.sample(dt);
  frames++;
  fpsAccum += dt;
  if (fpsAccum >= 0.5) {
    fps = frames / fpsAccum;
    frames = 0;
    fpsAccum = 0;
    if (!perfEl.classList.contains('hidden')) {
      perfEl.textContent =
        `${fps.toFixed(0)} fps · ${adaptive.tier}\n` +
        `alt ${drawn.position.y.toFixed(0)} m · agl ${drawn.agl.toFixed(0)} m\n` +
        `ias ${drawn.airspeed.toFixed(1)} · cruise ${cruiseSpeed(config, drawn.wing).toFixed(1)}\n` +
        `air ${drawn.airKind} @ ${drawn.airIntensity.toFixed(2)} · turb ${drawn.turbulence.toFixed(2)}\n` +
        `thermals ${wind.thermals().length} · waves ${wind.waves().length} · flock ${flock.count}`;
    }
  }
}

function zeroInput(i: FlightInput): FlightInput {
  scratchInput.pitch = 0;
  scratchInput.roll = 0;
  scratchInput.tuck = 0;
  scratchInput.spread = 0;
  void i;
  return scratchInput;
}

requestAnimationFrame(frame);

// Handy hooks for automated flight tests and for poking at a world from the
// console. Harmless in play, and the only way to verify feel without hands.
declare global {
  interface Window {
    __aloft?: Record<string, unknown>;
  }
}
window.__aloft = {
  state: () => current,
  config,
  sky: () => sky.state,
  session,
  wind,
  terrain,
  biomes,
  flock,
  start: (mode: RunMode = 'crossing') => startRun(mode),
  setTime: (t: number) => sky.setTime(t),
  setSeed: (s: number) => newSeed(s),
  fps: () => fps,
  booted: () => booted,
  phase: () => session.phase,
  worldReady: () => renderer.worldReady,
};
