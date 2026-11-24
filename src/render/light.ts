import * as THREE from 'three';
import { G } from './globals';

/**
 * A color script, like a film's: each land is a handful of painted moments
 * along the journey, and the frame is always somewhere between two of them.
 * Position in the script follows *distance flown*, not a clock — the day
 * waits for you.
 */
export interface Key {
  p: number;
  /** azimuth relative to travel (deg, + = right), elevation (deg) */
  sun: [number, number];
  sunCol: string;
  sunI: number;
  key: string;
  keyI: number;
  zen: string;
  mid: string;
  hor: string;
  warm: string;
  anti: string;
  skyI: number;
  ambS: string;
  ambG: string;
  ambI: number;
  /** density per km, e-fold height (m), base height, inscatter gain */
  fog: [number, number, number, number];
  /** ground mist: density per km, top height */
  mist: [number, number];
  /** halo lobes: wide, mid, tight */
  halo: [number, number, number];
  cover: number;
  cloudShadow?: number;
  cirrus?: number;
  stars?: number;
  aurora?: number;
  exp: number;
  sat?: number;
  con?: number;
  /** grade: shadow tint and highlight tint */
  lo?: string;
  hi?: string;
  /** moon azimuth/elevation if it matters */
  moon?: [number, number];
  /** key light comes from the moon instead of the sun (0..1) */
  moonlit?: number;
  wind?: [number, number];
}

export interface Frame {
  exp: number;
  sat: number;
  con: number;
  lo: THREE.Color;
  hi: THREE.Color;
  cover: number;
  sunEl: number;
  stars: number;
}

/** scene-referred balance between painted sky and lit ground */
const KEY_GAIN = 0.46;
const AMB_GAIN = 0.62;

const c0 = new THREE.Color();
const c1 = new THREE.Color();
const mixHex = (a: string, b: string, t: number, k: number, out: THREE.Color) => {
  c0.set(a);
  c1.set(b);
  out.copy(c0).lerp(c1, t).multiplyScalar(k);
};
const L = (a: number, b: number, t: number) => a + (b - a) * t;

export function dirFromAzEl(azDeg: number, elDeg: number, out: THREE.Vector3): THREE.Vector3 {
  const a = (azDeg * Math.PI) / 180;
  const e = (elDeg * Math.PI) / 180;
  // az 0 = straight ahead (-Z), + = right (+X)
  return out.set(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
}

const sunV = new THREE.Vector3();
const moonV = new THREE.Vector3();

/** 0..1: pulls any land down into one shared night (used while sleeping). */
const NIGHT = {
  zen: new THREE.Color('#040a1c'),
  mid: new THREE.Color('#0a1632'),
  hor: new THREE.Color('#1c2e4e'),
  warm: new THREE.Color('#1c2e4e'),
  key: new THREE.Color('#9cb8f0'),
  ambS: new THREE.Color('#304c8c'),
  ambG: new THREE.Color('#16243c'),
};

export function applyLight(keys: Key[], p: number, frame: Frame, night = 0): void {
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].p <= p) i++;
  const a = keys[i];
  const b = keys[Math.min(i + 1, keys.length - 1)];
  let t = b.p > a.p ? (p - a.p) / (b.p - a.p) : 0;
  t = Math.max(0, Math.min(1, t));
  t = t * t * (3 - 2 * t) * 0.6 + t * 0.4;

  const az = L(a.sun[0], b.sun[0], t);
  const el = L(a.sun[1], b.sun[1], t);
  dirFromAzEl(az, el, sunV);
  G.uSunDir.value.copy(sunV);
  const ma = a.moon ?? [-40, 30];
  const mb = b.moon ?? ma;
  dirFromAzEl(L(ma[0], mb[0], t), L(ma[1], mb[1], t), moonV);
  G.uMoonDir.value.copy(moonV);

  const ml = L(a.moonlit ?? 0, b.moonlit ?? 0, t);
  // the key light never drops below a grazing angle, so shadows stay long but sane
  const kd = G.uKeyDir.value;
  kd.copy(sunV);
  kd.y = Math.max(kd.y, 0.035);
  kd.normalize();
  if (ml > 0) kd.lerp(moonV, ml).normalize();

  mixHex(a.sunCol, b.sunCol, t, L(a.sunI, b.sunI, t), G.uSunCol.value);
  mixHex(a.key, b.key, t, L(a.keyI, b.keyI, t) * KEY_GAIN, G.uKeyCol.value);
  const si = L(a.skyI, b.skyI, t);
  mixHex(a.zen, b.zen, t, si, G.uZenith.value);
  mixHex(a.mid, b.mid, t, si, G.uMid.value);
  mixHex(a.hor, b.hor, t, si, G.uHorizon.value);
  mixHex(a.warm, b.warm, t, si, G.uWarm.value);
  mixHex(a.anti, b.anti, t, si, G.uAnti.value);
  const ai = L(a.ambI, b.ambI, t) * AMB_GAIN;
  mixHex(a.ambS, b.ambS, t, ai, G.uAmbSky.value);
  mixHex(a.ambG, b.ambG, t, ai, G.uAmbGnd.value);
  G.uFog.value.set(
    L(a.fog[0], b.fog[0], t) / 1000,
    1 / L(a.fog[1], b.fog[1], t),
    L(a.fog[2], b.fog[2], t),
    L(a.fog[3], b.fog[3], t),
  );
  G.uMist.value.set(L(a.mist[0], b.mist[0], t) / 1000, L(a.mist[1], b.mist[1], t), 0.5, 1);
  G.uHalo.value.set(L(a.halo[0], b.halo[0], t), L(a.halo[1], b.halo[1], t), L(a.halo[2], b.halo[2], t), 1);
  G.uStars.value = L(a.stars ?? 0, b.stars ?? 0, t);
  G.uAurora.value = L(a.aurora ?? 0, b.aurora ?? 0, t);
  G.uCirrus.value = L(a.cirrus ?? 0.4, b.cirrus ?? 0.4, t);
  G.uCloudShadow.value = L(a.cloudShadow ?? 0.55, b.cloudShadow ?? 0.55, t);
  const wa = a.wind ?? [0, -6];
  const wb = b.wind ?? wa;
  G.uWind.value.set(L(wa[0], wb[0], t), L(wa[1], wb[1], t));
  frame.cover = L(a.cover, b.cover, t);
  G.uCloud.value.z = frame.cover;
  frame.exp = L(a.exp, b.exp, t);
  frame.sat = L(a.sat ?? 1, b.sat ?? 1, t);
  frame.con = L(a.con ?? 1, b.con ?? 1, t);
  mixHex(a.lo ?? '#808080', b.lo ?? '#808080', t, 1, frame.lo);
  mixHex(a.hi ?? '#808080', b.hi ?? '#808080', t, 1, frame.hi);
  frame.sunEl = el;
  if (night > 0) {
    const n = night;
    G.uZenith.value.lerp(NIGHT.zen, n);
    G.uMid.value.lerp(NIGHT.mid, n);
    G.uHorizon.value.lerp(NIGHT.hor, n);
    G.uWarm.value.lerp(NIGHT.warm, n);
    G.uAnti.value.lerp(NIGHT.mid, n);
    G.uSunCol.value.multiplyScalar(1 - n);
    c0.copy(NIGHT.key).multiplyScalar(1.0 * KEY_GAIN);
    G.uKeyCol.value.lerp(c0, n);
    c0.copy(NIGHT.ambS).multiplyScalar(0.5 * AMB_GAIN);
    G.uAmbSky.value.lerp(c0, n);
    c0.copy(NIGHT.ambG).multiplyScalar(0.5 * AMB_GAIN);
    G.uAmbGnd.value.lerp(c0, n);
    G.uStars.value = L(G.uStars.value, 1.1, n);
    dirFromAzEl(-30 + 40 * n, 30, moonV);
    G.uMoonDir.value.lerp(moonV, n).normalize();
    G.uKeyDir.value.lerp(moonV, n).normalize();
    frame.exp = L(frame.exp, 1.45, n);
    G.uCirrus.value *= 1 - 0.7 * n;
  }
  frame.stars = G.uStars.value;
}

export function makeFrame(): Frame {
  return {
    exp: 1,
    sat: 1,
    con: 1,
    lo: new THREE.Color('#808080'),
    hi: new THREE.Color('#808080'),
    cover: 0.5,
    sunEl: 20,
    stars: 0,
  };
}
