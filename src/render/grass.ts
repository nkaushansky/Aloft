import * as THREE from 'three';
import { FULL } from './glsl/common';
import { Uniforms, worldMaterial } from './globals';
import type { Movement } from '../game/days';

/**
 * The near ground: a ring of grass that follows you, bending in the same
 * gusts the trees and water feel. It only exists where you can see it, and
 * only matters when you fly low enough to brush it.
 */
export class Grass {
  private meshes: THREE.Mesh[] = [];
  private readonly u: Uniforms;
  private readonly group = new THREE.Group();
  radius = 110;

  constructor(scene: THREE.Scene, style: Record<string, THREE.IUniform>, private amount = 1) {
    scene.add(this.group);
    this.u = {
      ...style,
      gTall: { value: 1 },
      gA: { value: new THREE.Color() },
      gB: { value: new THREE.Color() },
      gTip: { value: new THREE.Color() },
      gF0: { value: new THREE.Color() },
      gF1: { value: new THREE.Color() },
      uR: { value: this.radius },
      gLand: { value: 0 },
    };
    this.build();
  }

  setAmount(a: number): void {
    if (a === this.amount) return;
    this.amount = a;
    for (const m of this.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
    }
    this.meshes = [];
    this.build();
  }

  private build(): void {
    if (this.amount <= 0) return;
    const mk = (n: number, kind: number, blades: number) => {
      // a tuft: several blades fanned from one root
      const pos: number[] = [];
      const idx: number[] = [];
      for (let b = 0; b < blades; b++) {
        const base = pos.length / 3;
        // x = side(-1..1), y = height 0..1, z = blade index
        for (const [s, h] of [
          [-1, 0],
          [1, 0],
          [-0.8, 0.45],
          [0.8, 0.45],
          [0, 1],
        ])
          pos.push(s, h, b);
        idx.push(base, base + 1, base + 2, base + 2, base + 1, base + 3, base + 2, base + 3, base + 4);
      }
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      const inst = new Float32Array(n * n * 2);
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) {
          inst[(j * n + i) * 2] = i;
          inst[(j * n + i) * 2 + 1] = j;
        }
      g.setAttribute('iC', new THREE.InstancedBufferAttribute(inst, 2));
      g.instanceCount = n * n;
      const m = new THREE.Mesh(
        g,
        worldMaterial(VERT, FRAG, { ...this.u, uN: { value: n }, uKind: { value: kind }, uBlades: { value: blades } }, { side: THREE.DoubleSide }),
      );
      m.frustumCulled = false;
      this.group.add(m);
      this.meshes.push(m);
    };
    const k = Math.sqrt(this.amount);
    mk(Math.round(230 * k), 0, 6);
    mk(Math.round(96 * k), 1, 5); // reeds
    mk(Math.round(84 * k), 2, 3); // flowers
  }

  setStyle(g: Movement['grass'], land: number): void {
    this.u.gTall.value = g.tall;
    (this.u.gA.value as THREE.Color).set(g.colorA);
    (this.u.gB.value as THREE.Color).set(g.colorB);
    (this.u.gTip.value as THREE.Color).set(g.tip);
    (this.u.gF0.value as THREE.Color).set(g.flowers[0]);
    (this.u.gF1.value as THREE.Color).set(g.flowers[1]);
    this.u.gLand.value = land;
  }

  update(agl: number): void {
    const on = agl < 130;
    for (const m of this.meshes) m.visible = on;
    this.u.uR.value = this.radius;
  }
}

const VERT = /* glsl */ `
${FULL}
in vec2 iC;
uniform float uN, uKind, uBlades, uR, gTall, gLand;
uniform vec3 sGrassA, sGrassB, sDry;
uniform vec3 gA, gB, gTip, gF0, gF1;
out vec3 vC;
out vec3 vW;
out vec3 vN;
out float vT;
void main(){
  float cell = 2.0 * uR / uN;
  vec2 cc = floor(uCamPos.xz / cell);
  vec2 id = mod(iC - cc, uN);         // wrap so each tuft keeps its place in the world
  vec2 gid = cc + id - floor(uN * 0.5);
  vec2 rnd = hash22(gid + uKind * 37.0);
  vec2 rnd2 = hash22(gid * 1.7 + 11.0 + uKind * 5.0);
  vec2 xz = (gid + 0.5 + (rnd - 0.5) * 0.95) * cell;
  float dxz = length(xz - uCamPos.xz);
  float fade = 1.0 - smoothstep(uR * 0.62, uR * 0.98, dxz);
  vec2 muv = xz / (2.0 * uWorld.x) + 0.5;
  float y = terrainH(xz);
  vec4 mk = textureLod(uMaskTex, muv, 0.0);
  vec4 nt = textureLod(uNormalTex, muv, 0.0);
  float keep = 1.0;
  float h;
  float m2 = textureLod(uNoise, xz / 430.0 + 0.37, 0.0).r;
  float m1 = textureLod(uNoise, xz / 1900.0, 0.0).r;
  float patchy = textureLod(uNoise, xz / 37.0, 0.0).r;
  if (uKind < 0.5){
    keep = step(rnd2.x, mk.g * 1.05 - mk.b * 0.9 - mk.r * 0.35) * step(0.55, y) * smoothstep(0.3, 0.5, patchy + mk.g * 0.25);
    if (gLand == 2.0) keep *= step(mk.a, 0.3);
    h = gTall * (0.3 + 0.36 * rnd.x) * (0.55 + 0.8 * patchy) * (0.65 + 0.5 * fract(rnd.x * 9.0 + position.z * 0.61));
  } else if (uKind < 1.5){
    // reeds keep to the edge of the water
    float edge = smoothstep(-0.75, -0.2, y) * (1.0 - smoothstep(0.5, 1.5, y));
    float bed = smoothstep(0.42, 0.56, textureLod(uNoise, xz / 120.0 + 0.2, 0.0).r);
    keep = step(rnd2.x, edge * bed * 1.2) * step(0.1, mk.g + edge) * step(mk.b, 0.5);
    if (gLand == 3.0 || gLand == 4.0 || gLand == 2.0) keep *= 0.0;
    h = (1.2 + 1.3 * rnd.x) * (0.6 + 0.5 * fract(rnd.x * 9.0 + position.z * 0.61));
  } else {
    keep = step(rnd2.x, (mk.g - mk.b - mk.r * 0.6) * smoothstep(0.5, 0.66, textureLod(uNoise, xz / 75.0 + 0.6, 0.0).r)) * step(0.7, y);
    if (gLand == 2.0) keep *= step(mk.a, 0.3);
    h = gTall * (0.5 + 0.4 * rnd.x);
  }
  h *= fade * keep;
  float b = position.z;
  float ang = rnd.y * 6.283 + b * 6.283 / uBlades + rnd2.y;
  vec2 dir = vec2(cos(ang), sin(ang));
  float t = position.y;
  float spread = uKind < 0.5 ? 0.42 : 0.22;
  vec3 p = vec3(xz.x, y - 0.04, xz.y);
  p.xz += dir * (0.10 + 0.16 * fract(rnd.y * 7.0 + b * 0.37)) * (1.0 + rnd.x);
  // gusts roll through as one wave
  vec2 wd = normalize(uWind + vec2(1e-4));
  float ws = length(uWind);
  vec2 q = xz - uWind * uTime * 1.7;
  float g = textureLod(uNoise, vec2(dot(q, wd) / 260.0, dot(q, vec2(-wd.y, wd.x)) / 780.0), 0.0).r;
  g = smoothstep(0.4, 0.8, g);
  float fl = sin(uTime * 3.1 + rnd.x * 20.0 + xz.x * 0.4) * 0.08;
  vec2 bend = dir * spread * (0.4 + 0.6 * rnd2.x) + wd * (0.08 + 0.055 * ws * (0.35 + 1.1 * g)) + fl * wd.yx;
  // the bird's passing presses it down and outward
  vec2 bd = xz - uBirdPos.xz;
  float bl = length(bd) + 1e-3;
  float press = smoothstep(9.0, 1.0, uBirdPos.y - y) * exp(-bl * bl / 18.0);
  bend += bd / bl * press * 0.9;
  p.y += h * t * (1.0 - 0.22 * dot(bend, bend) * t);
  p.xz += bend * h * t * t;
  // width holds up at distance so fields don't go bald
  float w = (0.0075 + 0.0008 * dxz) * (uKind < 0.5 ? 1.0 : uKind < 1.5 ? 1.0 : 1.0) * smoothstep(0.0, 0.02, h) * (0.7 + 0.6 * rnd2.y);
  // anything brushing the lens gets out of the way
  h *= smoothstep(0.9, 2.6, length(vec3(xz.x, y + 0.6, xz.y) - uCamPos));
  vec3 toCam = normalize(uCamPos - p);
  vec3 side = normalize(cross(vec3(0.0, 1.0, 0.0), toCam));
  p += side * position.x * w * (1.0 - t * 0.75) ;
  vec3 col;
  if (uKind < 1.5){
    col = mix(gA, gB, sat(m2 * 1.5 - 0.25 + (rnd2.y - 0.5) * 0.5));
    col = mix(col, sDry, sat((m1 - 0.42) * 1.5) * 0.5);
    if (uKind > 0.5) col = mix(col, gTip * 0.8, 0.35 + 0.3 * rnd.x);
    col = mix(col * 0.48, mix(col, gTip, 0.55 + 0.3 * g), t * t * 0.9 + 0.1 * t);
  } else {
    vec3 stem = gA * 0.8;
    vec3 fcol = rnd2.y > 0.45 ? gF0 : gF1;
    col = mix(stem, fcol, smoothstep(0.55, 0.8, t));
    p += side * position.x * 0.05 * smoothstep(0.5, 0.8, t) * step(0.01, h);
    p.y += 0.03 * t;
  }
  vC = col;
  vW = p;
  vT = t;
  vec3 gn; gn.xz = nt.xy * 2.0 - 1.0; gn.y = sqrt(max(0.0, 1.0 - dot(gn.xz, gn.xz)));
  vN = normalize(gn + vec3(dir.x, 0.0, dir.y) * 0.25 + vec3(bend.x, 0.0, bend.y) * 0.4);
  gl_Position = h <= 0.001 ? vec4(0.0, 0.0, 2.0, 1.0) : projectionMatrix * viewMatrix * vec4(p, 1.0);
}
`;

const FRAG = /* glsl */ `
${FULL}
in vec3 vC;
in vec3 vW;
in vec3 vN;
in float vT;
layout(location = 0) out vec4 o;
void main(){
  vec3 V = normalize(uCamPos - vW);
  vec3 N = normalize(vN);
  float sh = keyShadow(vW, 0.0016) * birdShadow(vW);
  float ao = mix(0.5, 1.0, vT);
  float nl = sat((dot(N, uKeyDir) + 0.35) / 1.35);
  vec3 c = vC * (uKeyCol * nl * sh * ao + ambient(N, ao));
  float back = pow(sat(dot(-V, uKeyDir)), 3.0);
  c += vC * uKeyCol * back * sh * vT * 1.15;
  vec3 H = normalize(V + uKeyDir);
  c += uKeyCol * sh * pow(sat(dot(N, H)), 22.0) * 0.10 * vT;
  o = vec4(c, 1.0);
}
`;
