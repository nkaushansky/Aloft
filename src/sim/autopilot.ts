import type { BirdState } from './state';
import { forwardOf } from './state';
import type { FlightInput } from './flightModel';
import type { TerrainProvider } from './terrain';
import type { Thermal, ThermalField } from './air';
import type { Route } from '../world/noise';

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const wrap = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

/**
 * "Drift": the bird flies itself. It keeps the road south, works any rising
 * air worth working, and comes down when it arrives — so the game can also
 * simply be watched.
 */
export class Autopilot {
  private at: Thermal | null = null;
  private side = 1;
  private tried = new Map<Thermal, number>();
  private clock = 0;
  private since = 0;
  private bestY = 0;
  private bestT = 0;

  reset(): void {
    this.at = null;
    this.tried.clear();
  }

  fly(s: BirdState, terrain: TerrainProvider, thermals: ThermalField, route: Route, dt: number): FlightInput {
    this.clock += dt;
    const p = s.position;
    route.dist(p.x, p.z);
    const t = route.qt;
    const left = (1 - t) * route.total;
    const f = forwardOf({ yaw: s.yaw, pitch: 0 });
    const plenty = s.agl * 10 > left + 300;

    if (!this.at && !plenty && thermals.vigor > 0.3) {
      const n = thermals.nearest(p.x, p.z);
      if (n && n.d < Math.max(n.t.radius * 1.3, Math.min(380, s.agl * 4)) && p.y < n.t.top * 0.6 && s.agl < 300 && this.clock - (this.tried.get(n.t) ?? -999) > 90) {
        this.at = n.t;
        this.since = this.clock;
        this.bestY = p.y;
        this.bestT = this.clock;
        const dx = n.t.x - p.x;
        const dz = n.t.z - p.z;
        this.side = dx * -f.z + dz * f.x > 0 ? 1 : -1;
      }
    }

    if (this.at) {
      const c = this.at;
      const dx = c.x - p.x;
      const dz = c.z - p.z;
      const d = Math.hypot(dx, dz) + 1e-3;
      if (p.y > this.bestY + 4) {
        this.bestY = p.y;
        this.bestT = this.clock;
      }
      const done = p.y > c.ground + (c.top - c.ground) * 0.72 || this.clock - this.bestT > 26 || this.clock - this.since > 120;
      if (done) {
        this.tried.set(c, this.clock);
        this.at = null;
      } else if (d < c.radius * 2.2) {
        // ride a circle about the core, leaning in or out to hold it
        const R = Math.max(42, c.radius * 0.42);
        const toward = Math.atan2(-dx, -dz);
        const k = clamp((d - R) / R, -0.9, 1);
        const want = toward + this.side * (Math.PI / 2) * (1 - 0.72 * Math.max(0, k) + 0.3 * Math.max(0, -k));
        const err = wrap(want - s.yaw);
        const bank = clamp(this.side * 0.42 - err * 0.9, -0.85, 0.85);
        return { pitch: this.pitchFor(s, 17.8), roll: clamp((bank - s.roll) * 2, -1, 1), beat: s.agl < 18 && s.breath > 0.15 };
      } else return this.toward(s, c.x, c.z, terrain);
    }

    const [ex, ez] = route.at(1);
    const dEnd = Math.hypot(ex - p.x, ez - p.z);
    if (dEnd < 700 && s.agl > 170) {
      // come down in wide easy turns
      const bank = dEnd > 320 ? null : 0.5;
      const inp = bank === null ? this.toward(s, ex, ez, terrain) : { pitch: 0, roll: clamp((bank - s.roll) * 2, -1, 1), beat: false };
      return { ...inp, pitch: this.pitchFor(s, 31), beat: false };
    }
    const ahead = route.at(Math.min(1, t + 380 / route.total));
    return this.toward(s, ahead[0], ahead[1], terrain);
  }

  private pitchFor(s: BirdState, speed: number): number {
    const e = (s.airspeed - speed) * 0.06;
    return clamp(e - (s.pitch + 0.05) * 0.5, -0.5, 0.5);
  }

  private toward(s: BirdState, x: number, z: number, terrain: TerrainProvider): FlightInput {
    const p = s.position;
    const d = wrap(Math.atan2(-(x - p.x), -(z - p.z)) - s.yaw);
    let bank = clamp(-d * 0.9, -0.55, 0.55);
    const f = forwardOf({ yaw: s.yaw, pitch: 0 });
    let pitch = this.pitchFor(s, 20.5);
    let beat = false;
    for (const L of [50, 110, 190]) {
      const h = Math.max(0, terrain.heightAt(p.x + f.x * L, p.z + f.z * L));
      if (h + 16 > p.y - L * 0.07) {
        pitch = Math.max(pitch, 0.4 - L * 0.001);
        const l = terrain.heightAt(p.x + f.x * L + f.z * 70, p.z + f.z * L - f.x * 70);
        const r = terrain.heightAt(p.x + f.x * L - f.z * 70, p.z + f.z * L + f.x * 70);
        bank += l < r ? -0.4 : 0.4;
        beat = s.breath > 0.1;
      }
    }
    if (s.agl < 24 && s.breath > 0.12) beat = true;
    return { pitch, roll: clamp((bank - s.roll) * 1.6, -1, 1), beat };
  }
}
