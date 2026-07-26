import type { Config } from '../sim/config';
import type { BirdState, SkyState, Vec3 } from '../sim/types';
import { AirKind } from '../sim/types';
import { airKindColor, airKindLabel } from '../sim/wind';
import { speedToFly } from '../sim/flight';
import { phaseLabel, timeLabel } from '../sim/sky';
import { clamp, clamp01, damp } from '../sim/math';

/**
 * INSTRUMENTS, NOT WIDGETS.
 *
 * This is a soaring game, so the interface borrows from real sailplane
 * instruments: a vertical variometer tape, a speed scale with a target bug, an
 * altitude column, a compass strip. Thin rules, mono numerals, a lot of empty
 * space.
 *
 * Two things make it feel like part of the world rather than pasted on top:
 *
 *   It is TINTED BY THE SKY. tint() rewrites four CSS custom properties every
 *   frame from the sky state, so the instruments go warm at golden hour and
 *   indigo at dusk. Nothing here is a fixed colour fighting the frame behind
 *   it.
 *
 *   The VARIO IS COLOURED BY THE AIR. The bar takes the colour of whatever
 *   kind of air you are in, so the instrument tells you *what* as well as
 *   *how fast* — and a pilot learns to recognise the cyan of wave before they
 *   have read a single word about it.
 *
 * Performance: every element is cached at construction and only written when
 * the value it displays actually changed. Layout thrash at 60 fps is a real
 * bug, not a nicety.
 */

/** Vario scale, m/s. Anything past this pins the needle, which is fine — a
 *  6 m/s climb is already a very good day. */
const VARIO_RANGE = 6;
/** Seconds of damping on the displayed climb rate. Real varios are damped over
 *  a couple of seconds; an undamped one is unreadable noise. */
const VARIO_LAMBDA = 1.9;
/** Seconds a transient note stays up. */
const NOTE_TIME = 4.2;
/** Seconds a phase banner stays up. */
const BANNER_TIME = 7;

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

export class Hud {
  private readonly root: HTMLElement;
  private readonly cfg: Config;

  // vario
  private readonly varioFill: HTMLElement;
  private readonly varioNeedle: HTMLElement;
  private readonly varioNum: HTMLElement;
  private readonly varioKind: HTMLElement;
  private readonly varioEl: HTMLElement;
  private readonly varioBar: HTMLElement;

  // corners
  private readonly speedValue: HTMLElement;
  private readonly speedBar: HTMLElement;
  private readonly speedFill: HTMLElement;
  private readonly speedBug: HTMLElement;
  private readonly speedSub: HTMLElement;
  private readonly altValue: HTMLElement;
  private readonly altSub: HTMLElement;
  private readonly distValue: HTMLElement;
  private readonly clockEl: HTMLElement;
  private readonly phaseEl: HTMLElement;
  private readonly flockEl: HTMLElement;
  private readonly flockWrap: HTMLElement;

  // wing
  private readonly wingMark: HTMLElement;
  private readonly wingTuck: HTMLElement;
  private readonly wingSpread: HTMLElement;

  // compass
  private readonly compassTape: HTMLElement;
  private readonly compassWind: HTMLElement;

  // transient
  private readonly noteEl: HTMLElement;
  private readonly bannerEl: HTMLElement;
  private readonly bannerPhase: HTMLElement;
  private readonly bannerLine: HTMLElement;

  private varioValue = 0;
  private noteTimer = 0;
  private bannerTimer = 0;
  private landingShown = false;

  /** Last written string per field, so we never touch the DOM for no reason. */
  private readonly last = new Map<string, string>();

  constructor(parent: HTMLElement, cfg: Config) {
    this.root = parent;
    this.cfg = cfg;

    // ---------------------------------------------------------- vario
    this.varioEl = el('div', 'vario');
    const scale = el('div', 'vario-scale');
    // Ticks every 1 m/s, majors every 2, and a heavier rule at zero — the
    // line you are actually trying to stay above.
    for (let v = -VARIO_RANGE; v <= VARIO_RANGE; v++) {
      const tick = el('i', v === 0 ? 'zero' : Math.abs(v) % 2 === 0 ? 'major' : '');
      tick.style.top = `${this.varioPct(v)}%`;
      scale.appendChild(tick);
    }
    this.varioBar = el('div', 'vario-bar');
    this.varioFill = el('div', 'vario-fill');
    this.varioNeedle = el('div', 'vario-needle');
    this.varioNum = el('div', 'vario-num');
    this.varioKind = el('div', 'vario-kind');
    this.varioBar.append(this.varioFill, this.varioNeedle, this.varioNum, this.varioKind);
    this.varioEl.append(scale, this.varioBar);
    parent.appendChild(this.varioEl);

    // -------------------------------------------------- bottom left: speed
    const bl = el('div', 'hud-corner hud-bl');
    bl.appendChild(label('airspeed'));
    this.speedValue = el('div', 'readout-value tnum');
    bl.appendChild(this.speedValue);
    this.speedBar = el('div', 'speedbar');
    this.speedFill = el('i', '');
    this.speedBug = el('b', '');
    this.speedBar.append(this.speedFill, this.speedBug);
    bl.appendChild(this.speedBar);
    this.speedSub = el('div', 'readout-sub');
    bl.appendChild(this.speedSub);
    parent.appendChild(bl);

    // ------------------------------------------------ bottom right: height
    const br = el('div', 'hud-corner hud-br');
    br.appendChild(label('altitude'));
    this.altValue = el('div', 'readout-value tnum');
    br.appendChild(this.altValue);
    this.altSub = el('div', 'readout-sub tnum');
    br.appendChild(this.altSub);
    parent.appendChild(br);

    // ------------------------------------------------- top left: the day
    const tl = el('div', 'hud-corner hud-tl');
    tl.appendChild(label('crossed'));
    this.distValue = el('div', 'readout-value tnum');
    tl.appendChild(this.distValue);
    this.clockEl = el('div', 'readout-sub tnum');
    tl.appendChild(this.clockEl);
    this.phaseEl = el('div', 'readout-sub');
    tl.appendChild(this.phaseEl);
    parent.appendChild(tl);

    // ----------------------------------------------- top right: the flock
    const tr = el('div', 'hud-corner hud-tr');
    this.flockWrap = el('div', 'flock');
    const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    glyph.setAttribute('viewBox', '0 0 15 9');
    const gp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    // A tiny gull silhouette — the same shape the flock actually is.
    gp.setAttribute('d', 'M0,7 C3,7 5,1 7.5,1 C10,1 12,7 15,7 C12,4.6 10,3 7.5,3 C5,3 3,4.6 0,7 Z');
    glyph.appendChild(gp);
    this.flockEl = el('span', 'tnum');
    this.flockWrap.append(glyph, this.flockEl);
    this.flockWrap.style.opacity = '0';
    tr.append(label('with you'), this.flockWrap);
    parent.appendChild(tr);

    // ------------------------------------------------------------- wing
    const wing = el('div', 'wing');
    const track = el('div', 'wing-track');
    // Detents at tuck, cruise and spread, so the marker has somewhere to be.
    for (const p of [0, 50, 100]) {
      const u = el('u', '');
      u.style.left = `${p}%`;
      track.appendChild(u);
    }
    this.wingMark = el('i', '');
    track.appendChild(this.wingMark);
    const labels = el('div', 'wing-labels');
    this.wingTuck = el('span', '');
    this.wingTuck.textContent = 'tuck';
    const mid = el('span', '');
    mid.textContent = 'cruise';
    this.wingSpread = el('span', '');
    this.wingSpread.textContent = 'spread';
    labels.append(this.wingTuck, mid, this.wingSpread);
    wing.append(track, labels);
    parent.appendChild(wing);

    // ---------------------------------------------------------- compass
    const compass = el('div', 'compass');
    this.compassTape = el('div', 'compass-tape');
    // One tick every 15 degrees, built once and then only translated.
    for (let d = -360; d < 720; d += 15) {
      const t = el('div', 'compass-tick');
      const norm = ((d % 360) + 360) % 360;
      const isCardinal = norm % 45 === 0;
      if (isCardinal) t.classList.add('card');
      t.textContent = isCardinal ? CARDINALS[norm / 45] : '';
      t.appendChild(el('i', ''));
      t.style.left = `${d * COMPASS_PX_PER_DEG}px`;
      this.compassTape.appendChild(t);
    }
    this.compassWind = el('div', 'compass-wind');
    this.compassWind.textContent = '▼';
    this.compassTape.appendChild(this.compassWind);
    compass.append(this.compassTape, el('div', 'compass-centre'));
    parent.appendChild(compass);

    // -------------------------------------------------------- transient
    this.noteEl = el('div', 'note');
    parent.appendChild(this.noteEl);

    this.bannerEl = el('div', 'banner');
    this.bannerPhase = el('p', 'banner-phase');
    this.bannerLine = el('p', 'banner-line');
    this.bannerEl.append(this.bannerPhase, this.bannerLine);
    parent.appendChild(this.bannerEl);
  }

  // ------------------------------------------------------------- helpers

  /** Vertical position (0 = top, 100 = bottom) of a climb rate on the tape. */
  private varioPct(v: number): number {
    return 50 - (clamp(v, -VARIO_RANGE, VARIO_RANGE) / VARIO_RANGE) * 50;
  }

  private set(key: string, elm: HTMLElement, value: string): void {
    if (this.last.get(key) === value) return;
    this.last.set(key, value);
    elm.textContent = value;
  }

  private setStyle(key: string, elm: HTMLElement, prop: string, value: string): void {
    if (this.last.get(key) === value) return;
    this.last.set(key, value);
    elm.style.setProperty(prop, value);
  }

  // ---------------------------------------------------------------- tint

  /**
   * Rewrite the interface palette from the sky. Colours arrive linear, so
   * they get a rough gamma on the way out — the browser is compositing in
   * sRGB and the rest of the frame has already been tonemapped.
   */
  tint(sky: SkyState): void {
    const s = document.documentElement.style;
    // Text must stay legible at every hour, so the ink is the horizon colour
    // pushed hard toward white rather than the horizon colour itself.
    setVar(s, '--sky-ink', mixToward(sky.skyHorizon, 1, 0.62), 'ink');
    setVar(s, '--sky-dim', mixToward(sky.skyHorizon, 1, 0.3), 'dim');
    setVar(s, '--sky-glow', normalizeBright(sky.sunColor), 'glow');
    setVar(s, '--sky-deep', mixToward(sky.skyZenith, 0, 0.35), 'deep');
    setVar(s, '--sky-cool', mixToward(sky.ambient, 1, 0.28), 'cool');
  }

  // -------------------------------------------------------------- update

  update(
    dt: number,
    bird: BirdState,
    sky: SkyState,
    session: { distance: number; flock: number; landingReadiness: number },
  ): void {
    // --- vario ------------------------------------------------------------
    this.varioValue = damp(this.varioValue, bird.climbRate, VARIO_LAMBDA, dt);
    const v = this.varioValue;
    const zero = 50;
    const pct = this.varioPct(v);
    const top = Math.min(zero, pct);
    const height = Math.abs(zero - pct);
    this.setStyle('vf-top', this.varioFill, 'top', `${top}%`);
    this.setStyle('vf-h', this.varioFill, 'height', `${height}%`);
    this.setStyle('vn-top', this.varioNeedle, 'top', `${pct}%`);
    this.setStyle('vnum-top', this.varioNum, 'top', `${pct}%`);
    this.set('vnum', this.varioNum, `${v >= 0 ? '+' : ''}${v.toFixed(1)}`);

    // The instrument takes the colour of the air. Sink reads as the cold
    // blue-grey even when the dominant feature technically is a thermal's
    // outer ring, because what you need to know is that you are going down.
    const kind = v < -0.4 && bird.airKind === AirKind.Still ? AirKind.Sink : bird.airKind;
    const c = airKindColor(kind);
    const css = `rgb(${to255(c.r)} ${to255(c.g)} ${to255(c.b)})`;
    this.setStyle('vario-color', this.varioEl, '--vario-color', css);
    this.set('vkind', this.varioKind, airKindLabel(kind));

    // --- airspeed ---------------------------------------------------------
    this.set('ias', this.speedValue, `${bird.airspeed.toFixed(0)}`);
    const frac = clamp01(bird.airspeed / this.cfg.maxAirspeed);
    this.setStyle('ias-w', this.speedFill, 'width', `${(frac * 100).toFixed(1)}%`);

    // The speed-to-fly bug: what the air you are in actually wants. A nudge,
    // never an instruction — but chasing it is the single best thing a new
    // pilot can learn to do.
    const want = speedToFly(this.cfg, bird.liftRate, bird.wing);
    const wantFrac = clamp01(want / this.cfg.maxAirspeed);
    this.setStyle('bug', this.speedBug, 'left', `${(wantFrac * 100).toFixed(1)}%`);
    const delta = bird.airspeed - want;
    this.set(
      'ias-sub',
      this.speedSub,
      Math.abs(delta) < 3 ? 'on speed' : delta < 0 ? 'fly faster' : 'ease off',
    );
    const stalling = bird.flying < 0.6;
    if (stalling !== this.speedBar.classList.contains('stall')) {
      this.speedBar.classList.toggle('stall', stalling);
    }

    // --- altitude ---------------------------------------------------------
    this.set('alt', this.altValue, thin(Math.round(bird.position.y)));
    this.set('agl', this.altSub, `${thin(Math.max(0, Math.round(bird.agl)))} above ground`);

    // --- the day ----------------------------------------------------------
    this.set('dist', this.distValue, (session.distance / 1000).toFixed(1));
    this.set('clock', this.clockEl, timeLabel(sky.t));
    this.set('phase', this.phaseEl, phaseLabel(sky.phase).toLowerCase());

    // --- the flock --------------------------------------------------------
    this.setStyle('flock-op', this.flockWrap, 'opacity', session.flock > 0 ? '1' : '0');
    this.set('flock', this.flockEl, `${session.flock}`);

    // --- wing -------------------------------------------------------------
    const wingPct = (bird.wing * 0.5 + 0.5) * 100;
    this.setStyle('wing-left', this.wingMark, 'left', `${wingPct.toFixed(1)}%`);
    const tucking = bird.wing < -0.25;
    const spreading = bird.wing > 0.25;
    if (tucking !== this.wingTuck.classList.contains('on')) this.wingTuck.classList.toggle('on', tucking);
    if (spreading !== this.wingSpread.classList.contains('on')) {
      this.wingSpread.classList.toggle('on', spreading);
    }

    // --- compass ----------------------------------------------------------
    // yaw 0 faces -Z, which is north. Positive yaw turns left (west).
    const headingDeg = (((-bird.yaw * 180) / Math.PI) % 360 + 360) % 360;
    this.setStyle(
      'tape',
      this.compassTape,
      'transform',
      `translateX(${(-headingDeg * COMPASS_PX_PER_DEG).toFixed(1)}px)`,
    );
    // The direction the wind is travelling toward. Once you can read this you
    // can plan a whole leg around it.
    this.setStyle(
      'wind-mark',
      this.compassWind,
      'left',
      `${(this.cfg.windDirDeg * COMPASS_PX_PER_DEG + this.compassCentreOffset()).toFixed(1)}px`,
    );

    // --- transient --------------------------------------------------------
    if (this.noteTimer > 0) {
      this.noteTimer -= dt;
      if (this.noteTimer <= 0) this.noteEl.classList.remove('show');
    }
    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.bannerEl.classList.remove('show');
    }

    // The landing prompt. Offered once, quietly, when the bird is genuinely
    // in a position to settle — never nagged.
    if (session.landingReadiness > 0.45 && !this.landingShown && this.noteTimer <= 0) {
      this.landingShown = true;
      this.note('you can settle here');
    } else if (session.landingReadiness < 0.2) {
      this.landingShown = false;
    }
  }

  private compassCentreOffset(): number {
    // The tape is translated by heading, so the wind marker's own left offset
    // just needs to sit in the same coordinate space as the ticks.
    return 0;
  }

  // ------------------------------------------------------------ messages

  note(text: string): void {
    if (!text) return;
    this.noteEl.textContent = text;
    this.noteEl.classList.add('show');
    this.noteTimer = NOTE_TIME;
  }

  banner(label_: string, line: string): void {
    this.bannerPhase.textContent = label_;
    this.bannerLine.textContent = line;
    this.bannerEl.classList.add('show');
    this.bannerTimer = BANNER_TIME;
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v);
  }

  dispose(): void {
    this.root.replaceChildren();
    this.last.clear();
  }
}

// ------------------------------------------------------------------ utils

/** Pixels of compass tape per degree of heading. */
const COMPASS_PX_PER_DEG = 3.1;

function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function label(text: string): HTMLElement {
  const e = el('div', 'readout-label');
  e.textContent = text;
  return e;
}

const to255 = (v: number): number => Math.round(clamp01(Math.pow(clamp01(v), 1 / 2.2)) * 255);

/** Blend a linear colour toward black (0) or white (1) and return "R G B". */
function mixToward(c: Vec3, target: number, amount: number): string {
  const f = (x: number): number => to255(x + (target - x) * amount);
  return `${f(c.x)} ${f(c.y)} ${f(c.z)}`;
}

/**
 * The sun's hue at a usable brightness. Sun colour is HDR and at noon would
 * come out pure white, which makes a bad accent — so normalise to the
 * brightest channel and keep the hue.
 */
function normalizeBright(c: Vec3): string {
  const m = Math.max(c.x, c.y, c.z, 1e-4);
  const k = 0.98 / m;
  return `${to255(c.x * k)} ${to255(c.y * k)} ${to255(c.z * k)}`;
}

function setVar(style: CSSStyleDeclaration, name: string, value: string, cacheKey: string): void {
  const cache = setVar as unknown as Record<string, string>;
  if (cache[cacheKey] === value) return;
  cache[cacheKey] = value;
  style.setProperty(name, value);
}

/** Thin-space thousands separator, the way an altimeter would print it. */
function thin(n: number): string {
  return n.toLocaleString('en-US').replace(/,/g, ' ');
}
