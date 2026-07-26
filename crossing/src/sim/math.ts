/**
 * Pure scalar/vector helpers. No Three.js, no DOM — the sim layer's only
 * dependency is arithmetic.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

export const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const invLerp = (a: number, b: number, v: number): number =>
  a === b ? 0 : (v - a) / (b - a);

export const remap = (v: number, a: number, b: number, c: number, d: number): number =>
  lerp(c, d, clamp01(invLerp(a, b, v)));

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01(e0 === e1 ? (x < e0 ? 0 : 1) : (x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

export function smootherstep(e0: number, e1: number, x: number): number {
  const t = clamp01(e0 === e1 ? (x < e0 ? 0 : 1) : (x - e0) / (e1 - e0));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Frame-rate independent exponential approach. `lambda` is roughly "how many
 * e-foldings per second" — bigger is snappier. This is the only smoothing
 * primitive the codebase should use; naive `a += (b-a)*k` is dt-dependent and
 * makes feel drift with framerate.
 */
export const damp = (current: number, target: number, lambda: number, dt: number): number =>
  target + (current - target) * Math.exp(-lambda * dt);

/** Shortest signed difference between two angles, in (-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export const angleLerp = (a: number, b: number, t: number): number => a + angleDelta(a, b) * t;

export const angleDamp = (a: number, b: number, lambda: number, dt: number): number =>
  a + angleDelta(a, b) * (1 - Math.exp(-lambda * dt));

/** Wrap to (-PI, PI]. */
export function wrapAngle(a: number): number {
  let r = a % TAU;
  if (r > Math.PI) r -= TAU;
  if (r <= -Math.PI) r += TAU;
  return r;
}

// ---------------------------------------------------------------- vectors

export const vlen = (v: Vec3): number => Math.hypot(v.x, v.y, v.z);
export const vlenXZ = (v: Vec3): number => Math.hypot(v.x, v.z);
export const vlen2 = (v: Vec3): number => v.x * v.x + v.y * v.y + v.z * v.z;
export const vdot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export function vset(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function vcopy(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

export function vadd(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  out.z = a.z + b.z;
  return out;
}

export function vsub(out: Vec3, a: Vec3, b: Vec3): Vec3 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  out.z = a.z - b.z;
  return out;
}

export function vscale(out: Vec3, a: Vec3, s: number): Vec3 {
  out.x = a.x * s;
  out.y = a.y * s;
  out.z = a.z * s;
  return out;
}

export function vaddScaled(out: Vec3, a: Vec3, b: Vec3, s: number): Vec3 {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  out.z = a.z + b.z * s;
  return out;
}

export function vlerp(out: Vec3, a: Vec3, b: Vec3, t: number): Vec3 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

export function vnormalize(out: Vec3, a: Vec3): Vec3 {
  const l = vlen(a);
  if (l < 1e-9) return vset(out, 0, 0, 0);
  return vscale(out, a, 1 / l);
}

export const vdistXZ = (a: Vec3, b: Vec3): number => Math.hypot(a.x - b.x, a.z - b.z);

// ------------------------------------------------------------------ easing

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
export const easeInCubic = (t: number): number => t * t * t;
export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
export const easeOutQuint = (t: number): number => 1 - Math.pow(1 - t, 5);
export const easeOutBack = (t: number): number => {
  const c = 1.70158;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};

/**
 * Perlin-style bias: pushes values toward 0 (b<0.5) or 1 (b>0.5) while
 * keeping the [0,1] range. Handy for shaping noise into terrain or density.
 */
export function bias(x: number, b: number): number {
  if (b <= 0) return 0;
  if (b >= 1) return 1;
  return Math.pow(x, Math.log(b) / Math.log(0.5));
}

/** Signed power — preserves sign while curving magnitude. Great for sticks. */
export const signedPow = (x: number, p: number): number =>
  Math.sign(x) * Math.pow(Math.abs(x), p);

/** Deadzone + rescale, for analog sticks. */
export function deadzone(x: number, dz: number): number {
  const a = Math.abs(x);
  if (a <= dz) return 0;
  return Math.sign(x) * ((a - dz) / (1 - dz));
}

// -------------------------------------------------------------- geometry

/** Squared distance from point P to segment AB, in the XZ plane. */
export function distSqToSegmentXZ(
  px: number,
  pz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): { d2: number; t: number } {
  const dx = bx - ax;
  const dz = bz - az;
  const len2 = dx * dx + dz * dz;
  let t = len2 > 1e-9 ? ((px - ax) * dx + (pz - az) * dz) / len2 : 0;
  t = clamp01(t);
  const cx = ax + dx * t;
  const cz = az + dz * t;
  const ex = px - cx;
  const ez = pz - cz;
  return { d2: ex * ex + ez * ez, t };
}

/** A cheap, allocation-free gaussian falloff: exp(-r2) with an early cutoff. */
export const gaussian = (r2: number): number => (r2 > 9 ? 0 : Math.exp(-r2));
