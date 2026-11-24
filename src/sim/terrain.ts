/**
 * The terrain abstraction the whole game is built against. The sim only ever
 * asks "how high is the ground here?" — never where that answer comes from.
 */
export interface TerrainProvider {
  /** Ground height (m) at a world-space XZ point (lakebed included). */
  heightAt(x: number, z: number): number;
}

/** A flat plane at a fixed height — for tests. */
export class FlatTerrain implements TerrainProvider {
  constructor(private readonly h = 0) {}
  heightAt(_x: number, _z: number): number {
    return this.h;
  }
}

/** A baked heightfield core with a coarse far ring around it. */
export class Heightfield implements TerrainProvider {
  constructor(
    private readonly core: Float32Array,
    private readonly n: number,
    private readonly half: number,
    private readonly far: Float32Array,
    private readonly nFar: number,
    private readonly farHalf: number,
  ) {}

  heightAt(x: number, z: number): number {
    const e = Math.max(Math.abs(x), Math.abs(z)) / this.half;
    if (e < 0.95) return bil(this.core, this.n, this.half, x, z);
    const t = Math.min(1, Math.max(0, (e - 0.95) / 0.042));
    const w = 1 - t * t * (3 - 2 * t);
    const f = bil(this.far, this.nFar, this.farHalf, x, z);
    return w > 0 ? w * bil(this.core, this.n, this.half, x, z) + (1 - w) * f : f;
  }
}

/** Anything 8-bit laid over the same core grid (ground masks). */
export class MaskField {
  constructor(
    private readonly data: Uint8Array,
    private readonly n: number,
    private readonly half: number,
  ) {}

  at(x: number, z: number, ch: 0 | 1 | 2 | 3): number {
    const i = Math.round((x / (2 * this.half) + 0.5) * (this.n - 1));
    const j = Math.round((z / (2 * this.half) + 0.5) * (this.n - 1));
    if (i < 0 || j < 0 || i >= this.n || j >= this.n) return 0;
    return this.data[(j * this.n + i) * 4 + ch] / 255;
  }
}

function bil(a: Float32Array, n: number, half: number, x: number, z: number): number {
  const u = Math.min(n - 1.001, Math.max(0, (x / (2 * half) + 0.5) * (n - 1)));
  const v = Math.min(n - 1.001, Math.max(0, (z / (2 * half) + 0.5) * (n - 1)));
  const i = u | 0;
  const j = v | 0;
  const fx = u - i;
  const fz = v - j;
  const k = j * n + i;
  const t0 = a[k] + (a[k + 1] - a[k]) * fx;
  const t1 = a[k + n] + (a[k + n + 1] - a[k + n]) * fx;
  return t0 + (t1 - t0) * fz;
}
