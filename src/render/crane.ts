import * as THREE from 'three';
import { FULL } from './glsl/common';
import { worldMaterial } from './globals';
import { makeRng } from '../world/noise';

/**
 * The crane. Not a model file: a skeleton of three bones a side, some two
 * hundred feathers laid over it, and a soft body drawn through splines — all
 * posed from the flight state every frame, so nothing about it ever loops.
 */

const V3 = THREE.Vector3;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const D = Math.PI / 180;

export interface Pose {
  /** 0 spread .. 1 folded against the body */
  fold: number;
  /** partial tuck for speed, 0..1 */
  tuck: number;
  flapPhase: number;
  flapAmp: number;
  /** resting dihedral (rad) */
  dihedral: number;
  /** primaries bending up under load, 0..1 */
  load: number;
  /** left/right asymmetry in a turn, -1..1 */
  bank: number;
  /** 0 trailing .. 1 standing */
  legs: number;
  /** 0 outstretched .. 1 raised in an S */
  neck: number;
  neckYaw: number;
  neckPitch: number;
  tailFan: number;
  /** braking: wings cupped forward */
  flare: number;
  /** standing on one leg 0..1 */
  oneLeg: number;
  /** walk phase for a few steps */
  step: number;
  stepAmp: number;
  /** head tucked under wing, asleep 0..1 */
  sleep: number;
}

export function glidePose(): Pose {
  return { fold: 0, tuck: 0, flapPhase: 0, flapAmp: 0, dihedral: 0.06, load: 0.4, bank: 0, legs: 0, neck: 0, neckYaw: 0, neckPitch: 0, tailFan: 0.35, flare: 0, oneLeg: 0, step: 0, stepAmp: 0, sleep: 0 };
}

const F_STRIDE = 16;
const FEATHERS_PER_BIRD = 310;

/** One shared instanced draw holding every near bird's feathers. */
export class FeatherField {
  readonly mesh: THREE.Mesh;
  readonly shadow: THREE.Mesh;
  private readonly buf: THREE.InstancedInterleavedBuffer;
  private readonly geo: THREE.InstancedBufferGeometry;
  n = 0;
  readonly data: Float32Array;

  constructor(maxBirds: number) {
    const A = 2;
    const T = 7;
    const pos: number[] = [];
    const idx: number[] = [];
    for (let j = 0; j <= T; j++) for (let i = 0; i <= A * 2; i++) pos.push(i / A - 1, j / T, 0);
    const w = A * 2 + 1;
    for (let j = 0; j < T; j++)
      for (let i = 0; i < A * 2; i++) {
        const a = j * w + i;
        idx.push(a, a + w, a + 1, a + 1, a + w, a + w + 1);
      }
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.geo.setIndex(idx);
    this.data = new Float32Array(maxBirds * FEATHERS_PER_BIRD * F_STRIDE);
    this.buf = new THREE.InstancedInterleavedBuffer(this.data, F_STRIDE, 1);
    this.buf.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iP', new THREE.InterleavedBufferAttribute(this.buf, 4, 0)); // root xyz, length
    this.geo.setAttribute('iD', new THREE.InterleavedBufferAttribute(this.buf, 4, 4)); // dir xyz, width
    this.geo.setAttribute('iU', new THREE.InterleavedBufferAttribute(this.buf, 4, 8)); // up xyz, bend
    this.geo.setAttribute('iC', new THREE.InterleavedBufferAttribute(this.buf, 4, 12)); // tone, rust, notch, rnd
    this.geo.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geo, worldMaterial(F_VERT, F_FRAG, {}, { side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false;
    this.shadow = new THREE.Mesh(this.geo, worldMaterial(F_VERT, DEPTH_FRAG, {}, { side: THREE.DoubleSide }));
    this.shadow.frustumCulled = false;
  }

  begin(): void {
    this.n = 0;
  }

  end(): void {
    this.geo.instanceCount = this.n;
    this.buf.clearUpdateRanges();
    this.buf.addUpdateRange(0, this.n * F_STRIDE);
    this.buf.needsUpdate = true;
  }
}

interface FSpec {
  seg: 0 | 1 | 2; // humerus, forearm, hand
  t: number; // along bone
  fwd: number; // root offset toward the leading edge
  up: number; // lift off the wing plane
  ang: number; // spread direction (rad from +x toward +z)
  len: number;
  wid: number;
  tone: number; // 0 white .. 1 black at the tip
  rust: number;
  notch: number;
  under: boolean;
  rnd: number;
  layer: number;
}

const LH = 0.56;
const LF = 0.78;
const LW = 0.52;

function wingSpecs(): FSpec[] {
  const rng = makeRng(77);
  const out: FSpec[] = [];
  const add = (f: Partial<FSpec> & Pick<FSpec, 'seg' | 't' | 'ang' | 'len' | 'wid'>) =>
    out.push({ fwd: 0, up: 0, tone: 0, rust: 0, notch: 0, under: false, rnd: rng(), layer: 0, ...f });
  // primaries: ten, fanning from back to outward — the fingers
  for (let i = 0; i < 10; i++) {
    const k = i / 9;
    add({ seg: 2, t: 0.04 + k * 0.96, ang: lerp(76, 6, Math.pow(k, 0.92)) * D, len: lerp(0.66, 0.9, Math.sin(Math.PI * (0.25 + k * 0.6))) * (k > 0.88 ? 0.9 : 1), wid: lerp(0.095, 0.072, k), tone: 0.95, notch: clamp01((k - 0.28) / 0.3), layer: 0.002 * i, rust: 0.1 });
  }
  // secondaries
  for (let i = 0; i < 13; i++) {
    const k = i / 12;
    add({ seg: 1, t: k, ang: lerp(97, 78, k) * D, len: lerp(0.6, 0.66, k), wid: 0.092, tone: lerp(0.9, 0.82, k), layer: 0.002 * (k * 6), rust: 0.12 });
  }
  // tertials — long, soft, part of the bustle
  for (let i = 0; i < 8; i++) {
    const k = i / 7;
    add({ seg: 0, t: 0.1 + k * 0.9, ang: lerp(104, 96, k) * D, len: lerp(0.5, 0.62, k), wid: 0.1, tone: 0.75, layer: 0.01, rust: 0.35 });
  }
  // coverts in three courses over the top
  const course = (n: number, len: number, wid: number, fwd: number, up: number, tone: number, rust: number) => {
    for (let i = 0; i < n; i++) {
      const k = (i + 0.5) / n;
      const s = k * (LH + LF + LW * 0.95);
      const seg: 0 | 1 | 2 = s < LH ? 0 : s < LH + LF ? 1 : 2;
      const t = seg === 0 ? s / LH : seg === 1 ? (s - LH) / LF : (s - LH - LF) / LW;
      const ang = seg === 0 ? lerp(102, 96, t) : seg === 1 ? lerp(96, 78, t) : lerp(74, 26, t);
      add({ seg, t, ang: ang * D, len: len * (seg === 2 ? lerp(1, 0.72, t) : 1) * (0.94 + rng() * 0.12), wid, fwd, up, tone, rust: rust * (0.6 + rng() * 0.6), layer: 0.004 * (i % 2) });
    }
  };
  course(27, 0.36, 0.075, 0.015, 0.016, 0.1, 0.5);
  course(27, 0.25, 0.066, 0.045, 0.028, 0.0, 0.7);
  course(28, 0.17, 0.056, 0.075, 0.04, 0.0, 0.85);
  // lining beneath
  for (let i = 0; i < 18; i++) {
    const k = (i + 0.5) / 18;
    const s = k * (LH + LF + LW * 0.8);
    const seg: 0 | 1 | 2 = s < LH ? 0 : s < LH + LF ? 1 : 2;
    const t = seg === 0 ? s / LH : seg === 1 ? (s - LH) / LF : (s - LH - LF) / LW;
    const ang = seg === 0 ? 100 : seg === 1 ? lerp(96, 78, t) : lerp(74, 32, t);
    add({ seg, t, ang: ang * D, len: 0.31, wid: 0.085, fwd: 0.04, up: -0.028, tone: 0.0, rust: 0.2, under: true });
  }
  return out;
}

const SPECS = wingSpecs();

/** rings × sides soft tube list that gets rewritten every frame */
class SoftMesh {
  readonly geo = new THREE.BufferGeometry();
  readonly pos: Float32Array;
  readonly nor: Float32Array;
  readonly col: Float32Array;
  private readonly idx: number[] = [];
  private v = 0;
  private readonly parts: Array<{ start: number; rings: number; sides: number }> = [];

  constructor(maxV: number) {
    this.pos = new Float32Array(maxV * 3);
    this.nor = new Float32Array(maxV * 3);
    this.col = new Float32Array(maxV * 4);
  }

  part(rings: number, sides: number, flip = false): number {
    const start = this.v;
    for (let r = 0; r < rings - 1; r++)
      for (let s = 0; s < sides; s++) {
        const a = start + r * (sides + 1) + s;
        if (flip) this.idx.push(a, a + sides + 1, a + 1, a + 1, a + sides + 1, a + sides + 2);
        else this.idx.push(a, a + 1, a + sides + 1, a + 1, a + sides + 2, a + sides + 1);
      }
    this.v += rings * (sides + 1);
    this.parts.push({ start, rings, sides });
    return this.parts.length - 1;
  }

  finish(): void {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setIndex(this.idx);
    this.geo.setDrawRange(0, this.idx.length);
    this.geo.boundingSphere = new THREE.Sphere(new V3(), 6);
  }

  /** write ring r of part p: centre, tangent-frame axes, radii */
  ring(p: number, r: number, c: THREE.Vector3, ax: THREE.Vector3, ay: THREE.Vector3, rx: number, ry: number, paint: (a: number, out: number[]) => void): void {
    const { start, sides } = this.parts[p];
    const out = [1, 1, 1, 0];
    for (let s = 0; s <= sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const k = start + r * (sides + 1) + s;
      this.pos[k * 3] = c.x + ax.x * ca * rx + ay.x * sa * ry;
      this.pos[k * 3 + 1] = c.y + ax.y * ca * rx + ay.y * sa * ry;
      this.pos[k * 3 + 2] = c.z + ax.z * ca * rx + ay.z * sa * ry;
      const nx = ax.x * ca * ry + ay.x * sa * rx;
      const ny = ax.y * ca * ry + ay.y * sa * rx;
      const nz = ax.z * ca * ry + ay.z * sa * rx;
      const l = Math.hypot(nx, ny, nz) || 1;
      this.nor[k * 3] = nx / l;
      this.nor[k * 3 + 1] = ny / l;
      this.nor[k * 3 + 2] = nz / l;
      paint(sa, out);
      this.col[k * 4] = out[0];
      this.col[k * 4 + 1] = out[1];
      this.col[k * 4 + 2] = out[2];
      this.col[k * 4 + 3] = out[3];
    }
  }

  flush(): void {
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.normal.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
  }
}

const tA = new V3();
const tB = new V3();
const tC = new V3();
const AXX = new V3();
const AXY = new V3();
const TAN = new V3();
const UP = new V3(0, 1, 0);

function crv(p: THREE.Vector3[], t: number, out: THREE.Vector3): THREE.Vector3 {
  const n = p.length - 1;
  const f = Math.min(n - 1e-5, Math.max(0, t * n));
  const i = Math.floor(f);
  const u = f - i;
  const a = p[Math.max(0, i - 1)];
  const b = p[i];
  const c = p[i + 1];
  const d = p[Math.min(n, i + 2)];
  const u2 = u * u;
  const u3 = u2 * u;
  const q = (k: 'x' | 'y' | 'z') => 0.5 * (2 * b[k] + (c[k] - a[k]) * u + (2 * a[k] - 5 * b[k] + 4 * c[k] - d[k]) * u2 + (3 * b[k] - a[k] - 3 * c[k] + d[k]) * u3);
  return out.set(q('x'), q('y'), q('z'));
}

export class Crane {
  readonly body: THREE.Mesh;
  readonly shadow: THREE.Mesh;
  readonly group = new THREE.Group();
  readonly shadowGroup = new THREE.Group();
  scale = 1;
  /** 0 rust-brown yearling .. 1 white */
  age = 1;
  private readonly soft = new SoftMesh(1700);
  private readonly pBody: number;
  private readonly pNeck: number;
  private readonly pHead: number;
  private readonly pBeak: number;
  private readonly pArm: number[];
  private readonly pLeg: number[];
  private readonly joints: THREE.Vector3[][] = [[], []];
  private time = Math.random() * 100;

  constructor(
    private readonly field: FeatherField,
    scene: THREE.Scene,
    shadowScene: THREE.Scene,
  ) {
    this.pBody = this.soft.part(15, 12);
    this.pNeck = this.soft.part(20, 10, true);
    this.pHead = this.soft.part(9, 12, true);
    this.pBeak = this.soft.part(6, 6, true);
    this.pArm = [this.soft.part(14, 7), this.soft.part(14, 7)];
    this.pLeg = [this.soft.part(12, 5, true), this.soft.part(12, 5, true)];
    this.soft.finish();
    this.body = new THREE.Mesh(this.soft.geo, worldMaterial(B_VERT, B_FRAG, {}, {}));
    this.body.frustumCulled = false;
    this.shadow = new THREE.Mesh(this.soft.geo, worldMaterial(B_VERT, DEPTH_FRAG, {}, { side: THREE.DoubleSide }));
    this.shadow.frustumCulled = false;
    this.group.add(this.body);
    this.shadowGroup.add(this.shadow);
    this.group.rotation.order = 'YXZ';
    this.shadowGroup.matrixAutoUpdate = false;
    scene.add(this.group);
    shadowScene.add(this.shadowGroup);
  }

  dispose(scene: THREE.Scene, shadowScene: THREE.Scene): void {
    scene.remove(this.group);
    shadowScene.remove(this.shadowGroup);
    this.soft.geo.dispose();
  }

  /**
   * Pose and place. `pitch` positive = nose up, `roll` positive = right wing
   * down, matching the sim.
   */
  update(pos: { x: number; y: number; z: number }, yaw: number, pitch: number, roll: number, p: Pose, dt: number): void {
    this.time += dt;
    const g = this.group;
    g.position.set(pos.x, pos.y, pos.z);
    const stand = p.legs * (1 - p.flare * 0.5);
    g.rotation.set(pitch + p.legs * 0.28 + p.flare * 0.42, yaw, -roll, 'YXZ');
    g.scale.setScalar(this.scale);
    // standing height: the body rides above its feet
    g.position.y += stand * 0.98 * this.scale;
    g.updateMatrixWorld(true);
    this.shadowGroup.matrix.copy(g.matrixWorld);
    this.shadowGroup.matrixWorldNeedsUpdate = true;

    this.poseBody(p);
    for (let side = 0; side < 2; side++) this.poseWing(side, p);
    this.poseTail(p);
    this.soft.flush();
  }

  private poseBody(p: Pose): void {
    const S = this.soft;
    const rust = 1 - this.age;
    const white: [number, number, number] = [lerp(0.86, 0.28, rust * 0.9), lerp(0.86, 0.12, rust * 0.9), lerp(0.85, 0.052, rust * 0.9)];
    const breath = Math.sin(this.time * 1.7) * 0.008;

    // trunk
    const prof: Array<[number, number, number, number]> = [
      [-0.6, 0.055, 0.1, 0.1], [-0.52, 0.035, 0.135, 0.14], [-0.43, 0.012, 0.17, 0.18], [-0.32, -0.004, 0.2, 0.212], [-0.2, -0.012, 0.218, 0.226],
      [-0.08, -0.014, 0.222, 0.228], [0.04, -0.012, 0.216, 0.218], [0.16, -0.004, 0.202, 0.2], [0.28, 0.006, 0.19, 0.184], [0.38, 0.02, 0.16, 0.15],
      [0.47, 0.03, 0.128, 0.115], [0.55, 0.036, 0.096, 0.082], [0.62, 0.038, 0.066, 0.054], [0.68, 0.038, 0.036, 0.03], [0.71, 0.038, 0.006, 0.006],
    ];
    AXX.set(1, 0, 0);
    AXY.set(0, 1, 0);
    prof.forEach(([z, y, rx, ry], i) => {
      const b = 1 + breath * 2;
      S.ring(this.pBody, i, tA.set(0, y, z), AXX, AXY, rx * b, ry * b, (sa, o) => {
        const k = 0.9 + 0.1 * sa;
        o[0] = white[0] * k;
        o[1] = white[1] * k;
        o[2] = white[2] * k;
        o[3] = 0;
      });
    });

    // neck: a spline from breast to head
    const n = p.neck * (1 - p.sleep);
    const yaw = p.neckYaw;
    const nod = p.neckPitch;
    const sway = Math.sin(this.time * 0.9) * 0.008;
    const pts = [
      new V3(0, lerp(0.06, 0.06, n), -0.46),
      new V3(lerp(0, yaw * 0.06, n), lerp(0.085, 0.16, n), lerp(-0.68, -0.64, n)),
      new V3(lerp(yaw * 0.08, yaw * 0.1, n), lerp(0.098, 0.5, n), lerp(-0.92, -0.62, n)),
      new V3(lerp(yaw * 0.2, yaw * 0.2, n) + sway, lerp(0.105, 0.84, n) + nod * 0.06, lerp(-1.16, -0.6, n)),
      new V3(lerp(yaw * 0.34, yaw * 0.3, n) + sway, lerp(0.12, 1.1, n) + nod * 0.16, lerp(-1.36, -0.7, n)),
    ];
    if (p.sleep > 0) {
      // asleep: neck curled back, bill along the back feathers
      const q = [new V3(0, 0.06, -0.46), new V3(0.03, 0.26, -0.6), new V3(0.08, 0.46, -0.46), new V3(0.12, 0.45, -0.24), new V3(0.12, 0.36, -0.04)];
      pts.forEach((v, i) => v.lerp(q[i], p.sleep));
    }
    const R = 20;
    for (let i = 0; i < R; i++) {
      const t = i / (R - 1);
      crv(pts, t, tA);
      crv(pts, Math.min(1, t + 0.02), tB);
      crv(pts, Math.max(0, t - 0.02), tC);
      TAN.subVectors(tB, tC).normalize();
      AXX.crossVectors(TAN, Math.abs(TAN.y) > 0.9 ? tC.set(0, 0, 1) : UP).normalize();
      AXY.crossVectors(AXX, TAN).normalize();
      const r = lerp(0.118, 0.05, Math.pow(clamp01(t * 1.25), 0.65)) + 0.012 * Math.max(0, t - 0.85);
      S.ring(this.pNeck, i, tA, AXX, AXY, r * 0.94, r, (sa, o) => {
        // grey-black throat shading up the neck, white nape
        const throat = clamp01((t - 0.12) * 1.5) * clamp01(0.75 - sa * 0.9) * (0.25 + 0.75 * this.age);
        const b = 1 - 0.965 * throat;
        const ru = rust * clamp01(0.3 + t);
        o[0] = lerp(0.86, 0.36, ru) * b;
        o[1] = lerp(0.86, 0.16, ru) * b;
        o[2] = lerp(0.85, 0.075, ru) * b;
        o[3] = 0;
      });
    }

    // head
    const hp = pts[4];
    const dir = new V3().subVectors(pts[4], pts[3]).normalize();
    const face = new V3(yaw * 0.5, lerp(-0.12, -0.16, n) + nod * 0.6, -1).normalize();
    dir.lerp(face, 0.82).normalize();
    if (p.sleep > 0) dir.lerp(tA.set(0.12, -0.25, 1).normalize(), p.sleep).normalize();
    AXX.crossVectors(dir, UP).normalize();
    AXY.crossVectors(AXX, dir).normalize();
    for (let i = 0; i < 9; i++) {
      const t = i / 8;
      const z = lerp(-0.075, 0.12, t);
      const s = Math.sqrt(Math.max(0.0, 1 - Math.pow((t - 0.42) / 0.62, 2)));
      tA.copy(hp).addScaledVector(dir, z).addScaledVector(AXY, 0.012);
      S.ring(this.pHead, i, tA, AXX, AXY, 0.052 * s + 0.004, 0.056 * s + 0.004, (sa, o) => {
        const crown = clamp01((sa - 0.42) * 4) * clamp01((t - 0.08) * 6) * clamp01((0.86 - t) * 8);
        const cheek = clamp01((t - 0.35) * 3) * clamp01(0.4 - sa);
        const red = this.age;
        const ru = rust;
        const ck = 1 - 0.95 * cheek * this.age;
        let cr = lerp(0.86, 0.36, ru) * ck;
        let cg = lerp(0.86, 0.15, ru) * ck;
        let cb = lerp(0.85, 0.07, ru) * ck;
        cr = lerp(cr, lerp(0.22, 0.62, red), crown);
        cg = lerp(cg, lerp(0.09, 0.02, red), crown);
        cb = lerp(cb, lerp(0.04, 0.015, red), crown);
        // eye
        const e = Math.max(0, 1 - Math.abs(t - 0.56) * 11) * Math.max(0, 1 - Math.abs(sa - 0.2) * 4.2);
        const k = 1 - 0.95 * clamp01(e * 2.2);
        o[0] = cr * k;
        o[1] = cg * k;
        o[2] = cb * k;
        o[3] = crown * red * 0.4;
      });
    }
    for (let i = 0; i < 6; i++) {
      const t = i / 5;
      tA.copy(hp).addScaledVector(dir, 0.1 + t * 0.29).addScaledVector(AXY, -0.002 - t * t * 0.012);
      const r = lerp(0.026, 0.004, t);
      S.ring(this.pBeak, i, tA, AXX, AXY, r * 0.8, r, (_s, o) => {
        o[0] = lerp(0.2, 0.12, t);
        o[1] = lerp(0.17, 0.1, t);
        o[2] = lerp(0.09, 0.06, t);
        o[3] = 0.25;
      });
    }

    // legs
    for (let s = 0; s < 2; s++) {
      const sx = s === 0 ? 1 : -1;
      const st = Math.sin(p.step + s * Math.PI) * p.stepAmp;
      const lift = Math.max(0, Math.cos(p.step + s * Math.PI)) * p.stepAmp;
      const raise = s === 1 ? p.oneLeg : 0;
      const pitchFix = -(p.legs * 0.28);
      const c = Math.cos(pitchFix);
      const si = Math.sin(pitchFix);
      const local = (y: number, z: number): [number, number] => [y * c - z * si, y * si + z * c];
      const hip = new V3(sx * 0.085, -0.13, 0.12);
      // standing targets, un-pitched
      const [ky, kz] = local(lerp(-0.6, -0.42, raise) + lift * 0.1, lerp(0.16, 0.02, raise) - st * 0.12);
      const [fy, fz] = local(lerp(-1.06, -0.56, raise) + lift * 0.2, lerp(0.06, 0.22, raise) - st * 0.34);
      const kneeA = new V3(sx * 0.07, -0.02, 0.62);
      const footA = new V3(sx * 0.05, 0.0, 1.2);
      const kneeB = new V3(sx * 0.08, ky, kz);
      const footB = new V3(sx * 0.085, fy, fz);
      const L = p.legs;
      const reach = p.flare * (1 - L);
      const knee = kneeA.lerp(kneeB, L).add(tA.set(0, -0.22 * reach, -0.2 * reach));
      const foot = footA.lerp(footB, L).add(tA.set(0, -0.62 * reach, -0.55 * reach));
      const toe = new V3(foot.x, foot.y - lerp(0.0, 0.015, L), foot.z + lerp(0.16, -0.2, L));
      const path = [hip, new V3().lerpVectors(hip, knee, 0.5), knee, new V3().lerpVectors(knee, foot, 0.5), foot, toe];
      for (let i = 0; i < 12; i++) {
        const t = i / 11;
        // straight bones: piecewise linear, not a curve
        const f = t * (path.length - 1);
        const k = Math.min(path.length - 2, Math.floor(f));
        tA.lerpVectors(path[k], path[k + 1], f - k);
        TAN.subVectors(path[k + 1], path[k]).normalize();
        AXX.crossVectors(TAN, Math.abs(TAN.y) > 0.9 ? tC.set(0, 0, 1) : UP).normalize();
        AXY.crossVectors(AXX, TAN).normalize();
        const thigh = clamp01(1 - t * 3.2);
        const r = 0.017 + 0.06 * thigh * thigh + (Math.abs(t - 0.42) < 0.06 ? 0.006 : 0) - 0.008 * clamp01((t - 0.8) * 5);
        const wide = t > 0.82 ? 1.9 : 1;
        S.ring(this.pLeg[s], i, tA, AXX, AXY, r * wide, r, (_sa, o) => {
          const w = thigh;
          o[0] = lerp(0.03, white[0], w);
          o[1] = lerp(0.028, white[1], w);
          o[2] = lerp(0.028, white[2], w);
          o[3] = 0.1;
        });
      }
    }
  }

  private emit(px: number, py: number, pz: number, dx: number, dy: number, dz: number, ux: number, uy: number, uz: number, len: number, wid: number, bend: number, tone: number, rust: number, notch: number, rnd: number): void {
    const f = this.field;
    if ((f.n + 1) * F_STRIDE > f.data.length) return;
    const m = this.group.matrixWorld.elements;
    const s = this.scale;
    const d = f.data;
    const o = f.n++ * F_STRIDE;
    d[o] = m[0] * px + m[4] * py + m[8] * pz + m[12];
    d[o + 1] = m[1] * px + m[5] * py + m[9] * pz + m[13];
    d[o + 2] = m[2] * px + m[6] * py + m[10] * pz + m[14];
    d[o + 3] = len * s;
    d[o + 4] = (m[0] * dx + m[4] * dy + m[8] * dz) / s;
    d[o + 5] = (m[1] * dx + m[5] * dy + m[9] * dz) / s;
    d[o + 6] = (m[2] * dx + m[6] * dy + m[10] * dz) / s;
    d[o + 7] = wid * s;
    d[o + 8] = (m[0] * ux + m[4] * uy + m[8] * uz) / s;
    d[o + 9] = (m[1] * ux + m[5] * uy + m[9] * uz) / s;
    d[o + 10] = (m[2] * ux + m[6] * uy + m[10] * uz) / s;
    d[o + 11] = bend;
    d[o + 12] = tone;
    d[o + 13] = rust * (1 - this.age);
    d[o + 14] = notch;
    d[o + 15] = rnd;
  }

  private poseWing(side: number, p: Pose): void {
    const sx = side === 0 ? 1 : -1;
    const fold = p.fold;
    const tuck = p.tuck * (1 - fold);
    const flap = Math.sin(p.flapPhase);
    const flapLag = Math.sin(p.flapPhase - 0.75);
    const flapLag2 = Math.sin(p.flapPhase - 1.35);
    // on the upstroke the wing half-folds, the way real wings do
    const up = Math.max(0, Math.cos(p.flapPhase)) * p.flapAmp;
    const turb = (Math.sin(this.time * 2.1 + side * 2) * 0.4 + Math.sin(this.time * 3.7 + side) * 0.25) * 0.012;
    const inner = p.bank * sx; // + on the inside wing of the turn
    const dS = (p.dihedral + 0.05 * p.load + turb + p.flapAmp * 0.5 * flap - inner * 0.03) * (1 - fold) + fold * -0.06 + p.flare * 0.12;
    const dE = dS + (0.015 + p.flapAmp * 0.3 * flapLag - 0.05 * tuck) * (1 - fold);
    const dW = dE + (0.06 * p.load + p.flapAmp * 0.38 * flapLag2 - 0.06 * tuck - 0.02) * (1 - fold);
    const aH = lerp(lerp(17, 34, tuck) + up * 10 - p.flare * 16, 80, fold) * D;
    const aF = lerp(lerp(-17, -34, tuck) - up * 14 - p.flare * 8, -84, fold) * D;
    const aW = lerp(lerp(13, 46, tuck) + up * 26 - inner * 5 - p.flare * 10, 87, fold) * D;
    const sh = new V3(sx * 0.15, 0.1, -0.2);
    const dirOf = (a: number, dih: number, out: THREE.Vector3) => out.set(sx * Math.cos(a) * Math.cos(dih), Math.cos(a) * Math.sin(dih), Math.sin(a));
    const bH = dirOf(aH, dS, new V3());
    const bF = dirOf(aF, dE, new V3());
    const bW = dirOf(aW, dW, new V3());
    // folded wings ride lower along the flank
    const elbow = new V3().copy(sh).addScaledVector(bH, LH * lerp(1, 0.78, fold));
    const wrist = new V3().copy(elbow).addScaledVector(bF, LF * lerp(1, 0.72, fold));
    const tip = new V3().copy(wrist).addScaledVector(bW, LW * lerp(1, 0.8, fold));
    if (fold > 0) {
      elbow.y -= 0.02 * fold;
      wrist.y -= 0.05 * fold;
      wrist.x = lerp(wrist.x, sx * 0.23, fold);
      elbow.x = lerp(elbow.x, sx * 0.24, fold);
      tip.x = lerp(tip.x, sx * 0.21, fold);
    }
    const J = [sh, elbow, wrist, tip];
    this.joints[side] = J;

    // the arm itself
    const armPts = [new V3(sx * 0.08, 0.08, -0.22), sh, new V3().lerpVectors(sh, elbow, 0.6).add(tA.set(0, 0, -0.05 * (1 - fold))), elbow.clone().add(tA.set(0, 0, -0.07 * (1 - fold))), new V3().lerpVectors(elbow, wrist, 0.55).add(tA.set(0, 0, -0.03 * (1 - fold))), wrist, tip];
    const rust = 1 - this.age;
    for (let i = 0; i < 14; i++) {
      const t = i / 13;
      crv(armPts, t, tA);
      crv(armPts, Math.min(1, t + 0.02), tB);
      crv(armPts, Math.max(0, t - 0.02), tC);
      TAN.subVectors(tB, tC).normalize();
      AXX.crossVectors(UP, TAN).normalize();
      AXY.crossVectors(TAN, AXX).normalize();
      const thick = lerp(0.085, 0.016, Math.pow(t, 0.7));
      const chord = lerp(0.14, 0.03, Math.pow(t, 0.8));
      this.soft.ring(this.pArm[side], i, tA, AXX, AXY, chord, thick, (_sa, o) => {
        o[0] = lerp(0.86, 0.36, rust * 0.8);
        o[1] = lerp(0.86, 0.17, rust * 0.8);
        o[2] = lerp(0.85, 0.085, rust * 0.8);
        o[3] = 0;
      });
    }

    const dihs = [dS, dE, dW];
    const fingers = p.load * 0.34 + p.flapAmp * -0.5 * Math.cos(p.flapPhase) * 0.6;
    for (let k = 0; k < SPECS.length; k++) {
      const s = SPECS[k];
      const a = J[s.seg];
      const b = J[s.seg + 1];
      const px = lerp(a.x, b.x, s.t);
      const py = lerp(a.y, b.y, s.t);
      const pz = lerp(a.z, b.z, s.t);
      // dihedral blends across joints so the surface stays continuous
      const d0 = s.seg === 0 ? dS : lerp(dihs[s.seg - 1], dihs[s.seg], 0.35 + 0.65 * Math.min(1, s.t * 1.6));
      const splay = s.seg === 2 ? (p.load * 0.1 + p.flare * 0.12) * (s.t - 0.3) : 0;
      const spreadAng = s.ang - splay - p.flare * 0.1 + tuck * (s.seg === 2 ? 0.62 * (0.4 + s.t) : 0.1);
      const ang = lerp(spreadAng, (s.seg === 0 ? 92 : s.seg === 1 ? 90 : 88.5) * D, fold);
      const ca = Math.cos(ang);
      const sa = Math.sin(ang);
      const cd = Math.cos(d0);
      const sd = Math.sin(d0);
      const dx = sx * ca * cd;
      let dy = ca * sd;
      const dz = sa;
      const ux = -sx * sd;
      const uy = cd;
      // trailing edge reflexes a touch; folded feathers droop into a bustle
      const droop = lerp(s.under ? 0 : -0.03 - 0.04 * p.flare, s.seg === 0 ? -0.34 : -0.16 - 0.06 * s.rnd, fold);
      dy += droop * sa;
      const dl = Math.hypot(dx, dy, dz);
      const u = s.up * (1 - fold * 0.2) + s.layer + 0.004;
      const bend = (s.seg === 2 && s.len > 0.5 ? fingers * (0.25 + s.t * 1.1) : 0.02) * (1 - fold) + (s.rnd - 0.5) * 0.03 + Math.sin(this.time * 9 + s.rnd * 40) * 0.006 * (1 - fold);
      const len = s.len * lerp(1, s.seg === 2 ? 0.74 : 0.82, fold) * (1 - 0.1 * tuck * (s.seg === 2 ? 1 : 0.3));
      let X = px + ux * u;
      let Y = py + uy * u;
      let Z = pz - s.fwd * (1 - fold);
      let DX = dx / dl;
      let DY = dy / dl;
      let DZ = dz / dl;
      let UX = ux;
      let UY = uy;
      if (fold > 0.01) {
        // folded, the wing is a shingled cloak down the flank
        const st = ((s.seg === 0 ? s.t * LH : s.seg === 1 ? LH + s.t * LF : LH + LF + s.t * LW) / (LH + LF + LW));
        const cov = s.len < 0.45 ? 1 : 0;
        const fy = lerp(0.19, -0.1, Math.pow(st, 0.8)) + (cov ? -0.015 : 0.0);
        const fz = cov ? lerp(-0.34, 0.08, st) - s.fwd * 2.1 + 0.16 : lerp(0.0, 0.3, st);
        const fx = sx * (0.235 * Math.sqrt(Math.max(0.05, 1 - (fy / 0.27) * (fy / 0.27))) + 0.012 + (cov ? 0.016 + s.up * 0.5 : 0) + s.layer * 0.4);
        const dY = -0.16 - 0.1 * (1 - st) - (cov ? 0 : 0.08 * s.rnd);
        const dl2 = Math.hypot(0.04, dY, 1);
        X = lerp(X, fx, fold);
        Y = lerp(Y, fy, fold);
        Z = lerp(Z, fz, fold);
        DX = lerp(DX, (-sx * 0.05) / dl2, fold);
        DY = lerp(DY, dY / dl2, fold);
        DZ = lerp(DZ, 1 / dl2, fold);
        UX = lerp(UX, sx * 0.92, fold);
        UY = lerp(UY, 0.38, fold);
        if (s.under && fold > 0.6) continue;
      }
      this.emit(X, Y, Z, DX, DY, DZ, UX, UY, 0, len, s.wid, s.under ? -bend * 0.5 : bend, s.tone, s.rust, s.notch, s.rnd + side);
    }
  }

  private poseTail(p: Pose): void {
    const n = 12;
    for (let i = 0; i < n; i++) {
      const k = i / (n - 1) - 0.5;
      const spread = lerp(0.24, 1.0, p.tailFan) * lerp(1, 0.5, p.fold);
      const a = k * spread;
      const dip = -0.02 - 0.22 * p.flare - 0.2 * p.legs;
      const dx = Math.sin(a);
      const dz = Math.cos(a);
      this.emit(k * 0.12, 0.05 - Math.abs(k) * 0.02, 0.5, dx, dip, dz, 0, 1, dip * -0.4, 0.5 - Math.abs(k) * 0.08, 0.078, 0.05, 0.15, 0.4, 0, i * 0.37);
    }
    // contour feathers: breast, flanks and belly, shingled front to back
    for (let r = 0; r < 6; r++) {
      const z = -0.5 + r * 0.17;
      const m = 7;
      for (let i = 0; i < m; i++) {
        const a = lerp(-0.2, Math.PI + 0.2, (i + (r & 1) * 0.5) / m) + Math.PI;
        const rr = r === 0 ? 0.13 : r === 1 ? 0.2 : r === 5 ? 0.14 : 0.225;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        this.emit(ca * rr, sa * rr * 1.04 + 0.0, z, ca * 0.08, sa * 0.08 + 0.05, 1, ca, sa, 0, 0.27, 0.085, -0.06, 0, 0.75, 0, i * 0.61 + r * 1.3);
      }
    }
    // back and rump feathers soften the join
    for (let r = 0; r < 4; r++) {
      const m = 7 - (r > 2 ? 2 : 0);
      for (let i = 0; i < m; i++) {
        const k = i / (m - 1) - 0.5;
        const z = 0.02 + r * 0.13;
        this.emit(k * 0.3, 0.195 - Math.abs(k) * 0.16 - r * 0.032, z, k * 0.35, -0.1 - r * 0.03, 1, k * 0.6, 1, 0, 0.26, 0.07, 0.03, 0.0, 0.8, 0, i * 0.7 + r);
      }
    }
  }
}

const F_VERT = /* glsl */ `
${FULL}
in vec4 iP; in vec4 iD; in vec4 iU; in vec4 iC;
out vec3 vW; out vec3 vN; out vec2 vQ; out vec4 vC;
float prof(float t, float notch){
  float w = smoothstep(0.0, 0.14, t) * 0.45 + 0.55;
  w *= sqrt(max(0.0, 1.0 - pow(max(t - 0.62, 0.0) / 0.385, 2.2)));
  float n = mix(1.0, 0.56, notch * smoothstep(0.36, 0.6, t));
  return w * n;
}
void main(){
  float x = position.x, t = position.y;
  vec3 dir = normalize(iD.xyz);
  vec3 side = normalize(cross(dir, iU.xyz));
  vec3 up = normalize(cross(side, dir));
  float w = prof(t, iC.z) * iD.w;
  float b = iU.w;
  vec3 p = iP.xyz + dir * iP.w * t + side * x * w;
  p += up * (b * t * t * iP.w + (1.0 - x * x) * iD.w * 0.18);
  vec3 n = normalize(up - dir * 2.0 * b * t + side * x * 0.4);
  vW = p; vN = n; vQ = vec2(x, t); vC = iC;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const F_FRAG = /* glsl */ `
${FULL}
in vec3 vW; in vec3 vN; in vec2 vQ; in vec4 vC;
layout(location = 0) out vec4 o;
void main(){
  vec3 V = normalize(uCamPos - vW);
  vec3 N = normalize(vN);
  if (dot(N, V) < 0.0) N = -N;
  float t = vQ.y, x = vQ.x;
  vec3 white = vec3(0.86, 0.858, 0.85);
  float barb = sin((t * 46.0 + abs(x) * 9.0 + vC.w * 30.0)) * 0.5 + 0.5;
  float shaft = exp(-x * x * 180.0);
  vec3 col = white * (0.94 + 0.06 * barb);
  float dk = vC.x * smoothstep(0.08, 0.55, t + vC.x * 0.18);
  col = mix(col, vec3(0.032, 0.032, 0.038), dk * 0.96);
  col = mix(col, vec3(0.26, 0.1, 0.038) * (0.7 + 0.6 * fract(vC.w * 7.3)), sat(vC.y * (0.75 + 0.6 * t)));
  col *= 1.0 - 0.10 * shaft;
  col *= mix(0.84, 1.0, smoothstep(0.0, 0.3, t));
  float edge = smoothstep(0.65, 1.0, abs(x));
  col *= 1.0 - 0.14 * edge;
  float sh = terrainShadow(vW) * cloudShadowAt(vW) * csmShadow(vW + N * 0.05, 0.0011);
  float nl = sat((dot(N, uKeyDir) + 0.28) / 1.28);
  vec3 c = col * (uKeyCol * nl * sh * 1.04 + ambient(N, 0.82));
  // sun through the vane
  float back = sat(-dot(N, uKeyDir)) ;
  float thru = pow(sat(dot(-V, uKeyDir) * 0.5 + 0.5), 4.0);
  vec3 tint = mix(col, vec3(0.98, 0.86, 0.7), 0.35 * (1.0 - dk));
  c += tint * uKeyCol * (back * 0.34 + thru * 0.5) * sh * (1.0 - 0.97 * dk) * smoothstep(0.1, 0.7, t);
  float rim = pow(1.0 - sat(dot(N, V)), 4.0);
  c += (uAmbSky * 0.3 + uKeyCol * 0.1 * sh) * rim * lum(col);
  o = vec4(c, 1.0);
}
`;

const B_VERT = /* glsl */ `
${FULL}
in vec4 color;
out vec3 vW; out vec3 vN; out vec4 vC; out vec3 vL;
void main(){
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz; vL = position;
  vN = normalize(mat3(modelMatrix) * normal);
  vC = color;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const B_FRAG = /* glsl */ `
${FULL}
in vec3 vW; in vec3 vN; in vec4 vC; in vec3 vL;
layout(location = 0) out vec4 o;
void main(){
  vec3 V = normalize(uCamPos - vW);
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  // soft downy breakup
  float f = nz(vec2(atan(vL.x, vL.y) * 0.6, vL.z * 1.4)).b;
  float f2 = nz(vL.xz * 2.3 + vL.y).b;
  vec3 col = vC.rgb * (0.86 + 0.22 * f) * (0.94 + 0.1 * f2);
  N = normalize(N + (f - 0.5) * 0.35 * vec3(0.3, 0.2, 1.0));
  float sh = terrainShadow(vW) * cloudShadowAt(vW) * csmShadow(vW + N * 0.05, 0.0011);
  float nl = sat((dot(N, uKeyDir) + 0.26) / 1.26);
  vec3 c = col * (uKeyCol * nl * sh * 1.04 + ambient(N, 0.82));
  float rim = pow(1.0 - sat(dot(N, V)), 3.0);
  float thru = pow(sat(dot(-V, uKeyDir) * 0.5 + 0.5), 5.0);
  c += (uAmbSky * 0.3 + uKeyCol * sh * (0.1 + 0.8 * thru)) * rim * lum(col);
  vec3 H = normalize(V + uKeyDir);
  c += uKeyCol * sh * pow(sat(dot(N, H)), 30.0) * vC.a * 0.5;
  o = vec4(c, 1.0);
}
`;

const DEPTH_FRAG = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 o;
void main(){ o = vec4(1.0); }
`;
