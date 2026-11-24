import * as THREE from 'three';
import { FULL } from './glsl/common';
import { Uniforms, worldMaterial } from './globals';
import type { TreeKind } from '../game/days';
import type { Heightfield, MaskField } from '../sim/terrain';
import { Noise, makeRng } from '../world/noise';

/** Four painted leaf sprays in one atlas: broad, fine, needle, frond. */
function makeLeafAtlas(): THREE.CanvasTexture {
  const S = 1024;
  const T = S / 2;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const c = cv.getContext('2d')!;
  const rng = makeRng(4242);
  const leaf = (x: number, y: number, l: number, w: number, a: number, tone: number) => {
    c.save();
    c.translate(x, y);
    c.rotate(a);
    const v = Math.round(255 * tone);
    c.fillStyle = `rgb(${v},${v},${v})`;
    c.beginPath();
    c.moveTo(-l, 0);
    c.quadraticCurveTo(0, -w, l, 0);
    c.quadraticCurveTo(0, w, -l, 0);
    c.fill();
    c.restore();
  };
  const clip = (i: number, j: number, fn: () => void) => {
    c.save();
    c.beginPath();
    c.rect(i * T + 3, j * T + 3, T - 6, T - 6);
    c.clip();
    c.translate(i * T + T / 2, j * T + T / 2);
    fn();
    c.restore();
  };
  // 0: broad leaves, a loose round cluster — dark behind, bright in front
  clip(0, 0, () => {
    for (let k = 0; k < 330; k++) {
      const f = k / 330;
      const r = Math.sqrt(rng()) * T * 0.43;
      const a = rng() * Math.PI * 2;
      leaf(Math.cos(a) * r, Math.sin(a) * r, 13 + rng() * 12, 8 + rng() * 7, rng() * 6.3, 0.42 + 0.5 * f + rng() * 0.12);
    }
  });
  // 1: fine leaves, airy
  clip(1, 0, () => {
    for (let k = 0; k < 260; k++) {
      const f = k / 260;
      const r = Math.pow(rng(), 0.55) * T * 0.44;
      const a = rng() * Math.PI * 2;
      leaf(Math.cos(a) * r, Math.sin(a) * r * 1.02, 8 + rng() * 8, 5 + rng() * 4.5, rng() * 6.3, 0.45 + 0.45 * f + rng() * 0.14);
    }
  });
  // 2: needle bough — drooping strokes from a spine
  clip(0, 1, () => {
    for (let k = 0; k < 420; k++) {
      const u = rng() * 2 - 1;
      const x = u * T * 0.44;
      const top = -T * 0.2 + Math.abs(u) * T * 0.2;
      const len = (1 - Math.abs(u) * 0.55) * T * (0.12 + rng() * 0.28);
      const y = top + rng() * T * 0.24;
      c.strokeStyle = `rgba(${0},${0},${0},1)`;
      const v = Math.round(255 * (0.4 + 0.55 * rng() * (0.5 + 0.5 * (k / 420))));
      c.strokeStyle = `rgb(${v},${v},${v})`;
      c.lineWidth = 4 + rng() * 5;
      c.lineCap = 'round';
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + u * 26 + (rng() - 0.5) * 22, y + len);
      c.stroke();
    }
  });
  // 3: frond — a feathered blade lying along +x
  clip(1, 1, () => {
    for (let k = 0; k < 64; k++) {
      const t = k / 63;
      const x = -T * 0.46 + t * T * 0.92;
      const l = T * 0.34 * Math.sin(Math.PI * Math.min(1, 0.12 + t * 0.9)) + 8;
      for (const s of [-1, 1]) {
        const v = Math.round(255 * (0.55 + 0.4 * rng()));
        c.strokeStyle = `rgb(${v},${v},${v})`;
        c.lineWidth = 8 - 3 * t;
        c.lineCap = 'round';
        c.beginPath();
        c.moveTo(x, 0);
        c.quadraticCurveTo(x + 24, s * l * 0.5, x + 34 + 20 * t, s * l);
        c.stroke();
      }
    }
    c.strokeStyle = '#d8d8d8';
    c.lineWidth = 9;
    c.beginPath();
    c.moveTo(-T * 0.47, 0);
    c.lineTo(T * 0.45, 0);
    c.stroke();
  });
  // bleed colour under the alpha so mips don't fringe dark
  const img = c.getImageData(0, 0, S, S);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 8) {
      d[i] = d[i + 1] = d[i + 2] = 178;
    } else {
      const a = d[i + 3] / 255;
      d[i] = d[i + 1] = d[i + 2] = Math.min(255, d[i] * a + 178 * (1 - a));
    }
  }
  const t = new THREE.DataTexture(new Uint8Array(d.buffer), S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.flipY = false;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t as unknown as THREE.CanvasTexture;
}

interface Card {
  p: [number, number, number];
  n: [number, number, number];
  s: number;
  sy?: number;
  shade: number;
}

class TreeGeo {
  pos: number[] = [];
  nor: number[] = [];
  cor: number[] = []; // corner xy, kind z
  uv: number[] = [];
  mis: number[] = []; // shade, flutter
  idx: number[] = [];

  tube(pts: Array<[number, number, number, number]>, sides: number): void {
    const base = this.pos.length / 3;
    for (let r = 0; r < pts.length; r++) {
      const [x, y, z, rad] = pts[r];
      for (let s = 0; s <= sides; s++) {
        const a = (s / sides) * Math.PI * 2;
        this.pos.push(x + Math.cos(a) * rad, y, z + Math.sin(a) * rad);
        this.nor.push(Math.cos(a), 0.1, Math.sin(a));
        this.cor.push(0, 0, 0);
        this.uv.push(s / sides, y);
        this.mis.push(0.55 + 0.45 * Math.min(1, r / pts.length + 0.3), 0);
      }
    }
    for (let r = 0; r < pts.length - 1; r++)
      for (let s = 0; s < sides; s++) {
        const a = base + r * (sides + 1) + s;
        this.idx.push(a, a + sides + 1, a + 1, a + 1, a + sides + 1, a + sides + 2);
      }
  }

  card(c: Card, tile: number, kind: number, rot: number): void {
    const base = this.pos.length / 3;
    const tu = tile % 2;
    const tv = tile >> 1;
    const q: Array<[number, number]> = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    const ca = Math.cos(rot);
    const sa = Math.sin(rot);
    for (const [x, y] of q) {
      this.pos.push(...c.p);
      this.nor.push(...c.n);
      const X = x * c.s;
      const Y = y * (c.sy ?? c.s);
      this.cor.push(X * ca - Y * sa, X * sa + Y * ca, kind);
      // canvas rows run downward: v=0 is the top of the tile
      this.uv.push((tu + 0.5 + x * 0.49) / 2, (tv + 0.5 - y * 0.49) / 2);
      this.mis.push(c.shade, 1);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** a fixed (non-billboard) frond strip */
  frond(p0: [number, number, number], ang: number, len: number, droop: number, wid: number): void {
    const base = this.pos.length / 3;
    const seg = 5;
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      const r = len * t * (1 - 0.25 * droop * t);
      const y = p0[1] + len * (0.32 * t - droop * t * t);
      const cx = p0[0] + Math.cos(ang) * r;
      const cz = p0[2] + Math.sin(ang) * r;
      for (const s of [-1, 1]) {
        this.pos.push(cx - Math.sin(ang) * wid * s, y - 0.16 * wid, cz + Math.cos(ang) * wid * s);
        this.nor.push(Math.cos(ang) * 0.35 - Math.sin(ang) * s * 0.3, 0.85, Math.sin(ang) * 0.35 + Math.cos(ang) * s * 0.3);
        this.cor.push(0, 0, 2);
        this.uv.push((1 + 0.03 + t * 0.94) / 2, (1 + 0.5 + s * 0.48) / 2);
        this.mis.push(0.75 + 0.3 * t, t);
      }
    }
    for (let i = 0; i < seg; i++) {
      const a = base + i * 2;
      this.idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('aCor', new THREE.Float32BufferAttribute(this.cor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('aMis', new THREE.Float32BufferAttribute(this.mis, 2));
    g.setIndex(this.idx);
    return g;
  }
}

/** Trees are unit-height; instances scale them. */
function buildTree(form: TreeKind['form'], lod: 0 | 1, seed: number): THREE.BufferGeometry {
  const g = new TreeGeo();
  const rng = makeRng(seed * 77 + 13);
  const near = lod === 0;
  const sph = (n: number, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, size: number, tile: number, fill = 0.55) => {
    for (let i = 0; i < n; i++) {
      // even-ish points through the volume, biased to the shell
      const y = 1 - (2 * (i + 0.5)) / n;
      const th = i * 2.39996 + rng() * 0.6;
      const rr = Math.sqrt(1 - y * y);
      const k = fill + (1 - fill) * Math.pow(rng(), 0.4);
      const d: [number, number, number] = [Math.cos(th) * rr, y, Math.sin(th) * rr];
      const p: [number, number, number] = [cx + d[0] * rx * k, cy + d[1] * ry * k, cz + d[2] * rz * k];
      const up = 0.25;
      const l = Math.hypot(d[0], d[1] + up, d[2]) || 1;
      g.card(
        { p, n: [d[0] / l, (d[1] + up) / l, d[2] / l], s: size * (0.8 + rng() * 0.45), shade: Math.min(1, 0.42 + 0.34 * (d[1] * 0.5 + 0.5) + 0.34 * k) },
        tile,
        1,
        rng() * 6.28,
      );
    }
  };
  switch (form) {
    case 'broadleaf': {
      g.tube([[0, 0, 0, 0.036], [0.01, 0.2, 0, 0.026], [0, 0.45, 0.01, 0.018], [0, 0.66, 0, 0.008]], near ? 6 : 3);
      if (near) {
        for (let b = 0; b < 4; b++) {
          const a = b * 1.7 + rng();
          g.tube([[0, 0.28 + b * 0.05, 0, 0.014], [Math.cos(a) * 0.12, 0.45 + b * 0.04, Math.sin(a) * 0.12, 0.007]], 4);
        }
        sph(26, 0, 0.64, 0, 0.27, 0.27, 0.27, 0.13, 0);
        sph(14, 0.17, 0.52, 0.08, 0.17, 0.15, 0.17, 0.11, 0);
        sph(14, -0.14, 0.5, -0.12, 0.17, 0.15, 0.17, 0.11, 0);
        sph(10, 0.03, 0.82, -0.05, 0.15, 0.13, 0.15, 0.1, 0);
      } else {
        sph(9, 0, 0.62, 0, 0.23, 0.23, 0.23, 0.2, 0, 0.75);
        sph(3, 0.03, 0.8, 0, 0.1, 0.08, 0.1, 0.16, 0, 0.8);
      }
      break;
    }
    case 'birch': {
      g.tube([[0, 0, 0, 0.018], [0.012, 0.3, 0, 0.014], [-0.006, 0.6, 0.008, 0.01], [0.01, 0.92, 0, 0.003]], near ? 6 : 3);
      if (near) {
        for (let i = 0; i < 46; i++) {
          const t = rng();
          const y = 0.3 + t * 0.64;
          const r = 0.17 * Math.sin(Math.PI * Math.min(1, 0.18 + t * 0.82)) * (0.45 + 0.55 * Math.sqrt(rng()));
          const a = i * 2.4;
          const nx = Math.cos(a);
          const nz = Math.sin(a);
          g.card({ p: [nx * r, y, nz * r], n: [nx * 0.8, 0.55, nz * 0.8], s: 0.085 + rng() * 0.035, sy: 0.11, shade: 0.62 + 0.4 * t * (r / 0.17 + 0.3) }, 1, 1, rng() * 0.6 - 0.3);
        }
      } else {
        for (let i = 0; i < 9; i++) {
          const t = (i + 0.5) / 9;
          const r = 0.1 * Math.sin(Math.PI * Math.min(1, 0.2 + t * 0.8));
          const a = i * 2.4;
          g.card({ p: [Math.cos(a) * r, 0.32 + t * 0.56, Math.sin(a) * r], n: [Math.cos(a) * 0.7, 0.6, Math.sin(a) * 0.7], s: 0.13, sy: 0.15, shade: 0.7 + 0.3 * t }, 1, 1, 0);
        }
      }
      break;
    }
    case 'conifer': {
      g.tube([[0, 0, 0, 0.022], [0, 0.5, 0, 0.013], [0, 0.96, 0, 0.002]], near ? 5 : 3);
      const tiers = near ? 11 : 6;
      for (let t = 0; t < tiers; t++) {
        const f = t / (tiers - 1);
        const y = 0.14 + f * 0.8;
        const r = 0.185 * Math.pow(1 - f, 0.85) + 0.012;
        const m = near ? Math.max(3, Math.round(7 - f * 4)) : f > 0.7 ? 1 : 2;
        for (let i = 0; i < m; i++) {
          const a = (i / m) * Math.PI * 2 + t * 1.3 + rng() * 0.4;
          const rr = r * (near ? 0.6 : 0.36);
          g.card(
            { p: [Math.cos(a) * rr, y - 0.02, Math.sin(a) * rr], n: [Math.cos(a) * 0.82, 0.5, Math.sin(a) * 0.82], s: r * (near ? 0.82 : 1.15) + 0.018, sy: near ? 0.085 + r * 0.2 : 0.12 + r * 0.25, shade: 0.5 + 0.5 * f + (near ? 0.12 * rng() : 0.1) },
            2,
            3,
            0,
          );
        }
      }
      break;
    }
    case 'pine': {
      g.tube([[0, 0, 0, 0.034], [0.03, 0.3, 0.01, 0.026], [0.0, 0.62, 0.02, 0.016], [0.02, 0.84, 0, 0.006]], near ? 6 : 3);
      const clumps: Array<[number, number, number, number]> = [[0.02, 0.84, 0, 0.2], [0.17, 0.72, 0.05, 0.16], [-0.16, 0.7, -0.07, 0.15], [0.03, 0.62, -0.18, 0.13], [-0.03, 0.66, 0.18, 0.12]];
      for (const [x, y, z, r] of clumps) {
        if (near) g.tube([[0.01, y - 0.2, 0.01, 0.012], [x * 0.9, y - 0.04, z * 0.9, 0.005]], 4);
        sph(near ? 11 : 2, x, y, z, r, r * 0.5, r, near ? 0.085 : 0.16, near ? 2 : 0, near ? 0.5 : 0.8);
      }
      break;
    }
    case 'juniper': {
      g.tube([[0, 0, 0, 0.09], [0.08, 0.2, 0.03, 0.065], [0.02, 0.42, -0.04, 0.045], [0.1, 0.62, 0, 0.02]], near ? 6 : 3);
      const c: Array<[number, number, number, number]> = [[0.12, 0.72, 0, 0.32], [-0.22, 0.56, 0.1, 0.26], [0.26, 0.5, -0.16, 0.24], [0, 0.92, 0.05, 0.2]];
      for (const [x, y, z, r] of c) sph(near ? 12 : 3, x, y, z, r, r * 0.75, r, near ? 0.13 : 0.22, 1, 0.5);
      break;
    }
    case 'willow': {
      g.tube([[0, 0, 0, 0.05], [0.03, 0.25, 0, 0.038], [-0.02, 0.52, 0.02, 0.02]], near ? 6 : 3);
      const m = near ? 44 : 11;
      for (let i = 0; i < m; i++) {
        const a = i * 2.4;
        const r = 0.36 * Math.sqrt((i + 0.5) / m);
        const top = 0.86 - 0.3 * (r / 0.36) * (r / 0.36);
        g.card({ p: [Math.cos(a) * r, top - 0.12, Math.sin(a) * r], n: [Math.cos(a) * 0.6, 0.7, Math.sin(a) * 0.6], s: near ? 0.085 : 0.16, sy: near ? 0.2 : 0.26, shade: 0.55 + 0.45 * (top / 0.86) }, 1, 3, 0);
      }
      break;
    }
    case 'acacia': {
      g.tube([[0, 0, 0, 0.034], [0.02, 0.3, 0, 0.026], [-0.01, 0.55, 0.02, 0.018], [0.04, 0.72, 0, 0.01]], near ? 6 : 3);
      for (let b = 0; b < (near ? 5 : 0); b++) {
        const a = b * 1.3;
        g.tube([[0, 0.48, 0, 0.014], [Math.cos(a) * 0.24, 0.8, Math.sin(a) * 0.24, 0.004]], 4);
      }
      const d: Array<[number, number, number, number]> = [[0, 0.88, 0, 0.36], [0.3, 0.82, 0.1, 0.24], [-0.28, 0.83, -0.12, 0.26], [0.04, 0.8, 0.3, 0.2], [0, 0.82, -0.3, 0.2]];
      for (const [x, y, z, r] of d) sph(near ? 13 : 3, x, y, z, r, 0.07, r, near ? 0.1 : 0.2, 1, 0.4);
      break;
    }
    case 'palm': {
      g.tube([[0, 0, 0, 0.03], [0.04, 0.35, 0, 0.022], [0.07, 0.7, 0.01, 0.019], [0.08, 0.88, 0.01, 0.018]], near ? 6 : 3);
      const m = near ? 15 : 7;
      for (let i = 0; i < m; i++) g.frond([0.08, 0.88, 0.01], i * 2.4 + rng() * 0.2, 0.36 + rng() * 0.08, 0.35 + (i / m) * 0.75, near ? 0.06 : 0.1);
      break;
    }
  }
  return g.build();
}

const TILE = 64;
const MAX_NEAR = 2600;
const MAX_MID = 34000;

interface Species {
  kind: TreeKind;
  near: THREE.InstancedBufferGeometry;
  mid: THREE.InstancedBufferGeometry;
  nearBuf: THREE.InstancedInterleavedBuffer;
  midBuf: THREE.InstancedInterleavedBuffer;
  nearMesh: THREE.Mesh;
  midMesh: THREE.Mesh;
  shadow: THREE.Mesh;
  nNear: number;
  nMid: number;
}

interface Tile {
  /** per species: count and interleaved data (8 floats) */
  data: Float32Array[];
  maxY: number;
  minY: number;
}

/** Forests: lazily-grown tiles streamed into a handful of instanced draws. */
export class Trees {
  private species: Species[] = [];
  private tiles = new Map<number, Tile>();
  private hf: Heightfield | null = null;
  private mask: MaskField | null = null;
  private noise = new Noise(1);
  private seed = 1;
  private gap = 9;
  private clear: Array<{ x: number; z: number; r: number }> = [];
  private readonly atlas: THREE.Texture;
  private readonly frustum = new THREE.Frustum();
  private readonly pv = new THREE.Matrix4();
  private readonly box = new THREE.Box3();
  private lastPos = new THREE.Vector3(1e9, 0, 0);
  private lastDir = new THREE.Vector3();
  nearR = 190;
  farR = 1400;
  density = 1;
  readonly uFar = { value: 1400 };

  constructor(
    private readonly scene: THREE.Scene,
    private readonly shadowScene: THREE.Scene,
  ) {
    this.atlas = makeLeafAtlas();
  }

  load(kinds: TreeKind[], gap: number, hf: Heightfield, mask: MaskField, seed: number, clear: Array<{ x: number; z: number; r: number }>): void {
    for (const s of this.species) {
      this.scene.remove(s.nearMesh, s.midMesh);
      this.shadowScene.remove(s.shadow);
      s.near.dispose();
      s.mid.dispose();
      (s.nearMesh.material as THREE.Material).dispose();
      (s.midMesh.material as THREE.Material).dispose();
      (s.shadow.material as THREE.Material).dispose();
    }
    this.species = [];
    this.tiles.clear();
    this.hf = hf;
    this.mask = mask;
    this.seed = seed;
    this.gap = gap;
    this.clear = clear;
    this.noise = new Noise(seed + 515);
    this.lastPos.set(1e9, 0, 0);
    kinds.forEach((k, i) => {
      const mk = (lod: 0 | 1, max: number) => {
        const base = buildTree(k.form, lod, i + 3);
        const g = new THREE.InstancedBufferGeometry();
        for (const n of Object.keys(base.attributes)) g.setAttribute(n, base.attributes[n]);
        g.setIndex(base.index);
        const buf = new THREE.InstancedInterleavedBuffer(new Float32Array(max * 8), 8, 1);
        buf.setUsage(THREE.DynamicDrawUsage);
        g.setAttribute('iA', new THREE.InterleavedBufferAttribute(buf, 4, 0));
        g.setAttribute('iB', new THREE.InterleavedBufferAttribute(buf, 4, 4));
        g.instanceCount = 0;
        return { g, buf };
      };
      const n = mk(0, MAX_NEAR);
      const m = mk(1, MAX_MID);
      const u: Uniforms = {
        tLeaf: { value: this.atlas },
        kL0: { value: new THREE.Color(k.leaf[0]) },
        kL1: { value: new THREE.Color(k.leaf[1]) },
        kL2: { value: new THREE.Color(k.leaf[2]) },
        kBark: { value: new THREE.Color(k.bark) },
        kBirch: { value: k.form === 'birch' ? 1 : 0 },
        uTreeFar: this.uFar,
      };
      const opts = { side: THREE.DoubleSide, alphaToCoverage: true } as const;
      const matN = worldMaterial(VERT, FRAG, { ...u, uMidLod: { value: 0 } }, opts);
      const matM = worldMaterial(VERT, FRAG, { ...u, uMidLod: { value: 1 } }, opts);
      const matS = worldMaterial('#define SHADOW\n' + VERT, SHADOW_FRAG, { ...u, uMidLod: { value: 0 } }, { side: THREE.DoubleSide });
      const nearMesh = new THREE.Mesh(n.g, matN);
      const midMesh = new THREE.Mesh(m.g, matM);
      const shadow = new THREE.Mesh(n.g, matS);
      nearMesh.frustumCulled = midMesh.frustumCulled = shadow.frustumCulled = false;
      this.scene.add(nearMesh, midMesh);
      this.shadowScene.add(shadow);
      this.species.push({ kind: k, near: n.g, mid: m.g, nearBuf: n.buf, midBuf: m.buf, nearMesh, midMesh, shadow, nNear: 0, nMid: 0 });
    });
  }

  private grow(ti: number, tj: number): Tile {
    const key = (ti + 4096) * 8192 + (tj + 4096);
    const hit = this.tiles.get(key);
    if (hit) return hit;
    const rng = makeRng((ti * 73856093) ^ (tj * 19349663) ^ (this.seed * 83492791));
    const lists: number[][] = this.species.map(() => []);
    const hf = this.hf!;
    const mask = this.mask!;
    const n = Math.max(1, Math.round(TILE / this.gap));
    const st = TILE / n;
    let minY = 1e9;
    let maxY = -1e9;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = ti * TILE + (i + 0.5 + (rng() - 0.5) * 0.9) * st;
        const z = tj * TILE + (j + 0.5 + (rng() - 0.5) * 0.9) * st;
        const r = rng();
        const pick = rng();
        const sz = rng();
        const yaw = rng();
        const tint = rng();
        const m = mask.at(x, z, 0);
        if (r > (m > 0.12 ? Math.min(1, m * 1.25) : m * 0.5) * this.density) continue;
        const y = hf.heightAt(x, z);
        if (y < 0.5) continue;
        let blocked = false;
        for (const c of this.clear) if ((x - c.x) ** 2 + (z - c.z) ** 2 < c.r * c.r) blocked = true;
        if (blocked) continue;
        // stands: species gather in patches
        const patch = this.noise.fbm(x / 260, z / 260, 2) * 0.55;
        let p = Math.min(0.9999, Math.max(0, pick + patch));
        let k = 0;
        for (; k < this.species.length - 1; k++) {
          p -= this.species[k].kind.weight;
          if (p < 0) break;
        }
        const sp = this.species[k].kind;
        const edge = Math.min(1, 0.72 + m * 0.5);
        const s = (sp.size[0] + (sp.size[1] - sp.size[0]) * sz) * edge;
        lists[k].push(x, y - 0.15, z, s, yaw * 6.283, tint, rng(), 0.85 + rng() * 0.35);
        if (y < minY) minY = y;
        if (y + s > maxY) maxY = y + s;
      }
    }
    const t: Tile = { data: lists.map((l) => new Float32Array(l)), minY, maxY };
    this.tiles.set(key, t);
    return t;
  }

  update(cam: THREE.PerspectiveCamera, budget = 40): void {
    if (!this.hf) return;
    this.uFar.value = this.farR;
    const p = cam.position;
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    if (p.distanceToSquared(this.lastPos) < 25 && dir.dot(this.lastDir) > 0.9995) return;
    this.lastPos.copy(p);
    this.lastDir.copy(dir);
    this.pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    for (const s of this.species) s.nNear = s.nMid = 0;
    const R = Math.ceil(this.farR / TILE);
    const ci = Math.floor(p.x / TILE);
    const cj = Math.floor(p.z / TILE);
    let grown = 0;
    // spiral outward so the nearest always get their budget first
    for (let ring = 0; ring <= R; ring++) {
      for (let j = -ring; j <= ring; j++) {
        const edge = Math.abs(j) === ring;
        for (let i = -ring; i <= ring; i += edge ? 1 : Math.max(1, ring * 2)) {
          const ti = ci + i;
          const tj = cj + j;
          const cx = (ti + 0.5) * TILE;
          const cz = (tj + 0.5) * TILE;
          const d = Math.hypot(cx - p.x, cz - p.z);
          if (d > this.farR + TILE * 0.7) continue;
          const key = (ti + 4096) * 8192 + (tj + 4096);
          let t = this.tiles.get(key);
          const isNear = d < this.nearR;
          if (!t) {
            // rough cull before paying to grow
            this.box.min.set(cx - TILE * 0.6, -20, cz - TILE * 0.6);
            this.box.max.set(cx + TILE * 0.6, 2200, cz + TILE * 0.6);
            if (!isNear && !this.frustum.intersectsBox(this.box)) continue;
            if (grown++ > budget) continue;
            t = this.grow(ti, tj);
          }
          if (t.maxY < t.minY) continue;
          this.box.min.set(cx - TILE * 0.6, t.minY - 2, cz - TILE * 0.6);
          this.box.max.set(cx + TILE * 0.6, t.maxY + 4, cz + TILE * 0.6);
          const vis = this.frustum.intersectsBox(this.box);
          if (!vis && d > 150) continue; // keep close ones for their shadows
          const thin = d > this.farR * 0.55;
          for (let k = 0; k < this.species.length; k++) {
            const s = this.species[k];
            const a = t.data[k];
            let cnt = a.length / 8;
            if (cnt === 0) continue;
            if (isNear) {
              cnt = Math.min(cnt, MAX_NEAR - s.nNear);
              if (cnt <= 0) continue;
              (s.nearBuf.array as Float32Array).set(cnt * 8 === a.length ? a : a.subarray(0, cnt * 8), s.nNear * 8);
              s.nNear += cnt;
            } else if (vis) {
              if (thin) cnt = Math.ceil(cnt * 0.6);
              cnt = Math.min(cnt, MAX_MID - s.nMid);
              if (cnt <= 0) continue;
              (s.midBuf.array as Float32Array).set(a.subarray(0, cnt * 8), s.nMid * 8);
              s.nMid += cnt;
            }
          }
        }
      }
    }
    if (grown > budget) this.lastPos.set(1e9, 0, 0); // more to do next frame
    for (const s of this.species) {
      s.near.instanceCount = s.nNear;
      s.mid.instanceCount = s.nMid;
      s.nearMesh.visible = s.nNear > 0;
      s.midMesh.visible = s.nMid > 0;
      s.nearBuf.clearUpdateRanges();
      s.nearBuf.addUpdateRange(0, s.nNear * 8);
      s.nearBuf.needsUpdate = true;
      s.midBuf.clearUpdateRanges();
      s.midBuf.addUpdateRange(0, s.nMid * 8);
      s.midBuf.needsUpdate = true;
    }
    if (this.tiles.size > 9000) this.tiles.clear();
  }

  get count(): number {
    return this.species.reduce((a, s) => a + s.nNear + s.nMid, 0);
  }
}

const VERT = /* glsl */ `
${FULL}
in vec3 aCor;
in vec2 aMis;
in vec4 iA;
in vec4 iB;
uniform float uTreeFar, uMidLod;
out vec3 vW;
out vec3 vN;
out vec2 vUv;
out vec3 vTint;   // tint, shade, kind
out float vH;
out float vSh;
void main(){
  float s = iA.w;
  vec3 base = iA.xyz;
  float dist = length(base - uCamPos);
  // thinned far trees spread their crowns to keep the mass
  float spread = 1.0 + uMidLod * 0.2 * smoothstep(uTreeFar * 0.5, uTreeFar * 0.62, dist);
  float grow = 1.0 - smoothstep(uTreeFar * 0.84, uTreeFar, dist);
  float ca = cos(iB.x), sa = sin(iB.x);
  vec3 p = position * vec3(iB.w * spread, 1.0, iB.w * spread);
  p.xz = mat2(ca, -sa, sa, ca) * p.xz;
  vec3 n = normal;
  n.xz = mat2(ca, -sa, sa, ca) * n.xz;
  // wind: the whole tree leans, crowns more than trunks, gusts in waves
  vec2 wd = normalize(uWind + vec2(1e-4));
  float ws = length(uWind);
  float gust = textureLod(uNoise, (base.xz - uWind * uTime * 1.3) / 420.0, 0.0).r;
  float sway = (0.006 + 0.0034 * ws) * (0.5 + 1.2 * gust) * (1.0 + 0.5 * sin(uTime * (1.1 + iB.z * 0.6) + iB.z * 20.0));
  float hh = p.y * p.y;
  p.xz += wd * sway * hh * 1.4;
  vec3 wp = base + p * s * grow;
  float kind = aCor.z;
  if (kind > 0.5 && kind < 1.5 || kind > 2.5){
    float fl = sin(uTime * 2.3 + iB.z * 30.0 + position.x * 25.0 + position.y * 17.0) * 0.07 * (0.4 + 0.12 * ws);
    vec2 c = aCor.xy * s * grow * iB.w * spread;
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    #ifdef SHADOW
    vec3 f = -uKeyDir; right = normalize(cross(f, vec3(0.0, 1.0, 0.0))); up = cross(right, f);
    #endif
    if (kind > 2.5){ up = normalize(mix(up, vec3(0.0, 1.0, 0.0), 0.85)); }
    float cf = cos(fl), sf = sin(fl);
    c = vec2(c.x * cf - c.y * sf, c.x * sf + c.y * cf);
    wp += right * c.x + up * c.y;
    // push cards a little toward the eye so crowns read round
    n = normalize(n + (right * aCor.x + up * aCor.y) / max(length(aCor.xy), 1e-3) * 0.28);
  }
  vW = wp;
  vN = n;
  vUv = uv;
  vTint = vec3(iB.y, aMis.x, kind);
  vH = position.y;
  vSh = terrainShadow(base + vec3(0.0, s * 0.6, 0.0)) * cloudShadowAt(base);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;

const SHADOW_FRAG = /* glsl */ `
precision highp float;
in vec2 vUv;
in vec3 vTint;
uniform sampler2D tLeaf;
layout(location = 0) out vec4 o;
void main(){
  if (vTint.z > 0.5 && texture(tLeaf, vUv).a < 0.4) discard;
  o = vec4(1.0);
}
`;

const FRAG = /* glsl */ `
${FULL}
in vec3 vW;
in vec3 vN;
in vec2 vUv;
in vec3 vTint;
in float vH;
in float vSh;
uniform sampler2D tLeaf;
uniform vec3 kL0, kL1, kL2, kBark;
uniform float kBirch, uMidLod;
layout(location = 0) out vec4 o;
void main(){
  vec3 V = normalize(uCamPos - vW);
  vec3 col;
  float a = 1.0;
  float leaf = step(0.5, vTint.z);
  vec3 N = normalize(vN);
  if (leaf > 0.5){
    vec4 t = texture(tLeaf, vUv);
    vec2 d = vec2(dFdx(vUv.x), dFdy(vUv.y)) * 1024.0;
    float lod = 0.5 * log2(max(dot(dFdx(vUv), dFdx(vUv)), dot(dFdy(vUv), dFdy(vUv))) * 1024.0 * 1024.0 + 1e-6);
    a = t.a * (1.0 + max(lod, 0.0) * 0.22);
    a = sat((a - 0.42) / max(fwidth(a), 0.06) + 0.5);
    if (a < 0.4) discard;
    float m = nz(vW.xz / 61.0).r;
    col = mix(kL0, kL1, smoothstep(0.2, 0.7, vTint.x));
    col = mix(col, kL2, smoothstep(0.62, 0.95, vTint.x) * 0.9);
    col *= mix(0.58, 1.18, t.r) * (0.9 + 0.2 * m);
    col *= mix(0.8, 1.12, smoothstep(0.3, 0.95, vH));
  } else {
    float b = nz(vec2(vUv.x * 0.5 + vTint.x, vUv.y * 1.3)).b;
    col = kBark * (0.6 + 0.7 * b);
    if (kBirch > 0.5) col = mix(col, vec3(0.05), smoothstep(0.68, 0.74, nz(vec2(vUv.x * 0.2 + vTint.x, vUv.y * 7.0)).r) * 0.85);
  }
  float ao = vTint.y;
  float sh = vSh;
  if (uMidLod < 0.5) sh *= csmShadow(vW + N * 0.4, 0.0016);
  // crowns shade themselves
  float selfS = smoothstep(-0.55, 0.45, dot(N, uKeyDir));
  float nl = sat((dot(N, uKeyDir) + 0.42) / 1.42);
  vec3 c = col * (uKeyCol * nl * sh * mix(0.55, 1.0, ao) + ambient(N, ao * 0.95));
  if (leaf > 0.5){
    float back = pow(sat(dot(-V, uKeyDir)), 2.5);
    c += col * mix(vec3(1.0), col * 2.2, 0.4) * uKeyCol * back * sh * ao * (0.5 + 0.5 * (1.0 - selfS)) * 1.25;
  }
  o = vec4(c, a);
}
`;
