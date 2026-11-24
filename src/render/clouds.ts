import * as THREE from 'three';
import { FULL } from './glsl/common';
import { VIEWRAY } from './glsl/passes';
import { G, Uniforms } from './globals';
import type { Engine } from './engine';
import { Pass } from './pass';
import { Noise, smoothstep } from '../world/noise';

/** One cloud in the weather: where, how wide, how tall, how soft. */
export interface Puff {
  x: number;
  z: number;
  r: number;
  /** stretch along x/z (defaults round) */
  sx?: number;
  sz?: number;
  rot?: number;
  /** 0..1 fraction of the slab it fills */
  tall: number;
  /** 0..1 coverage contribution */
  amt: number;
  /** 0 = billowing, 1 = silk-smooth (lenticular) */
  smooth?: number;
}

export interface WeatherSpec {
  base: number;
  top: number;
  density: number;
  /** background field coverage (0 = only puffs) and scale (m) */
  field: number;
  fieldScale: number;
  fieldTall: number;
  /** solid deck (cloud sea) */
  sea?: boolean;
  /** holes punched through the field/deck */
  holes?: Array<{ x: number; z: number; r: number }>;
  puffs: Puff[];
  seed: number;
  rain?: { x: number; z: number; r: number; amt: number };
}

const NOISE3D = /* glsl */ `
precision highp float;
in vec2 vUv;
uniform float uZ;
layout(location = 0) out vec4 o;
vec3 h3(vec3 p, float per){
  p = mod(p, per);
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453);
}
float worley(vec3 p, float per){
  p *= per;
  vec3 i = floor(p), f = fract(p);
  float d = 1e9;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec3 g = vec3(x, y, z);
    vec3 r = g + h3(i + g, per) - f;
    d = min(d, dot(r, r));
  }
  return 1.0 - clamp(sqrt(d), 0.0, 1.0);
}
float perlin(vec3 p, float per){
  p *= per;
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  #define GR(o) dot(h3(i + o, per) * 2.0 - 1.0, f - o)
  return mix(mix(mix(GR(vec3(0,0,0)), GR(vec3(1,0,0)), u.x), mix(GR(vec3(0,1,0)), GR(vec3(1,1,0)), u.x), u.y),
             mix(mix(GR(vec3(0,0,1)), GR(vec3(1,0,1)), u.x), mix(GR(vec3(0,1,1)), GR(vec3(1,1,1)), u.x), u.y), u.z);
}
void main(){
  vec3 p = vec3(vUv, uZ);
  float pf = 0.0, a = 0.6, per = 4.0;
  for (int i = 0; i < 4; i++){ pf += perlin(p, per) * a; per *= 2.0; a *= 0.5; }
  pf = clamp(pf * 0.9 + 0.5, 0.0, 1.0);
  float w1 = worley(p, 4.0), w2 = worley(p, 8.0), w3 = worley(p, 16.0);
  float wf = w1 * 0.625 + w2 * 0.25 + w3 * 0.125;
  float pw = clamp((pf - (wf - 1.0)) / (2.0 - wf) , 0.0, 1.0);
  pw = mix(pf, clamp(pf * 0.55 + wf * 0.6, 0.0, 1.0), 0.75);
  o = vec4(pw, w1, w2, w3);
}
`;

const MARCH = /* glsl */ `
${FULL}
${VIEWRAY}
in vec2 vUv;
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
uniform sampler2D tDepth;
uniform sampler3D uVol;
uniform float uFrame, uSteps, uMistSteps, uSea, uVolScale, uErode;
uniform vec4 uRain;       // x z r amt
uniform vec3 uFlash;

float remap(float v, float a, float b, float c, float d){ return c + (v - a) * (d - c) / max(b - a, 1e-4); }

float dens(vec3 p, bool cheap, out float hf){
  float b = uCloud.x, t = uCloud.y;
  hf = (p.y - b) / (t - b);
  if (hf <= 0.0 || hf >= 1.0) return 0.0;
  vec4 w = texture(uWeather, (p.xz + uCloudOff) / (2.0 * uWeatherHalf) + 0.5);
  float cov = w.r;
  if (cov < 0.02) return 0.0;
  float tall = max(w.g, 0.06);
  float hh = hf / tall;
  if (hh >= 1.0) return 0.0;
  float prof;
  if (uSea > 0.5) prof = smoothstep(0.0, 0.2, hh) * (1.0 - smoothstep(0.35, 1.0, hh));
  else prof = smoothstep(0.0, 0.11, hh) * (1.0 - smoothstep(0.35, 1.0, hh));
  vec3 q = p + vec3(uWind.x, -1.2, uWind.y) * uTime * 0.6;
  vec4 n = texture(uVol, q * uVolScale);
  float wf = n.g * 0.6 + n.b * 0.27 + n.a * 0.13;
  float bs = mix(n.r, 1.0, w.b * 0.85);
  float th = uSea > 0.5 ? 1.0 - cov : mix(0.96, 0.30, cov);
  float d = remap(bs * mix(1.0, prof, 0.85), th, 1.0, 0.0, 1.0) * smoothstep(0.0, 0.12, prof);
  if (d <= 0.0) return 0.0;
  if (!cheap){
    vec4 e = texture(uVol, q * uVolScale * 4.7 + vec3(0.0, uTime * 0.0012, 0.0));
    float ef = e.g * 0.55 + e.b * 0.3 + e.a * 0.15;
    float er = mix(1.0 - ef, ef, sat(hh * 3.0));
    d = remap(d, er * uErode * (1.0 - w.b), 1.0, 0.0, 1.0);
  } else {
    d = remap(d, 0.25 * uErode * (1.0 - w.b), 1.0, 0.0, 1.0);
  }
  return sat(d) * uCloud.w;
}

float hg(float mu, float g){ float g2 = g * g; return (1.0 - g2) / (4.0 * PI * pow(1.0 + g2 - 2.0 * g * mu, 1.5)); }

float lightOD(vec3 p){
  float od = 0.0;
  float s = 34.0;
  float acc = 0.0;
  vec3 L = normalize(uKeyDir + vec3(0.0, 0.06, 0.0));
  for (int i = 0; i < 5; i++){
    acc += s;
    float hf;
    od += dens(p + L * (acc - s * 0.5), i > 1, hf) * s;
    s *= 1.85;
  }
  return od;
}

void main(){
  vec3 ray = viewRay(vUv);
  vec3 d = normalize(ray);
  float z = texture(tDepth, vUv).r;
  float tMax = z >= 0.9999999 ? 1e6 : length(ray) * linZ(z);
  if (d.y < -1e-4){ float tw = -uCamPos.y / d.y; if (tw > 0.0) tMax = min(tMax, tw); }

  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float jit = fract(ign + uFrame * 0.61803399);

  float mu = dot(d, uKeyDir);

  // ---------------------------------------------------------------- clouds
  vec3 S = vec3(0.0);
  float T = 1.0;
  float dAcc = 0.0, dW = 0.0;
  float b = uCloud.x, t = uCloud.y;
  float t0, t1;
  if (abs(d.y) < 1e-4){ t0 = (uCamPos.y > b && uCamPos.y < t) ? 0.0 : 1e9; t1 = 1e6; }
  else {
    float a1 = (b - uCamPos.y) / d.y, a2 = (t - uCamPos.y) / d.y;
    t0 = max(min(a1, a2), 0.0); t1 = max(a1, a2);
  }
  float farLim = 22000.0;
  t1 = min(min(t1, tMax), farLim);
  if (t0 < t1 && uCloud.w > 0.0){
    float Lm = t1 - t0;
    int N = int(uSteps);
    float ph = mix(hg(mu, 0.75), hg(mu, -0.18), 0.45) + 0.32 * pow(sat(mu), 60.0);
    float ph2 = mix(hg(mu, 0.45), hg(mu, -0.1), 0.5);
    float prev = 0.0;
    float expo = Lm > 3000.0 ? 1.75 : 1.25;
    for (int i = 0; i < N; i++){
      float u = (float(i) + jit) / float(N);
      float s = Lm * pow(u, expo);
      float ds = s - prev;
      prev = s;
      vec3 p = uCamPos + d * (t0 + s);
      float hf;
      float dn = dens(p, t0 + s > 9000.0, hf);
      if (dn > 0.0005){
        float od = lightOD(p);
        float sig = dn * 0.05;
        float olod = od * 0.036;
        // three scattering orders: bright rims, soft hearts
        vec3 L = uKeyCol * (exp(-olod) * ph * 9.0 + exp(-olod * 0.32) * ph2 * 5.0 + exp(-olod * 0.09) * 0.16);
        // sunlit clouds through thick evening air go gold then rose
        float powder = 1.0 - exp(-dn * 5.0);
        L *= mix(0.62, 1.0, powder);
        vec3 amb = mix(uAmbGnd * 0.85 + uHorizon * 0.16, uAmbSky * 1.0 + uMid * 0.22, sat(hf * 1.15)) * 0.62;
        amb += uWarm * 0.06;
        amb += uFlash;
        vec3 Li = (L + amb);
        float ex = exp(-sig * ds);
        vec3 Sc = Li * (1.0 - ex);
        // air between us and it
        S += T * Sc;
        float wgt = T * (1.0 - ex);
        dAcc += (t0 + s) * wgt; dW += wgt;
        T *= ex;
        if (T < 0.012){ T = 0.0; break; }
      }
    }
  }
  float cd = dW > 0.001 ? dAcc / dW : min(tMax, 12000.0);
  if (dW > 0.0){
    vec3 wp = uCamPos + d * cd;
    vec3 aT = fogT(uCamPos, wp);
    float far = smoothstep(farLim * 0.55, farLim, cd);
    S = S * aT + airColor(d) * (1.0 - aT) * (1.0 - T);
    // far decks dissolve into the sky
    S = mix(S, skyColor(d) * (1.0 - T), far);
  }

  // ------------------------------------------------------- mist, shafts, rain
  vec3 mS = vec3(0.0);
  float mT = 1.0;
  if (uMist.x > 1e-6 || uRain.w > 0.0){
    float mEnd = min(tMax, 5200.0);
    float phm = hg(mu, 0.62) * 2.4 + 0.08;
    int M = int(uMistSteps);
    float prev = 0.0;
    for (int i = 0; i < M; i++){
      float u = (float(i) + jit) / float(M);
      float s = mEnd * u * u;
      float ds = s - prev; prev = s;
      vec3 p = uCamPos + d * s;
      float dn = 0.0;
      if (uMist.x > 1e-6){
        float top = uMist.y * (0.55 + 0.9 * nz(p.xz / 2300.0 + uTime * 0.0006).r);
        float prof = smoothstep(top, top * 0.1, p.y);
        float wisp = nz((p.xz - uWind * uTime * 0.35) / 610.0).r * 0.65 + nz((p.xz + p.y * 3.0) / 170.0 + uTime * 0.003).r * 0.35;
        dn += uMist.x * prof * smoothstep(0.28, 0.66, wisp) * 1.7;
      }
      float rn = 0.0;
      if (uRain.w > 0.0){
        vec2 q = p.xz - uRain.xy - uWind * (uCloud.x - p.y) * 0.02;
        float r = length(q) / uRain.z;
        float a = atan(q.y, q.x);
        float st = nz(vec2(a * 1.9 + r * 0.35, p.y / 2600.0 + uTime * 0.012)).r * 0.6 + nz(vec2(a * 7.0 - r, p.y / 900.0 + uTime * 0.03)).r * 0.4;
        rn = uRain.w * smoothstep(1.0, 0.62, r + (st - 0.5) * 0.5) * smoothstep(uCloud.x + 250.0, uCloud.x - 60.0, p.y) * 0.0017 * (0.4 + st);
      }
      float tot = dn + rn;
      if (tot > 1e-7){
        float sh = terrainShadow(p) * cloudShadowAt(p);
        vec3 L = uKeyCol * sh * phm + (uAmbSky * 0.34 + uHorizon * 0.2);
        L = mix(L, uAmbSky * 0.42 + uKeyCol * sh * 0.06, rn / tot);
        float ex = exp(-tot * ds);
        mS += mT * L * (1.0 - ex);
        mT *= ex;
      }
    }
  }
  vec3 C; float A;
  if (uCamPos.y < (b + t) * 0.5){ C = mS + S * mT; } else { C = S + mS * T; }
  A = T * mT;
  o0 = vec4(C, A);
  o1 = vec4(cd, tMax, 0.0, 1.0);
}
`;

const RESOLVE = /* glsl */ `
precision highp float;
in vec2 vUv;
layout(location = 0) out vec4 o;
uniform sampler2D tCur, tInfo, tHist;
uniform vec4 uProj;
uniform mat3 uCamRot;
uniform mat4 uPrevVP;
uniform vec3 uCamPos2;
uniform vec2 uTexel;
uniform float uReset;
void main(){
  vec4 cur = texture(tCur, vUv);
  vec2 inf = texture(tInfo, vUv).rg;
  vec3 ray = uCamRot * vec3((vUv * 2.0 - 1.0) * uProj.xy, -1.0);
  vec3 wp = uCamPos2 + normalize(ray) * min(inf.x, 30000.0);
  vec4 pc = uPrevVP * vec4(wp, 1.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  vec4 mn = cur, mx = cur, av = cur;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++){
    if (i == 0 && j == 0) continue;
    vec4 s = texture(tCur, vUv + vec2(float(i), float(j)) * uTexel);
    mn = min(mn, s); mx = max(mx, s); av += s;
  }
  av /= 9.0;
  vec4 hist = texture(tHist, puv);
  vec4 pad = (mx - mn) * 0.12 + 0.003;
  hist = clamp(hist, mn - pad, mx + pad);
  float k = 0.09;
  vec2 mv = abs(puv - vUv) / uTexel;
  k = mix(k, 0.22, clamp(max(mv.x, mv.y) * 0.1, 0.0, 1.0));
  if (pc.w <= 0.0 || puv.x < 0.0 || puv.y < 0.0 || puv.x > 1.0 || puv.y > 1.0) { k = 1.0; cur = mix(cur, av, 0.6); }
  if (uReset > 0.5) k = 1.0;
  o = mix(hist, cur, k);
}
`;

export class Clouds {
  private vol: THREE.WebGL3DRenderTarget | null = null;
  private weather: THREE.DataTexture;
  private rtRaw!: THREE.WebGLRenderTarget;
  private hist: THREE.WebGLRenderTarget[] = [];
  private cur = 0;
  private readonly pMarch: Pass;
  private readonly pRes: Pass;
  private frame = 0;
  private reset = true;
  private readonly prevVP = new THREE.Matrix4();
  readonly u: Uniforms;
  w = 1;
  h = 1;
  spec: WeatherSpec | null = null;
  private static readonly WN = 512;

  constructor(private readonly eng: Engine) {
    const n = Clouds.WN;
    this.weather = new THREE.DataTexture(new Uint8Array(n * n * 4), n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.weather.wrapS = this.weather.wrapT = THREE.RepeatWrapping;
    this.weather.minFilter = this.weather.magFilter = THREE.LinearFilter;
    this.weather.needsUpdate = true;
    G.uWeather.value = this.weather;
    this.u = {
      tDepth: { value: null },
      uVol: { value: null },
      uFrame: { value: 0 },
      uSteps: { value: 48 },
      uMistSteps: { value: 14 },
      uSea: { value: 0 },
      uVolScale: { value: 1 / 1500 },
      uErode: { value: 0.42 },
      uRain: { value: new THREE.Vector4(0, 0, 1, 0) },
      uFlash: { value: new THREE.Color(0, 0, 0) },
      uProj: { value: new THREE.Vector4() },
      uCamRot: { value: new THREE.Matrix3() },
    };
    this.pMarch = new Pass(MARCH, this.u);
    this.pRes = new Pass(RESOLVE, {
      tCur: { value: null },
      tInfo: { value: null },
      tHist: { value: null },
      uProj: this.u.uProj,
      uCamRot: this.u.uCamRot,
      uPrevVP: { value: this.prevVP },
      uCamPos2: G.uCamPos,
      uTexel: { value: new THREE.Vector2() },
      uReset: { value: 1 },
    });
  }

  get texture(): THREE.Texture {
    return this.hist[this.cur].texture;
  }

  /** Grow the noise volume on the GPU, a few slices at a time. */
  buildVolume(size = 96): void {
    const gl = this.eng.gl;
    this.vol = new THREE.WebGL3DRenderTarget(size, size, size, { depthBuffer: false, type: THREE.UnsignedByteType, format: THREE.RGBAFormat });
    const t = this.vol.texture;
    t.wrapS = t.wrapT = (t as THREE.Data3DTexture).wrapR = THREE.RepeatWrapping;
    t.minFilter = t.magFilter = THREE.LinearFilter;
    const p = new Pass(NOISE3D, { uZ: { value: 0 } });
    for (let z = 0; z < size; z++) {
      p.mat.uniforms.uZ.value = (z + 0.5) / size;
      gl.setRenderTarget(this.vol, z);
      gl.render(p.scene, Pass.cam);
    }
    gl.setRenderTarget(null);
    this.u.uVol.value = t;
  }

  resize(w: number, h: number): void {
    const s = this.eng.quality.cloudScale;
    this.w = Math.max(16, Math.round(w * s));
    this.h = Math.max(16, Math.round(h * s));
    this.rtRaw?.dispose();
    for (const t of this.hist) t.dispose();
    const o = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false } as const;
    this.rtRaw = new THREE.WebGLRenderTarget(this.w, this.h, { ...o, count: 2 });
    this.hist = [new THREE.WebGLRenderTarget(this.w, this.h, o), new THREE.WebGLRenderTarget(this.w, this.h, o)];
    this.reset = true;
    this.u.uSteps.value = this.eng.quality.cloudSteps;
    this.u.uMistSteps.value = this.eng.quality.mistSteps;
  }

  cut(): void {
    this.reset = true;
  }

  setWeather(s: WeatherSpec): void {
    this.spec = s;
    const n = Clouds.WN;
    const half = G.uWeatherHalf.value;
    const data = this.weather.image.data as Uint8Array;
    const nz = new Noise(s.seed + 5);
    const cov = new Float32Array(n * n);
    const tall = new Float32Array(n * n);
    const smo = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      const z = (j / n - 0.5) * 2 * half;
      for (let i = 0; i < n; i++) {
        const x = (i / n - 0.5) * 2 * half;
        const k = j * n + i;
        let c = 0;
        if (s.field > 0) {
          const f = nz.fbm(x / s.fieldScale, z / s.fieldScale, 4) * 0.9 + 0.5;
          c = s.sea ? 0.72 + 0.28 * f : smoothstep(1 - s.field, 1 - s.field + 0.42, f);
          // fade the wrap seam
          const e = Math.max(Math.abs(x), Math.abs(z)) / half;
          if (!s.sea) c *= 1 - smoothstep(0.9, 1, e);
        }
        tall[k] = s.fieldTall * (0.7 + 0.5 * (nz.n(x / 2400 + 9, z / 2400) * 0.5 + 0.5));
        cov[k] = c;
      }
    }
    for (const h of s.holes ?? []) {
      stamp(n, half, h.x, h.z, h.r * 1.5, (k, d) => {
        const w = smoothstep(h.r * 0.75, h.r * 1.4, d);
        cov[k] *= w;
      });
    }
    for (const p of s.puffs) {
      const sx = p.sx ?? 1;
      const sz = p.sz ?? 1;
      const ca = Math.cos(p.rot ?? 0);
      const sa = Math.sin(p.rot ?? 0);
      const R = p.r * Math.max(sx, sz) * 1.15;
      const ci = (p.x / (2 * half) + 0.5) * n;
      const cj = (p.z / (2 * half) + 0.5) * n;
      const rr = Math.ceil((R / (2 * half)) * n) + 1;
      for (let j = Math.floor(cj) - rr; j <= cj + rr; j++) {
        for (let i = Math.floor(ci) - rr; i <= ci + rr; i++) {
          if (i < 0 || j < 0 || i >= n || j >= n) continue;
          const dx = (i / n - 0.5) * 2 * half - p.x;
          const dz = (j / n - 0.5) * 2 * half - p.z;
          const u = (dx * ca + dz * sa) / (p.r * sx);
          const v = (-dx * sa + dz * ca) / (p.r * sz);
          const d = Math.sqrt(u * u + v * v);
          const w = 1 - smoothstep(0.25, 1.05, d);
          if (w <= 0) continue;
          const k = j * n + i;
          const a = w * p.amt;
          if (a > cov[k]) {
            cov[k] = a;
            smo[k] = Math.max(smo[k], (p.smooth ?? 0) * w);
          }
          // domes: taller toward the middle
          tall[k] = Math.max(cov[k] > 0.02 && w < 0.2 ? tall[k] : 0, p.tall * (0.45 + 0.55 * Math.sqrt(w)));
        }
      }
    }
    for (let k = 0; k < n * n; k++) {
      data[k * 4] = Math.round(Math.min(1, cov[k]) * 255);
      data[k * 4 + 1] = Math.round(Math.min(1, tall[k]) * 255);
      data[k * 4 + 2] = Math.round(Math.min(1, smo[k]) * 255);
    }
    // soft coverage for shadows
    const soft = blur(cov, n, 2);
    for (let k = 0; k < n * n; k++) data[k * 4 + 3] = Math.round(Math.min(1, soft[k]) * 255);
    this.weather.needsUpdate = true;
    G.uCloud.value.x = s.base;
    G.uCloud.value.y = s.top;
    G.uCloud.value.w = s.density;
    this.u.uSea.value = s.sea ? 1 : 0;
    (this.u.uRain.value as THREE.Vector4).set(s.rain?.x ?? 0, s.rain?.z ?? 0, s.rain?.r ?? 1, s.rain?.amt ?? 0);
    this.reset = true;
  }

  render(V: Uniforms): void {
    const gl = this.eng.gl;
    this.u.tDepth.value = V.tDepth.value;
    (this.u.uProj.value as THREE.Vector4).copy(V.uProj.value as THREE.Vector4);
    (this.u.uCamRot.value as THREE.Matrix3).copy(V.uCamRot.value as THREE.Matrix3);
    this.u.uFrame.value = this.frame++ % 64;
    this.pMarch.render(gl, this.rtRaw);
    const r = this.pRes.mat.uniforms;
    r.tCur.value = this.rtRaw.textures[0];
    r.tInfo.value = this.rtRaw.textures[1];
    r.tHist.value = this.hist[this.cur].texture;
    (r.uTexel.value as THREE.Vector2).set(1 / this.w, 1 / this.h);
    r.uReset.value = this.reset ? 1 : 0;
    const next = 1 - this.cur;
    this.pRes.render(gl, this.hist[next]);
    this.cur = next;
    this.reset = false;
    this.prevVP.copy(V.uVP.value as THREE.Matrix4);
  }
}

function stamp(n: number, half: number, x: number, z: number, r: number, fn: (k: number, d: number) => void): void {
  const ci = (x / (2 * half) + 0.5) * n;
  const cj = (z / (2 * half) + 0.5) * n;
  const rr = Math.ceil((r / (2 * half)) * n) + 1;
  for (let j = Math.floor(cj) - rr; j <= cj + rr; j++) {
    for (let i = Math.floor(ci) - rr; i <= ci + rr; i++) {
      if (i < 0 || j < 0 || i >= n || j >= n) continue;
      fn(j * n + i, Math.hypot(i - ci, j - cj) * ((2 * half) / n));
    }
  }
}

function blur(a: Float32Array, n: number, r: number): Float32Array {
  const b = new Float32Array(n * n);
  const c = new Float32Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let q = -r; q <= r; q++) s += a[j * n + ((i + q + n) % n)];
      b[j * n + i] = s / (2 * r + 1);
    }
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let q = -r; q <= r; q++) s += b[((j + q + n) % n) * n + i];
      c[j * n + i] = s / (2 * r + 1);
    }
  return c;
}
