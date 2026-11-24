import type { Config } from './config';
import type { TerrainProvider } from './terrain';
import { smoothstep } from './math';

/**
 * The air abstraction: the sim asks "how fast is the air rising here?" and
 * never where the answer comes from.
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
  /** height (m) where the column dissolves */
  top: number;
  /** ground height at its foot */
  ground: number;
}

/** Steady wind shared by everything that leans, drifts or climbs a slope. */
export interface Wind {
  x: number;
  z: number;
}

/**
 * Columns of warm air. Strongest at the core, gaussian at the edge, easing
 * off toward the top instead of hitting a lid.
 */
export class ThermalField implements LiftProvider {
  /** day factor: thermals sleep at dawn and tire at dusk */
  vigor = 1;
  constructor(readonly thermals: Thermal[]) {}

  liftAt(x: number, y: number, z: number): number {
    let total = 0;
    for (const t of this.thermals) {
      const dx = x - t.x;
      const dz = z - t.z;
      const r2 = (dx * dx + dz * dz) / (t.radius * t.radius);
      if (r2 > 9) continue;
      const fade = 1 - smoothstep(t.top * 0.72, t.top, y);
      total += t.strength * Math.exp(-r2) * fade;
    }
    return total * this.vigor;
  }

  /** Nearest thermal and how far from its axis we are. */
  nearest(x: number, z: number): { t: Thermal; d: number } | null {
    let best: Thermal | null = null;
    let bd = 1e18;
    for (const t of this.thermals) {
      const d = (x - t.x) ** 2 + (z - t.z) ** 2;
      if (d < bd) {
        bd = d;
        best = t;
      }
    }
    return best ? { t: best, d: Math.sqrt(bd) } : null;
  }
}

/**
 * Ridge lift: wind meeting a slope is deflected upward. Derived directly from
 * the terrain's gradient, strongest near the surface, gentle aloft.
 */
export class RidgeLift implements LiftProvider {
  constructor(
    private readonly cfg: Config,
    private readonly terrain: TerrainProvider,
    private readonly wind: Wind,
    private readonly gain: () => number,
  ) {}

  liftAt(x: number, y: number, z: number): number {
    const d = 26; // wide stencil: feel the hill, not the pebble
    const t = this.terrain;
    const hx = (t.heightAt(x + d, z) - t.heightAt(x - d, z)) / (2 * d);
    const hz = (t.heightAt(x, z + d) - t.heightAt(x, z - d)) / (2 * d);
    const up = this.wind.x * hx + this.wind.z * hz;
    if (up <= 0) return 0;
    const agl = y - Math.max(0, t.heightAt(x, z));
    const band = Math.max(0, 1 - agl / this.cfg.ridgeCeiling);
    return Math.min(up, 7) * this.cfg.ridgeGain * this.gain() * band;
  }
}

/**
 * The glass-off: in the last of the light the whole land breathes out, and
 * the air holds you up a little wherever you are. No one is stranded at dusk.
 */
export class GlassOff implements LiftProvider {
  amount = 0;
  constructor(private readonly terrain: TerrainProvider) {}
  liftAt(x: number, y: number, z: number): number {
    if (this.amount <= 0) return 0;
    const agl = y - Math.max(0, this.terrain.heightAt(x, z));
    return this.amount * (1 - smoothstep(60, 180, agl)) * 1.5;
  }
}

/**
 * Warm currents on the night sea: where the water glows, the air rises.
 * The same stripes are drawn in the water by the renderer.
 */
export class GlowCurrents implements LiftProvider {
  constructor(private readonly lines: Array<{ x: number; z: number }[]>) {}
  liftAt(x: number, y: number, z: number): number {
    let best = 1e9;
    for (const l of this.lines) {
      for (let i = 0; i < l.length - 1; i++) {
        const ax = l[i].x;
        const az = l[i].z;
        const bx = l[i + 1].x - ax;
        const bz = l[i + 1].z - az;
        let t = ((x - ax) * bx + (z - az) * bz) / (bx * bx + bz * bz);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = (ax + bx * t - x) ** 2 + (az + bz * t - z) ** 2;
        if (d < best) best = d;
      }
    }
    const r = 80;
    return 2.9 * Math.exp(-best / (r * r)) * (1 - smoothstep(130, 260, y));
  }
}

/** Sum of all lift sources — what the sim actually flies in. */
export class CompositeLift implements LiftProvider {
  constructor(readonly sources: LiftProvider[]) {}
  liftAt(x: number, y: number, z: number): number {
    let total = 0;
    for (const s of this.sources) total += s.liftAt(x, y, z);
    return total;
  }
}
