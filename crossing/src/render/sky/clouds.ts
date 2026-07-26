/**
 * CLOUDS AS INSTRUMENTS.
 *
 * Nothing up here is decoration. Every shape in this file is a label on a
 * piece of air, and learning to read the shapes is learning to read the sky:
 *
 *   cumulus      — a thermal is working under this, right now
 *   cloud street — a line of thermals you can run in a straight line
 *   lenticular   — standing wave, smooth and enormous, and it does not move
 *   rotor        — the air below the wave is being torn apart; this is the toll
 *
 * The lifecycle is the skill. A cumulus with a hard flat base and a crisp
 * rounded top has lift under it. The same cloud twenty minutes later — edges
 * chewed, base gone ragged, top wisping off downwind — has nothing under it at
 * all, and flying to it costs you the whole glide. Real pilots read this. Here
 * it is drawn honestly, from the thermal's own age, so it can be learned.
 *
 * Everything is soft camera-facing billboards: one InstancedMesh per type,
 * four draw calls, all sharing one material family and the one shared
 * atmosphere, so the clouds agree with the ground about where the sun is.
 */

import * as THREE from 'three';
import type { Config } from '../../sim/config';
import type {
  BirdState,
  QualitySettings,
  SkyState,
  ThermalInfo,
  Vec3,
  WaveInfo,
  WindField,
} from '../../sim/types';
import { TAU, clamp, clamp01, damp, lerp, smoothstep } from '../../sim/math';
import { hash2 } from '../../sim/noise';
import {
  ATMOSPHERE_PRELUDE,
  ATMOSPHERE_UNIFORMS_GLSL,
  withAtmosphere,
  type AtmosphereUniforms,
} from '../shaders/atmosphere';

// ===================================================================== FEEL

/** Hard ceiling on puffs per cumulus, so buffers are sized once and never grow. */
const MAX_PUFFS_PER_CLOUD = 14;
/** Puffs in one connective street segment, at ultra. */
const STREET_MAX_PUFFS = 5;
/** How many downwind neighbours one cloud may link to. Two keeps lines linear. */
const STREET_MAX_LINKS = 2;
/** Wave systems we are willing to draw cloud for. Extra ones are simply skipped. */
const MAX_WAVES = 12;
/** Lenticular lenses stacked over one crest. */
const MAX_LENS_STACK = 4;
/** Crests downwind that still get a lens. Further out the wave is too weak. */
const MAX_LENS_CRESTS = 4;
/** Crests that get a rotor line — rotor really only lives under the first two. */
const ROTOR_CRESTS = 2;
const ROTOR_MAX_PUFFS = 14;

/**
 * How much wider the cloud is than the thermal core that feeds it. Raise it
 * and the sky gets soupy and the clouds stop pointing at anything; lower it
 * and cumulus turn into tennis balls.
 */
const PUFF_SPREAD = 2.05;
/** Fraction of a cumulus's puffs that form the flat shadowed base slab. */
const BASE_FRACTION = 0.45;
/** Metres of height scatter allowed in the base row while the cloud is healthy. */
const BASE_RAGGED = 9;
/** Extra metres of scatter once it is dying — this is the base falling apart. */
const BASE_RAGGED_DEATH = 70;
/** Peak opacity of a single cumulus puff. Nine of these stack to near-solid. */
const CUMULUS_OPACITY = 0.74;
/** A cumulus never sits closer than this above the ground that made it (m). */
const MIN_CLOUD_CLEARANCE = 140;

/**
 * The cloud's clock, in fractions of the thermal's life. Condensation lags the
 * column starting to work (nothing at 0.10, fully formed by 0.34) and, more
 * importantly, the cloud OUTLIVES the lift: decay only begins at 0.80, by
 * which time the thermal's own envelope is already fading. That gap is the
 * trap the game wants you to learn to see.
 */
const CLOUD_FORM_START = 0.1;
const CLOUD_FORM_END = 0.34;
const CLOUD_DECAY_START = 0.8;

/** How far a cluster stretches along the wind at full streetFactor. */
const STREET_STRETCH = 0.85;
/** How hard it is squeezed across the wind at full streetFactor. */
const STREET_SQUASH = 0.5;
/** Two clouds closer than this are already one cloud; further than this, no line. */
const STREET_MIN_GAP = 420;
const STREET_MAX_GAP = 3400;
/** |dot| of the gap direction with the wind before a pair counts as a street. */
const STREET_ALIGN_MIN = 0.86;
/** Metres between connective puffs along a link. */
const STREET_SPACING = 520;
/** How far the connective cloud sags between its parents (m). */
const STREET_SAG = 70;
const STREET_OPACITY = 0.46;

/** Where along a wavelength the lens sits, and where the rotor sits (0..1). */
const LENS_CREST_PHASE = 0.5;
const ROTOR_CREST_PHASE = 0.36;
/** Height of the first lens above the wave's working base (m). */
const LENS_FIRST_OFFSET = 240;
/** Vertical spacing of stacked lenses (m). */
const LENS_GAP = 360;
/** Each lens in a stack leans this far downwind of the one below (m). */
const LENS_LEAN = 130;
/** Lens half-width as a fraction of the wave bar's half-width. */
const LENS_WIDTH = 0.42;
/** Thickness of a lens relative to its width. Real ones are astonishingly flat. */
const LENS_ASPECT = 0.17;
const LENS_OPACITY = 0.66;
/** Lenses are lit from above and dark underneath, but never as dark as a base. */
const LENS_SHADE = 0.22;

/** Half-width of one rotor fragment (m). */
const ROTOR_PUFF = 265;
/** How much of the wave bar's length the rotor line spans. */
const ROTOR_LINE = 0.55;
/** How far fragments scatter up- and downwind of the line (m). Keeps it torn. */
const ROTOR_SCATTER = 420;
/** Tumble rate (rad/s) at the extremes. This is the whole warning label. */
const ROTOR_SPIN = 0.55;
const ROTOR_OPACITY = 0.62;

/**
 * Turns summed cumulus footprint into the 0..1 the terrain shader wants. It is
 * a fudge, and it is the honest kind: raise it and the ground gets more
 * dappled for the same sky.
 */
const COVERAGE_GAIN = 3.0;
/** How fast coverage may change. Slow, so ground shadow breathes, never blinks. */
const COVERAGE_LAMBDA = 0.35;

/**
 * Clouds draw after everything opaque (three guarantees that), and this block
 * fixes the order between the four types. It is a fixed order rather than a
 * per-frame sort because the four types occupy different air — cumulus at
 * cloudbase, rotor below the wave, lenses above it — so they almost never
 * overlap on screen, and a fixed order can never flicker.
 */
const ORDER_ROTOR = 20;
const ORDER_STREET = 21;
const ORDER_CUMULUS = 22;
const ORDER_LENS = 23;

// Wind direction is read once a frame into this. Module scratch — no
// allocation is permitted anywhere below here.
const _wind: Vec3 = { x: 0, y: 0, z: 0 };

// ==================================================================== SHADER

/**
 * The per-type look. All four share one shader; these are the numbers baked
 * into it at build time, which is also what gives each type its own program
 * with the branches already resolved.
 */
interface CloudStyle {
  /** Linear grey the puff starts from before any light touches it. */
  albedo: number;
  /** How hard fbm chews the silhouette. Raise it for shreddier, wilder edges. */
  billow: number;
  /** How far the per-puff decay term is allowed to eat the shape away. */
  bite: number;
  /** Width of the soft rim. Raise it for mistier, less defined puffs. */
  soft: number;
  /** How fast the edge noise crawls. 0 freezes it — a lens must be still. */
  scroll: number;
  /** Noise cells across a puff. Higher is finer, lacier detail. */
  grain: number;
  /** Gain on forward scatter — THE backlit-golden-hour knob. */
  forward: number;
  /** Gain on the multiple-scatter interior glow that stops clouds reading flat. */
  multi: number;
  /** How much top-bright/bottom-dark ramp runs down the billboard. */
  vertical: number;
  /** Fast opacity churn. Only rotor should have any. */
  flicker: number;
  /** Almond silhouette instead of round — lenticulars only. */
  lens: boolean;
  /** Sunset rim iridescence — lenticulars only. */
  iridescent: boolean;
}

const CUMULUS_STYLE: CloudStyle = {
  albedo: 0.94,
  billow: 0.92,
  bite: 0.85,
  soft: 0.34,
  scroll: 0.011,
  grain: 2.6,
  forward: 0.9,
  multi: 0.34,
  vertical: 0.55,
  flicker: 0,
  lens: false,
  iridescent: false,
};

const STREET_STYLE: CloudStyle = {
  albedo: 0.9,
  billow: 0.78,
  bite: 0.7,
  soft: 0.46,
  scroll: 0.009,
  grain: 2.0,
  forward: 0.75,
  multi: 0.3,
  vertical: 0.42,
  flicker: 0,
  lens: false,
  iridescent: false,
};

const LENS_STYLE: CloudStyle = {
  albedo: 0.97,
  billow: 0.16,
  bite: 0.2,
  soft: 0.3,
  scroll: 0,
  grain: 1.5,
  forward: 1.2,
  multi: 0.42,
  vertical: 0.85,
  flicker: 0,
  lens: true,
  iridescent: true,
};

const ROTOR_STYLE: CloudStyle = {
  albedo: 0.42,
  billow: 1.35,
  bite: 1.0,
  soft: 0.22,
  scroll: 0.22,
  grain: 3.4,
  forward: 0.45,
  multi: 0.16,
  vertical: 0.35,
  flicker: 0.55,
  lens: false,
  iridescent: false,
};

/** GLSL float literal from a JS number. */
const glf = (v: number): string => v.toFixed(4);

const CLOUD_VERTEX = /* glsl */ `
${ATMOSPHERE_UNIFORMS_GLSL}

attribute vec3 iCenter;  // world position of the puff
attribute vec4 iSize;    // halfWidth, halfHeight, shade bias, spin (rad/s)
attribute vec3 iNormal;  // fake normal: offset from the cluster's shading centre
attribute vec4 iParams;  // alpha, noise seed, roll, edge erosion

varying vec2  vQuad;
varying vec3  vWorld;
varying vec3  vNrm;
varying float vAlpha;
varying float vSeed;
varying float vEdge;
varying float vShade;
varying float vUp;

void main() {
  vec3 c = (modelMatrix * vec4(iCenter, 1.0)).xyz;

  // Camera basis straight out of the view matrix. Every puff turns to face the
  // eye, which is what lets a handful of quads read as one lumpy volume.
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);

  // Roll happens in world space so the *shape* stays put in quad space; that
  // is what lets rotor fragments tumble without their silhouettes swimming.
  float rot = iParams.z + iSize.w * uTime;
  float cr = cos(rot), sr = sin(rot);
  vec2 q = vec2(position.x * cr - position.y * sr, position.x * sr + position.y * cr);

  vec3 world = c + camRight * (q.x * iSize.x) + camUp * (q.y * iSize.y);

  vQuad  = position.xy;
  vWorld = world;
  vNrm   = iNormal;
  vSeed  = iParams.y;
  vEdge  = iParams.w;
  vShade = iSize.z;

  // Vertical position inside the puff, measured in WORLD up rather than quad
  // up, so the top-bright ramp survives the roll. Looking straight down it
  // goes to zero on its own, which is correct — there is no top from there.
  vUp = (world.y - c.y) / max(iSize.y, 1.0);

  // Fly into a puff and it dissolves instead of showing you its quad. Keyed
  // on the puff's THINNEST half-extent, because that is when you are actually
  // inside it — a lenticular is two kilometres wide and a hundred and fifty
  // metres thick, and it must not evaporate while it is still a view.
  float dcam = distance(c, uCameraPos);
  float near = min(iSize.x, iSize.y) * 1.5;
  vAlpha = iParams.x * smoothstep(near * 0.18, near * 1.05, dcam);

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

function cloudFragment(s: CloudStyle): string {
  // A lens is pointed at its tips; everything else is a round lobe. Resolved
  // here rather than branched in the shader.
  const body = s.lens
    ? `float lw = 1.0 - vQuad.x * vQuad.x;
  float body = lw - (vQuad.y * vQuad.y) / max(lw, 0.08);`
    : `float body = 1.0 - dot(vQuad, vQuad);`;

  const flicker =
    s.flicker > 0
      ? `
  // Rotor is air coming apart. Opacity churning this fast is the tell, and it
  // is the only cloud in the game allowed to be agitated.
  a *= mix(1.0, 0.32 + 0.68 * anoise3(vec3(vSeed * 11.0, uTime * 1.9, vSeed * 3.0)), ${glf(
    s.flicker,
  )});`
      : '';

  const irid = s.iridescent
    ? `
  // The rim of a wave cloud splits low sun into faint bands. Only near sunset,
  // only where the lens is thin, and never enough to look like a bug.
  float band = fract(cosSun * 7.0 + shape * 2.2 + vSeed * 0.61);
  vec3 hue = 0.5 + 0.5 * cos(6.2831853 * (band + vec3(0.0, 0.33, 0.67)));
  col += hue * uIrid * rim * rim * fwd * 0.6 * uSunIntensity;`
    : '';

  return /* glsl */ `
${ATMOSPHERE_PRELUDE}

uniform float uIrid;

varying vec2  vQuad;
varying vec3  vWorld;
varying vec3  vNrm;
varying float vAlpha;
varying float vSeed;
varying float vEdge;
varying float vShade;
varying float vUp;

// Moonlight, linear. Dim and cold — enough to keep a lenticular legible at the
// top of the night, never enough to look like a second sun.
const vec3 MOONLIGHT = vec3(0.14, 0.19, 0.34);

void main() {
  if (vAlpha < 0.0025) discard;

  ${body}

  // Billowed edge: fbm eats into the lobe so puffs are cloud-shaped rather
  // than gaussian blobs. vEdge is the decay term — as a thermal dies, this
  // rises and the silhouette visibly tears itself apart.
  vec3 np = vec3(vQuad * ${glf(s.grain)} + vSeed * 31.7, vSeed * 6.1 + uTime * ${glf(s.scroll)});
  float n = afbm3(np, 3) - 0.43;
  float shape = body + n * ${glf(s.billow)} - vEdge * ${glf(s.bite)};
  if (shape <= 0.0) discard;

  float a = smoothstep(0.0, ${glf(s.soft)}, shape) * vAlpha;${flicker}
  if (a < 0.002) discard;

  vec3 toFrag = vWorld - uCameraPos;
  float dist = length(toFrag);
  vec3 viewDir = toFrag / max(dist, 1.0);
  vec3 N = normalize(vNrm);

  // How deep into the puff this pixel sits. Edges are thin and scatter light;
  // the middle is thick and shadows itself.
  float thick = smoothstep(0.0, ${glf(s.soft * 2.4)}, shape);

  // Top-bright / bottom-dark ramp. On cumulus this is what welds the base row
  // into one flat shadowed slab; on a lenticular it is the entire lens.
  float updown = clamp(vUp * 0.5 + 0.5, 0.0, 1.0);
  float grad = mix(1.0, 0.40 + 0.60 * updown, ${glf(s.vertical)});
  float dark = mix(1.0, 0.28, clamp(vShade, 0.0, 1.0)) * grad;

  vec3 albedo = vec3(${glf(s.albedo)}) * dark;

  // The shared surface model, so clouds and ground agree about the light.
  vec3 col = shadeSurface(albedo, N, viewDir, 1.0);

  // Multiple scattering: light that bounced around inside and came back out.
  // Without it a cloud reads as painted card no matter how good the edge is.
  float ndl = max(dot(N, uSunDir), 0.0);
  col += albedo * uSunColor * uSunIntensity * ${glf(s.multi)} * (0.30 + 0.70 * ndl) * thick;

  // FORWARD SCATTER. A cloud between you and the sun blazes along its thin
  // edges. This one term is backlit golden hour, and it is the picture the
  // whole art direction exists to deliver — weighted to the rim, where the
  // cloud is thin enough for the sun to come through it.
  float cosSun = dot(viewDir, uSunDir);
  float fwd = miePhase(cosSun, 0.76);
  float rim = 1.0 - thick;
  col += uSunColor * uSunIntensity * fwd * (0.30 + 2.6 * rim) * ${glf(s.forward)};

  // At night the sun term is gone and this is all that is left holding the
  // lenticulars up. uStars is the day's own night signal, so it fades in with
  // everything else that belongs to the dark.
  float mdl = clamp(dot(N, uMoonDir) * 0.5 + 0.5, 0.0, 1.0);
  col += albedo * MOONLIGHT * uStars * (0.40 + 0.60 * mdl);${irid}

  col = aerialPerspective(col, vWorld, viewDir, dist);
  col += ditherValue(gl_FragCoord.xy);

  gl_FragColor = vec4(max(col, vec3(0.0)), clamp(a, 0.0, 1.0));
}
`;
}

function cloudMaterial(atmo: AtmosphereUniforms, style: CloudStyle): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: withAtmosphere(atmo, { uIrid: { value: 0 } }),
    vertexShader: CLOUD_VERTEX,
    fragmentShader: cloudFragment(style),
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.NormalBlending,
    // The quad always turns to face the eye, but which way it ends up wound
    // depends on the camera basis, so both sides have to draw.
    side: THREE.DoubleSide,
  });
}

// ===================================================================== BATCH

/**
 * One instanced mesh of billboards, with its instance data in flat typed
 * arrays that are filled from scratch every frame and uploaded whole. The
 * counts here are small enough (hundreds, not thousands) that a full upload
 * is cheaper than tracking dirty ranges, and it keeps the refill code honest.
 */
class PuffBatch {
  readonly geometry = new THREE.InstancedBufferGeometry();
  readonly mesh: THREE.Mesh;
  readonly material: THREE.ShaderMaterial;

  count = 0;

  private readonly capacity: number;
  private readonly center: Float32Array;
  private readonly size: Float32Array;
  private readonly normal: Float32Array;
  private readonly params: Float32Array;
  private readonly aCenter: THREE.InstancedBufferAttribute;
  private readonly aSize: THREE.InstancedBufferAttribute;
  private readonly aNormal: THREE.InstancedBufferAttribute;
  private readonly aParams: THREE.InstancedBufferAttribute;

  constructor(material: THREE.ShaderMaterial, capacity: number, renderOrder: number) {
    this.material = material;
    this.capacity = capacity;

    const pos = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.geometry.setIndex([0, 1, 2, 0, 2, 3]);

    this.center = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity * 4);
    this.normal = new Float32Array(capacity * 3);
    this.params = new Float32Array(capacity * 4);

    this.aCenter = new THREE.InstancedBufferAttribute(this.center, 3);
    this.aSize = new THREE.InstancedBufferAttribute(this.size, 4);
    this.aNormal = new THREE.InstancedBufferAttribute(this.normal, 3);
    this.aParams = new THREE.InstancedBufferAttribute(this.params, 4);
    this.aCenter.setUsage(THREE.DynamicDrawUsage);
    this.aSize.setUsage(THREE.DynamicDrawUsage);
    this.aNormal.setUsage(THREE.DynamicDrawUsage);
    this.aParams.setUsage(THREE.DynamicDrawUsage);

    this.geometry.setAttribute('iCenter', this.aCenter);
    this.geometry.setAttribute('iSize', this.aSize);
    this.geometry.setAttribute('iNormal', this.aNormal);
    this.geometry.setAttribute('iParams', this.aParams);
    this.geometry.instanceCount = 0;

    this.mesh = new THREE.Mesh(this.geometry, material);
    // Culling is ours: the puffs move every frame and the mesh itself sits at
    // the origin, so a bounding sphere would be meaningless.
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.renderOrder = renderOrder;
  }

  begin(): void {
    this.count = 0;
  }

  /** Silently drops puffs past capacity — a full sky degrades, never breaks. */
  push(
    x: number,
    y: number,
    z: number,
    halfW: number,
    halfH: number,
    shade: number,
    spin: number,
    nx: number,
    ny: number,
    nz: number,
    alpha: number,
    seed: number,
    rot: number,
    edge: number,
  ): void {
    if (this.count >= this.capacity || alpha <= 0.002) return;
    const i = this.count++;
    const i3 = i * 3;
    const i4 = i * 4;
    this.center[i3] = x;
    this.center[i3 + 1] = y;
    this.center[i3 + 2] = z;
    this.size[i4] = halfW;
    this.size[i4 + 1] = halfH;
    this.size[i4 + 2] = shade;
    this.size[i4 + 3] = spin;
    this.normal[i3] = nx;
    this.normal[i3 + 1] = ny;
    this.normal[i3 + 2] = nz;
    this.params[i4] = alpha;
    this.params[i4 + 1] = seed;
    this.params[i4 + 2] = rot;
    this.params[i4 + 3] = edge;
  }

  flush(): void {
    this.geometry.instanceCount = this.count;
    if (this.count === 0) return;
    this.aCenter.needsUpdate = true;
    this.aSize.needsUpdate = true;
    this.aNormal.needsUpdate = true;
    this.aParams.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ================================================================ CLOUD LAYER

export class CloudLayer {
  private readonly cumulus: PuffBatch;
  private readonly street: PuffBatch;
  private readonly lens: PuffBatch;
  private readonly rotor: PuffBatch;

  // Per-cloud scratch, filled in pass one and read by the emit and street
  // passes. Preallocated: nothing in update() may allocate.
  private readonly clX: Float32Array;
  private readonly clY: Float32Array;
  private readonly clZ: Float32Array;
  private readonly clR: Float32Array;
  private readonly clA: Float32Array;
  private readonly clDie: Float32Array;
  private readonly clDev: Float32Array;
  private readonly clD: Float32Array;
  private readonly clSeed: Int32Array;
  private readonly clOrder: Int32Array;
  private clCount = 0;
  /** Summed R²·alive from the last pass, for the coverage estimate. */
  private cloudArea = 0;

  private puffs = 6;
  private linkPuffs = 3;
  private rotorPuffs = 8;
  private lensStack = 3;
  private _coverage = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly cfg: Config,
    private readonly wind: WindField,
    atmo: AtmosphereUniforms,
    quality: QualitySettings,
  ) {
    const maxClouds = cfg.thermalCount + 16;

    this.cumulus = new PuffBatch(
      cloudMaterial(atmo, CUMULUS_STYLE),
      maxClouds * MAX_PUFFS_PER_CLOUD,
      ORDER_CUMULUS,
    );
    this.street = new PuffBatch(
      cloudMaterial(atmo, STREET_STYLE),
      maxClouds * STREET_MAX_LINKS * STREET_MAX_PUFFS,
      ORDER_STREET,
    );
    this.lens = new PuffBatch(
      cloudMaterial(atmo, LENS_STYLE),
      MAX_WAVES * MAX_LENS_CRESTS * MAX_LENS_STACK,
      ORDER_LENS,
    );
    this.rotor = new PuffBatch(
      cloudMaterial(atmo, ROTOR_STYLE),
      MAX_WAVES * ROTOR_CRESTS * ROTOR_MAX_PUFFS,
      ORDER_ROTOR,
    );

    this.clX = new Float32Array(maxClouds);
    this.clY = new Float32Array(maxClouds);
    this.clZ = new Float32Array(maxClouds);
    this.clR = new Float32Array(maxClouds);
    this.clA = new Float32Array(maxClouds);
    this.clDie = new Float32Array(maxClouds);
    this.clDev = new Float32Array(maxClouds);
    this.clD = new Float32Array(maxClouds);
    this.clSeed = new Int32Array(maxClouds);
    this.clOrder = new Int32Array(maxClouds);

    this.setQuality(quality);

    scene.add(this.cumulus.mesh);
    scene.add(this.street.mesh);
    scene.add(this.lens.mesh);
    scene.add(this.rotor.mesh);
  }

  /** 0..1 cloud coverage right now — the terrain shader uses it for shadows. */
  get coverage(): number {
    return this._coverage;
  }

  setQuality(q: QualitySettings): void {
    this.puffs = clamp(Math.round(q.cloudPuffs), 3, MAX_PUFFS_PER_CLOUD);
    this.linkPuffs = clamp(Math.round(q.cloudPuffs * 0.55), 2, STREET_MAX_PUFFS);
    this.rotorPuffs = clamp(Math.round(q.cloudPuffs * 1.4), 5, ROTOR_MAX_PUFFS);
    this.lensStack = clamp(Math.round(1 + q.cloudPuffs * 0.3), 2, MAX_LENS_STACK);
  }

  /**
   * `_bird` is unused on purpose: clouds are placed by the world — thermals,
   * waves and the sun — and culled by the camera. Where the bird happens to be
   * has no say in what the sky is doing, which is rather the point.
   */
  update(dt: number, _bird: BirdState, sky: SkyState, cameraPos: THREE.Vector3): void {
    // The wind at cloudbase is the axis everything up here organises along:
    // the lean of a cumulus, the direction a street runs, which way rotor tears.
    this.wind.prevailingAt(sky.cloudBase, _wind);
    const wl = Math.hypot(_wind.x, _wind.z);
    const windX = wl > 1e-3 ? _wind.x / wl : 0;
    const windZ = wl > 1e-3 ? _wind.z / wl : -1;
    const streetF = clamp01(sky.streetFactor);

    this.cumulus.begin();
    this.street.begin();
    this.lens.begin();
    this.rotor.begin();

    this.surveyCumulus(sky, cameraPos);
    this.emitCumulus(sky, windX, windZ, streetF);
    this.emitStreets(streetF, windX, windZ);
    this.emitWaveClouds(cameraPos);

    this.cumulus.flush();
    this.street.flush();
    this.lens.flush();
    this.rotor.flush();

    // Iridescence only when the sun is within ~17° of the horizon. Outside
    // that window the effect is physically wrong and reads as a rendering bug.
    const irid = smoothstep(0.3, 0.02, Math.abs(sky.sunElevation)) * clamp01(sky.sunIntensity);
    this.lens.material.uniforms.uIrid.value = irid;

    // Coverage: total cumulus footprint over the disc thermals live in. The
    // terrain shader only needs to know how dappled the ground is, so a fast
    // honest estimate beats a slow exact one. Damped hard — ground shadow
    // should breathe with the day, never blink as one cloud dies.
    const disc = this.cfg.thermalHorizon * this.cfg.thermalHorizon;
    const raw = clamp01((this.cloudArea * COVERAGE_GAIN) / Math.max(disc, 1) + streetF * 0.06);
    this._coverage = damp(this._coverage, raw, COVERAGE_LAMBDA, dt);
  }

  dispose(): void {
    for (const b of [this.cumulus, this.street, this.lens, this.rotor]) {
      this.scene.remove(b.mesh);
      b.dispose();
    }
  }

  // ------------------------------------------------------------- cumulus

  /**
   * Pass one: decide where each cumulus is, how big, and how alive — then sort
   * back to front. Sorting only the clusters (a couple of dozen) rather than
   * every puff costs nothing and removes almost all of the seams you would
   * otherwise see where two clouds overlap.
   */
  private surveyCumulus(sky: SkyState, cam: THREE.Vector3): void {
    const cfg = this.cfg;
    const thermals = this.wind.thermals();
    const cull = cfg.viewDistance;
    const cap = this.clX.length;
    let area = 0;
    let n = 0;

    for (let i = 0; i < thermals.length && n < cap; i++) {
      const t: ThermalInfo = thermals[i];
      if (!t.hasCloud) continue;

      const ageT = clamp01(t.age / Math.max(cfg.thermalLifetime, 1));
      const forming = smoothstep(CLOUD_FORM_START, CLOUD_FORM_END, ageT);
      if (forming <= 0) continue;
      // Squared so the fade holds on and then lets go, which is what makes a
      // dying cumulus linger over air that has already stopped working.
      const dying = smoothstep(CLOUD_DECAY_START, 1, ageT);
      const alive = forming * (1 - dying * dying);
      if (alive <= 0.004) continue;

      // Condensation happens at cloudbase, and the column leans downwind on
      // the way up — so the cloud is NOT over the hot ground that made it.
      // Chasing the shadow instead of the cloud is a real beginner's error.
      const cy = Math.max(sky.cloudBase, t.base + MIN_CLOUD_CLEARANCE);
      const dh = cy - t.base;
      const cx = t.x + t.tiltX * dh;
      const cz = t.z + t.tiltZ * dh;

      const d = Math.hypot(cx - cam.x, cz - cam.z);
      if (d > cull) continue;
      const distFade = 1 - smoothstep(cull * 0.8, cull, d);

      const dev = clamp(t.strength / Math.max(cfg.thermalStrength, 0.01), 0.35, 1.7);
      const r = t.radius * PUFF_SPREAD * (0.72 + 0.5 * dev);

      this.clX[n] = cx;
      this.clY[n] = cy;
      this.clZ[n] = cz;
      this.clR[n] = r;
      this.clA[n] = alive * distFade;
      this.clDie[n] = dying;
      this.clDev[n] = dev;
      this.clD[n] = d;
      this.clSeed[n] = Math.floor(t.jitter * 8191) | 0;
      this.clOrder[n] = n;
      area += r * r * alive;
      n++;
    }

    this.clCount = n;
    this.cloudArea = area;

    // Insertion sort, farthest first. Never more than a couple of dozen.
    for (let i = 1; i < n; i++) {
      const v = this.clOrder[i];
      const dv = this.clD[v];
      let j = i - 1;
      while (j >= 0 && this.clD[this.clOrder[j]] < dv) {
        this.clOrder[j + 1] = this.clOrder[j];
        j--;
      }
      this.clOrder[j + 1] = v;
    }
  }

  private emitCumulus(sky: SkyState, windX: number, windZ: number, streetF: number): void {
    for (let o = 0; o < this.clCount; o++) {
      this.emitCluster(this.clOrder[o], sky, windX, windZ, streetF);
    }
  }

  private emitCluster(
    k: number,
    sky: SkyState,
    windX: number,
    windZ: number,
    streetF: number,
  ): void {
    const b = this.cumulus;
    const cx = this.clX[k];
    const cy = this.clY[k];
    const cz = this.clZ[k];
    const r = this.clR[k];
    const alive = this.clA[k];
    const dying = this.clDie[k];
    const dev = this.clDev[k];
    const sd = this.clSeed[k];

    // A strong thermal builds a taller cloud. Capped against the cumulus layer
    // depth the day gives us so clouds never punch through their own ceiling.
    const h = Math.min(sky.cloudDepth * (0.32 + 0.55 * dev), r * 1.35);
    const n = this.puffs;
    const baseN = Math.max(2, Math.round(n * BASE_FRACTION));
    const shadeCentreY = h * 0.42;

    // Streets: stretch the cluster along the wind and squeeze it across, so
    // the individual clouds stop being round and start being a line.
    const stretch = 1 + streetF * STREET_STRETCH;
    const squash = 1 / (1 + streetF * STREET_SQUASH);

    for (let i = 0; i < n; i++) {
      const h1 = hash2(i, 11, sd);
      const h2 = hash2(i, 29, sd);
      const h3 = hash2(i, 47, sd);

      let ox = 0;
      let oy = 0;
      let oz = 0;
      let hw = 0;
      let hh = 0;
      let shade = 0;
      let pa = alive;

      if (i < baseN) {
        const ang = (i / baseN) * TAU + (h1 - 0.5) * 1.2;
        const rad = r * (0.18 + 0.78 * h2);
        ox = Math.cos(ang) * rad;
        oz = Math.sin(ang) * rad;
        hw = r * (0.44 + 0.3 * h3);
        hh = hw * 0.7;
        // Every base puff bottoms out at the same height. THIS is the flat
        // base, and the flat base is the single detail that makes a cumulus
        // read as a cumulus rather than as a ball of cotton.
        oy = hh * 0.52 + (h3 - 0.5) * (BASE_RAGGED + dying * BASE_RAGGED_DEATH);
        shade = 1;
        // And the crisp base is the first thing a dying thermal loses.
        pa = alive * (1 - dying * 0.82);
      } else {
        const t = (i - baseN) / Math.max(1, n - baseN);
        const ang = t * 4.7 + h1 * TAU;
        const rad = r * (1 - 0.6 * t) * (0.12 + 0.72 * h2);
        ox = Math.cos(ang) * rad;
        oz = Math.sin(ang) * rad;
        hw = r * (0.38 + 0.26 * h3) * (1 - 0.28 * t);
        hh = hw * (0.82 + 0.22 * h2);
        // Tops lift and thin as the cloud dies — the wisp blowing off the top
        // is the last thing left of a thermal.
        oy = h * (0.16 + 0.84 * Math.pow(t, 0.75)) + (h3 - 0.5) * h * 0.12 + dying * h * 0.35 * t;
        shade = 0.18 * (1 - t);
      }

      if (streetF > 0.001) {
        const along = ox * windX + oz * windZ;
        const ax = ox - along * windX;
        const az = oz - along * windZ;
        ox = windX * along * stretch + ax * squash;
        oz = windZ * along * stretch + az * squash;
      }

      // Fake normal: where this puff sits relative to the cluster's middle.
      // Base puffs get theirs bent hard downward so the underside genuinely
      // shadows instead of just being a bit grey.
      let nx = ox;
      let ny = (oy - shadeCentreY) * (i < baseN ? 2.2 : 1);
      let nz = oz;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;

      b.push(
        cx + ox,
        cy + oy,
        cz + oz,
        hw,
        hh,
        shade,
        0,
        nx,
        ny,
        nz,
        clamp01(pa) * CUMULUS_OPACITY,
        h2 * 64 + i,
        h1 * TAU,
        dying * 0.9 + h1 * 0.1,
      );
    }
  }

  // -------------------------------------------------------------- streets

  /**
   * The afternoon payoff. When convection organises, thermals stop being dots
   * and start being lines running downwind — and you stop circling and start
   * running straight. Connective cloud between neighbouring thermals is what
   * makes the line readable from a long way off, which is the whole point:
   * you can see the highway before you commit to it.
   */
  private emitStreets(streetF: number, windX: number, windZ: number): void {
    if (streetF < 0.02) return;
    const b = this.street;
    const n = this.clCount;

    for (let i = 0; i < n; i++) {
      let made = 0;
      for (let j = i + 1; j < n && made < STREET_MAX_LINKS; j++) {
        const dx = this.clX[j] - this.clX[i];
        const dz = this.clZ[j] - this.clZ[i];
        const d = Math.hypot(dx, dz);
        if (d < STREET_MIN_GAP || d > STREET_MAX_GAP) continue;

        // Only pairs that actually lie along the wind axis join up. Anything
        // else would draw a line the air is not organised along, and the whole
        // value of a street is that it tells the truth about where lift is.
        const align = Math.abs((dx / d) * windX + (dz / d) * windZ);
        if (align < STREET_ALIGN_MIN) continue;

        const w =
          smoothstep(STREET_ALIGN_MIN, 0.99, align) *
          streetF *
          Math.min(this.clA[i], this.clA[j]) *
          (1 - smoothstep(STREET_MAX_GAP * 0.65, STREET_MAX_GAP, d));
        if (w < 0.01) continue;
        made++;

        const seg = Math.min(this.linkPuffs, Math.max(2, Math.round(d / STREET_SPACING)));
        for (let s = 0; s < seg; s++) {
          const u = (s + 0.5) / seg;
          const h1 = hash2(i * 131 + j, s, this.clSeed[i]);
          const h2 = hash2(i, s * 17 + j, this.clSeed[j] + 401);

          const rr = lerp(this.clR[i], this.clR[j], u);
          const hw = rr * (0.42 + 0.35 * h1);
          const hh = hw * (0.26 + 0.14 * h2);
          // Connective cloud is thin and sags between its parents, and it is
          // fullest right where the two real clouds are.
          const fill = 0.55 + 0.45 * Math.abs(Math.cos(u * Math.PI));
          const py =
            lerp(this.clY[i], this.clY[j], u) - STREET_SAG * (1 - Math.abs(2 * u - 1)) + hh * 0.4;

          let nx = (h1 - 0.5) * 0.6;
          let ny = 0.55;
          let nz = (h2 - 0.5) * 0.6;
          const nl = Math.hypot(nx, ny, nz) || 1;
          nx /= nl;
          ny /= nl;
          nz /= nl;

          b.push(
            this.clX[i] + dx * u,
            py,
            this.clZ[i] + dz * u,
            hw,
            hh,
            0.45,
            0,
            nx,
            ny,
            nz,
            w * fill * STREET_OPACITY,
            h1 * 71 + s,
            h2 * TAU,
            0.15 + 0.2 * h2,
          );
        }
      }
    }
  }

  // --------------------------------------------------- lenticular & rotor

  /**
   * Neither of these reads the day at all, and that is the point: wave does
   * not need the sun, so its clouds are the only ones still standing at night.
   */
  private emitWaveClouds(cam: THREE.Vector3): void {
    const cfg = this.cfg;
    const waves = this.wind.waves();
    const cull = cfg.viewDistance;
    const count = Math.min(waves.length, MAX_WAVES);

    for (let i = 0; i < count; i++) {
      const w: WaveInfo = waves[i];
      const strength = clamp01(w.amplitude / Math.max(cfg.waveAmplitude, 0.001));
      if (strength < 0.06) continue;

      // Stable per-wave randomness from the crest that generates it, so a
      // lenticular has the same shape every time you fly past it. They are
      // landmarks; landmarks do not reshuffle.
      const sd = (Math.floor(w.crestX * 0.013) ^ Math.floor(w.crestZ * 0.017)) | 0;
      const perpX = -w.dirZ;
      const perpZ = w.dirX;
      const crests = Math.max(1, Math.min(w.crests, MAX_LENS_CRESTS));

      // ---- lenticular: the stillest thing in the game ---------------------
      // Their positions come only from the wave's own geometry — no wind, no
      // drift, no time. Everything else in the sky streams downwind past them.
      for (let k = 0; k < crests; k++) {
        const dist = w.wavelength * (k + LENS_CREST_PHASE);
        const px = w.crestX + w.dirX * dist;
        const pz = w.crestZ + w.dirZ * dist;
        const d = Math.hypot(px - cam.x, pz - cam.z);
        if (d > cull) continue;
        const distFade = 1 - smoothstep(cull * 0.8, cull, d);
        // Each crest downwind is weaker than the one before it.
        const decay = 1 - k / (w.crests + 0.8);
        const stack = Math.max(2, Math.min(this.lensStack, Math.round(2 + strength * 2)));

        for (let s = 0; s < stack; s++) {
          const h1 = hash2(k * 7 + s, i * 13, sd);
          const h2 = hash2(k, s * 23 + i, sd + 61);
          const h3 = hash2(s, k * 5 + i, sd + 199);

          const hw = w.halfWidth * LENS_WIDTH * (1 - 0.14 * s) * (0.78 + 0.4 * h2);
          const hh = hw * LENS_ASPECT * (0.8 + 0.35 * h3);
          const lat = (h1 - 0.5) * hw * 0.5;
          const lon = (h2 - 0.5) * w.wavelength * 0.08 + s * LENS_LEAN;

          // A lens is a smooth dome: normal mostly up, leaning with the
          // offset so the stack does not all light identically.
          let nx = lat * 0.0012 + (h2 - 0.5) * 0.25;
          let ny = 1;
          let nz = (h3 - 0.5) * 0.25;
          const nl = Math.hypot(nx, ny, nz) || 1;
          nx /= nl;
          ny /= nl;
          nz /= nl;

          this.lens.push(
            px + perpX * lat + w.dirX * lon,
            w.base + LENS_FIRST_OFFSET + s * LENS_GAP * (0.85 + 0.3 * h1),
            pz + perpZ * lat + w.dirZ * lon,
            hw,
            hh,
            LENS_SHADE,
            0,
            nx,
            ny,
            nz,
            LENS_OPACITY * smoothstep(0.08, 0.5, strength) * decay * distFade * (0.8 + 0.25 * h3),
            h1 * 53 + s * 3 + k,
            0,
            0,
          );
        }
      }

      // ---- rotor: the warning label on the doorway ------------------------
      // A torn line of dark cloud under the wave base, slightly upwind of the
      // lens above it. Broken silhouette, tumbling fragments, opacity churning
      // — everything about it should read as "this will be rough".
      const rotorCrests = Math.min(crests, ROTOR_CRESTS);
      const nP = this.rotorPuffs;
      const rotorY = w.base - cfg.rotorDepth * 0.45;

      for (let k = 0; k < rotorCrests; k++) {
        const dist = w.wavelength * (k + ROTOR_CREST_PHASE);
        const px = w.crestX + w.dirX * dist;
        const pz = w.crestZ + w.dirZ * dist;
        const d = Math.hypot(px - cam.x, pz - cam.z);
        if (d > cull) continue;
        const distFade = 1 - smoothstep(cull * 0.8, cull, d);

        for (let j = 0; j < nP; j++) {
          const u = nP > 1 ? (j / (nP - 1)) * 2 - 1 : 0;
          const h1 = hash2(j * 5 + k, i * 29, sd + 811);
          const h2 = hash2(j, k * 31 + i, sd + 1277);
          const h3 = hash2(j * 3, k + i * 7, sd + 1699);

          const along = (h1 - 0.5) * ROTOR_SCATTER;
          const across = u * w.halfLength * ROTOR_LINE;
          const hw = ROTOR_PUFF * (0.55 + 0.9 * h3);
          const hh = hw * (0.5 + 0.45 * h1);

          let nx = h1 - 0.5;
          let ny = -0.2 + h2 * 0.5;
          let nz = h3 - 0.5;
          const nl = Math.hypot(nx, ny, nz) || 1;
          nx /= nl;
          ny /= nl;
          nz /= nl;

          this.rotor.push(
            px + perpX * across + w.dirX * along,
            rotorY + (h2 - 0.5) * cfg.rotorDepth * 0.55,
            pz + perpZ * across + w.dirZ * along,
            hw,
            hh,
            0.35 + 0.3 * h3,
            (h1 - 0.5) * ROTOR_SPIN,
            nx,
            ny,
            nz,
            ROTOR_OPACITY *
              smoothstep(0.12, 0.55, strength) *
              (1 - u * u * 0.55) *
              distFade *
              (1 - k * 0.35),
            h2 * 88 + j,
            h3 * TAU,
            0.35 + 0.35 * h2,
          );
        }
      }
    }
  }
}
