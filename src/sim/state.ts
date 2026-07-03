import type { Config } from './config';

/** Plain vector — the sim deliberately does not import Three.js. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Complete aircraft state. Everything the renderer needs to draw a frame and
 * everything the model needs to step forward. Angles are radians.
 *
 * Conventions (right-handed, matching Three.js world axes):
 *  - yaw 0 faces -Z; positive yaw turns left.
 *  - pitch positive is nose-up.
 *  - roll positive is right-wing-down (banking right).
 */
export interface AircraftState {
  position: Vec3;
  yaw: number;
  pitch: number;
  roll: number;
  /** Speed through the air along the nose (m/s). */
  airspeed: number;
  /** Smoothed virtual-stick deflections in [-1, 1] — keys ease in, not snap. */
  stickPitch: number;
  stickRoll: number;
  /** Smoothed extra sink from flying below cruise (m/s, downward). */
  settle: number;
  /** 1 = fully flying, 0 = fully stalled. Drives control softening + HUD. */
  flying: number;
}

/** Fresh launch: wings level, at altitude, at speed, pointed down -Z. */
export function createLaunchState(cfg: Config): AircraftState {
  return {
    position: { x: 0, y: cfg.launchAltitude, z: 0 },
    yaw: 0,
    pitch: 0,
    roll: 0,
    airspeed: cfg.launchAirspeed,
    stickPitch: 0,
    stickRoll: 0,
    settle: 0,
    flying: 1,
  };
}

/** Unit forward vector for the craft's yaw/pitch (roll doesn't move the nose). */
export function forwardOf(state: AircraftState): Vec3 {
  const cp = Math.cos(state.pitch);
  return {
    x: -Math.sin(state.yaw) * cp,
    y: Math.sin(state.pitch),
    z: -Math.cos(state.yaw) * cp,
  };
}

/** Specific total energy (per unit mass): potential + kinetic. The HUD's star. */
export function totalEnergy(state: AircraftState, cfg: Config): number {
  return cfg.gravity * state.position.y + 0.5 * state.airspeed * state.airspeed;
}
