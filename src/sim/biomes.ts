import type { Config } from './config';
import type { TerrainProvider } from './terrain';
import { valueNoise } from './noise';
import { clamp } from './math';

/**
 * The biome layer: one seeded source of truth for what the land *is* at any
 * point — water, forest, dry country, meadow. Both sides of the game consult
 * it: the sim (thermals form over sun-baked ground, never over water or
 * under forest) and the renderer (colors, trees, shorelines). Because it
 * derives from the same seeds as the terrain, a seed rebuilds the whole
 * world identically — biomes included (Q7).
 *
 * Biomes do work, never decorate: every answer here changes either where
 * lift lives or what the wind shows.
 */
export class Biomes {
  constructor(
    private readonly cfg: Config,
    private readonly terrain: TerrainProvider,
  ) {}

  /** The water surface height. Terrain below this is lakebed. */
  waterLevel(): number {
    return this.cfg.waterLevel;
  }

  isWater(x: number, z: number): boolean {
    return this.terrain.heightAt(x, z) < this.cfg.waterLevel;
  }

  /** 0..1 forest density — cool, still ground where thermals don't form. */
  forestAt(x: number, z: number): number {
    const h = this.terrain.heightAt(x, z);
    if (h < this.cfg.waterLevel + 2 || h > 150) return 0; // no trees in lakes or on stone
    const n = valueNoise(x / 620 + 31.7, z / 620 + 11.3, this.cfg.terrainSeed * 13 + 5);
    return clamp((n - 0.52) / 0.3, 0, 1);
  }

  /** 0..1 dryness — sun-baked country where thermals are born. */
  drynessAt(x: number, z: number): number {
    const n = valueNoise(x / 950 + 7.1, z / 950 + 47.9, this.cfg.terrainSeed * 29 + 11);
    const dry = clamp((n - 0.45) / 0.35, 0, 1);
    // forests and water cool the land no matter what the dryness noise says
    return dry * (1 - this.forestAt(x, z)) * (this.isWater(x, z) ? 0 : 1);
  }
}
