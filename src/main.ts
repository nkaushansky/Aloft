import GUI from 'lil-gui';
import { config } from './sim/config';
import { AircraftState, createLaunchState } from './sim/state';
import { step } from './sim/flightModel';
import { ProceduralTerrain } from './sim/terrain';
import { Biomes } from './sim/biomes';
import { ThermalField, RidgeLift, CompositeLift } from './sim/lift';
import { Renderer } from './render/renderer';
import { ChaseCamera } from './render/chaseCamera';
import { KeyboardInput } from './input/keyboard';
import { TouchInput } from './input/touch';
import { DebugHud } from './ui/debugHud';
import { TouchButtons } from './ui/touchButtons';
import { FlightHud } from './ui/flightHud';
import { StickIndicator } from './ui/stickIndicator';
import { AudioBed } from './audio/audioBed';

// Wiring only: input -> sim.step(dt) -> render. All feel lives in sim/.

const container = document.getElementById('app')!;
const terrain = new ProceduralTerrain(config);
const biomes = new Biomes(config, terrain);
const thermals = new ThermalField(config, biomes);
const lift = new CompositeLift([thermals, new RidgeLift(config, terrain)]);
const renderer = new Renderer(container, terrain, thermals, biomes);
const chaseCam = new ChaseCamera();
const input = new KeyboardInput();
const touch = new TouchInput(container);
const hud = new DebugHud(container);
const flightHud = new FlightHud(container);
const stick = new StickIndicator(container);

let current: AircraftState = createLaunchState(config);
let previous: AircraftState = current;

const reset = () => {
  current = createLaunchState(config);
  previous = current;
  chaseCam.snap();
};
input.onKey('KeyR', reset);
input.onKey('KeyH', () => hud.toggle());

// Audio wakes on the first gesture (browser autoplay policy); M mutes.
const audio = new AudioBed();
const wake = () => audio.start();
window.addEventListener('keydown', wake, { once: true });
window.addEventListener('pointerdown', wake, { once: true });
input.onKey('KeyM', () => audio.toggleMute());

new TouchButtons(container, reset, () => audio.toggleMute());

// --- live tuning panel (a desktop tool — hidden on touch devices) ---------
const gui = new GUI({ title: 'Aloft — feel tuning' });
if (window.matchMedia('(pointer: coarse)').matches) gui.hide();
const forces = gui.addFolder('forces');
forces.add(config, 'gravity', 1, 20, 0.1);
forces.add(config, 'liftPerSpeed', 0.005, 0.08, 0.0005);
forces.add(config, 'dragCoeff', 0.0005, 0.01, 0.0001);
forces.add(config, 'settleResponse', 0.05, 1.5, 0.01);
const control = gui.addFolder('control');
control.add(config, 'inputResponse', 0.05, 1.5, 0.01);
control.add(config, 'pitchRate', 0.2, 4, 0.05);
control.add(config, 'rollRate', 0.2, 5, 0.05);
control.add(config, 'bankTurnFactor', 0, 3, 0.05);
control.add(config, 'trimPitch', -0.3, 0.1, 0.005);
control.add(config, 'pitchAutoLevel', 0, 2, 0.05);
control.add(config, 'rollAutoLevel', 0, 3, 0.05);
control.add(config, 'maxPitch', 0.3, 1.4, 0.01);
control.add(config, 'maxBank', 0.3, 1.4, 0.01);
const limits = gui.addFolder('limits & stall');
limits.add(config, 'minAirspeed', 2, 20, 0.5);
limits.add(config, 'stallRecoveryMargin', 1.0, 2.0, 0.05);
limits.add(config, 'stallNoseDrop', 0.2, 4, 0.1);
limits.add(config, 'stallDiveAngle', -1.0, 0, 0.02);
limits.add(config, 'maxAirspeed', 20, 100, 1);
const launch = gui.addFolder('launch');
launch.add(config, 'launchAltitude', 20, 400, 5);
launch.add(config, 'launchAirspeed', 5, 50, 1);
const cam = gui.addFolder('camera');
cam.add(config, 'camDistance', 4, 40, 0.5);
cam.add(config, 'camHeight', 0, 15, 0.25);
cam.add(config, 'camLerp', 0.01, 1, 0.01);
cam.add(config, 'camLookAhead', 0, 60, 1);
cam.add(config, 'camFov', 40, 100, 1);
const rebuildWorld = () => renderer.rebuildTerrain();
const world = gui.addFolder('world');
// Q7: a seed IS a map — one click deals a fresh world, same seeds rebuild it
world.add(
  {
    newWorld: () => {
      config.terrainSeed = 1 + Math.floor(Math.random() * 98);
      config.thermalSeed = 1 + Math.floor(Math.random() * 98);
      rebuildWorld();
    },
  },
  'newWorld',
);
world.add(config, 'terrainSeed', 1, 99, 1).listen().onFinishChange(rebuildWorld);
world.add(config, 'waterLevel', 0, 45, 1).onFinishChange(rebuildWorld);
world.add(config, 'terrainAmplitude', 0, 250, 5).onFinishChange(rebuildWorld);
world.add(config, 'terrainScale', 250, 2000, 25).onFinishChange(rebuildWorld);
world.add(config, 'hillHeight', 50, 500, 5).onFinishChange(rebuildWorld);
world.add(config, 'hillRadius', 150, 1200, 10).onFinishChange(rebuildWorld);
world.add(config, 'hillX', -2000, 2000, 25).onFinishChange(rebuildWorld);
world.add(config, 'hillZ', -2500, 0, 25).onFinishChange(rebuildWorld);
const air = gui.addFolder('air');
air.add(config, 'windSpeed', 0, 25, 0.5);
air.add(config, 'windDirDeg', 0, 360, 5);
air.add(config, 'windCarry', 0, 1, 0.05);
air.add(config, 'thermalCount', 0, 16, 1);
air.add(config, 'thermalSeed', 1, 99, 1);
air.add(config, 'thermalStrength', 0, 12, 0.25);
air.add(config, 'thermalRadius', 30, 300, 5);
air.add(config, 'thermalTop', 100, 900, 10);
air.add(config, 'ridgeGain', 0, 3, 0.05);
air.add(config, 'ridgeCeiling', 50, 600, 10);
const day = gui.addFolder('day & sky');
day.add(config, 'timeOfDay', 0, 1, 0.001).listen();
day.add(config, 'dayAuto');
day.add(config, 'dayLength', 60, 1800, 10);
day.add(config, 'cloudCount', 0, 16, 1);
day.add(config, 'cloudShadow', 0, 0.35, 0.01);
launch.close();
world.close();

// --- fixed-timestep loop ----------------------------------------------------
// The sim runs at a locked 60Hz; the renderer draws every animation frame,
// interpolating between the last two sim states so high-refresh displays
// stay smooth and feel is framerate-independent.
const SIM_DT = 1 / 60;
let accumulator = 0;
let lastTime = performance.now();

function lerpState(a: AircraftState, b: AircraftState, t: number): AircraftState {
  const angle = (x: number, y: number) => {
    let d = y - x;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return x + d * t;
  };
  const lerp = (x: number, y: number) => x + (y - x) * t;
  return {
    position: {
      x: lerp(a.position.x, b.position.x),
      y: lerp(a.position.y, b.position.y),
      z: lerp(a.position.z, b.position.z),
    },
    yaw: angle(a.yaw, b.yaw),
    pitch: angle(a.pitch, b.pitch),
    roll: angle(a.roll, b.roll),
    airspeed: lerp(a.airspeed, b.airspeed),
    stickPitch: lerp(a.stickPitch, b.stickPitch),
    stickRoll: lerp(a.stickRoll, b.stickRoll),
    settle: lerp(a.settle, b.settle),
    flying: lerp(a.flying, b.flying),
    lift: lerp(a.lift, b.lift),
    climbRate: lerp(a.climbRate, b.climbRate),
  };
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  // Clamp so a background tab doesn't fast-forward the sim on return.
  const frameDt = Math.min((now - lastTime) / 1000, 0.25);
  accumulator += frameDt;
  lastTime = now;

  // keyboard and touch are peers: sum and clamp, the sim never knows which
  const kb = input.read();
  const tc = touch.read();
  const controls = {
    pitch: Math.max(-1, Math.min(1, kb.pitch + tc.pitch)),
    roll: Math.max(-1, Math.min(1, kb.roll + tc.roll)),
  };
  while (accumulator >= SIM_DT) {
    previous = current;
    current = step(current, controls, SIM_DT, config, terrain, lift);
    accumulator -= SIM_DT;
  }

  if (config.dayAuto) config.timeOfDay = (config.timeOfDay + frameDt / config.dayLength) % 1;

  const alpha = accumulator / SIM_DT;
  const drawn = lerpState(previous, current, alpha);
  chaseCam.update(renderer.camera, drawn, frameDt, terrain);
  hud.update(drawn);
  flightHud.update(drawn);
  stick.update(drawn);
  audio.update(drawn);
  renderer.render(drawn, frameDt);
}

requestAnimationFrame(frame);

// Test hooks: let automated flights read state and nudge config (harmless in play).
(window as unknown as Record<string, unknown>).__aloftState = () => current;
(window as unknown as Record<string, unknown>).__aloftConfig = config;
(window as unknown as Record<string, unknown>).__aloftThermals = () => thermals.list();
(window as unknown as Record<string, unknown>).__aloftLandmarks = () => renderer.landmarks;
(window as unknown as Record<string, unknown>).__aloftBiomes = {
  sample: (x: number, z: number) => ({
    h: terrain.heightAt(x, z),
    water: biomes.isWater(x, z),
    forest: biomes.forestAt(x, z),
    dry: biomes.drynessAt(x, z),
  }),
};
