import type { Config } from './config';
import type { TerrainProvider } from './terrain';
import { AircraftState, createLaunchState, forwardOf } from './state';

/** Normalized control input, device-agnostic. Both axes in [-1, 1]. */
export interface FlightInput {
  /** +1 = full nose-up, -1 = full nose-down. */
  pitch: number;
  /** +1 = full roll right, -1 = full roll left. */
  roll: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 0 → 1 with smooth ends, like GLSL smoothstep. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Advance the arcade flight model by dt seconds. Pure: no Three.js, no DOM,
 * no globals — returns a new state and never mutates the input state.
 *
 * The whole model is one idea: total energy = altitude + airspeed, bleeding
 * to drag, with pitch as the exchange lever.
 */
export function step(
  state: AircraftState,
  input: FlightInput,
  dt: number,
  cfg: Config,
  terrain: TerrainProvider,
): AircraftState {
  const s: AircraftState = { ...state, position: { ...state.position } };

  // --- stall envelope -------------------------------------------------
  // "flying" fades from 1 to 0 as airspeed sags from the recovery band down
  // to the stall threshold. It softens control before the stall arrives and
  // drives the gentle nose-drop that recovers it.
  s.flying = smoothstep(cfg.minAirspeed, cfg.minAirspeed * cfg.stallRecoveryMargin, s.airspeed);
  const authority = 0.3 + 0.7 * s.flying; // never zero — a stall mushes, it doesn't lock you out

  // --- attitude from input ---------------------------------------------
  // The virtual stick eases toward the commanded input, so a keyboard tap
  // arrives as a swelling deflection, not a step. Maneuvers become leans.
  const stickEase = Math.min(1, dt / Math.max(cfg.inputResponse, 1e-3));
  s.stickPitch += (input.pitch - s.stickPitch) * stickEase;
  s.stickRoll += (input.roll - s.stickRoll) * stickEase;

  s.pitch += s.stickPitch * cfg.pitchRate * authority * dt;
  s.roll += s.stickRoll * cfg.rollRate * authority * dt;

  // Hands-off forgiveness: the nose drifts to its glide trim (slightly nose
  // down, so releasing the stick *is* gliding), the wings drift to level.
  if (Math.abs(input.pitch) < 0.05) {
    s.pitch += (cfg.trimPitch - s.pitch) * Math.min(1, cfg.pitchAutoLevel * dt);
  }
  if (Math.abs(input.roll) < 0.05) {
    s.roll -= s.roll * Math.min(1, cfg.rollAutoLevel * dt);
  }

  // Stall recovery: the nose is pushed toward a shallow dive until speed
  // returns. Scaled by (1 - flying) so it only acts inside the stall.
  s.pitch += (cfg.stallDiveAngle - s.pitch) * cfg.stallNoseDrop * (1 - s.flying) * dt;

  s.pitch = clamp(s.pitch, -cfg.maxPitch, cfg.maxPitch);
  s.roll = clamp(s.roll, -cfg.maxBank, cfg.maxBank);

  // --- coordinated turn from bank ---------------------------------------
  // Banking right (positive roll) turns right (negative yaw). Physically a
  // coordinated turn rate is g·tan(bank)/V — slower flight carves tighter.
  const turnV = Math.max(s.airspeed, 4); // avoid a spin-on-a-dime at near-zero speed
  s.yaw += (-cfg.bankTurnFactor * (cfg.gravity * Math.tan(s.roll)) / turnV) * dt;

  // --- airspeed: the energy trade ---------------------------------------
  // Nose down converts altitude to speed (gravity pulls along the path);
  // nose up converts it back. Drag is the constant leak.
  const accel = -cfg.gravity * Math.sin(s.pitch) - cfg.dragCoeff * s.airspeed * s.airspeed;
  s.airspeed = clamp(s.airspeed + accel * dt, 0, cfg.maxAirspeed);

  // --- lift deficit → settle ---------------------------------------------
  // At or above cruise, lift carries the craft and it goes exactly where the
  // nose points. Below cruise it mushes downward; banking sheds some lift
  // too, so tight turns cost height. First-order smoothed so sink arrives
  // with a little lag instead of snapping on.
  const lift = cfg.liftPerSpeed * s.airspeed * s.airspeed * Math.cos(s.roll);
  const deficit = Math.max(0, cfg.gravity - lift);
  const targetSettle = deficit * cfg.settleResponse;
  s.settle += (targetSettle - s.settle) * Math.min(1, dt / Math.max(cfg.settleResponse, 1e-3));

  // --- integrate position -------------------------------------------------
  const fwd = forwardOf(s);
  s.position.x += fwd.x * s.airspeed * dt;
  s.position.y += fwd.y * s.airspeed * dt - s.settle * dt;
  s.position.z += fwd.z * s.airspeed * dt;

  // --- ground contact: simple reset (Phase 0 only) -------------------------
  const ground = terrain.heightAt(s.position.x, s.position.z);
  if (s.position.y <= ground + 0.5) {
    return createLaunchState(cfg);
  }

  return s;
}
