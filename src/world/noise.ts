/**
 * Deterministic noise toolkit for world-building. Pure and seeded: the same
 * seed always rebuilds the same country. No DOM, no Three — runs in workers.
 */

/** Tiny seeded RNG (mulberry32). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export function smoothstep(e0: number, e1: number, x: number): number {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

const GRAD_N = 64;

export class Noise {
  private readonly perm = new Uint8Array(512);
  private readonly gx = new Float64Array(256);
  private readonly gy = new Float64Array(256);
  /** per-lattice random in [0,1) */
  private readonly rnd = new Float64Array(256);

  constructor(seed: number) {
    const rng = makeRng(seed * 2654435761 + 1013);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
    for (let i = 0; i < 256; i++) {
      const a = ((i % GRAD_N) / GRAD_N) * Math.PI * 2 + rng() * 0.1;
      this.gx[i] = Math.cos(a);
      this.gy[i] = Math.sin(a);
      this.rnd[i] = rng();
    }
  }

  /** Gradient noise, roughly [-1, 1]. */
  n(x: number, y: number): number {
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const ix = fx & 255;
    const iy = fy & 255;
    const dx = x - fx;
    const dy = y - fy;
    const u = dx * dx * dx * (dx * (dx * 6 - 15) + 10);
    const v = dy * dy * dy * (dy * (dy * 6 - 15) + 10);
    const p = this.perm;
    const a = p[ix] + iy;
    const b = p[ix + 1] + iy;
    const g00 = p[a];
    const g10 = p[b];
    const g01 = p[a + 1];
    const g11 = p[b + 1];
    const n00 = this.gx[g00] * dx + this.gy[g00] * dy;
    const n10 = this.gx[g10] * (dx - 1) + this.gy[g10] * dy;
    const n01 = this.gx[g01] * dx + this.gy[g01] * (dy - 1);
    const n11 = this.gx[g11] * (dx - 1) + this.gy[g11] * (dy - 1);
    const nx0 = n00 + (n10 - n00) * u;
    const nx1 = n01 + (n11 - n01) * u;
    return (nx0 + (nx1 - nx0) * v) * 1.5;
  }

  fbm(x: number, y: number, oct: number, lac = 2.03, gain = 0.5): number {
    let s = 0;
    let a = 0.5;
    for (let i = 0; i < oct; i++) {
      s += this.n(x, y) * a;
      // rotate each octave so lattice directions never line up
      const nx = (x * 0.8 - y * 0.6) * lac + 17.3;
      y = (x * 0.6 + y * 0.8) * lac - 9.7;
      x = nx;
      a *= gain;
    }
    return s;
  }

  /** Ridged multifractal, ~[0, 1.2]; crisp crests, soft valleys. */
  ridged(x: number, y: number, oct: number, lac = 2.07, gain = 0.5, sharp = 2): number {
    let s = 0;
    let a = 0.5;
    let w = 1;
    for (let i = 0; i < oct; i++) {
      let r = 1 - Math.abs(this.n(x, y));
      r = Math.pow(r < 0 ? 0 : r, sharp);
      s += r * a * w;
      w = r > 1 ? 1 : r;
      const nx = (x * 0.8 - y * 0.6) * lac + 31.1;
      y = (x * 0.6 + y * 0.8) * lac + 11.7;
      x = nx;
      a *= gain;
    }
    return s;
  }

  /** Random [0,1) per integer cell. */
  cell(ix: number, iy: number, salt = 0): number {
    return this.rnd[this.perm[this.perm[(ix + salt * 17) & 255] + ((iy + salt * 59) & 255)]];
  }

  /**
   * Worley F1 over a jittered grid. Returns distance to nearest feature (in
   * cell units); `this.wx/wy/wid` hold the winner's position and a hash.
   */
  wx = 0;
  wy = 0;
  wid = 0;
  worley(x: number, y: number, jitter = 0.85, salt = 0): number {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    let best = 1e9;
    for (let j = -1; j <= 1; j++) {
      for (let i = -1; i <= 1; i++) {
        const gx = cx + i;
        const gy = cy + j;
        const px = gx + 0.5 + (this.cell(gx, gy, salt) - 0.5) * jitter;
        const py = gy + 0.5 + (this.cell(gx, gy, salt + 1) - 0.5) * jitter;
        const d = (px - x) * (px - x) + (py - y) * (py - y);
        if (d < best) {
          best = d;
          this.wx = px;
          this.wy = py;
          this.wid = this.cell(gx, gy, salt + 2);
        }
      }
    }
    return Math.sqrt(best);
  }
}

/** Smooth closed-open polyline (Catmull-Rom) with fast distance queries. */
export class Route {
  readonly px: number[] = [];
  readonly pz: number[] = [];
  readonly len: number[] = [];
  readonly total: number;

  constructor(readonly ctrl: ReadonlyArray<readonly [number, number]>) {
    const c = ctrl;
    const at = (i: number) => c[clamp(i, 0, c.length - 1)];
    for (let i = 0; i < c.length - 1; i++) {
      const p0 = at(i - 1);
      const p1 = at(i);
      const p2 = at(i + 1);
      const p3 = at(i + 2);
      const steps = 24;
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        this.px.push(cr(p0[0], p1[0], p2[0], p3[0], t));
        this.pz.push(cr(p0[1], p1[1], p2[1], p3[1], t));
      }
    }
    this.px.push(c[c.length - 1][0]);
    this.pz.push(c[c.length - 1][1]);
    let acc = 0;
    this.len.push(0);
    for (let i = 1; i < this.px.length; i++) {
      acc += Math.hypot(this.px[i] - this.px[i - 1], this.pz[i] - this.pz[i - 1]);
      this.len.push(acc);
    }
    this.total = acc;
  }

  /** Nearest point: sets `qt` (0..1 along length), returns distance. */
  qt = 0;
  dist(x: number, z: number): number {
    let best = 1e18;
    let bt = 0;
    for (let i = 0; i < this.px.length - 1; i++) {
      const ax = this.px[i];
      const az = this.pz[i];
      const bx = this.px[i + 1] - ax;
      const bz = this.pz[i + 1] - az;
      const l2 = bx * bx + bz * bz || 1e-9;
      let t = ((x - ax) * bx + (z - az) * bz) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = ax + bx * t - x;
      const dz = az + bz * t - z;
      const d = dx * dx + dz * dz;
      if (d < best) {
        best = d;
        bt = this.len[i] + Math.sqrt(l2) * t;
      }
    }
    this.qt = bt / this.total;
    return Math.sqrt(best);
  }

  /** Point at 0..1 along the route's length. */
  at(t: number): [number, number] {
    const target = clamp(t, 0, 1) * this.total;
    let lo = 0;
    let hi = this.len.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (this.len[m] <= target) lo = m;
      else hi = m;
    }
    const f = (target - this.len[lo]) / Math.max(1e-6, this.len[hi] - this.len[lo]);
    return [lerp(this.px[lo], this.px[hi], f), lerp(this.pz[lo], this.pz[hi], f)];
  }

  /** Unit tangent at t. */
  dir(t: number): [number, number] {
    const a = this.at(t - 0.004);
    const b = this.at(t + 0.004);
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  }

  /** Coarse distance/param grid for bulk evaluation. */
  bake(half: number, n: number): { d: Float32Array; t: Float32Array; n: number; half: number } {
    const d = new Float32Array(n * n);
    const t = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1) - 0.5) * 2 * half;
        const z = (j / (n - 1) - 0.5) * 2 * half;
        d[j * n + i] = this.dist(x, z);
        t[j * n + i] = this.qt;
      }
    }
    return { d, t, n, half };
  }
}

function cr(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t3)
  );
}
