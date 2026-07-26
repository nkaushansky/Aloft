/**
 * THE COMPANIONS.
 *
 * Sixty-four other birds, and they are the best instrument in the game. You
 * cannot see air, but you can see what air does to a bird, and a flock spread
 * across a thermal draws the whole column for you — the ones on the far side
 * riding up while the ones you are on sink. Reading the flock is reading the
 * sky, so the drawing has exactly two jobs: be legible at a glance, and be
 * cheap enough that sixty-four of them cost nothing.
 *
 * Two instanced meshes, two draw calls:
 *
 *   NEAR  a real little animal — body wedge, fanned tail, four wing panels,
 *         beat done in the vertex shader so the CPU never touches a wing.
 *   FAR   a camera-facing dash, oriented along the bird's own wing axis so it
 *         still banks, with a floor on its minor axis so a distant flock is
 *         birds rather than crawling sub-pixel noise.
 *
 * They cross-fade by distance with complementary weights, so there is exactly
 * one bird's worth of opacity at every range and nothing ever pops.
 *
 * All of it lives in the shared atmosphere, which is what gets the reading
 * right for free: a companion is a dark speck against bright sky and a bright
 * speck against dark ground, because shadeSurface's rim term is doing what it
 * does for the mountains too.
 */

import * as THREE from 'three';
import type { Config } from '../../sim/config';
import type { FlockBird, QualitySettings, SkyState } from '../../sim/types';
import { clamp01, lerp, smoothstep, smootherstep } from '../../sim/math';
import {
  ATMOSPHERE_PRELUDE,
  ATMOSPHERE_UNIFORMS_GLSL,
  withAtmosphere,
  type AtmosphereUniforms,
} from '../shaders/atmosphere';

// ====================================================================== FEEL

/**
 * Half-span of the built geometry, metres. FlockBird.scale runs 0.72..1.22 on
 * top of this, so the flock spans roughly 3.3 m to 5.6 m — a shade smaller
 * than the player, which is what keeps the player reading as the protagonist.
 */
const HALF_SPAN = 2.3;

/**
 * How far the wings swing. Big soaring birds drop deep on the power stroke and
 * recover to barely above level, which is why a working flock looks like it is
 * rowing rather than fluttering.
 */
const BEAT_DOWN = 0.78;
const BEAT_UP = 0.42;

/**
 * Where the built geometry hands over to the dash, in metres, at the 'high'
 * tier. By LOD_NEAR a companion is a few pixels across and one pixel tall, so
 * the triangles have stopped earning their vertex cost; by LOD_FAR they would
 * be actively harmful, flickering in and out of the sample grid.
 */
const LOD_NEAR = 470;
const LOD_FAR = 820;

/** Nothing beyond this is worth an instance. Leavers heading off to roost fade
 *  out over the last fifth of it rather than winking away. */
const FLOCK_CULL = 5000;

/** Half-span of the far dash, as a multiple of the instance scale. */
const SPECK_SPAN = HALF_SPAN;
/** Minor axis of the dash — a bird is a line, not a dot. */
const SPECK_THICK = 0.34;
/**
 * Floor on the dash's minor axis, as a fraction of distance. At the default
 * 62° FOV on a ~900 px tall frame this lands around two pixels. Below that a
 * flock stops being birds and starts being a shimmer.
 */
const SPECK_MIN_ANGLE = 0.0016;

/**
 * The flock is a crowd of individuals, in linear light. Nothing here is bright:
 * a soaring bird at any distance is a dark shape, and every scrap of luminance
 * it gets comes from the sun raking its back or burning through its primaries.
 * FlockBird.tint walks this ramp — near-black slate, warm brown, dust grey.
 */
const TINT_SLATE = [0.024, 0.026, 0.032];
const TINT_BROWN = [0.098, 0.058, 0.031];
const TINT_DUST = [0.134, 0.128, 0.116];

/** Pale underside. Countershading is most of why a bird reads as a bird. */
const BELLY = [0.30, 0.285, 0.255];

/**
 * Companions draw in the transparent pass (presence is an opacity) but BEFORE
 * every cloud type, so a bird correctly occludes cloud behind it and is
 * correctly occluded by cloud in front. Cumulus start at 20.
 */
const ORDER_BODY = 10;
const ORDER_SPECK = 11;

/** Geometry LOD range multiplier per tier. Low tiers give up on wings sooner. */
const TIER_LOD: Record<string, number> = { low: 0.55, medium: 0.8, high: 1, ultra: 1.3 };

/** GLSL float literal from a JS number. */
const glf = (v: number): string => v.toFixed(4);

// Module scratch. Nothing below allocates once the constructor has returned.
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _quat = new THREE.Quaternion();
const _pos = new THREE.Vector3();
const _scl = new THREE.Vector3();
const _mat = new THREE.Matrix4();

// ==================================================================== SHADERS

/**
 * THE BEAT LIVES HERE. `aWing` is baked into the geometry — 0 everywhere on
 * the body and tail, 0.42 at the elbow, 1 at the tip — and the wing rotates
 * about the fore-aft axis by that weight. Because the weight ramps across two
 * panels the wing bends at the elbow instead of hinging like a plank, and
 * because it is per-vertex the CPU never touches a wing vertex.
 *
 * The sim only advances `flap` while a bird is actually working, and damps it
 * back to zero otherwise — so sin(flap) is zero for a gliding bird and the
 * common case is a sky full of perfectly still shapes.
 */
const BODY_VERTEX = /* glsl */ `
${ATMOSPHERE_UNIFORMS_GLSL}

attribute float aWing;   // per-vertex: 0 on the body, 1 at the wingtip
attribute float aFlap;   // per-instance: beat phase in radians
attribute float aFade;   // per-instance: presence, as opacity

varying vec3  vWorld;
varying vec3  vNrm;
varying vec3  vTint;
varying float vFade;
varying float vBelly;

void main() {
  // Which wing this vertex belongs to. Both must rise together, so the sign of
  // the rotation follows the side of the body — the body itself has weight 0
  // and never notices.
  float side = position.x >= 0.0 ? 1.0 : -1.0;
  float s = sin(aFlap);
  float beat = s > 0.0 ? s * ${glf(BEAT_UP)} : s * ${glf(BEAT_DOWN)};
  float a = beat * aWing * side;
  float ca = cos(a), sa = sin(a);

  vec3 p = position;
  p.xy = vec2(p.x * ca - p.y * sa, p.x * sa + p.y * ca);
  // The baked flat normal is rotated by the same angle. Not exact across a
  // panel whose two ends turn different amounts, but the error is a couple of
  // degrees on a shape that is three pixels tall.
  vec3 n = normal;
  n.xy = vec2(n.x * ca - n.y * sa, n.x * sa + n.y * ca);

  vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
  vWorld = wp.xyz;
  vNrm = mat3(modelMatrix) * (mat3(instanceMatrix) * n);
  // Countershading is measured in the BIRD's own frame, so one rolled hard
  // into a turn keeps its pale belly instead of turning into a lit ceiling.
  vBelly = n.y;
  vFade = aFade;
#ifdef USE_INSTANCING_COLOR
  vTint = instanceColor;
#else
  vTint = vec3(0.07);
#endif
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const BODY_FRAGMENT = /* glsl */ `
${ATMOSPHERE_PRELUDE}

uniform vec3  uBelly;
uniform float uRim;

varying vec3  vWorld;
varying vec3  vNrm;
varying vec3  vTint;
varying float vFade;
varying float vBelly;

void main() {
  if (vFade < 0.004) discard;

  // Wings are single quads, so half of them face away. Flip rather than cull:
  // culling would open holes in the silhouette the moment a bird banks.
  vec3 N = normalize(vNrm);
  if (!gl_FrontFacing) N = -N;

  vec3 toFrag = vWorld - uCameraPos;
  float dist = length(toFrag);
  vec3 viewDir = toFrag / max(dist, 0.001);

  vec3 albedo = mix(vTint, uBelly, smoothstep(0.15, -0.6, vBelly) * 0.5);

  vec3 col = shadeSurface(albedo, N, viewDir, 1.0);

  // A flock strung across a low sun is a line of black shapes with burning
  // edges. Deliberately allowed past 1.0 — that headroom is what bloom eats.
  float fres = pow(1.0 - clamp(dot(N, -viewDir), 0.0, 1.0), 2.6);
  float backlit = pow(clamp(dot(-viewDir, uSunDir) * 0.5 + 0.5, 0.0, 1.0), 3.0);
  col += uSunColor * uSunIntensity * fres * (0.14 + 2.2 * backlit) * uRim;

  // The last companions peel off to roost around dusk; this is what keeps them
  // legible on the way out.
  float mdl = clamp(dot(N, uMoonDir) * 0.5 + 0.5, 0.0, 1.0);
  col += albedo * vec3(0.16, 0.21, 0.38) * uStars * (0.35 + 0.65 * mdl);

  col = aerialPerspective(col, vWorld, viewDir, dist);
  col += ditherValue(gl_FragCoord.xy);
  gl_FragColor = vec4(max(col, vec3(0.0)), clamp(vFade, 0.0, 1.0));
}
`;

/**
 * The far dash. It is a billboard, but not a round one: it is stretched along
 * the bird's own wing axis projected into the screen, so it still rolls with
 * the bank and still foreshortens to a stub when you look down a wing. That
 * one detail is the difference between distant birds and distant confetti.
 */
const SPECK_VERTEX = /* glsl */ `
${ATMOSPHERE_UNIFORMS_GLSL}

attribute float aFade;

varying vec2  vQuad;
varying vec3  vWorld;
varying vec3  vNrm;
varying vec3  vTint;
varying float vFade;

void main() {
  vec3 c = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;

  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

  mat3 im = mat3(instanceMatrix);
  float sc = length(im[0]);
  vec3 span = im[0] / max(sc, 1e-5);
  // The lighting normal is the bird's back, which is honest and is what makes
  // the shared rim term fire when a distant bird is seen edge-on — the exact
  // case where it needs to separate from the ground behind it.
  vNrm = im[1] / max(length(im[1]), 1e-5);

  vec2 e = vec2(dot(span, camRight), dot(span, camUp));
  float sl = length(e);
  e = sl > 1e-4 ? e / sl : vec2(1.0, 0.0);

  float dist = distance(c, uCameraPos);
  float halfW = sc * ${glf(SPECK_SPAN)} * (0.32 + 0.68 * sl);
  float halfH = max(sc * ${glf(SPECK_THICK)}, dist * ${glf(SPECK_MIN_ANGLE)});
  halfW = max(halfW, halfH);

  // Scale in the wing frame first, then rotate that frame into the screen —
  // the other order would give a screen-aligned ellipse that never banks.
  vec2 s = vec2(position.x * halfW, position.y * halfH);
  vec2 q = vec2(s.x * e.x - s.y * e.y, s.x * e.y + s.y * e.x);

  vec3 world = c + camRight * q.x + camUp * q.y;
  vQuad  = position.xy;
  vWorld = world;
  vFade  = aFade;
#ifdef USE_INSTANCING_COLOR
  vTint = instanceColor;
#else
  vTint = vec3(0.07);
#endif
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const SPECK_FRAGMENT = /* glsl */ `
${ATMOSPHERE_PRELUDE}

uniform float uRim;

varying vec2  vQuad;
varying vec3  vWorld;
varying vec3  vNrm;
varying vec3  vTint;
varying float vFade;

void main() {
  float r = 1.0 - dot(vQuad, vQuad);
  if (r <= 0.0) discard;
  // Soft edge: a hard-edged two-pixel dash aliases into a strobe the moment it
  // moves, which at this range is every single frame.
  float a = smoothstep(0.0, 0.55, r) * vFade;
  if (a < 0.004) discard;

  vec3 toFrag = vWorld - uCameraPos;
  float dist = length(toFrag);
  vec3 viewDir = toFrag / max(dist, 0.001);

  vec3 N = normalize(vNrm);
  if (dot(N, -viewDir) < 0.0) N = -N;

  vec3 col = shadeSurface(vTint, N, viewDir, 1.0);

  float fres = pow(1.0 - clamp(dot(N, -viewDir), 0.0, 1.0), 2.0);
  float backlit = pow(clamp(dot(-viewDir, uSunDir) * 0.5 + 0.5, 0.0, 1.0), 3.0);
  col += uSunColor * uSunIntensity * fres * (0.10 + 1.6 * backlit) * uRim;
  col += vTint * vec3(0.16, 0.21, 0.38) * uStars;

  col = aerialPerspective(col, vWorld, viewDir, dist);
  col += ditherValue(gl_FragCoord.xy);
  gl_FragColor = vec4(max(col, vec3(0.0)), clamp(a, 0.0, 1.0));
}
`;

// =================================================================== GEOMETRY

/** Flat-shaded triangle soup, built once at construction. */
interface Soup {
  pos: number[];
  nrm: number[];
  wing: number[];
}

/**
 * One flat-shaded triangle. The face normal is computed here rather than
 * averaged across the mesh: hard facets read as feathers-and-bone at a
 * distance, smooth ones read as a soap bar.
 */
function tri(
  s: Soup,
  ax: number, ay: number, az: number, wa: number,
  bx: number, by: number, bz: number, wb: number,
  cx: number, cy: number, cz: number, wc: number,
): void {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  let nx = uy * vz - uz * vy;
  let ny = uz * vx - ux * vz;
  let nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l;
  ny /= l;
  nz /= l;
  s.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
  s.nrm.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  s.wing.push(wa, wb, wc);
}

/** A wing panel, given as four corners; `side` mirrors it and fixes winding. */
function panel(s: Soup, side: number, q: readonly number[]): void {
  const x = (i: number) => q[i * 4] * side;
  const y = (i: number) => q[i * 4 + 1];
  const z = (i: number) => q[i * 4 + 2];
  const w = (i: number) => q[i * 4 + 3];
  // Mirroring flips the handedness, so the left wing walks its corners the
  // other way round and keeps its normals pointing at the sky.
  const o = side > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
  for (let k = 0; k < 6; k += 3) {
    const i = o[k], j = o[k + 1], m = o[k + 2];
    tri(s, x(i), y(i), z(i), w(i), x(j), y(j), z(j), w(j), x(m), y(m), z(m), w(m));
  }
}

/**
 * The animal. A six-vertex body wedge, a flat fanned tail, and two wing panels
 * per side — the inner panel exists purely so the beat bends at the elbow.
 * Eighteen triangles total, nose along -Z to match the sim's yaw convention.
 */
function buildBird(): THREE.BufferGeometry {
  const s: Soup = { pos: [], nrm: [], wing: [] };

  // --- body: nose, a four-point ring at the shoulders, tail ---------------
  const nx = 0, ny = 0.005, nz = -0.95;
  const tx = 0, ty = 0.02, tz = 0.72;
  const rT = [0, 0.115, -0.2];
  const rR = [0.115, 0.01, -0.2];
  const rB = [0, -0.1, -0.2];
  const rL = [-0.115, 0.01, -0.2];
  const ring = [rT, rR, rB, rL];
  for (let i = 0; i < 4; i++) {
    const a = ring[i];
    const b = ring[(i + 1) & 3];
    tri(s, nx, ny, nz, 0, a[0], a[1], a[2], 0, b[0], b[1], b[2], 0);
    tri(s, tx, ty, tz, 0, b[0], b[1], b[2], 0, a[0], a[1], a[2], 0);
  }

  // --- tail: a flat plate. Half the silhouette of a soaring bird from below
  //     is the tail, and it costs two triangles.
  tri(s, -0.055, 0.02, 0.55, 0, 0.26, 0.03, 1.02, 0, 0.055, 0.02, 0.55, 0);
  tri(s, -0.055, 0.02, 0.55, 0, -0.26, 0.03, 1.02, 0, 0.26, 0.03, 1.02, 0);

  // --- wings. Corners are [x, y, z, beatWeight], leading edge first. The y
  //     rise from root to tip is the resting dihedral; the z shift is sweep.
  const inner = [
    0.1, 0.05, -0.28, 0,
    0.1, 0.05, 0.22, 0,
    1.02, 0.1, 0.06, 0.42,
    1.02, 0.1, -0.32, 0.42,
  ];
  const outer = [
    1.02, 0.1, -0.32, 0.42,
    1.02, 0.1, 0.06, 0.42,
    2.3, 0.17, 0.14, 1,
    2.3, 0.17, -0.1, 1,
  ];
  panel(s, 1, inner);
  panel(s, 1, outer);
  panel(s, -1, inner);
  panel(s, -1, outer);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(s.pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(s.nrm), 3));
  g.setAttribute('aWing', new THREE.BufferAttribute(new Float32Array(s.wing), 1));
  return g;
}

function buildQuad(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3),
  );
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

// ================================================================= INSTANCING

/**
 * One InstancedMesh plus the flat arrays behind it. Slots are packed fresh
 * every frame — a bird that is not visible at this LOD simply is not written,
 * and `count` stops the draw short of the stale tail — so nothing is ever
 * reallocated and a presence of zero can never leave a ghost on screen.
 */
class Batch {
  readonly mesh: THREE.InstancedMesh;
  count = 0;

  private readonly capacity: number;
  private readonly material: THREE.ShaderMaterial;
  private readonly fade: Float32Array;
  private readonly aFade: THREE.InstancedBufferAttribute;
  private readonly flap: Float32Array;
  private readonly aFlap: THREE.InstancedBufferAttribute;
  private readonly color: Float32Array;
  private readonly aColor: THREE.InstancedBufferAttribute;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.ShaderMaterial,
    capacity: number,
    order: number,
  ) {
    this.capacity = capacity;
    this.material = material;

    this.fade = new Float32Array(capacity);
    this.aFade = new THREE.InstancedBufferAttribute(this.fade, 1);
    this.aFade.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aFade', this.aFade);

    // The far dash has no wings to beat and its shader never mentions aFlap,
    // so the attribute is simply never bound there. Carrying it on both keeps
    // one push() path instead of two.
    this.flap = new Float32Array(capacity);
    this.aFlap = new THREE.InstancedBufferAttribute(this.flap, 1);
    this.aFlap.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('aFlap', this.aFlap);

    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    // Built by hand rather than through setColorAt so the ramp can write
    // straight into the array without a Color round-trip every frame.
    this.color = new Float32Array(capacity * 3).fill(1);
    this.aColor = new THREE.InstancedBufferAttribute(this.color, 3);
    this.aColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = this.aColor;

    // The flock moves every frame and the mesh itself sits at the origin, so a
    // bounding sphere would be a lie. Culling is the distance test in update().
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = order;
    this.mesh.count = 0;
  }

  /** Takes the orientation from module scratch `_mat`, composed by the caller. */
  push(alpha: number, flap: number, r: number, g: number, b: number): void {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    this.fade[i] = alpha;
    this.flap[i] = flap;
    const i3 = i * 3;
    this.color[i3] = r;
    this.color[i3 + 1] = g;
    this.color[i3 + 2] = b;
    this.mesh.setMatrixAt(i, _mat);
  }

  flush(): void {
    this.mesh.count = this.count;
    if (this.count === 0) return;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.aFade.needsUpdate = true;
    this.aFlap.needsUpdate = true;
    this.aColor.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.dispose();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

// ================================================================ FLOCK ACTOR

export class FlockActor {
  private readonly body: Batch;
  private readonly speck: Batch;
  private readonly bodyMat: THREE.ShaderMaterial;
  private readonly speckMat: THREE.ShaderMaterial;
  private readonly cull: number;

  private lodNear = LOD_NEAR;
  private lodFar = LOD_FAR;

  constructor(
    private readonly scene: THREE.Scene,
    cfg: Config,
    atmo: AtmosphereUniforms,
    quality: QualitySettings,
  ) {
    const cap = Math.max(1, cfg.flockMax);
    this.cull = Math.min(cfg.viewDistance, FLOCK_CULL);

    this.bodyMat = new THREE.ShaderMaterial({
      uniforms: withAtmosphere(atmo, {
        uBelly: { value: new THREE.Color().setRGB(BELLY[0], BELLY[1], BELLY[2]) },
        uRim: { value: 1 },
      }),
      vertexShader: BODY_VERTEX,
      fragmentShader: BODY_FRAGMENT,
      transparent: true,
      // Presence is an opacity, so these have to live in the transparent pass —
      // but they still write depth, because a bird occluding its own far wing
      // matters far more often than a two-second join fade blending oddly.
      depthWrite: true,
      depthTest: true,
      side: THREE.DoubleSide,
    });

    this.speckMat = new THREE.ShaderMaterial({
      uniforms: withAtmosphere(atmo, { uRim: { value: 0.85 } }),
      vertexShader: SPECK_VERTEX,
      fragmentShader: SPECK_FRAGMENT,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
    });

    this.body = new Batch(buildBird(), this.bodyMat, cap, ORDER_BODY);
    this.speck = new Batch(buildQuad(), this.speckMat, cap, ORDER_SPECK);

    this.setQuality(quality);

    scene.add(this.body.mesh);
    scene.add(this.speck.mesh);
  }

  /** Cheaper tiers give up on wing geometry sooner and dash out earlier. */
  setQuality(q: QualitySettings): void {
    const k = TIER_LOD[q.tier] ?? 1;
    this.lodNear = LOD_NEAR * k;
    this.lodFar = LOD_FAR * k;
  }

  /**
   * `_dt` and `_sky` are unused on purpose. The flock's motion is entirely the
   * sim's — nothing here integrates — and the flock has no colour of its own
   * that the day changes: the light it wears arrives through the shared
   * atmosphere uniforms, which someone else already synced this frame.
   */
  update(
    _dt: number,
    birds: readonly FlockBird[],
    _sky: SkyState,
    cameraPos: THREE.Vector3,
  ): void {
    this.body.count = 0;
    this.speck.count = 0;

    const cull = this.cull;
    const near = this.lodNear;
    const far = this.lodFar;

    for (let i = 0; i < birds.length; i++) {
      const b = birds[i];
      if (b.presence <= 0.004) continue;

      const dx = b.x - cameraPos.x;
      const dy = b.y - cameraPos.y;
      const dz = b.z - cameraPos.z;
      const d = Math.hypot(dx, dy, dz);
      if (d >= cull) continue;

      // Presence drives size and opacity together, eased at both ends, so a
      // companion swims into being out of the haze instead of switching on.
      const e = smootherstep(0, 1, clamp01(b.presence));
      const alpha = e * (1 - smoothstep(cull * 0.8, cull, d));
      if (alpha <= 0.004) continue;
      const grow = 0.55 + 0.45 * e;

      _euler.set(b.pitch, b.yaw, -b.roll, 'YXZ');
      _quat.setFromEuler(_euler);
      _pos.set(b.x, b.y, b.z);
      _scl.setScalar(b.scale * grow);
      _mat.compose(_pos, _quat, _scl);

      // Complementary weights: exactly one bird's worth of ink at every range,
      // handed from the triangles to the dash without a seam.
      const geoW = 1 - smoothstep(near, far, d);

      // The tint ramp. Two segments so the middle of the range is brown rather
      // than the flat grey a straight slate-to-dust lerp would give.
      const t = clamp01(b.tint);
      let cr: number, cg: number, cb: number;
      if (t < 0.5) {
        const u = t * 2;
        cr = lerp(TINT_SLATE[0], TINT_BROWN[0], u);
        cg = lerp(TINT_SLATE[1], TINT_BROWN[1], u);
        cb = lerp(TINT_SLATE[2], TINT_BROWN[2], u);
      } else {
        const u = (t - 0.5) * 2;
        cr = lerp(TINT_BROWN[0], TINT_DUST[0], u);
        cg = lerp(TINT_BROWN[1], TINT_DUST[1], u);
        cb = lerp(TINT_BROWN[2], TINT_DUST[2], u);
      }

      if (geoW > 0.006) this.body.push(alpha * geoW, b.flap, cr, cg, cb);
      if (geoW < 0.994) this.speck.push(alpha * (1 - geoW), b.flap, cr, cg, cb);
    }

    this.body.flush();
    this.speck.flush();
  }

  dispose(): void {
    this.scene.remove(this.body.mesh);
    this.scene.remove(this.speck.mesh);
    this.body.dispose();
    this.speck.dispose();
  }
}
