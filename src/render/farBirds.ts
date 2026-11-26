import * as THREE from 'three';
import { FULL } from './glsl/common';
import { worldMaterial } from './globals';

function birdGeo(): THREE.BufferGeometry {
  // x = lateral, y = up, z = back; wings flap in the vertex shader by |x|
  const v: number[] = [];
  const t: number[] = []; // tone
  const idx: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], ta: number, tb: number, tc: number, td: number) => {
    const k = v.length / 3;
    v.push(...a, ...b, ...c, ...d);
    t.push(ta, tb, tc, td);
    idx.push(k, k + 1, k + 2, k, k + 2, k + 3);
  };
  for (const s of [-1, 1]) {
    quad([0.1 * s, 0.06, -0.28], [0.95 * s, 0.06, -0.36], [0.98 * s, 0.05, 0.22], [0.1 * s, 0.05, 0.28], 0, 0, 0.8, 0.5);
    quad([0.95 * s, 0.06, -0.36], [1.62 * s, 0.06, -0.24], [1.6 * s, 0.05, 0.26], [0.98 * s, 0.05, 0.22], 0, 0, 0.9, 0.8);
    quad([1.62 * s, 0.06, -0.24], [2.3 * s, 0.06, 0.02], [2.2 * s, 0.05, 0.22], [1.6 * s, 0.05, 0.26], 0.2, 1, 1, 0.9);
  }
  // body: two crossed diamonds, long neck, trailing legs
  quad([-0.19, 0, -0.1], [0, 0.17, -0.1], [0.19, 0, -0.1], [0, -0.2, -0.1], 0, 0, 0, 0);
  quad([0, 0.17, -0.5], [0.2, 0, 0], [0, 0.1, 0.62], [-0.2, 0, 0], 0, 0, 0, 0);
  quad([0, -0.16, -0.5], [-0.2, 0, 0], [0, 0.0, 0.62], [0.2, 0, 0], 0, 0, 0, 0);
  quad([0.06, 0.06, -0.5], [0.03, 0.1, -1.7], [-0.03, 0.1, -1.7], [-0.06, 0.06, -0.5], 0.3, 0.9, 0.9, 0.3);
  quad([0.0, 0.12, -0.5], [0.0, 0.13, -1.7], [0.0, 0.06, -1.7], [0.0, -0.02, -0.5], 0.0, 0.2, 0.9, 0.7);
  quad([0.04, 0.02, 0.5], [0.03, 0.02, 1.25], [-0.03, 0.02, 1.25], [-0.04, 0.02, 0.5], 1, 1, 1, 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.setAttribute('aTone', new THREE.Float32BufferAttribute(t, 1));
  g.setIndex(idx);
  return g;
}

const S = 8;

/** Distant cranes: the flock ahead, kettles marking thermals. CPU-placed. */
export class FarBirds {
  readonly mesh: THREE.Mesh;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly buf: THREE.InstancedInterleavedBuffer;
  private readonly d: Float32Array;
  n = 0;

  constructor(private readonly max: number) {
    const base = birdGeo();
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute('position', base.attributes.position);
    this.geo.setAttribute('aTone', base.attributes.aTone);
    this.geo.setIndex(base.index);
    this.d = new Float32Array(max * S);
    this.buf = new THREE.InstancedInterleavedBuffer(this.d, S, 1);
    this.buf.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iA', new THREE.InterleavedBufferAttribute(this.buf, 4, 0)); // xyz, yaw
    this.geo.setAttribute('iB', new THREE.InterleavedBufferAttribute(this.buf, 4, 4)); // phase, roll, scale, flap
    this.geo.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geo, worldMaterial(VERT, FRAG, {}, { side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false;
  }

  begin(): void {
    this.n = 0;
  }

  put(x: number, y: number, z: number, yaw: number, roll: number, phase: number, scale: number, flap: number): void {
    if (this.n >= this.max) return;
    const o = this.n++ * S;
    const d = this.d;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = z;
    d[o + 3] = yaw;
    d[o + 4] = phase;
    d[o + 5] = roll;
    d[o + 6] = scale;
    d[o + 7] = flap;
  }

  end(): void {
    this.geo.instanceCount = this.n;
    this.buf.clearUpdateRanges();
    this.buf.addUpdateRange(0, this.n * S);
    this.buf.needsUpdate = true;
  }
}

const BIRD_FN = /* glsl */ `
vec3 birdVert(vec3 p, float yaw, float roll, float phase, float scale, float flap, float pitch, out vec3 n){
  float ax = abs(p.x), sg = sign(p.x);
  float a = 0.10 + sin(phase) * 0.55 * flap;
  float b = sin(phase - 0.9) * 0.6 * flap + 0.06;
  float i = min(ax, 0.95), o = max(ax - 0.95, 0.0);
  vec3 q = p;
  n = vec3(0.0, 1.0, 0.0);
  if (ax > 0.21){
    q.x = sg * (cos(a) * i + cos(a + b) * o);
    q.y = p.y + sin(a) * i + sin(a + b) * o;
    float th = ax > 0.95 ? a + b : a;
    n = vec3(-sg * sin(th), cos(th), 0.0);
  }
  float cr = cos(-roll), sr = sin(-roll);
  mat3 R = mat3(cr, sr, 0.0, -sr, cr, 0.0, 0.0, 0.0, 1.0);
  float cp = cos(pitch), sp = sin(pitch);
  mat3 P = mat3(1.0, 0.0, 0.0, 0.0, cp, sp, 0.0, -sp, cp);
  float cy = cos(yaw), sy = sin(yaw);
  mat3 Y = mat3(cy, 0.0, -sy, 0.0, 1.0, 0.0, sy, 0.0, cy);
  mat3 M = Y * P * R;
  n = M * n;
  return M * q * scale;
}
`;

const VERT = /* glsl */ `
${FULL}
${BIRD_FN}
in float aTone;
in vec4 iA; in vec4 iB;
out vec3 vW; out vec3 vN; out float vTone;
void main(){
  vec3 n;
  float d = length(iA.xyz - uCamPos);
  // never let a bird vanish between pixels
  float s = iB.z * max(1.0, d / 900.0);
  vec3 p = birdVert(position, iA.w, iB.y, iB.x, s, iB.w, 0.0, n);
  vW = iA.xyz + p; vN = n; vTone = aTone;
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}
`;

const FRAG = /* glsl */ `
${FULL}
in vec3 vW; in vec3 vN; in float vTone;
layout(location = 0) out vec4 o;
void main(){
  vec3 V = normalize(uCamPos - vW);
  vec3 N = normalize(vN);
  if (dot(N, V) < 0.0) N = -N;
  vec3 col = mix(vec3(1.05), vec3(0.035), smoothstep(0.35, 0.95, vTone));
  float sh = terrainShadow(vW) * cloudShadowAt(vW);
  float nl = sat((dot(N, uKeyDir) + 0.3) / 1.3);
  vec3 c = col * (uKeyCol * nl * sh + ambient(N, 0.85));
  float thru = pow(sat(dot(-V, uKeyDir) * 0.5 + 0.5), 4.0);
  c += col * uKeyCol * thru * 0.5 * sh;
  o = vec4(c, 1.0);
}
`;

/**
 * The multitude: thousands of cranes over the wintering water, flowing in
 * the vertex shader. `rise` lifts them from standing to one great turning.
 */
export class Multitude {
  readonly mesh: THREE.Mesh;
  readonly u = {
    uCenter: { value: new THREE.Vector3() },
    uRise: { value: 0 },
    uSpread: { value: 900 },
  };

  constructor(count: number) {
    const base = birdGeo();
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', base.attributes.position);
    g.setAttribute('aTone', base.attributes.aTone);
    g.setIndex(base.index);
    const r = new Float32Array(count * 4);
    for (let i = 0; i < r.length; i++) r[i] = Math.random();
    g.setAttribute('iR', new THREE.InstancedBufferAttribute(r, 4));
    g.instanceCount = count;
    this.mesh = new THREE.Mesh(g, worldMaterial(MVERT, FRAG, this.u, { side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }
}

const MVERT = /* glsl */ `
${FULL}
${BIRD_FN}
in float aTone;
in vec4 iR;
uniform vec3 uCenter; uniform float uRise, uSpread;
out vec3 vW; out vec3 vN; out float vTone;
void main(){
  vec3 n;
  // each bird leaves the water in its own time
  float wake = smoothstep(iR.z * 0.75, iR.z * 0.75 + 0.25, uRise);
  float r0 = 16.0 + pow(iR.x, 0.72) * uSpread;
  float a0 = iR.y * 6.2832;
  vec2 stand = vec2(cos(a0), sin(a0)) * r0;
  // they stand in companies, not evenly
  stand += (vec2(nz(stand / 190.0).r, nz(stand / 190.0 + 0.5).r) - 0.5) * 60.0;
  float lane = pow(iR.x, 0.8);
  float rad = 38.0 + 400.0 * lane;
  float dir = iR.w > 0.2 ? 1.0 : -1.0;
  float w = dir * (13.0 + 4.0 * iR.y) / rad;
  float a = a0 + w * uTime;
  float h = 11.0 + 130.0 * pow(iR.z, 1.1) * (0.3 + 0.7 * lane) + 9.0 * sin(uTime * 0.21 + iR.w * 30.0 + a * 2.0);
  vec3 fly = vec3(cos(a) * rad, h, sin(a) * rad);
  fly.xz += 30.0 * vec2(sin(a * 2.0 + iR.z * 6.0), cos(a * 3.0 + iR.x * 6.0)) * lane;
  vec2 wp = uCenter.xz + stand;
  float gy = max(terrainH(wp), -0.3) + 0.9;
  vec3 st = vec3(stand.x, gy, stand.y);
  vec3 pos = mix(st, fly, wake * wake * (3.0 - 2.0 * wake));
  float yaw = mix(iR.w * 6.28, atan(sin(a) * dir, -cos(a) * dir), step(0.02, wake));
  float flap = mix(0.0, 0.35 + 0.65 * step(0.5, fract(uTime * 0.05 + iR.w * 9.0)), wake);
  flap = max(flap, (1.0 - smoothstep(0.3, 1.0, wake)) * step(0.01, wake));
  vec3 bp = position;
  // standing birds keep their wings in and their heads up
  if (wake < 0.02){ bp.x *= 0.13; if (bp.z < -0.6) bp.y += 1.0; if (bp.z > 0.6) { bp.y -= 0.9; bp.z = 0.1; } bp.z *= 0.75; }
  vec3 p = birdVert(bp, yaw, 0.3 * dir * wake, uTime * (6.5 + iR.x * 2.0) + iR.w * 40.0, 0.95 + 0.15 * iR.y, flap, 0.0, n);
  vec3 c = vec3(uCenter.x + pos.x, pos.y, uCenter.z + pos.z);
  // they part around whoever is watching
  vec2 away = c.xz - uCamPos.xz;
  float dh = length(away) + 0.001;
  c.xz = uCamPos.xz + away / dh * sqrt(dh * dh + 260.0 * min(1.0, wake * 5.0));
  float d = length(c - uCamPos);
  vW = c + p * max(1.0, d / 420.0); vN = n; vTone = aTone;
  gl_Position = projectionMatrix * viewMatrix * vec4(vW, 1.0);
}
`;
