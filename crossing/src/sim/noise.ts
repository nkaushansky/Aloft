/**
 * Deterministic noise toolkit. Everything here is a pure function of its
 * arguments plus a seed, so a seed rebuilds an identical world — terrain,
 * biomes, thermals, wave systems, scatter, all of it.
 *
 * A seed IS a map (inherited from Aloft's Q7, and load-bearing here: the
 * Logbook records the seed of every crossing).
 */

const F32 = 1 / 4294967296;

export function hash2(ix: number, iz: number, seed: number): number {
  let h = Math.imul(ix, 0x27d4eb2d) ^ Math.imul(iz, 0x165667b1) ^ Math.imul(seed, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) * F32;
}

export function hash3(ix: number, iy: number, iz: number, seed: number): number {
  let h =
    Math.imul(ix, 0x27d4eb2d) ^
    Math.imul(iy, 0x85ebca6b) ^
    Math.imul(iz, 0x165667b1) ^
    Math.imul(seed, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0xc2b2ae35);
  h ^= h >>> 13;
  h = Math.imul(h, 0x27d4eb2d);
  h ^= h >>> 16;
  return (h >>> 0) * F32;
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** Smooth value noise in [0,1]. */
export function valueNoise2(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = fade(x - ix);
  const fz = fade(z - iz);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  return a + (b - a) * fx + (c - a) * fz + (a - b - c + d) * fx * fz;
}

/** Smooth 3D value noise in [0,1]. Used for cloud/air texture. */
export function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = fade(x - ix);
  const fy = fade(y - iy);
  const fz = fade(z - iz);
  const c000 = hash3(ix, iy, iz, seed);
  const c100 = hash3(ix + 1, iy, iz, seed);
  const c010 = hash3(ix, iy + 1, iz, seed);
  const c110 = hash3(ix + 1, iy + 1, iz, seed);
  const c001 = hash3(ix, iy, iz + 1, seed);
  const c101 = hash3(ix + 1, iy, iz + 1, seed);
  const c011 = hash3(ix, iy + 1, iz + 1, seed);
  const c111 = hash3(ix + 1, iy + 1, iz + 1, seed);
  const x00 = c000 + (c100 - c000) * fx;
  const x10 = c010 + (c110 - c010) * fx;
  const x01 = c001 + (c101 - c001) * fx;
  const x11 = c011 + (c111 - c011) * fx;
  const y0 = x00 + (x10 - x00) * fy;
  const y1 = x01 + (x11 - x01) * fy;
  return y0 + (y1 - y0) * fz;
}

/** Fractal value noise in [-1,1]. `octaves` defaults to a cheap 4. */
export function fbm2(x: number, z: number, seed: number, octaves = 4, gain = 0.5, lac = 2.03): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += (valueNoise2(x * freq, z * freq, seed + o * 131) * 2 - 1) * amp;
    norm += amp;
    freq *= lac;
    amp *= gain;
  }
  return norm > 0 ? sum / norm : 0;
}

export function fbm3(x: number, y: number, z: number, seed: number, octaves = 3): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += (valueNoise3(x * freq, y * freq, z * freq, seed + o * 197) * 2 - 1) * amp;
    norm += amp;
    freq *= 2.07;
    amp *= 0.5;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Ridged multifractal in [0,1] — sharp crests, smooth valleys. This is what
 * makes mountains look like mountains instead of like dunes, and it gives the
 * ridge-lift and wave systems real spines to work with.
 */
export function ridged2(x: number, z: number, seed: number, octaves = 5): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  let prev = 1;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(valueNoise2(x * freq, z * freq, seed + o * 271) * 2 - 1);
    const shaped = n * n * prev;
    sum += shaped * amp;
    norm += amp;
    prev = 0.6 + 0.4 * shaped;
    freq *= 2.11;
    amp *= 0.52;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Billowy noise in [0,1] — puffy lobes. Cumulus, tree clumps, scree fields.
 */
export function billow2(x: number, z: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += Math.abs(valueNoise2(x * freq, z * freq, seed + o * 313) * 2 - 1) * amp;
    norm += amp;
    freq *= 2.05;
    amp *= 0.5;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Worley / cellular noise. Returns the distance to the nearest feature point
 * (normalized ~0..1) and that point's stable id-hash. Used for placing
 * mountain massifs, lake basins and cloud cells on a jittered grid.
 */
export interface CellResult {
  dist: number;
  fx: number;
  fz: number;
  id: number;
}

export function worley2(x: number, z: number, seed: number, out: CellResult): CellResult {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  let best = 1e9;
  out.fx = 0;
  out.fz = 0;
  out.id = 0;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx;
      const cz = iz + dz;
      const jx = cx + hash2(cx, cz, seed);
      const jz = cz + hash2(cx, cz, seed + 977);
      const ex = jx - x;
      const ez = jz - z;
      const d2 = ex * ex + ez * ez;
      if (d2 < best) {
        best = d2;
        out.fx = jx;
        out.fz = jz;
        out.id = Math.floor(hash2(cx, cz, seed + 7919) * 1e6);
      }
    }
  }
  out.dist = Math.sqrt(best);
  return out;
}

/**
 * Curl of a 2D scalar potential, giving a divergence-free 2D flow. This is
 * how the wind field gets swirl and eddies that look like real air rather
 * than like drifting fog: divergence-free means nothing appears or vanishes.
 */
export function curl2(
  x: number,
  z: number,
  seed: number,
  eps: number,
  out: { x: number; z: number },
): { x: number; z: number } {
  const n1 = fbm2(x, z + eps, seed, 3);
  const n2 = fbm2(x, z - eps, seed, 3);
  const n3 = fbm2(x + eps, z, seed, 3);
  const n4 = fbm2(x - eps, z, seed, 3);
  const dz = (n1 - n2) / (2 * eps);
  const dx = (n3 - n4) / (2 * eps);
  out.x = dz;
  out.z = -dx;
  return out;
}

/** Mulberry32 — tiny, fast, deterministic. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) * F32;
  };
}

/** Convenience: a seeded rng that returns values in [lo, hi). */
export function ranged(rng: () => number, lo: number, hi: number): number {
  return lo + rng() * (hi - lo);
}

/** Pick one element deterministically. */
export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];
}

/**
 * Turn a human-typed seed word into a stable 32-bit number, so players can
 * share "GLASSWING" instead of 48173.
 */
export function seedFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 100000;
}

const SEED_SYLLABLES_A = [
  'gla', 'ver', 'hal', 'mor', 'sol', 'thra', 'wind', 'ash', 'kes', 'lum',
  'cor', 'bran', 'sil', 'dun', 'far', 'ith', 'nor', 'pel', 'ryn', 'tal',
];
const SEED_SYLLABLES_B = [
  'wing', 'mere', 'crest', 'vale', 'reach', 'spire', 'fell', 'holm', 'gate', 'mark',
  'ridge', 'hollow', 'drift', 'shear', 'bourne', 'stead', 'cairn', 'thorn', 'wick', 'span',
];

/** Turn a numeric seed into a pronounceable name. Purely cosmetic, stable. */
export function nameFromSeed(seed: number): string {
  const rng = makeRng(seed * 2654435761 + 12345);
  const a = pick(rng, SEED_SYLLABLES_A);
  const b = pick(rng, SEED_SYLLABLES_B);
  return (a + b).toUpperCase();
}
