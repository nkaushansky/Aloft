import type { BirdState } from './state';
import { forwardOf } from './state';
import type { TerrainProvider } from './terrain';

/** A bird that isn't you. */
export interface Companion {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  roll: number;
  beat: number;
  beatPhase: number;
  fold: number;
  /** waiting somewhere | flying with you | standing at the roost */
  state: 'waiting' | 'circling' | 'joining' | 'with' | 'landing' | 'roosted';
  /** waiting spot or circle centre */
  hx: number;
  hy: number;
  hz: number;
  hr: number;
  t: number;
  slot: number;
  vx: number;
  vy: number;
  vz: number;
  seed: number;
  scale: number;
}

/**
 * The company. You are the youngest, so you fly at the back: the others spread
 * ahead on either hand in a wide open V, swinging through turns a moment
 * behind you, each with its own small wander.
 */
export class Flock {
  readonly birds: Companion[] = [];
  private time = 0;
  /** the leader's smoothed heading and ground velocity */
  private yaw = 0;
  private gx = 0;
  private gy = 0;
  private gz = 0;
  private lx = 0;
  private ly = 0;
  private lz = 0;
  private fresh = true;

  add(b: Partial<Companion> & Pick<Companion, 'x' | 'y' | 'z' | 'state'>): Companion {
    const c: Companion = {
      id: this.birds.length,
      yaw: 0,
      pitch: 0,
      roll: 0,
      beat: 0,
      beatPhase: Math.random() * 6,
      fold: b.state === 'waiting' || b.state === 'roosted' ? 1 : 0,
      hx: b.x,
      hy: b.y,
      hz: b.z,
      hr: 40,
      t: Math.random() * 6.28,
      slot: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      seed: Math.random() * 100,
      scale: 0.96 + Math.random() * 0.1,
      ...b,
    };
    this.birds.push(c);
    return c;
  }

  clear(): void {
    this.birds.length = 0;
    this.fresh = true;
  }

  get with(): number {
    let n = 0;
    for (const b of this.birds) if (b.state === 'with' || b.state === 'joining') n++;
    return n;
  }

  join(c: Companion): void {
    c.state = 'joining';
    c.t = 0;
    c.slot = this.birds.filter((b) => b !== c && (b.state === 'with' || b.state === 'joining')).length;
  }

  step(leader: BirdState, dt: number, terrain: TerrainProvider): void {
    this.time += dt;
    const p = leader.position;
    if (this.fresh || Math.hypot(p.x - this.lx, p.z - this.lz) > 30) {
      this.fresh = false;
      this.yaw = leader.yaw;
      this.gx = this.gy = this.gz = 0;
    } else if (dt > 1e-4) {
      const k = 1 - Math.exp(-dt * 5);
      this.gx += ((p.x - this.lx) / dt - this.gx) * k;
      this.gy += ((p.y - this.ly) / dt - this.gy) * k;
      this.gz += ((p.z - this.lz) / dt - this.gz) * k;
    }
    this.lx = p.x;
    this.ly = p.y;
    this.lz = p.z;
    let dYaw = leader.yaw - this.yaw;
    while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
    while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
    this.yaw += dYaw * (1 - Math.exp(-dt * 2.2));
    for (const b of this.birds) {
      switch (b.state) {
        case 'circling':
          this.circle(b, dt);
          break;
        case 'with':
        case 'joining':
          this.follow(b, leader, dt, terrain);
          break;
        case 'landing':
          this.settle(b, dt, terrain);
          break;
        default:
          b.fold = Math.min(1, b.fold + dt * 1.2);
          b.beat *= Math.exp(-dt * 3);
          b.pitch *= Math.exp(-dt * 3);
          b.roll *= Math.exp(-dt * 3);
      }
    }
  }

  private circle(b: Companion, dt: number): void {
    const v = 13;
    b.t += (v / b.hr) * dt;
    b.x = b.hx + Math.cos(b.t) * b.hr;
    b.z = b.hz + Math.sin(b.t) * b.hr;
    b.y = b.hy + Math.sin(b.t * 0.31 + b.seed) * 9;
    // heading is the tangent: d/dt(cos, sin) = (-sin, cos)
    b.yaw = Math.atan2(Math.sin(b.t), -Math.cos(b.t));
    b.roll = 0.42;
    b.pitch = 0.04;
    b.fold = 0;
  }

  private follow(b: Companion, leader: BirdState, dt: number, terrain: TerrainProvider): void {
    b.t += dt;
    const side = b.slot % 2 === 0 ? 1 : -1;
    const rank = Math.floor(b.slot / 2) + 1;
    const f = forwardOf({ yaw: this.yaw, pitch: 0 });
    const lat = side * (4.6 + 3.0 * (rank - 1) + Math.sin(this.time * 0.37 + b.seed) * 0.5);
    const ahead = -0.4 + 2.5 * (rank - 1) + (side > 0 ? 0.9 : 0) + Math.sin(this.time * 0.29 + b.seed * 2) * 0.6;
    const up = 0.3 + 0.35 * rank + Math.sin(this.time * 0.43 + b.seed * 3) * 0.5;
    const tx = leader.position.x + f.x * ahead - f.z * lat;
    const tz = leader.position.z + f.z * ahead + f.x * lat;
    let ty = leader.position.y + up - leader.roll * lat * 0.12;
    const g = Math.max(0, terrain.heightAt(tx, tz)) + 2.2;
    if (ty < g) ty = g;
    // spring toward the slot; far birds hurry without teleporting
    const dx = tx - b.x;
    const dy = ty - b.y;
    const dz = tz - b.z;
    const d = Math.hypot(dx, dy, dz);
    const lv = Math.hypot(this.gx, this.gz);
    const chase = b.state === 'joining' ? Math.min(1, b.t / 4) : 1;
    const k = 1.9 * chase;
    const maxV = 16 + lv;
    let wx = this.gx + dx * k;
    let wy = this.gy + dy * k;
    let wz = this.gz + dz * k;
    const wl = Math.hypot(wx, wy, wz);
    if (wl > maxV) {
      wx *= maxV / wl;
      wy *= maxV / wl;
      wz *= maxV / wl;
    }
    const a = 1 - Math.exp(-dt * 3.4);
    b.vx += (wx - b.vx) * a;
    b.vy += (wy - b.vy) * a;
    b.vz += (wz - b.vz) * a;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z += b.vz * dt;
    if (d < 6 && b.state === 'joining' && b.t > 1.5) b.state = 'with';
    const sp = Math.hypot(b.vx, b.vz);
    if (sp > 1) {
      const yaw = Math.atan2(-b.vx, -b.vz);
      let dyaw = yaw - b.yaw;
      while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
      while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
      const turn = dyaw * (1 - Math.exp(-dt * 4));
      b.yaw += turn;
      const want = Math.max(-0.9, Math.min(0.9, (-turn / Math.max(dt, 1e-4)) * 1.4 * 0.7 + leader.roll * 0.35));
      b.roll += (want - b.roll) * (1 - Math.exp(-dt * 2.6));
      const wp = Math.atan2(b.vy, Math.max(6, sp)) * 0.7;
      b.pitch += (wp - b.pitch) * (1 - Math.exp(-dt * 3));
    }
    const eff = Math.max(b.state === 'joining' ? 0.7 : 0, leader.beat * 0.9, d > 9 ? 0.6 : 0, b.vy > 2.5 && leader.lift < 1 ? 0.4 : 0);
    b.beat += (eff - b.beat) * (1 - Math.exp(-dt * 2));
    b.beatPhase += dt * (1.2 + 6.2 * b.beat);
    b.fold *= Math.exp(-dt * 3);
  }

  private settle(b: Companion, dt: number, terrain: TerrainProvider): void {
    b.t += dt;
    const g = Math.max(-0.35, terrain.heightAt(b.hx, b.hz));
    const dx = b.hx - b.x;
    const dz = b.hz - b.z;
    const dy = g - b.y;
    const d = Math.hypot(dx, dz);
    const sp = Math.min(13, 2 + d * 0.42);
    const k = 1 - Math.exp(-dt * 1.8);
    b.vx += ((dx / (d + 0.01)) * sp - b.vx) * k;
    b.vz += ((dz / (d + 0.01)) * sp - b.vz) * k;
    const gl = d > 6 ? -Math.max(0, b.y - g) / Math.max(1, d / sp) : dy * 1.5;
    b.vy += (gl - b.vy) * k;
    b.x += b.vx * dt;
    b.y = Math.max(g, b.y + b.vy * dt);
    b.z += b.vz * dt;
    if (Math.hypot(b.vx, b.vz) > 0.6) {
      const yaw = Math.atan2(-b.vx, -b.vz);
      let dyaw = yaw - b.yaw;
      while (dyaw > Math.PI) dyaw -= 2 * Math.PI;
      while (dyaw < -Math.PI) dyaw += 2 * Math.PI;
      const tn = dyaw * (1 - Math.exp(-dt * 2));
      b.yaw += tn;
      b.roll += (Math.max(-0.6, Math.min(0.6, -tn / Math.max(dt, 1e-4))) - b.roll) * k;
    }
    b.pitch += ((d < 20 ? 0.25 : 0) - b.pitch) * k;
    b.beat += ((d < 24 && d > 2 ? 0.7 : 0) - b.beat) * k;
    b.beatPhase += dt * (1.2 + 6.2 * b.beat);
    if (d < 1.6 && b.y - g < 0.5) {
      b.state = 'roosted';
      b.x = b.hx;
      b.z = b.hz;
      b.y = g;
      b.t = 0;
    }
  }
}
