import type { Config } from './config';

/** Plain vector — the sim deliberately does not import Three.js. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** How the bird is meeting the world right now. */
export type Mode = 'air' | 'ground' | 'leap';

/**
 * Complete bird state. Everything the renderer needs to draw a frame and
 * everything the model needs to step forward. Angles are radians.
 *
 * Conventions (right-handed, matching Three.js world axes):
 *  - yaw 0 faces -Z; positive yaw turns left.
 *  - pitch positive is nose-up.
 *  - roll positive is right-wing-down (banking right).
 */
export interface BirdState {
  mode: Mode;
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
  /** 1 = fully flying, 0 = fully stalled. Drives control softening. */
  flying: number;
  /** Vertical air velocity at our position (m/s). */
  lift: number;
  /** Net vertical speed last step (m/s). */
  climbRate: number;
  /** 0..1 stamina for wingbeats. */
  breath: number;
  /** 0..1 eased wingbeat effort. */
  beat: number;
  /** Wingbeat phase (radians), advancing while beating. */
  beatPhase: number;
  /** Height above ground or water (m). */
  agl: number;
  /** 0..1 eased: legs down, wings cupped, about to touch. */
  flare: number;
  /** 1 while skimming a surface this step, easing out. */
  touch: number;
  /** Surface under us is water. */
  overWater: boolean;
  /** Seconds in the current mode. */
  modeTime: number;
}

export function createState(cfg: Config, x: number, y: number, z: number, yaw: number): BirdState {
  return {
    mode: 'air',
    position: { x, y, z },
    yaw,
    pitch: cfg.trimPitch,
    roll: 0,
    airspeed: cfg.launchAirspeed,
    stickPitch: 0,
    stickRoll: 0,
    settle: 0,
    flying: 1,
    lift: 0,
    climbRate: 0,
    breath: 1,
    beat: 0,
    beatPhase: 0,
    agl: 50,
    flare: 0,
    touch: 0,
    overWater: false,
    modeTime: 0,
  };
}

/** Unit forward vector for the bird's yaw/pitch (roll doesn't move the nose). */
export function forwardOf(s: { yaw: number; pitch: number }): Vec3 {
  const cp = Math.cos(s.pitch);
  return { x: -Math.sin(s.yaw) * cp, y: Math.sin(s.pitch), z: -Math.cos(s.yaw) * cp };
}

/** Specific total energy (per unit mass): potential + kinetic. */
export function totalEnergy(s: BirdState, cfg: Config): number {
  return cfg.gravity * s.position.y + 0.5 * s.airspeed * s.airspeed;
}
