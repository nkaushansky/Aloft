import { FULL, GLOBALS } from './common';

export const VIEWRAY = /* glsl */ `
uniform vec4 uProj;      // tanX, tanY, near, far
uniform mat3 uCamRot;    // camera basis (right, up, back)
vec3 viewRay(vec2 uv){
  vec2 n = uv * 2.0 - 1.0;
  return uCamRot * vec3(n * uProj.xy, -1.0);
}
float linZ(float z){ return uProj.z * uProj.w / (uProj.w - z * (uProj.w - uProj.z)); }
`;

/** Sun-march over the heightmap: how high must you be, here, to see the sun? */
export const SHADOW_BAKE = /* glsl */ `
${FULL}
in vec2 vUv;
layout(location = 0) out vec2 o;
uniform float uMaxH;
void main(){
  vec2 xz = (vUv - 0.5) * 2.0 * uWorld.x;
  float h0 = texH(uHeightTex, vUv, uWorld.y);
  vec2 dir = normalize(uKeyDir.xz + vec2(1e-5));
  float tanE = uKeyDir.y / max(length(uKeyDir.xz), 1e-4);
  float ceilH = -200.0;
  float od = 0.0;
  float s = 10.0 + 8.0 * hash12(gl_FragCoord.xy);
  float n = uWorld.y;
  for (int i = 0; i < 58; i++){
    vec2 q = xz + dir * s;
    vec2 uv = q / (2.0 * uWorld.x) + 0.5;
    if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) break;
    float h = s < 160.0 ? texH(uHeightTex, uv, n) : texelFetch(uHeightTex, ivec2(uv * (n - 1.0)), 0).r;
    float c = h - s * tanE;
    if (c > ceilH){ ceilH = c; od = s; }
    if (uMaxH - s * tanE < h0 - 40.0 && s * tanE > 40.0 + uMaxH - h0) break;
    s = s * 1.085 + 6.0;
  }
  o = vec2(ceilH, od);
}
`;

export const COMPOSITE = /* glsl */ `
${FULL}
${VIEWRAY}
in vec2 vUv;
layout(location = 0) out vec4 o;
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tClouds, tCloudInfo;
uniform vec2 uCloudRes;
uniform float uCloudsOn;

vec3 stars(vec3 d){
  if (uStars < 0.01 || d.y < -0.02) return vec3(0.0);
  vec3 c = vec3(0.0);
  // three sheets of stars, the brightest the sparsest
  for (int k = 0; k < 3; k++){
    float s = 90.0 + float(k) * 85.0;
    vec3 ad = abs(d);
    vec2 uv; float face;
    if (ad.y >= ad.x && ad.y >= ad.z){ uv = d.xz / ad.y; face = d.y > 0.0 ? 1.0 : 2.0; }
    else if (ad.x >= ad.z){ uv = d.zy / ad.x; face = d.x > 0.0 ? 3.0 : 4.0; }
    else { uv = d.xy / ad.z; face = d.z > 0.0 ? 5.0 : 6.0; }
    vec2 g = uv * s;
    vec2 id = floor(g) + face * 131.0 + float(k) * 57.0;
    vec2 rnd = hash22(id);
    vec2 f = fract(g) - 0.5 - (rnd - 0.5) * 0.7;
    float b = hash12(id + 7.7);
    float thr = 0.955 - float(k) * 0.03;
    if (b > thr){
      float m = (b - thr) / (1.0 - thr);
      float tw = 0.75 + 0.25 * sin(uTime * (1.0 + rnd.x * 2.5) + rnd.y * 40.0);
      float r = length(f) * (1.0 - 0.25 * m);
      float st = exp(-r * r * 120.0) * (0.10 + 2.6 * m * m * m) * tw;
      vec3 tint = mix(vec3(1.0, 0.86, 0.72), vec3(0.75, 0.85, 1.0), rnd.x);
      c += st * tint * (k == 0 ? 1.2 : 0.55);
    }
  }
  // the long river of them
  vec3 ax = normalize(vec3(0.42, 0.5, 0.76));
  float band = dot(d, ax);
  vec2 q = vec2(atan(d.x, d.z) * 1.6, band * 2.4);
  float n = nz(q * 0.33).r * 0.6 + nz(q * 0.9 + 0.3).r * 0.4;
  float dust = smoothstep(0.38, 0.66, nz(q * 0.55 + vec2(0.2, 0.7)).r);
  float mw = exp(-band * band * 16.0) * smoothstep(0.25, 0.8, n) * (1.0 - 0.7 * dust * exp(-band * band * 60.0));
  c += mw * vec3(0.34, 0.38, 0.52) * 0.5;
  return c * uStars * smoothstep(-0.02, 0.22, d.y);
}

vec3 aurora(vec3 d){
  if (uAurora < 0.01 || d.y < 0.02) return vec3(0.0);
  vec3 acc = vec3(0.0);
  float j = hash12(gl_FragCoord.xy) * 0.9;
  for (int i = 0; i < 22; i++){
    float t = float(i) + j;
    float hgt = 0.75 + t * 0.035 + t * t * 0.0012;
    vec2 p = d.xz * (hgt / (d.y + 0.22));
    vec2 w = vec2(nz(p * 0.11 + uTime * 0.0035).r, nz(p * 0.11 + 0.5 - uTime * 0.003).r) - 0.5;
    p += w * 2.3;
    float r = nz(vec2(p.x * 0.045, p.y * 0.17) + vec2(0.0, uTime * 0.002)).r;
    float ribbon = 1.0 - smoothstep(0.0, 0.055, abs(r - 0.5));
    float rays = 0.55 + 0.45 * nz(vec2(p.x * 0.9 + uTime * 0.01, p.y * 0.22)).r * 1.6;
    float f = exp(-t * 0.12);
    vec3 col = mix(vec3(0.12, 1.0, 0.55), vec3(0.55, 0.25, 0.95), smoothstep(2.0, 17.0, t));
    acc += col * ribbon * rays * f;
  }
  return acc * 0.085 * uAurora * smoothstep(0.02, 0.25, d.y);
}

vec4 cirrus(vec3 d){
  if (uCirrus < 0.01 || d.y < 0.015) return vec4(0.0);
  vec2 p = uCamPos.xz * 0.12 + d.xz / (d.y + 0.06) * 2600.0;
  vec2 wd = normalize(uWind + vec2(1e-4));
  mat2 R = mat2(wd.x, -wd.y, wd.y, wd.x);
  vec2 q = R * p;
  q.x += uTime * 3.0;
  vec2 w = vec2(nz(q / 16000.0).r, nz(q / 16000.0 + 0.41).r) - 0.5;
  q += w * 1500.0;
  float a = nz(q / vec2(26000.0, 8200.0)).r;
  float b = nz(q / vec2(15000.0, 1500.0) + 0.2).r;
  float c = nz(q / vec2(5200.0, 620.0) + 0.6).r;
  float n = a * 0.52 + b * 0.33 + c * 0.15;
  float cov = mix(0.62, 0.43, uCirrus);
  float m = smoothstep(cov, cov + 0.3, n) * smoothstep(0.015, 0.2, d.y) * min(uCirrus * 1.6, 1.0);
  float mu = sat(dot(d, uSunDir));
  vec3 lit = mix(uMid, uHorizon, 0.4) * 0.9 + uSunCol * (0.16 + 0.5 * pow(mu, 8.0)) + uWarm * 0.35;
  return vec4(lit, m * 0.62);
}

vec3 fullSky(vec3 d){
  vec3 c = skyColor(d);
  c += stars(d);
  c += aurora(d);
  // moon
  if (uStars > 0.01){
    float mm = dot(d, uMoonDir);
    float r = acos(clamp(mm, -1.0, 1.0));
    float R = 0.021;
    if (r < R * 1.1){
      vec3 u = normalize(cross(uMoonDir, vec3(0.0, 1.0, 0.0)));
      vec3 v = cross(u, uMoonDir);
      vec2 q = vec2(dot(d, u), dot(d, v)) / R;
      float z = sqrt(max(0.0, 1.0 - dot(q, q)));
      float ph = sat(dot(vec3(q, z), normalize(vec3(-0.55, 0.18, 0.75))) * 1.6 + 0.06);
      float maria = 0.72 + 0.4 * nz(q * 0.19 + 0.3).r;
      float m = smoothstep(R, R * 0.93, r);
      c = mix(c, vec3(1.0, 0.97, 0.9) * 2.6 * ph * maria + c * 0.25, m * uStars);
    }
  }
  vec4 ci = cirrus(d);
  c = mix(c, ci.rgb, ci.a * mix(1.0, 0.35, uStars));
  // sun disc
  float mu = dot(d, uSunDir);
  float disc = smoothstep(0.99990, 0.99996, mu);
  c += uSunCol * disc * 26.0 * uHalo.w * (1.0 - ci.a * 0.6) * smoothstep(-0.03, 0.0, uSunDir.y + 0.02);
  return c;
}

void main(){
  float z = texture(tDepth, vUv).r;
  vec3 ray = viewRay(vUv);
  vec3 d = normalize(ray);
  vec3 c;
  float dist;
  if (z >= 0.9999999){
    c = fullSky(d);
    dist = 1e9;
  } else {
    vec3 wp = uCamPos + ray * linZ(z);
    c = texture(tColor, vUv).rgb;
    c = applyAir(c, wp);
    dist = length(wp - uCamPos);
  }
  if (uCloudsOn > 0.5){
    // depth-aware upsample of the cloud buffer
    vec2 tx = 1.0 / uCloudRes;
    vec2 p = vUv * uCloudRes - 0.5;
    vec2 f = fract(p);
    vec2 b = (floor(p) + 0.5) * tx;
    vec4 s00 = texture(tClouds, b);
    vec4 s10 = texture(tClouds, b + vec2(tx.x, 0.0));
    vec4 s01 = texture(tClouds, b + vec2(0.0, tx.y));
    vec4 s11 = texture(tClouds, b + tx);
    vec4 wz = vec4((1.0 - f.x) * (1.0 - f.y), f.x * (1.0 - f.y), (1.0 - f.x) * f.y, f.x * f.y);
    vec4 dz = vec4(texture(tCloudInfo, b).g, texture(tCloudInfo, b + vec2(tx.x, 0.0)).g, texture(tCloudInfo, b + vec2(0.0, tx.y)).g, texture(tCloudInfo, b + tx).g);
    float dd = min(dist, 1e6);
    if (d.y < -1e-4) { float tw = -uCamPos.y / d.y; if (tw > 0.0) dd = min(dd, tw); }
    vec4 sim = 1.0 / (0.02 + abs(min(dz, vec4(30000.0)) - min(dd, 30000.0)) / max(dd, 30.0));
    wz *= sim * sim;
    wz /= dot(wz, vec4(1.0)) + 1e-6;
    vec4 cl = s00 * wz.x + s10 * wz.y + s01 * wz.z + s11 * wz.w;
    // what is close is seen through clear air
    float nearK = smoothstep(14.0, 120.0, dist);
    cl = mix(vec4(0.0, 0.0, 0.0, 1.0), cl, nearK);
    c = c * cl.a + cl.rgb;
  }
  o = vec4(max(c, vec3(0.0)), 1.0);
}
`;

export const COPY = /* glsl */ `
precision highp float;
in vec2 vUv;
uniform sampler2D tColor;
layout(location = 0) out vec4 o;
void main(){ o = vec4(texture(tColor, vUv).rgb, 1.0); }
`;

export const BLOOM_DOWN = /* glsl */ `
precision highp float;
in vec2 vUv;
uniform sampler2D tColor;
uniform vec2 uTexel;
uniform float uFirst;
layout(location = 0) out vec4 o;
vec3 s(vec2 uv){
  vec3 c = min(texture(tColor, uv).rgb, vec3(60.0));
  return c;
}
vec3 kar(vec3 c){ return c / (1.0 + max(c.r, max(c.g, c.b)) * uFirst * 0.35); }
void main(){
  vec2 t = uTexel;
  vec3 a = s(vUv + t * vec2(-2, 2)), b = s(vUv + t * vec2(0, 2)), c = s(vUv + t * vec2(2, 2));
  vec3 d = s(vUv + t * vec2(-2, 0)), e = s(vUv), f = s(vUv + t * vec2(2, 0));
  vec3 g = s(vUv + t * vec2(-2, -2)), h = s(vUv + t * vec2(0, -2)), i = s(vUv + t * vec2(2, -2));
  vec3 j = s(vUv + t * vec2(-1, 1)), k = s(vUv + t * vec2(1, 1)), l = s(vUv + t * vec2(-1, -1)), m = s(vUv + t * vec2(1, -1));
  vec3 r = kar((a + b + d + e) * 0.25) * 0.125 + kar((b + c + e + f) * 0.25) * 0.125
         + kar((d + e + g + h) * 0.25) * 0.125 + kar((e + f + h + i) * 0.25) * 0.125
         + kar((j + k + l + m) * 0.25) * 0.5;
  if (uFirst > 0.5){
    float br = max(r.r, max(r.g, r.b));
    r *= smoothstep(0.7, 2.6, br) * 0.9 + 0.1;
  }
  o = vec4(r, 1.0);
}
`;

export const BLOOM_UP = /* glsl */ `
precision highp float;
in vec2 vUv;
uniform sampler2D tColor;
uniform sampler2D tBase;
uniform vec2 uTexel;
uniform float uMix;
layout(location = 0) out vec4 o;
void main(){
  vec2 t = uTexel;
  vec3 r = texture(tColor, vUv).rgb * 4.0;
  r += (texture(tColor, vUv + vec2(t.x, 0)).rgb + texture(tColor, vUv - vec2(t.x, 0)).rgb + texture(tColor, vUv + vec2(0, t.y)).rgb + texture(tColor, vUv - vec2(0, t.y)).rgb) * 2.0;
  r += texture(tColor, vUv + t).rgb + texture(tColor, vUv - t).rgb + texture(tColor, vUv + vec2(t.x, -t.y)).rgb + texture(tColor, vUv + vec2(-t.x, t.y)).rgb;
  o = vec4(mix(texture(tBase, vUv).rgb, r / 16.0, uMix), 1.0);
}
`;

export const GRADE = /* glsl */ `
${GLOBALS}
in vec2 vUv;
uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform float uExp, uSat, uCon, uBloom, uVig, uFade, uPainterly;
uniform vec3 uLo, uHi, uFadeCol;
uniform vec2 uTexel;
layout(location = 0) out vec4 o;

// AgX (Troy Sobotka), polynomial fit by Benjamin Wrensch
vec3 agxC(vec3 x){
  vec3 x2 = x * x; vec3 x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agx(vec3 v){
  const mat3 m = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051, 0.0784335999999992, 0.878468636469772, 0.0784336, 0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  const float mn = -12.47393, mx = 4.026069;
  v = m * v;
  v = clamp(log2(max(v, 1e-10)), mn, mx);
  v = (v - mn) / (mx - mn);
  return agxC(v);
}
vec3 agxEotf(vec3 v){
  const mat3 m = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438, -0.0980208811401368, 1.15190312990417, -0.0980434501171241, -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  v = m * v;
  return max(v, vec3(0.0));
}
vec3 kuwahara(vec2 uv){
  // a light four-quadrant smear: colour settles into strokes, edges survive
  vec3 m[4]; vec3 s[4];
  for (int k = 0; k < 4; k++){ m[k] = vec3(0.0); s[k] = vec3(0.0); }
  for (int j = 0; j <= 2; j++) for (int i = 0; i <= 2; i++){
    vec2 q = vec2(float(i), float(j)) * uTexel * 1.1;
    vec3 c;
    c = min(texture(tColor, uv + vec2(-q.x, -q.y)).rgb, vec3(8.0)); m[0] += c; s[0] += c * c;
    c = min(texture(tColor, uv + vec2( q.x, -q.y)).rgb, vec3(8.0)); m[1] += c; s[1] += c * c;
    c = min(texture(tColor, uv + vec2( q.x,  q.y)).rgb, vec3(8.0)); m[2] += c; s[2] += c * c;
    c = min(texture(tColor, uv + vec2(-q.x,  q.y)).rgb, vec3(8.0)); m[3] += c; s[3] += c * c;
  }
  vec3 acc = vec3(0.0); float w = 0.0;
  for (int k = 0; k < 4; k++){
    m[k] /= 9.0; s[k] = abs(s[k] / 9.0 - m[k] * m[k]);
    float v = (s[k].r + s[k].g + s[k].b);
    float a = 1.0 / (1.0 + pow(v * 900.0, 2.0));
    acc += m[k] * a; w += a;
  }
  return acc / w;
}
void main(){
  vec3 c = texture(tColor, vUv).rgb;
  if (uPainterly > 0.01) c = mix(c, kuwahara(vUv), uPainterly);
  vec3 bl = texture(tBloom, vUv).rgb;
  c = mix(c, bl, uBloom);
  c *= uExp;
  vec2 q = vUv - 0.5;
  float v = 1.0 - uVig * smoothstep(0.25, 0.85, length(q * vec2(1.15, 1.0)));
  c *= v;
  c = agx(c);
  // grade in display-log space: split tone, contrast, saturation
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c += (uLo - 0.5) * 0.30 * (1.0 - smoothstep(0.0, 0.6, l));
  c += (uHi - 0.5) * 0.26 * smoothstep(0.3, 0.95, l);
  c = (c - 0.47) * uCon * 1.1 + 0.47;
  l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSat * 1.1);
  c = agxEotf(c);
  // agx output is display-encoded already (2.2); keep it there
  c = mix(c, uFadeCol, uFade);
  float g = hash12(gl_FragCoord.xy + fract(uTime) * 61.7) - 0.5;
  c += g * 0.010;
  o = vec4(sat(c), 1.0);
}
`;

export const FXAA = /* glsl */ `
precision highp float;
in vec2 vUv;
uniform sampler2D tColor;
uniform vec2 uTexel;
uniform float uSharp;
layout(location = 0) out vec4 o;
float L(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
void main(){
  vec2 t = uTexel;
  vec3 m = texture(tColor, vUv).rgb;
  vec3 nw = texture(tColor, vUv + t * vec2(-1, -1)).rgb, ne = texture(tColor, vUv + t * vec2(1, -1)).rgb;
  vec3 sw = texture(tColor, vUv + t * vec2(-1, 1)).rgb, se = texture(tColor, vUv + t * vec2(1, 1)).rgb;
  float lm = L(m), a = L(nw), b = L(ne), c = L(sw), d = L(se);
  float mn = min(lm, min(min(a, b), min(c, d))), mx = max(lm, max(max(a, b), max(c, d)));
  vec3 r = m;
  if (mx - mn > max(0.05, mx * 0.11)){
    vec2 dir = vec2(-((a + b) - (c + d)), (a + c) - (b + d));
    float red = max((a + b + c + d) * 0.03125, 0.0078125);
    float inv = 1.0 / (min(abs(dir.x), abs(dir.y)) + red);
    dir = clamp(dir * inv, -6.0, 6.0) * t;
    vec3 A = 0.5 * (texture(tColor, vUv + dir * (1.0 / 3.0 - 0.5)).rgb + texture(tColor, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
    vec3 B = A * 0.5 + 0.25 * (texture(tColor, vUv - dir * 0.5).rgb + texture(tColor, vUv + dir * 0.5).rgb);
    float lb = L(B);
    r = (lb < mn || lb > mx) ? A : B;
  }
  // gentle sharpen to recover what upscaling softens
  vec3 blur = (nw + ne + sw + se) * 0.25;
  r += (r - blur) * uSharp;
  o = vec4(clamp(r, 0.0, 1.0), 1.0);
}
`;
