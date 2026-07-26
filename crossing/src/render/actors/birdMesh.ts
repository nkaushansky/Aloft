/**
 * THE BIRD.
 *
 * This is the only mesh on screen every single frame, so it carries more
 * character per triangle than anything else in the game. It is built in code
 * from flat-shaded facets — no external assets — as a big soaring raptor:
 * long high-aspect wings, short deep body, fanned tail, small pale head.
 *
 * THE WING MORPH IS THE POINT. `bird.wing` is the skill layer made visible.
 * From behind, at a glance, at any speed, the silhouette has to answer the
 * question "what is this animal doing":
 *
 *   SPREAD (+1)  full span, slight FORWARD sweep, primaries splayed like
 *                fingers, tail fanned wide, shallow dihedral. Hanging.
 *   CRUISE ( 0)  wings level and straight, tail closed to a wedge.
 *   TUCK  (-1)   swept hard back and telescoped in, span visibly SHORTER,
 *                tail pinched, the whole animal narrowed into a dart.
 *
 * Every wing is a chain of four posable joints (shoulder, elbow, wrist, and
 * four independent primaries) so the morph is real articulation rather than a
 * blend shape. The wingtips flex UP under load and wash DOWN when unloaded,
 * which is the cheapest, most legible way to draw force.
 *
 * Also here, because they belong to the bird and must not cost more than two
 * draw calls: wingtip vortices (brief, spiralling, sun-tinted, additive) and
 * the contrail (thin, white, enormously long-lived) that turns a wave climb
 * into an achievement written across the sky.
 */

import * as THREE from 'three';
import { cruiseSpeed, type Config } from '../../sim/config';
import type { BirdState, QualitySettings, SkyState } from '../../sim/types';
import { TAU, clamp, clamp01, damp, lerp, smoothstep } from '../../sim/math';
import {
  ATMOSPHERE_PRELUDE,
  ATMOSPHERE_UNIFORMS_GLSL,
  withAtmosphere,
  type AtmosphereUniforms,
} from '../shaders/atmosphere';

// ===================================================================== SCALE
//
// A big albatross-sized animal: 5.2 m span, 1.9 m body. At the default chase
// camera (15.5 m back, 62° FOV) that fills about a third of the frame width —
// enough that the wing morph is legible without the bird eating the world.

const BODY_TINT_NECK = 0.34;
const BODY_TINT_MID = 0.08;
const BODY_TINT_TAIL = 0.05;
const HEAD_TINT = 0.88;
const BEAK_TINT = 0.3;

/** Half-span budget, metres. Sums to 2.60 → 5.2 m of wing. */
const INNER_LEN = 0.62;
const MID_LEN = 0.72;
const OUTER_LEN = 0.8;
const PRIM_LEN = 0.46;

/** Chord (front-to-back) at each joint. Mean ~0.38 → aspect ratio ~13. */
const CHORD_ROOT = 0.62;
const CHORD_ELBOW = 0.5;
const CHORD_WRIST = 0.34;
const CHORD_TIP = 0.15;

/** Section thickness at each joint. Thin enough to read as a wing, not a plank. */
const THICK_ROOT = 0.085;
const THICK_ELBOW = 0.055;
const THICK_WRIST = 0.03;
const THICK_TIP = 0.013;

/** Washout: the outer panel flies at a lower angle than the root. Real wings do. */
const TWIST_WRIST = -0.04;
const TWIST_TIP = -0.13;

const PRIMARIES = 4;

/** Shoulder joint, in body space. */
const SHOULDER_X = 0.15;
const SHOULDER_Y = 0.055;
const SHOULDER_Z = -0.12;

// -------------------------------------------------------------- pose targets
//
// Three columns everywhere: cruise, spread, tuck. Sweep is positive-backward;
// dihedral is positive-up. Read down the tuck column and you can see the dart.

const SWEEP_INNER = [0.02, -0.12, 0.44];
const SWEEP_MID = [0.04, -0.05, 0.36];
const SWEEP_OUTER = [0.06, 0.03, 0.32];

const DIHED_INNER = [0.05, 0.075, 0.14];
const DIHED_MID = [0.02, 0.045, -0.02];
const DIHED_OUTER = [0.0, 0.035, -0.13];

/**
 * Joint spacing multipliers. Sweep alone already shortens the span; telescoping
 * the joints in on top of it is what makes a tucked wing look *drawn in* rather
 * than merely angled. Fully tucked, the effective half-span falls to ~48%.
 */
const TELE_MID = [1, 1, 0.9];
const TELE_OUTER = [1, 1, 0.88];
const TELE_PRIM = [1, 1.02, 0.8];

/** Wingtip flex per g of load, and how far it may travel either way. */
const FLEX_PER_G = 0.3;
const FLEX_MIN = -0.34;
const FLEX_MAX = 0.62;
/** How much of the flex each joint takes. The hand does nearly all the bending. */
const FLEX_MID = 0.35;
const FLEX_OUTER = 1.0;

/** Extra tip-up on the inside wing of a turn. Reads as "leaning into it". */
const BANK_TIP = 0.2;

/** A lazy beat is 1.35 s, and never happens unless slow AND sinking hard. */
const BEAT_PERIOD = 1.35;
const BEAT_GAP = 5.5;
const BEAT_AMP_INNER = 0.62;
const BEAT_AMP_MID = 0.34;
const BEAT_AMP_OUTER = 0.5;

// ------------------------------------------------------------------- trails

const VORTEX_LIFE = 1.5;
const VORTEX_WIDTH = 0.34;
const VORTEX_SPIRAL_R = 0.22;
/** Radians of spiral per second of age. The two tips counter-rotate, as real ones do. */
const VORTEX_SPIRAL_RATE = 7.5;

const CONTRAIL_LIFE = 18;
const CONTRAIL_WIDTH = 0.3;

/** Anything further than this from the last point means the bird teleported. */
const TRAIL_BREAK = 60;

const ORDER_CONTRAIL = 24;
const ORDER_VORTEX = 25;

// Module scratch. Nothing below may allocate once the game is running.
const _ringA = new Float32Array(24);
const _ringB = new Float32Array(24);
const _ringC = new Float32Array(24);

/**
 * Three-way pose blend. `sp` and `tk` are mutually exclusive (one is always
 * zero), so this is an exact lerp toward whichever end the wing is heading for.
 * Scalars rather than a triple, because this is called ~40 times a frame and
 * nothing in here is allowed to allocate.
 */
const blend = (base: number, sV: number, tV: number, sp: number, tk: number): number =>
  base + (sV - base) * sp + (tV - base) * tk;

/** Same, reading a fixed [cruise, spread, tuck] table without copying it. */
const blend3 = (v: readonly number[], sp: number, tk: number): number =>
  v[0] + (v[1] - v[0]) * sp + (v[2] - v[0]) * tk;

// =================================================================== GEOMETRY

/**
 * A flat-shaded triangle soup builder. Every triangle carries its own face
 * normal on all three vertices — that is the faceting, and the faceting is the
 * whole look. `ref` is an outward reference direction: winding is corrected
 * against it automatically, so no build code below has to reason about it.
 */
class Facets {
  private readonly px: number[] = [];
  private readonly nx: number[] = [];
  private readonly tn: number[] = [];
  /** Set to -1 to build the mirrored (left) copy. Winding follows. */
  mirror = 1;

  triRef(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    ta: number, tb: number, tc: number,
    rx: number, ry: number, rz: number,
  ): void {
    const m = this.mirror;
    const a0 = ax * m;
    let b0 = bx * m;
    let c0 = cx * m;
    let bY = by;
    let bZ = bz;
    let cY = cy;
    let cZ = cz;
    let tB = tb;
    let tC = tc;

    // Face normal from the edge cross product — this IS the flat shading.
    let nX = (bY - ay) * (cZ - az) - (bZ - az) * (cY - ay);
    let nY = (bZ - az) * (c0 - a0) - (b0 - a0) * (cZ - az);
    let nZ = (b0 - a0) * (cY - ay) - (bY - ay) * (c0 - a0);

    if (nX * (rx * m) + nY * ry + nZ * rz < 0) {
      const sx = b0; const sy = bY; const sz = bZ; const st = tB;
      b0 = c0; bY = cY; bZ = cZ; tB = tC;
      c0 = sx; cY = sy; cZ = sz; tC = st;
      nX = -nX; nY = -nY; nZ = -nZ;
    }

    const l = Math.hypot(nX, nY, nZ);
    if (l < 1e-9) return; // degenerate sliver — not worth a facet
    nX /= l; nY /= l; nZ /= l;

    this.px.push(a0, ay, az, b0, bY, bZ, c0, cY, cZ);
    this.nx.push(nX, nY, nZ, nX, nY, nZ, nX, nY, nZ);
    this.tn.push(ta, tB, tC);
  }

  quadRef(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    ta: number, tb: number, tc: number, td: number,
    rx: number, ry: number, rz: number,
  ): void {
    this.triRef(ax, ay, az, bx, by, bz, cx, cy, cz, ta, tb, tc, rx, ry, rz);
    this.triRef(ax, ay, az, cx, cy, cz, dx, dy, dz, ta, tc, td, rx, ry, rz);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.px), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nx), 3));
    g.setAttribute('aTint', new THREE.BufferAttribute(new Float32Array(this.tn), 1));
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * The four points of a wing section, as fractions of chord and thickness:
 * leading edge, upper crown, trailing edge, lower belly. Four points is enough
 * to read as an aerofoil and few enough that every panel is a hard facet.
 */
const SECTION_Z = [-0.35, 0.02, 0.65, 0.02];
const SECTION_Y = [0.0, 0.55, -0.04, -0.35];

/** Four-point airfoil section at station `x`, written as x,y,z ×4. */
function airfoilRing(
  out: Float32Array,
  x: number,
  chord: number,
  thick: number,
  twist: number,
): void {
  const pz = SECTION_Z;
  const py = SECTION_Y;
  const cs = Math.cos(twist);
  const sn = Math.sin(twist);
  for (let i = 0; i < 4; i++) {
    const z0 = pz[i] * chord;
    const y0 = py[i] * thick;
    out[i * 3] = x;
    out[i * 3 + 1] = y0 * cs - z0 * sn;
    out[i * 3 + 2] = y0 * sn + z0 * cs;
  }
}

/** Hexagonal body section at station `z`. `flat` squashes it in X. */
function tubeRing(out: Float32Array, z: number, r: number, cy: number, flat: number): void {
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * TAU) / 6;
    out[i * 3] = Math.cos(a) * r * flat;
    out[i * 3 + 1] = cy + Math.sin(a) * r;
    out[i * 3 + 2] = z;
  }
}

/** Skin two rings of the same vertex count. Tint gradients from A to B. */
function ringPrism(
  b: Facets,
  ra: Float32Array,
  rb: Float32Array,
  n: number,
  tA: number,
  tB: number,
): void {
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += ra[i * 3] + rb[i * 3];
    cy += ra[i * 3 + 1] + rb[i * 3 + 1];
    cz += ra[i * 3 + 2] + rb[i * 3 + 2];
  }
  const inv = 1 / (2 * n);
  cx *= inv; cy *= inv; cz *= inv;

  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ra[i * 3]; const ay = ra[i * 3 + 1]; const az = ra[i * 3 + 2];
    const dx = ra[j * 3]; const dy = ra[j * 3 + 1]; const dz = ra[j * 3 + 2];
    const ex = rb[j * 3]; const ey = rb[j * 3 + 1]; const ez = rb[j * 3 + 2];
    const fx = rb[i * 3]; const fy = rb[i * 3 + 1]; const fz = rb[i * 3 + 2];
    b.quadRef(
      ax, ay, az, dx, dy, dz, ex, ey, ez, fx, fy, fz,
      tA, tA, tB, tB,
      (ax + dx + ex + fx) * 0.25 - cx,
      (ay + dy + ey + fy) * 0.25 - cy,
      (az + dz + ez + fz) * 0.25 - cz,
    );
  }
}

/** Close a ring with a flat fan. */
function ringCap(
  b: Facets,
  r: Float32Array,
  n: number,
  t: number,
  rx: number, ry: number, rz: number,
): void {
  for (let i = 1; i < n - 1; i++) {
    b.triRef(
      r[0], r[1], r[2],
      r[i * 3], r[i * 3 + 1], r[i * 3 + 2],
      r[(i + 1) * 3], r[(i + 1) * 3 + 1], r[(i + 1) * 3 + 2],
      t, t, t, rx, ry, rz,
    );
  }
}

/** Close a ring onto a single point — nose cones, tail points. */
function ringCone(
  b: Facets,
  r: Float32Array,
  n: number,
  px: number, py: number, pz: number,
  tRing: number,
  tTip: number,
): void {
  let cx = 0; let cy = 0; let cz = 0;
  for (let i = 0; i < n; i++) {
    cx += r[i * 3]; cy += r[i * 3 + 1]; cz += r[i * 3 + 2];
  }
  cx /= n; cy /= n; cz /= n;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = r[i * 3]; const ay = r[i * 3 + 1]; const az = r[i * 3 + 2];
    const bx = r[j * 3]; const by = r[j * 3 + 1]; const bz = r[j * 3 + 2];
    b.triRef(
      ax, ay, az, bx, by, bz, px, py, pz,
      tRing, tRing, tTip,
      (ax + bx + px) / 3 - cx, (ay + by + py) / 3 - cy, (az + bz + pz) / 3 - cz,
    );
  }
}

/** One tapered wing bone: a swept airfoil with optional end caps. */
function wingBone(
  b: Facets,
  len: number,
  c0: number, c1: number,
  t0: number, t1: number,
  w0: number, w1: number,
  tint0: number, tint1: number,
  capRoot: boolean,
  capTip: boolean,
): void {
  airfoilRing(_ringA, 0, c0, t0, w0);
  airfoilRing(_ringB, len, c1, t1, w1);
  ringPrism(b, _ringA, _ringB, 4, tint0, tint1);
  if (capRoot) ringCap(b, _ringA, 4, tint0, -1, 0, 0);
  if (capTip) ringCap(b, _ringB, 4, tint1, 1, 0, 0);
}

// ==================================================================== SHADERS

const BIRD_VERTEX = /* glsl */ `
${ATMOSPHERE_UNIFORMS_GLSL}

attribute float aTint;

varying vec3  vWorld;
varying vec3  vNrm;
varying vec3  vLocal;
varying float vTint;
varying float vBelly;

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  // No inverse-transpose: nothing in the rig carries a non-uniform scale except
  // the tail, and the tail is a flat plate scaled only in the plane it lies in,
  // so its ±Y normals survive this untouched.
  vNrm  = mat3(modelMatrix) * normal;
  vLocal = position;
  vTint = aTint;
  // "Underside" is measured in the BIRD's own frame, so a bird rolled inverted
  // keeps its dark belly instead of turning into a lit ceiling.
  vBelly = normal.y;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

function birdFragment(grain: boolean): string {
  const mottle = grain
    ? `
  // Barely-there feather mottling. Its only job is to stop big flat facets from
  // reading as painted plastic; if you can consciously see it, it is too strong.
  albedo *= 0.88 + 0.24 * afbm3(vLocal * 11.0, 3);`
    : '';

  return /* glsl */ `
${ATMOSPHERE_PRELUDE}

uniform vec3  uDark;
uniform vec3  uPale;
uniform vec3  uBelly;
uniform float uRim;

varying vec3  vWorld;
varying vec3  vNrm;
varying vec3  vLocal;
varying float vTint;
varying float vBelly;

void main() {
  vec3 N = normalize(vNrm);
  if (!gl_FrontFacing) N = -N;

  vec3 toFrag = vWorld - uCameraPos;
  float dist = length(toFrag);
  vec3 viewDir = toFrag / max(dist, 0.001);

  vec3 albedo = mix(uDark, uPale, clamp(vTint, 0.0, 1.0));
  albedo = mix(albedo, albedo * uBelly, smoothstep(0.25, -0.55, vBelly));${mottle}

  vec3 col = shadeSurface(albedo, N, viewDir, 1.0);

  // THE PICTURE. A backlit bird at dawn is a black shape with a burning edge,
  // and that single frame is the art direction of the whole game. The rim runs
  // hot on purpose — above 1.0 is where bloom lives.
  float fres = pow(1.0 - clamp(dot(N, -viewDir), 0.0, 1.0), 2.6);
  float backlit = pow(clamp(dot(-viewDir, uSunDir) * 0.5 + 0.5, 0.0, 1.0), 3.0);
  // Toned down from (0.18 + 2.6): shadeSurface already contributes a rim, and
  // the two stacked turned the bird into a white plank under a high sun. This
  // still burns at dawn and dusk, which is when it is supposed to.
  col += uSunColor * uSunIntensity * fres * (0.10 + 0.85 * backlit) * uRim;

  // Moonlight, so the silhouette still exists at the top of the night.
  float mdl = clamp(dot(N, uMoonDir) * 0.5 + 0.5, 0.0, 1.0);
  col += albedo * vec3(0.16, 0.21, 0.38) * uStars * (0.35 + 0.65 * mdl);

  col = aerialPerspective(col, vWorld, viewDir, dist);
  col += ditherValue(gl_FragCoord.xy);
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}
`;
}

const TRAIL_VERTEX = /* glsl */ `
${ATMOSPHERE_UNIFORMS_GLSL}

attribute vec3 aTangent;
attribute vec3 aParam;   // side (-1/+1), half width, alpha

varying vec3  vWorld;
varying float vSide;
varying float vA;

void main() {
  // The ribbon widens across the screen, not across some fixed axis, so a trail
  // reads the same thickness whether you are behind it or beside it.
  vec3 toCam = uCameraPos - position;
  vec3 v = toCam / max(length(toCam), 0.001);
  vec3 side = cross(aTangent, v);
  float sl = length(side);
  // Sighting straight down the trail: the cross product collapses, so fall back
  // to the camera's own right vector rather than letting the ribbon vanish.
  side = sl > 1e-4 ? side / sl : vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);

  vec3 world = position + side * (aParam.x * aParam.y);
  vWorld = world;
  vSide  = aParam.x;
  vA     = aParam.z;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

function trailFragment(additive: boolean): string {
  const depth = additive
    ? `
  // Additive light travels the same air as everything else, but *mixing* toward
  // the fog colour would make a vortex brighten the haze instead of vanishing
  // into it — so the shared atmosphere attenuates it instead of tinting it.
  a *= exp(-dist * uFogDensity * 620.0);
  vec3 col = lit;`
    : `
  vec3 col = aerialPerspective(lit, vWorld, viewDir, dist);`;

  return /* glsl */ `
${ATMOSPHERE_PRELUDE}

uniform vec3  uTint;
uniform float uGain;
uniform float uSunGain;

varying vec3  vWorld;
varying float vSide;
varying float vA;

void main() {
  // Soft across the ribbon — a hard-edged strip reads as a decal every time.
  float a = vA * (1.0 - vSide * vSide);
  if (a < 0.004) discard;

  vec3 toFrag = vWorld - uCameraPos;
  float dist = length(toFrag);
  vec3 viewDir = toFrag / max(dist, 0.001);

  // Condensation is water: it scatters forward hard, which is exactly why a
  // trail drawn across a low sun is the brightest thing in the frame.
  float fwd = miePhase(dot(viewDir, uSunDir), 0.62);
  vec3 lit = uTint * uSunColor * uSunIntensity * (0.55 + 2.4 * fwd) * uSunGain;
  lit += uTint * uAmbient * uAmbientIntensity * 0.55;
  lit += uTint * skyColor(vec3(0.0, 1.0, 0.0)) * 0.22;
  lit += uTint * vec3(0.10, 0.14, 0.26) * uStars;
${depth}

  gl_FragColor = vec4(max(col * uGain, vec3(0.0)), clamp(a, 0.0, 1.0));
}
`;
}

// ===================================================================== TRAILS

/**
 * A ring buffer of world-space trail points. Fixed capacity, no growth, no
 * allocation after construction: points are appended at the head and expire off
 * the tail purely by age, so a trail always fades cleanly when emission stops.
 */
class TrailStrand {
  readonly px: Float32Array;
  readonly py: Float32Array;
  readonly pz: Float32Array;
  readonly pBirth: Float32Array;
  readonly pStr: Float32Array;
  readonly cap: number;
  head = 0;
  count = 0;

  constructor(cap: number) {
    this.cap = Math.max(cap, 2);
    this.px = new Float32Array(this.cap);
    this.py = new Float32Array(this.cap);
    this.pz = new Float32Array(this.cap);
    this.pBirth = new Float32Array(this.cap);
    this.pStr = new Float32Array(this.cap);
  }

  /** Buffer index of the k-th point counting from the oldest. */
  at(k: number): number {
    return (this.head - this.count + 1 + k + this.cap * 2) % this.cap;
  }

  expire(now: number, life: number): void {
    while (this.count > 0 && now - this.pBirth[this.at(0)] >= life) this.count--;
  }

  push(x: number, y: number, z: number, now: number, str: number): void {
    this.head = (this.head + 1) % this.cap;
    if (this.count < this.cap) this.count++;
    const i = this.head;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.pBirth[i] = now;
    this.pStr[i] = str;
  }

  /** Squared distance from the newest point, or Infinity if empty. */
  headDist2(x: number, y: number, z: number): number {
    if (this.count === 0) return Infinity;
    const i = this.head;
    const dx = x - this.px[i];
    const dy = y - this.py[i];
    const dz = z - this.pz[i];
    return dx * dx + dy * dy + dz * dz;
  }

  clear(): void {
    this.count = 0;
  }
}

/**
 * One draw call's worth of ribbon: N strands of `cap` points, two vertices per
 * point, one index buffer built once. Unused points collapse onto the last live
 * position so their triangles are exactly degenerate and cost nothing.
 */
class Ribbon {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;
  readonly cap: number;
  private readonly geo = new THREE.BufferGeometry();
  private readonly posArr: Float32Array;
  private readonly tanArr: Float32Array;
  private readonly parArr: Float32Array;
  private readonly aPos: THREE.BufferAttribute;
  private readonly aTan: THREE.BufferAttribute;
  private readonly aPar: THREE.BufferAttribute;

  constructor(material: THREE.ShaderMaterial, strands: number, cap: number, order: number) {
    this.material = material;
    this.cap = cap;
    const verts = strands * cap * 2;

    this.posArr = new Float32Array(verts * 3);
    this.tanArr = new Float32Array(verts * 3);
    this.parArr = new Float32Array(verts * 3);
    this.aPos = new THREE.BufferAttribute(this.posArr, 3);
    this.aTan = new THREE.BufferAttribute(this.tanArr, 3);
    this.aPar = new THREE.BufferAttribute(this.parArr, 3);
    this.aPos.setUsage(THREE.DynamicDrawUsage);
    this.aTan.setUsage(THREE.DynamicDrawUsage);
    this.aPar.setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.aPos);
    this.geo.setAttribute('aTangent', this.aTan);
    this.geo.setAttribute('aParam', this.aPar);

    const idx = new Uint16Array(strands * (cap - 1) * 6);
    let w = 0;
    for (let s = 0; s < strands; s++) {
      for (let k = 0; k < cap - 1; k++) {
        const v = (s * cap + k) * 2;
        idx[w++] = v; idx[w++] = v + 1; idx[w++] = v + 2;
        idx[w++] = v + 2; idx[w++] = v + 1; idx[w++] = v + 3;
      }
    }
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));

    this.mesh = new THREE.Mesh(this.geo, material);
    // The vertices are already world-space and move every frame, so a bounding
    // sphere would be a lie. Culling is the trail's own business.
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = order;
  }

  setPoint(
    s: number, k: number,
    x: number, y: number, z: number,
    tx: number, ty: number, tz: number,
    halfW: number, alpha: number,
  ): void {
    const v = (s * this.cap + k) * 2;
    const i0 = v * 3;
    const i1 = i0 + 3;
    this.posArr[i0] = x; this.posArr[i0 + 1] = y; this.posArr[i0 + 2] = z;
    this.posArr[i1] = x; this.posArr[i1 + 1] = y; this.posArr[i1 + 2] = z;
    this.tanArr[i0] = tx; this.tanArr[i0 + 1] = ty; this.tanArr[i0 + 2] = tz;
    this.tanArr[i1] = tx; this.tanArr[i1 + 1] = ty; this.tanArr[i1 + 2] = tz;
    this.parArr[i0] = -1; this.parArr[i0 + 1] = halfW; this.parArr[i0 + 2] = alpha;
    this.parArr[i1] = 1; this.parArr[i1 + 1] = halfW; this.parArr[i1 + 2] = alpha;
  }

  /** Park a whole strand somewhere harmless and invisible. */
  blank(s: number): void {
    for (let k = 0; k < this.cap; k++) {
      this.setPoint(s, k, 0, -1e6, 0, 0, 0, 1, 0, 0);
    }
  }

  flush(): void {
    this.aPos.needsUpdate = true;
    this.aTan.needsUpdate = true;
    this.aPar.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
  }
}

interface WingRig {
  side: number;
  inner: THREE.Group;
  mid: THREE.Group;
  outer: THREE.Group;
  prim: THREE.Group[];
  tip: THREE.Object3D;
}

function trailCaps(tier: string): { vortex: number; contrail: number } {
  switch (tier) {
    case 'low':
      return { vortex: 16, contrail: 0 };
    case 'medium':
      return { vortex: 26, contrail: 110 };
    case 'ultra':
      return { vortex: 48, contrail: 224 };
    default:
      return { vortex: 38, contrail: 170 };
  }
}

// ================================================================ BIRD ACTOR

export class BirdActor {
  /**
   * The bird's own transform: position and attitude straight from the sim, so
   * anything that wants to hang off the animal can parent to this. The trails
   * live in world space and are added to the scene separately.
   */
  readonly group = new THREE.Group();

  private readonly trails = new THREE.Group();
  private readonly body = new THREE.Group();
  private readonly headPivot = new THREE.Group();
  private readonly tailPivot = new THREE.Group();
  private readonly contrailAnchor = new THREE.Object3D();
  private readonly wings: WingRig[] = [];

  private readonly material: THREE.ShaderMaterial;
  private readonly geos: THREE.BufferGeometry[] = [];

  private readonly vortexRib: Ribbon | null;
  private readonly contrailRib: Ribbon | null;
  private readonly vortexStrand: TrailStrand[] = [];
  private readonly contrailStrand: TrailStrand | null;

  private time = 0;
  private wingT = 0;
  private wingLag = 0;
  private flex = 0;
  private beat = -1;
  private beatWait = BEAT_GAP;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly cfg: Config,
    atmo: AtmosphereUniforms,
    quality: QualitySettings,
  ) {
    this.material = new THREE.ShaderMaterial({
      uniforms: withAtmosphere(atmo, {
        // Linear, and deliberately dark: a raptor is nearly black, and nearly
        // black is what makes the rim light mean something.
        uDark: { value: new THREE.Color(0.075, 0.058, 0.046) },
        uPale: { value: new THREE.Color(0.52, 0.47, 0.42) },
        uBelly: { value: new THREE.Color(0.34, 0.34, 0.38) },
        uRim: { value: 1.0 },
      }),
      vertexShader: BIRD_VERTEX,
      fragmentShader: birdFragment(quality.tier !== 'low'),
      // The wings are closed volumes and the winding is guaranteed by the
      // builder, but double-siding a 240-triangle hero mesh costs nothing and
      // removes any chance of a hole opening up in the player's own body.
      side: THREE.DoubleSide,
    });

    this.buildBody();
    this.buildHead();
    this.buildTail();
    this.wings.push(this.buildWing(1), this.buildWing(-1));

    this.contrailAnchor.position.set(0, 0.02, 0.86);
    this.body.add(this.contrailAnchor);

    this.group.rotation.order = 'YXZ';
    this.group.add(this.body);
    scene.add(this.group);

    // ---- trails ---------------------------------------------------------
    const caps = trailCaps(quality.tier);
    const sunTint = new THREE.Color(1, 1, 1);

    this.vortexRib = new Ribbon(
      new THREE.ShaderMaterial({
        uniforms: withAtmosphere(atmo, {
          uTint: { value: sunTint.clone() },
          uGain: { value: 1.35 },
          uSunGain: { value: 1.0 },
        }),
        vertexShader: TRAIL_VERTEX,
        fragmentShader: trailFragment(true),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
      }),
      2,
      caps.vortex,
      ORDER_VORTEX,
    );
    this.vortexStrand.push(new TrailStrand(caps.vortex), new TrailStrand(caps.vortex));
    this.trails.add(this.vortexRib.mesh);

    if (caps.contrail > 0) {
      this.contrailRib = new Ribbon(
        new THREE.ShaderMaterial({
          uniforms: withAtmosphere(atmo, {
            uTint: { value: sunTint.clone() },
            uGain: { value: 1.0 },
            uSunGain: { value: 0.85 },
          }),
          vertexShader: TRAIL_VERTEX,
          fragmentShader: trailFragment(false),
          transparent: true,
          depthWrite: false,
          blending: THREE.NormalBlending,
          side: THREE.DoubleSide,
        }),
        1,
        caps.contrail,
        ORDER_CONTRAIL,
      );
      this.contrailStrand = new TrailStrand(caps.contrail);
      this.trails.add(this.contrailRib.mesh);
    } else {
      this.contrailRib = null;
      this.contrailStrand = null;
    }

    this.trails.matrixAutoUpdate = false;
    scene.add(this.trails);
  }

  // ---------------------------------------------------------------- build

  private addMesh(parent: THREE.Object3D, b: Facets): THREE.Mesh {
    const g = b.build();
    this.geos.push(g);
    const m = new THREE.Mesh(g, this.material);
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    parent.add(m);
    return m;
  }

  /** Short, deep-chested, hexagonal in section. Silhouette over anatomy. */
  private buildBody(): void {
    const b = new Facets();
    const z = [-0.66, -0.36, 0.04, 0.46, 0.9];
    const r = [0.052, 0.14, 0.152, 0.1, 0.034];
    const cy = [0.04, 0.01, 0.0, 0.02, 0.055];
    const tint = [BODY_TINT_NECK, BODY_TINT_MID, BODY_TINT_MID, BODY_TINT_TAIL, BODY_TINT_TAIL];

    tubeRing(_ringA, z[0], r[0], cy[0], 0.95);
    ringCone(b, _ringA, 6, 0, 0.048, -0.76, tint[0], tint[0]);
    for (let i = 0; i < 4; i++) {
      tubeRing(_ringA, z[i], r[i], cy[i], 0.95);
      tubeRing(_ringB, z[i + 1], r[i + 1], cy[i + 1], 0.95);
      ringPrism(b, _ringA, _ringB, 6, tint[i], tint[i + 1]);
    }
    tubeRing(_ringA, z[4], r[4], cy[4], 0.95);
    ringCone(b, _ringA, 6, 0, 0.062, 1.02, tint[4], tint[4]);

    this.addMesh(this.body, b);
  }

  /** Small pale head on a pivot, with a hooked beak. It tucks as the nose drops. */
  private buildHead(): void {
    const b = new Facets();
    const z = [0.06, -0.06, -0.2, -0.3];
    const r = [0.075, 0.105, 0.088, 0.05];

    tubeRing(_ringA, z[0], r[0], 0, 1);
    ringCap(b, _ringA, 6, HEAD_TINT, 0, 0, 1);
    for (let i = 0; i < 3; i++) {
      tubeRing(_ringA, z[i], r[i], 0, 1);
      tubeRing(_ringB, z[i + 1], r[i + 1], 0, 1);
      ringPrism(b, _ringA, _ringB, 6, HEAD_TINT, HEAD_TINT);
    }
    // Beak: the ring narrows hard and drops to a hooked point below the axis.
    tubeRing(_ringC, z[3], r[3], 0, 1);
    tubeRing(_ringA, -0.38, 0.026, -0.008, 1);
    ringPrism(b, _ringC, _ringA, 6, HEAD_TINT, BEAK_TINT);
    ringCone(b, _ringA, 6, 0, -0.048, -0.5, BEAK_TINT, BEAK_TINT);

    this.headPivot.position.set(0, 0.105, -0.62);
    this.body.add(this.headPivot);
    this.addMesh(this.headPivot, b);
  }

  /**
   * A thin scalloped plate. It is scaled — wide when spread, pinched to a wedge
   * when tucked — and because the scale is in X and Z only, its ±Y normals come
   * through the model matrix untouched.
   */
  private buildTail(): void {
    const b = new Facets();
    const N = 7;
    const half = 0.34;
    const len = 0.7;
    const rtY = 0.02;

    let px = 0; let pz = 0; let pth = 0;
    for (let i = 0; i < N; i++) {
      const s = (i / (N - 1)) * 2 - 1;
      const x = s * half;
      // Longest down the middle, with a light scallop so the trailing edge
      // reads as separate feathers rather than a cut-out card.
      const z = len * (1 - 0.22 * s * s) + 0.022 * Math.cos(s * Math.PI * 3);
      const th = 0.016 * (1 - 0.5 * Math.abs(s));
      const t = 0.12 + 0.3 * Math.abs(s);

      if (i > 0) {
        b.triRef(0, rtY, 0, px, pth, pz, x, th, z, 0.08, t, t, 0, 1, 0);
        b.triRef(0, -rtY, 0, x, -th, z, px, -pth, pz, 0.08, t, t, 0, -1, 0);
        // trailing rim, closing the plate
        const mx = (px + x) * 0.5;
        const mz = (pz + z) * 0.5;
        b.quadRef(
          px, pth, pz, x, th, z, x, -th, z, px, -pth, pz,
          t, t, t, t,
          mx, 0, mz,
        );
      }
      px = x; pz = z; pth = th;
    }

    this.tailPivot.position.set(0, 0.045, 0.96);
    this.body.add(this.tailPivot);
    this.addMesh(this.tailPivot, b);
  }

  /**
   * One wing: shoulder → elbow → wrist → four primaries, each on its own pivot.
   * Built for +X and mirrored in the vertex data for the left side, so nothing
   * in the rig ever carries a negative scale.
   */
  private buildWing(side: number): WingRig {
    const inner = new THREE.Group();
    const mid = new THREE.Group();
    const outer = new THREE.Group();
    inner.position.set(side * SHOULDER_X, SHOULDER_Y, SHOULDER_Z);
    this.body.add(inner);
    inner.add(mid);
    mid.add(outer);

    const bi = new Facets(); bi.mirror = side;
    wingBone(bi, INNER_LEN, CHORD_ROOT, CHORD_ELBOW, THICK_ROOT, THICK_ELBOW, 0, 0, 0.3, 0.1, true, false);
    this.addMesh(inner, bi);

    const bm = new Facets(); bm.mirror = side;
    wingBone(bm, MID_LEN, CHORD_ELBOW, CHORD_WRIST, THICK_ELBOW, THICK_WRIST, 0, TWIST_WRIST, 0.1, 0.05, false, false);
    this.addMesh(mid, bm);

    const bo = new Facets(); bo.mirror = side;
    wingBone(bo, OUTER_LEN, CHORD_WRIST, CHORD_TIP, THICK_WRIST, THICK_TIP, TWIST_WRIST, TWIST_TIP, 0.05, 0.02, false, true);
    this.addMesh(outer, bo);

    const prim: THREE.Group[] = [];
    for (let i = 0; i < PRIMARIES; i++) {
      const u = i / (PRIMARIES - 1);
      const g = new THREE.Group();
      // The fingers sit at different chordwise stations, which is what lets the
      // fan open across the chord instead of into a single spike.
      g.position.set(side * OUTER_LEN, 0, lerp(-0.055, 0.075, u));
      outer.add(g);
      const bp = new Facets(); bp.mirror = side;
      wingBone(bp, PRIM_LEN, 0.115, 0.045, 0.026, 0.01, TWIST_TIP, TWIST_TIP * 1.4, 0.02, 0.0, true, true);
      this.addMesh(g, bp);
      prim.push(g);
    }

    // Vortices are shed from the true aerodynamic tip, which rides the outermost
    // finger — so they spread and close with the hand, not with the arm.
    const tip = new THREE.Object3D();
    tip.position.set(side * PRIM_LEN * 0.92, 0, 0);
    prim[PRIMARIES - 1].add(tip);

    return { side, inner, mid, outer, prim, tip };
  }

  // --------------------------------------------------------------- update

  update(dt: number, bird: BirdState, sky: SkyState, cameraPos: THREE.Vector3): void {
    const d = clamp(dt, 0, 0.1); // a tab-switch spike must not fling the rig
    this.time += d;

    this.group.position.set(bird.position.x, bird.position.y, bird.position.z);
    // yaw 0 faces -Z and positive yaw turns left, which is exactly three's own
    // Y rotation. Roll is negated because positive roll is right-wing-DOWN.
    this.group.rotation.set(bird.pitch, bird.yaw, -bird.roll);

    // ---- the morph, eased twice: once fast for the arm, once slow for the
    // hand, so the pose travels down the wing as a whip rather than a snap.
    this.wingT = damp(this.wingT, clamp(bird.wing, -1, 1), 12, d);
    this.wingLag = damp(this.wingLag, this.wingT, 5.5, d);
    const sp = Math.max(this.wingT, 0);
    const tk = Math.max(-this.wingT, 0);
    const spL = Math.max(this.wingLag, 0);
    const tkL = Math.max(-this.wingLag, 0);

    // ---- load. A wing that bends is the cheapest way to draw force, and the
    // unloaded case matters just as much: push over and the tips wash down.
    const flexT = clamp((bird.gForce - 1) * FLEX_PER_G, FLEX_MIN, FLEX_MAX);
    this.flex = damp(this.flex, flexT, 7, d);

    const rollN = clamp(bird.roll / Math.max(this.cfg.maxBank, 0.01), -1, 1);
    const pitchDown = clamp01(-bird.pitch / 0.7);
    const stall = clamp01(bird.stallBreak);
    const turb = clamp01(bird.turbulence);

    // ---- the rare, lazy beat. Soarers do not flap; this only fires when the
    // bird is genuinely slow and going down, and then only after a long wait.
    const cruise = cruiseSpeed(this.cfg, bird.wing);
    const wantBeat =
      !bird.landed && bird.flying > 0.15 && bird.airspeed < cruise * 0.92 && bird.climbRate < -1.8;
    if (this.beat >= 0) {
      this.beat += d / BEAT_PERIOD;
      if (this.beat >= 1) {
        this.beat = -1;
        this.beatWait = BEAT_GAP * (0.75 + 0.5 * (Math.sin(this.time * 3.7) * 0.5 + 0.5));
      }
    } else if (wantBeat) {
      this.beatWait -= d;
      if (this.beatWait <= 0) this.beat = 0;
    } else {
      this.beatWait = BEAT_GAP;
    }
    const env = this.beat >= 0 ? Math.sin(Math.PI * this.beat) : 0;
    const beat0 = this.beatAt(0, env);
    const beat1 = this.beatAt(0.08, env);
    const beat2 = this.beatAt(0.16, env);

    // ---- stall shudder and turbulence jitter, both small enough to feel
    // rather than see.
    const shR = Math.sin(this.time * 31) * stall * 0.09;
    const shL = Math.sin(this.time * 31 + 2.1) * stall * 0.09;

    const j1 = Math.sin(this.time * 23.7) + Math.sin(this.time * 37.1) * 0.6;
    const j2 = Math.sin(this.time * 29.3 + 1.7) + Math.sin(this.time * 41.9) * 0.6;
    const j3 = Math.sin(this.time * 33.1 + 0.9);
    const jt = turb * 0.018;
    this.body.position.set(j1 * jt, j2 * jt, 0);
    this.body.rotation.set(j2 * turb * 0.026, j3 * turb * 0.02, j1 * turb * 0.03 + shR * 0.4);

    // ---- head: tucks in as the nose drops, and looks into the turn.
    this.headPivot.rotation.set(-0.3 * pitchDown + 0.08 * clamp01(bird.pitch / 0.7), -0.2 * rollN, 0);
    this.headPivot.position.z = -0.62 + 0.055 * pitchDown;

    // ---- tail: fanned wide when spread, pinched to a spike when tucked,
    // closing further as the nose drops and splaying open as the bird mushes.
    let fan = blend(1, 1.6, 0.55, sp, tk) * (1 - 0.3 * pitchDown) + stall * 0.75;
    fan = Math.max(fan, 0.25);
    this.tailPivot.scale.set(fan, 1, blend(1, 0.94, 1.14, sp, tk));
    this.tailPivot.rotation.set(-0.05 + 0.24 * pitchDown - 0.18 * bird.stickPitch, 0, rollN * 0.1);

    this.poseWing(this.wings[0], sp, tk, spL, tkL, clamp01(rollN), beat0, beat1, beat2, shR);
    this.poseWing(this.wings[1], sp, tk, spL, tkL, clamp01(-rollN), beat0, beat1, beat2, shL);

    // Matrices have to be current before the tips can be read for the trails.
    this.group.updateMatrixWorld();
    this.updateTrails(bird, sky, cameraPos);
  }

  private beatAt(lag: number, env: number): number {
    const p = this.beat - lag;
    // Downstroke first — the power stroke goes down, and the recovery is what
    // lifts. Getting this backwards makes a bird look like it is swimming.
    return this.beat < 0 || p < 0 ? 0 : -Math.sin(TAU * p) * env;
  }

  private poseWing(
    w: WingRig,
    sp: number, tk: number,
    spL: number, tkL: number,
    inside: number,
    beat0: number, beat1: number, beat2: number,
    shake: number,
  ): void {
    const s = w.side;
    const flex = this.flex;

    // Sweep is negated by side because the arm points along +X on the right and
    // -X on the left; both have to fold toward +Z.
    w.inner.rotation.y = -s * blend3(SWEEP_INNER, sp, tk);
    w.inner.rotation.z =
      s * (blend3(DIHED_INNER, sp, tk) + beat0 * BEAT_AMP_INNER + shake);

    w.mid.position.x = s * INNER_LEN * blend3(TELE_MID, sp, tk);
    w.mid.rotation.y = -s * blend3(SWEEP_MID, spL, tkL);
    w.mid.rotation.z =
      s * (blend3(DIHED_MID, spL, tkL) + flex * FLEX_MID + beat1 * BEAT_AMP_MID + shake * 0.6);

    w.outer.position.x = s * MID_LEN * blend3(TELE_OUTER, spL, tkL);
    w.outer.rotation.y = -s * blend3(SWEEP_OUTER, spL, tkL);
    w.outer.rotation.z =
      s *
      (blend3(DIHED_OUTER, spL, tkL) +
        flex * FLEX_OUTER +
        inside * BANK_TIP +
        beat2 * BEAT_AMP_OUTER +
        shake * 1.4);

    const reach = OUTER_LEN * blend3(TELE_PRIM, spL, tkL);
    for (let i = 0; i < PRIMARIES; i++) {
      const u = i / (PRIMARIES - 1);
      const p = w.prim[i];
      p.position.x = s * reach;
      // Splayed like fingers when spread; all folded to one swept point when
      // tucked. This is the single most legible half of the whole morph.
      p.rotation.y =
        -s *
        blend(
          lerp(-0.03, 0.26, u),
          lerp(-0.12, 0.78, u),
          lerp(1.05, 1.3, u),
          spL,
          tkL,
        );
      p.rotation.z =
        s *
        (blend(0.02 + 0.05 * u, 0.06 + 0.26 * u, -0.02 - 0.08 * u, spL, tkL) +
          flex * (0.5 + 0.5 * u) * 0.6 +
          shake * 1.8);
    }
  }

  // --------------------------------------------------------------- trails

  private updateTrails(bird: BirdState, sky: SkyState, cam: THREE.Vector3): void {
    const cfg = this.cfg;
    const now = this.time;
    const spread = Math.max(this.wingT, 0);

    // ---- wingtip vortices: only under real load, brighter the harder you pull.
    const vs =
      smoothstep(cfg.vortexG, cfg.vortexG + 1.5, bird.gForce) * (0.7 + 0.5 * spread);
    const vSpace = Math.max(0.4, (bird.airspeed * VORTEX_LIFE) / Math.max(1, this.vortexStrand[0].cap - 2));

    if (this.vortexRib) {
      for (let i = 0; i < 2; i++) {
        const st = this.vortexStrand[i];
        st.expire(now, VORTEX_LIFE);
        const e = this.wings[i].tip.matrixWorld.elements;
        const x = e[12]; const y = e[13]; const z = e[14];
        const d2 = st.headDist2(x, y, z);
        if (d2 > TRAIL_BREAK * TRAIL_BREAK) st.clear();
        else if (vs > 0.03 && d2 >= vSpace * vSpace) st.push(x, y, z, now, vs);

        this.writeStrand(
          this.vortexRib, i, st, VORTEX_LIFE,
          VORTEX_WIDTH, 1.0, 0.3,
          VORTEX_SPIRAL_R, VORTEX_SPIRAL_RATE * (i === 0 ? 1 : -1),
          1.6, cam,
        );
      }
      this.vortexRib.flush();
    }

    // ---- contrail: cold air makes it, so the night makes it easier and keeps
    // it longer. Above the trigger height it just writes itself across the sky.
    if (this.contrailRib && this.contrailStrand) {
      const night = clamp01(sky.starVisibility);
      const trigger = cfg.contrailAltitude * (1 - 0.12 * night);
      const cs =
        smoothstep(trigger, trigger + 450, bird.position.y) *
        clamp01(bird.airspeed / 18) *
        (0.7 + 0.3 * night) *
        (bird.landed ? 0 : 1);

      const st = this.contrailStrand;
      const life = CONTRAIL_LIFE * (0.85 + 0.3 * night);
      st.expire(now, life);

      const e = this.contrailAnchor.matrixWorld.elements;
      const x = e[12]; const y = e[13]; const z = e[14];
      const cSpace = Math.max(2, (bird.airspeed * life) / Math.max(1, st.cap - 2));
      const d2 = st.headDist2(x, y, z);
      if (d2 > TRAIL_BREAK * TRAIL_BREAK) st.clear();
      else if (cs > 0.02 && d2 >= cSpace * cSpace) st.push(x, y, z, now, cs);

      // Widens as it ages while the alpha falls away — which is what diffusing
      // into still air actually looks like.
      this.writeStrand(
        this.contrailRib, 0, st, life,
        CONTRAIL_WIDTH, 0.55, 1.9,
        0, 0, 1.1, cam,
      );
      this.contrailRib.flush();
    }
  }

  /**
   * Rebuild one strand's vertices in place, oldest point first. Everything here
   * is scalar arithmetic on preallocated arrays — no vectors, no allocation.
   */
  private writeStrand(
    rib: Ribbon,
    slot: number,
    st: TrailStrand,
    life: number,
    width: number,
    w0: number,
    w1: number,
    spiralR: number,
    spiralRate: number,
    alphaPow: number,
    cam: THREE.Vector3,
  ): void {
    const m = st.count;
    if (m < 2) {
      rib.blank(slot);
      return;
    }

    let lx = 0; let ly = 0; let lz = 0;
    for (let k = 0; k < m; k++) {
      const i = st.at(k);
      const x = st.px[i];
      const y = st.py[i];
      const z = st.pz[i];

      const a = st.at(k > 0 ? k - 1 : 0);
      const b = st.at(k < m - 1 ? k + 1 : m - 1);
      let tx = st.px[b] - st.px[a];
      let ty = st.py[b] - st.py[a];
      let tz = st.pz[b] - st.pz[a];
      let tl = Math.hypot(tx, ty, tz);
      if (tl < 1e-5) { tx = 0; ty = 0; tz = 1; tl = 1; }
      tx /= tl; ty /= tl; tz /= tl;

      const age = clamp01((this.time - st.pBirth[i]) / life);

      let ox = x;
      let oy = y;
      let oz = z;
      if (spiralR > 0) {
        // A frame perpendicular to the trail, from whichever reference axis is
        // least parallel to it, so the spiral never degenerates.
        const rx = Math.abs(ty) > 0.94 ? 1 : 0;
        const ry = rx === 1 ? 0 : 1;
        let ux = ty * 0 - tz * ry;
        let uy = tz * rx - tx * 0;
        let uz = tx * ry - ty * rx;
        const ul = Math.hypot(ux, uy, uz) || 1;
        ux /= ul; uy /= ul; uz /= ul;
        const vx = uy * tz - uz * ty;
        const vy = uz * tx - ux * tz;
        const vz = ux * ty - uy * tx;
        const ang = age * life * spiralRate;
        const rr = spiralR * (0.18 + 0.82 * age);
        const ca = Math.cos(ang) * rr;
        const sa = Math.sin(ang) * rr;
        ox += ux * ca + vx * sa;
        oy += uy * ca + vy * sa;
        oz += uz * ca + vz * sa;
      }

      // A trail whipping past the lens would otherwise smear the whole frame.
      const dc = Math.hypot(ox - cam.x, oy - cam.y, oz - cam.z);
      const alpha =
        Math.pow(1 - age, alphaPow) * st.pStr[i] * smoothstep(0.6, 3.2, dc);

      rib.setPoint(slot, k, ox, oy, oz, tx, ty, tz, width * lerp(w0, w1, age), alpha);
      lx = ox; ly = oy; lz = oz;
    }

    // Collapse the unused tail of the buffer onto the last live point: exactly
    // degenerate triangles, zero fill, no wrap-around smear.
    for (let k = m; k < rib.cap; k++) {
      rib.setPoint(slot, k, lx, ly, lz, 0, 0, 1, 0, 0);
    }
  }

  // -------------------------------------------------------------- lifetime

  setVisible(v: boolean): void {
    this.group.visible = v;
    this.trails.visible = v;
    if (!v) {
      // Clearing on hide means the bird never reappears trailing a streak from
      // wherever it was last seen.
      this.vortexStrand[0].clear();
      this.vortexStrand[1].clear();
      this.contrailStrand?.clear();
    }
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.scene.remove(this.trails);
    for (const g of this.geos) g.dispose();
    this.geos.length = 0;
    this.material.dispose();
    this.vortexRib?.dispose();
    this.contrailRib?.dispose();
  }
}
