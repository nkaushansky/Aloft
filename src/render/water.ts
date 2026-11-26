import * as THREE from 'three';
import { FULL } from './glsl/common';
import { VIEWRAY } from './glsl/passes';
import { G, Uniforms, worldMaterial } from './globals';
import { HALF } from '../world/lands';

export interface WaterStyle {
  deep: string;
  shallow: string;
  clarity: number;
  /** what the water takes out of light, per channel */
  absorb: [number, number, number];
  chop: number;
  swell: number;
  glow: string;
  glowAmt: number;
}

/**
 * One sheet of water at y = 0, everywhere. Its job is to hold the sky: it
 * reflects the finished frame, takes the wind as moving cat's-paws, and on
 * the night crossing it glows where the sea is warm.
 */
export class Water {
  readonly mesh: THREE.Mesh;
  readonly u: Uniforms;
  private readonly glowTex: THREE.DataTexture;
  private static readonly GN = 512;
  private static readonly S = 5;

  constructor(view: Uniforms) {
    const n = 176;
    const inner = 0.62;
    const pos = new Float32Array((n + 1) * (n + 1) * 3);
    const S = Water.S;
    const half = n / 2;
    const ni = Math.floor(half * inner);
    const coord = (i: number) => {
      const k = Math.abs(i - half);
      const sg = Math.sign(i - half);
      if (k <= ni) return sg * k * S;
      const t = (k - ni) / (half - ni);
      return sg * (ni * S + (Math.pow(t, 4.2) * 64000 + t * 400));
    };
    for (let j = 0; j <= n; j++)
      for (let i = 0; i <= n; i++) {
        const k = (j * (n + 1) + i) * 3;
        pos[k] = coord(i);
        pos[k + 1] = 0;
        pos[k + 2] = coord(j);
      }
    const idx = new Uint32Array(n * n * 6);
    let q = 0;
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i;
        idx[q++] = a; idx[q++] = a + n + 1; idx[q++] = a + 1;
        idx[q++] = a + 1; idx[q++] = a + n + 1; idx[q++] = a + n + 2;
      }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));

    const gn = Water.GN;
    this.glowTex = new THREE.DataTexture(new Uint8Array(gn * gn), gn, gn, THREE.RedFormat, THREE.UnsignedByteType);
    this.glowTex.minFilter = this.glowTex.magFilter = THREE.LinearFilter;
    this.glowTex.needsUpdate = true;

    this.u = {
      ...view,
      wDeep: { value: new THREE.Color() },
      wShallow: { value: new THREE.Color() },
      wClarity: { value: 3 },
      wAbs: { value: new THREE.Vector3(1.2, 0.6, 0.5) },
      wChop: { value: 0.3 },
      wSwell: { value: 0 },
      wGlow: { value: new THREE.Color() },
      wGlowAmt: { value: 0 },
      wGlowTex: { value: this.glowTex },
      wCenter: { value: new THREE.Vector2() },
      wWake: { value: new THREE.Vector4(0, 0, 0, 0) },
      wWhale: { value: [0, 1, 2, 3, 4, 5].map(() => new THREE.Vector4()) },
      wWhaleB: { value: [0, 1, 2, 3, 4, 5].map(() => new THREE.Vector2(15, -8)) },
      wRings: { value: [0, 1, 2, 3, 4, 5].map(() => new THREE.Vector4(0, 0, -100, 0)) },
      uSsr: { value: 22 },
    };
    const mat = worldMaterial(VERT, FRAG, this.u, { depthWrite: true, depthTest: true });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
  }

  setStyle(s: WaterStyle): void {
    (this.u.wDeep.value as THREE.Color).set(s.deep);
    (this.u.wShallow.value as THREE.Color).set(s.shallow);
    this.u.wClarity.value = s.clarity;
    (this.u.wAbs.value as THREE.Vector3).set(...s.absorb);
    this.u.wChop.value = s.chop;
    this.u.wSwell.value = s.swell;
    (this.u.wGlow.value as THREE.Color).set(s.glow);
    this.u.wGlowAmt.value = s.glowAmt;
  }

  setCurrents(lines: Array<{ x: number; z: number }[]>): void {
    const n = Water.GN;
    const d = this.glowTex.image.data as Uint8Array;
    d.fill(0);
    for (let j = 0; j < n && lines.length; j++)
      for (let i = 0; i < n; i++) {
        const x = (i / n - 0.5) * 2 * HALF;
        const z = (j / n - 0.5) * 2 * HALF;
        let best = 1e9;
        for (const l of lines)
          for (let k = 0; k < l.length - 1; k++) {
            const ax = l[k].x;
            const az = l[k].z;
            const bx = l[k + 1].x - ax;
            const bz = l[k + 1].z - az;
            let t = ((x - ax) * bx + (z - az) * bz) / (bx * bx + bz * bz);
            t = t < 0 ? 0 : t > 1 ? 1 : t;
            const q = (ax + bx * t - x) ** 2 + (az + bz * t - z) ** 2;
            if (q < best) best = q;
          }
        d[j * n + i] = Math.round(Math.exp(-best / (95 * 95)) * 255);
      }
    this.glowTex.needsUpdate = true;
  }

  private ringI = 0;
  /** Drop a ripple ring on the surface. */
  ring(x: number, z: number, strength: number): void {
    const r = this.u.wRings.value as THREE.Vector4[];
    r[this.ringI++ % r.length].set(x, z, G.uTime.value, strength);
  }

  update(cam: THREE.Vector3): void {
    const S = Water.S;
    (this.u.wCenter.value as THREE.Vector2).set(Math.round(cam.x / S) * S, Math.round(cam.z / S) * S);
  }
}

const WAVES = /* glsl */ `
uniform float wSwell;
const vec4 GW[4] = vec4[4](
  vec4(0.35, -0.94, 92.0, 1.25),
  vec4(-0.28, -0.96, 57.0, 0.72),
  vec4(0.74, -0.67, 34.0, 0.36),
  vec4(-0.8, -0.6, 21.0, 0.2));
vec3 swell(vec2 p){
  vec3 o = vec3(0.0);
  for (int i = 0; i < 4; i++){
    vec2 D = normalize(GW[i].xy);
    float k = 2.0 * PI / GW[i].z;
    float A = GW[i].w * wSwell;
    float ph = k * dot(D, p) - sqrt(9.8 * k) * 0.8 * uTime + float(i) * 1.7;
    float c = cos(ph), s = sin(ph);
    o += vec3(D.x * 0.55 * A * c, A * s, D.y * 0.55 * A * c);
  }
  return o;
}
// The same waves, per pixel. Each one bows out before it is finer than the
// pixels can hold, so the sea never shimmers or steps; what it loses in shape
// it gives back as roughness.
vec3 swellNormal(vec2 p, float foot, out float lost){
  vec3 dx = vec3(1.0, 0.0, 0.0), dz = vec3(0.0, 0.0, 1.0);
  lost = 0.0;
  for (int i = 0; i < 4; i++){
    vec2 D = normalize(GW[i].xy);
    float k = 2.0 * PI / GW[i].z;
    float keep = 1.0 - smoothstep(GW[i].z * 0.10, GW[i].z * 0.36, foot);
    float A = GW[i].w * wSwell;
    float ph = k * dot(D, p) - sqrt(9.8 * k) * 0.8 * uTime + float(i) * 1.7;
    float c = cos(ph), s = sin(ph);
    float Q = 0.55;
    lost += (1.0 - keep) * A * k;
    A *= keep;
    dx += vec3(-Q * A * k * D.x * D.x * s, A * k * D.x * c, -Q * A * k * D.x * D.y * s);
    dz += vec3(-Q * A * k * D.x * D.y * s, A * k * D.y * c, -Q * A * k * D.y * D.y * s);
  }
  return normalize(cross(dz, dx));
}
`;

const VERT = /* glsl */ `
${FULL}
${WAVES}
uniform vec2 wCenter;
out vec3 vW;
out vec2 vX;
out float vH;
void main(){
  vec2 xz = position.xz + wCenter;
  vec3 p = vec3(xz.x, 0.0, xz.y);
  if (wSwell > 0.0){
    // fades by true distance, never by place in the grid: the grid jumps, the sea must not
    float f = 1.0 - smoothstep(150.0, 250.0, length(xz - uCamPos.xz));
    if (f > 0.0){
      float lee = smoothstep(0.0, -14.0, terrainH(xz));
      p += swell(xz) * f * lee;
    }
  }
  vH = p.y;
  vW = p;
  vX = xz;
  gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */ `
${FULL}
${VIEWRAY}
${WAVES}
in vec3 vW;
in vec2 vX;
in float vH;
layout(location = 0) out vec4 o;
uniform sampler2D tDepth, tOpaque, tScene, tClouds, wGlowTex;
uniform mat4 uVP;
uniform vec3 wDeep, wShallow, wGlow, wAbs;
uniform float wClarity, wChop, wGlowAmt, uSsr, uCloudsOn;
uniform vec4 wRings[6];
uniform vec4 wWhale[6];   // x, z, yaw, amount
uniform vec2 wWhaleB[6];  // length, depth

vec2 grad(vec2 p, float s, vec2 scroll){
  vec2 q = p / s + scroll;
  float e = 1.0 / 180.0;
  float a = nz(q).r;
  return vec2(nz(q + vec2(e, 0.0)).r - a, nz(q + vec2(0.0, e)).r - a) / (e * s) * 1.0;
}

vec3 cheapClouds(vec3 p, vec3 r, vec3 sky){
  if (r.y < 0.02 || uCloud.w <= 0.0) return sky;
  vec2 q = p.xz + r.xz / r.y * (uCloud.x + 80.0);
  float dist = length(q - p.xz);
  float c = texture(uWeather, (q + uCloudOff) / (2.0 * uWeatherHalf) + 0.5).a;
  c *= 0.6 + 0.8 * nz(q / 900.0).r;
  float m = smoothstep(0.25, 0.75, c) * (1.0 - smoothstep(7000.0, 18000.0, dist));
  vec3 cc = uKeyCol * 0.28 + uAmbSky * 0.8 + uWarm * 0.1;
  return mix(sky, cc, m * 0.7);
}

vec3 reflectScene(vec3 p, vec3 r){
  vec3 sky = skyBase(r) + skyHalo(r, 0.35);
  sky = cheapClouds(p, r, sky);
  vec4 ci = vec4(0.0);
  vec3 res = sky;
  // sky seen in the same frame, where the reflected ray lands on screen
  vec4 sc = uVP * vec4(r * 1.0e4, 0.0);
  if (sc.w > 0.0){
    vec2 uv = sc.xy / sc.w * 0.5 + 0.5;
    vec2 e = smoothstep(vec2(0.0), vec2(0.09), uv) * smoothstep(vec2(1.0), vec2(0.91), uv);
    float m = e.x * e.y;
    if (m > 0.0 && textureLod(tDepth, uv, 0.0).r >= 0.9999999) res = mix(res, min(textureLod(tScene, uv, 0.0).rgb, vec3(14.0)), m);
  }
  // march for land
  float s = 1.5;
  float prev = 0.0;
  float jit = hash12(gl_FragCoord.xy) * 0.7 + 0.5;
  int N = int(uSsr);
  for (int i = 0; i < N; i++){
    float t = s * jit;
    vec3 q = p + r * (prev + t);
    vec4 c = uVP * vec4(q, 1.0);
    if (c.w <= 0.0) break;
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
    float z = textureLod(tDepth, uv, 0.0).r;
    if (z < 0.9999999){
      float lz = linZ(z);
      if (c.w > lz && c.w - lz < s * 1.25 + 0.35 + c.w * 0.012){
        // refine
        float a = prev, b = prev + t;
        for (int k = 0; k < 4; k++){
          float m = 0.5 * (a + b);
          vec4 cm = uVP * vec4(p + r * m, 1.0);
          vec2 um = cm.xy / cm.w * 0.5 + 0.5;
          if (cm.w > linZ(textureLod(tDepth, um, 0.0).r)) b = m; else a = m;
        }
        vec4 ch = uVP * vec4(p + r * b, 1.0);
        vec2 uh = ch.xy / ch.w * 0.5 + 0.5;
        vec2 e = smoothstep(vec2(0.0), vec2(0.07), uh) * smoothstep(vec2(1.0), vec2(0.93), uh);
        vec3 hit = min(textureLod(tScene, uh, 0.0).rgb, vec3(10.0));
        res = mix(res, hit, e.x * e.y);
        break;
      }
    }
    prev += t;
    s *= 1.42;
  }
  return res;
}

void main(){
  vec2 suv = gl_FragCoord.xy / uRes;
  float myZ = 1.0 / gl_FragCoord.w;
  float oz = texture(tDepth, suv).r;
  float oZ = oz >= 0.9999999 ? 1e6 : linZ(oz);
  if (oZ < myZ) discard;
  vec3 V = uCamPos - vW;
  float dist = length(V);
  V /= dist;
  float path = (oZ - myZ) * dist / myZ;   // metres of water along the ray
  float bed = terrainH(vW.xz);
  float depth = max(vW.y - bed, 0.0);

  // --- surface ---------------------------------------------------------------
  vec2 w = uWind;
  vec2 wd = normalize(w + vec2(1e-4));
  float paws = nz((vW.xz - w * uTime * 1.2) / 520.0).r;
  paws = smoothstep(0.44, 0.7, paws);
  float f1 = 1.0 - smoothstep(60.0, 420.0, dist);
  float f2 = 1.0 - smoothstep(300.0, 2400.0, dist);
  float amp = wChop * (0.35 + 1.0 * paws);
  vec2 g = vec2(0.0);
  g += grad(vW.xz, 31.0, -wd * uTime * 0.030) * 1.6 * f2;
  g += grad(vW.yx * 0.0 + vW.zx, 17.0, vec2(uTime * 0.034, -uTime * 0.021)).yx * 0.9 * f2;
  g += grad(vW.xz, 6.3, -wd.yx * uTime * 0.09 + 0.3) * 0.55 * f1;
  g += grad(vW.xz, 2.3, wd * uTime * 0.16) * 0.28 * f1;
  g *= amp;
  // ripple rings
  for (int i = 0; i < 6; i++){
    float age = uTime - wRings[i].z;
    if (age < 0.0 || age > 7.0) continue;
    vec2 q = vW.xz - wRings[i].xy;
    float r = length(q) + 1e-3;
    float R = 0.6 + age * 2.4;
    float band = exp(-pow((r - R) / (0.5 + age * 0.25), 2.0));
    g += q / r * cos((r - R) * 5.0) * band * wRings[i].w * 0.35 * exp(-age * 0.55);
  }
  vec3 vN = vec3(0.0, 1.0, 0.0);
  float lost = 0.0;
  if (wSwell > 0.0){
    float px = dist * 2.0 * uProj.y / uRes.y;
    float foot = px / clamp(V.y, 0.045, 1.0);
    float lee = smoothstep(0.0, -14.0, bed);
    vN = normalize(mix(vec3(0.0, 1.0, 0.0), swellNormal(vX, foot, lost), lee));
    lost *= lee;
  }
  vec3 N = normalize(vN + vec3(-g.x, 0.0, -g.y));
  // distant water is rougher in aggregate: tip the mean normal up a little
  float ndv = max(dot(N, V), 0.02);
  float F = 0.02 + 0.98 * pow(1.0 - ndv, 5.0);
  F = mix(F, min(F, 0.72), smoothstep(800.0, 6000.0, dist) * (0.3 + 0.5 * wChop));

  vec3 R = reflect(-V, N);
  R.y = abs(R.y) + 0.004;
  // far chop smears reflections vertically
  R.y += ((0.01 + 0.025 * wChop) * smoothstep(200.0, 3000.0, dist)) + lost * 0.3;
  R = normalize(R);
  vec3 refl = reflectScene(vW, R);

  // --- body --------------------------------------------------------------------
  vec2 off = N.xz * clamp(path * 0.5, 0.0, 2.2) / max(dist, 6.0) * 0.9;
  vec2 ruv = suv + off;
  float rz = texture(tDepth, ruv).r;
  float rZ = rz >= 0.9999999 ? 1e6 : linZ(rz);
  if (rZ < myZ) { ruv = suv; rZ = oZ; }
  float rp = (rZ - myZ) * dist / myZ;
  rp = min(rp, depth * 3.0 + 1.0);
  vec3 bedc = texture(tOpaque, ruv).rgb;
  vec3 ext = wAbs / wClarity;
  vec3 T = exp(-ext * rp);
  float sh = terrainShadow(vW) * cloudShadowAt(vW);
  float nl = max(uKeyDir.y, 0.0);
  vec3 light = uAmbSky * 0.9 + uKeyCol * nl * 0.55 * sh;
  vec3 body = mix(wDeep, wShallow, exp(-depth * 0.55) * 0.7) * light;
  vec3 under = bedc * T + body * (1.0 - T);
  // light through the thin tops of swells
  if (wSwell > 0.0){
    float crest = smoothstep(0.2, 2.0, vH);
    under += wShallow * (uKeyCol * 0.5 + uAmbSky * 0.3) * crest * pow(sat(dot(-V, uKeyDir) * 0.5 + 0.5), 2.0) * 0.6;
  }

  vec3 c = mix(under, refl, F);

  // --- the path of light ----------------------------------------------------
  vec3 Ng = normalize(vN + vec3(-g.x, 0.0, -g.y) * 1.2 + vec3(0.0));
  vec3 H = normalize(V + uKeyDir);
  float rough = mix(260.0, 34.0, smoothstep(40.0, 2500.0, dist)) / (1.0 + lost * 6.0);
  float sp = pow(sat(dot(Ng, H)), rough);
  // a broad soft lobe stretched toward the sun: the road of light
  vec3 Nw = normalize(vec3(Ng.x * 0.5, 1.0, Ng.z * 0.5));
  float sp2 = pow(sat(dot(Nw, H)), mix(90.0, 26.0, smoothstep(20.0, 1800.0, dist)));
  // glitter from two sheets of smooth noise sliding over each other: it flows, it doesn't flicker
  float tw = nz(vW.xz / 41.0 - wd * uTime * 0.016).r + nz(vW.zx / 33.0 + vec2(uTime * 0.011, -uTime * 0.013)).r - 0.5;
  float gl = 0.35 + 1.5 * smoothstep(0.46, 0.78, tw);
  float lowSun = smoothstep(0.35, 0.02, uKeyDir.y);
  c += uKeyCol * sh * (sp * gl * (0.6 + 2.2 * lowSun) * 1.1 + sp2 * (0.06 + 0.34 * lowSun) * (0.45 + 0.9 * smoothstep(0.42, 0.7, tw)));

  // --- the glowing currents ---------------------------------------------------
  if (wGlowAmt > 0.0){
    float band = texture(wGlowTex, vW.xz / (2.0 * uWorld.x) + 0.5).r;
    vec2 q = vW.xz;
    float n1 = nz(q / 140.0 + wd * uTime * -0.006).r;
    float n2 = nz(q / 37.0 + vec2(uTime * 0.011, -uTime * 0.007)).r;
    float fil = 1.0 - smoothstep(0.0, 0.035, abs(n1 * 0.62 + n2 * 0.38 - 0.5));
    float bloomP = smoothstep(0.5, 0.72, nz(q / 420.0 - wd * uTime * 0.003).r);
    float pts = smoothstep(0.93, 1.0, nz(q / 2.7).a) * (0.5 + 0.5 * sin(uTime * 2.0 + nz(q / 9.0).a * 40.0)) * f1;
    float crest = smoothstep(0.1, 1.6, vH) * 0.35;
    float birdD = length(vW.xz - uBirdPos.xz);
    float low = smoothstep(16.0, 1.5, uBirdPos.y - vW.y);
    float wake = low * exp(-birdD * birdD / 60.0) * 1.5;
    float gA = band * band * (0.025 + fil * (0.16 + 0.55 * bloomP) + crest * 0.25) + pts * (0.05 + 0.5 * band) + wake * (0.12 + fil * 0.6);
    float night = sat(uStars * 1.4);
    // whales: the glow wakes around them, and their bodies are the dark in it
    for (int i = 0; i < 6; i++){
      float wa = wWhale[i].w;
      if (wa <= 0.0) continue;
      vec2 qw = vW.xz - wWhale[i].xy;
      if (dot(qw, qw) > 26000.0) continue;
      vec2 f = vec2(-sin(wWhale[i].z), -cos(wWhale[i].z));
      float al = dot(qw, f), la = dot(qw, vec2(-f.y, f.x));
      float hl = wWhaleB[i].x * 0.5;
      float e = length(vec2(la / (wWhaleB[i].x * 0.16), al / hl));
      float rim = exp(-pow((e - 1.1) / 0.24, 2.0));
      float inside = smoothstep(1.02, 0.78, e);
      float bh = -al - hl * 0.4;
      float wk = 0.0;
      if (bh > 0.0){
        float arm = abs(la) - (wWhaleB[i].x * 0.07 + bh * 0.17);
        wk = exp(-arm * arm / (1.6 + bh * 0.12)) * exp(-bh / 46.0) * 0.8;
        wk += exp(-la * la / (wWhaleB[i].x * 0.22 + bh * 0.25)) * exp(-bh / 30.0) * 0.75;
        // it gathers along the flank; it doesn't start at a line
        wk *= smoothstep(0.0, hl * 0.95, bh);
      }
      float dimD = mix(0.5, 1.0, smoothstep(-10.0, -1.5, wWhaleB[i].y));
      gA *= 1.0 - 0.8 * inside * wa;
      gA += wa * dimD * (rim * (0.5 + 0.6 * fil) + wk * (0.35 + 0.9 * fil) + exp(-pow(max(e - 1.0, 0.0) / 1.1, 2.0)) * 0.12 * (1.0 - inside));
    }
    c += wGlow * gA * 0.85 * night * wGlowAmt * (1.0 - 0.5 * F);
    // shoreline sparks
    c += wGlow * smoothstep(1.6, 0.1, depth) * (0.2 + 0.8 * fil) * 0.22 * night * wGlowAmt * step(0.01, depth);
  }

  // --- shore -----------------------------------------------------------------
  float edge = smoothstep(0.0, 0.32, depth);
  float lace = 0.0;
  if (wSwell > 0.0 || wChop > 0.5){
    float ph = depth * 0.9 - uTime * 0.35 + nz(vW.xz / 44.0).r * 3.0;
    lace = smoothstep(0.75, 1.0, sin(ph * 2.2)) * smoothstep(2.6, 0.3, depth) * smoothstep(0.4, 0.7, nz(vW.xz / 9.0).b);
    lace += smoothstep(0.55, 0.0, depth) * smoothstep(0.35, 0.65, nz(vW.xz / 6.0 + uTime * 0.02).b);
    float cap = smoothstep(1.15, 2.0, vH) * smoothstep(0.5, 0.75, nz(vW.xz / 5.0 - w * uTime * 0.02).b);
    lace += cap * 0.8 * f1;
  }
  c = mix(c, (uKeyCol * nl * sh * 0.8 + uAmbSky) * 0.85, sat(lace) * 0.7);

  c = applyAir(c, vW);
  // thin water at the rim lets the bank show through
  vec3 behind = texture(tScene, suv).rgb;
  c = mix(behind, c, edge);
  if (uCloudsOn > 0.5 && edge > 0.0){
    vec4 cl = texture(tClouds, suv);
    c = mix(behind, (c * cl.a + cl.rgb), edge);
  }
  o = vec4(max(c, vec3(0.0)), 1.0);
}
`;
