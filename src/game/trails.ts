import type { BirdState } from '../sim/state';
import { forwardOf } from '../sim/state';
import type { TerrainProvider } from '../sim/terrain';
import type { Thermal, ThermalField, Wind } from '../sim/air';
import { config } from '../sim/config';
import type { Route } from '../world/noise';
import { makeRng } from '../world/noise';

export interface Feather {
  x: number;
  y: number;
  z: number;
  /** visible amount, 0..1 */
  a: number;
  /** on the air yet? */
  laid: boolean;
  /** seconds until it starts to show */
  wait: number;
  taken: boolean;
  /** seconds since it noticed you and began to come, or -1 */
  pull: number;
  /** shed for you, so it keeps to your height; the rest stay where they hang */
  drift: boolean;
}

interface Trail {
  kind: 'road' | 'thermal' | 'skim' | 'place';
  f: Feather[];
  laid: boolean;
  /** where along the road it belongs */
  t: number;
  thermal?: Thermal;
}

export interface TrailWorld {
  seed: number;
  route: Route;
  terrain: TerrainProvider;
  thermals: ThermalField;
  wind: Wind;
  /** how many of the thermals belong to the road */
  roadThermals: number;
  landmarks: Array<{ x: number; z: number; y: number; yaw: number; kind: string }>;
}

/** a feather this near (height counted more gently) has noticed you, and comes */
const NOTICE = 23;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const wrap = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

/**
 * The flock sheds feathers along the good air. Most are let go *for you*: a
 * line falls ahead of wherever you happen to be, along a glide you could fly
 * without trying, bending home toward the road; a spiral opens in front of
 * you when you lean into rising air, turning the way you are turning. The
 * rest wait by the water and the named places for whoever goes looking.
 */
export class Trails {
  readonly feathers: Feather[] = [];
  private readonly trails: Trail[] = [];
  private turning = 0;
  private sinceRoad = 0;

  constructor(private readonly w: TrailWorld) {
    const rng = makeRng(w.seed * 97 + 41);
    const add = (kind: Trail['kind'], n: number, t: number, thermal?: Thermal): Trail => {
      const tr: Trail = { kind, f: [], laid: false, t, thermal };
      for (let i = 0; i < n; i++) {
        const f: Feather = { x: 0, y: -999, z: 0, a: 0, laid: false, wait: 0, taken: false, pull: -1, drift: kind === 'road' || kind === 'thermal' };
        tr.f.push(f);
        this.feathers.push(f);
      }
      this.trails.push(tr);
      return tr;
    };
    for (const t of w.thermals.thermals.slice(0, w.roadThermals)) add('thermal', 9, 0, t);
    const roads = 10;
    for (let i = 0; i < roads; i++) add('road', 7, 0.035 + (i / roads) * 0.9);

    // two low runs where the road crosses water
    let skims = 0;
    for (let s = 0; s < 14 && skims < 2; s++) {
      const t0 = 0.12 + rng() * 0.74;
      const [x0, z0] = w.route.at(t0);
      if (w.terrain.heightAt(x0, z0) > -0.8) continue;
      const tr = add('skim', 7, t0);
      for (let i = 0; i < 7; i++) {
        const [x, z] = w.route.at(t0 + (i * 34) / w.route.total);
        const [dx, dz] = w.route.dir(t0);
        const off = Math.sin(i * 0.6) * 9;
        this.place(tr.f[i], x - dz * off, this.surf(x, z) + 5, z + dx * off, 0);
      }
      tr.laid = true;
      skims++;
    }

    for (const l of w.landmarks) {
      const tr = add('place', 5, 0);
      const dx = -Math.sin(l.yaw);
      const dz = -Math.cos(l.yaw);
      const lift = l.kind === 'arch' ? 42 : l.kind === 'whale' ? 8 : 28;
      for (let i = 0; i < 5; i++) {
        const u = (i - 2) * 30;
        if (l.kind === 'viaduct') {
          // under the standing arches
          const x = l.x + Math.cos(l.yaw) * 17 - Math.sin(l.yaw) * u;
          const z = l.z - Math.sin(l.yaw) * 17 - Math.cos(l.yaw) * u;
          this.place(tr.f[i], x, Math.max(this.surf(x, z) + 8, 19), z, 0);
        } else {
          const side = l.kind === 'arch' || l.kind === 'whale' ? 0 : 24;
          const x = l.x + dx * u - dz * side;
          const z = l.z + dz * u + dx * side;
          this.place(tr.f[i], x, Math.max(this.surf(l.x, l.z) + lift, this.surf(x, z) + 8), z, 0);
        }
      }
      tr.laid = true;
    }
  }

  private surf(x: number, z: number): number {
    return Math.max(0, this.w.terrain.heightAt(x, z));
  }

  private place(f: Feather, x: number, y: number, z: number, wait: number): void {
    f.x = x;
    f.y = y;
    f.z = z;
    f.laid = true;
    f.wait = wait;
  }

  /** Advance; returns the feathers that reached you this step. */
  step(b: BirdState, progress: number, dt: number): Feather[] {
    const got: Feather[] = [];
    const p = b.position;
    const fwd = forwardOf(b);
    if (b.mode === 'air') {
      this.layThermal(b, dt);
      this.layRoad(b, progress, dt);
    }
    for (const f of this.feathers) {
      if (!f.laid) continue;
      if (f.taken) {
        if (f.a > 0) f.a = Math.max(0, f.a - dt * 3);
        continue;
      }
      if (f.wait > 0) {
        f.wait -= dt;
        continue;
      }
      f.a = Math.min(1, f.a + dt / 1.2);
      const dx = p.x - f.x;
      const dy = p.y + 0.2 - f.y;
      const dz = p.z - f.z;
      const flat = Math.hypot(dx, dz);
      const d = Math.hypot(flat, dy);
      // it floats on the same air you do: steer for it, and it minds the height
      if (f.drift && f.pull < 0 && flat < 300 && b.mode === 'air') {
        const ahead = -(dx * fwd.x + dz * fwd.z);
        if (ahead > 0) {
          const meet = p.y + b.climbRate * Math.min(6, ahead / Math.max(10, b.airspeed));
          const floor = this.surf(f.x, f.z) + 7;
          f.y += clamp(Math.max(meet, floor) - f.y, -5, 5) * Math.min(1, dt * 0.9);
        }
      }
      if (f.pull < 0 && Math.hypot(flat, dy * 0.6) < NOTICE && b.mode === 'air') f.pull = 0;
      if (f.pull >= 0) {
        // it falls into your wake: travels with you, and closes the rest
        f.pull += dt;
        const k = 1 - Math.exp(-dt * (2.2 + f.pull * 7));
        f.x += fwd.x * b.airspeed * dt + dx * k;
        f.y += b.climbRate * dt + dy * k;
        f.z += fwd.z * b.airspeed * dt + dz * k;
        if (d < 2.4 || f.pull > 1.1) {
          f.taken = true;
          got.push(f);
        }
      }
    }
    return got;
  }

  /** A line ahead, along the glide you're already flying, easing home. */
  private layRoad(b: BirdState, progress: number, dt: number): void {
    this.sinceRoad += dt;
    const { route } = this.w;
    const tr = this.trails.find((t) => t.kind === 'road' && !t.laid);
    if (!tr || this.sinceRoad < 9 || progress < tr.t) return;
    const p = b.position;
    route.dist(p.x, p.z);
    const [rx, rz] = route.dir(route.qt);
    const f = forwardOf({ yaw: b.yaw, pitch: 0 });
    // only when you're travelling, not turning in lift or flying home
    if (Math.abs(b.roll) > 0.32 || f.x * rx + f.z * rz < 0.35 || b.agl < 7) return;
    // along your track over the ground, not your nose: the wind has a say
    const vx = f.x * b.airspeed + this.w.wind.x * config.windCarry;
    const vz = f.z * b.airspeed + this.w.wind.z * config.windCarry;
    let yaw = Math.atan2(-vx, -vz);
    let x = p.x - Math.sin(yaw) * 125;
    let z = p.z - Math.cos(yaw) * 125;
    let y = p.y - 5;
    const step = 33;
    for (let i = 0; i < tr.f.length; i++) {
      this.place(tr.f[i], x, Math.max(y, this.surf(x, z) + 9), z, i * 0.16);
      const [tx, tz] = route.at(Math.min(1, route.qt + (340 + i * step) / route.total));
      const want = Math.atan2(-(tx - x), -(tz - z));
      yaw += clamp(wrap(want - yaw), -0.13, 0.13);
      x += -Math.sin(yaw) * step;
      z += -Math.cos(yaw) * step;
      y -= step * 0.066;
    }
    tr.laid = true;
    this.sinceRoad = 0;
  }

  /** A spiral that opens in front of you once you lean into a thermal. */
  private layThermal(b: BirdState, dt: number): void {
    const n = this.w.thermals.nearest(b.position.x, b.position.z);
    const inside = n && n.d < n.t.radius * 1.05 && b.lift > 1.1 && Math.abs(b.roll) > 0.2;
    this.turning = inside ? this.turning + dt : 0;
    if (!inside || this.turning < 0.9) return;
    const tr = this.trails.find((t) => t.kind === 'thermal' && !t.laid && t.thermal === n.t);
    if (!tr || b.position.y > n.t.ground + (n.t.top - n.t.ground) * 0.72) return;
    const p = b.position;
    const f = forwardOf({ yaw: b.yaw, pitch: 0 });
    const side = Math.sign(b.roll);
    const R = clamp((b.airspeed * b.airspeed) / (9.8 * Math.tan(Math.max(0.2, Math.abs(b.roll)))), 40, 92);
    // the middle of the turn you're in, drifting toward the middle of the lift
    let cx = p.x - f.z * side * R;
    let cz = p.z + f.x * side * R;
    let a = Math.atan2(p.z - cz, p.x - cx);
    const dir = side; // leaning right turns clockwise seen from above: +x toward +z
    const step = 34 / R;
    const rise = Math.max(0.9, b.lift - 1.7) * (34 / Math.max(14, b.airspeed));
    let y = p.y;
    for (let i = 0; i < tr.f.length; i++) {
      a += dir * (i === 0 ? step * 1.3 : step);
      y += rise * (i === 0 ? 1.3 : 1);
      cx += (n.t.x - cx) * 0.03;
      cz += (n.t.z - cz) * 0.03;
      this.place(tr.f[i], cx + Math.cos(a) * R, Math.max(y, this.surf(cx, cz) + 8), cz + Math.sin(a) * R, i * 0.18);
    }
    tr.laid = true;
  }
}
