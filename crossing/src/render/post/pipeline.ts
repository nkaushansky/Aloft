/**
 * THE GRADE.
 *
 * Everything the scene renders is linear HDR — the sun disc, the specular
 * glitter on water, the golden-hour rim on a wing all come out of the world
 * shaders well above 1.0 on purpose. This file is what turns those numbers
 * into a photograph: it finds the over-bright parts and lets them bleed, it
 * catches the slant of low light in the air, it smears the world past you
 * when you tuck, and only then does it tonemap, grade and dither down to
 * eight bits.
 *
 * The whole chain is hand-rolled — no three/examples imports. Six small
 * fragment programs, one fullscreen triangle, a handful of render targets
 * that all live and die together. Keeping it in one file means the passes
 * can share buffers (the bloom prefilter IS the god-ray mask), and it means
 * the pipeline never drifts out of sync with a Three.js example that got
 * rewritten between point releases.
 *
 * Order, and why:
 *   scene -> HDR    the only place with depth; everything after is 2D
 *   bloom           threshold, 5 mips down, tent back up. wide and soft.
 *   god rays        radial blur of the same bright buffer, from the sun
 *   speed           radial blur + chromatic aberration, driven by the tuck
 *   composite       exposure, ACES, film grade, vignette, grain, fade, dither
 *   FXAA            last, on the finished 8-bit image, where edges are real
 *
 * If a machine can afford none of the middle three, the chain collapses to
 * composite + FXAA and costs two fullscreen passes total.
 */

import * as THREE from 'three';
import type { QualitySettings } from '../../sim/types';
import { clamp01 } from '../../sim/math';

// ===================================================================== FEEL

/**
 * Where the bloom starts to notice a pixel. The sky sits around 0.3–1.2 in
 * linear HDR, so a threshold just above 1 means ordinary daylight does not
 * glow — only the sun, the water glitter and sunlit cloud edges do. Raised from 1.04:
 * sunlit ground was landing right on the old threshold, so every hillside
 * bloomed and the whole frame read as fogged.
 */
const BLOOM_THRESHOLD = 1.38;
/** Softness of the knee under the threshold. High = the glow arrives gradually. */
const BLOOM_KNEE = 0.65;
/** Firefly clamp. Without it one 400.0 pixel on the water strobes across mips. */
const BLOOM_CLAMP = 26.0;
/** How much of the accumulated glow reaches the composite. */
const BLOOM_STRENGTH = 0.44;
/**
 * Tent radius in source texels on the way back up. Above ~1 the upsample
 * overshoots each mip and the glow goes from a halo to a haze — which is
 * exactly the expensive-looking result we want.
 */
const BLOOM_RADIUS = 1.3;
/** Half res, then four more halvings. Deepest mip is 1/32 — that is the width. */
const MAX_BLOOM_MIPS = 5;

/** Steps along the ray toward the sun. 24 at half res is smooth and cheap. */
const GODRAY_SAMPLES = 24;
/** Fraction of the distance to the sun the ray marches. Long, lazy shafts. */
const GODRAY_DENSITY = 0.85;
/** Per-step falloff. Closer to 1 = shafts that reach further across the frame. */
const GODRAY_DECAY = 0.958;
/** Per-step gain, before decay. */
const GODRAY_WEIGHT = 0.06;
/** Master gain on the shafts. */
const GODRAY_STRENGTH = 1.05;

/** Taps in the speed blur. Ten is enough because the reach is short. */
const SPEED_SAMPLES = 10;
/**
 * How far, as a fraction of the radius from screen centre, the world smears
 * at a full tuck. Small numbers read as speed; large numbers read as nausea.
 */
const SPEED_BLUR_MAX = 0.06;
/** Radial channel separation at full tuck, and the extra from rough air. */
const CA_FROM_SPEED = 0.0075;
const CA_FROM_TURBULENCE = 0.0045;

/** Film grain amplitude in the final 8-bit image. Fine, never crunchy. */
const GRAIN_AMOUNT = 0.03;

// ============================================================== FULLSCREEN

/** GLSL needs "1.0", not "1". Feel constants above are plain JS numbers. */
function glf(n: number): string {
  return Number.isInteger(n) ? n.toFixed(1) : String(n);
}

/**
 * One triangle, not two — the diagonal seam of a quad costs a second batch of
 * helper lanes right down the middle of the screen. Clip space is written
 * directly, so the ortho camera below exists only because render() wants one.
 */
const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

// ============================================================ BLOOM SHADERS

const PREFILTER_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
varying vec2 vUv;

const float THRESHOLD = ${glf(BLOOM_THRESHOLD)};
const float KNEE = ${glf(BLOOM_KNEE)};
const float CLAMP_HI = ${glf(BLOOM_CLAMP)};

void main(){
  // Four taps at the SOURCE resolution: this pass is also the first halving,
  // and averaging before thresholding is what keeps a single hot pixel from
  // popping in and out of the glow as the camera drifts.
  vec3 c = texture2D(tDiffuse, vUv + vec2(-1.0, -1.0) * uTexel).rgb
         + texture2D(tDiffuse, vUv + vec2( 1.0, -1.0) * uTexel).rgb
         + texture2D(tDiffuse, vUv + vec2(-1.0,  1.0) * uTexel).rgb
         + texture2D(tDiffuse, vUv + vec2( 1.0,  1.0) * uTexel).rgb;
  c = min(c * 0.25, vec3(CLAMP_HI));

  // Soft knee: below the threshold nothing passes, just above it the response
  // is quadratic rather than a step, so a cloud edge brightening through the
  // threshold swells instead of switching on.
  float br = max(c.r, max(c.g, c.b));
  float knee = THRESHOLD * KNEE + 1e-5;
  float soft = clamp(br - THRESHOLD + knee, 0.0, 2.0 * knee);
  soft = soft * soft / (4.0 * knee);
  float contrib = max(soft, br - THRESHOLD) / max(br, 1e-5);

  gl_FragColor = vec4(c * contrib, 1.0);
}
`;

/**
 * The 13-tap downsample from the Call of Duty presentation: a centre box plus
 * a wider ring, weighted so the filter has no zeros in its frequency response.
 * A naive 2x2 box aliases badly by the third mip and the glow crawls.
 */
const DOWNSAMPLE_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
varying vec2 vUv;

vec3 tap(vec2 o){ return texture2D(tDiffuse, vUv + o * uTexel).rgb; }

void main(){
  vec3 a = tap(vec2(-2.0,  2.0)), b = tap(vec2(0.0,  2.0)), c = tap(vec2(2.0,  2.0));
  vec3 d = tap(vec2(-2.0,  0.0)), e = tap(vec2(0.0,  0.0)), f = tap(vec2(2.0,  0.0));
  vec3 g = tap(vec2(-2.0, -2.0)), h = tap(vec2(0.0, -2.0)), i = tap(vec2(2.0, -2.0));
  vec3 j = tap(vec2(-1.0,  1.0)), k = tap(vec2(1.0,  1.0));
  vec3 l = tap(vec2(-1.0, -1.0)), m = tap(vec2(1.0, -1.0));

  vec3 col = e * 0.125;
  col += (a + c + g + i) * 0.03125;
  col += (b + d + f + h) * 0.0625;
  col += (j + k + l + m) * 0.125;

  gl_FragColor = vec4(col, 1.0);
}
`;

/** 3x3 tent on the way back up, blended additively into the larger mip. */
const UPSAMPLE_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
uniform float uRadius;
varying vec2 vUv;

vec3 tap(vec2 o){ return texture2D(tDiffuse, vUv + o * uTexel * uRadius).rgb; }

void main(){
  vec3 col = tap(vec2(-1.0,  1.0)) + tap(vec2(0.0,  1.0)) * 2.0 + tap(vec2(1.0,  1.0))
           + tap(vec2(-1.0,  0.0)) * 2.0 + tap(vec2(0.0, 0.0)) * 4.0 + tap(vec2(1.0, 0.0)) * 2.0
           + tap(vec2(-1.0, -1.0)) + tap(vec2(0.0, -1.0)) * 2.0 + tap(vec2(1.0, -1.0));
  gl_FragColor = vec4(col * 0.0625, 1.0);
}
`;

// ========================================================== GOD RAY SHADER

const GODRAY_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uSunPos;
uniform float uSunVisible;
uniform float uDayT;
uniform float uStrength;
varying vec2 vUv;

const float DENSITY = ${glf(GODRAY_DENSITY)};
const float DECAY = ${glf(GODRAY_DECAY)};
const float WEIGHT = ${glf(GODRAY_WEIGHT)};

void main(){
  // Same arc SkyModel.solar() uses, so the rays agree with the sky about
  // where the sun actually is without needing another uniform pushed in.
  float elev = sin((uDayT - 0.045) / 0.81 * 3.14159265) * 1.09;

  // Crepuscular rays are a low-sun phenomenon. At noon the light comes down
  // a short column of thin air and there is nothing to catch; drawing shafts
  // anyway reads as a dirty lens filter rather than as weather.
  float lowSun = 1.0 - smoothstep(0.12, 0.55, elev);

  // Off-screen sun: fade rather than pop, because the ray direction inverts
  // the instant the sun crosses behind the camera.
  vec2 outside = max(vec2(0.0), abs(uSunPos - 0.5) - 0.5);
  float onScreen = 1.0 - smoothstep(0.0, 0.45, length(outside));

  float gain = uSunVisible * lowSun * onScreen * uStrength;
  if (gain < 0.002) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  vec2 delta = (vUv - uSunPos) * (DENSITY / float(${GODRAY_SAMPLES}));
  vec2 uv = vUv;
  float decay = 1.0;
  vec3 acc = vec3(0.0);
  for (int i = 0; i < ${GODRAY_SAMPLES}; i++){
    uv -= delta;
    // Clamp-to-edge would otherwise smear the border pixel into a fake shaft
    // whenever the march walks off the frame.
    float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    acc += texture2D(tDiffuse, uv).rgb * decay * WEIGHT * inside;
    decay *= DECAY;
  }

  // Dawn runs pinker, the low evening sun runs orange; both warm up as they
  // sink, because the shafts are the reddened light itself.
  vec3 tint = mix(vec3(1.0, 0.58, 0.36), vec3(1.0, 0.80, 0.56), smoothstep(0.0, 0.45, elev));
  gl_FragColor = vec4(acc * tint * gain, 1.0);
}
`;

// ============================================================ SPEED SHADER

const SPEED_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uBlur;
uniform float uCA;
varying vec2 vUv;

void main(){
  vec2 d = vUv - 0.5;

  // Uniform branch — the whole draw takes the same side, so this genuinely
  // costs nothing at cruise, which is where the bird spends most of its day.
  if (uBlur + uCA < 0.0005) { gl_FragColor = texture2D(tDiffuse, vUv); return; }

  // Both effects vanish at the centre of the frame and build toward the
  // corners. That is the difference between "fast" and "broken optics": the
  // thing you are looking at stays sharp while the world tears past it.
  float r2 = clamp(dot(d, d) * 4.0, 0.0, 1.0);
  float ca = uCA * r2;

  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < ${SPEED_SAMPLES}; i++){
    float t = float(i) / float(${SPEED_SAMPLES - 1});
    // Samples march inward: the streaks trail toward the vanishing point.
    float s = 1.0 - uBlur * t;
    float w = 1.0 - t * 0.62;
    acc.r += texture2D(tDiffuse, 0.5 + d * (s * (1.0 + ca))).r * w;
    acc.g += texture2D(tDiffuse, 0.5 + d * s).g * w;
    acc.b += texture2D(tDiffuse, 0.5 + d * (s * (1.0 - ca))).b * w;
    wsum += w;
  }

  gl_FragColor = vec4(acc / wsum, 1.0);
}
`;

// ======================================================== COMPOSITE SHADER

const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D tScene;
#ifdef USE_BLOOM
uniform sampler2D tBloom;
uniform float uBloom;
#endif
#ifdef USE_GODRAYS
uniform sampler2D tGodray;
#endif
uniform float uExposure;
uniform float uVignette;
uniform float uFade;
uniform float uGrain;
uniform float uTime;
uniform float uDayT;
uniform vec2 uResolution;
varying vec2 vUv;

/**
 * Byte-for-byte the acesFilm() in shaders/atmosphere.ts. It is duplicated
 * rather than imported because pulling in ATMOSPHERE_GLSL would drag the
 * whole shared uniform block into a pass that has no world to shade — but if
 * one of the two ever changes, both must.
 */
vec3 acesFilm(vec3 x){
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

vec3 linearToSRGB(vec3 c){
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

float grainHash(vec2 p){
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}

/** 4x4 ordered Bayer, built arithmetically. Cheaper than a lookup texture. */
float bayer2(vec2 a){ a = floor(a); return fract(a.x / 2.0 + a.y * a.y * 0.75); }
float bayer4(vec2 a){ return bayer2(0.5 * a) * 0.25 + bayer2(a); }

/** How much the S-curve bends the luma. Gentle — the sky has to stay smooth. */
const float CONTRAST = 0.22;
/** Overall gain, paid back after the grade tints (which only ever darken). */
const float GRADE_GAIN = 1.035;

void main(){
  vec3 col = texture2D(tScene, vUv).rgb;
#ifdef USE_BLOOM
  col += texture2D(tBloom, vUv).rgb * uBloom;
#endif
#ifdef USE_GODRAYS
  col += texture2D(tGodray, vUv).rgb;
#endif

  col = acesFilm(col * uExposure);

  // ------------------------------------------------------------- grade
  // Split-tone: shadows sit in the sky's own blue (which is where the fill
  // light is actually coming from up here), highlights carry the sun's
  // colour, and at low sun that colour is amber. Every tint is <= 1.0 so the
  // grade can never push a channel back over white and clip what ACES just
  // finished rolling off; GRADE_GAIN gives the exposure back afterwards.
  float elev = sin((uDayT - 0.045) / 0.81 * 3.14159265) * 1.09;
  float golden = 1.0 - smoothstep(0.05, 0.45, elev);

  float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
  vec3 shadowTint = vec3(0.88, 0.945, 1.0);
  vec3 highTint = mix(vec3(1.0, 0.99, 0.965), vec3(1.0, 0.935, 0.845), golden);
  col *= mix(shadowTint, highTint, smoothstep(0.0, 0.85, l)) * GRADE_GAIN;

  // S-curve applied as a ratio on luma, so contrast never shifts hue.
  float s = l * l * (3.0 - 2.0 * l);
  col *= mix(l, s, CONTRAST) / max(l, 1e-4);

  // ---------------------------------------------------------- vignette
  vec2 vd = (vUv - 0.5) * vec2(uResolution.x / max(uResolution.y, 1.0), 1.0);
  col *= 1.0 - uVignette * smoothstep(0.30, 0.95, length(vd) * 1.35);

  col *= 1.0 - uFade;

  // Everything below is deliberately in display space: grain and dither are
  // perceptual effects and applying them in linear makes the shadows crawl.
  col = linearToSRGB(col);

  // Grain lives in the mids. Bright sky has almost none (real film runs out
  // of unexposed silver up there), and pure black gets a little, which is
  // what stops the fade-to-black from banding.
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  float g = grainHash(gl_FragCoord.xy + fract(uTime) * 311.7) - 0.5;
  col += g * uGrain * (1.0 - smoothstep(0.28, 1.0, lum));

  col += (bayer4(gl_FragCoord.xy) - 0.5) / 255.0;

  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

// ============================================================= FXAA SHADER

/**
 * FXAA 3.11's console variant. Offsets are in texture space and follow the
 * original's NW/NE/SW/SE convention exactly, which is what makes dir come out
 * perpendicular to the luma gradient regardless of which way v points.
 *
 * The buffer it reads is already sRGB-encoded, which is correct and not an
 * accident: FXAA's luma test is a perceptual one, and running it on linear
 * values makes it blind to edges in the shadows.
 */
const FXAA_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform vec2 uTexel;
varying vec2 vUv;

const float SPAN_MAX = 8.0;
const float REDUCE_MUL = 0.125;
const float REDUCE_MIN = 0.0078125;
const vec3 LUMA = vec3(0.299, 0.587, 0.114);

void main(){
  vec3 rgbNW = texture2D(tDiffuse, vUv + vec2(-1.0, -1.0) * uTexel).rgb;
  vec3 rgbNE = texture2D(tDiffuse, vUv + vec2( 1.0, -1.0) * uTexel).rgb;
  vec3 rgbSW = texture2D(tDiffuse, vUv + vec2(-1.0,  1.0) * uTexel).rgb;
  vec3 rgbSE = texture2D(tDiffuse, vUv + vec2( 1.0,  1.0) * uTexel).rgb;
  vec3 rgbM  = texture2D(tDiffuse, vUv).rgb;

  float lNW = dot(rgbNW, LUMA);
  float lNE = dot(rgbNE, LUMA);
  float lSW = dot(rgbSW, LUMA);
  float lSE = dot(rgbSE, LUMA);
  float lM  = dot(rgbM,  LUMA);

  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

  vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), ((lNW + lSW) - (lNE + lSE)));

  float reduce = max((lNW + lNE + lSW + lSE) * 0.25 * REDUCE_MUL, REDUCE_MIN);
  float rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcpMin, vec2(-SPAN_MAX), vec2(SPAN_MAX)) * uTexel;

  vec3 rgbA = 0.5 * (texture2D(tDiffuse, vUv + dir * (1.0 / 3.0 - 0.5)).rgb
                   + texture2D(tDiffuse, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
  vec3 rgbB = rgbA * 0.5 + 0.25 * (texture2D(tDiffuse, vUv - dir * 0.5).rgb
                                 + texture2D(tDiffuse, vUv + dir * 0.5).rgb);

  float lB = dot(rgbB, LUMA);
  // The four-tap blend overshooting the local range means it crossed a second
  // edge; fall back to the safe two-tap rather than smear detail away.
  gl_FragColor = vec4((lB < lMin || lB > lMax) ? rgbA : rgbB, 1.0);
}
`;

// ================================================================ PIPELINE

function fullscreenMaterial(
  fragmentShader: string,
  uniforms: Record<string, THREE.IUniform>,
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: FULLSCREEN_VERT,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    // Passes always cover every pixel they are pointed at, so there is nothing
    // to blend against and nothing behind them to respect.
    blending: THREE.NoBlending,
  });
}

export class PostPipeline {
  private quality: QualitySettings;

  // --- fullscreen plumbing ------------------------------------------------
  private readonly quadGeom: THREE.BufferGeometry;
  private readonly quadMesh: THREE.Mesh;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  // --- materials (built once; only their defines ever change) -------------
  private readonly prefilterMat: THREE.ShaderMaterial;
  private readonly downMat: THREE.ShaderMaterial;
  private readonly upMat: THREE.ShaderMaterial;
  private readonly godrayMat: THREE.ShaderMaterial;
  private readonly speedMat: THREE.ShaderMaterial;
  private readonly compositeMat: THREE.ShaderMaterial;
  private readonly fxaaMat: THREE.ShaderMaterial;

  // --- targets ------------------------------------------------------------
  private hdr: THREE.WebGLRenderTarget | null = null;
  private speedRT: THREE.WebGLRenderTarget | null = null;
  private godrayRT: THREE.WebGLRenderTarget | null = null;
  private ldr: THREE.WebGLRenderTarget | null = null;
  /** [0] is the half-res bright buffer; the rest are the blur chain. */
  private mips: THREE.WebGLRenderTarget[] = [];

  private bufW = 1;
  private bufH = 1;
  private targetsDirty = true;
  private time = 0;

  /** Scratch so setState never allocates. */
  private readonly sunPos = new THREE.Vector2(0.5, 0.5);

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    quality: QualitySettings,
  ) {
    this.quality = quality;

    this.quadGeom = new THREE.BufferGeometry();
    this.quadGeom.setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
    );
    this.quadGeom.setAttribute(
      'uv',
      new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2),
    );

    this.prefilterMat = fullscreenMaterial(PREFILTER_FRAG, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });
    this.downMat = fullscreenMaterial(DOWNSAMPLE_FRAG, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });
    this.upMat = fullscreenMaterial(UPSAMPLE_FRAG, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
      uRadius: { value: BLOOM_RADIUS },
    });
    // The only pass that blends: each mip is added on top of the one below it.
    this.upMat.blending = THREE.CustomBlending;
    this.upMat.blendEquation = THREE.AddEquation;
    this.upMat.blendSrc = THREE.OneFactor;
    this.upMat.blendDst = THREE.OneFactor;

    this.godrayMat = fullscreenMaterial(GODRAY_FRAG, {
      tDiffuse: { value: null },
      uSunPos: { value: new THREE.Vector2(0.5, 0.5) },
      uSunVisible: { value: 0 },
      uDayT: { value: 0 },
      uStrength: { value: GODRAY_STRENGTH },
    });
    this.speedMat = fullscreenMaterial(SPEED_FRAG, {
      tDiffuse: { value: null },
      uBlur: { value: 0 },
      uCA: { value: 0 },
    });
    this.compositeMat = fullscreenMaterial(COMPOSITE_FRAG, {
      tScene: { value: null },
      tBloom: { value: null },
      tGodray: { value: null },
      uBloom: { value: BLOOM_STRENGTH },
      uExposure: { value: 1 },
      uVignette: { value: 0.28 },
      uFade: { value: 0 },
      uGrain: { value: GRAIN_AMOUNT },
      uTime: { value: 0 },
      uDayT: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
    });
    this.fxaaMat = fullscreenMaterial(FXAA_FRAG, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2() },
    });

    this.quadMesh = new THREE.Mesh(this.quadGeom, this.compositeMat);
    this.quadMesh.frustumCulled = false;
    this.quadScene.add(this.quadMesh);

    this.applyDefines();
  }

  // ================================================================= SIZING

  setSize(w: number, h: number, pixelRatio: number): void {
    const bw = Math.max(1, Math.round(w * pixelRatio));
    const bh = Math.max(1, Math.round(h * pixelRatio));
    if (bw === this.bufW && bh === this.bufH && !this.targetsDirty) return;
    this.bufW = bw;
    this.bufH = bh;
    this.allocTargets();
  }

  setQuality(q: QualitySettings): void {
    const flagsChanged =
      q.bloom !== this.quality.bloom ||
      q.godrays !== this.quality.godrays ||
      q.motionBlur !== this.quality.motionBlur;
    this.quality = q;
    if (!flagsChanged) return;
    this.applyDefines();
    // Renderer calls setSize() straight after setQuality(); the dirty flag is
    // what stops that call from early-outing on an unchanged resolution.
    this.targetsDirty = true;
  }

  /**
   * The composite samples the bloom and god-ray buffers through #ifdefs rather
   * than multiplying by a zero uniform, so a machine with the effects off does
   * not pay for two texture fetches on every pixel of every frame.
   */
  private applyDefines(): void {
    const d: Record<string, boolean> = {};
    if (this.quality.bloom) d.USE_BLOOM = true;
    if (this.quality.godrays) d.USE_GODRAYS = true;
    this.compositeMat.defines = d;
    this.compositeMat.needsUpdate = true;
  }

  private makeRT(w: number, h: number, half: boolean, depth: boolean): THREE.WebGLRenderTarget {
    const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      type: half ? THREE.HalfFloatType : THREE.UnsignedByteType,
      depthBuffer: depth,
      stencilBuffer: false,
      generateMipmaps: false,
    });
    // Every buffer here holds values this file wrote and this file will read
    // back verbatim — no hardware sRGB decode is wanted anywhere in the chain.
    rt.texture.colorSpace = THREE.NoColorSpace;
    rt.texture.wrapS = THREE.ClampToEdgeWrapping;
    rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    return rt;
  }

  private allocTargets(): void {
    this.freeTargets();

    const q = this.quality;
    const wantBright = q.bloom || q.godrays;

    // Depth lives only here: this is the one pass with actual geometry in it.
    this.hdr = this.makeRT(this.bufW, this.bufH, true, true);
    this.ldr = this.makeRT(this.bufW, this.bufH, false, false);

    if (q.motionBlur) this.speedRT = this.makeRT(this.bufW, this.bufH, true, false);

    if (wantBright) {
      // Halve until a mip stops being worth filtering. mips[0] is both the
      // bloom chain's head and the god-ray mask — one prefilter, two uses.
      const levels = q.bloom ? MAX_BLOOM_MIPS : 1;
      let w = this.bufW;
      let h = this.bufH;
      for (let i = 0; i < levels; i++) {
        w = Math.max(1, w >> 1);
        h = Math.max(1, h >> 1);
        if (i > 0 && (w < 8 || h < 8)) break;
        this.mips.push(this.makeRT(w, h, true, false));
      }
      if (q.godrays) {
        const m0 = this.mips[0];
        this.godrayRT = this.makeRT(m0.width, m0.height, true, false);
      }
    }

    (this.compositeMat.uniforms.uResolution.value as THREE.Vector2).set(this.bufW, this.bufH);
    (this.fxaaMat.uniforms.uTexel.value as THREE.Vector2).set(1 / this.bufW, 1 / this.bufH);
    this.targetsDirty = false;
  }

  private freeTargets(): void {
    this.hdr?.dispose();
    this.speedRT?.dispose();
    this.godrayRT?.dispose();
    this.ldr?.dispose();
    for (const m of this.mips) m.dispose();
    this.hdr = null;
    this.speedRT = null;
    this.godrayRT = null;
    this.ldr = null;
    this.mips.length = 0;
  }

  // ================================================================== STATE

  setState(opts: {
    exposure: number;
    speed01: number;
    turbulence: number;
    sunScreenPos: THREE.Vector2;
    sunVisible: number;
    vignette: number;
    fade: number;
    dayT: number;
  }): void {
    const cu = this.compositeMat.uniforms;
    cu.uExposure.value = Math.max(0, opts.exposure);
    cu.uVignette.value = clamp01(opts.vignette);
    cu.uFade.value = clamp01(opts.fade);
    cu.uDayT.value = opts.dayT;

    this.sunPos.copy(opts.sunScreenPos);
    const gu = this.godrayMat.uniforms;
    (gu.uSunPos.value as THREE.Vector2).copy(this.sunPos);
    gu.uSunVisible.value = clamp01(opts.sunVisible);
    gu.uDayT.value = opts.dayT;

    // Squared so cruise stays optically clean and the last quarter of the
    // tuck is where the frame really starts to tear past. Chromatic
    // aberration is the part the eye reads as speed, so rough air borrows it
    // too — a rotor should feel like the lens itself is being shaken.
    const sp = clamp01(opts.speed01);
    const su = this.speedMat.uniforms;
    su.uBlur.value = SPEED_BLUR_MAX * sp * sp;
    su.uCA.value = CA_FROM_SPEED * sp + CA_FROM_TURBULENCE * clamp01(opts.turbulence);
  }

  // ================================================================= RENDER

  private blit(mat: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null): void {
    this.quadMesh.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.quadCam);
  }

  render(dt: number): void {
    if (this.targetsDirty || !this.hdr || !this.ldr) this.allocTargets();
    const hdr = this.hdr;
    const ldr = this.ldr;
    if (!hdr || !ldr) return;

    this.time += dt;
    this.compositeMat.uniforms.uTime.value = this.time;

    const gl = this.renderer;
    const prevAutoClear = gl.autoClear;
    gl.autoClear = true;

    // --- 1. the world, in linear HDR -------------------------------------
    gl.setRenderTarget(hdr);
    gl.render(this.scene, this.camera);

    let sceneTex: THREE.Texture = hdr.texture;

    // --- 2a. bright pass: bloom's head and the god-ray mask ---------------
    if (this.mips.length > 0) {
      const m0 = this.mips[0];
      this.prefilterMat.uniforms.tDiffuse.value = hdr.texture;
      (this.prefilterMat.uniforms.uTexel.value as THREE.Vector2).set(1 / this.bufW, 1 / this.bufH);
      this.blit(this.prefilterMat, m0);

      // --- 3. god rays, before the bloom chain smears mips[0] ------------
      if (this.quality.godrays && this.godrayRT) {
        this.godrayMat.uniforms.tDiffuse.value = m0.texture;
        this.blit(this.godrayMat, this.godrayRT);
      }

      // --- 2b. down the chain, then additively back up -------------------
      if (this.quality.bloom && this.mips.length > 1) {
        for (let i = 1; i < this.mips.length; i++) {
          const src = this.mips[i - 1];
          this.downMat.uniforms.tDiffuse.value = src.texture;
          (this.downMat.uniforms.uTexel.value as THREE.Vector2).set(
            1 / src.width,
            1 / src.height,
          );
          this.blit(this.downMat, this.mips[i]);
        }

        // The upsample adds into a target that already holds its own mip, so
        // clearing it first would throw away everything the way down found.
        gl.autoClear = false;
        for (let i = this.mips.length - 1; i > 0; i--) {
          const src = this.mips[i];
          this.upMat.uniforms.tDiffuse.value = src.texture;
          (this.upMat.uniforms.uTexel.value as THREE.Vector2).set(1 / src.width, 1 / src.height);
          this.blit(this.upMat, this.mips[i - 1]);
        }
        gl.autoClear = true;
      }
    }

    // --- 4. speed: radial smear plus channel separation -------------------
    if (this.quality.motionBlur && this.speedRT) {
      this.speedMat.uniforms.tDiffuse.value = hdr.texture;
      this.blit(this.speedMat, this.speedRT);
      sceneTex = this.speedRT.texture;
    }

    // --- 5. composite and grade down to eight bits ------------------------
    const cu = this.compositeMat.uniforms;
    cu.tScene.value = sceneTex;
    cu.tBloom.value = this.quality.bloom && this.mips.length > 0 ? this.mips[0].texture : null;
    cu.tGodray.value = this.quality.godrays && this.godrayRT ? this.godrayRT.texture : null;
    this.blit(this.compositeMat, ldr);

    // --- 6. FXAA on the finished image, straight to the canvas ------------
    this.fxaaMat.uniforms.tDiffuse.value = ldr.texture;
    this.blit(this.fxaaMat, null);

    gl.autoClear = prevAutoClear;
    gl.setRenderTarget(null);
  }

  // ================================================================ TEARDOWN

  dispose(): void {
    this.freeTargets();
    this.quadGeom.dispose();
    this.prefilterMat.dispose();
    this.downMat.dispose();
    this.upMat.dispose();
    this.godrayMat.dispose();
    this.speedMat.dispose();
    this.compositeMat.dispose();
    this.fxaaMat.dispose();
    this.quadScene.remove(this.quadMesh);
  }
}
