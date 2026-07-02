import GUI from 'lil-gui';
import { config } from './sim/config';
import { AircraftState, createLaunchState } from './sim/state';
import { step } from './sim/flightModel';
import { FlatTerrain } from './sim/terrain';
import { Renderer } from './render/renderer';
import { ChaseCamera } from './render/chaseCamera';
import { KeyboardInput } from './input/keyboard';
import { DebugHud } from './ui/debugHud';

// Wiring only: input -> sim.step(dt) -> render. All feel lives in sim/.

const container = document.getElementById('app')!;
const renderer = new Renderer(container);
const chaseCam = new ChaseCamera();
const input = new KeyboardInput();
const hud = new DebugHud(container);
const terrain = new FlatTerrain();

let current: AircraftState = createLaunchState(config);
let previous: AircraftState = current;

input.onKey('KeyR', () => {
  current = createLaunchState(config);
  previous = current;
  chaseCam.snap();
});
input.onKey('KeyH', () => hud.toggle());

// --- live tuning panel ----------------------------------------------------
const gui = new GUI({ title: 'Aloft — feel tuning' });
const forces = gui.addFolder('forces');
forces.add(config, 'gravity', 1, 20, 0.1);
forces.add(config, 'liftPerSpeed', 0.005, 0.08, 0.0005);
forces.add(config, 'dragCoeff', 0.0005, 0.01, 0.0001);
forces.add(config, 'settleResponse', 0.05, 1.5, 0.01);
const control = gui.addFolder('control');
control.add(config, 'pitchRate', 0.2, 4, 0.05);
control.add(config, 'rollRate', 0.2, 5, 0.05);
control.add(config, 'bankTurnFactor', 0, 3, 0.05);
control.add(config, 'autoLevel', 0, 3, 0.05);
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
launch.close();

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
    settle: lerp(a.settle, b.settle),
    flying: lerp(a.flying, b.flying),
  };
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  // Clamp so a background tab doesn't fast-forward the sim on return.
  const frameDt = Math.min((now - lastTime) / 1000, 0.25);
  accumulator += frameDt;
  lastTime = now;

  const controls = input.read();
  while (accumulator >= SIM_DT) {
    previous = current;
    current = step(current, controls, SIM_DT, config, terrain);
    accumulator -= SIM_DT;
  }

  const alpha = accumulator / SIM_DT;
  const drawn = lerpState(previous, current, alpha);
  chaseCam.update(renderer.camera, drawn, frameDt);
  hud.update(drawn);
  renderer.render(drawn);
}

requestAnimationFrame(frame);
