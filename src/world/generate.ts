/**
 * Bake a land into textures: base heights → hydraulic erosion → fine detail →
 * normals, occlusion and ground masks. Pure and worker-safe; `bakeLand` is a
 * generator-style async so the main thread fallback can breathe between steps.
 */
import { HALF, Land, LandId, makeLand, sampleGrid } from './lands';
import { Noise, clamp, lerp, makeRng, smoothstep } from './noise';

export interface BakedLand {
  id: LandId;
  seed: number;
  /** core grid resolution (N×N over ±HALF) */
  n: number;
  height: Float32Array;
  /** nx, nz (signed→0..255), occlusion, curvature */
  normal: Uint8Array;
  /** forest, lush, rock, special */
  mask: Uint8Array;
  /** far ring: nFar×nFar over ±farHalf */
  nFar: number;
  farHalf: number;
  far: Float32Array;
  maxH: number;
  landmarks: PlacedLandmark[];
}

export interface PlacedLandmark {
  id: string;
  name: string;
  kind: string;
  x: number;
  z: number;
  /** ground height at the base */
  y: number;
  yaw: number;
  reach: number;
}

export interface BakeOptions {
  id: LandId;
  seed?: number;
  /** final core resolution: 1024 (phones) or 2048 */
  n: number;
  onProgress?: (p: number) => void;
  /** yields to the event loop on the main-thread fallback */
  breathe?: () => Promise<void>;
}

export async function bakeLand(o: BakeOptions): Promise<BakedLand> {
  const land = makeLand(o.id, o.seed);
  const prog = o.onProgress ?? (() => {});
  const breathe = o.breathe ?? (async () => {});

  // --- coarse base -----------------------------------------------------------
  const c = 1024;
  const coarse = new Float32Array(c * c);
  for (let j = 0; j < c; j++) {
    const z = (j / (c - 1) - 0.5) * 2 * HALF;
    for (let i = 0; i < c; i++) {
      coarse[j * c + i] = land.base((i / (c - 1) - 0.5) * 2 * HALF, z);
    }
    if ((j & 31) === 0) {
      prog(0.45 * (j / c));
      await breathe();
    }
  }
  stampPads(land, coarse, c, true);

  // --- erosion ----------------------------------------------------------------
  const before = coarse.slice();
  await erode(land, coarse, c, (p) => prog(0.45 + 0.2 * p), breathe);
  // fade erosion out at the rim so the far ring meets it exactly
  for (let j = 0; j < c; j++) {
    for (let i = 0; i < c; i++) {
      const e = Math.min(i, j, c - 1 - i, c - 1 - j) / c;
      const w = smoothstep(0.004, 0.05, e);
      const k = j * c + i;
      coarse[k] = lerp(before[k], coarse[k], w);
    }
  }

  // --- upsample + fine detail ---------------------------------------------------
  const n = o.n;
  const height = new Float32Array(n * n);
  const dn = new Noise(land.seed + 999);
  let maxH = 0;
  for (let j = 0; j < n; j++) {
    const v = (j / (n - 1)) * (c - 1);
    const z = (j / (n - 1) - 0.5) * 2 * HALF;
    for (let i = 0; i < n; i++) {
      const u = (i / (n - 1)) * (c - 1);
      const x = (i / (n - 1) - 0.5) * 2 * HALF;
      let h = cubic(coarse, c, u, v);
      const iu = clamp(u | 0, 1, c - 2);
      const iv = clamp(v | 0, 1, c - 2);
      const k = iv * c + iu;
      const cell = (2 * HALF) / (c - 1);
      const sl = Math.hypot(coarse[k + 1] - coarse[k - 1], coarse[k + c] - coarse[k - c]) / (2 * cell);
      const rough = smoothstep(0.1, 0.9, sl) + 0.12;
      const d = dn.fbm(x / 64, z / 64, 4, 2.1, 0.55);
      h += d * land.detail * rough * smoothstep(0.4, 5, Math.abs(h));
      height[j * n + i] = h;
      if (h > maxH) maxH = h;
    }
    if ((j & 63) === 0) {
      prog(0.65 + 0.15 * (j / n));
      await breathe();
    }
  }

  // --- normals, occlusion, masks ----------------------------------------------
  const normal = new Uint8Array(n * n * 4);
  const mask = new Uint8Array(n * n * 4);
  const cell = (2 * HALF) / (n - 1);
  const ao = occlusion(coarse, c);
  const mk = new Float64Array(4);
  for (let j = 0; j < n; j++) {
    const z = (j / (n - 1) - 0.5) * 2 * HALF;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1) - 0.5) * 2 * HALF;
      const k = j * n + i;
      const iL = i > 0 ? k - 1 : k;
      const iR = i < n - 1 ? k + 1 : k;
      const jU = j > 0 ? k - n : k;
      const jD = j < n - 1 ? k + n : k;
      const dx = (height[iR] - height[iL]) / (cell * (iR - iL || 1));
      const dz = (height[jD] - height[jU]) / (cell * ((jD - jU) / n || 1));
      const inv = 1 / Math.sqrt(1 + dx * dx + dz * dz);
      normal[k * 4] = clamp(Math.round((-dx * inv * 0.5 + 0.5) * 255), 0, 255);
      normal[k * 4 + 1] = clamp(Math.round((-dz * inv * 0.5 + 0.5) * 255), 0, 255);
      normal[k * 4 + 2] = clamp(Math.round(bil(ao, c, (i / (n - 1)) * (c - 1), (j / (n - 1)) * (c - 1)) * 255), 0, 255);
      const curv = (height[iL] + height[iR] + height[jU] + height[jD] - 4 * height[k]) / cell;
      normal[k * 4 + 3] = clamp(Math.round((clamp(curv * 0.6, -1, 1) * 0.5 + 0.5) * 255), 0, 255);
      const sl = Math.hypot(dx, dz);
      land.masks(x, z, height[k], sl, mk);
      mask[k * 4] = Math.round(clamp(mk[0], 0, 1) * 255);
      mask[k * 4 + 1] = Math.round(clamp(mk[1], 0, 1) * 255);
      mask[k * 4 + 2] = Math.round(clamp(mk[2], 0, 1) * 255);
      mask[k * 4 + 3] = Math.round(clamp(mk[3], 0, 1) * 255);
    }
    if ((j & 63) === 0) {
      prog(0.8 + 0.14 * (j / n));
      await breathe();
    }
  }

  // --- the far ring -------------------------------------------------------------
  const nFar = 512;
  const farHalf = HALF * 4;
  const far = new Float32Array(nFar * nFar);
  for (let j = 0; j < nFar; j++) {
    const z = (j / (nFar - 1) - 0.5) * 2 * farHalf;
    for (let i = 0; i < nFar; i++) {
      const x = (i / (nFar - 1) - 0.5) * 2 * farHalf;
      far[j * nFar + i] = land.base(x, z);
      if (far[j * nFar + i] > maxH) maxH = far[j * nFar + i];
    }
    if ((j & 31) === 0) {
      prog(0.94 + 0.06 * (j / nFar));
      await breathe();
    }
  }

  const landmarks: PlacedLandmark[] = land.landmarks.map((l) => {
    const [x, z, dir] = placeOf(land, l);
    return {
      id: l.id,
      name: l.name,
      kind: l.kind,
      x,
      z,
      y: sampleGrid(height, n, HALF, x, z),
      yaw: dir + (l.yaw ?? 0),
      reach: l.reach,
    };
  });

  prog(1);
  return { id: land.id, seed: land.seed, n, height, normal, mask, nFar, farHalf, far, maxH, landmarks };
}

/** World position + heading of a landmark definition. */
function placeOf(land: Land, l: { t: number; off: number }): [number, number, number] {
  const [px, pz] = land.route.at(l.t);
  const [dx, dz] = land.route.dir(l.t);
  // right of travel = (-dz, dx) rotated… travel (dx,dz), right-hand side is (-dz, dx) in XZ with +Z south
  return [px - dz * l.off, pz + dx * l.off, Math.atan2(-dx, -dz)];
}

function stampPads(land: Land, h: Float32Array, n: number, _coarse: boolean): void {
  const cell = (2 * HALF) / (n - 1);
  for (const l of land.landmarks) {
    if (!l.pad) continue;
    const [x, z] = placeOf(land, l);
    const ci = (x / (2 * HALF) + 0.5) * (n - 1);
    const cj = (z / (2 * HALF) + 0.5) * (n - 1);
    const y = l.padY ?? sampleGrid(h, n, HALF, x, z);
    const outer = l.pad * 2.4;
    const r = Math.ceil(outer / cell) + 1;
    for (let j = Math.floor(cj) - r; j <= cj + r; j++) {
      for (let i = Math.floor(ci) - r; i <= ci + r; i++) {
        if (i < 0 || j < 0 || i >= n || j >= n) continue;
        const d = Math.hypot(i - ci, j - cj) * cell;
        const w = 1 - smoothstep(l.pad * 0.7, outer, d);
        h[j * n + i] = lerp(h[j * n + i], y, w);
      }
    }
  }
}

function bil(a: Float32Array, n: number, u: number, v: number): number {
  const i = clamp(Math.floor(u), 0, n - 2);
  const j = clamp(Math.floor(v), 0, n - 2);
  const fx = clamp(u - i, 0, 1);
  const fy = clamp(v - j, 0, 1);
  const k = j * n + i;
  return lerp(lerp(a[k], a[k + 1], fx), lerp(a[k + n], a[k + n + 1], fx), fy);
}

function cubic(a: Float32Array, n: number, u: number, v: number): number {
  const i = Math.floor(u);
  const j = Math.floor(v);
  const fx = u - i;
  const fy = v - j;
  const w0 = (t: number) => -0.5 * t + t * t - 0.5 * t * t * t;
  const w1 = (t: number) => 1 - 2.5 * t * t + 1.5 * t * t * t;
  const w2 = (t: number) => 0.5 * t + 2 * t * t - 1.5 * t * t * t;
  const w3 = (t: number) => -0.5 * t * t + 0.5 * t * t * t;
  const wx = [w0(fx), w1(fx), w2(fx), w3(fx)];
  const wy = [w0(fy), w1(fy), w2(fy), w3(fy)];
  let s = 0;
  for (let y = 0; y < 4; y++) {
    const jj = clamp(j - 1 + y, 0, n - 1) * n;
    let r = 0;
    for (let x = 0; x < 4; x++) r += a[jj + clamp(i - 1 + x, 0, n - 1)] * wx[x];
    s += r * wy[y];
  }
  return s;
}

/** Wide-radius occlusion on the coarse grid: valleys gather shade, crests don't. */
function occlusion(h: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n * n);
  const cell = (2 * HALF) / (n - 1);
  const radii = [2, 5, 11];
  const dirs = 8;
  const ox: number[] = [];
  const oy: number[] = [];
  const ow: number[] = [];
  for (const r of radii) {
    for (let d = 0; d < dirs; d++) {
      const a = (d / dirs) * Math.PI * 2 + r;
      ox.push(Math.round(Math.cos(a) * r));
      oy.push(Math.round(Math.sin(a) * r));
      ow.push(r * cell);
    }
  }
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const c = h[j * n + i];
      let o = 0;
      for (let s = 0; s < ox.length; s++) {
        const x = i + ox[s];
        const y = j + oy[s];
        if (x < 0 || y < 0 || x >= n || y >= n) continue;
        const sl = (h[y * n + x] - c) / ow[s];
        if (sl > 0) o += sl / (1 + sl);
      }
      out[j * n + i] = clamp(1 - (o / ox.length) * 1.9, 0.12, 1);
    }
  }
  return out;
}

/** Droplet hydraulic erosion with sediment, on the coarse grid. */
async function erode(
  land: Land,
  h: Float32Array,
  n: number,
  prog: (p: number) => void,
  breathe: () => Promise<void>,
): Promise<void> {
  const rng = makeRng(land.seed * 31 + 5);
  const cell = (2 * HALF) / (n - 1);
  const inv = 1 / cell;
  const total = Math.floor(n * n * land.erosion.droplets);
  const K = land.erosion.strength;
  const maxLife = 46;
  const inertia = 0.08;
  for (let d = 0; d < total; d++) {
    let x = 2 + rng() * (n - 5);
    let y = 2 + rng() * (n - 5);
    let dx = 0;
    let dy = 0;
    let speed = 1;
    let water = 1;
    let sed = 0;
    for (let life = 0; life < maxLife; life++) {
      const ix = x | 0;
      const iy = y | 0;
      const fx = x - ix;
      const fy = y - iy;
      const k = iy * n + ix;
      const h00 = h[k];
      const h10 = h[k + 1];
      const h01 = h[k + n];
      const h11 = h[k + n + 1];
      const hc = h00 * (1 - fx) * (1 - fy) + h10 * fx * (1 - fy) + h01 * (1 - fx) * fy + h11 * fx * fy;
      if (hc < 0.3) break; // reached open water
      const gx = ((h10 - h00) * (1 - fy) + (h11 - h01) * fy) * inv;
      const gy = ((h01 - h00) * (1 - fx) + (h11 - h10) * fx) * inv;
      dx = dx * inertia - gx * (1 - inertia);
      dy = dy * inertia - gy * (1 - inertia);
      const l = Math.hypot(dx, dy);
      if (l < 1e-5) break;
      dx /= l;
      dy /= l;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 2 || ny < 2 || nx > n - 4 || ny > n - 4) break;
      const kx = nx | 0;
      const ky = ny | 0;
      const ffx = nx - kx;
      const ffy = ny - ky;
      const kk = ky * n + kx;
      const hn =
        h[kk] * (1 - ffx) * (1 - ffy) + h[kk + 1] * ffx * (1 - ffy) + h[kk + n] * (1 - ffx) * ffy + h[kk + n + 1] * ffx * ffy;
      const dh = hn - hc;
      const slope = clamp(-dh * inv, 0.004, 1.6);
      const cap = slope * speed * water * 7 * K;
      if (sed > cap || dh > 0) {
        const dep = dh > 0 ? Math.min(dh, sed) : (sed - cap) * 0.25;
        sed -= dep;
        h[k] += dep * (1 - fx) * (1 - fy);
        h[k + 1] += dep * fx * (1 - fy);
        h[k + n] += dep * (1 - fx) * fy;
        h[k + n + 1] += dep * fx * fy;
      } else {
        const er = Math.min((cap - sed) * 0.22, -dh * 0.5);
        sed += er;
        // a small soft brush so gullies have shoulders
        const a = er * 0.36;
        const b = er * 0.16;
        h[k] -= a * (1 - fx) * (1 - fy) + b;
        h[k + 1] -= a * fx * (1 - fy) + b;
        h[k + n] -= a * (1 - fx) * fy + b;
        h[k + n + 1] -= a * fx * fy + b;
      }
      speed = Math.sqrt(Math.max(0.01, speed * speed - dh * inv * 2.2)) * 0.94;
      water *= 0.975;
      x = nx;
      y = ny;
    }
    if ((d & 8191) === 0) {
      prog(d / total);
      await breathe();
    }
  }
}
