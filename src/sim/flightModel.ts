import type { Config } from './config';
import type { TerrainProvider } from './terrain';
import type { LiftProvider, Wind } from './air';
import { BirdState, forwardOf } from './state';
import { clamp, smoothstep } from './math';

/** Normalized control input, device-agnostic. */
export interface FlightInput {
  /** +1 = full nose-up, -1 = full nose-down. */
  pitch: number;
  /** +1 = full roll right, -1 = full roll left. */
  roll: number;
  /** Beating the wings (spends breath). */
  beat: boolean;
}

/** Everything outside the bird that a step needs. */
export interface World {
  terrain: TerrainProvider;
  lift: LiftProvider;
  wind: Wind;
  /** 0..1 drag saved by flying in company */
  draft: number;
}

/**
 * Advance the flight model by dt seconds. Pure: no Three.js, no DOM, no
 * globals — returns a new state and never mutates the input state.
 *
 * The whole model is one idea: total energy = altitude + airspeed, bleeding
 * to drag, with pitch as the exchange lever. Rising air tops it up. Breath is
 * the small purse you earn from rising air and rest, and may spend anywhere.
 */
export function step(state: BirdState, input: FlightInput, dt: number, cfg: Config, w: World): BirdState {
  const s: BirdState = { ...state, position: { ...state.position }, modeTime: state.modeTime + dt };
  if (s.mode === 'ground') return stepGround(s, input, dt, cfg, w);
  if (s.mode === 'leap') return stepLeap(s, input, dt, cfg, w);
  return stepAir(s, input, dt, cfg, w);
}

function surface(w: World, x: number, z: number): { g: number; y: number; water: boolean } {
  const g = w.terrain.heightAt(x, z);
  return g < 0 ? { g, y: 0, water: true } : { g, y: g, water: false };
}

function ease(from: number, to: number, rate: number, dt: number): number {
  return from + (to - from) * (1 - Math.exp(-rate * dt));
}

function stepAir(s: BirdState, input: FlightInput, dt: number, cfg: Config, w: World): BirdState {
  // --- stall envelope -------------------------------------------------
  s.flying = smoothstep(cfg.minAirspeed, cfg.minAirspeed * cfg.stallRecoveryMargin, s.airspeed);
  const authority = 0.3 + 0.7 * s.flying;

  // --- attitude from input ---------------------------------------------
  const stickEase = Math.min(1, dt / Math.max(cfg.inputResponse, 1e-3));
  s.stickPitch += (input.pitch - s.stickPitch) * stickEase;
  s.stickRoll += (input.roll - s.stickRoll) * stickEase;
  s.pitch += s.stickPitch * cfg.pitchRate * authority * dt;
  s.roll += s.stickRoll * cfg.rollRate * authority * dt;

  if (Math.abs(input.pitch) < 0.05) {
    s.pitch += (cfg.trimPitch - s.pitch) * Math.min(1, cfg.pitchAutoLevel * dt);
  }
  if (Math.abs(input.roll) < 0.05) {
    s.roll -= s.roll * Math.min(1, cfg.rollAutoLevel * dt);
  }
  s.pitch += (cfg.stallDiveAngle - s.pitch) * cfg.stallNoseDrop * (1 - s.flying) * dt;
  s.pitch = clamp(s.pitch, -cfg.maxPitch, cfg.maxPitch);
  s.roll = clamp(s.roll, -cfg.maxBank, cfg.maxBank);

  // --- breath: the wingbeat ----------------------------------------------
  const wants = input.beat && s.breath > 0.001 ? 1 : 0;
  s.beat = ease(s.beat, wants, wants ? 3.2 : 2.2, dt);
  if (wants) s.breath = Math.max(0, s.breath - dt / cfg.breathSeconds);
  s.beatPhase += dt * (1.2 + 6.2 * s.beat) * (s.beat > 0.02 ? 1 : 0);

  // --- coordinated turn from bank ---------------------------------------
  const turnV = Math.max(s.airspeed, 4);
  s.yaw += ((-cfg.bankTurnFactor * cfg.gravity * Math.tan(s.roll)) / turnV) * dt;

  // --- airspeed: the energy trade ---------------------------------------
  const drag = cfg.dragCoeff * (1 - w.draft) * s.airspeed * s.airspeed;
  const thrust = cfg.beatThrust * s.beat * smoothstep(34, 18, s.airspeed);
  const accel = -cfg.gravity * Math.sin(s.pitch) - drag + thrust;
  s.airspeed = clamp(s.airspeed + accel * dt, 0, cfg.maxAirspeed);

  // --- lift deficit → settle ---------------------------------------------
  const liftAcc = cfg.liftPerSpeed * s.airspeed * s.airspeed * Math.cos(s.roll);
  const deficit = Math.max(0, cfg.gravity - liftAcc);
  const targetSettle = deficit * cfg.settleResponse * (1 - 0.7 * s.beat);
  s.settle += (targetSettle - s.settle) * Math.min(1, dt / Math.max(cfg.settleResponse, 1e-3));

  // --- rising air ---------------------------------------------------------
  s.lift = w.lift.liftAt(s.position.x, s.position.y, s.position.z);

  // --- integrate -----------------------------------------------------------
  const fwd = forwardOf(s);
  let vy = fwd.y * s.airspeed - s.settle + s.lift + cfg.beatLift * s.beat;
  // the cushion: close to any surface, the air holds you up a little
  const sf = surface(w, s.position.x, s.position.z);
  const h0 = s.position.y - sf.y;
  const cush = smoothstep(cfg.cushionHeight, 0.5, h0) * cfg.cushion;
  if (vy < 0) vy *= 1 - cush;
  s.climbRate = vy;
  // rising air travels with you: inside it, the wind mostly lets go
  const carry = cfg.windCarry * (1 - cfg.liftHold * smoothstep(0.6, 2.6, s.lift));
  s.position.x += (fwd.x * s.airspeed + w.wind.x * carry) * dt;
  s.position.y += vy * dt;
  s.position.z += (fwd.z * s.airspeed + w.wind.z * carry) * dt;

  // --- breath comes back ----------------------------------------------------
  if (!wants) {
    const inLift = smoothstep(0.6, 3, s.lift);
    s.breath = clamp(s.breath + (cfg.breathGlide + (cfg.breathLift - cfg.breathGlide) * inLift) * dt, 0, 1);
  }

  // --- meeting the surface -------------------------------------------------
  const g = surface(w, s.position.x, s.position.z);
  s.agl = s.position.y - g.y;
  s.overWater = g.water;
  s.touch = Math.max(0, s.touch - dt * 2);

  // look a moment ahead and lean away from rising ground, softly
  const look = 1.1;
  const ax = s.position.x + fwd.x * s.airspeed * look;
  const az = s.position.z + fwd.z * s.airspeed * look;
  const ahead = surface(w, ax, az).y;
  const need = ahead + cfg.clearance + 2 - (s.position.y + vy * look);
  if (need > 0) {
    const want = Math.atan2(ahead + 4 - s.position.y, Math.max(6, s.airspeed * look));
    if (want > s.pitch) s.pitch += (Math.min(want, 0.7) - s.pitch) * Math.min(1, dt * 1.6);
    // steep ground: slide along it rather than into it
    const e = 10;
    const hx = w.terrain.heightAt(s.position.x + e, s.position.z) - w.terrain.heightAt(s.position.x - e, s.position.z);
    const hz = w.terrain.heightAt(s.position.x, s.position.z + e) - w.terrain.heightAt(s.position.x, s.position.z - e);
    const sl = Math.hypot(hx, hz) / (2 * e);
    if (sl > 0.55) {
      // contour direction nearest our heading
      let cx = -hz;
      let cz = hx;
      if (cx * fwd.x + cz * fwd.z < 0) {
        cx = -cx;
        cz = -cz;
      }
      const wantYaw = Math.atan2(-cx, -cz);
      let d = wantYaw - s.yaw;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      s.yaw += d * Math.min(1, dt * 1.3 * smoothstep(0.55, 1.4, sl));
    }
  }

  const floor = g.y + cfg.clearance;
  if (s.position.y < floor) {
    // never a crash: the surface receives you
    s.position.y += (floor - s.position.y) * Math.min(1, dt * 14) + 0.002;
    if (s.position.y < g.y + 0.35) s.position.y = g.y + 0.35;
    s.touch = 1;
    s.settle *= 1 - Math.min(1, dt * 6);
    if (s.pitch < 0.02) s.pitch += (0.05 - s.pitch) * Math.min(1, dt * 4);
    s.airspeed -= s.airspeed * 0.22 * dt;
    s.roll -= s.roll * Math.min(1, dt * 1.5);
    const deep = g.water && -g.g > cfg.wadeDepth;
    if (deep) {
      // open water lifts you off its back
      if (s.airspeed < 14) {
        s.airspeed += (14 - s.airspeed) * Math.min(1, dt * 1.2);
        s.position.y += 1.6 * dt;
        s.beat = ease(s.beat, 0.8, 2, dt);
        s.beatPhase += dt * 5;
      }
    } else if (s.airspeed < cfg.landSpeed) {
      return land(s, w);
    }
  }

  // flare: legs reach for the ground when slow and low
  const slow = smoothstep(17, 12.5, s.airspeed);
  const lowv = smoothstep(16, 3, s.agl);
  const deepBelow = g.water && -g.g > cfg.wadeDepth;
  s.flare = ease(s.flare, deepBelow ? 0 : slow * lowv, 3, dt);
  return s;
}

function land(s: BirdState, w: World): BirdState {
  s.mode = 'ground';
  s.modeTime = 0;
  s.beat = 0;
  s.position.y = w.terrain.heightAt(s.position.x, s.position.z);
  return s;
}

function stepGround(s: BirdState, input: FlightInput, dt: number, cfg: Config, w: World): BirdState {
  // momentum runs out through a few soft steps
  s.airspeed = ease(s.airspeed, 0, 3.2, dt);
  const f = forwardOf({ yaw: s.yaw, pitch: 0 });
  s.position.x += f.x * s.airspeed * dt;
  s.position.z += f.z * s.airspeed * dt;
  const g = w.terrain.heightAt(s.position.x, s.position.z);
  s.position.y = ease(s.position.y, Math.max(g, -cfg.wadeDepth), 14, dt);
  s.pitch = ease(s.pitch, 0, 4, dt);
  s.roll = ease(s.roll, 0, 4, dt);
  s.stickRoll = ease(s.stickRoll, input.roll, 2, dt);
  s.stickPitch = ease(s.stickPitch, 0, 3, dt);
  // turn on the spot, slowly, to choose a way to leave
  s.yaw -= s.stickRoll * 1.1 * dt * smoothstep(0.4, 1.2, s.modeTime);
  s.settle = 0;
  s.lift = 0;
  s.climbRate = 0;
  s.agl = 0;
  s.beat = ease(s.beat, 0, 4, dt);
  s.flare = ease(s.flare, 0, 2, dt);
  s.touch = 0;
  s.flying = 1;
  s.overWater = g < 0;
  s.breath = clamp(s.breath + cfg.breathRest * dt, 0, 1);
  if (input.beat && s.modeTime > 0.9) {
    s.mode = 'leap';
    s.modeTime = 0;
  }
  return s;
}

/** A short run, a long stride, and the ground lets go. */
function stepLeap(s: BirdState, input: FlightInput, dt: number, cfg: Config, w: World): BirdState {
  const T = 1.15;
  const k = clamp(s.modeTime / T, 0, 1);
  s.airspeed = ease(s.airspeed, cfg.leapSpeed * (0.35 + 0.65 * k), 5, dt);
  s.stickRoll = ease(s.stickRoll, input.roll, 3, dt);
  s.yaw -= s.stickRoll * 0.6 * dt;
  const f = forwardOf({ yaw: s.yaw, pitch: 0 });
  s.position.x += f.x * s.airspeed * dt;
  s.position.z += f.z * s.airspeed * dt;
  const g = surface(w, s.position.x, s.position.z);
  const lift = smoothstep(0.45, 1, k);
  s.position.y = Math.max(s.position.y + lift * 4.6 * dt, Math.max(g.g, -cfg.wadeDepth) + lift * 1.6);
  s.pitch = ease(s.pitch, 0.22 * lift, 4, dt);
  s.beat = ease(s.beat, k > 0.25 ? 1 : 0, 5, dt);
  s.beatPhase += dt * (2 + 6.5 * s.beat);
  s.agl = s.position.y - g.y;
  s.climbRate = lift * 4.6;
  s.overWater = g.water;
  s.flare = ease(s.flare, 0, 2, dt);
  if (k >= 1) {
    s.mode = 'air';
    s.modeTime = 0;
    s.airspeed = Math.max(s.airspeed, cfg.leapSpeed);
    s.settle = 0;
    s.position.y = Math.max(s.position.y, g.y + cfg.clearance + 0.4);
  }
  return s;
}
