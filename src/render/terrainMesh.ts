import * as THREE from 'three';
import type { BakedLand } from '../world/generate';
import { HALF } from '../world/lands';
import { FULL } from './glsl/common';
import { G, worldMaterial } from './globals';

/** Per-land ground paint. Colours are sRGB hex. */
export interface GroundStyle {
  grassA: string;
  grassB: string;
  dry: string;
  forestA: string;
  forestB: string;
  forestC: string;
  rockA: string;
  rockB: string;
  sand: string;
  mud: string;
  snow: string;
  /** canopy height beyond tree draw distance */
  canopy: number;
  /** strata strength for canyon country */
  strata: number;
  /** how much wind-sheen the fields carry */
  sheen: number;
}

const GRID = 32;
const LEAF = 64;
const K = 2.5;
const ROOT = 65536;
const MAX_PATCH = 1400;

/** CDLOD terrain: one instanced grid patch, a quadtree, and a heightmap. */
export class TerrainMesh {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  private readonly inst: Float32Array;
  private readonly attr: THREE.InstancedBufferAttribute;
  private readonly geo: THREE.InstancedBufferGeometry;
  private pyramid: Array<{ n: number; min: Float32Array; max: Float32Array }> = [];
  private readonly frustum = new THREE.Frustum();
  private readonly pv = new THREE.Matrix4();
  private readonly box = new THREE.Box3();
  private count = 0;
  readonly style: Record<string, THREE.IUniform>;
  /** world textures owned by this terrain */
  private tex: THREE.Texture[] = [];

  constructor(private lodScale = 1) {
    const v = GRID + 1;
    const pos = new Float32Array(v * v * 3);
    for (let j = 0; j < v; j++) {
      for (let i = 0; i < v; i++) {
        pos[(j * v + i) * 3] = i / GRID;
        pos[(j * v + i) * 3 + 1] = 0;
        pos[(j * v + i) * 3 + 2] = j / GRID;
      }
    }
    const idx = new Uint16Array(GRID * GRID * 6);
    let q = 0;
    for (let j = 0; j < GRID; j++) {
      for (let i = 0; i < GRID; i++) {
        const a = j * v + i;
        const flip = (i + j) & 1;
        if (flip) {
          idx[q++] = a; idx[q++] = a + v; idx[q++] = a + 1;
          idx[q++] = a + 1; idx[q++] = a + v; idx[q++] = a + v + 1;
        } else {
          idx[q++] = a; idx[q++] = a + v; idx[q++] = a + v + 1;
          idx[q++] = a; idx[q++] = a + v + 1; idx[q++] = a + 1;
        }
      }
    }
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.inst = new Float32Array(MAX_PATCH * 3);
    this.attr = new THREE.InstancedBufferAttribute(this.inst, 3);
    this.attr.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aPatch', this.attr);

    this.style = {
      sGrassA: { value: new THREE.Color() },
      sGrassB: { value: new THREE.Color() },
      sDry: { value: new THREE.Color() },
      sForestA: { value: new THREE.Color() },
      sForestB: { value: new THREE.Color() },
      sForestC: { value: new THREE.Color() },
      sRockA: { value: new THREE.Color() },
      sRockB: { value: new THREE.Color() },
      sSand: { value: new THREE.Color() },
      sMud: { value: new THREE.Color() },
      sSnow: { value: new THREE.Color() },
      sCanopy: { value: 9 },
      sStrata: { value: 0 },
      sSheen: { value: 1 },
      uTreeFar: { value: 1400 },
      uLodK: { value: K * lodScale },
      uAgl: { value: 0 },
      uLand: { value: 0 },
    };
    this.material = worldMaterial(VERT, FRAG, this.style);
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
  }

  setStyle(s: GroundStyle, landIndex: number): void {
    const u = this.style;
    (u.sGrassA.value as THREE.Color).set(s.grassA);
    (u.sGrassB.value as THREE.Color).set(s.grassB);
    (u.sDry.value as THREE.Color).set(s.dry);
    (u.sForestA.value as THREE.Color).set(s.forestA);
    (u.sForestB.value as THREE.Color).set(s.forestB);
    (u.sForestC.value as THREE.Color).set(s.forestC);
    (u.sRockA.value as THREE.Color).set(s.rockA);
    (u.sRockB.value as THREE.Color).set(s.rockB);
    (u.sSand.value as THREE.Color).set(s.sand);
    (u.sMud.value as THREE.Color).set(s.mud);
    (u.sSnow.value as THREE.Color).set(s.snow);
    u.sCanopy.value = s.canopy;
    u.sStrata.value = s.strata;
    u.sSheen.value = s.sheen;
    u.uLand.value = landIndex;
  }

  load(b: BakedLand): void {
    for (const t of this.tex) t.dispose();
    this.tex = [];
    const r32 = (d: Float32Array, n: number) => {
      const t = new THREE.DataTexture(d, n, n, THREE.RedFormat, THREE.FloatType);
      t.internalFormat = 'R32F';
      t.minFilter = t.magFilter = THREE.NearestFilter;
      t.generateMipmaps = false;
      t.needsUpdate = true;
      this.tex.push(t);
      return t;
    };
    const rgba = (d: Uint8Array, n: number) => {
      const t = new THREE.DataTexture(d, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = true;
      t.anisotropy = 8;
      t.needsUpdate = true;
      this.tex.push(t);
      return t;
    };
    G.uHeightTex.value = r32(b.height, b.n);
    G.uNormalTex.value = rgba(b.normal, b.n);
    G.uMaskTex.value = rgba(b.mask, b.n);
    G.uFarTex.value = r32(b.far, b.nFar);
    const fn = new Uint8Array(b.nFar * b.nFar * 4);
    const cell = (2 * b.farHalf) / (b.nFar - 1);
    for (let j = 0; j < b.nFar; j++) {
      for (let i = 0; i < b.nFar; i++) {
        const k = j * b.nFar + i;
        const l = i > 0 ? k - 1 : k;
        const r = i < b.nFar - 1 ? k + 1 : k;
        const u = j > 0 ? k - b.nFar : k;
        const d = j < b.nFar - 1 ? k + b.nFar : k;
        const dx = (b.far[r] - b.far[l]) / (2 * cell);
        const dz = (b.far[d] - b.far[u]) / (2 * cell);
        const inv = 1 / Math.sqrt(1 + dx * dx + dz * dz);
        fn[k * 4] = Math.round((-dx * inv * 0.5 + 0.5) * 255);
        fn[k * 4 + 1] = Math.round((-dz * inv * 0.5 + 0.5) * 255);
        fn[k * 4 + 2] = 255;
        fn[k * 4 + 3] = 128;
      }
    }
    G.uFarNrm.value = rgba(fn, b.nFar);
    G.uWorld.value.set(HALF, b.n, b.farHalf, b.nFar);
    this.buildPyramid(b);
  }

  private buildPyramid(b: BakedLand): void {
    // min/max of 64 m leaves across the whole ±32768 root
    const n0 = ROOT / LEAF; // 1024
    const min = new Float32Array(n0 * n0);
    const max = new Float32Array(n0 * n0);
    for (let j = 0; j < n0; j++) {
      for (let i = 0; i < n0; i++) {
        const x0 = -ROOT / 2 + i * LEAF;
        const z0 = -ROOT / 2 + j * LEAF;
        let mn = 1e9;
        let mx = -1e9;
        const inCore = x0 >= -HALF && x0 < HALF && z0 >= -HALF && z0 < HALF;
        if (inCore) {
          for (let b1 = 0; b1 <= 3; b1++) {
            for (let a1 = 0; a1 <= 3; a1++) {
              const u = Math.min(b.n - 1, Math.round(((x0 + (a1 * LEAF) / 3) / (2 * HALF) + 0.5) * (b.n - 1)));
              const v = Math.min(b.n - 1, Math.round(((z0 + (b1 * LEAF) / 3) / (2 * HALF) + 0.5) * (b.n - 1)));
              const h = b.height[v * b.n + u];
              if (h < mn) mn = h;
              if (h > mx) mx = h;
            }
          }
        } else {
          const u = Math.max(0, Math.min(b.nFar - 2, Math.floor((x0 / (2 * b.farHalf) + 0.5) * (b.nFar - 1))));
          const v = Math.max(0, Math.min(b.nFar - 2, Math.floor((z0 / (2 * b.farHalf) + 0.5) * (b.nFar - 1))));
          const k = v * b.nFar + u;
          mn = Math.min(b.far[k], b.far[k + 1], b.far[k + b.nFar], b.far[k + b.nFar + 1]);
          mx = Math.max(b.far[k], b.far[k + 1], b.far[k + b.nFar], b.far[k + b.nFar + 1]);
        }
        min[j * n0 + i] = mn - 4;
        max[j * n0 + i] = mx + 16;
      }
    }
    this.pyramid = [{ n: n0, min, max }];
    let cur = this.pyramid[0];
    while (cur.n > 1) {
      const n = cur.n >> 1;
      const mn = new Float32Array(n * n);
      const mx = new Float32Array(n * n);
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const a = j * 2 * cur.n + i * 2;
          mn[j * n + i] = Math.min(cur.min[a], cur.min[a + 1], cur.min[a + cur.n], cur.min[a + cur.n + 1]);
          mx[j * n + i] = Math.max(cur.max[a], cur.max[a + 1], cur.max[a + cur.n], cur.max[a + cur.n + 1]);
        }
      }
      cur = { n, min: mn, max: mx };
      this.pyramid.push(cur);
    }
  }

  update(camera: THREE.PerspectiveCamera, agl: number): void {
    this.pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.pv);
    this.count = 0;
    const h = Math.max(0, agl);
    this.style.uAgl.value = h;
    const cx = camera.position.x;
    const cz = camera.position.z;
    this.visit(this.pyramid.length - 1, 0, 0, cx, cz, h);
    this.geo.instanceCount = this.count;
    this.attr.needsUpdate = true;
    this.attr.clearUpdateRanges();
    this.attr.addUpdateRange(0, this.count * 3);
  }

  private visit(level: number, i: number, j: number, cx: number, cz: number, agl: number): void {
    const size = LEAF * (1 << level);
    const x0 = -ROOT / 2 + i * size;
    const z0 = -ROOT / 2 + j * size;
    const py = this.pyramid[level];
    const k = j * py.n + i;
    this.box.min.set(x0, py.min[k], z0);
    this.box.max.set(x0 + size, py.max[k], z0 + size);
    if (!this.frustum.intersectsBox(this.box)) return;
    const dx = Math.max(x0 - cx, 0, cx - x0 - size);
    const dz = Math.max(z0 - cz, 0, cz - z0 - size);
    const d = Math.sqrt(dx * dx + dz * dz + agl * agl);
    if (level > 0 && d < K * this.lodScale * size) {
      const a = i * 2;
      const b = j * 2;
      this.visit(level - 1, a, b, cx, cz, agl);
      this.visit(level - 1, a + 1, b, cx, cz, agl);
      this.visit(level - 1, a, b + 1, cx, cz, agl);
      this.visit(level - 1, a + 1, b + 1, cx, cz, agl);
      return;
    }
    if (this.count >= MAX_PATCH) return;
    const o = this.count++ * 3;
    this.inst[o] = x0;
    this.inst[o + 1] = z0;
    this.inst[o + 2] = size;
  }

  get patches(): number {
    return this.count;
  }
}

const VERT = /* glsl */ `
${FULL}
in vec3 aPatch;
uniform float uLodK;
uniform float uAgl;
uniform float sCanopy;
uniform float uTreeFar;
out vec3 vW;
out float vDist;
out float vCan;
void main(){
  float size = aPatch.z;
  float step = size / ${GRID.toFixed(1)};
  vec2 xz = aPatch.xy + position.xz * size;
  vec2 d2 = xz - uCamPos.xz;
  float d = sqrt(dot(d2, d2) + uAgl * uAgl);
  float m = smoothstep(uLodK * size * 2.0 * 0.82, uLodK * size * 2.0 * 0.97, d);
  if (size < 60000.0) {
    vec2 g = position.xz * ${GRID.toFixed(1)};
    vec2 odd = mod(g, 2.0);
    xz -= odd * step * m;
  }
  float h = terrainH(xz);
  // beyond the planted trees, the forest continues as a raised canopy
  vec2 muv = xz / (2.0 * uWorld.x) + 0.5;
  float inCore = coreW(xz);
  float f = textureLod(uMaskTex, muv, 1.0).r * inCore;
  float dist = length(vec3(xz.x, h, xz.y) - uCamPos);
  float far = smoothstep(uTreeFar * 0.72, uTreeFar * 1.02, dist);
  float bump = textureLod(uNoise, xz / 210.0, 1.0).g;
  vCan = f * far;
  h += smoothstep(0.15, 0.6, f) * far * sCanopy * (0.45 + 0.75 * bump);
  // a little grain in the near ground
  float near = 1.0 - smoothstep(60.0, 240.0, dist);
  if (near > 0.0) {
    float rk = textureLod(uMaskTex, muv, 0.0).b;
    h += near * (textureLod(uNoise, xz / 23.0, 0.0).r - 0.5) * (0.35 + rk * 1.6) * smoothstep(0.1, 0.9, abs(h));
  }
  vW = vec3(xz.x, h, xz.y);
  vDist = dist;
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}
`;

const FRAG = /* glsl */ `
${FULL}
in vec3 vW;
in float vDist;
in float vCan;
uniform vec3 sGrassA, sGrassB, sDry, sForestA, sForestB, sForestC, sRockA, sRockB, sSand, sMud, sSnow;
uniform float sStrata, sSheen, uLand, uTreeFar;
layout(location = 0) out vec4 o;

vec4 tri(vec3 p, vec3 w, float s){
  return nz(p.zy * s) * w.x + nz(p.xz * s) * w.y + nz(p.xy * s) * w.z;
}

void main(){
  vec2 muv = vW.xz / (2.0 * uWorld.x) + 0.5;
  float cw = coreW(vW.xz);
  vec4 nt = texture(uNormalTex, muv);
  vec4 mk = texture(uMaskTex, muv);
  vec4 fnT = texture(uFarNrm, vW.xz / (2.0 * uWorld.z) + 0.5);
  nt = mix(fnT, nt, cw);
  if (cw < 1.0) {
    // beyond the surveyed land: keep painting in the same hand
    float s0 = length(fnT.xy * 2.0 - 1.0);
    float q = nz(vW.xz / 5200.0).r;
    vec4 fm = vec4(smoothstep(0.45, 0.6, q) * smoothstep(6.0, 20.0, vW.y), smoothstep(1.0, 4.0, vW.y), smoothstep(0.5, 0.8, s0), uLand == 2.0 ? smoothstep(430.0, 700.0, vW.y) : 0.5);
    if (uLand == 3.0 || uLand == 4.0) fm.r *= 0.1;
    mk = mix(fm, mk, cw);
  }
  vec3 N;
  N.xz = nt.xy * 2.0 - 1.0;
  N.y = sqrt(max(0.0, 1.0 - dot(N.xz, N.xz)));
  float ao = nt.z;
  float curv = nt.w * 2.0 - 1.0;
  vec3 gN = N;
  vec3 V = normalize(uCamPos - vW);

  float near = 1.0 - smoothstep(120.0, 900.0, vDist);
  float mid = 1.0 - smoothstep(900.0, 5200.0, vDist);

  // macro variation, several scales, so no meadow is one colour
  float m1 = nz(vW.xz / 1900.0).r;
  float m2 = nz(vW.xz / 430.0 + 0.37).r;
  float m3 = nz(vW.xz / 97.0).r;
  vec3 tw = pow(abs(N), vec3(5.0)); tw /= (tw.x + tw.y + tw.z);
  vec4 b1 = tri(vW, tw, 1.0 / 46.0);
  vec4 b2 = tri(vW, tw, 1.0 / 9.5);
  float dab = mix(b1.b, b2.b, 0.55 * near);

  // detail normals: soft strokes on soft ground, hard fracture on stone
  if (mid > 0.01) {
    float rkN = smoothstep(0.2, 0.8, mk.b);
    vec4 q1 = tri(vW, tw, 1.0 / 71.0), q2 = tri(vW + 1.7, tw, 1.0 / 71.0);
    vec4 r1 = tri(vW, tw, 1.0 / 17.0), r2 = tri(vW + 0.45, tw, 1.0 / 17.0);
    vec3 g1 = vec3(q1.r - q2.r, (q1.b - q2.b) * 0.4, (q1.b - q2.b) * 0.5 + (q1.r - q2.r) * 0.5);
    vec3 g2 = vec3(r1.r - r2.r, r1.b - r2.b, (r1.b - r2.b) * 0.7) * (0.35 + 0.65 * near);
    float soil = 1.0 - smoothstep(0.1, 0.5, mk.r) * smoothstep(0.0, 0.3, vCan);
    N = normalize(N + (g1 * (0.5 + 2.3 * rkN) + g2 * (0.35 + 1.3 * rkN)) * mid * soil);
  }

  // --- paint --------------------------------------------------------------
  float lush = mk.g;
  vec3 grass = mix(sGrassA, sGrassB, sat(m2 * 1.5 - 0.25 + (dab - 0.5) * 0.6));
  grass = mix(grass, sDry, sat((m1 - 0.42) * 1.5) * 0.65);
  vec3 col = mix(sDry, grass, lush);
  float dabMul = 0.72 + 0.56 * dab;
  // tussocks and hollows: the ground is never one sheet
  float tus = nz(vW.xz / 152.0 + 0.11).g;
  float hol = nz(vW.xz / 620.0 + 0.4).r;
  float tk = smoothstep(0.42, 0.82, tus) * (1.0 - smoothstep(3500.0, 9000.0, vDist));
  col = mix(col, mix(sGrassB, sDry, 0.45) * 1.06, tk * 0.5 * lush);
  col *= mix(1.0, 0.7, smoothstep(0.52, 0.36, hol) * lush);
  // a pale belt of standing reed along the water
  float reed = smoothstep(0.35, 0.8, vW.y) * (1.0 - smoothstep(1.2, 2.6 + 1.6 * hol, vW.y)) * lush;
  col = mix(col, sDry * (0.9 + 0.35 * tus), reed * 0.62);
  if (sStrata > 0.0) {
    // wind-laid sand: long ripples, gravel lag, desert varnish
    vec2 wd0 = normalize(uWind + vec2(1e-4));
    float rip = sin(dot(vW.xz, wd0) * 0.55 + nz(vW.xz / 97.0).r * 14.0) * 0.5 + 0.5;
    float big = sin(dot(vW.xz, wd0) * 0.047 + nz(vW.xz / 420.0).r * 9.0) * 0.5 + 0.5;
    float lag = smoothstep(0.5, 0.72, nz(vW.xz / 240.0 + 0.7).r + (tus - 0.5) * 0.3);
    col *= 0.9 + 0.12 * rip * near + 0.1 * big;
    col = mix(col, mix(sRockA, sMud, 0.35) * (0.75 + 0.5 * tus), lag * 0.6 * (1.0 - lush));
    col = mix(col, sSnow, smoothstep(0.66, 0.8, nz(vW.xz / 510.0 + 0.2).r) * 0.3 * (1.0 - lush));
    N = normalize(N + vec3(wd0.x, 0.0, wd0.y) * (rip - 0.5) * 0.22 * near + vec3(wd0.x, 0.0, wd0.y) * (big - 0.5) * 0.16 * mid);
  }
  // at your feet: blades, litter, grit
  float close = 1.0 - smoothstep(14.0, 70.0, vDist);
  if (close > 0.0) {
    float f1 = tri(vW, tw, 1.0 / 2.6).b, f2 = tri(vW + 5.0, tw, 1.0 / 0.9).b;
    col *= mix(1.0, 0.55 + 0.6 * f1 + 0.34 * f2, close);
    N = normalize(N + vec3(f1 - 0.5, 0.0, f2 - 0.5) * 0.5 * close);
  }
  // beyond the planted shrubs, the land keeps its freckles
  float frk = smoothstep(0.80, 0.9, nz(vW.xz / 310.0 + 0.23).g * 0.6 + nz(vW.xz / 143.0).g * 0.4) * smoothstep(160.0, 700.0, vDist) * (1.0 - smoothstep(5200.0, 9000.0, vDist));
  col = mix(col, mix(sForestA, sGrassA, 0.35) * 0.55, frk * (0.75 - 0.5 * mk.b));
  col *= dabMul;

  // forest floor near, canopy far
  float crown = nz(vW.xz / 210.0).g;
  float crown2 = nz(vW.xz / 93.0 + 0.5).g;
  float kind = sat(m2 * 2.2 - 0.6 + (nz(vW.xz / 61.0).r - 0.5) * 1.6);
  vec3 can = mix(sForestA, sForestB, smoothstep(0.35, 0.65, kind));
  can = mix(can, sForestC, smoothstep(0.62, 0.8, nz(vW.xz / 38.0 + 0.2).r * 0.6 + m1 * 0.5));
  float canShade = mix(0.3, 0.92, smoothstep(0.4, 0.86, crown * 0.55 + crown2 * 0.45));
  // from far off a wood is a weave of its own colours, never a flat wash
  float weave = nz(vW.xz / 331.0 + 0.6).g;
  can = mix(can, sForestA, 0.35 * smoothstep(0.5, 0.8, weave));
  can = mix(can, sForestC, 0.4 * smoothstep(0.45, 0.2, weave));
  can *= mix(1.0, 0.84, smoothstep(600.0, 2500.0, vDist));
  vec3 floorC = mix(col, can * 0.5, 0.6);
  float isF = smoothstep(0.12, 0.5, mk.r);
  vec3 fcol = mix(floorC, can * canShade, vCan > 0.0 ? smoothstep(0.0, 0.35, vCan) : 0.0);
  col = mix(col, fcol, isF);
  if (vCan > 0.0 && mid > 0.0) {
    float c0 = crown;
    float cx = nz((vW.xz + vec2(3.0, 0.0)) / 210.0).g - c0;
    float cz = nz((vW.xz + vec2(0.0, 3.0)) / 210.0).g - c0;
    N = normalize(N + vec3(-cx, 0.0, -cz) * 2.6 * isF * vCan);
  }

  // stone
  float rk = sat(mk.b + (dab - 0.5) * 0.35);
  rk = smoothstep(0.25, 0.75, rk);
  vec3 rock = mix(sRockA, sRockB, sat(b1.r * 1.3 - 0.1 + (m3 - 0.5) * 0.8));
  rock *= 0.68 + 0.64 * b2.b * near + 0.64 * b1.b * (1.0 - near);
  if (sStrata > 0.0) {
    float wob = (nz(vW.xz / 620.0).r - 0.5) * 26.0 + (m3 - 0.5) * 5.0;
    float yy = vW.y + wob;
    float band = nz(vec2(yy / 210.0, 0.31)).r;
    float fine = nz(vec2(yy / 37.0, 0.77)).r;
    vec3 sc = mix(sRockA, sRockB, smoothstep(0.35, 0.65, band));
    sc = mix(sc, sSnow, smoothstep(0.62, 0.72, fine) * 0.55);
    sc = mix(sc, sMud, smoothstep(0.4, 0.3, fine) * 0.4);
    sc *= 0.72 + 0.5 * b1.b;
    rock = mix(rock, sc, sStrata);
    // dust lies on every ledge
    col = mix(col, mix(sSand, sDry, m2) * dabMul, (1.0 - lush) * 0.85);
  }
  col = mix(col, rock, rk * (1.0 - isF * 0.6));

  // shore: sand, mud, and a dark wet lip
  float sh = vW.y + (m3 - 0.5) * 0.7 + (dab - 0.5) * 0.35;
  float marsh = (uLand == 0.0 || uLand == 5.0) ? 1.0 : 0.0;
  float sandy = (1.0 - smoothstep(mix(0.5, 0.2, marsh), mix(2.0, 0.75, marsh), sh)) * (1.0 - rk * 0.7);
  col = mix(col, mix(sMud, sSand, smoothstep(-0.2, 1.0, sh)) * (0.85 + 0.3 * dab), sandy);
  float wet = 1.0 - smoothstep(0.02, 0.55, sh);
  col *= mix(1.0, 0.55, wet);

  // snow
  float snow = 0.0;
  if (uLand == 2.0) {
    snow = smoothstep(0.32, 0.62, mk.a + (dab - 0.5) * 0.35 + curv * 0.12);
    vec3 sn = sSnow * (0.93 + 0.09 * dab);
    col = mix(col, sn, snow);
    N = normalize(mix(N, gN, snow * 0.65));
  }

  // --- light ---------------------------------------------------------------
  float sha = keyShadow(vW, 0.0012) * birdShadow(vW);
  ao *= mix(1.0, 0.72 + 0.28 * smoothstep(-0.4, 0.35, -curv), 0.6);
  // under the trees it is dim
  ao *= 1.0 - 0.35 * isF * (1.0 - smoothstep(0.0, 0.4, vCan)) * (1.0 - smoothstep(300.0, 1200.0, vDist));
  float wrap = mix(0.12, 0.34, isF);
  vec3 c = litSurface(col, N, V, ao, sha, wrap);

  // grass and canopy glow when the sun is behind them
  float soft = max(lush * (1.0 - rk), isF) * (1.0 - snow) * (1.0 - sandy);
  float back = pow(sat(dot(-V, uKeyDir) * 0.5 + 0.5), 3.0);
  c += col * uKeyCol * back * soft * sha * 0.55 * sat(0.4 + dot(gN, uKeyDir) * 0.6 + 0.2);

  // wind crossing a field, seen from far above
  if (sSheen > 0.0) {
    vec2 wd = normalize(uWind + vec2(1e-4));
    vec2 q = vW.xz - uWind * uTime * 1.7;
    float g = nz(vec2(dot(q, wd) / 190.0, dot(q, vec2(-wd.y, wd.x)) / 1500.0)).r;
    g = smoothstep(0.5, 0.8, g) * (0.55 + 0.9 * nz(q / 61.0).b);
    float gz = pow(1.0 - sat(dot(V, gN)), 2.0);
    c += (uKeyCol * 0.5 * sha + uAmbSky * 0.5) * mix(col, vec3(lum(col)) * 1.6, 0.35) * g * sSheen * lush * (1.0 - rk) * (1.0 - sandy) * (1.0 - snow) * (0.16 + 0.5 * gz) * (1.0 - smoothstep(1800.0, 5000.0, vDist));
  }

  // damp ground and snow catch the light
  vec3 H = normalize(V + uKeyDir);
  float spec = pow(sat(dot(N, H)), 60.0) * wet * 0.5 + pow(sat(dot(N, H)), 24.0) * snow * 0.35;
  c += uKeyCol * spec * sha;
  if (snow > 0.0 && near > 0.0) {
    float gl = step(0.985, nz(vW.xz / 1.7 + floor(V.xz * 24.0) * 0.013).a) * near;
    c += uKeyCol * gl * snow * sha * 0.8 * sat(dot(N, uKeyDir));
  }
  o = vec4(c, 1.0);
}
`;
