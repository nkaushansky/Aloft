import * as THREE from 'three';
import type { Config } from '../../sim/config';
import type { QualitySettings, SkyState } from '../../sim/types';
import { ATMOSPHERE_PRELUDE, withAtmosphere } from '../shaders/atmosphere';
import type { AtmosphereUniforms } from '../shaders/atmosphere';
import { clamp01, damp } from '../../sim/math';

/**
 * THE DOME.
 *
 * One inverted sphere, one draw call, recentred on the camera every frame so
 * it can never be reached. Everything in it is procedural, so there is not a
 * single texture and not a single seam.
 *
 * The important discipline here: the base colour is `skyColor()` from the
 * shared atmosphere — the *same* function the terrain's aerial perspective
 * fades into. That is why a ridge 15 km out dissolves into exactly the sky
 * behind it instead of into a slightly-wrong grey. Everything else in this
 * shader (sun, moon, stars, aurora, cirrus) is added on top of that base and
 * never replaces it.
 *
 * Draw order inside the fragment shader is the physical one: sky, then the
 * sun's wide halo, then things at infinity (stars, Milky Way, moon), then the
 * aurora at ~100 km, then the cirrus deck at ~8 km veiling all of it, and only
 * then the sun's disc itself — kept clean and far above 1.0 so the bloom in
 * the post chain has something real to bleed from.
 */

/** Vertex: the dome is only ever translated, so local position *is* the view ray. */
const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAG = /* glsl */ `
${ATMOSPHERE_PRELUDE}

varying vec3 vDir;

uniform float uSunSize;    // angular radius of the sun disc, radians
uniform float uMoonSize;   // angular radius of the moon disc, radians
uniform float uMoonPhase;  // 0..1 around the terminator; 0.25 is a fat crescent
uniform float uStarGrid;   // stars per cube-face unit — quality dial
uniform float uCirrus;     // 0..1 how much high cloud the day is carrying

// The plane of the galaxy, tilted so the band cuts the sky diagonally rather
// than lying along an axis of the world (which reads as a bug immediately).
const vec3 MW_POLE = vec3(0.4104, 0.6486, -0.6407);
// Yaw 0 faces -Z, so the aurora sits ahead of a bird flying the crossing.
const vec3 NORTH = vec3(0.0, 0.0, -1.0);

// ------------------------------------------------------------------ stars
/**
 * One star per cell of a grid laid over the cube faces: even density, and the
 * cost is a fixed handful of hashes per pixel no matter how many stars are on
 * screen. 'mw' lifts the magnitude curve inside the Milky Way so the band
 * reads as *more stars*, not merely a brighter smear.
 */
vec3 starField(vec3 dir, float grid, float mw) {
  vec3 ad = abs(dir);
  vec2 uv;
  float face;
  if (ad.x >= ad.y && ad.x >= ad.z)      { uv = dir.zy / ad.x; face = dir.x > 0.0 ? 0.0 : 1.0; }
  else if (ad.y >= ad.z)                 { uv = dir.xz / ad.y; face = dir.y > 0.0 ? 2.0 : 3.0; }
  else                                   { uv = dir.xy / ad.z; face = dir.z > 0.0 ? 4.0 : 5.0; }

  vec2 g = uv * grid + face * 71.0;
  vec2 gi = floor(g);
  vec2 gf = fract(g) - 0.5;

  vec3 r = ahash33(vec3(gi, face * 13.0));
  float d2 = dot(gf - (r.xy - 0.5) * 0.64, gf - (r.xy - 0.5) * 0.64);

  // Steep magnitude distribution: almost every cell holds nothing, a few hold
  // something you would actually point at. Real skies are mostly empty.
  float mag = pow(max(r.z, 1e-4), 11.0 - 5.5 * mw);

  // Core is held near 1.5 px wide whatever the grid density, so raising
  // quality adds stars instead of fattening them.
  float sharp = 936000.0 / (grid * grid);
  float core = exp(-d2 * sharp);
  float halo = exp(-d2 * sharp * 0.1) * 0.2;

  // A slow breath, not a twinkle — anything faster turns the sky into TV snow.
  float tw = ahash12(gi + 3.7);
  float scint = 0.93 + 0.07 * sin(uTime * (0.3 + tw * 0.45) + tw * 40.0);

  // Colour temperature: a few orange giants among the blue-whites.
  vec3 tint = mix(vec3(1.0, 0.76, 0.58), vec3(0.72, 0.83, 1.0), ahash12(gi + 19.1));
  return tint * (mag * (core + halo) * scint);
}

// ----------------------------------------------------------------- aurora
/**
 * Vertical curtains standing in the northern sky: a few sheets whose position
 * wanders on slow fbm, each frayed into rays toward its top. Green oxygen at
 * the foot going magenta where the atmosphere thins. Deliberately restrained —
 * this is a reward for reaching the night, not a screensaver.
 */
vec3 auroraCurtains(vec3 dir) {
  float north = smoothstep(-0.10, 0.55, dot(dir, NORTH));
  float el = dir.y;
  // Standing on the horizon, fading out well before the zenith.
  float vert = smoothstep(0.0, 0.07, el) * (1.0 - smoothstep(0.16, 0.72, el));
  if (north <= 0.0 || vert <= 0.0) return vec3(0.0);

  float az = atan(dir.x, -dir.z);
  float t = uTime * 0.035;

  float sum = 0.0;
  for (int i = 0; i < AURORA_CURTAINS; i++) {
    float fi = float(i);
    float wob = afbm2(vec2(az * 1.7 + fi * 5.3, t + fi * 0.9), AURORA_OCT) - 0.5;
    float centre = (fi - float(AURORA_CURTAINS - 1) * 0.5) * 0.42 + wob * 0.8;
    float d = az - centre;
    float sheet = exp(-d * d * 24.0);
    // Torn along its length and dissolving upward into rays.
    float fray = afbm2(vec2(az * 9.0 + fi * 3.1, el * 3.2 - t * 2.2), AURORA_OCT);
    sum += sheet * (0.40 + 0.95 * fray);
  }

  // Fine vertical striation — the single detail that says "aurora" and not "fog".
  float striate = 0.60 + 0.40 * sin(az * 210.0 + afbm2(vec2(az * 26.0, t * 3.0), 2) * 7.0);

  vec3 c = mix(vec3(0.10, 1.00, 0.44), vec3(0.78, 0.22, 0.96), smoothstep(0.04, 0.55, el));
  return c * (sum * vert * striate * north);
}

// ----------------------------------------------------------------- cirrus
/**
 * A flat deck of ice cloud projected onto the view ray, so the wisps compress
 * toward the horizon exactly the way a real layer does. Stretched hard on one
 * axis because cirrus is fibrous, never blobby. 'cover' comes back separately
 * so the caller can veil what is behind it rather than adding light twice.
 */
vec3 cirrusDeck(vec3 dir, out float cover) {
  cover = 0.0;
  float h = dir.y;
  if (h < 0.012) return vec3(0.0);

  // Clamped so the projection cannot run to infinity and alias at the horizon.
  vec2 p = dir.xz / max(h, 0.062) * 1.15;
  p += vec2(uTime * 0.0022, uTime * 0.0011);
  vec2 q = vec2(p.x * 0.30, p.y * 1.25);

  float f = afbm2(q * 0.9, CIRRUS_OCT) + 0.10 * afbm2(q * 4.1, 2);
  float wisp = smoothstep(0.52, 0.90, f);
  // Fade hard near the horizon. A flat deck projected onto near-horizontal
  // rays stretches without limit, and the result is vertical smears standing
  // over the skyline — the artefact reads as a broken shader, not as weather.
  wisp *= smoothstep(0.055, 0.30, h);

  float c = dot(dir, uSunDir);
  // Ice forward-scatters ferociously: the wisps near the sun go white-hot.
  float fwd = pow(max(c, 0.0), 6.0);
  vec3 lit = uSunColor * uSunIntensity * (0.42 + 1.9 * fwd);

  // With the sun on the horizon the deck is lit from underneath — this is the
  // whole reason cirrus exists in this game.
  float low = exp(-abs(uSunDir.y) * 6.0);
  vec3 col = mix(lit, lit * vec3(1.45, 0.70, 0.46), low);

  // After sundown they are just a dim grey veil holding skylight.
  float night = 1.0 - smoothstep(-0.10, 0.05, uSunDir.y);
  col = mix(col, uSkyHorizon * 0.45 + uAmbient * uAmbientIntensity * 0.35, night);

  // Nearly transparent under a high sun, thick and structural at sunset. The
  // high-sun figure has to be genuinely small: cirrus at noon that reads as a
  // veil bleaches the blue out of the whole dome.
  cover = wisp * mix(0.07, 0.66, low) * uCirrus;
  return col;
}

void main() {
  vec3 dir = normalize(vDir);

  // 1 — the shared sky. Gradient, Rayleigh brightening and the Mie halo all
  // arrive here already agreeing with the terrain's aerial perspective.
  vec3 col = skyColor(dir);

  float sunAng = acos(clamp(dot(dir, uSunDir), -1.0, 1.0));
  // Fade the whole solar contribution out as the sun sinks, rather than
  // letting a hard disc slice itself in half on the horizon line.
  float sunUp = smoothstep(-0.05, 0.02, uSunDir.y);

  // 2a — the wide warm glow, added before the cirrus so the veil catches it.
  float glow = exp(-sunAng * 16.0) * 0.55 + exp(-sunAng * 3.2) * 0.10;
  col += uSunColor * uSunIntensity * glow * sunUp;

  // 3/4 — everything at infinity. One uniform branch keeps the daytime sky
  // from paying for any of it.
  if (uStars > 0.003) {
    // Atmospheric extinction: stars die in the thick air near the horizon.
    float ext = smoothstep(-0.01, 0.18, dir.y);

    float mwTex = afbm3(dir * 5.0 + 17.0, MW_OCT);
    float mwBand = 1.0 - smoothstep(0.02, 0.34, abs(dot(dir, MW_POLE)));
    float mw = clamp(mwBand * (0.30 + 1.15 * mwTex), 0.0, 1.0);

    col += starField(dir, uStarGrid, mw) * 1.7 * uStars * ext;
    // Unresolved starlight plus warm dust — faint on purpose; a bright Milky
    // Way is the fastest way to make a sky look like a phone wallpaper.
    col += mix(vec3(0.40, 0.45, 0.66), vec3(0.86, 0.79, 0.68), mwTex) * mw * 0.035 * uStars * ext;

    // The moon, with a real terminator: build a frame on its disc, lift a
    // hemisphere normal out of it and light that.
    float moonUp = smoothstep(-0.06, 0.03, uMoonDir.y);
    if (moonUp > 0.0) {
      vec3 mz = uMoonDir;
      vec3 upv = abs(mz.y) > 0.985 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
      vec3 mx = normalize(cross(upv, mz));
      vec3 my = cross(mz, mx);
      vec2 duv = vec2(dot(dir, mx), dot(dir, my)) / uMoonSize;
      float r2 = dot(duv, duv);
      float facing = step(0.0, dot(dir, mz));
      float inside = (1.0 - smoothstep(0.90, 1.0, sqrt(r2))) * facing;

      vec3 n = vec3(duv, sqrt(max(1.0 - min(r2, 1.0), 0.0)));
      float ph = uMoonPhase * 6.28318531;
      vec3 L = normalize(vec3(sin(ph), 0.22, cos(ph)));
      // Regolith is famously flat-lit — a straight lambert reads as a snooker ball.
      float lam = pow(max(dot(n, L), 0.001), 0.55);
      float maria = 0.80 + 0.20 * anoise2(duv * 2.6 + 5.0);
      float grain = 0.93 + 0.07 * anoise2(duv * 9.0);

      col += vec3(0.90, 0.92, 1.0) * maria * grain * inside * lam * 3.4 * uStars * moonUp;
      col += vec3(0.60, 0.68, 0.88) * exp(-r2 * 0.045) * 0.11 * uStars * moonUp;
    }
  }

  // 5 — the aurora, in front of the stars and behind the cloud.
  if (uAurora > 0.003) {
    col += auroraCurtains(dir) * uAurora * 0.42;
  }

  // 6 — high cirrus veils everything above.
  if (uCirrus > 0.004) {
    float cover;
    vec3 cc = cirrusDeck(dir, cover);
    col = mix(col, cc, clamp(cover, 0.0, 0.85));
  }

  // 2b — the disc itself, last and clean, deep into HDR for the bloom.
  float limb = 1.0 - smoothstep(uSunSize * 0.80, uSunSize * 1.08, sunAng);
  float darken = mix(1.0, 0.62, clamp(sunAng / max(uSunSize, 1e-5), 0.0, 1.0));
  col += uSunColor * uSunIntensity * limb * darken * 62.0 * sunUp;

  // 7 — a sky gradient without dither bands like a cheap gif.
  col = max(col, vec3(0.0)) + ditherValue(gl_FragCoord.xy);

  gl_FragColor = vec4(col, 1.0);
}
`;

/** A type alias, not an interface — `withAtmosphere` needs an implicit index signature. */
type DomeUniforms = {
  uSunSize: { value: number };
  uMoonSize: { value: number };
  uMoonPhase: { value: number };
  uStarGrid: { value: number };
  uCirrus: { value: number };
};

export class SkyDome {
  private readonly scene: THREE.Scene;
  private readonly geo: THREE.SphereGeometry;
  private readonly mat: THREE.ShaderMaterial;
  private readonly mesh: THREE.Mesh;

  private readonly own: DomeUniforms = {
    uSunSize: { value: 0.0095 },
    uMoonSize: { value: 0.0125 },
    uMoonPhase: { value: 0.18 },
    uStarGrid: { value: 60 },
    uCirrus: { value: 0.4 },
  };

  /** Smoothed cirrus coverage — scrubbing the clock must not pop the sky. */
  private cirrus = 0.4;

  constructor(scene: THREE.Scene, cfg: Config, atmo: AtmosphereUniforms, quality: QualitySettings) {
    this.scene = scene;

    const tier = quality.tier;
    const ultra = tier === 'ultra';
    const high = ultra || tier === 'high';
    const low = tier === 'low';

    // More stars at higher tiers, not bigger ones (see `sharp` in the shader).
    this.own.uStarGrid.value = low ? 44 : tier === 'medium' ? 60 : ultra ? 92 : 76;

    // The dome sits well inside the draw distance so it can never be clipped
    // by the far plane; depthTest is off and it draws first, so it still ends
    // up behind every mountain regardless of how far the terrain streams.
    const radius = cfg.viewDistance * 0.85;
    const segs = low ? 32 : high ? 64 : 48;
    this.geo = new THREE.SphereGeometry(radius, segs, Math.max(16, segs >> 1));

    this.mat = new THREE.ShaderMaterial({
      uniforms: withAtmosphere(atmo, this.own),
      vertexShader: VERT,
      fragmentShader: FRAG,
      defines: {
        CIRRUS_OCT: low ? 3 : high ? 5 : 4,
        AURORA_OCT: low ? 2 : 3,
        AURORA_CURTAINS: low ? 2 : ultra ? 4 : 3,
        MW_OCT: low ? 3 : 4,
      },
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: true,
      transparent: false,
    });

    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'skyDome';
    scene.add(this.mesh);
  }

  update(dt: number, cameraPos: THREE.Vector3, sky: SkyState): void {
    // Recentre: the horizon must stay at eye level from 40 m or 7000 m up.
    this.mesh.position.copy(cameraPos);

    // Cirrus thickens as the sun approaches the horizon — partly physical
    // (the deck is only legible when lit edge-on) and mostly because that is
    // when it is worth looking at. Damped so setTime() scrubs smoothly.
    const lowSun = Math.exp(-Math.abs(Math.sin(sky.sunElevation)) * 5.2);
    this.cirrus = damp(this.cirrus, 0.30 + 0.70 * lowSun, 1.2, dt);
    this.own.uCirrus.value = clamp01(this.cirrus);

    // The moon walks its terminator slowly across the crossing, so the same
    // seed does not always show the same crescent.
    this.own.uMoonPhase.value = 0.17 + sky.t * 0.05;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
  }
}
