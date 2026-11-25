import * as THREE from 'three';
import { FULL } from './glsl/common';
import { worldMaterial } from './globals';
import type { Water } from './water';
import type { Fx } from './fx';
import type { Route } from '../world/noise';
import type { TerrainProvider } from '../sim/terrain';

/**
 * Whales of the night crossing. Each body is a skin over a nine-point spine
 * that follows the whale's own path through the water, the way a real one
 * rolls: the tail goes everywhere the head has been. Around them the glow
 * wakes; their bodies are the dark in it.
 */

const SP = 9;
const V3 = THREE.Vector3;

interface Whale {
  group: number;
  /** place in the group's circle */
  ang: number;
  rad: number;
  size: number;
  phase: number;
  period: number;
  mesh: THREE.Mesh;
  spine: THREE.Vector3[];
  x: number;
  z: number;
  yaw: number;
  headY: number;
  prevHead: number;
  prevTail: number;
  /** seconds into a leap, or -1 */
  leap: number;
  /** 0..1 gathering itself below, before a leap */
  hold: number;
  roll: number;
  blowT: number;
}

interface Pod {
  x: number;
  z: number;
  r: number;
  dir: number;
  a: number;
  rested: number;
  leaps: number;
}

export interface WhaleEvents {
  blow(dist: number): void;
  breach(dist: number): void;
  splash(dist: number, size: number): void;
}

const PODS: Array<{ t: number; off: number; whales: Array<[number, number, number]> }> = [
  // [angle offset, radius offset, size]
  { t: 0.24, off: -60, whales: [[0, 0, 1.75]] },
  { t: 0.48, off: 90, whales: [[0, 0, 1.9], [-0.13, -11, 0.85]] }, // mother and calf
  { t: 0.7, off: -70, whales: [[0, 0, 1.95], [-0.34, 21, 1.6], [-0.6, -13, 1.75]] },
];

const LEN = 16;
const SPEED = 6.6;

const bump = (x: number) => Math.exp(-x * x);

export class Whales {
  readonly list: Whale[] = [];
  private pods: Pod[] = [];
  private readonly root = new THREE.Group();
  private active = false;
  private time = 0;
  events: WhaleEvents | null = null;

  constructor(
    scene: THREE.Scene,
    private readonly water: Water,
    private readonly fx: Fx,
  ) {
    scene.add(this.root);
    const geo = whaleGeometry();
    PODS.forEach((p, gi) => {
      for (const [ang, rad, size] of p.whales) {
        const spine = Array.from({ length: SP }, () => new V3());
        const mesh = new THREE.Mesh(geo, worldMaterial(VERT, FRAG, { uSp: { value: spine }, uRoll: { value: 0 }, uSize: { value: size }, wGlow: water.u.wGlow, uPh: { value: Math.random() * 6 } }, {}));
        mesh.frustumCulled = false;
        mesh.visible = false;
        this.root.add(mesh);
        this.list.push({ group: gi, ang, rad, size, phase: this.list.length * 0.37 + gi * 0.21, period: 21 + size * 5, mesh, spine, x: 0, z: 0, yaw: 0, headY: -8, prevHead: -8, prevTail: -8, leap: -1, hold: 0, roll: 0, blowT: -1 });
      }
    });
  }

  load(on: boolean, route: Route, terrain: TerrainProvider): void {
    this.active = on;
    for (const w of this.list) w.mesh.visible = on;
    if (!on) {
      this.clearWater();
      return;
    }
    // find them deep water with room to turn, beside the glowing currents
    this.pods = PODS.map((p) => {
      let best = { x: 0, z: 0, s: -1e9, r: 118 };
      for (let i = -6; i <= 6; i++) {
        for (let j = -4; j <= 4; j++) {
          const t = p.t + i * 0.007;
          const [x, z] = route.at(t);
          const [dx, dz] = route.dir(t);
          const off = p.off + j * 45;
          const cx = x - dz * off;
          const cz = z + dx * off;
          let shallow = 0;
          for (let k = 0; k < 16; k++) {
            const a = (k / 16) * 6.283;
            for (const r of [70, 125, 165]) if (terrain.heightAt(cx + Math.cos(a) * r, cz + Math.sin(a) * r) > -18) shallow++;
          }
          const s = -shallow * 10 - Math.abs(i) * 0.6 - Math.abs(j) * 0.8;
          if (s > best.s) best = { x: cx, z: cz, s, r: 118 };
        }
      }
      return { x: best.x, z: best.z, r: best.r, dir: p.off > 0 ? -1 : 1, a: p.t * 20, rested: 99, leaps: 0 };
    });
  }

  private clearWater(): void {
    for (const v of this.water.u.wWhale.value as THREE.Vector4[]) v.w = 0;
  }

  /** The nearest whale, or null in lands that have none. */
  nearest(x: number, z: number): { x: number; y: number; z: number; d: number } | null {
    if (!this.active) return null;
    let best: { x: number; y: number; z: number; d: number } | null = null;
    for (const w of this.list) {
      const d = Math.hypot(w.x - x, w.z - z);
      if (!best || d < best.d) best = { x: w.x, y: w.headY, z: w.z, d };
    }
    return best;
  }

  /** depth of the head along an ordinary swim: two easy rolls, then the dive */
  private swimY(w: Whale, t: number): number {
    const u = (((t / w.period + w.phase) % 1) + 1) % 1;
    const up = 5.0 + w.size * 1.05;
    const k = w.period / (1.5 + w.size * 0.75);
    const b = up * bump((u - 0.15) * k) + up * bump((u - 0.41) * k) + (up + 1.2) * bump((u - 0.68) * k * 1.05);
    return -6.2 + b * (1 - w.hold) - 2.2 * w.hold;
  }

  update(dt: number, bird: { x: number; y: number; z: number }, fwd: { x: number; z: number }): void {
    if (!this.active) return;
    this.time += dt;
    for (const p of this.pods) {
      p.a += (p.dir * SPEED * dt) / p.r;
      p.rested += dt;
    }
    this.maybeLeap(bird, fwd, dt);

    const uw = this.water.u.wWhale.value as THREE.Vector4[];
    const ub = this.water.u.wWhaleB.value as THREE.Vector2[];
    this.list.forEach((w, i) => {
      const p = this.pods[w.group];
      const a = p.a + w.ang * p.dir;
      const R = p.r + w.rad;
      const hx = p.x + Math.cos(a) * R;
      const hz = p.z + Math.sin(a) * R;
      // heading: tangent of the circle
      const fx = -Math.sin(a) * p.dir;
      const fz = Math.cos(a) * p.dir;
      w.yaw = Math.atan2(-fx, -fz);
      const L = LEN * w.size;
      if (w.leap >= 0) this.poseLeap(w, hx, hz, fx, fz, L, dt);
      else this.poseSwim(w, p, a, R, L);
      const mid = w.spine[4];
      w.x = mid.x;
      w.z = mid.z;
      const head = w.spine[0];
      const tail = w.spine[SP - 1];
      w.headY = head.y;
      const d = Math.hypot(head.x - bird.x, head.y - bird.y, head.z - bird.z);
      const near = d < 900;
      if (near) this.surfaceEvents(w, head, tail, d, fx, fz, dt);
      w.prevHead = head.y;
      w.prevTail = tail.y;
      (w.mesh.material as THREE.ShaderMaterial).uniforms.uRoll.value = w.roll;
      if (i < uw.length) {
        // in the air the glow is only where it will land
        uw[i].set(mid.x, mid.z, w.yaw, near ? 1 - Math.min(1, Math.max(0, (mid.y - 1.5) / 3)) : 0);
        ub[i].set(L, Math.min(0, mid.y));
      }
      w.mesh.visible = d < 1600;
    });
  }

  private poseSwim(w: Whale, p: Pod, a: number, R: number, L: number): void {
    w.roll *= 0.97;
    const t = this.time;
    for (let i = 0; i < SP; i++) {
      const b = (i / (SP - 1)) * L;
      const tau = t - b / SPEED;
      const aa = a - (p.dir * b) / R;
      const beat = Math.sin(t * 1.5 + w.phase * 20 - b * 0.34) * 0.34 * w.size * (i / (SP - 1)) ** 2;
      w.spine[i].set(p.x + Math.cos(aa) * R, this.swimY(w, tau) + beat, p.z + Math.sin(aa) * R);
    }
  }

  /** The leap: one long slow arc, the body following its own nose. */
  private poseLeap(w: Whale, hx: number, hz: number, fx: number, fz: number, L: number, dt: number): void {
    w.leap += dt * 0.82;
    const T = w.leap;
    const k = 0.45 + 0.55 * (w.size / 1.9);
    const vy = 18.6 * k;
    const g = 6.3 * k;
    const vh = 7.6;
    const y0 = -12.5 * k;
    const path = (t: number): [number, number] => {
      // before the launch it was rising from the deep on the same line
      if (t < 0) return [vh * t, y0 + vy * t * 0.62];
      return [vh * t, y0 + vy * t - 0.5 * g * t * t];
    };
    const [hxp, hyp] = path(T);
    let px = hxp;
    let py = hyp;
    let t = T;
    let acc = 0;
    let idx = 0;
    const step = L / (SP - 1);
    const at = (along: number, y: number, i: number) => {
      const s = along - vh * T; // relative to the head's own place on the circle
      w.spine[i].set(hx + fx * s, y, hz + fz * s);
    };
    at(hxp, hyp, 0);
    while (idx < SP - 1 && t > T - 8) {
      t -= 0.02;
      const [nx, ny] = path(t);
      const d = Math.hypot(nx - px, ny - py);
      if (acc + d >= step) {
        const k = (step - acc) / d;
        px += (nx - px) * k;
        py += (ny - py) * k;
        idx++;
        at(px, py, idx);
        acc = 0;
      } else {
        acc += d;
        px = nx;
        py = ny;
      }
    }
    w.roll = 0.95 * Math.sin(Math.min(1, Math.max(0, (T - 0.7) / 4.6)) * Math.PI);
    if (w.spine[SP - 1].y < -5.5 && T > 4) {
      w.leap = -1;
      // rejoin the ordinary swim while still deep
      const u = (this.time / w.period) % 1;
      w.phase = 0.88 - u;
    }
  }

  /** Someone worth leaping for: coming this way, near, and not too often. */
  private maybeLeap(bird: { x: number; y: number; z: number }, fwd: { x: number; z: number }, dt: number): void {
    for (let g = 0; g < this.pods.length; g++) {
      const p = this.pods[g];
      const w = this.list.find((q) => q.group === g)!;
      if (w.leap >= 0) continue;
      const dx = w.x - bird.x;
      const dz = w.z - bird.z;
      const d = Math.hypot(dx, dz);
      const ahead = (dx * fwd.x + dz * fwd.z) / (d + 1);
      const willing = (p.leaps === 0 || p.rested > 38) && bird.y < 340;
      // it goes down first, and waits for you there
      const gather = willing && d < 560 && ahead > 0.55;
      w.hold += ((gather ? 1 : 0) - w.hold) * (1 - Math.exp(-dt * (gather ? 0.9 : 0.4)));
      if (gather && w.hold > 0.85 && w.spine[0].y < -4 && w.spine[SP - 1].y < -1.5 && d > 70 && d < 245 && ahead > 0.6) {
        w.leap = 0;
        w.hold = 0;
        p.rested = 0;
        p.leaps++;
        this.events?.breach(d);
      }
    }
  }

  private surfaceEvents(w: Whale, head: THREE.Vector3, tail: THREE.Vector3, d: number, fx: number, fz: number, dt: number): void {
    const s = w.size;
    // the breath: a tall soft plume as the back of the head clears
    if (w.leap < 0 && w.prevHead < 0.1 && head.y >= 0.1) {
      w.blowT = 0;
      this.events?.blow(d);
    }
    if (w.blowT >= 0) {
      w.blowT += dt;
      const n = Math.random() < dt * 60 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const h = w.spine[1];
        this.fx.spark(h.x + (Math.random() - 0.5) * 0.5, Math.max(0.4, h.y + 1.5 * s), h.z + (Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 1.5 + fx, (6.5 + Math.random() * 5.5) * s, (Math.random() - 0.5) * 1.5 + fz, 3);
      }
      if (w.blowT > 0.75) w.blowT = -1;
    }
    const cross = (prev: number, now: number) => (prev < 0.2 && now >= 0.2) || (prev > 0.2 && now <= 0.2);
    const big = w.leap >= 0;
    if (cross(w.prevHead, head.y) || cross(w.prevTail, tail.y)) {
      const c = cross(w.prevHead, head.y) ? head : tail;
      this.water.ring(c.x, c.z, big ? 2.6 : 1.1);
      const n = big ? 46 : 9;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * 6.283;
        const r = Math.random() * 1.8 * s;
        const v = (big ? 2 + Math.random() * 4.5 : 1 + Math.random() * 1.5) * s;
        this.fx.spark(c.x + Math.cos(a) * r, 0.2, c.z + Math.sin(a) * r, Math.cos(a) * v, (big ? 3 + Math.random() * 7 : 1.5 + Math.random() * 2) * s, Math.sin(a) * v, i % 3 === 0 ? 3 : 4);
      }
      if (big) {
        for (let k = 1; k < 4; k++) setTimeout(() => this.water.ring(c.x, c.z, 2.2 - k * 0.5), k * 340);
        this.events?.splash(d, s);
      } else if (d < 220) this.events?.splash(d, 0.35 * s);
    }
    // out of the water, the body sheds light
    if (big && Math.random() < dt * 70) {
      const q = w.spine[2 + Math.floor(Math.random() * 6)];
      if (q.y > 0.5) this.fx.spark(q.x + (Math.random() - 0.5) * 2, q.y - 1.2 * s, q.z + (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 1.2, -0.4, (Math.random() - 0.5) * 1.2, 4);
    }
  }
}

/** attributes: position = (x, y offsets in the cross-section, extra z), aS = along the spine, aK = kind */
function whaleGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const as: number[] = [];
  const idx: number[] = [];
  const R = 34;
  const S = 18;
  // half-width, half-height, centre lift; s: 0 nose .. 1 tail
  const prof: Array<[number, number, number, number]> = [
    [0, 0.05, 0.05, -0.05], [0.015, 0.42, 0.28, -0.04], [0.05, 0.82, 0.58, -0.02], [0.11, 1.18, 0.98, 0.0], [0.18, 1.46, 1.32, 0.02], [0.27, 1.66, 1.56, 0.03],
    [0.36, 1.72, 1.64, 0.04], [0.46, 1.62, 1.56, 0.05], [0.56, 1.36, 1.36, 0.07], [0.66, 1.0, 1.08, 0.1], [0.76, 0.62, 0.8, 0.1], [0.85, 0.36, 0.56, 0.08], [0.93, 0.26, 0.36, 0.04], [1, 0.22, 0.14, 0],
  ];
  const sample = (s: number): [number, number, number] => {
    let i = 0;
    while (i < prof.length - 2 && prof[i + 1][0] < s) i++;
    const a = prof[i];
    const b = prof[i + 1];
    let t = (s - a[0]) / (b[0] - a[0]);
    t = Math.max(0, Math.min(1, t));
    t = t * t * (3 - 2 * t) * 0.5 + t * 0.5;
    return [a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t];
  };
  for (let i = 0; i <= R; i++) {
    const s = Math.pow(i / R, 1.15);
    const [w, h, c] = sample(s);
    for (let k = 0; k <= S; k++) {
      const a = (k / S) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      // flat-bottomed head, full throat
      const flat = s < 0.3 && sa > 0.2 ? 1 - 0.12 * (1 - s / 0.3) : 1;
      let y = sa * h * flat + c;
      if (s > 0.6 && s < 0.75 && sa > 0.92) y += 0.42 * Math.sin(((s - 0.6) / 0.15) * Math.PI); // the hump
      pos.push(ca * w, y, 0);
      const l = Math.hypot(ca / w, sa / h) || 1;
      nor.push(ca / w / l, sa / h / l, 0);
      as.push(s, 0, sa, 0);
    }
  }
  for (let i = 0; i < R; i++)
    for (let k = 0; k < S; k++) {
      const a = i * (S + 1) + k;
      idx.push(a, a + 1, a + S + 1, a + 1, a + S + 2, a + S + 1);
    }
  // flippers: long, scalloped, rowing slowly
  for (const sd of [-1, 1]) {
    const base = pos.length / 3;
    const N = 9;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const ch = 1.2 * Math.pow(1 - t, 0.5) + 0.12 + 0.1 * Math.sin(t * 15);
      for (const e of [-1, 1]) {
        pos.push(sd * 1.25, -0.5, 0);
        nor.push(0, 1, 0);
        as.push(0.285 + (e * ch * 0.5 + t * 1.5) / LEN, 1, t * sd, e);
      }
    }
    for (let i = 0; i < N; i++) {
      const a = base + i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2, a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  // flukes
  {
    const base = pos.length / 3;
    const N = 16;
    for (let i = 0; i <= N; i++) {
      const u = (i / N) * 2 - 1;
      const x = u * 2.75;
      const au = Math.abs(u);
      const lead = -0.35 + au * 1.15;
      const trail = 0.78 + 0.35 * Math.sin(au * Math.PI) - 0.42 * Math.exp(-au * au * 40) + au * 0.12;
      for (const e of [0, 1]) {
        pos.push(x, 0.06 * (1 - au), 0);
        nor.push(0, 1, 0);
        as.push(1 + (e ? trail : lead) / LEN, 2, u, e);
      }
    }
    for (let i = 0; i < N; i++) {
      const a = base + i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2, a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aS', new THREE.Float32BufferAttribute(as, 4));
  g.setIndex(idx);
  return g;
}

const VERT = /* glsl */ `
${FULL}
in vec4 aS;
uniform vec3 uSp[${SP}];
uniform float uRoll, uSize, uPh;
out vec3 vW; out vec3 vN; out vec4 vS;
vec3 spine(float s){
  float f = clamp(s, 0.0, 1.12) * float(${SP - 1});
  int i = int(min(floor(f), float(${SP - 2})));
  float u = f - float(i);
  vec3 a = uSp[max(i - 1, 0)], b = uSp[i], c = uSp[i + 1], d = uSp[min(i + 2, ${SP - 1})];
  return 0.5 * (2.0 * b + (c - a) * u + (2.0 * a - 5.0 * b + 4.0 * c - d) * u * u + (3.0 * b - a - 3.0 * c + d) * u * u * u);
}
void main(){
  float s = aS.x;
  vec3 p = spine(min(s, 1.0));
  vec3 T = normalize(spine(max(min(s, 1.0) - 0.03, 0.0)) - spine(min(min(s, 1.0) + 0.03, 1.0)));
  vec3 Rr = normalize(cross(T, vec3(0.0, 1.0, 0.0)));
  vec3 U = cross(Rr, T);
  float cr = cos(uRoll), sr = sin(uRoll);
  vec3 X = Rr * cr + U * sr, Y = U * cr - Rr * sr;
  vec3 q = position, n = normal;
  if (aS.y > 0.5 && aS.y < 1.5){
    float t = abs(aS.z), sd = sign(aS.z);
    float a = 0.55 + 0.32 * sin(uTime * 0.9 + uPh);
    float len = 4.6;
    q.x += sd * cos(a) * len * t;
    q.y -= sin(a) * len * t;
    n = normalize(vec3(sd * sin(a), cos(a), 0.0));
  }
  if (s > 1.0){ p += -T * (s - 1.0) * ${LEN.toFixed(1)} * uSize; }
  vW = p + (X * q.x + Y * q.y) * uSize;
  vN = normalize(X * n.x + Y * n.y + T * (aS.y < 0.5 ? (s < 0.12 ? 0.6 : 0.0) : 0.0));
  vS = aS;
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}
`;

const FRAG = /* glsl */ `
${FULL}
in vec3 vW; in vec3 vN; in vec4 vS;
uniform vec3 wGlow;
layout(location = 0) out vec4 o;
void main(){
  vec3 V = normalize(uCamPos - vW);
  vec3 N = normalize(vN);
  if (dot(N, V) < 0.0) N = -N;
  float ang = asin(clamp(vS.z, -1.0, 1.0));
  float m = nz(vec2(vS.x * 2.6, ang * 0.16)).r, m2 = nz(vec2(vS.x * 11.0, ang * 0.5)).b, m3 = nz(vec2(vS.x * 31.0, ang * 1.6)).r;
  vec3 col = mix(vec3(0.016, 0.019, 0.025), vec3(0.040, 0.045, 0.054), smoothstep(0.35, 0.7, m * 0.6 + m2 * 0.4));
  if (vS.y < 0.5){
    // pale throat with its long pleats, running back to the belly
    float belly = smoothstep(-0.12, -0.55, vS.z + (m - 0.5) * 0.5) * smoothstep(0.66, 0.36, vS.x);
    float pl = sin(ang * 46.0 + m * 2.0);
    float pleat = smoothstep(0.1, 0.9, pl) * smoothstep(0.52, 0.3, vS.x);
    col = mix(col, vec3(0.26, 0.275, 0.29) * (0.55 + 0.75 * m2) * (1.0 - 0.6 * pleat), belly);
    N = normalize(N + vec3(0.0, cos(ang * 46.0 + m * 2.0) * 0.25 * belly, 0.0));
    // the line of the mouth, and the chin's knuckles and barnacles
    float mouth = smoothstep(0.035, 0.0, abs(vS.z + 0.05 + vS.x * 1.1)) * smoothstep(0.24, 0.16, vS.x);
    col *= 1.0 - 0.7 * mouth;
    col += vec3(0.13, 0.13, 0.12) * smoothstep(0.70, 0.82, nz(vec2(vS.x * 23.0, ang * 1.9)).g) * smoothstep(0.2, 0.02, vS.x) * 0.8;
    float eye = length(vec2((vS.x - 0.2) * 26.0, (vS.z + 0.22) * 5.0));
    col = mix(col, vec3(0.10), smoothstep(0.55, 0.4, eye)); col = mix(col, vec3(0.004), smoothstep(0.32, 0.22, eye));
  } else {
    col = mix(col, vec3(0.28, 0.295, 0.31) * (0.6 + 0.7 * m3), smoothstep(0.42, 0.62, m2 + (dot(N, vec3(0.0, 1.0, 0.0)) < 0.0 ? 0.25 : -0.08)) * 0.75);
  }
  // pale scratches and old moons of scar
  float scr = smoothstep(0.035, 0.0, abs(nz(vec2(vS.x * 3.1 + ang * 0.4, ang * 0.2 + 0.6)).r - 0.5));
  col += vec3(0.07) * scr * smoothstep(0.45, 0.7, m);
  col *= 0.75 + 0.5 * m3;
  float sh = cloudShadowAt(vW);
  float nl = sat((dot(N, uKeyDir) + 0.1) / 1.1);
  vec3 c = col * (uKeyCol * nl * sh * 1.6 + ambient(N, 1.0) * 0.9);
  // wet skin holds the moon, the sky, and whatever is shining overhead
  vec3 H = normalize(V + uKeyDir);
  c += uKeyCol * sh * (pow(sat(dot(N, H)), 110.0) * 1.1 + pow(sat(dot(N, H)), 18.0) * 0.07) * (0.6 + 0.8 * m3);
  float fr = pow(1.0 - sat(dot(N, V)), 3.6);
  c += uKeyCol * sh * fr * pow(sat(dot(-V, uKeyDir) * 0.5 + 0.5), 3.0) * 0.6;
  vec3 R = reflect(-V, N);
  c += (skyBase(vec3(R.x, abs(R.y), R.z)) * 0.55 + vec3(0.04, 0.22, 0.16) * uAurora * sat(N.y)) * (0.03 + 0.55 * fr);
  // the sea's light: on the skin at the waterline, all round it below
  float night = sat(uStars * 1.4);
  float under = smoothstep(0.4, -0.8, vW.y);
  float lap = exp(-pow((vW.y - 0.3) / 0.6, 2.0)) * (0.35 + 0.65 * nz(vW.xz / 3.0 + uTime * 0.05).r);
  // streams of it running off a body that has just come up
  float run = smoothstep(0.56, 0.66, nz(vec2(vS.x * 7.0, ang * 0.9 + uTime * 0.05)).r) * sat(1.0 - vW.y / 16.0) * (1.0 - under);
  float dots = smoothstep(0.80, 0.95, nz(vec2(vS.x * 19.0, ang * 1.3)).a) * (0.5 + 0.5 * sin(uTime * 1.6 + vS.x * 30.0));
  c += wGlow * night * (under * (0.03 + 0.75 * fr + 0.3 * dots) + lap * 0.4 + run * 0.10 + (1.0 - under) * dots * 0.07);
  o = vec4(c, 1.0);
}
`;
