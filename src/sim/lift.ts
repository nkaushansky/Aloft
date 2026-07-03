import type { Config } from './config';
import type { TerrainProvider } from './terrain';
import { smoothstep } from './math';

/**
 * The air abstraction, sibling to TerrainProvider: the sim asks "how fast is
 * the air rising here?" and never where the answer comes from. Phase 1 ships
 * one thermal and ridge lift; later phases add more sources behind the same
 * interface.
 */
export interface LiftProvider {
  /** Vertical air velocity (m/s, positive = rising) at a world point. */
  liftAt(x: number, y: number, z: number): number;
}

/**
 * A single thermal: a rising column over sun-baked ground. Strongest at the
 * core, fading with radius (gaussian) and dissolving gently near its top so
 * the climb eases off instead of hitting a lid.
 */
export class ThermalLift implements LiftProvider {
  constructor(private readonly cfg: Config) {}

  liftAt(x: number, y: number, z: number): number {
    const dx = x - this.cfg.thermalX;
    const dz = z - this.cfg.thermalZ;
    const r2 = (dx * dx + dz * dz) / (this.cfg.thermalRadius * this.cfg.thermalRadius);
    if (r2 > 9) return 0; // far outside the column
    const radial = Math.exp(-r2);
    const topFade = 1 - smoothstep(this.cfg.thermalTop * 0.75, this.cfg.thermalTop, y);
    return this.cfg.thermalStrength * radial * topFade;
  }
}

/**
 * Ridge lift: wind meeting a slope is deflected upward. Derived directly
 * from the terrain's gradient — any windward face generates lift, strongest
 * near the surface and fading with height above the ground.
 */
export class RidgeLift implements LiftProvider {
  constructor(
    private readonly cfg: Config,
    private readonly terrain: TerrainProvider,
  ) {}

  liftAt(x: number, y: number, z: number): number {
    const d = 8; // finite-difference step (m) for the terrain gradient
    const hx = (this.terrain.heightAt(x + d, z) - this.terrain.heightAt(x - d, z)) / (2 * d);
    const hz = (this.terrain.heightAt(x, z + d) - this.terrain.heightAt(x, z - d)) / (2 * d);
    const dir = (this.cfg.windDirDeg * Math.PI) / 180;
    // Wind vector: the direction the wind travels toward (0° = -Z, matching yaw 0).
    const wx = -Math.sin(dir) * this.cfg.windSpeed;
    const wz = -Math.cos(dir) * this.cfg.windSpeed;
    const upslope = wx * hx + wz * hz; // wind component climbing the slope
    if (upslope <= 0) return 0; // leeward — no lift (rotor/sink is a later phase)
    const agl = y - this.terrain.heightAt(x, z);
    const band = Math.max(0, 1 - agl / this.cfg.ridgeCeiling);
    return upslope * this.cfg.ridgeGain * band;
  }
}

/** Sum of all lift sources — what the sim actually flies in. */
export class CompositeLift implements LiftProvider {
  constructor(private readonly sources: LiftProvider[]) {}

  liftAt(x: number, y: number, z: number): number {
    let total = 0;
    for (const s of this.sources) total += s.liftAt(x, y, z);
    return total;
  }
}
