import * as THREE from 'three';
import type { SkyState } from '../../sim/types';

/**
 * ONE ATMOSPHERE, SHARED BY EVERYTHING.
 *
 * The single biggest reason a real-time scene reads as "a place" instead of
 * "some meshes" is that every surface in it agrees about the light. Terrain,
 * clouds, water, the wind ribbons, the bird and the sky dome all include the
 * GLSL below and all read the same uniform object *by reference*, so there is
 * exactly one source of truth for where the sun is, what colour it is, and
 * how much air sits between the camera and any given fragment.
 *
 * Aerial perspective is the star: distant things don't just fade to a fog
 * colour, they fade toward *the colour of the sky in the direction you are
 * looking*, brightening toward the sun. That single trick is most of what
 * makes height feel like height.
 */

export interface AtmosphereUniforms {
  uSunDir: { value: THREE.Vector3 };
  uMoonDir: { value: THREE.Vector3 };
  uSunColor: { value: THREE.Color };
  uSunIntensity: { value: number };
  uSkyZenith: { value: THREE.Color };
  uSkyHorizon: { value: THREE.Color };
  uGroundBounce: { value: THREE.Color };
  uFogColor: { value: THREE.Color };
  uFogDensity: { value: number };
  uAmbient: { value: THREE.Color };
  uAmbientIntensity: { value: number };
  uTime: { value: number };
  uCameraPos: { value: THREE.Vector3 };
  uExposure: { value: number };
  uMist: { value: number };
  uStars: { value: number };
  uAurora: { value: number };
  uWaterLevel: { value: number };
  /** Day progress 0..1, for anything that wants the raw clock. */
  uDayT: { value: number };
  [key: string]: { value: unknown };
}

export function createAtmosphereUniforms(waterLevel = 0): AtmosphereUniforms {
  return {
    uSunDir: { value: new THREE.Vector3(0, 0.3, -1).normalize() },
    uMoonDir: { value: new THREE.Vector3(0, -0.3, 1).normalize() },
    uSunColor: { value: new THREE.Color(1, 0.85, 0.65) },
    uSunIntensity: { value: 1 },
    uSkyZenith: { value: new THREE.Color(0.19, 0.36, 0.66) },
    uSkyHorizon: { value: new THREE.Color(0.72, 0.79, 0.86) },
    uGroundBounce: { value: new THREE.Color(0.22, 0.24, 0.2) },
    uFogColor: { value: new THREE.Color(0.72, 0.79, 0.86) },
    uFogDensity: { value: 0.000035 },
    uAmbient: { value: new THREE.Color(0.4, 0.5, 0.65) },
    uAmbientIntensity: { value: 0.55 },
    uTime: { value: 0 },
    uCameraPos: { value: new THREE.Vector3() },
    uExposure: { value: 1 },
    uMist: { value: 0 },
    uStars: { value: 0 },
    uAurora: { value: 0 },
    uWaterLevel: { value: waterLevel },
    uDayT: { value: 0 },
  };
}

const _c = new THREE.Color();

/** Push a SkyState into the shared uniforms. Called once per frame, total. */
export function syncAtmosphere(
  u: AtmosphereUniforms,
  sky: SkyState,
  cameraPos: THREE.Vector3,
  time: number,
): void {
  u.uSunDir.value.set(sky.sunDir.x, sky.sunDir.y, sky.sunDir.z);
  u.uMoonDir.value.set(sky.moonDir.x, sky.moonDir.y, sky.moonDir.z);
  u.uSunColor.value.setRGB(sky.sunColor.x, sky.sunColor.y, sky.sunColor.z);
  u.uSunIntensity.value = sky.sunIntensity;
  u.uSkyZenith.value.setRGB(sky.skyZenith.x, sky.skyZenith.y, sky.skyZenith.z);
  u.uSkyHorizon.value.setRGB(sky.skyHorizon.x, sky.skyHorizon.y, sky.skyHorizon.z);
  u.uGroundBounce.value.setRGB(sky.groundBounce.x, sky.groundBounce.y, sky.groundBounce.z);
  u.uFogColor.value.setRGB(sky.fogColor.x, sky.fogColor.y, sky.fogColor.z);
  u.uFogDensity.value = sky.fogDensity;
  u.uAmbient.value.setRGB(sky.ambient.x, sky.ambient.y, sky.ambient.z);
  u.uAmbientIntensity.value = sky.ambientIntensity;
  u.uTime.value = time;
  u.uCameraPos.value.copy(cameraPos);
  u.uExposure.value = sky.exposure;
  u.uMist.value = sky.mistStrength;
  u.uStars.value = sky.starVisibility;
  u.uAurora.value = sky.auroraStrength;
  u.uDayT.value = sky.t;
  void _c;
}

/**
 * GLSL declarations for the shared uniforms. Prepend to any fragment (and,
 * where needed, vertex) shader that wants to live in this atmosphere.
 */
export const ATMOSPHERE_UNIFORMS_GLSL = /* glsl */ `
uniform vec3  uSunDir;
uniform vec3  uMoonDir;
uniform vec3  uSunColor;
uniform float uSunIntensity;
uniform vec3  uSkyZenith;
uniform vec3  uSkyHorizon;
uniform vec3  uGroundBounce;
uniform vec3  uFogColor;
uniform float uFogDensity;
uniform vec3  uAmbient;
uniform float uAmbientIntensity;
uniform float uTime;
uniform vec3  uCameraPos;
uniform float uExposure;
uniform float uMist;
uniform float uStars;
uniform float uAurora;
uniform float uWaterLevel;
uniform float uDayT;
`;

/**
 * Shared helper functions. Hash/noise first (several modules want them), then
 * the sky model, then aerial perspective, then tonemapping.
 */
export const ATMOSPHERE_GLSL = /* glsl */ `
// ------------------------------------------------------------- hashing
float ahash11(float p){ p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float ahash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float ahash13(vec3 p3){
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 ahash33(vec3 p3){
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}

float anoise2(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = ahash12(i), b = ahash12(i + vec2(1.0, 0.0));
  float c = ahash12(i + vec2(0.0, 1.0)), d = ahash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float anoise3(vec3 p){
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = ahash13(i), n100 = ahash13(i + vec3(1,0,0));
  float n010 = ahash13(i + vec3(0,1,0)), n110 = ahash13(i + vec3(1,1,0));
  float n001 = ahash13(i + vec3(0,0,1)), n101 = ahash13(i + vec3(1,0,1));
  float n011 = ahash13(i + vec3(0,1,1)), n111 = ahash13(i + vec3(1,1,1));
  return mix(mix(mix(n000,n100,f.x), mix(n010,n110,f.x), f.y),
             mix(mix(n001,n101,f.x), mix(n011,n111,f.x), f.y), f.z);
}
float afbm2(vec2 p, int oct){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++){ if (i >= oct) break; s += anoise2(p) * a; p *= 2.03; a *= 0.5; }
  return s;
}
float afbm3(vec3 p, int oct){
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 6; i++){ if (i >= oct) break; s += anoise3(p) * a; p *= 2.07; a *= 0.5; }
  return s;
}

// ----------------------------------------------------------- scattering
// A cheap analytic stand-in for Rayleigh + Mie. Not physically exact, but it
// obeys the two rules that matter for a game sky: the horizon is brighter and
// warmer than the zenith, and the whole thing swings hard toward the sun.
float rayleighPhase(float c){ return 0.75 * (1.0 + c * c); }
float miePhase(float c, float g){
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * 3.14159265 * pow(1.0 + g2 - 2.0 * g * c, 1.5));
}

/** Colour of the sky in a given (normalized) direction. */
vec3 skyColor(vec3 dir){
  float up = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
  // Horizon band is compressed: most of the interesting colour lives in the
  // first few degrees above the horizon, exactly like the real thing.
  float h = pow(1.0 - clamp(dir.y, 0.0, 1.0), 3.2);
  vec3 col = mix(uSkyZenith, uSkyHorizon, h);

  // ground half: darker, tinted by what the land bounces back
  float below = smoothstep(0.0, -0.14, dir.y);
  col = mix(col, uGroundBounce, below * 0.86);

  float c = dot(dir, uSunDir);
  // Rayleigh-ish forward brightening across the whole dome. Kept small on
  // purpose: at 0.055 this term was adding as much light again as the zenith
  // colour itself, which desaturated the entire sky to a pale neutral and
  // then dragged everything else there through aerial perspective.
  col += uSunColor * uSunIntensity * 0.024 * rayleighPhase(c) * (0.35 + 0.65 * up);
  // Mie halo hugging the sun, strongest near the horizon (dusty low air)
  float mie = miePhase(c, 0.76);
  col += uSunColor * uSunIntensity * mie * 0.16 * (0.4 + 0.6 * h);

  // the sun's own glow (the disc itself is drawn by the sky dome)
  float sunGlow = pow(max(c, 0.0), 220.0);
  col += uSunColor * uSunIntensity * sunGlow * 2.2;

  return max(col, vec3(0.0));
}

// ------------------------------------------------- aerial perspective
/**
 * Blend a surface colour toward the atmosphere between it and the camera.
 * Density thins with height (scale height ~2200 m) so a mountain 15 km away
 * at 4000 m stays crisp while the valley floor at the same distance is milk.
 */
vec3 aerialPerspective(vec3 color, vec3 worldPos, vec3 viewDir, float dist){
  float camH = max(uCameraPos.y, 0.0);
  float fragH = max(worldPos.y, 0.0);
  float meanH = 0.5 * (camH + fragH);
  float heightFalloff = exp(-meanH / 2200.0);

  // FOG_SCALE turns uFogDensity (a per-metre coefficient of order 3e-5) into
  // the dimensionless optical depth the falloff below expects. At 3.0 a clear
  // midday gives roughly: 3 km barely touched, 15 km three-quarters hazed,
  // 40 km gone. Raise it and the world closes in around you.
  const float FOG_SCALE = 3.0;
  float d = dist * uFogDensity * heightFalloff * FOG_SCALE;
  float f = 1.0 - exp(-d * d * 0.55 - d * 0.35);

  // Fog takes the colour of the sky you're looking through, not a flat grey.
  vec3 airColor = mix(uFogColor, skyColor(viewDir), 0.62);

  // Low valley mist: a dense shallow layer that only bites near the ground.
  float mistBand = exp(-max(fragH - uWaterLevel, 0.0) / 190.0);
  float mistF = 1.0 - exp(-dist * 0.00016 * uMist * mistBand);
  vec3 mistColor = mix(uFogColor, uSkyHorizon, 0.4) * 1.06;

  vec3 outc = mix(color, airColor, clamp(f, 0.0, 1.0));
  outc = mix(outc, mistColor, clamp(mistF, 0.0, 0.92));
  return outc;
}

// ------------------------------------------------------------ lighting
/**
 * The shared surface lighting model: warm directional key from the sun,
 * hemispheric fill split between sky above and bounce below, and a rim term
 * that keeps silhouettes legible against a bright sky.
 */
vec3 shadeSurface(vec3 albedo, vec3 normal, vec3 viewDir, float ao){
  float ndl = dot(normal, uSunDir);
  // Wrapped diffuse — a little light bleeds past the terminator, which stops
  // shadowed slopes from going dead black at low sun.
  float wrap = clamp((ndl + 0.28) / 1.28, 0.0, 1.0);
  vec3 key = uSunColor * uSunIntensity * wrap;

  float hemi = clamp(normal.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 fill = mix(uGroundBounce, uAmbient, hemi) * uAmbientIntensity;

  // Rim: brighter where the surface turns away from the eye and toward the sun.
  float rim = pow(1.0 - clamp(dot(normal, -viewDir), 0.0, 1.0), 3.0);
  float backlit = clamp(dot(-viewDir, uSunDir) * 0.5 + 0.5, 0.0, 1.0);
  vec3 rimC = uSunColor * uSunIntensity * rim * backlit * 0.5;

  return albedo * (key + fill * ao) + rimC * ao;
}

// --------------------------------------------------------- tonemapping
vec3 acesFilm(vec3 x){
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

/** Ordered dither — kills banding in the big smooth sky gradients. */
float ditherValue(vec2 fragCoord){
  return (ahash12(fragCoord + fract(uTime) * 17.13) - 0.5) / 255.0;
}
`;

/** Convenience: the two chunks together, in the right order. */
export const ATMOSPHERE_PRELUDE = ATMOSPHERE_UNIFORMS_GLSL + ATMOSPHERE_GLSL;

/**
 * Merge the shared atmosphere uniforms into a material's uniform object *by
 * reference*, so one syncAtmosphere() call updates every material at once.
 */
export function withAtmosphere<T extends Record<string, { value: unknown }>>(
  atmo: AtmosphereUniforms,
  own: T,
): T & AtmosphereUniforms {
  return Object.assign({}, own, atmo) as T & AtmosphereUniforms;
}
