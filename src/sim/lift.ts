import type { Config } from './config';
import type { TerrainProvider } from './terrain';
import { smoothstep } from './math';
import { makeRng } from './noise';

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

/** One thermal's personality: where it lives and how it lifts. */
export interface Thermal {
  x: number;
  z: number;
  radius: number;
  strength: number;
  top: number;
}

/**
 * A seeded field of thermals scattered over the land, each with its own
 * personality — some are broad and gentle, some tight and strong. Every
 * column is strongest at its core, fading with radius (gaussian) and
 * dissolving gently near its top so the climb eases off instead of hitting
 * a lid. Deterministic per seed: the renderer asks for the same list to
 * place the tells (dust, birds).
 */
export class ThermalField implements LiftProvider {
  private thermals: Thermal[] = [];
  private builtKey = '';

  constructor(private readonly cfg: Config) {}

  /** The current thermal list (rebuilt automatically when config changes). */
  list(): Thermal[] {
    const c = this.cfg;
    const key = `${c.thermalCount}|${c.thermalSeed}|${c.thermalStrength}|${c.thermalRadius}|${c.thermalTop}`;
    if (key !== this.builtKey) {
      this.builtKey = key;
      const rng = makeRng(c.thermalSeed * 7919 + 17);
      this.thermals = [];
      for (let i = 0; i < c.thermalCount; i++) {
        const angle = rng() * Math.PI * 2;
        const dist = 400 + rng() * 1500; // never right on top of the launch
        // personality: ±40% size, ±35% strength, ±30% height around the averages
        this.thermals.push({
          x: Math.cos(angle) * dist,
          z: Math.sin(angle) * dist,
          radius: c.thermalRadius * (0.6 + rng() * 0.8),
          strength: c.thermalStrength * (0.65 + rng() * 0.7),
          top: c.thermalTop * (0.7 + rng() * 0.6),
        });
      }
    }
    return this.thermals;
  }

  liftAt(x: number, y: number, z: number): number {
    let total = 0;
    for (const t of this.list()) {
      const dx = x - t.x;
      const dz = z - t.z;
      const r2 = (dx * dx + dz * dz) / (t.radius * t.radius);
      if (r2 > 9) continue;
      const topFade = 1 - smoothstep(t.top * 0.75, t.top, y);
      total += t.strength * Math.exp(-r2) * topFade;
    }
    return total;
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
