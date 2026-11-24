import * as THREE from 'three';

/**
 * One shared uniform block. Every material spreads this object, so each
 * `{ value }` is the same reference everywhere — set once, seen by all.
 */
export const G = {
  uTime: { value: 0 },
  uCamPos: { value: new THREE.Vector3() },
  uRes: { value: new THREE.Vector2(1, 1) },
  uSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uSunCol: { value: new THREE.Color(1, 1, 1) },
  uKeyDir: { value: new THREE.Vector3(0, 1, 0) },
  uKeyCol: { value: new THREE.Color(1, 1, 1) },
  uMoonDir: { value: new THREE.Vector3(0, 1, 0) },
  uZenith: { value: new THREE.Color() },
  uMid: { value: new THREE.Color() },
  uHorizon: { value: new THREE.Color() },
  uWarm: { value: new THREE.Color() },
  uAnti: { value: new THREE.Color() },
  uAmbSky: { value: new THREE.Color() },
  uAmbGnd: { value: new THREE.Color() },
  uFog: { value: new THREE.Vector4(0.0001, 0.002, 0, 1) },
  uMist: { value: new THREE.Vector4(0, 40, 30, 0) },
  uHalo: { value: new THREE.Vector4(0.2, 0.4, 2, 1) },
  uStars: { value: 0 },
  uAurora: { value: 0 },
  uCirrus: { value: 0.5 },
  uWind: { value: new THREE.Vector2(0, -6) },
  uGust: { value: 1 },
  uNoise: { value: null as THREE.Texture | null },
  uHeightTex: { value: null as THREE.Texture | null },
  uNormalTex: { value: null as THREE.Texture | null },
  uMaskTex: { value: null as THREE.Texture | null },
  uFarTex: { value: null as THREE.Texture | null },
  uFarNrm: { value: null as THREE.Texture | null },
  uShadowTex: { value: null as THREE.Texture | null },
  uWeather: { value: null as THREE.Texture | null },
  uWorld: { value: new THREE.Vector4(8192, 2048, 32768, 512) },
  uCloud: { value: new THREE.Vector4(700, 1500, 0.5, 1) },
  uCloudOff: { value: new THREE.Vector2(0, 0) },
  uCloudShadow: { value: 0.6 },
  uWeatherHalf: { value: 16384 },
  uCsm: { value: null as THREE.Texture | null },
  uCsmMat: { value: new THREE.Matrix4() },
  uCsmInfo: { value: new THREE.Vector4(1 / 2048, 200, 0, 0) },
  uBirdPos: { value: new THREE.Vector4(0, 0, 0, 5) },
};

export type Uniforms = Record<string, THREE.IUniform>;

/** Build a ShaderMaterial bound to the shared world. */
export function worldMaterial(
  vert: string,
  frag: string,
  uniforms: Uniforms = {},
  opts: Partial<THREE.ShaderMaterialParameters> = {},
): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: { ...G, ...uniforms },
    ...opts,
  });
}
