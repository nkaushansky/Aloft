import type { Config } from './config';
import type { BirdState, Vec3 } from './types';
import { AirKind } from './types';

/** Fresh launch: wings level, high, at speed, pointed downwind. */
export function createBirdState(cfg: Config, x = 0, y = cfg.launchAltitude, z = 0): BirdState {
  return {
    position: { x, y, z },
    yaw: (cfg.windDirDeg * Math.PI) / 180,
    pitch: -0.05,
    roll: 0,
    airspeed: cfg.launchAirspeed,
    groundVel: { x: 0, y: 0, z: 0 },
    stickPitch: 0,
    stickRoll: 0,
    wing: 0,
    settle: 0,
    flying: 1,
    liftRate: 0,
    climbRate: 0,
    airKind: AirKind.Still,
    airIntensity: 0,
    turbulence: 0,
    agl: y,
    energy: cfg.gravity * y + 0.5 * cfg.launchAirspeed * cfg.launchAirspeed,
    gForce: 1,
    stallBreak: 0,
    landed: false,
  };
}

export function cloneBirdState(s: BirdState): BirdState {
  return {
    ...s,
    position: { ...s.position },
    groundVel: { ...s.groundVel },
  };
}

/** Unit forward vector for yaw/pitch. Roll does not move the nose. */
export function forwardOf(s: BirdState, out: Vec3): Vec3 {
  const cp = Math.cos(s.pitch);
  out.x = -Math.sin(s.yaw) * cp;
  out.y = Math.sin(s.pitch);
  out.z = -Math.cos(s.yaw) * cp;
  return out;
}

/** Unit right-wing vector, including roll. For vortices and wing geometry. */
export function rightOf(s: BirdState, out: Vec3): Vec3 {
  const cy = Math.cos(s.yaw);
  const sy = Math.sin(s.yaw);
  const cr = Math.cos(s.roll);
  const sr = Math.sin(s.roll);
  const sp = Math.sin(s.pitch);
  out.x = cy * cr + sy * sp * sr;
  out.y = -Math.cos(s.pitch) * sr;
  out.z = -sy * cr + cy * sp * sr;
  return out;
}

/** Specific total energy (J/kg). The number the whole game is about. */
export function totalEnergy(s: BirdState, cfg: Config): number {
  return cfg.gravity * s.position.y + 0.5 * s.airspeed * s.airspeed;
}

/**
 * Interpolate two sim states for rendering between fixed steps. Angles take
 * the short way round so a yaw crossing ±PI doesn't spin the bird.
 */
export function lerpBirdState(a: BirdState, b: BirdState, t: number, out: BirdState): BirdState {
  const L = (x: number, y: number): number => x + (y - x) * t;
  const A = (x: number, y: number): number => {
    let d = (y - x) % (Math.PI * 2);
    if (d > Math.PI) d -= Math.PI * 2;
    if (d < -Math.PI) d += Math.PI * 2;
    return x + d * t;
  };
  out.position.x = L(a.position.x, b.position.x);
  out.position.y = L(a.position.y, b.position.y);
  out.position.z = L(a.position.z, b.position.z);
  out.groundVel.x = L(a.groundVel.x, b.groundVel.x);
  out.groundVel.y = L(a.groundVel.y, b.groundVel.y);
  out.groundVel.z = L(a.groundVel.z, b.groundVel.z);
  out.yaw = A(a.yaw, b.yaw);
  out.pitch = A(a.pitch, b.pitch);
  out.roll = A(a.roll, b.roll);
  out.airspeed = L(a.airspeed, b.airspeed);
  out.stickPitch = L(a.stickPitch, b.stickPitch);
  out.stickRoll = L(a.stickRoll, b.stickRoll);
  out.wing = L(a.wing, b.wing);
  out.settle = L(a.settle, b.settle);
  out.flying = L(a.flying, b.flying);
  out.liftRate = L(a.liftRate, b.liftRate);
  out.climbRate = L(a.climbRate, b.climbRate);
  out.airIntensity = L(a.airIntensity, b.airIntensity);
  out.turbulence = L(a.turbulence, b.turbulence);
  out.agl = L(a.agl, b.agl);
  out.energy = L(a.energy, b.energy);
  out.gForce = L(a.gForce, b.gForce);
  out.stallBreak = L(a.stallBreak, b.stallBreak);
  out.airKind = b.airKind;
  out.landed = b.landed;
  return out;
}
