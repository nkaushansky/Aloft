import type { Config } from './config';

/**
 * The terrain abstraction the whole game is built against. The sim (and later
 * the lift system) only ever asks "how high is the ground here?" — never where
 * that answer comes from. Phase 1's shaped hill and any future real-elevation
 * mode are just other implementations of this interface.
 */
export interface TerrainProvider {
  /** Ground height (m) at a world-space XZ point. */
  heightAt(x: number, z: number): number;
}

/** Phase 0 world: a flat plane at y = 0, everywhere. */
export class FlatTerrain implements TerrainProvider {
  heightAt(_x: number, _z: number): number {
    return 0;
  }
}

/**
 * Phase 1 world: one smooth gaussian hill rising from a flat plain. Gentle
 * everywhere by construction — no cliffs, no creases — which suits both the
 * tone and the ridge-lift math (a continuous gradient).
 */
export class HillTerrain implements TerrainProvider {
  constructor(private readonly cfg: Config) {}

  heightAt(x: number, z: number): number {
    const dx = x - this.cfg.hillX;
    const dz = z - this.cfg.hillZ;
    const r2 = (dx * dx + dz * dz) / (this.cfg.hillRadius * this.cfg.hillRadius);
    return r2 > 12 ? 0 : this.cfg.hillHeight * Math.exp(-r2);
  }
}
