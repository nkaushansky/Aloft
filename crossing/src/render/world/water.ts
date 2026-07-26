import * as THREE from 'three';
import type { Config } from '../../sim/config';
import type { QualitySettings, SkyState, TerrainProvider } from '../../sim/types';
import { clamp01, damp } from '../../sim/math';
import {
  ATMOSPHERE_PRELUDE,
  withAtmosphere,
  type AtmosphereUniforms,
} from '../shaders/atmosphere';

/**
 * WATER.
 *
 * One plane at the waterline, following the camera in XZ and snapped to a
 * coarse grid, shaded entirely per-pixel. It has to hold up from 3000 m, where
 * a lake is a mirror lying in a valley, and from 20 m, where it is a moving
 * surface with sparkle on it. Four ideas do all the work:
 *
 *  - **Fresnel.** At any angle flatter than about 30° water is overwhelmingly
 *    a mirror, and looking straight down it is barely reflective at all. Every
 *    expensive-looking water surface in every game is mostly this one curve.
 *    The mirror samples the shared `skyColor()`, so the lake and the sky can
 *    never disagree about what kind of day it is.
 *  - **Sun glitter.** An anisotropic lobe stretched along the sun's azimuth:
 *    a broad blazing streak running to the horizon that breaks into individual
 *    sparks close in. It is pushed well above 1.0 on purpose so bloom catches
 *    it. Nothing else in the file makes water read as *wet* the way this does.
 *  - **Distance attenuation of the surface detail.** Five directional swells,
 *    each of which switches itself off once its own wavelength gets near a
 *    pixel — measured with a footprint that accounts for grazing compression,
 *    not raw distance, because water seen edge-on is squeezed into nothing.
 *    Far water goes glassy instead of boiling, and the glitter lobe widens to
 *    replace the detail it lost.
 *  - **Depth.** There is no depth buffer to read, so the CPU samples the
 *    terrain provider into a coarse height map around the camera. That single
 *    channel gives the shoreline its soft alpha fade (no hard geometric edge),
 *    the turquoise over sandbars, the near-black of deep basins, and a foam
 *    line that laps in and out with the swell.
 */

// ------------------------------------------------------------------ layout

/**
 * The plane is deliberately larger than the far plane, so its own edge is
 * always clipped away rather than ending in mid-air short of the horizon.
 */
const SPAN_FACTOR = 2.2;
/** Flat quad — nothing is displaced, so this is only insurance against
 *  interpolation precision on very long triangles. */
const PLANE_SEGMENTS = 8;
/**
 * Metres the follow position snaps to. The wave pattern is evaluated in world
 * space so it cannot swim regardless, but snapping keeps the far edge and the
 * float precision of the corners from jittering under the camera.
 */
const SNAP = 512;
/**
 * Water draws in the transparent pass (the shore needs to fade), and this is
 * what fixes its order inside it: before the clouds, which sit at 20+, so a
 * low rotor shred over a lake still draws on top of the water instead of the
 * water painting over it.
 */
const RENDER_ORDER = 1;

// ------------------------------------------------------------- depth map

/** Texels per side of the CPU-sampled depth map. */
const DEPTH_RES = 192;
/** Metres the map covers. 12288 / 192 = 64 m per texel. */
const DEPTH_SPAN = 12288;
/** The map re-centres on this grid — a sixteenth of its own span. */
const DEPTH_SNAP = 768;
/** Deepest water the byte encoding resolves. Colour saturates long before. */
const DEPTH_RANGE = 60;
/**
 * Rows re-sampled per frame while the map slides. 192 heightAt calls a row at
 * roughly a microsecond each, so six rows is about a millisecond — small
 * beside the terrain streamer's own budget, and the whole map lands in half a
 * second, during which the previous one keeps drawing.
 */
const ROWS_PER_FRAME = 6;

// ------------------------------------------------------------------- feel

/** Seconds-ish of easing on the wind direction. A veering wind turns the sea over. */
const WIND_LAMBDA = 0.35;
/** Wind speed (m/s) at which the sea is fully worked up. */
const CHOP_FULL_WIND = 16;
/** How much dawn mist glasses the water off. Still mornings are mirror mornings. */
const MIST_CALM = 0.55;
const CHOP_LAMBDA = 0.5;

/** GLSL float literal from a JS number. */
const glf = (v: number): string => v.toFixed(5);

// =================================================================== SHADER

const WATER_VERTEX = /* glsl */ `
varying vec3 vWorld;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
`;

/**
 * Shared between both quality paths: the depth lookup, the Fresnel curve and
 * the glitter lobe. Only the surface detail is dropped at low quality.
 */
const WATER_COMMON = /* glsl */ `
uniform sampler2D uDepthTex;
uniform vec2  uDepthCenter;
uniform vec2  uWaveDir;
uniform float uChop;

varying vec3 vWorld;

/** Deep water, linear. Nearly black — most of what you see out there is sky. */
const vec3 DEEP_WATER = vec3(0.006, 0.032, 0.062);
/** Shallows over sand. The turquoise is the whole reason lakes read as places. */
const vec3 SHALLOW_WATER = vec3(0.075, 0.330, 0.330);
/** Cold and dim: moon glitter must never look like a second sun. */
const vec3 MOONLIGHT = vec3(0.42, 0.52, 0.85);
/** What a lake gives back on an aurora night, when skyColor() has nothing. */
const vec3 AURORA_TINT = vec3(0.05, 0.15, 0.09);

/** Metres of depth over which the water reaches its deep colour. */
const float DEEP_AT = 24.0;
/** Metres of depth over which the shore fades in. Keeps the edge off the geometry. */
const float EDGE_DEPTH = 0.85;
/** How brightly the sun comes back up through a sandbar. */
const float SHALLOW_GLOW = 0.16;
/** Gain on the sun's specular streak. Far above 1.0 on purpose — bloom eats it. */
const float GLITTER = 18.0;
const float MOON_GLITTER = 2.4;

/**
 * Depth (m) below the waterline at a world point, from the CPU map. Beyond the
 * map we can only assume open water; the shore fade and the shallow tint stop
 * mattering kilometres before the fog does.
 */
float waterDepth(vec2 p) {
  vec2 frac = (p - uDepthCenter) / ${glf(DEPTH_SPAN)} + 0.5;
  // Half-texel correction: the map's corner samples sit on the region's edges,
  // not at texel centres.
  vec2 uv = frac * ${glf((DEPTH_RES - 1) / DEPTH_RES)} + ${glf(0.5 / DEPTH_RES)};
  float e = texture2D(uDepthTex, clamp(uv, 0.0, 1.0)).r;
  // Stored as sqrt(depth), so the first metre — the only one the shoreline
  // cares about — keeps most of the byte's resolution.
  float d = e * e * ${glf(DEPTH_RANGE)};
  float beyond = smoothstep(0.40, 0.50, max(abs(frac.x - 0.5), abs(frac.y - 0.5)));
  return mix(d, ${glf(DEPTH_RANGE)}, beyond);
}

/**
 * Anisotropic specular lobe, stretched along the light's azimuth. Sun glitter
 * is not a round highlight: the spread of wave slopes smears it into a path
 * running away toward the horizon, and ax > ay is that path.
 */
float glint(vec3 N, vec3 viewDir, vec3 L, float ax, float ay) {
  vec3 H = L - viewDir;
  float hl = length(H);
  if (hl < 1e-4) return 0.0;
  H /= hl;
  float hn = dot(H, N);
  if (hn <= 1e-3) return 0.0;

  // Horizontal direction toward the light. With the light overhead there is no
  // azimuth to stretch along, so any axis will do and the lobe stays round.
  float ll = length(L.xz);
  vec2 t2 = mix(vec2(1.0, 0.0), L.xz / max(ll, 1e-4), step(1e-3, ll));
  vec3 T = vec3(t2.x, 0.0, t2.y);
  vec3 B = vec3(-t2.y, 0.0, t2.x);

  float ht = dot(H, T) / ax;
  float hb = dot(H, B) / ay;
  return exp(-(ht * ht + hb * hb) / (hn * hn));
}
`;

/** The wave stack. High quality only — the cheap path has a flat surface. */
const WATER_WAVES = /* glsl */ `
vec2 wrot(vec2 v, float a) {
  float c = cos(a), s = sin(a);
  return vec2(v.x * c - v.y * s, v.x * s + v.y * c);
}

/**
 * One directional swell: slope in .xy, height in .z. The plane never moves —
 * everything the eye reads as motion is this slope tilting the normal.
 */
vec3 swell(vec2 p, vec2 dir, float len, float amp, float speed, float jitter) {
  float k = 6.2831853 / len;
  float ph = dot(p, dir) * k - uTime * speed * k + jitter;
  return vec3(cos(ph) * amp * k * dir, sin(ph) * amp);
}

/**
 * THE LINE THAT DECIDES HOW FAR WATER CAN BE SEEN. Each layer switches itself
 * off once its wavelength approaches a pixel, so distant water goes glassy
 * instead of aliasing into a boiling mess. The measure is the surface
 * footprint of a pixel, not raw distance: water seen edge-on is compressed to
 * almost nothing, which is exactly why the horizon band of a real lake is a
 * mirror while the water at your feet is all texture.
 */
float layerFade(float footprint, float len) {
  // Tightened from (90, 300). At the old thresholds the long swells survived
  // out to the horizon at grazing angles and aliased into hard diagonal bands
  // across the whole lake — the single most visible artefact in the frame.
  return 1.0 - smoothstep(len * 22.0, len * 85.0, footprint);
}

vec3 waves(vec2 p, float footprint) {
  vec2 d0 = uWaveDir;
  vec2 d1 = wrot(d0, 0.42);
  vec2 d2 = wrot(d0, -0.62);
  vec2 d3 = wrot(d0, 1.15);
  vec2 d4 = wrot(d0, -1.55);

  // Sea state. Calm water is not just smaller waves, it is *much* smaller
  // waves, so this is a wide range.
  float a = mix(0.32, 1.25, uChop);

  // A slow noise field warping the phase, so the layers never beat into a
  // visible regular grid. One noise fetch buys irregularity for all of them.
  float j = anoise2(p * 0.0035 - uWaveDir * uTime * 0.006) * 6.2831853;

  vec3 w = vec3(0.0);
  w += swell(p, d0, 145.0, 0.95 * a, 7.4, 0.0)          * layerFade(footprint, 145.0);
  w += swell(p, d1,  46.0, 0.40 * a, 4.6, j * 0.7)      * layerFade(footprint, 46.0);
  w += swell(p, d2,  15.0, 0.135 * a, 2.9, j * 1.9)     * layerFade(footprint, 15.0);
  w += swell(p, d3,   5.0, 0.048 * a, 1.7, j * 3.3)     * layerFade(footprint, 5.0);
  w += swell(p, d4,   1.7, 0.014 * a, 1.1, j * 5.1)     * layerFade(footprint, 1.7);
  return w;
}
`;

function waterFragment(hq: boolean): string {
  // High quality builds a real surface; the cheap path keeps the plane flat and
  // leans entirely on Fresnel plus a broad glitter lobe, which is still enough
  // for water to read as water.
  const surface = hq
    ? /* glsl */ `
  vec3 w = waves(p, footprint);
  vec3 N = normalize(vec3(-w.x, 1.0, -w.y));
  float waveH = w.z;

  // Sparkle grain: a fine field breaking the glitter into individual points
  // near the camera. Faded out with the same footprint the waves use, or it
  // would be the one thing left aliasing at distance.
  float grainFade = 1.0 - smoothstep(400.0, 4000.0, footprint);
  float grain = anoise2(p * 0.62 + uWaveDir * (uTime * 0.9));
  float sparkle = mix(1.0, 0.25 + 1.7 * grain, grainFade);
`
    : /* glsl */ `
  vec3 N = vec3(0.0, 1.0, 0.0);
  float waveH = 0.0;
  float sparkle = 1.0;
`;

  const foam = hq
    ? /* glsl */ `
  // The lace where water meets land. It laps with the swell, which is what
  // stops the shoreline reading as a printed edge.
  float foamFade = 1.0 - smoothstep(2000.0, 20000.0, footprint);
  float band = 1.0 - smoothstep(0.0, 2.4, depth);
  float fn = anoise2(p * 0.28 + uWaveDir * (uTime * 0.35));
  float foam = band * band * smoothstep(0.44, 0.92, fn + waveH * 0.35) * foamFade;
  col += foam * (uSunColor * uSunIntensity * 0.35 + uAmbient * uAmbientIntensity * 0.8) * 0.75;
`
    : '';

  return /* glsl */ `
${ATMOSPHERE_PRELUDE}
${WATER_COMMON}
${hq ? WATER_WAVES : ''}

void main() {
  vec2 p = vWorld.xz;
  vec3 toFrag = vWorld - uCameraPos;
  float dist = length(toFrag);
  vec3 viewDir = toFrag / max(dist, 1e-3);

  // Metres of surface per unit of screen angle. Grazing views stretch this
  // enormously, and everything that could alias is keyed off it.
  float grazing = clamp(-viewDir.y, 0.0, 1.0);
  float footprint = dist / max(grazing, 0.045);

  float depth = waterDepth(p);
${surface}

  // --- shoreline ---------------------------------------------------------
  // No hard geometric edge anywhere: the water simply stops being opaque as
  // the bottom comes up, and the swell moves that line in and out.
  float alpha = smoothstep(0.0, EDGE_DEPTH, depth + waveH * 0.3);
  if (alpha < 0.004) discard;

  float deepMix = smoothstep(0.6, DEEP_AT, depth);
  float shallow = 1.0 - deepMix;

  // --- the body of the water --------------------------------------------
  vec3 albedo = mix(SHALLOW_WATER, DEEP_WATER, deepMix);
  // Diffuse uses a flattened normal: the body colour must not carry the wave
  // texture, only the reflection and the glitter may.
  vec3 bodyN = normalize(mix(vec3(0.0, 1.0, 0.0), N, 0.3));
  vec3 body = shadeSurface(albedo, bodyN, viewDir, mix(1.0, 0.5, deepMix));
  // Sun coming back up out of a sandbar.
  body += SHALLOW_GLOW * albedo * uSunColor * uSunIntensity * shallow * max(uSunDir.y, 0.0);

  // --- the mirror --------------------------------------------------------
  // Schlick, F0 = 0.02. Straight down you get the water itself; anywhere near
  // flat you get the sky, and that swing is most of what makes this expensive.
  float cosI = clamp(dot(-viewDir, N), 0.0, 1.0);
  float fres = 0.02 + 0.98 * pow(1.0 - cosI, 5.0);

  vec3 R = reflect(viewDir, N);
  // A steep wave face can tip the mirror below the horizon, where skyColor()
  // returns ground bounce and the lake grows dark blotches. Never allow it.
  R.y = max(R.y, 0.0035);
  vec3 refl = skyColor(normalize(R));

  vec3 col = mix(body, refl, fres);

  // The aurora is drawn by the sky dome and skyColor() knows nothing about it,
  // so on the one night the sky is the entire show a lake would come back
  // black. Faint, and only where the mirror is looking well up.
  col += AURORA_TINT * uAurora * fres * smoothstep(0.02, 0.45, R.y);

  // --- glitter -----------------------------------------------------------
  // Losing the fine normals at distance would kill the streak, so the lobe
  // widens by exactly as much as the surface flattened: near the camera it is
  // tight and breaks into sparks, at the horizon it is a broad blazing path.
  float wide = smoothstep(1500.0, 60000.0, footprint);
  float ax = mix(0.055, 0.30, wide);
  float ay = mix(0.040, 0.085, wide);

  float sunUp = smoothstep(-0.03, 0.08, uSunDir.y);
  float spec = glint(N, viewDir, uSunDir, ax, ay) * sparkle;
  col += uSunColor * uSunIntensity * spec * fres * GLITTER * sunUp;

  // The same effect under the moon, dim and cold, so night water still moves.
  float moonUp = smoothstep(-0.03, 0.10, uMoonDir.y) * uStars;
  float mspec = glint(N, viewDir, uMoonDir, ax * 1.4, ay * 1.4) * sparkle;
  col += MOONLIGHT * mspec * fres * MOON_GLITTER * moonUp;
${foam}

  col = aerialPerspective(col, vWorld, viewDir, dist);
  col += ditherValue(gl_FragCoord.xy);

  gl_FragColor = vec4(max(col, vec3(0.0)), clamp(alpha, 0.0, 1.0));
}
`;
}

// ==================================================================== CLASS

export class WaterPlane {
  private readonly scene: THREE.Scene;
  private readonly cfg: Config;
  private readonly terrain: TerrainProvider;
  private readonly level: number;

  private readonly geom: THREE.PlaneGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;

  private readonly depthData: Uint8Array<ArrayBuffer>;
  private readonly depthTex: THREE.DataTexture;

  private readonly uDepthTex: { value: THREE.DataTexture };
  private readonly uDepthCenter: { value: THREE.Vector2 };
  private readonly uWaveDir: { value: THREE.Vector2 };
  private readonly uChop: { value: number };

  private hq: boolean;

  /** Smoothed wind direction, unit length. Starts blowing toward -Z. */
  private windX = 0;
  private windZ = -1;
  private chop = 0.5;

  /** Centre of the depth map currently on the GPU, and whether there is one. */
  private texCx = 0;
  private texCz = 0;
  private texValid = false;

  /** Centre and progress of the map being sampled right now. */
  private buildCx = 0;
  private buildCz = 0;
  private buildRow = 0;
  private building = false;

  constructor(
    scene: THREE.Scene,
    cfg: Config,
    terrain: TerrainProvider,
    atmo: AtmosphereUniforms,
    quality: QualitySettings,
  ) {
    this.scene = scene;
    this.cfg = cfg;
    this.terrain = terrain;
    this.level = terrain.waterLevel();
    this.hq = quality.waterReflection;

    const span = Math.max(cfg.viewDistance * SPAN_FACTOR, 8000);
    this.geom = new THREE.PlaneGeometry(span, span, PLANE_SEGMENTS, PLANE_SEGMENTS);
    this.geom.rotateX(-Math.PI / 2);

    // Explicitly backed by an ArrayBuffer: TypeScript 5.7 made the typed
    // arrays generic over their buffer, and DataTexture will not take one that
    // might be sitting on a SharedArrayBuffer.
    this.depthData = new Uint8Array(new ArrayBuffer(DEPTH_RES * DEPTH_RES));
    this.depthTex = new THREE.DataTexture(
      this.depthData,
      DEPTH_RES,
      DEPTH_RES,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    this.depthTex.minFilter = THREE.LinearFilter;
    this.depthTex.magFilter = THREE.LinearFilter;
    this.depthTex.wrapS = THREE.ClampToEdgeWrapping;
    this.depthTex.wrapT = THREE.ClampToEdgeWrapping;
    this.depthTex.generateMipmaps = false;
    this.depthTex.needsUpdate = true;

    this.uDepthTex = { value: this.depthTex };
    this.uDepthCenter = { value: new THREE.Vector2() };
    this.uWaveDir = { value: new THREE.Vector2(0, -1) };
    this.uChop = { value: this.chop };

    const uniforms = withAtmosphere(atmo, {
      uDepthTex: this.uDepthTex,
      uDepthCenter: this.uDepthCenter,
      uWaveDir: this.uWaveDir,
      uChop: this.uChop,
    });

    this.material = new THREE.ShaderMaterial({
      uniforms: uniforms as unknown as Record<string, THREE.IUniform>,
      vertexShader: WATER_VERTEX,
      fragmentShader: waterFragment(this.hq),
      // The shore needs to fade, so water lives in the transparent pass — but
      // it still writes depth, because it is opaque everywhere else and the
      // ribbons and clouds under it must be occluded.
      transparent: true,
      depthWrite: true,
      depthTest: true,
      // Seen from below (a bird on the water, the camera dipping under) the
      // surface should still be there rather than a hole into the sky.
      side: THREE.DoubleSide,
      fog: false,
      lights: false,
    });

    this.mesh = new THREE.Mesh(this.geom, this.material);
    this.mesh.position.set(0, this.level, 0);
    this.mesh.renderOrder = RENDER_ORDER;
    // The plane is always under the camera and always crosses the frustum;
    // culling it can only ever be wrong.
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  update(
    dt: number,
    cameraPos: THREE.Vector3,
    sky: SkyState,
    windDirX: number,
    windDirZ: number,
  ): void {
    // Wind eases rather than snaps, so a veering wind turns the sea over.
    const wl = Math.hypot(windDirX, windDirZ);
    if (wl > 1e-4) {
      this.windX = damp(this.windX, windDirX / wl, WIND_LAMBDA, dt);
      this.windZ = damp(this.windZ, windDirZ / wl, WIND_LAMBDA, dt);
    }
    const l = Math.hypot(this.windX, this.windZ);
    if (l > 1e-4) this.uWaveDir.value.set(this.windX / l, this.windZ / l);

    // Sea state: wind works the water up, dawn mist glasses it off. A still
    // misty morning lake is a mirror, and that is worth the two lines.
    const target =
      clamp01(this.cfg.windSpeed / CHOP_FULL_WIND) *
      (1 - MIST_CALM * clamp01(sky.mistStrength));
    this.chop = damp(this.chop, target, CHOP_LAMBDA, dt);
    this.uChop.value = this.chop;

    // Follow the camera on a coarse grid. The surface is evaluated in world
    // space, so the pattern is nailed to the world and cannot swim.
    this.mesh.position.set(
      Math.round(cameraPos.x / SNAP) * SNAP,
      this.level,
      Math.round(cameraPos.z / SNAP) * SNAP,
    );

    this.updateDepth(cameraPos);
  }

  setQuality(q: QualitySettings): void {
    if (q.waterReflection === this.hq) return;
    this.hq = q.waterReflection;
    this.material.fragmentShader = waterFragment(this.hq);
    this.material.needsUpdate = true;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.geom.dispose();
    this.material.dispose();
    this.depthTex.dispose();
  }

  // ------------------------------------------------------------ depth map

  private updateDepth(cameraPos: THREE.Vector3): void {
    const cx = Math.round(cameraPos.x / DEPTH_SNAP) * DEPTH_SNAP;
    const cz = Math.round(cameraPos.z / DEPTH_SNAP) * DEPTH_SNAP;

    // First frame, or the camera was moved (a new run, a new seed): there is
    // no usable map at all, and no map means no water, so pay for it now.
    const jumped =
      !this.texValid ||
      Math.abs(cx - this.texCx) > DEPTH_SPAN * 0.35 ||
      Math.abs(cz - this.texCz) > DEPTH_SPAN * 0.35;
    if (jumped) {
      this.beginBuild(cx, cz);
      this.buildRows(DEPTH_RES);
      return;
    }

    if (!this.building && (cx !== this.texCx || cz !== this.texCz)) {
      this.beginBuild(cx, cz);
    }
    if (this.building) this.buildRows(ROWS_PER_FRAME);
  }

  private beginBuild(cx: number, cz: number): void {
    this.buildCx = cx;
    this.buildCz = cz;
    this.buildRow = 0;
    this.building = true;
  }

  /**
   * Sample terrain height into the map, a few rows at a time. Nothing is
   * uploaded until the whole map is consistent, so the shader keeps reading
   * the previous one — a half-written map would drag a seam of alpha across
   * every shoreline on screen.
   */
  private buildRows(rows: number): void {
    const step = DEPTH_SPAN / (DEPTH_RES - 1);
    const x0 = this.buildCx - DEPTH_SPAN * 0.5;
    const z0 = this.buildCz - DEPTH_SPAN * 0.5;
    const level = this.level;
    const data = this.depthData;
    const end = Math.min(this.buildRow + rows, DEPTH_RES);

    for (let j = this.buildRow; j < end; j++) {
      const z = z0 + j * step;
      const base = j * DEPTH_RES;
      for (let i = 0; i < DEPTH_RES; i++) {
        const d = level - this.terrain.heightAt(x0 + i * step, z);
        if (d <= 0) {
          data[base + i] = 0;
        } else {
          // sqrt encoding: the shoreline lives in the first metre, and this is
          // what keeps that metre from collapsing into one or two byte steps.
          const e = Math.sqrt(Math.min(d, DEPTH_RANGE) / DEPTH_RANGE);
          data[base + i] = Math.min(255, Math.round(e * 255));
        }
      }
    }
    this.buildRow = end;

    if (this.buildRow >= DEPTH_RES) {
      this.building = false;
      this.texCx = this.buildCx;
      this.texCz = this.buildCz;
      this.texValid = true;
      this.uDepthCenter.value.set(this.texCx, this.texCz);
      this.depthTex.needsUpdate = true;
    }
  }
}
