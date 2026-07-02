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
