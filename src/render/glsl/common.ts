/**
 * Shared GLSL. Every surface in the world — terrain, feather, leaf, water,
 * cloud — reads the same light and the same air from these functions, so the
 * whole frame always belongs to one moment of one day.
 */
export const GLOBALS = /* glsl */ `
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
precision highp sampler2DShadow;

uniform float uTime;
uniform vec3 uCamPos;
uniform vec2 uRes;            // render resolution (px)
uniform vec3 uSunDir;
uniform vec3 uSunCol;         // sun disc / halo colour
uniform vec3 uKeyDir;         // dominant light: sun, or moon at night
uniform vec3 uKeyCol;
uniform vec3 uMoonDir;
uniform vec3 uZenith;
uniform vec3 uMid;
uniform vec3 uHorizon;
uniform vec3 uWarm;
uniform vec3 uAnti;
uniform vec3 uAmbSky;
uniform vec3 uAmbGnd;
uniform vec4 uFog;            // density/m, height falloff/m, base height, inscatter gain
uniform vec4 uMist;           // density, top height, softness, noise
uniform vec4 uHalo;           // wide, mid, tight, disc
uniform float uStars;
uniform float uAurora;
uniform float uCirrus;
uniform vec2 uWind;           // m/s, direction it travels toward (x,z)
uniform float uGust;

uniform sampler2D uNoise;     // R fbm, G cells, B brush dabs, A white
uniform sampler2D uHeightTex;
uniform sampler2D uNormalTex;
uniform sampler2D uMaskTex;
uniform sampler2D uFarTex;
uniform sampler2D uFarNrm;
uniform sampler2D uShadowTex; // R: shadow ceiling (m), G: occluder distance
uniform sampler2D uWeather;   // R coverage, G height, B rain, A soft coverage
uniform vec4 uWorld;          // half, hn, farHalf, fn
uniform vec4 uCloud;          // base, top, coverage, density
uniform vec2 uCloudOff;       // weather scroll (m)
uniform float uCloudShadow;
uniform float uWeatherHalf;

uniform sampler2DShadow uCsm;
uniform mat4 uCsmMat;
uniform vec4 uCsmInfo;        // texel, radius, enabled, 0
uniform vec4 uBirdPos;        // xyz, wingspan — for the soft shadow that tells you your height

#define PI 3.14159265359
#define sat(x) clamp(x, 0.0, 1.0)

float hash11(float p){ p = fract(p * .1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * vec3(.1031, .1030, .0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
float lum(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec4 nz(vec2 p){ return texture(uNoise, p); }
`;

export const SKY = /* glsl */ `
// The sky is a painted gradient with physical manners: warm toward the sun,
// a blush opposite it, light pooling along the horizon.
vec3 skyBase(vec3 d){
  float h = max(d.y, 0.0);
  float t1 = 1.0 - exp(-h * 6.5);
  float t2 = 1.0 - exp(-h * 1.55);
  vec3 c = mix(uHorizon, uMid, t1);
  c = mix(c, uZenith, t2 * t2 * 0.6 + t2 * 0.4);
  vec2 dz = normalize(d.xz + vec2(1e-5));
  vec2 sz = normalize(uSunDir.xz + vec2(1e-5));
  float az = 0.5 + 0.5 * dot(dz, sz);
  float low = exp(-h * 5.2);
  float warm = az * az * az;
  c = mix(c, uWarm, sat(warm * low * 0.92));
  float belt = exp(-pow((h - 0.10) / 0.10, 2.0)) * pow(1.0 - az, 1.6);
  c = mix(c, uAnti, sat(belt * 0.85));
  return c;
}
vec3 skyHalo(vec3 d, float cap){
  float mu = max(dot(d, uSunDir), 0.0);
  float up = smoothstep(-0.12, 0.02, uSunDir.y);
  vec3 g = uSunCol * (uHalo.x * pow(mu, 6.0) + uHalo.y * pow(mu, 44.0) + uHalo.z * min(pow(mu, 420.0), cap));
  float mm = max(dot(d, uMoonDir), 0.0);
  g += vec3(0.55, 0.7, 1.0) * uStars * (0.045 * pow(mm, 18.0) + 0.16 * pow(mm, 260.0));
  return g * mix(0.25, 1.0, up);
}
vec3 skyColor(vec3 d){
  vec3 c = skyBase(d) + skyHalo(d, 1.0);
  // below the horizon the air simply thickens
  c *= mix(1.0, 0.82, smoothstep(0.0, -0.5, d.y));
  return c;
}
// what the air itself looks like along a ray — always horizon-tinted, never spiky
vec3 airColor(vec3 d){
  vec3 q = normalize(vec3(d.x, max(d.y * 0.35, 0.0) + 0.015, d.z));
  return (skyBase(q) + skyHalo(q, 0.0) * 0.55) * uFog.w;
}
`;

export const ATMOS = /* glsl */ `
float fogDepth(vec3 a, vec3 b){
  // analytic exponential height fog between two points
  vec3 v = b - a;
  float len = length(v);
  float dy = v.y;
  float ha = max(a.y - uFog.z, -60.0);
  float k = uFog.y;
  float t = k * dy;
  float f = abs(t) > 1e-3 ? (1.0 - exp(-clamp(t, -40.0, 40.0))) / t : 1.0 - 0.5 * t;
  return uFog.x * exp(-k * ha) * len * f;
}
vec3 fogT(vec3 a, vec3 b){
  float od = fogDepth(a, b) + length(b - a) * uFog.x * 0.16;
  return exp(-od * vec3(0.72, 0.92, 1.22));
}
vec3 applyAir(vec3 col, vec3 wp){
  vec3 T = fogT(uCamPos, wp);
  vec3 d = normalize(wp - uCamPos);
  return col * T + airColor(d) * (1.0 - T);
}
`;

export const TERRAIN_SAMPLE = /* glsl */ `
float texH(sampler2D t, vec2 uv, float n){
  vec2 p = clamp(uv, 0.0, 1.0) * (n - 1.0);
  ivec2 i = ivec2(min(floor(p), vec2(n - 2.0)));
  vec2 f = p - vec2(i);
  float a = texelFetch(t, i, 0).r;
  float b = texelFetch(t, i + ivec2(1, 0), 0).r;
  float c = texelFetch(t, i + ivec2(0, 1), 0).r;
  float d = texelFetch(t, i + ivec2(1, 1), 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float coreW(vec2 xz){
  float e = max(abs(xz.x), abs(xz.y));
  return 1.0 - smoothstep(uWorld.x * 0.95, uWorld.x * 0.992, e);
}
float terrainH(vec2 xz){
  float w = coreW(xz);
  float h = 0.0;
  if (w > 0.0) h += w * texH(uHeightTex, xz / (2.0 * uWorld.x) + 0.5, uWorld.y);
  if (w < 1.0) h += (1.0 - w) * texH(uFarTex, xz / (2.0 * uWorld.z) + 0.5, uWorld.w);
  return h;
}
`;

export const SHADOWS = /* glsl */ `
float terrainShadow(vec3 wp){
  vec2 uv = wp.xz / (2.0 * uWorld.x) + 0.5;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1.0;
  vec2 s = texture(uShadowTex, uv).rg;
  float w = 1.5 + s.g * 0.012;
  return smoothstep(-w, w, wp.y - s.r + 0.6);
}
float cloudShadowAt(vec3 wp){
  if (uCloudShadow <= 0.0) return 1.0;
  float el = max(uKeyDir.y, 0.16);
  vec2 p = wp.xz + uKeyDir.xz / el * max(uCloud.x + 120.0 - wp.y, 0.0);
  float c = texture(uWeather, (p + uCloudOff) / (2.0 * uWeatherHalf) + 0.5).a;
  float above = smoothstep(uCloud.y, uCloud.x, wp.y);
  return 1.0 - uCloudShadow * smoothstep(0.12, 0.7, c) * above;
}
float csmShadow(vec3 wp, float bias){
  if (uCsmInfo.z < 0.5) return 1.0;
  vec4 q = uCsmMat * vec4(wp, 1.0);
  vec3 p = q.xyz * 0.5 + 0.5;
  vec2 e = abs(p.xy - 0.5) * 2.0;
  float m = max(e.x, e.y);
  if (m > 1.0 || p.z > 1.0) return 1.0;
  float t = uCsmInfo.x;
  float s = 0.0;
  p.z -= bias;
  s += texture(uCsm, vec3(p.xy + vec2(-0.5, -1.2) * t, p.z));
  s += texture(uCsm, vec3(p.xy + vec2(1.2, -0.5) * t, p.z));
  s += texture(uCsm, vec3(p.xy + vec2(0.5, 1.2) * t, p.z));
  s += texture(uCsm, vec3(p.xy + vec2(-1.2, 0.5) * t, p.z));
  s += texture(uCsm, p);
  return mix(s * 0.2, 1.0, smoothstep(0.8, 1.0, m));
}
float birdShadow(vec3 wp){
  // a soft winged smudge beneath the crane, projected along the light
  float el = max(uKeyDir.y, 0.22);
  vec3 b = uBirdPos.xyz;
  float dh = b.y - wp.y;
  if (dh < 0.0 || dh > 160.0) return 1.0;
  vec2 p = wp.xz - (b.xz - uKeyDir.xz / el * dh);
  float r = uBirdPos.w * (0.42 + dh * 0.018);
  return 1.0 - 0.5 * exp(-dot(p, p) / (r * r)) * (1.0 - smoothstep(60.0, 160.0, dh));
}
float keyShadow(vec3 wp, float bias){
  return terrainShadow(wp) * cloudShadowAt(wp) * csmShadow(wp, bias);
}
`;

export const LIGHT = /* glsl */ `
vec3 ambient(vec3 N, float ao){
  vec3 a = mix(uAmbGnd, uAmbSky, sat(N.y * 0.5 + 0.5));
  // the bright side of the sky lends its colour
  vec3 w = normalize(vec3(uSunDir.x, 0.25, uSunDir.z));
  a += uWarm * 0.16 * sat(dot(N, w) * 0.5 + 0.5) * uFog.w;
  return a * ao;
}
vec3 litSurface(vec3 albedo, vec3 N, vec3 V, float ao, float sh, float wrap){
  float nl = sat((dot(N, uKeyDir) + wrap) / (1.0 + wrap));
  return albedo * (uKeyCol * nl * sh + ambient(N, ao));
}
`;

export const FULL = GLOBALS + SKY + ATMOS + TERRAIN_SAMPLE + SHADOWS + LIGHT;

export const FSQ_VERT = /* glsl */ `
out vec2 vUv;
void main(){ vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
