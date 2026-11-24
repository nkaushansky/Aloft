import * as THREE from 'three';
import { FULL } from './glsl/common';
import { VIEWRAY } from './glsl/passes';
import { G, Uniforms, worldMaterial } from './globals';
import type { PlacedLandmark } from '../world/generate';
import type { Movement } from '../game/days';
import { makeRng } from '../world/noise';
import { makeGreatTree } from './trees';
import type { TerrainProvider } from '../sim/terrain';

type RGB = [number, number, number];

/** Accumulates painted, slightly irregular solids. */
class Solid {
  pos: number[] = [];
  nor: number[] = [];
  col: number[] = [];
  idx: number[] = [];
  constructor(private rng: () => number) {}

  private face(p: number[][], c: RGB, glow = 0): void {
    const k = this.pos.length / 3;
    const ux = p[1][0] - p[0][0];
    const uy = p[1][1] - p[0][1];
    const uz = p[1][2] - p[0][2];
    const vx = p[2][0] - p[0][0];
    const vy = p[2][1] - p[0][1];
    const vz = p[2][2] - p[0][2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const t = 0.9 + this.rng() * 0.2;
    for (const q of p) {
      this.pos.push(q[0], q[1], q[2]);
      this.nor.push(nx, ny, nz);
      this.col.push(c[0] * t, c[1] * t, c[2] * t, glow);
    }
    for (let i = 1; i < p.length - 1; i++) this.idx.push(k, k + i, k + i + 1);
  }

  box(x: number, y: number, z: number, w: number, h: number, d: number, c: RGB, o: { yaw?: number; taper?: number; tilt?: number; jit?: number; glow?: number } = {}): void {
    const ca = Math.cos(o.yaw ?? 0);
    const sa = Math.sin(o.yaw ?? 0);
    const tp = 1 - (o.taper ?? 0);
    const j = o.jit ?? 0;
    const v: number[][] = [];
    for (const [sx, sy, sz] of [[-1, 0, -1], [1, 0, -1], [1, 0, 1], [-1, 0, 1], [-1, 1, -1], [1, 1, -1], [1, 1, 1], [-1, 1, 1]]) {
      const s = sy ? tp : 1;
      const lx = (sx * w * s) / 2 + (this.rng() - 0.5) * j + sy * (o.tilt ?? 0);
      const lz = (sz * d * s) / 2 + (this.rng() - 0.5) * j;
      v.push([x + lx * ca - lz * sa, y + sy * h + (this.rng() - 0.5) * j, z + lx * sa + lz * ca]);
    }
    const g = o.glow ?? 0;
    this.face([v[0], v[4], v[5], v[1]], c, g);
    this.face([v[1], v[5], v[6], v[2]], c, g);
    this.face([v[2], v[6], v[7], v[3]], c, g);
    this.face([v[3], v[7], v[4], v[0]], c, g);
    this.face([v[4], v[7], v[6], v[5]], c, g);
  }

  cyl(x: number, y: number, z: number, r0: number, r1: number, h: number, sides: number, c: RGB, o: { glow?: number; jit?: number; cap?: boolean; a0?: number; a1?: number; lean?: number } = {}): void {
    const j = o.jit ?? 0;
    const A0 = o.a0 ?? 0;
    const A1 = o.a1 ?? Math.PI * 2;
    const ring = (r: number, yy: number, lx: number) => {
      const out: number[][] = [];
      for (let s = 0; s <= sides; s++) {
        const a = A0 + ((A1 - A0) * s) / sides;
        out.push([x + lx + Math.cos(a) * r + (this.rng() - 0.5) * j, yy, z + Math.sin(a) * r + (this.rng() - 0.5) * j]);
      }
      return out;
    };
    const a = ring(r0, y, 0);
    const b = ring(r1, y + h, o.lean ?? 0);
    if (!j || A1 - A0 > 6.2) {
      a[sides] = a[0];
      b[sides] = b[0];
    }
    for (let s = 0; s < sides; s++) this.face([a[s], b[s], b[s + 1], a[s + 1]], c, o.glow ?? 0);
    if (o.cap !== false && r1 > 0.01) this.face([...b.slice(0, sides)].reverse(), c, o.glow ?? 0);
  }

  rock(x: number, y: number, z: number, rx: number, ry: number, rz: number, c: RGB, yaw = 0): void {
    const R = 5;
    const S = 8;
    const ca = Math.cos(yaw);
    const sa = Math.sin(yaw);
    const v: number[][][] = [];
    for (let i = 0; i <= R; i++) {
      const t = (i / R) * Math.PI;
      const row: number[][] = [];
      for (let s = 0; s < S; s++) {
        const a = (s / S) * Math.PI * 2;
        const k = 0.84 + this.rng() * 0.3;
        const lx = Math.sin(t) * Math.cos(a) * rx * k;
        const lz = Math.sin(t) * Math.sin(a) * rz * k;
        row.push([x + lx * ca - lz * sa, y - Math.cos(t) * ry * k, z + lx * sa + lz * ca]);
      }
      v.push(row);
    }
    for (let i = 0; i < R; i++) for (let s = 0; s < S; s++) this.face([v[i][s], v[i + 1][s], v[i + 1][(s + 1) % S], v[i][(s + 1) % S]], c);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 4));
    g.setIndex(this.idx);
    return g;
  }
}

const STONE: RGB = [0.3, 0.28, 0.25];
const PALE: RGB = [0.52, 0.49, 0.43];
const DARK: RGB = [0.1, 0.1, 0.11];
const WOOD: RGB = [0.16, 0.11, 0.075];
const SLATE: RGB = [0.11, 0.13, 0.16];
const THATCH: RGB = [0.34, 0.26, 0.14];
const BRONZE: RGB = [0.2, 0.15, 0.06];
const LAMP: RGB = [1.0, 0.72, 0.36];

export interface LandmarkInstance {
  def: PlacedLandmark;
  /** where a bird might stand, and how high the thing is */
  top: number;
  group: THREE.Group;
}

export class Landmarks {
  readonly list: LandmarkInstance[] = [];
  private readonly root = new THREE.Group();
  private readonly shadowRoot = new THREE.Group();
  private readonly fxRoot = new THREE.Group();
  private bell: THREE.Object3D | null = null;
  private whale: THREE.Mesh | null = null;
  private whaleHome = new THREE.Vector3();
  private beam: THREE.Mesh | null = null;
  whaleUp = 0;
  bellSwing = 0;
  private blowT = 0;
  onBlow: ((x: number, y: number, z: number) => void) | null = null;

  constructor(
    scene: THREE.Scene,
    shadow: THREE.Scene,
    fx: THREE.Scene,
    private readonly view: Uniforms,
  ) {
    scene.add(this.root);
    shadow.add(this.shadowRoot);
    fx.add(this.fxRoot);
  }

  clear(): void {
    for (const r of [this.root, this.shadowRoot, this.fxRoot]) {
      r.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        if (m.material) (m.material as THREE.Material).dispose();
      });
      r.clear();
    }
    this.list.length = 0;
    this.bell = null;
    this.whale = null;
    this.beam = null;
  }

  load(defs: PlacedLandmark[], mv: Movement, terrain: TerrainProvider, atlas: THREE.Texture): void {
    this.clear();
    for (const d of defs) {
      const g = new THREE.Group();
      g.position.set(d.x, d.y, d.z);
      g.rotation.y = d.yaw;
      this.root.add(g);
      const rng = makeRng(Math.floor(d.x * 13 + d.z * 7) >>> 0);
      let top = 10;
      const solid = (s: Solid) => {
        const geo = s.build();
        g.add(new THREE.Mesh(geo, worldMaterial(S_VERT, S_FRAG, { uTint: { value: new THREE.Color(1, 1, 1) } }, {})));
        const sh = new THREE.Mesh(geo, worldMaterial(S_VERT, D_FRAG, {}, { side: THREE.DoubleSide }));
        sh.position.copy(g.position);
        sh.rotation.copy(g.rotation);
        this.shadowRoot.add(sh);
      };
      switch (d.kind) {
        case 'steeple': {
          const s = new Solid(rng);
          const base = -d.y; // water is at world 0
          void base;
          // tower
          for (let i = 0; i < 7; i++) {
            const w = 9.4 - i * 0.16;
            s.box(0, -2 + i * 4, 0, w, 4.02, w, STONE, { jit: 0.16 });
          }
          s.box(0, 25.6, 0, 10.2, 0.9, 10.2, PALE, { jit: 0.1 });
          // openings
          for (const [a, b] of [[0, 1], [0, -1], [1, 0], [-1, 0]]) {
            s.box(a * 4.2, 19, b * 4.2, a ? 0.7 : 2.3, 4.4, b ? 0.7 : 2.3, DARK);
            s.box(a * 4.45, 8, b * 4.45, a ? 0.5 : 1.0, 3, b ? 0.5 : 1.0, DARK);
          }
          for (const [a, b] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) s.cyl(a * 4.6, 26.4, b * 4.6, 0.7, 0.02, 4.2, 5, SLATE, { cap: false });
          s.cyl(0, 26.4, 0, 5.6, 0.1, 19, 8, SLATE, { jit: 0.25, lean: 0.9 });
          s.cyl(0.9, 45.2, 0, 0.1, 0.07, 2.6, 5, BRONZE);
          s.box(0.9, 46.6, 0, 2.2, 0.16, 0.1, BRONZE, { yaw: 0.4 });
          // drowned nave: a roof ridge just breaking the surface
          for (let i = 0; i < 6; i++) {
            if (i === 3) continue;
            const z = 7.5 + i * 4.2;
            const h = 3.6 + Math.sin(i * 2.1) * 0.8;
            s.box(-3.1, 0.4, z, 0.6, h, 4, SLATE, { tilt: 2.4, jit: 0.2 });
            s.box(3.1, 0.4, z, 0.6, h, 4, SLATE, { tilt: -2.4, jit: 0.2 });
          }
          solid(s);
          top = 46;
          break;
        }
        case 'stilt': {
          const s = new Solid(rng);
          const lamps = d.id === 'stilt';
          const deck = 5.2;
          const huts = lamps ? 5 : 2;
          for (let h = 0; h < huts; h++) {
            const a = (h / huts) * 6.28 + 0.4;
            const R = lamps ? 26 + (h % 2) * 9 : 12 * h;
            const x = Math.cos(a) * R;
            const z = Math.sin(a) * R;
            for (const [i, j] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, -1], [0, 1]]) s.cyl(x + i * 3.4, -2, z + j * 2.8, 0.2, 0.17, deck + 2, 5, WOOD, { lean: (rng() - 0.5) * 0.4 });
            s.box(x, deck - 0.2, z, 8.6, 0.35, 7, WOOD, { jit: 0.12 });
            s.box(x, deck, z, 5.4, 3, 4.4, [0.22, 0.16, 0.11], { jit: 0.12 });
            s.box(x - 1.7, deck + 2.8, z, 0.5, 3.3, 6.6, THATCH, { tilt: 1.7, jit: 0.2 });
            s.box(x + 1.7, deck + 2.8, z, 0.5, 3.3, 6.6, THATCH, { tilt: -1.7, jit: 0.2 });
            s.box(x, deck + 0.9, z + 2.22, 1.1, 1.2, 0.06, LAMP, { glow: lamps ? 2.4 : 0.9 });
            s.box(x + 2.72, deck + 1.0, z, 0.06, 1.0, 1.0, LAMP, { glow: lamps ? 2.4 : 0.9 });
            if (lamps) {
              s.cyl(x + 4.4, deck + 0.3, z + 3.6, 0.1, 0.1, 3, 5, WOOD);
              s.box(x + 4.4, deck + 2.5, z + 3.2, 0.5, 0.7, 0.5, LAMP, { glow: 4 });
            }
          }
          // the posts herons keep
          for (let i = 0; i < 26; i++) {
            const a = rng() * 6.28;
            const R = 10 + rng() * 46;
            s.cyl(Math.cos(a) * R, -2.5, Math.sin(a) * R, 0.2, 0.15, 4.2 + rng() * 2.6, 5, WOOD, { lean: (rng() - 0.5) * 0.7 });
          }
          // a causeway of planks
          for (let i = 0; i < 16; i++) {
            const x = -34 + i * 3;
            s.box(x, 2.1 + Math.sin(i * 0.7) * 0.15, Math.sin(i * 0.35) * 3 - 3, 3.0, 0.2, 1.4, WOOD, { jit: 0.15 });
            if (i % 2) s.cyl(x, -2, Math.sin(i * 0.35) * 3 - 3.6, 0.15, 0.13, 4.2, 5, WOOD);
          }
          solid(s);
          top = 9;
          break;
        }
        case 'oldtree': {
          const form = mv.id === 'stillmere' ? 'oldbirch' : mv.id === 'wintering' ? 'oldacacia' : 'old';
          const size = form === 'old' ? 38 : form === 'oldbirch' ? 34 : 26;
          const t = makeGreatTree(form, mv.trees[0], size, atlas);
          (t.mesh.userData.place as (x: number, y: number, z: number) => void)(d.x, d.y - 0.4, d.z);
          this.root.add(t.mesh);
          this.shadowRoot.add(t.shadow);
          top = size * 0.8;
          break;
        }
        case 'viaduct': {
          const s = new Solid(rng);
          const n = 9;
          const span = 34;
          const deckY = 52 - d.y;
          for (let i = 0; i <= n; i++) {
            const x = (i - n / 2) * span;
            // piers go down to whatever is there
            const wx = d.x + Math.cos(d.yaw) * x;
            const wz = d.z - Math.sin(d.yaw) * x;
            const foot = Math.min(deckY - 20, terrain.heightAt(wx, wz) - d.y - 3);
            const H = deckY - 12 - foot;
            for (let k = 0; k < 6; k++) {
              const f = k / 6;
              s.box(x, foot + H * f, 0, 7.6 - f * 1.6, H / 6 + 0.02, 10 - f * 2, STONE, { jit: 0.18 });
            }
            s.box(x, deckY - 12.4, 0, 7.2, 1, 9.2, PALE, { jit: 0.1 });
          }
          for (let i = 0; i < n; i++) {
            if (i === 6) {
              // one arch has fallen; its ribs reach out and stop
              continue;
            }
            const cx = (i - n / 2 + 0.5) * span;
            const r = span / 2 - 3;
            const seg = 14;
            for (let k = 0; k < seg; k++) {
              const a0 = (k / seg) * Math.PI;
              const a1 = ((k + 1) / seg) * Math.PI;
              const x0 = cx - Math.cos(a0) * r;
              const x1 = cx - Math.cos(a1) * r;
              const y0 = deckY - 12 + Math.sin(a0) * 10.5;
              const y1 = deckY - 12 + Math.sin(a1) * 10.5;
              const w = Math.abs(x1 - x0) + 0.4;
              s.box((x0 + x1) / 2, Math.min(y0, y1) - 0.2, 0, w, deckY - Math.min(y0, y1) + 0.2, 7.4, k % 2 ? STONE : PALE, { jit: 0.06 });
            }
            s.box(cx, deckY, 3.5, span + 0.2, 1.5, 0.6, STONE, { jit: 0.1 });
            s.box(cx, deckY, -3.5, span + 0.2, 1.5, 0.6, STONE, { jit: 0.1 });
          }
          solid(s);
          top = deckY;
          break;
        }
        case 'waterfall': {
          // The Roofless Tower
          const s = new Solid(rng);
          for (let i = 0; i < 7; i++) {
            const gap = i > 3 ? 1.1 + (i - 3) * 0.5 : 0;
            s.cyl(0, -2 + i * 3.6, 0, 7.4 - i * 0.2, 7.2 - i * 0.2, 3.62, 16, STONE, { jit: 0.3, a0: gap, a1: 6.283 - gap * 0.4, cap: false });
            s.cyl(0, -2 + i * 3.6, 0, 6.2 - i * 0.2, 6.0 - i * 0.2, 3.62, 14, DARK, { a0: gap, a1: 6.283 - gap * 0.4, cap: false });
          }
          for (let i = 0; i < 16; i++) {
            const a = rng() * 6.28;
            s.rock(Math.cos(a) * (9 + rng() * 9), -0.4, Math.sin(a) * (9 + rng() * 9), 0.6 + rng(), 0.5 + rng() * 0.6, 0.6 + rng(), STONE, rng() * 6);
          }
          solid(s);
          const t = makeGreatTree('oldbirch', mv.trees[1], 24, atlas);
          (t.mesh.userData.place as (x: number, y: number, z: number) => void)(d.x, d.y, d.z);
          this.root.add(t.mesh);
          this.shadowRoot.add(t.shadow);
          top = 22;
          break;
        }
        case 'stones': {
          const s = new Solid(rng);
          const n = 9;
          const red = mv.id === 'rooms';
          const c: RGB = red ? [0.36, 0.15, 0.09] : STONE;
          const tops: THREE.Vector3[] = [];
          for (let i = 0; i < n; i++) {
            const a = (i / n) * 6.283;
            const R = 19 + (rng() - 0.5) * 2;
            const h = 8 + rng() * 6;
            s.box(Math.cos(a) * R, -1, Math.sin(a) * R, 3 + rng() * 1.4, h, 1.6 + rng(), c, { yaw: -a + Math.PI / 2 + (rng() - 0.5) * 0.3, taper: 0.28 + rng() * 0.2, tilt: (rng() - 0.5) * 1.2, jit: 0.5 });
            tops.push(new THREE.Vector3(Math.cos(a) * R, h - 2, Math.sin(a) * R));
          }
          s.box(0, -0.6, 0, 5, 1.6, 2.6, c, { yaw: 0.6, jit: 0.4 });
          solid(s);
          if (!red) {
            for (let i = 0; i < n; i++) g.add(makeCloth(tops[i], tops[(i + 2) % n], i));
          }
          top = 12;
          break;
        }
        case 'bell': {
          const s = new Solid(rng);
          const c: RGB = [0.22, 0.09, 0.06];
          for (const x of [-4.4, 4.4]) {
            s.cyl(x, -1, 0, 0.75, 0.6, 13, 8, c, { lean: -x * 0.06 });
            s.box(x, -1.4, 0, 2.2, 1.6, 2.2, STONE, { jit: 0.1 });
          }
          s.box(0, 11.8, 0, 14, 0.9, 1.3, c);
          s.box(0, 13.1, 0, 17, 0.7, 2.2, SLATE, { jit: 0.1 });
          s.box(0, 9.6, 0, 9.6, 0.55, 0.8, c);
          for (let i = 0; i < 9; i++) s.rock((rng() - 0.5) * 16, -0.6, 4 + rng() * 5, 0.7 + rng() * 0.8, 0.5 + rng() * 0.5, 0.7 + rng(), STONE, rng() * 6);
          solid(s);
          const b = new Solid(rng);
          b.cyl(0, -3.0, 0, 1.75, 1.55, 0.4, 16, BRONZE, { cap: false });
          b.cyl(0, -2.6, 0, 1.55, 1.3, 1.5, 16, BRONZE, { cap: false });
          b.cyl(0, -1.1, 0, 1.3, 0.5, 0.8, 16, BRONZE);
          b.cyl(0, -0.3, 0, 0.12, 0.12, 0.6, 6, DARK);
          b.cyl(0, -3.4, 0, 0.22, 0.22, 2.6, 6, DARK);
          const bg = new THREE.Group();
          bg.position.set(0, 9.6, 0);
          bg.add(new THREE.Mesh(b.build(), worldMaterial(S_VERT, S_FRAG, { uTint: { value: new THREE.Color(1, 1, 1) } }, { side: THREE.DoubleSide })));
          g.add(bg);
          this.bell = bg;
          g.add(makeCloth(new THREE.Vector3(-8, 13, 0), new THREE.Vector3(-20, 1, 6), 1), makeCloth(new THREE.Vector3(8, 13, 0), new THREE.Vector3(21, 0, -5), 2));
          top = 13;
          break;
        }
        case 'arch': {
          // a window of stone standing over the river
          const R = 66;
          const H = 96;
          const seg = 44;
          const sides = 14;
          const pos: number[] = [];
          const nor: number[] = [];
          const col: number[] = [];
          const idx: number[] = [];
          for (let i = 0; i <= seg; i++) {
            const t = i / seg;
            const a = Math.PI * (1.06 - 1.12 * t);
            const cx = Math.cos(a) * R;
            const cy = Math.sin(a) * H - 8;
            const tx = -Math.sin(a) * R;
            const ty = Math.cos(a) * H;
            const tl = Math.hypot(tx, ty);
            const nx = ty / tl;
            const ny = -tx / tl;
            const foot = Math.pow(Math.abs(t - 0.5) * 2, 3);
            for (let s = 0; s <= sides; s++) {
              const b = (s / sides) * Math.PI * 2;
              const w = 11 + foot * 21 + Math.sin(i * 1.3 + s * 2.1) * 1.4 + Math.sin(i * 3.1 + (s % sides) * 1.7) * 0.9;
              const d2 = 15 + foot * 17 + Math.sin(i * 0.9 + (s % sides) * 1.1) * 2;
              const ox = Math.cos(b) * w;
              const oz = Math.sin(b) * d2;
              pos.push(cx + nx * ox, cy + ny * ox, oz);
              const ll = Math.hypot(Math.cos(b), Math.sin(b));
              nor.push((nx * Math.cos(b)) / ll, (ny * Math.cos(b)) / ll, Math.sin(b) / ll);
              col.push(0.4, 0.16, 0.085, 0);
            }
          }
          for (let i = 0; i < seg; i++)
            for (let s = 0; s < sides; s++) {
              const a = i * (sides + 1) + s;
              idx.push(a, a + 1, a + sides + 1, a + 1, a + sides + 2, a + sides + 1);
            }
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
          geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
          geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
          geo.setIndex(idx);
          g.position.y = Math.max(-2, Math.min(4, d.y));
          g.add(new THREE.Mesh(geo, worldMaterial(S_VERT, '#define STRATA\n' + S_FRAG, { uTint: { value: new THREE.Color(1, 1, 1) } }, { side: THREE.DoubleSide })));
          const sh = new THREE.Mesh(geo, worldMaterial(S_VERT, D_FRAG, {}, { side: THREE.DoubleSide }));
          sh.position.copy(g.position);
          sh.rotation.copy(g.rotation);
          this.shadowRoot.add(sh);
          top = 80;
          break;
        }
        case 'lighthouse': {
          const s = new Solid(rng);
          const c: RGB = [0.62, 0.6, 0.56];
          for (let i = 0; i < 9; i++) s.cyl(0, -2 + i * 3.6, 0, 4.4 - i * 0.24, 4.16 - i * 0.24, 3.62, 16, i % 3 === 1 ? [0.34, 0.1, 0.07] : c, { cap: false });
          s.cyl(0, 30.4, 0, 3.3, 3.3, 0.6, 16, SLATE);
          s.cyl(0, 31, 0, 1.9, 1.9, 3, 12, LAMP, { glow: 7 });
          s.cyl(0, 34, 0, 2.5, 0.2, 2.2, 12, SLATE);
          for (let i = 0; i < 10; i++) {
            const a = (i / 10) * 6.283;
            s.cyl(Math.cos(a) * 3.1, 31, Math.sin(a) * 3.1, 0.07, 0.07, 1.1, 4, DARK);
          }
          s.box(9, -1, 3, 9, 4.4, 6.4, c, { jit: 0.1 });
          s.box(9, 3.3, 1.2, 9.6, 3, 0.4, SLATE, { tilt: 0 });
          s.box(9, 3.3, 3, 9.8, 2.4, 6.8, SLATE, { taper: 0.4 });
          s.box(9, 0.6, 6.24, 1, 1.3, 0.06, LAMP, { glow: 3 });
          s.box(6.6, 0.6, 6.24, 0.9, 1.1, 0.06, LAMP, { glow: 3 });
          solid(s);
          const bm = new THREE.Mesh(beamGeo(), worldMaterial(BEAM_V, BEAM_F, { ...this.view }, { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
          bm.position.set(d.x, d.y + 32.5, d.z);
          bm.frustumCulled = false;
          this.fxRoot.add(bm);
          this.beam = bm;
          top = 35;
          break;
        }
        case 'whale': {
          const geo = whaleGeo();
          const m = new THREE.Mesh(geo, worldMaterial(S_VERT, '#define WET\n' + S_FRAG, { uTint: { value: new THREE.Color(1, 1, 1) } }, {}));
          m.rotation.order = 'YXZ';
          this.root.add(m);
          this.whale = m;
          this.whaleHome.set(d.x, 0, d.z);
          top = 2;
          break;
        }
        case 'cairn': {
          const s = new Solid(rng);
          const red = mv.id === 'rooms';
          const c: RGB = red ? [0.34, 0.15, 0.09] : STONE;
          for (let i = 0; i < 46; i++) {
            const f = i / 46;
            const R = 3.4 * (1 - f) + 0.15;
            const a = i * 2.4;
            const k = R * (0.55 + 0.4 * rng());
            s.rock(Math.cos(a) * k, f * 6.2, Math.sin(a) * k, 0.95 - f * 0.45, 0.5 - f * 0.16, 0.8 - f * 0.35, c, rng() * 6);
          }
          s.cyl(0, 5.4, 0, 0.11, 0.08, 6.5, 5, WOOD, { lean: 0.5 });
          solid(s);
          g.add(makeCloth(new THREE.Vector3(0.5, 11.8, 0), new THREE.Vector3(5.2, 11, 0), 3, true));
          top = 8;
          break;
        }
      }
      this.list.push({ def: d, top, group: g });
    }
  }

  update(dt: number): void {
    const t = G.uTime.value;
    if (this.bell) {
      this.bellSwing *= Math.exp(-dt * 0.35);
      this.bell.rotation.z = Math.sin(t * 2.2) * (0.02 + this.bellSwing * 0.35);
    }
    if (this.beam) {
      this.beam.rotation.y = t * 0.42;
      this.beam.visible = G.uStars.value > 0.08;
    }
    if (this.whale) {
      const w = this.whale;
      const a = t * 0.045;
      const R = 90;
      const x = this.whaleHome.x + Math.cos(a) * R;
      const z = this.whaleHome.z + Math.sin(a) * R;
      const cyc = (t * 0.07) % 1;
      const rise = Math.sin(Math.PI * Math.min(1, Math.max(0, (cyc - 0.2) / 0.42)));
      this.whaleUp = rise;
      w.position.set(x, -6.4 + rise * 6.1, z);
      w.rotation.set(Math.cos(Math.PI * Math.min(1, Math.max(0, (cyc - 0.2) / 0.42))) * 0.2 * (rise > 0 ? 1 : 0), Math.atan2(Math.sin(a), -Math.cos(a)), 0, 'YXZ');
      if (rise > 0.55 && rise < 0.95 && cyc < 0.45) {
        this.blowT += dt;
        if (this.blowT > 0.03) {
          this.blowT = 0;
          const f = -5.2;
          this.onBlow?.(x - Math.sin(w.rotation.y) * -f * -1, w.position.y + 3.2, z - Math.cos(w.rotation.y) * -f * -1);
        }
      }
    }
  }

  whalePos(): THREE.Vector3 | null {
    return this.whale ? this.whale.position : null;
  }
}

function whaleGeo(): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const R = 22;
  const S = 14;
  for (let i = 0; i <= R; i++) {
    const t = i / R;
    const z = -11 + t * 24;
    const prof = Math.pow(Math.sin(Math.PI * Math.min(1, Math.pow(t, 0.62) * 0.99 + 0.005)), 0.8);
    const rx = 2.7 * prof + 0.1;
    const ry = 2.3 * prof + 0.1;
    const cy = -0.9 * Math.pow(t, 2) * 0 + Math.sin(t * 2.6) * 0.5;
    for (let s = 0; s <= S; s++) {
      const a = (s / S) * Math.PI * 2;
      pos.push(Math.cos(a) * rx, cy + Math.sin(a) * ry + (t > 0.62 && t < 0.72 && Math.abs(Math.cos(a)) < 0.3 && Math.sin(a) > 0 ? 0.7 : 0), z);
      nor.push(Math.cos(a), Math.sin(a), 0);
      const belly = Math.sin(a) < -0.35 ? 0.24 : 0.045;
      col.push(belly, belly * 1.05, belly * 1.15, 0);
    }
  }
  for (let i = 0; i < R; i++)
    for (let s = 0; s < S; s++) {
      const a = i * (S + 1) + s;
      idx.push(a, a + 1, a + S + 1, a + 1, a + S + 2, a + S + 1);
    }
  // flukes
  const fk = pos.length / 3;
  const fl = [[0, 0.4, 12], [4.2, 0.7, 15.6], [1.2, 0.5, 15], [0, 0.5, 14.4], [-1.2, 0.5, 15], [-4.2, 0.7, 15.6]];
  for (const p of fl) {
    pos.push(...p);
    nor.push(0, 1, 0);
    col.push(0.05, 0.055, 0.06, 0);
  }
  idx.push(fk, fk + 2, fk + 1, fk, fk + 3, fk + 2, fk, fk + 4, fk + 3, fk, fk + 5, fk + 4);
  idx.push(fk, fk + 1, fk + 2, fk, fk + 2, fk + 3, fk, fk + 3, fk + 4, fk, fk + 4, fk + 5);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  return g;
}

function beamGeo(): THREE.BufferGeometry {
  const L = 900;
  const g = new THREE.CylinderGeometry(46, 1.6, L, 24, 1, true);
  g.rotateZ(Math.PI / 2);
  g.translate(-L / 2, 0, 0);
  const h = g.clone();
  h.rotateY(Math.PI);
  const pos = new Float32Array(g.attributes.position.count * 6);
  pos.set(g.attributes.position.array as Float32Array, 0);
  pos.set(h.attributes.position.array as Float32Array, g.attributes.position.count * 3);
  const gi = Array.from(g.index!.array as Uint16Array);
  const off = g.attributes.position.count;
  const o = new THREE.BufferGeometry();
  o.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  o.setIndex([...gi, ...gi.map((i) => i + off)]);
  return o;
}

/** A string of small cloths, or a single pennant, that always tells the wind. */
function makeCloth(a: THREE.Vector3, b: THREE.Vector3, seed: number, pennant = false): THREE.Mesh {
  const pos: number[] = [];
  const q: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const cols: RGB[] = [[0.5, 0.1, 0.06], [0.72, 0.5, 0.14], [0.75, 0.72, 0.64], [0.1, 0.26, 0.36], [0.16, 0.32, 0.16]];
  const n = pennant ? 1 : 12;
  for (let i = 0; i < n; i++) {
    const t = (i + 0.5) / n;
    const p = new THREE.Vector3().lerpVectors(a, b, t);
    p.y -= pennant ? 0 : Math.sin(Math.PI * t) * 2.2;
    const c = cols[(i + seed) % cols.length];
    const W = pennant ? 4.6 : 0.9;
    const H = pennant ? 1.0 : 1.2;
    const k0 = pos.length / 3;
    const seg = 6;
    for (let s = 0; s <= seg; s++)
      for (let v = 0; v <= 1; v++) {
        pos.push(p.x, p.y - v * H * (pennant ? 1 - (s / seg) * 0.8 : 1), p.z);
        q.push((s / seg) * W, v, seed * 3 + i, 0);
        col.push(c[0], c[1], c[2], 0);
      }
    for (let s = 0; s < seg; s++) {
      const k = k0 + s * 2;
      idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aQ', new THREE.Float32BufferAttribute(q, 4));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, worldMaterial(C_VERT, C_FRAG, {}, { side: THREE.DoubleSide }));
  m.frustumCulled = false;
  return m;
}

const S_VERT = /* glsl */ `
${FULL}
in vec4 color;
out vec3 vW; out vec3 vN; out vec4 vC;
void main(){
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vC = color;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const D_FRAG = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 o;
void main(){ o = vec4(1.0); }
`;
const S_FRAG = /* glsl */ `
${FULL}
in vec3 vW; in vec3 vN; in vec4 vC;
uniform vec3 uTint;
layout(location = 0) out vec4 o;
void main(){
  vec3 V = normalize(uCamPos - vW);
  vec3 N = normalize(vN);
  if (!gl_FrontFacing) N = -N;
  vec3 tw = pow(abs(N), vec3(4.0)); tw /= tw.x + tw.y + tw.z;
  vec4 a = nz(vW.zy / 13.0) * tw.x + nz(vW.xz / 13.0) * tw.y + nz(vW.xy / 13.0) * tw.z;
  vec4 b = nz(vW.zy / 3.1) * tw.x + nz(vW.xz / 3.1) * tw.y + nz(vW.xy / 3.1) * tw.z;
  vec3 col = vC.rgb * uTint;
  #ifdef STRATA
  float wob = (nz(vW.xz / 620.0).r - 0.5) * 26.0;
  float band = nz(vec2((vW.y + wob) / 210.0, 0.31)).r, fine = nz(vec2((vW.y + wob) / 37.0, 0.77)).r;
  col = mix(vec3(0.43, 0.095, 0.045), vec3(0.69, 0.28, 0.12), smoothstep(0.35, 0.65, band));
  col = mix(col, vec3(0.85, 0.67, 0.45), smoothstep(0.62, 0.72, fine) * 0.5);
  N = normalize(N + (vec3(a.r, b.r, a.b) - 0.5) * 0.8);
  #endif
  col *= 0.68 + 0.35 * a.b + 0.3 * b.b;
  N = normalize(N + (vec3(b.r, a.b, b.b) - 0.5) * 0.28);
  // moss and lichen on what faces up and north
  float moss = smoothstep(0.45, 0.8, a.r + N.y * 0.25 - 0.1) * (1.0 - step(0.01, vC.a));
  #if !defined(STRATA) && !defined(WET)
  col = mix(col, col * 0.5 + vec3(0.05, 0.065, 0.025), moss * 0.6);
  #endif
  float wet = 1.0 - smoothstep(0.1, 1.1, vW.y + (a.r - 0.5));
  #ifdef WET
  wet = 1.0;
  #endif
  col *= mix(1.0, 0.5, wet);
  float ao = 0.75 + 0.25 * smoothstep(-0.3, 1.0, N.y);
  float sh = keyShadow(vW + N * 0.1, 0.0012);
  vec3 c = litSurface(col, N, V, ao, sh, 0.1);
  vec3 H = normalize(V + uKeyDir);
  c += uKeyCol * sh * pow(sat(dot(N, H)), 48.0) * wet * 0.9;
  #ifdef WET
  c += (uHorizon * 0.3 + uMid * 0.2) * pow(1.0 - sat(dot(N, V)), 4.0);
  #endif
  // lit windows and lamps come up as the light goes
  float dusk = sat(1.15 - lum(uKeyCol) * 0.62);
  c += vC.rgb * vC.a * (0.25 + 1.5 * dusk) * (0.92 + 0.08 * sin(uTime * 7.0 + vW.x));
  o = vec4(c, 1.0);
}
`;
const C_VERT = /* glsl */ `
${FULL}
in vec4 color; in vec4 aQ;
out vec3 vW; out vec3 vN; out vec4 vC;
void main(){
  vec4 w = modelMatrix * vec4(position, 1.0);
  vec2 wd = normalize(uWind + vec2(1e-4));
  float ws = length(uWind);
  float lift = 0.25 + 0.75 * smoothstep(1.0, 6.0, ws);
  float u = aQ.x;
  float wv = sin(u * 2.4 - uTime * (3.0 + ws * 0.5) + aQ.z * 2.0) * 0.22 * u;
  w.xz += wd * u * lift + vec2(-wd.y, wd.x) * wv;
  w.y -= u * (1.0 - lift) * 0.8 - wv * 0.3;
  vW = w.xyz;
  vN = normalize(vec3(-wd.y, 0.2, wd.x) + vec3(wd.x, 0.0, wd.y) * cos(u * 2.4 - uTime * 4.0) * 0.5);
  vC = color;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const C_FRAG = /* glsl */ `
${FULL}
in vec3 vW; in vec3 vN; in vec4 vC;
layout(location = 0) out vec4 o;
void main(){
  vec3 V = normalize(uCamPos - vW);
  vec3 N = normalize(vN); if (dot(N, V) < 0.0) N = -N;
  float sh = keyShadow(vW, 0.0016);
  float nl = sat((dot(N, uKeyDir) + 0.4) / 1.4);
  vec3 c = vC.rgb * (uKeyCol * nl * sh + ambient(N, 1.0));
  c += vC.rgb * uKeyCol * pow(sat(dot(-V, uKeyDir)), 3.0) * sh;
  o = vec4(c, 1.0);
}
`;
const BEAM_V = /* glsl */ `
${FULL}
out vec3 vL; out vec3 vW; out vec3 vN;
void main(){
  vL = position;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(mat3(modelMatrix) * vec3(0.0, position.y, position.z));
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;
const BEAM_F = /* glsl */ `
${FULL}
${VIEWRAY}
in vec3 vL; in vec3 vW; in vec3 vN;
uniform sampler2D tDepth;
layout(location = 0) out vec4 o;
void main(){
  float z = texture(tDepth, gl_FragCoord.xy / uRes).r;
  float oz = z >= 0.9999999 ? 1e6 : linZ(z);
  float soft = sat((oz - 1.0 / gl_FragCoord.w) / 14.0);
  float t = abs(vL.x) / 900.0;
  vec3 V = normalize(uCamPos - vW);
  float f = pow(abs(dot(normalize(vN), V)), 2.2);
  float a = f * pow(1.0 - t, 1.8) * 0.2 * smoothstep(0.0, 0.03, t) * sat(uStars * 1.3);
  o = vec4(vec3(1.0, 0.86, 0.6) * a * soft, 1.0);
}
`;
