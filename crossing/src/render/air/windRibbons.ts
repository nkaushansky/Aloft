/**
 * THE AIR, MADE VISIBLE.
 *
 * Every flight game treats the sky as empty space you move through. This one
 * treats it as terrain you read. `WindRibbons` seeds a few thousand passive
 * tracers into the real wind field around the bird and draws each one as a
 * short tapered streak of its own colour: gold where the air is going up,
 * cold blue-grey where it is falling, violet where it is tumbling. Nothing
 * here is decorative — a ribbon's colour is the kind of air, its brightness is
 * how fast that air is moving vertically, and its length is how fast it is
 * moving at all. A player who learns to read them can point at lift.
 *
 * `AirColumns` is the long-range half of the same readout: a soft luminous
 * shaft standing over every thermal worth crossing to, faint enough at two
 * kilometres to be a suggestion and unmistakable at two hundred metres.
 *
 * Performance shape, because it is the whole design of this file:
 *   - one CPU particle pool in flat Float32Arrays, zero allocation per frame;
 *   - the wind field is sampled for only 1/Nth of the pool each frame and the
 *     rest coast on their cached velocity (see SAMPLE_SLICES);
 *   - two draw calls total, sharing one set of instanced attributes.
 */

import * as THREE from 'three';
import type { Config } from '../../sim/config';
import { clamp01, smoothstep } from '../../sim/math';
import { makeRng } from '../../sim/noise';
import type {
  BirdState,
  QualitySettings,
  SkyState,
  WindField,
  WindSample,
} from '../../sim/types';
import { AirKind, makeWindSample } from '../../sim/types';
import { airKindColor } from '../../sim/wind';
import type { AtmosphereUniforms } from '../shaders/atmosphere';
import { ATMOSPHERE_PRELUDE, withAtmosphere } from '../shaders/atmosphere';

/** three's uniform bag, once the shared atmosphere has been merged in. */
type UniformMap = { [name: string]: THREE.IUniform };

// =========================================================== THE LEGEND

/**
 * The hues come from `airKindColor` in the sim, which is also what the vario
 * and the logbook read — there is exactly one answer in this game to "what
 * colour is a thermal", and it does not live here.
 *
 * What does live here is *value*, because the same hue has to do two opposite
 * jobs. Rising air is light added to the frame, so it is pushed above 1.0 to
 * give the bloom pass something to catch. Sinking air is drawn as something
 * dark hanging in front of the world, so it keeps its cold blue but at a
 * fraction of its brightness: raise SINK_COLOR_SCALE and sink stops reading as
 * a shadow and starts reading as blue mist.
 */
const LIFT_COLOR_GAIN = 1.35;
const SINK_COLOR_SCALE = 0.3;

// ====================================================== SHARED GEOMETRY

/**
 * A flat parametric strip: `position.x` runs 0 (head) to 1 (tail) and
 * `position.y` is -1..1 across. Both classes build their real geometry in the
 * vertex shader from this, because a camera-facing ribbon has no fixed shape
 * in object space. Reusing three's mandatory `position` attribute for the
 * parameters saves an attribute slot and an upload.
 */
function buildStripAttributes(segments: number): {
  position: THREE.BufferAttribute;
  index: THREE.BufferAttribute;
} {
  const rings = segments + 1;
  const pos = new Float32Array(rings * 2 * 3);
  for (let s = 0; s <= segments; s++) {
    const u = s / segments;
    const o = s * 6;
    pos[o] = u;
    pos[o + 1] = -1;
    pos[o + 2] = 0;
    pos[o + 3] = u;
    pos[o + 4] = 1;
    pos[o + 5] = 0;
  }
  const idx = new Uint16Array(segments * 6);
  for (let s = 0; s < segments; s++) {
    const b = s * 2;
    const o = s * 6;
    idx[o] = b;
    idx[o + 1] = b + 1;
    idx[o + 2] = b + 2;
    idx[o + 3] = b + 2;
    idx[o + 4] = b + 1;
    idx[o + 5] = b + 3;
  }
  return {
    position: new THREE.BufferAttribute(pos, 3),
    index: new THREE.BufferAttribute(idx, 1),
  };
}

// ============================================================= RIBBONS

/**
 * How many frames it takes for every ribbon to re-read the air. THE most
 * important number in this file: `wind.sample()` walks every thermal, wave and
 * convergence line near the bird, and doing that 2600 times at 60 Hz would eat
 * the frame on its own. At 3 slices each ribbon refreshes every 50 ms while a
 * ribbon travelling 12 m/s has moved 0.6 m — a rounding error against air
 * features that are hundreds of metres wide. Raising this buys frame time at
 * the cost of ribbons lagging when they cross a sharp thermal edge.
 */
const SAMPLE_SLICES = 3;

/**
 * Positions remembered per ribbon. The streak drawn on screen is the chord
 * from the oldest remembered position to the current one, so a ribbon curling
 * round a thermal core actually leans the way it curled. More samples means a
 * finer-grained history and a smoother tail; 5 spans cfg.ribbonLife in 4 steps.
 */
const TRAIL_SAMPLES = 5;

/** Segments along a ribbon. Enough to carry the comet taper smoothly. */
const RIBBON_SEGMENTS = 6;

/** Longest streak we will ever draw (m). Above this, fast air smears. */
const MAX_STREAK = 48;
const MAX_STREAK_SQ = MAX_STREAK * MAX_STREAK;

/** Seconds a ribbon exists before it is retired and reborn somewhere else. */
const LIFE_MIN = 7;
const LIFE_MAX = 15;
/** Fraction of a life spent easing in / easing out. Nothing ever pops. */
const FADE_IN = 0.12;
const FADE_OUT = 0.3;
/** Fraction of the box half-extent used to ease ribbons out at the walls. */
const EDGE_FADE = 0.16;

/** Vertical air speeds (m/s) that map to "nothing" and "fully lit". */
const RISE_MIN = 0.25;
const RISE_FULL = 4.6;
/** What a ribbon in dead-flat air still shows. Keeps the sky from going bald. */
const RISE_FLOOR = 0.07;
/** How much of a ribbon's brightness survives when the feature is weak. */
const INTENSITY_FLOOR = 0.4;
/**
 * Downward air slower than this still goes in the glowing pass. A faint
 * neutral shimmer reads better than a faint grey stain, and it keeps the
 * boundary between "calm" and "sinking" from flickering.
 */
const SINK_DEADBAND = 0.18;

/** Half-width of a ribbon (m) before per-ribbon jitter. */
const RIBBON_HALF_WIDTH = 0.45;
/**
 * Peak alpha of a fully lit ribbon. The single knob for how loud the air is;
 * everything else scales off it. Kept low because there are thousands of them
 * and because the calm tone says: suggest, don't shout.
 */
const BASE_OPACITY = 0.5;

/** Metres of clearance a respawn keeps from the eye, so nothing pops on-lens. */
const SPAWN_CLEARANCE = 30;

const RIBBON_VERT = /* glsl */ `
uniform vec3  uEye;
uniform float uOpacity;
uniform float uWidth;
uniform float uPassSign;
uniform float uPassGain;
uniform float uWidthScale;

attribute vec3 aPos;    // ribbon head, metres relative to the group origin
attribute vec3 aTail;   // head -> tail offset; its length IS the streak length
attribute vec3 aColor;  // linear RGB for this ribbon's kind of air
attribute vec2 aState;  // x: signed strength (sign picks the pass), y: seed 0..1

varying vec3  vWorld;
varying vec3  vCol;
varying float vAlpha;
varying float vU;
varying float vV;
varying float vDist;

void main() {
  // Each pass draws only its own half of the population; the other half is
  // collapsed behind the far plane so it costs one vertex and no fragments.
  float a = max(aState.x * uPassSign, 0.0) * uOpacity * uPassGain;
  float len = length(aTail);

  if (a <= 0.0 || len < 0.05) {
    vWorld = vec3(0.0); vCol = vec3(0.0);
    vAlpha = 0.0; vU = 0.0; vV = 0.0; vDist = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  float u = position.x;
  float v = position.y;

  vec3 head = (modelMatrix * vec4(aPos, 1.0)).xyz;
  vec3 dir = aTail / len;                 // the group is translation-only
  vec3 center = head + aTail * u;

  vec3 toEye = uEye - center;
  float dist = length(toEye);
  vec3 eyeDir = toEye / max(dist, 1e-4);

  // Billboard about the streak's own axis, so a ribbon is always broadside to
  // the camera and always readable. When the streak points straight at the eye
  // the cross product vanishes — any perpendicular will do, because at that
  // angle the ribbon is end-on and almost nothing anyway.
  vec3 side = cross(dir, eyeDir);
  float sl = length(side);
  side = sl > 1e-3 ? side / sl : normalize(cross(dir, vec3(0.0, 1.0, 0.0)) + vec3(1e-3, 0.0, 0.0));

  // Comet profile: nothing at the head, widest just behind it, tapering to
  // nothing again at the tail. Lowering HEAD_BIAS moves the fat part forward.
  const float HEAD_BIAS = 0.55;
  float prof = sin(3.14159265 * pow(clamp(u, 0.0, 1.0), HEAD_BIAS));

  float hw = uWidth * uWidthScale * (0.70 + 0.75 * aState.y) * prof;

  // Hold a minimum on-screen thickness so distant ribbons stay a clean line
  // instead of shimmering in and out of the pixel grid, and hand the extra
  // width back as opacity so the total light on screen is unchanged.
  const float MIN_SUBTEND = 0.0018;   // ~1.6 px at 62 deg fov on a 1080p frame
  float minHalf = dist * MIN_SUBTEND;
  float w = max(hw, minHalf);
  float comp = hw > 1e-5 ? hw / w : 0.0;

  vec3 world = center + side * (v * w);

  vWorld = world;
  vCol   = aColor;
  vAlpha = a * comp;
  vU = u;
  vV = v;
  vDist = dist;

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const RIBBON_FRAG = /* glsl */ `
${ATMOSPHERE_PRELUDE}

uniform vec2  uFarFade;   // (start, end) metres of the outer fade
uniform float uPassSign;

varying vec3  vWorld;
varying vec3  vCol;
varying float vAlpha;
varying float vU;
varying float vV;
varying float vDist;

void main() {
  // Soft everywhere, hard edges nowhere: a gaussian across the ribbon, offset
  // so it reaches exactly zero at the geometry's edge instead of stopping at
  // a small value and leaving a visible seam.
  const float ACROSS = 3.0;
  const float ACROSS_EDGE = 0.049787;         // exp(-ACROSS)
  float across = max(0.0, (exp(-ACROSS * vV * vV) - ACROSS_EDGE) / (1.0 - ACROSS_EDGE));

  // Brightest just behind the head and dying into the tail — that gradient is
  // what makes a still image of a ribbon still read as movement.
  float along = (1.0 - vU) * (0.55 + 0.45 * smoothstep(0.0, 0.14, vU));

  float a = vAlpha * across * along;

  // Nothing may smear across the lens. Ribbons closer than NEAR_GONE simply do
  // not exist, and they ease in over the next few wingspans.
  const float NEAR_GONE = 5.0;
  const float NEAR_FULL = 26.0;
  a *= smoothstep(NEAR_GONE, NEAR_FULL, vDist);
  a *= 1.0 - smoothstep(uFarFade.x, uFarFade.y, vDist);
  if (a < 0.0035) discard;

  vec3 viewDir = normalize(vWorld - uCameraPos);
  vec3 col = vCol;

  // Looking toward the sun through rising air is the most beautiful thing in
  // the game. Let it blow out — the bloom pass is downstream and hungry.
  const float BACKLIT_GAIN = 2.6;
  float backlit = pow(max(dot(viewDir, uSunDir), 0.0), 7.0) * uSunIntensity;
  col *= 1.0 + BACKLIT_GAIN * backlit * max(uPassSign, 0.0);

  col = aerialPerspective(col, vWorld, viewDir, vDist);
  col += ditherValue(gl_FragCoord.xy);

  gl_FragColor = vec4(col, a);
}
`;

export class WindRibbons {
  private readonly scene: THREE.Scene;
  private readonly cfg: Config;
  private readonly wind: WindField;
  private readonly group: THREE.Group;

  private readonly liftGeo: THREE.InstancedBufferGeometry;
  private readonly sinkGeo: THREE.InstancedBufferGeometry;
  private readonly liftMat: THREE.ShaderMaterial;
  private readonly sinkMat: THREE.ShaderMaterial;
  private readonly liftMesh: THREE.Mesh;
  private readonly sinkMesh: THREE.Mesh;

  /** Shared uniform objects, held by reference so one write feeds both passes. */
  private readonly u = {
    uEye: { value: new THREE.Vector3() },
    uOpacity: { value: BASE_OPACITY },
    uWidth: { value: RIBBON_HALF_WIDTH },
    uFarFade: { value: new THREE.Vector2(1, 2) },
  };

  // --- the pool -----------------------------------------------------------
  private readonly pool: number;
  private count = 0;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  /** Signed: positive rides the glowing pass, negative the dark one. */
  private readonly strength: Float32Array;
  private readonly trail: Float32Array;

  private readonly aPosArr: Float32Array;
  private readonly aTailArr: Float32Array;
  private readonly aColorArr: Float32Array;
  private readonly aStateArr: Float32Array;
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aTail: THREE.InstancedBufferAttribute;
  private readonly aColor: THREE.InstancedBufferAttribute;
  private readonly aState: THREE.InstancedBufferAttribute;

  private readonly rng: () => number;
  private readonly ws: WindSample = makeWindSample();

  private sliceCursor = 0;
  private trailHead = 0;
  private trailTimer = 0;
  private readonly trailInterval: number;
  private primed = false;

  /** Last known bird / eye position, so setQuality can respawn sensibly. */
  private ox = 0;
  private oy = 0;
  private oz = 0;
  private ex = 0;
  private ey = 0;
  private ez = 0;

  constructor(
    scene: THREE.Scene,
    cfg: Config,
    wind: WindField,
    atmo: AtmosphereUniforms,
    quality: QualitySettings,
  ) {
    this.scene = scene;
    this.cfg = cfg;
    this.wind = wind;
    this.rng = makeRng((cfg.seed ^ 0x71bb0) >>> 0);

    // The pool is allocated once at the config ceiling and quality only moves
    // how many of it are drawn. Resizing typed arrays mid-flight would hitch,
    // and the whole pool is under half a megabyte.
    this.pool = Math.max(1, Math.floor(cfg.windRibbons));
    this.count = Math.max(0, Math.min(Math.floor(quality.windRibbons), this.pool));

    this.pos = new Float32Array(this.pool * 3);
    this.vel = new Float32Array(this.pool * 3);
    this.age = new Float32Array(this.pool);
    this.life = new Float32Array(this.pool);
    this.strength = new Float32Array(this.pool);
    this.trail = new Float32Array(TRAIL_SAMPLES * this.pool * 3);

    this.aPosArr = new Float32Array(this.pool * 3);
    this.aTailArr = new Float32Array(this.pool * 3);
    this.aColorArr = new Float32Array(this.pool * 3);
    this.aStateArr = new Float32Array(this.pool * 2);
    this.aPos = new THREE.InstancedBufferAttribute(this.aPosArr, 3);
    this.aTail = new THREE.InstancedBufferAttribute(this.aTailArr, 3);
    this.aColor = new THREE.InstancedBufferAttribute(this.aColorArr, 3);
    this.aState = new THREE.InstancedBufferAttribute(this.aStateArr, 2);
    this.aPos.setUsage(THREE.DynamicDrawUsage);
    this.aTail.setUsage(THREE.DynamicDrawUsage);
    this.aColor.setUsage(THREE.DynamicDrawUsage);
    this.aState.setUsage(THREE.DynamicDrawUsage);

    // A ribbon's drawn streak spans cfg.ribbonLife seconds of air travel, and
    // the trail records that window in TRAIL_SAMPLES-1 equal steps.
    this.trailInterval = Math.max(0.05, cfg.ribbonLife / (TRAIL_SAMPLES - 1));

    const strip = buildStripAttributes(RIBBON_SEGMENTS);
    this.liftGeo = this.makeGeometry(strip);
    this.sinkGeo = this.makeGeometry(strip);

    // Rising air is light ADDED to the frame; sinking air is something dark
    // hanging in front of it. One blend mode cannot do both honestly, so there
    // are two passes over one pool and each instance sits out the wrong one.
    this.liftMat = new THREE.ShaderMaterial({
      uniforms: withAtmosphere(atmo, {
        ...this.u,
        uPassSign: { value: 1 },
        uPassGain: { value: 1 },
        uWidthScale: { value: 1 },
      }) as unknown as UniformMap,
      vertexShader: RIBBON_VERT,
      fragmentShader: RIBBON_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      // Linear HDR out; the post chain owns tonemapping and grading.
      toneMapped: false,
    });

    this.sinkMat = new THREE.ShaderMaterial({
      uniforms: withAtmosphere(atmo, {
        ...this.u,
        uPassSign: { value: -1 },
        // Falling air is quieter than rising air — it is a warning, not an
        // invitation. Raising this makes sink read as a heavier curtain.
        uPassGain: { value: 0.62 },
        // ...and broader, so it reads as a sheet rather than as sparks.
        uWidthScale: { value: 1.7 },
      }) as unknown as UniformMap,
      vertexShader: RIBBON_VERT,
      fragmentShader: RIBBON_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.sinkMesh = new THREE.Mesh(this.sinkGeo, this.sinkMat);
    this.liftMesh = new THREE.Mesh(this.liftGeo, this.liftMat);
    // Dark first, glow on top: the lift is what the player is looking for.
    this.sinkMesh.renderOrder = 8;
    this.liftMesh.renderOrder = 9;
    this.sinkMesh.frustumCulled = false;
    this.liftMesh.frustumCulled = false;

    this.group = new THREE.Group();
    this.group.matrixAutoUpdate = true;
    this.group.add(this.sinkMesh, this.liftMesh);
    scene.add(this.group);

    this.setInstanceCount(this.count);
  }

  private makeGeometry(strip: {
    position: THREE.BufferAttribute;
    index: THREE.BufferAttribute;
  }): THREE.InstancedBufferGeometry {
    const g = new THREE.InstancedBufferGeometry();
    // The base strip and every instanced attribute are shared between the two
    // passes, so the whole pool is uploaded to the GPU exactly once a frame.
    g.setAttribute('position', strip.position);
    g.setIndex(strip.index);
    g.setAttribute('aPos', this.aPos);
    g.setAttribute('aTail', this.aTail);
    g.setAttribute('aColor', this.aColor);
    g.setAttribute('aState', this.aState);
    g.instanceCount = 0;
    return g;
  }

  private setInstanceCount(n: number): void {
    this.liftGeo.instanceCount = n;
    this.sinkGeo.instanceCount = n;
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Put a ribbon somewhere fresh inside the box. `stagger` spreads the initial
   * ages so a whole population never breathes in unison; ordinary respawns
   * start at zero and ease in, which is invisible because they happen at
   * whatever moment each ribbon happens to leave the box.
   */
  private respawn(i: number, half: number, stagger: boolean): void {
    const rng = this.rng;
    let x = this.ox + (rng() * 2 - 1) * half;
    let y = this.oy + (rng() * 2 - 1) * half;
    let z = this.oz + (rng() * 2 - 1) * half;

    // Never light up in the camera's lap: push a spawn that landed too close
    // out to where the near fade can ease it in properly.
    const dx = x - this.ex;
    const dy = y - this.ey;
    const dz = z - this.ez;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d < SPAWN_CLEARANCE) {
      if (d < 1e-3) {
        x = this.ex + SPAWN_CLEARANCE;
        y = this.ey;
        z = this.ez;
      } else {
        const k = SPAWN_CLEARANCE / d;
        x = this.ex + dx * k;
        y = this.ey + dy * k;
        z = this.ez + dz * k;
      }
    }

    const i3 = i * 3;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.life[i] = LIFE_MIN + rng() * (LIFE_MAX - LIFE_MIN);
    this.age[i] = stagger ? rng() * this.life[i] : 0;
    this.aStateArr[i * 2 + 1] = rng();

    // The trail starts collapsed on the spawn point, so the streak grows out
    // of nothing over its first cfg.ribbonLife seconds instead of appearing
    // at full length.
    for (let s = 0; s < TRAIL_SAMPLES; s++) {
      const b = s * this.pool * 3 + i3;
      this.trail[b] = x;
      this.trail[b + 1] = y;
      this.trail[b + 2] = z;
    }

    this.sampleAir(i, x, y, z);
  }

  /** Read the air at one ribbon and cache everything the frame loop needs. */
  private sampleAir(i: number, x: number, y: number, z: number): void {
    const s = this.wind.sample(x, y, z, this.ws);
    const i3 = i * 3;
    this.vel[i3] = s.vx;
    this.vel[i3 + 1] = s.vy;
    this.vel[i3 + 2] = s.vz;

    // Brightness is the readout. A ribbon in dead air is a trace; a ribbon in
    // a five-metre core is a spark. Raising RISE_FULL calms the whole sky.
    const rise = Math.abs(s.vy);
    let str = RISE_FLOOR + (1 - RISE_FLOOR) * smoothstep(RISE_MIN, RISE_FULL, rise);
    str *= INTENSITY_FLOOR + (1 - INTENSITY_FLOOR) * clamp01(s.intensity);
    const rising = s.vy > -SINK_DEADBAND;
    this.strength[i] = rising ? str : -str;

    const c = airKindColor(s.kind);
    // A little per-ribbon brightness scatter, so a core reads as many separate
    // sparks rather than as one flat wash. A ribbon only ever appears in one of
    // the two passes, so its value can be baked in here rather than branched
    // for in the shader.
    const j = (rising ? LIFT_COLOR_GAIN : SINK_COLOR_SCALE) * (0.80 + 0.40 * this.aStateArr[i * 2 + 1]);
    this.aColorArr[i3] = c.r * j;
    this.aColorArr[i3 + 1] = c.g * j;
    this.aColorArr[i3 + 2] = c.b * j;
  }

  // ---------------------------------------------------------------- update

  update(dt: number, bird: BirdState, sky: SkyState, cameraPos: THREE.Vector3): void {
    if (this.count <= 0) return;

    // A tab switch or a long GC pause must not teleport the whole population
    // to the far side of the county.
    const step = dt < 0.1 ? dt : 0.1;

    const half = this.cfg.ribbonBox * 0.5;
    this.ox = bird.position.x;
    this.oy = bird.position.y;
    this.oz = bird.position.z;
    this.ex = cameraPos.x;
    this.ey = cameraPos.y;
    this.ez = cameraPos.z;
    this.group.position.set(this.ox, this.oy, this.oz);

    if (!this.primed) {
      // First frame: we finally know where the bird actually is.
      for (let i = 0; i < this.pool; i++) this.respawn(i, half, true);
      this.primed = true;
    }

    this.trailTimer += step;
    // step is clamped well below trailInterval, so one rotation per frame is
    // always enough and the tail can never jump.
    const frac = clamp01(this.trailTimer / this.trailInterval);
    const oldBase = ((this.trailHead + 1) % TRAIL_SAMPLES) * this.pool * 3;
    const nextBase = ((this.trailHead + 2) % TRAIL_SAMPLES) * this.pool * 3;

    // The rotating wind-sampling slice. See SAMPLE_SLICES.
    const sliceSize = Math.ceil(this.count / SAMPLE_SLICES);
    const sStart = this.sliceCursor;
    const sEnd = Math.min(sStart + sliceSize, this.count);
    this.sliceCursor = sEnd >= this.count ? 0 : sEnd;

    for (let i = 0; i < this.count; i++) {
      const i3 = i * 3;

      // Advect with the cached air velocity: a ribbon is a passive tracer, it
      // has no will of its own.
      const nx = this.pos[i3] + this.vel[i3] * step;
      const ny = this.pos[i3 + 1] + this.vel[i3 + 1] * step;
      const nz = this.pos[i3 + 2] + this.vel[i3 + 2] * step;
      const age = this.age[i] + step;

      const dx = nx - this.ox;
      const dy = ny - this.oy;
      const dz = nz - this.oz;
      const gone =
        age >= this.life[i] ||
        dx < -half || dx > half ||
        dy < -half || dy > half ||
        dz < -half || dz > half;

      if (gone) {
        this.respawn(i, half, false);
      } else {
        this.pos[i3] = nx;
        this.pos[i3 + 1] = ny;
        this.pos[i3 + 2] = nz;
        this.age[i] = age;
        if (i >= sStart && i < sEnd) this.sampleAir(i, nx, ny, nz);
      }

      const x = this.pos[i3];
      const y = this.pos[i3 + 1];
      const z = this.pos[i3 + 2];

      // The streak is the chord of the path over the last cfg.ribbonLife
      // seconds, interpolated between the two oldest samples so the tail
      // slides continuously instead of stepping when the ring rotates.
      const oa = oldBase + i3;
      const ob = nextBase + i3;
      let tx = this.trail[oa] + (this.trail[ob] - this.trail[oa]) * frac - x;
      let ty = this.trail[oa + 1] + (this.trail[ob + 1] - this.trail[oa + 1]) * frac - y;
      let tz = this.trail[oa + 2] + (this.trail[ob + 2] - this.trail[oa + 2]) * frac - z;
      const tl2 = tx * tx + ty * ty + tz * tz;
      if (tl2 > MAX_STREAK_SQ) {
        const k = MAX_STREAK / Math.sqrt(tl2);
        tx *= k;
        ty *= k;
        tz *= k;
      }

      // Life envelope, plus a soft ease-out at the walls of the box so no
      // ribbon ever blinks out of existence at a hard boundary.
      const t = this.age[i] / this.life[i];
      let env = smoothstep(0, FADE_IN, t) * (1 - smoothstep(1 - FADE_OUT, 1, t));
      const ax = 1 - Math.abs(x - this.ox) / half;
      const ay = 1 - Math.abs(y - this.oy) / half;
      const az = 1 - Math.abs(z - this.oz) / half;
      const edge = ax < ay ? (ax < az ? ax : az) : ay < az ? ay : az;
      env *= smoothstep(0, EDGE_FADE, edge);

      this.aPosArr[i3] = x - this.ox;
      this.aPosArr[i3 + 1] = y - this.oy;
      this.aPosArr[i3 + 2] = z - this.oz;
      this.aTailArr[i3] = tx;
      this.aTailArr[i3 + 1] = ty;
      this.aTailArr[i3 + 2] = tz;
      this.aStateArr[i * 2] = this.strength[i] * env;
    }

    if (this.trailTimer >= this.trailInterval) {
      this.trailTimer -= this.trailInterval;
      this.trailHead = (this.trailHead + 1) % TRAIL_SAMPLES;
      // The slot we just rotated onto is the one that had aged out; overwrite
      // it wholesale with where everybody is now.
      this.trail.set(this.pos, this.trailHead * this.pool * 3);
    }

    // How loud the air is allowed to be. Flat cold air should be a whisper and
    // a working sky unmistakable — but the floor rises after dark, because
    // mountain wave is the only lift left then and it still has to be found.
    const dayGain = 0.34 + 0.66 * clamp01(sky.thermalActivity);
    const nightFloor = 0.30 + 0.32 * clamp01(sky.starVisibility);
    this.u.uOpacity.value = BASE_OPACITY * Math.max(dayGain, nightFloor);
    this.u.uEye.value.copy(cameraPos);
    // Ribbons thin out well before the box wall, so the population's edge is
    // never something you can see.
    this.u.uFarFade.value.set(half * 0.62, half * 1.05);

    this.aPos.needsUpdate = true;
    this.aTail.needsUpdate = true;
    this.aColor.needsUpdate = true;
    this.aState.needsUpdate = true;
  }

  setQuality(q: QualitySettings): void {
    const next = Math.max(0, Math.min(Math.floor(q.windRibbons), this.pool));
    if (next === this.count) return;
    if (next > this.count && this.primed) {
      const half = this.cfg.ribbonBox * 0.5;
      for (let i = this.count; i < next; i++) this.respawn(i, half, true);
    }
    this.count = next;
    if (this.sliceCursor >= next) this.sliceCursor = 0;
    this.setInstanceCount(next);
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.group.remove(this.sinkMesh, this.liftMesh);
    this.liftGeo.dispose();
    this.sinkGeo.dispose();
    this.liftMat.dispose();
    this.sinkMat.dispose();
  }
}

// ============================================================== COLUMNS

/** Hard ceiling on column instances; quality picks how many of these are used. */
const COLUMN_CAP = 16;
/** Segments up a column. Carries the taper and the neck at the bottom. */
const COLUMN_SEGMENTS = 12;
/** A thermal below this much of its lifecycle is not worth crossing to. */
const COLUMN_MIN_LIFE = 0.26;
/** ...nor one below this fraction of the day's nominal core strength. */
const COLUMN_MIN_STRENGTH = 0.42;
/** How much wider than the working core the column is drawn, at the base. */
const COLUMN_BASE_FLARE = 1.15;
/** ...and at the top, because a thermal spreads as it rises. */
const COLUMN_TOP_FLARE = 1.9;
/**
 * Peak alpha of a column. Deliberately tiny: the column is a hint you notice
 * on the horizon, not a wall. Raising it makes thermals easier to find and the
 * sky busier.
 */
const COLUMN_OPACITY = 0.075;

const COLUMN_VERT = /* glsl */ `
uniform vec3 uEye;

attribute vec3 aBase;   // column foot, metres relative to the group origin
attribute vec3 aAxis;   // foot -> top, including the downwind lean
attribute vec4 aShape;  // x: base radius, y: top radius, z: strength, w: seed

varying vec3  vWorld;
varying float vU;
varying float vV;
varying float vDist;
varying float vStr;
varying float vSeed;
varying float vAxial;

void main() {
  float u = position.x;
  float v = position.y;

  vec3 foot = (modelMatrix * vec4(aBase, 1.0)).xyz;
  vec3 center = foot + aAxis * u;

  vec3 toEye = uEye - center;
  float dist = length(toEye);
  vec3 eyeDir = toEye / max(dist, 1e-4);

  vec3 adir = normalize(aAxis);
  vec3 side = cross(adir, eyeDir);
  float sl = length(side);
  side = sl > 1e-3 ? side / sl : vec3(1.0, 0.0, 0.0);

  // Opens out with height, and necks down hard at the very bottom onto the
  // patch of ground that is feeding it.
  float flare = mix(aShape.x, aShape.y, u * u);
  float neck = 0.42 + 0.58 * smoothstep(0.0, 0.07, u);

  vec3 world = center + side * (v * flare * neck);

  vWorld = world;
  vU = u;
  vV = v;
  vDist = dist;
  vStr = aShape.z;
  vSeed = aShape.w;
  // sin of the angle between the eye and the column's axis: zero when you are
  // looking straight down the shaft.
  vAxial = sl;

  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const COLUMN_FRAG = /* glsl */ `
${ATMOSPHERE_PRELUDE}

uniform vec2  uColFade;     // (start, end) metres of the outer fade
uniform float uColOpacity;
uniform float uElapsed;
uniform vec3  uColColor;
uniform int   uColOct;

varying vec3  vWorld;
varying float vU;
varying float vV;
varying float vDist;
varying float vStr;
varying float vSeed;
varying float vAxial;

void main() {
  // Soft round cross-section, reaching exactly zero at the edge of the quad.
  const float CORE = 2.2;
  const float CORE_EDGE = 0.110803;          // exp(-CORE)
  float across = max(0.0, (exp(-CORE * vV * vV) - CORE_EDGE) / (1.0 - CORE_EDGE));

  // Lifts off the ground and dissolves long before the top, the way a real
  // column loses its identity as it approaches cloudbase.
  float along = smoothstep(0.0, 0.10, vU) * (1.0 - smoothstep(0.45, 1.0, vU));
  float a = uColOpacity * vStr * across * along;
  if (a < 0.0004) discard;

  // Rising texture: the sample point sinks through the noise field, so the
  // pattern climbs. RISE is the speed it climbs at — match it to a thermal and
  // the column feels like it is actually carrying something.
  const float RISE = 6.0;          // m/s
  const float V_SCALE = 0.0033;    // ~300 m noise features vertically
  const float H_SCALE = 0.0083;    // ~120 m across
  float n = afbm3(vec3(
    vWorld.x * H_SCALE,
    vWorld.y * V_SCALE - uElapsed * RISE * V_SCALE,
    vWorld.z * H_SCALE), uColOct);
  float tex = clamp(0.55 + 1.05 * (n - 0.4375), 0.12, 1.6);

  // The first couple of hundred metres over a hot patch boil. This is the tell
  // that says *here*, from further away than the column itself is legible.
  float bottom = exp(-vU * 7.0);
  float shimmer = 1.0 + bottom * (0.85 + 0.55 * sin(uElapsed * 2.3 + vSeed * 6.2832 + vWorld.y * 0.05));

  a *= tex * (1.0 + bottom * 0.5);

  // Looking straight down a column shows you almost none of it — which is
  // true, and also the moment you are inside it and reading the ribbons.
  a *= mix(0.22, 1.0, smoothstep(0.05, 0.34, vAxial));

  // Reads as a suggestion far off and as an obvious elevator close in.
  a *= mix(1.0, 1.9, 1.0 - smoothstep(200.0, 1800.0, vDist));
  a *= 1.0 - smoothstep(uColFade.x, uColFade.y, vDist);
  // ...and gets out of the way entirely when you fly through it.
  a *= smoothstep(12.0, 90.0, vDist);
  if (a < 0.0015) discard;

  vec3 viewDir = normalize(vWorld - uCameraPos);
  vec3 col = uColColor * shimmer;

  const float BACKLIT_GAIN = 1.8;
  float backlit = pow(max(dot(viewDir, uSunDir), 0.0), 6.0) * uSunIntensity;
  col *= 1.0 + BACKLIT_GAIN * backlit;

  col = aerialPerspective(col, vWorld, viewDir, vDist);
  col += ditherValue(gl_FragCoord.xy);

  gl_FragColor = vec4(col, a);
}
`;

/**
 * The volumetric marker for lift worth crossing to: one soft luminous shaft
 * per strong thermal, leaning downwind exactly as the sim's own column does,
 * with texture scrolling upward inside it and the ground under it boiling.
 */
export class AirColumns {
  private readonly scene: THREE.Scene;
  private readonly cfg: Config;
  private readonly wind: WindField;
  private readonly group: THREE.Group;
  private readonly geo: THREE.InstancedBufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;

  private readonly u = {
    uEye: { value: new THREE.Vector3() },
    uColFade: { value: new THREE.Vector2(1, 2) },
    uColOpacity: { value: COLUMN_OPACITY },
    uElapsed: { value: 0 },
    uColColor: { value: new THREE.Color(1, 1, 1) },
    uColOct: { value: 3 },
  };

  private readonly aBaseArr = new Float32Array(COLUMN_CAP * 3);
  private readonly aAxisArr = new Float32Array(COLUMN_CAP * 3);
  private readonly aShapeArr = new Float32Array(COLUMN_CAP * 4);
  private readonly aBase: THREE.InstancedBufferAttribute;
  private readonly aAxis: THREE.InstancedBufferAttribute;
  private readonly aShape: THREE.InstancedBufferAttribute;

  private readonly scores = new Float32Array(COLUMN_CAP);
  private readonly picks = new Int32Array(COLUMN_CAP);

  private maxColumns: number;
  private viewDistance: number;
  private elapsed = 0;

  constructor(
    scene: THREE.Scene,
    cfg: Config,
    wind: WindField,
    atmo: AtmosphereUniforms,
    quality: QualitySettings,
  ) {
    this.scene = scene;
    this.cfg = cfg;
    this.wind = wind;

    // Columns are cheap in triangles and expensive in fill, so quality buys
    // count and noise detail rather than geometry.
    this.maxColumns = COLUMN_CAP;
    this.viewDistance = cfg.thermalHorizon * 0.85;

    const strip = buildStripAttributes(COLUMN_SEGMENTS);
    this.aBase = new THREE.InstancedBufferAttribute(this.aBaseArr, 3);
    this.aAxis = new THREE.InstancedBufferAttribute(this.aAxisArr, 3);
    this.aShape = new THREE.InstancedBufferAttribute(this.aShapeArr, 4);
    this.aBase.setUsage(THREE.DynamicDrawUsage);
    this.aAxis.setUsage(THREE.DynamicDrawUsage);
    this.aShape.setUsage(THREE.DynamicDrawUsage);

    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setAttribute('position', strip.position);
    this.geo.setIndex(strip.index);
    this.geo.setAttribute('aBase', this.aBase);
    this.geo.setAttribute('aAxis', this.aAxis);
    this.geo.setAttribute('aShape', this.aShape);
    this.geo.instanceCount = 0;

    this.mat = new THREE.ShaderMaterial({
      uniforms: withAtmosphere(atmo, this.u) as unknown as UniformMap,
      vertexShader: COLUMN_VERT,
      fragmentShader: COLUMN_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });

    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.frustumCulled = false;
    // Under the ribbons: the column is the background hint, the sparks are the
    // foreground detail.
    this.mesh.renderOrder = 7;

    this.group = new THREE.Group();
    this.group.add(this.mesh);
    scene.add(this.group);

    this.setQuality(quality);
  }

  update(dt: number, bird: BirdState, sky: SkyState, cameraPos: THREE.Vector3): void {
    this.elapsed += dt < 0.1 ? dt : 0.1;
    this.u.uElapsed.value = this.elapsed;
    this.u.uEye.value.copy(cameraPos);
    this.group.position.copy(cameraPos);

    const camX = cameraPos.x;
    const camY = cameraPos.y;
    const camZ = cameraPos.z;
    const list = this.wind.thermals();
    const minStrength = this.cfg.thermalStrength * COLUMN_MIN_STRENGTH;
    const K = this.maxColumns;
    const far = this.viewDistance;

    // Keep the best K by a score that mixes how strong the thermal is with how
    // close it is, so the marker budget is spent on the ones you might use.
    let n = 0;
    for (let t = 0; t < list.length && K > 0; t++) {
      const th = list[t];
      if (th.life < COLUMN_MIN_LIFE || th.strength < minStrength) continue;
      const dx = th.x - camX;
      const dz = th.z - camZ;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > far) continue;
      const score = th.life * th.strength * (1 - d / far);

      if (n < K) {
        let j = n++;
        while (j > 0 && this.scores[j - 1] < score) {
          this.scores[j] = this.scores[j - 1];
          this.picks[j] = this.picks[j - 1];
          j--;
        }
        this.scores[j] = score;
        this.picks[j] = t;
      } else if (score > this.scores[K - 1]) {
        let j = K - 1;
        while (j > 0 && this.scores[j - 1] < score) {
          this.scores[j] = this.scores[j - 1];
          this.picks[j] = this.picks[j - 1];
          j--;
        }
        this.scores[j] = score;
        this.picks[j] = t;
      }
    }

    const peak = this.cfg.thermalStrength * 1.35;
    for (let j = 0; j < n; j++) {
      const th = list[this.picks[j]];
      // The sim leans its column downwind by tiltX/tiltZ per metre of height,
      // and the marker has to lean the same way or it points at nothing.
      const h = Math.max(th.top - th.base, 1);
      const j3 = j * 3;
      const j4 = j * 4;
      this.aBaseArr[j3] = th.x - camX;
      this.aBaseArr[j3 + 1] = th.base - camY;
      this.aBaseArr[j3 + 2] = th.z - camZ;
      this.aAxisArr[j3] = th.tiltX * h;
      this.aAxisArr[j3 + 1] = h;
      this.aAxisArr[j3 + 2] = th.tiltZ * h;
      this.aShapeArr[j4] = th.radius * COLUMN_BASE_FLARE;
      this.aShapeArr[j4 + 1] = th.radius * COLUMN_TOP_FLARE;
      this.aShapeArr[j4 + 2] = clamp01(th.strength / peak) * clamp01(th.life);
      this.aShapeArr[j4 + 3] = th.jitter;
    }

    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
    if (n > 0) {
      this.aBase.needsUpdate = true;
      this.aAxis.needsUpdate = true;
      this.aShape.needsUpdate = true;
    }

    // Columns exist because the sun made them, so they fade with the day's
    // convective energy and are gone entirely by dusk.
    const day = clamp01(sky.thermalActivity);
    // Standing inside the elevator, the walls get out of the way — you are
    // already reading the sparks, and a gold veil over the horizon would just
    // hide where you are going next.
    const inside = bird.airKind === AirKind.Thermal ? clamp01(bird.airIntensity) : 0;
    this.u.uColOpacity.value = COLUMN_OPACITY * (0.25 + 0.75 * day) * (1 - 0.45 * inside);

    // Takes the sun's warmth so it belongs to the hour it is in; the constant
    // term keeps it gold rather than grey when the sun is low.
    const gold = airKindColor(AirKind.Thermal);
    const g = (0.55 + 0.85 * clamp01(sky.sunIntensity)) * LIFT_COLOR_GAIN;
    this.u.uColColor.value.setRGB(gold.r * g, gold.g * g, gold.b * g);
    this.u.uColFade.value.set(far * 0.7, far);
  }

  setQuality(q: QualitySettings): void {
    const tier = q.tier;
    this.maxColumns =
      tier === 'low' ? 4 : tier === 'medium' ? 7 : tier === 'high' ? 11 : COLUMN_CAP;
    // Octaves of the rising noise. This is pure fragment cost on quads that can
    // fill the screen, so it is the first thing to go on a weak GPU.
    this.u.uColOct.value = tier === 'low' ? 1 : tier === 'medium' ? 2 : 3;
    // Weaker machines also draw the markers closer in, which cuts fill again.
    this.viewDistance = this.cfg.thermalHorizon * (tier === 'low' ? 0.5 : tier === 'medium' ? 0.7 : 0.85);
  }

  dispose(): void {
    this.scene.remove(this.group);
    this.group.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
  }
}
