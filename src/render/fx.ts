import * as THREE from 'three';
import { FULL } from './glsl/common';
import { VIEWRAY } from './glsl/passes';
import { G, Uniforms, worldMaterial } from './globals';
import type { Thermal } from '../sim/air';
import { makeRng } from '../world/noise';

const SOFT = /* glsl */ `
${VIEWRAY}
uniform sampler2D tDepth;
float softDepth(float range){
  float z = texture(tDepth, gl_FragCoord.xy / uRes).r;
  float oz = z >= 0.9999999 ? 1e6 : linZ(z);
  float my = 1.0 / gl_FragCoord.w;
  return sat((oz - my) / range);
}
`;

function quad(): { pos: THREE.BufferAttribute; idx: THREE.BufferAttribute } {
  return {
    pos: new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3),
    idx: new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1),
  };
}

const KIND: Record<string, number> = { pollen: 0, leaves: 1, snow: 2, dust: 3, spray: 4, down: 5 };

/** Everything drawn in the air itself. */
export class Fx {
  readonly group = new THREE.Group();
  private readonly motes: THREE.Mesh;
  private readonly moteU: Uniforms;
  private readonly thermal: THREE.Mesh;
  private readonly thU: Uniforms;
  private readonly ribbons: THREE.Mesh;
  private readonly ribU: Uniforms;
  private readonly feathers: THREE.Mesh;
  private readonly fBuf: THREE.InstancedBufferAttribute;
  private readonly call: THREE.Mesh;
  private readonly callU: Uniforms;
  private readonly trail: THREE.Mesh;
  private readonly trPos: Float32Array;
  private readonly trA: Float32Array;
  private trHead = 0;
  private trN = 0;
  private readonly sparks: THREE.Mesh;
  private readonly spA: THREE.InstancedBufferAttribute;
  private readonly spB: THREE.InstancedBufferAttribute;
  private spI = 0;
  /** 0..1: the call is lighting up the air */
  reveal = 0;

  constructor(scene: THREE.Scene, view: Uniforms, amount: number) {
    scene.add(this.group);
    const rng = makeRng(8);
    const blend = { transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide } as const;

    // --- drifting motes
    {
      const n = Math.round(720 * amount);
      const q = quad();
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', q.pos);
      g.setIndex(q.idx);
      const r = new Float32Array(n * 4);
      for (let i = 0; i < r.length; i++) r[i] = rng();
      g.setAttribute('iR', new THREE.InstancedBufferAttribute(r, 4));
      g.instanceCount = n;
      this.moteU = { ...view, mKind: { value: 0 }, mCol: { value: new THREE.Color() }, mAmt: { value: 1 }, mBox: { value: 46 } };
      this.motes = new THREE.Mesh(g, worldMaterial(MOTE_V, MOTE_F, this.moteU, blend));
      this.motes.frustumCulled = false;
      this.group.add(this.motes);
    }

    // --- thermal columns: spiralling light
    {
      const per = Math.round(230 * amount);
      const n = per * 5;
      const q = quad();
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', q.pos);
      g.setIndex(q.idx);
      const r = new Float32Array(n * 4);
      const k = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < 4; c++) r[i * 4 + c] = rng();
        k[i] = i % 5;
      }
      g.setAttribute('iR', new THREE.InstancedBufferAttribute(r, 4));
      g.setAttribute('iK', new THREE.InstancedBufferAttribute(k, 1));
      g.instanceCount = n;
      this.thU = {
        ...view,
        tA: { value: [0, 1, 2, 3, 4].map(() => new THREE.Vector4()) }, // x ground z radius
        tB: { value: [0, 1, 2, 3, 4].map(() => new THREE.Vector4()) }, // top strength
        uVigor: { value: 1 },
        uReveal: { value: 0 },
        mCol: this.moteU.mCol,
      };
      this.thermal = new THREE.Mesh(g, worldMaterial(THERM_V, THERM_F, this.thU, { ...blend, blending: THREE.AdditiveBlending }));
      this.thermal.frustumCulled = false;
      this.group.add(this.thermal);
    }

    // --- and their helices: warm air drawn as slow turning brushstrokes
    {
      const seg = 90;
      const pos: number[] = [];
      const idx: number[] = [];
      for (let i = 0; i <= seg; i++) pos.push(-1, i / seg, 0, 1, i / seg, 0);
      for (let i = 0; i < seg; i++) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      const n = 5 * 4;
      const k = new Float32Array(n * 2);
      for (let i = 0; i < n; i++) {
        k[i * 2] = i % 5;
        k[i * 2 + 1] = Math.floor(i / 5);
      }
      g.setAttribute('iK', new THREE.InstancedBufferAttribute(k, 2));
      g.instanceCount = n;
      const m = new THREE.Mesh(g, worldMaterial(HELIX_V, HELIX_F, this.thU, { ...blend, blending: THREE.AdditiveBlending }));
      m.frustumCulled = false;
      this.group.add(m);
    }

    // --- wind, drawn as a few long unhurried strokes
    {
      const n = Math.round(46 * amount);
      const seg = 28;
      const pos: number[] = [];
      const idx: number[] = [];
      for (let i = 0; i <= seg; i++) pos.push(-1, i / seg, 0, 1, i / seg, 0);
      for (let i = 0; i < seg; i++) {
        const a = i * 2;
        idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      const r = new Float32Array(n * 4);
      for (let i = 0; i < r.length; i++) r[i] = rng();
      g.setAttribute('iR', new THREE.InstancedBufferAttribute(r, 4));
      g.instanceCount = n;
      this.ribU = { ...view, uReveal: this.thU.uReveal };
      this.ribbons = new THREE.Mesh(g, worldMaterial(RIB_V, RIB_F, this.ribU, blend));
      this.ribbons.frustumCulled = false;
      this.group.add(this.ribbons);
    }

    // --- the flock's dropped feathers
    {
      const n = 160;
      const pos: number[] = [];
      const idx: number[] = [];
      const seg = 8;
      for (let i = 0; i <= seg; i++) pos.push(-1, i / seg, 0, 0, i / seg, 0, 1, i / seg, 0);
      for (let i = 0; i < seg; i++)
        for (let j = 0; j < 2; j++) {
          const a = i * 3 + j;
          idx.push(a, a + 1, a + 3, a + 1, a + 4, a + 3);
        }
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      this.fBuf = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
      this.fBuf.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('iA', this.fBuf);
      g.instanceCount = 0;
      this.feathers = new THREE.Mesh(g, worldMaterial(FEA_V, FEA_F, { ...view }, blend));
      this.feathers.frustumCulled = false;
      this.group.add(this.feathers);
      // a halo behind each, so they read at a distance
      const q = quad();
      const gh = new THREE.InstancedBufferGeometry();
      gh.setAttribute('position', q.pos);
      gh.setIndex(q.idx);
      gh.setAttribute('iA', this.fBuf);
      gh.instanceCount = 0;
      const halo = new THREE.Mesh(gh, worldMaterial(HALO_V, HALO_F, { ...view }, { ...blend, blending: THREE.AdditiveBlending }));
      halo.frustumCulled = false;
      this.feathers.add(halo);
    }

    // --- the call
    this.callU = { ...view, cA: { value: new THREE.Vector4(0, 0, 0, -100) }, cP: { value: 0 } };
    this.call = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 32), worldMaterial(CALL_V, CALL_F, this.callU, { ...blend, blending: THREE.AdditiveBlending, depthTest: false }));
    this.call.frustumCulled = false;
    this.group.add(this.call);

    // --- wingtip threads
    {
      const N = 64;
      this.trPos = new Float32Array(N * 2 * 2 * 3);
      this.trA = new Float32Array(N * 2 * 2 * 2);
      const idx: number[] = [];
      for (let w = 0; w < 2; w++)
        for (let i = 0; i < N - 1; i++) {
          const a = w * N * 2 + i * 2;
          idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(this.trPos, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('aA', new THREE.BufferAttribute(this.trA, 2).setUsage(THREE.DynamicDrawUsage));
      g.setIndex(idx);
      this.trail = new THREE.Mesh(g, worldMaterial(TR_V, TR_F, { ...view }, blend));
      this.trail.frustumCulled = false;
      this.group.add(this.trail);
    }

    // --- spray, sparks, shed down
    {
      const n = 260;
      const q = quad();
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', q.pos);
      g.setIndex(q.idx);
      this.spA = new THREE.InstancedBufferAttribute(new Float32Array(n * 4).fill(-999), 4);
      this.spB = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
      g.setAttribute('iA', this.spA);
      g.setAttribute('iB', this.spB);
      g.instanceCount = n;
      this.sparks = new THREE.Mesh(g, worldMaterial(SP_V, SP_F, { ...view }, blend));
      this.sparks.frustumCulled = false;
      this.group.add(this.sparks);
    }
  }

  setMotes(kind: string, color: string, amount: number): void {
    this.moteU.mKind.value = KIND[kind] ?? 0;
    (this.moteU.mCol.value as THREE.Color).set(color);
    this.moteU.mAmt.value = amount;
  }

  /** feathers as [x,y,z,alpha]* */
  setFeathers(data: Float32Array, n: number): void {
    (this.fBuf.array as Float32Array).set(data.subarray(0, n * 4));
    this.fBuf.needsUpdate = true;
    (this.feathers.geometry as THREE.InstancedBufferGeometry).instanceCount = n;
    ((this.feathers.children[0] as THREE.Mesh).geometry as THREE.InstancedBufferGeometry).instanceCount = n;
  }

  sendCall(x: number, y: number, z: number): void {
    (this.callU.cA.value as THREE.Vector4).set(x, y, z, G.uTime.value);
    this.reveal = 1;
  }

  /** kind 0 water spray, 1 golden spark, 2 down */
  spark(x: number, y: number, z: number, vx: number, vy: number, vz: number, kind: number): void {
    const n = this.spA.count;
    const i = this.spI++ % n;
    (this.spA.array as Float32Array).set([x, y, z, G.uTime.value], i * 4);
    (this.spB.array as Float32Array).set([vx, vy, vz, kind], i * 4);
    this.spA.needsUpdate = true;
    this.spB.needsUpdate = true;
  }

  /** wingtip threads: positions of left/right tips and how strongly to mark */
  tips(l: THREE.Vector3, r: THREE.Vector3, amt: number, cam: THREE.Vector3): void {
    const N = 64;
    // shift history (small; cheap enough)
    for (let w = 0; w < 2; w++) {
      const o = w * N * 2;
      this.trPos.copyWithin((o + 2) * 3, o * 3, (o + N * 2 - 2) * 3);
      this.trA.copyWithin((o + 2) * 2, o * 2, (o + N * 2 - 2) * 2);
      const p = w === 0 ? l : r;
      const dx = cam.x - p.x;
      const dz = cam.z - p.z;
      const len = Math.hypot(dx, dz) || 1;
      const ox = (dz / len) * 0.03;
      const oz = (-dx / len) * 0.03;
      for (let s = 0; s < 2; s++) {
        const k = (o + s) * 3;
        const sg = s === 0 ? -1 : 1;
        this.trPos[k] = p.x + ox * sg;
        this.trPos[k + 1] = p.y + 0.03 * sg;
        this.trPos[k + 2] = p.z + oz * sg;
        this.trA[(o + s) * 2] = amt;
        this.trA[(o + s) * 2 + 1] = sg;
      }
      for (let i = 0; i < N; i++) {
        const f = 1 - i / (N - 1);
        // fade by position in the buffer is done in-shader via vertex id
        void f;
      }
    }
    this.trHead = (this.trHead + 1) % N;
    this.trN = Math.min(N, this.trN + 1);
    this.trail.geometry.attributes.position.needsUpdate = true;
    this.trail.geometry.attributes.aA.needsUpdate = true;
    this.trail.geometry.setDrawRange(0, Infinity);
  }

  resetTrail(p: THREE.Vector3): void {
    for (let i = 0; i < this.trPos.length; i += 3) {
      this.trPos[i] = p.x;
      this.trPos[i + 1] = p.y;
      this.trPos[i + 2] = p.z;
    }
    this.trA.fill(0);
  }

  update(dt: number, thermals: Thermal[], vigor: number, pos: { x: number; z: number }): void {
    this.reveal = Math.max(0, this.reveal - dt / 9);
    this.thU.uReveal.value = this.reveal * this.reveal * (3 - 2 * this.reveal);
    this.thU.uVigor.value = vigor;
    const s = [...thermals].sort((a, b) => (a.x - pos.x) ** 2 + (a.z - pos.z) ** 2 - ((b.x - pos.x) ** 2 + (b.z - pos.z) ** 2));
    for (let i = 0; i < 5; i++) {
      const t = s[i];
      const a = (this.thU.tA.value as THREE.Vector4[])[i];
      const b = (this.thU.tB.value as THREE.Vector4[])[i];
      if (t) {
        a.set(t.x, t.ground, t.z, t.radius);
        b.set(t.top, t.strength, 1, 0);
      } else b.set(0, 0, 0, 0);
    }
    this.call.visible = G.uTime.value - (this.callU.cA.value as THREE.Vector4).w < 4;
  }
}

const MOTE_V = /* glsl */ `
${FULL}
in vec4 iR;
uniform float mKind, mAmt, mBox;
out vec2 vQ; out float vA; out vec3 vW; out float vR;
void main(){
  float b = mBox;
  vec3 vel = vec3(uWind.x, 0.0, uWind.y) * 0.55;
  vel.y = mKind == 2.0 ? -1.4 : mKind == 1.0 ? -0.9 : mKind == 5.0 ? -0.25 : 0.12;
  vec3 p = iR.xyz * 2.0 * b + vel * uTime * (0.7 + 0.6 * iR.w);
  p += vec3(sin(uTime * 0.7 + iR.x * 40.0), sin(uTime * 0.9 + iR.y * 40.0) * 0.6, cos(uTime * 0.6 + iR.z * 40.0)) * (mKind == 1.0 ? 1.6 : 0.7);
  p = mod(p - uCamPos + b, 2.0 * b) - b;
  float d = length(p);
  vec3 c = uCamPos + p;
  float g = max(terrainH(c.xz), 0.0);
  float alive = step(iR.w, mAmt * (mKind == 4.0 ? smoothstep(40.0, 6.0, c.y) : mKind == 1.0 || mKind == 3.0 ? smoothstep(170.0, 30.0, c.y - g) : 1.0)) * step(g, c.y);
  vA = smoothstep(b, b * 0.55, d) * smoothstep(1.5, 4.5, d) * alive;
  float s = mKind == 1.0 ? 0.13 + 0.09 * iR.w : mKind == 2.0 ? 0.035 + 0.03 * iR.w : mKind == 5.0 ? 0.05 + 0.04 * iR.w : 0.026 + 0.02 * iR.w;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec2 q = position.xy;
  if (mKind == 1.0 || mKind == 5.0){ float a = uTime * (1.2 + iR.x) + iR.y * 30.0; float ca = cos(a), sa = sin(a); q = mat2(ca, -sa, sa, ca) * (q * vec2(1.0, 0.35 + 0.65 * abs(sin(uTime * 1.7 + iR.z * 20.0)))); }
  vW = c + (right * q.x + up * q.y) * s;
  vQ = position.xy; vR = iR.w;
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}
`;
const MOTE_F = /* glsl */ `
${FULL}
${SOFT}
in vec2 vQ; in float vA; in vec3 vW; in float vR;
uniform float mKind; uniform vec3 mCol;
layout(location = 0) out vec4 o;
void main(){
  if (vA < 0.01) discard;
  float r = length(vQ);
  float a = mKind == 1.0 ? smoothstep(1.0, 0.75, length(vQ * vec2(1.0, 1.9)) ) : mKind == 5.0 ? smoothstep(1.0, 0.2, length(vQ * vec2(1.0, 2.4))) * 0.8 : smoothstep(1.0, 0.1, r);
  vec3 d = normalize(vW - uCamPos);
  float back = pow(sat(dot(d, uKeyDir)), 4.0);
  vec3 L = uKeyCol * (0.35 + 1.5 * back) + uAmbSky * 0.8;
  vec3 c = mCol * L * (mKind == 1.0 ? mix(vec3(1.0), vec3(0.7, 0.4, 0.3), vR) : vec3(1.0));
  float A = a * vA * softDepth(1.0) * (mKind == 1.0 ? 1.0 : mKind == 2.0 ? 0.8 : 0.2 + 0.55 * back);
  o = vec4(c, A);
}
`;

const THERM_V = /* glsl */ `
${FULL}
in vec4 iR; in float iK;
uniform vec4 tA[5]; uniform vec4 tB[5];
uniform float uVigor, uReveal;
out vec2 vQ; out float vA; out vec3 vW;
void main(){
  int k = int(iK + 0.5);
  vec4 A = tA[k], B = tB[k];
  float H = B.x - A.y;
  float u = fract(iR.x + uTime * (0.016 + 0.02 * iR.y));
  float y = A.y + u * H * 0.96;
  float rr = A.w * (0.16 + 0.75 * iR.z) * (0.72 + 0.4 * u);
  float a = iR.w * 6.283 + uTime * (0.16 + 0.22 * (1.0 - iR.z)) + u * 5.0;
  vec3 c = vec3(A.x + cos(a) * rr, y, A.z + sin(a) * rr);
  float d = length(c - uCamPos);
  vA = B.z * uVigor * smoothstep(0.0, 0.06, u) * smoothstep(1.0, 0.8, u) * smoothstep(2.0, 8.0, d) * (0.3 + 0.7 * smoothstep(1600.0, 300.0, d));
  vA *= 0.55 + 2.4 * uReveal;
  float s = (0.09 + 0.07 * iR.y) * (1.0 + d / 150.0) * (1.0 + 0.6 * uReveal);
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vW = c + (right * position.x + up * position.y) * s;
  vQ = position.xy;
  gl_Position = B.z < 0.5 ? vec4(0.0, 0.0, 2.0, 1.0) : projectionMatrix * viewMatrix * vec4(vW, 1.0);
}
`;
const THERM_F = /* glsl */ `
${FULL}
${SOFT}
in vec2 vQ; in float vA; in vec3 vW;
uniform vec3 mCol; uniform float uReveal;
layout(location = 0) out vec4 o;
void main(){
  float a = smoothstep(1.0, 0.0, length(vQ)); a *= a;
  vec3 T = fogT(uCamPos, vW);
  vec3 c = mix(uKeyCol * 0.5 + uAmbSky * 0.35, vec3(1.0, 0.85, 0.55) * (0.4 + lum(uKeyCol) * 0.4), 0.55) * mix(vec3(1.0), mCol, 0.4);
  o = vec4(c * T * a * vA * softDepth(1.5) * 0.85, 1.0);
}
`;

const HELIX_V = /* glsl */ `
${FULL}
in vec2 iK;
uniform vec4 tA[5]; uniform vec4 tB[5];
uniform float uVigor, uReveal;
out float vA; out float vS; out vec3 vW; out float vU;
vec3 helix(vec4 A, vec4 B, float u, float s){
  float H = (B.x - A.y) * 0.92;
  float rr = A.w * (0.34 + 0.1 * s) * (0.62 + 0.55 * u) * (1.0 + 0.10 * sin(u * 9.0 + s * 2.0 + uTime * 0.2));
  float a = s * 1.571 + u * 7.4 + uTime * 0.16;
  return vec3(A.x + cos(a) * rr, A.y + 6.0 + u * H, A.z + sin(a) * rr);
}
void main(){
  int k = int(iK.x + 0.5);
  vec4 A = tA[k], B = tB[k];
  float u = position.y;
  vec3 p = helix(A, B, u, iK.y), p2 = helix(A, B, u + 0.01, iK.y);
  vec3 tan = normalize(p2 - p);
  vec3 side = normalize(cross(tan, uCamPos - p));
  float d = length(p - uCamPos);
  // a stroke that swells and thins as it climbs
  float flow = fract(u * 1.6 - uTime * 0.045 + iK.y * 0.27 + iK.x * 0.13);
  float st = smoothstep(0.0, 0.35, flow) * smoothstep(1.0, 0.45, flow);
  float w = (0.55 + 0.0042 * d) * (0.3 + 0.9 * st);
  p += side * position.x * w;
  vA = B.z * uVigor * st * smoothstep(0.0, 0.05, u) * smoothstep(1.0, 0.72, u) * smoothstep(26.0, 130.0, d) * smoothstep(2600.0, 900.0, d);
  vA *= 0.27 + 0.78 * uReveal;
  vS = position.x; vW = p; vU = u;
  gl_Position = B.z < 0.5 ? vec4(0.0, 0.0, 2.0, 1.0) : projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;
const HELIX_F = /* glsl */ `
${FULL}
${SOFT}
in float vA; in float vS; in vec3 vW; in float vU;
uniform vec3 mCol;
layout(location = 0) out vec4 o;
void main(){
  float e = 1.0 - vS * vS;
  float br = 0.6 + 0.8 * nz(vec2(vS * 0.16, vU * 5.0)).b;
  vec3 T = fogT(uCamPos, vW);
  vec3 c = uWarm * 0.45 + uKeyCol * 0.3 + uAmbSky * 0.25 + vec3(0.10, 0.075, 0.04);
  o = vec4(c * T * e * br * vA * softDepth(6.0), 1.0);
}
`;

const RIB_V = /* glsl */ `
${FULL}
in vec4 iR;
uniform float uReveal;
out float vA; out float vS; out vec3 vW;
vec3 flow(vec3 b, float s, vec2 wd){
  vec2 pd = vec2(-wd.y, wd.x);
  vec3 p = b + vec3(wd.x, 0.0, wd.y) * s;
  float w = s * 0.045 + iR.w * 20.0;
  p.xz += pd * (sin(w) * 6.0 + sin(w * 2.3 + 1.0) * 2.2);
  p.y += sin(w * 0.8 + 2.0) * 3.4 + sin(w * 2.9) * 0.8;
  return p;
}
void main(){
  float b = 130.0;
  vec2 wd = normalize(uWind + vec2(1e-4));
  float ws = length(uWind);
  float life = 5.5 + 3.0 * iR.w;
  float T = uTime / life + iR.x * 7.0;
  float id = floor(T), f = fract(T);
  vec3 r = vec3(hash12(vec2(id, iR.x * 91.0)), hash12(vec2(id + 3.0, iR.y * 91.0)), hash12(vec2(id + 7.0, iR.z * 91.0)));
  vec3 base = (r * 2.0 - 1.0) * vec3(b, 34.0, b);
  // keep to the world, not the camera: snap the box in big steps
  vec3 cc = floor(uCamPos / 60.0) * 60.0;
  vec3 p0 = cc + base + vec3(wd.x, 0.0, wd.y) * 20.0;
  float g = max(terrainH(p0.xz), 0.0);
  p0.y = max(p0.y, g + 3.0);
  float len = 34.0 + 22.0 * iR.y;
  float head = f * (40.0 + ws * 7.0);
  float s = head - position.y * len * smoothstep(0.0, 0.35, f);
  vec3 p = flow(p0, s, wd);
  vec3 p2 = flow(p0, s + 0.6, wd);
  vec3 tan = normalize(p2 - p);
  vec3 side = normalize(cross(tan, uCamPos - p));
  float d = length(p - uCamPos);
  float wdt = (0.07 + 0.0024 * d) * sin(3.14159 * sat(position.y * 0.98 + 0.01));
  p += side * position.x * wdt;
  vA = sin(3.14159 * f) * sin(3.14159 * position.y) * smoothstep(8.0, 22.0, d) * smoothstep(170.0, 90.0, d) * smoothstep(1.0, 5.0, ws);
  vA *= 0.045 + 0.2 * uReveal;
  vS = position.x; vW = p;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;
const RIB_F = /* glsl */ `
${FULL}
${SOFT}
in float vA; in float vS; in vec3 vW;
layout(location = 0) out vec4 o;
void main(){
  float a = vA * (1.0 - vS * vS) * softDepth(2.0);
  vec3 c = uHorizon * 0.75 + uKeyCol * 0.35 + uAmbSky * 0.5;
  o = vec4(c, a);
}
`;

const FEA_V = /* glsl */ `
${FULL}
in vec4 iA;
out vec2 vQ; out float vA; out vec3 vW; out vec3 vN;
void main(){
  vec3 c = iA.xyz;
  float id = fract(iA.x * 0.137 + iA.z * 0.091);
  float t = uTime * 0.55 + id * 30.0;
  c.y += sin(t * 1.3) * 0.35;
  c.xz += vec2(sin(t), cos(t * 0.8)) * 0.35;
  float rx = sin(t * 0.9) * 0.6 + 0.35, rz = cos(t * 0.7) * 0.5, ry = t * 0.5;
  float x = position.x, y = position.y - 0.5;
  float w = 0.17 * sqrt(max(0.0, 1.0 - pow(abs(position.y * 2.0 - 1.0), 2.4))) * (position.y < 0.12 ? position.y / 0.12 : 1.0);
  vec3 p = vec3(x * w, y * 1.5, (1.0 - x * x) * 0.04 + y * y * 0.35);
  mat3 X = mat3(1,0,0, 0,cos(rx),sin(rx), 0,-sin(rx),cos(rx));
  mat3 Z = mat3(cos(rz),sin(rz),0, -sin(rz),cos(rz),0, 0,0,1);
  mat3 Y = mat3(cos(ry),0,-sin(ry), 0,1,0, sin(ry),0,cos(ry));
  mat3 M = Y * X * Z;
  float d = length(c - uCamPos);
  vec3 wp = c + M * p * (1.0 + d / 220.0) * 1.35;
  vN = M * vec3(x * 0.4, 0.0, 1.0);
  vW = wp; vQ = vec2(x, position.y); vA = iA.w * smoothstep(900.0, 620.0, d);
  gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
}
`;
const FEA_F = /* glsl */ `
${FULL}
${SOFT}
in vec2 vQ; in float vA; in vec3 vW; in vec3 vN;
layout(location = 0) out vec4 o;
void main(){
  if (vA < 0.01) discard;
  vec3 N = normalize(vN); vec3 V = normalize(uCamPos - vW);
  if (dot(N, V) < 0.0) N = -N;
  float nl = sat(dot(N, uKeyDir) * 0.5 + 0.5);
  vec3 col = vec3(0.95, 0.94, 0.92) * (1.0 - 0.15 * exp(-vQ.x * vQ.x * 90.0));
  vec3 c = col * (uKeyCol * nl + uAmbSky * 1.1) + uWarm * 0.2 + vec3(0.12);
  float thru = pow(sat(dot(-V, uKeyDir) * 0.5 + 0.5), 4.0);
  c += uKeyCol * thru * 0.8;
  o = vec4(mix(c, airColor(-V), 1.0 - fogT(uCamPos, vW).g), vA * softDepth(0.5) * 0.95);
}
`;
const HALO_V = /* glsl */ `
${FULL}
in vec4 iA;
out vec2 vQ; out float vA; out vec3 vW;
void main(){
  vec3 c = iA.xyz;
  float id = fract(iA.x * 0.137 + iA.z * 0.091);
  float t = uTime * 0.55 + id * 30.0;
  c.y += sin(t * 1.3) * 0.35;
  c.xz += vec2(sin(t), cos(t * 0.8)) * 0.35;
  float d = length(c - uCamPos);
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  float s = 1.25 * (1.0 + d / 110.0);
  vW = c + (right * position.x + up * position.y) * s;
  vQ = position.xy;
  vA = iA.w * smoothstep(1500.0, 900.0, d) * (0.75 + 0.25 * sin(t * 2.0));
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}
`;
const HALO_F = /* glsl */ `
${FULL}
${SOFT}
in vec2 vQ; in float vA; in vec3 vW;
layout(location = 0) out vec4 o;
void main(){
  float r = length(vQ);
  float a = exp(-r * r * 5.0) * smoothstep(1.0, 0.6, r) + 0.6 * exp(-r * r * 60.0);
  vec3 c = (uWarm * 0.7 + uKeyCol * 0.22 + uAmbSky * 0.25 + 0.04);
  o = vec4(c * a * vA * 0.5 * softDepth(2.0), 1.0);
}
`;

const CALL_V = /* glsl */ `
${FULL}
uniform vec4 cA;
out vec3 vN; out vec3 vW; out float vT;
void main(){
  float t = uTime - cA.w;
  vT = t / 4.0;
  float R = 6.0 + 260.0 * (1.0 - exp(-t * 0.9));
  vW = cA.xyz + position * R;
  vN = position;
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}
`;
const CALL_F = /* glsl */ `
${FULL}
${SOFT}
in vec3 vN; in vec3 vW; in float vT;
layout(location = 0) out vec4 o;
void main(){
  vec3 V = normalize(uCamPos - vW);
  float f = 1.0 - abs(dot(normalize(vN), V));
  float rim = pow(f, 7.0) + 0.16 * pow(f, 2.0);
  float bands = 0.6 + 0.4 * sin(f * 60.0 - uTime * 3.0);
  // brighten where the ripple meets the land
  float z = texture(tDepth, gl_FragCoord.xy / uRes).r;
  float oz = z >= 0.9999999 ? 1e6 : linZ(z);
  float my = 1.0 / gl_FragCoord.w;
  float hit = exp(-abs(oz - my) / (3.0 + my * 0.03));
  float vis = step(my, oz + 6.0);
  // from inside, the shell is a faint brightening that sweeps the air
  float sheet = 0.035 * (0.6 + 0.4 * sin(vN.y * 26.0 + vN.x * 9.0 - uTime * 2.0));
  float a = (rim * bands * 0.4 + hit * 0.9 + sheet) * vis * pow(max(1.0 - vT, 0.0), 1.6) * smoothstep(0.0, 0.05, vT);
  vec3 c = uHorizon * 0.5 + uWarm * 0.45 + uKeyCol * 0.2;
  o = vec4(c * a, 1.0);
}
`;

const TR_V = /* glsl */ `
${FULL}
in vec2 aA;
out float vA; out float vS;
void main(){
  int row = (gl_VertexID / 2) % 64;
  float f = 1.0 - float(row) / 63.0;
  vA = aA.x * f * f; vS = aA.y;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}
`;
const TR_F = /* glsl */ `
${FULL}
${SOFT}
in float vA; in float vS;
layout(location = 0) out vec4 o;
void main(){
  vec3 c = uHorizon * 0.6 + uKeyCol * 0.5 + uAmbSky * 0.5;
  o = vec4(c, vA * (1.0 - vS * vS) * 0.5 * softDepth(0.3));
}
`;

const SP_V = /* glsl */ `
${FULL}
in vec4 iA; in vec4 iB;
out vec2 vQ; out float vA; out float vK; out vec3 vW;
void main(){
  float t = uTime - iA.w;
  float life = iB.w < 0.5 ? 1.1 : iB.w < 1.5 ? 2.2 : 5.0;
  float k = t / life;
  vK = iB.w;
  float grav = iB.w < 0.5 ? 6.0 : iB.w < 1.5 ? -0.4 : 0.35;
  float drag = iB.w < 0.5 ? 0.6 : 1.6;
  vec3 p = iA.xyz + iB.xyz * (1.0 - exp(-drag * t)) / drag - vec3(0.0, 0.5 * grav * t * t, 0.0);
  if (iB.w > 1.5) p += vec3(sin(t * 2.0 + iA.x), 0.0, cos(t * 1.7 + iA.z)) * 0.3 + vec3(uWind.x, 0.0, uWind.y) * t * 0.25;
  float s = iB.w < 0.5 ? 0.035 + 0.05 * k : iB.w < 1.5 ? 0.06 * (1.0 - k * 0.5) : 0.06;
  vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vW = p + (right * position.x + up * position.y) * s;
  vQ = position.xy;
  vA = (t < 0.0 || k > 1.0) ? 0.0 : (1.0 - k) * smoothstep(0.0, 0.05, k);
  gl_Position = vA <= 0.0 ? vec4(0.0, 0.0, 2.0, 1.0) : projectionMatrix * viewMatrix * vec4(vW, 1.0);
}
`;
const SP_F = /* glsl */ `
${FULL}
${SOFT}
in vec2 vQ; in float vA; in float vK; in vec3 vW;
layout(location = 0) out vec4 o;
void main(){
  float a = smoothstep(1.0, 0.2, length(vQ));
  vec3 d = normalize(vW - uCamPos);
  float back = pow(sat(dot(d, uKeyDir)), 4.0);
  vec3 c = vK < 0.5 ? (uKeyCol * (0.5 + 1.5 * back) + uAmbSky) * 0.9 : vK < 1.5 ? vec3(1.6, 1.25, 0.8) * (0.5 + lum(uHorizon)) : (uKeyCol * 0.6 + uAmbSky) * 0.95;
  o = vec4(c, a * vA * (vK < 0.5 ? 0.6 : 0.9) * softDepth(0.4));
}
`;
