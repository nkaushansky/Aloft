/**
 * The six movements: everything art-directed about each land — its paint,
 * its color script, its weather, its words. Geography lives in world/lands.
 */
import type { Key } from '../render/light';
import type { GroundStyle } from '../render/terrainMesh';
import type { WeatherSpec, Puff } from '../render/clouds';
import type { LandId } from '../world/lands';
import { Route, makeRng } from '../world/noise';
import type { Thermal } from '../sim/air';

export interface TreeKind {
  /** which builder */
  form: 'birch' | 'broadleaf' | 'conifer' | 'juniper' | 'willow' | 'acacia' | 'palm' | 'pine';
  weight: number;
  size: [number, number];
  leaf: [string, string, string];
  bark: string;
}

export interface Movement {
  id: LandId;
  numeral: string;
  title: string;
  /** shown as the flight begins */
  opening: string[];
  /** shown once the bird is down for the night */
  closing: string[];
  style: GroundStyle;
  trees: TreeKind[];
  /** average spacing between trees in full forest (m) */
  treeGap: number;
  grass: { tall: number; colorA: string; colorB: string; tip: string; flowers: string[] };
  water: { deep: string; shallow: string; clarity: number; chop: number; swell: number; glow: string; glowAmt: number };
  keys: Key[];
  weather(route: Route, thermals: Thermal[], seed: number): WeatherSpec;
  /** upward air: how many thermals, and their character */
  air: { thermals: number; strength: number; radius: number; top: number; ridge: number; glass: number };
  /** launch altitude above ground when flight starts airborne (free flight) */
  motes: { kind: 'pollen' | 'leaves' | 'snow' | 'dust' | 'spray' | 'down'; color: string; amount: number };
  /** where the plumage has got to, 0 (first rust) .. 1 (white) */
  age: number;
  /** music: root midi, mode intervals, bpm-ish breath */
  music: { root: number; scale: number[]; pace: number; color: 'glass' | 'wood' | 'bell' | 'brass' | 'deep' | 'choir' };
}

const thermalPuffs = (ts: Thermal[], r: number, tall: number, amt: number, rng: () => number): Puff[] => {
  const out: Puff[] = [];
  for (const t of ts) {
    out.push({ x: t.x, z: t.z, r: r * (0.85 + rng() * 0.4), tall: tall * (0.8 + rng() * 0.4), amt });
    out.push({ x: t.x + (rng() - 0.5) * r * 1.5, z: t.z + (rng() - 0.5) * r * 1.5, r: r * 0.6, tall: tall * 0.6, amt: amt * 0.9 });
  }
  return out;
};

const scatterPuffs = (rng: () => number, n: number, spread: number, r: [number, number], tall: [number, number], amt: number): Puff[] => {
  const out: Puff[] = [];
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2;
    const d = Math.sqrt(0.06 + rng() * 0.94) * spread;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const R = r[0] + rng() * (r[1] - r[0]);
    const T = tall[0] + rng() * (tall[1] - tall[0]);
    const k = 2 + Math.floor(rng() * 3);
    for (let j = 0; j < k; j++) {
      out.push({ x: x + (rng() - 0.5) * R * 1.8, z: z + (rng() - 0.5) * R * 1.4, r: R * (0.55 + rng() * 0.5), tall: T * (0.6 + rng() * 0.5), amt });
    }
  }
  return out;
};

export const MOVEMENTS: Record<LandId, Movement> = {
  // ------------------------------------------------------------------ I
  stillmere: {
    id: 'stillmere',
    numeral: 'I',
    title: 'Stillmere',
    opening: ['They left while you were sleeping.'],
    closing: ['One day behind.', 'The water does not mind.'],
    style: {
      grassA: '#7f8a44', grassB: '#a59a4e', dry: '#b89a5c', forestA: '#4c6136', forestB: '#8a7c36', forestC: '#b8862f',
      rockA: '#7d7a72', rockB: '#9a9488', sand: '#a6936c', mud: '#4b4232', snow: '#ffffff', canopy: 9, strata: 0, sheen: 1,
    },
    trees: [
      { form: 'birch', weight: 0.62, size: [9, 15], leaf: ['#c79a33', '#a9892f', '#d9b245'], bark: '#d8d2c4' },
      { form: 'conifer', weight: 0.26, size: [10, 17], leaf: ['#38502f', '#2f4630', '#4d5f36'], bark: '#584636' },
      { form: 'willow', weight: 0.12, size: [7, 10], leaf: ['#8f9a4a', '#7b8a40', '#a8a552'], bark: '#6a5c48' },
    ],
    treeGap: 8.5,
    grass: { tall: 1.25, colorA: '#6f7a3a', colorB: '#9a8f48', tip: '#d8c27a', flowers: ['#efe9d0', '#d9b6c8'] },
    water: { deep: '#16303a', shallow: '#4a5a48', clarity: 3.2, chop: 0.28, swell: 0, glow: '#000000', glowAmt: 0 },
    keys: [
      { p: 0.0, sun: [-38, 0.6], sunCol: '#ff9a5c', sunI: 1.1, key: '#ff9c66', keyI: 1.1, zen: '#3a5f96', mid: '#8fb0cf', hor: '#f4cdb4', warm: '#ff9d6e', anti: '#cfa9c2', skyI: 0.72, ambS: '#8fa6cc', ambG: '#6f6a70', ambI: 0.62, fog: [0.16, 130, 0, 1.0], mist: [1.5, 46], halo: [0.2, 0.5, 2.6], cover: 0.4, cirrus: 0.75, exp: 1.0, sat: 1.08, con: 1.02, lo: '#7a7f92', hi: '#8c8078', cloudShadow: 0.3, wind: [0.8, -3.2], stars: 0.06 },
      { p: 0.12, sun: [-34, 4.5], sunCol: '#ffb070', sunI: 1.5, key: '#ffb37c', keyI: 2.3, zen: '#4076b4', mid: '#97bcd8', hor: '#fbd9b4', warm: '#ffb27a', anti: '#d2b4c4', skyI: 0.86, ambS: '#93aed2', ambG: '#7d7668', ambI: 0.66, fog: [0.13, 150, 0, 1.0], mist: [1.2, 42], halo: [0.2, 0.55, 3.2], cover: 0.45, cirrus: 0.7, exp: 0.98, sat: 1.08, con: 1.03, lo: '#7c8090', hi: '#8c8278', cloudShadow: 0.4, wind: [0.9, -3.6] },
      { p: 0.36, sun: [-18, 17], sunCol: '#ffe0b0', sunI: 1.2, key: '#ffe2ba', keyI: 3.3, zen: '#2f74c4', mid: '#86b8e2', hor: '#e8e6d6', warm: '#ffe4bc', anti: '#c8d2dc', skyI: 0.96, ambS: '#97b6dc', ambG: '#8a8468', ambI: 0.68, fog: [0.075, 260, 0, 1.0], mist: [0.28, 34], halo: [0.14, 0.4, 2.2], cover: 0.6, cirrus: 0.5, exp: 0.92, sat: 1.1, con: 1.03, cloudShadow: 0.6, wind: [1.4, -4.6] },
      { p: 0.66, sun: [14, 27], sunCol: '#fff0d4', sunI: 1.1, key: '#fff0d2', keyI: 3.5, zen: '#2a6cc0', mid: '#84b6e4', hor: '#e2e8e2', warm: '#fff0d2', anti: '#cbd8e2', skyI: 0.98, ambS: '#98b8de', ambG: '#8f8a6c', ambI: 0.68, fog: [0.06, 320, 0, 1.0], mist: [0.08, 30], halo: [0.12, 0.35, 2], cover: 0.68, cirrus: 0.4, exp: 0.9, sat: 1.1, con: 1.03, cloudShadow: 0.65, wind: [1.8, -5.2] },
      { p: 0.86, sun: [34, 10], sunCol: '#ffc27a', sunI: 1.4, key: '#ffc488', keyI: 3.0, zen: '#3a6fb2', mid: '#93b6d2', hor: '#f7dcb0', warm: '#ffbe78', anti: '#d4b8c2', skyI: 0.92, ambS: '#96accc', ambG: '#8a7c66', ambI: 0.66, fog: [0.09, 220, 0, 1.0], mist: [0.3, 30], halo: [0.2, 0.55, 3], cover: 0.55, cirrus: 0.65, exp: 0.95, sat: 1.1, con: 1.04, lo: '#7c7f90', hi: '#8e8274', cloudShadow: 0.5, wind: [1.2, -4] },
      { p: 1.0, sun: [40, 2.2], sunCol: '#ff8a4c', sunI: 1.5, key: '#ff9058', keyI: 1.9, zen: '#3b4f8c', mid: '#a98fb0', hor: '#ffbe8c', warm: '#ff8a58', anti: '#b48fb4', skyI: 0.82, ambS: '#8c94bc', ambG: '#7a6660', ambI: 0.62, fog: [0.13, 170, 0, 1.0], mist: [0.8, 26], halo: [0.26, 0.7, 3.4], cover: 0.5, cirrus: 0.8, exp: 1.02, sat: 1.12, con: 1.04, lo: '#74788e', hi: '#92806f', cloudShadow: 0.35, wind: [0.5, -2.4] },
    ],
    weather(_r, ts, seed) {
      const rng = makeRng(seed + 3);
      return { base: 620, top: 1080, density: 1, field: 0, fieldScale: 3000, fieldTall: 0.4, seed, puffs: [...thermalPuffs(ts, 330, 0.62, 0.86, rng), ...scatterPuffs(rng, 26, 13000, [300, 620], [0.35, 0.8], 0.82)] };
    },
    air: { thermals: 9, strength: 6.6, radius: 130, top: 560, ridge: 1, glass: 0.5 },
    motes: { kind: 'down', color: '#fff2da', amount: 0.8 },
    age: 0.0,
    music: { root: 50, scale: [0, 2, 4, 7, 9], pace: 1, color: 'glass' },
  },

  // ------------------------------------------------------------------ II
  copper: {
    id: 'copper',
    numeral: 'II',
    title: 'The Copper Wood',
    opening: ['The long ridges run south,', 'and the wind leans on them all day.'],
    closing: ['You can hear them now,', 'two valleys on.'],
    style: {
      grassA: '#8a8a3c', grassB: '#b2963f', dry: '#c2a158', forestA: '#b4561f', forestB: '#c98a26', forestC: '#8c2f1e',
      rockA: '#7c766e', rockB: '#a39a8c', sand: '#b3a07a', mud: '#5a4a36', snow: '#ffffff', canopy: 12, strata: 0, sheen: 0.9,
    },
    trees: [
      { form: 'broadleaf', weight: 0.42, size: [11, 18], leaf: ['#c4591c', '#b0441c', '#da7a26'], bark: '#57463a' },
      { form: 'broadleaf', weight: 0.3, size: [10, 16], leaf: ['#d39a2c', '#bf8424', '#e6b43e'], bark: '#5f4d3c' },
      { form: 'broadleaf', weight: 0.14, size: [9, 15], leaf: ['#8e2a1e', '#a4341f', '#6d2420'], bark: '#4b3c34' },
      { form: 'conifer', weight: 0.14, size: [13, 21], leaf: ['#34492c', '#2b4030', '#43552f'], bark: '#4e3f33' },
    ],
    treeGap: 9.5,
    grass: { tall: 0.8, colorA: '#7c7a36', colorB: '#b0903e', tip: '#e6c878', flowers: ['#e8c060', '#c86a4a'] },
    water: { deep: '#10262a', shallow: '#4c4a32', clarity: 2.6, chop: 0.4, swell: 0, glow: '#000000', glowAmt: 0 },
    keys: [
      { p: 0.0, sun: [-52, 9], sunCol: '#ffd09a', sunI: 1.3, key: '#ffd2a0', keyI: 3.0, zen: '#2c66ae', mid: '#86b0d6', hor: '#f2e0c4', warm: '#ffd09a', anti: '#c4c2d2', skyI: 0.92, ambS: '#90aed4', ambG: '#8c7458', ambI: 0.64, fog: [0.1, 200, 0, 1.0], mist: [0.9, 70], halo: [0.18, 0.5, 2.8], cover: 0.5, cirrus: 0.4, exp: 0.95, sat: 1.12, con: 1.05, cloudShadow: 0.5, wind: [5.4, -3.2] },
      { p: 0.3, sun: [-16, 26], sunCol: '#fff0d0', sunI: 1.1, key: '#fff0d0', keyI: 3.6, zen: '#1f60b6', mid: '#78aee0', hor: '#dfe6e0', warm: '#fff0d4', anti: '#c4d2e0', skyI: 0.98, ambS: '#92b4de', ambG: '#94805c', ambI: 0.64, fog: [0.062, 300, 0, 1.0], mist: [0.16, 60], halo: [0.12, 0.35, 2], cover: 0.66, cirrus: 0.5, exp: 0.9, sat: 1.13, con: 1.05, cloudShadow: 0.7, wind: [6.4, -3.4] },
      { p: 0.58, sun: [14, 22], sunCol: '#ffe4b4', sunI: 1.2, key: '#ffe6b8', keyI: 3.6, zen: '#2464b4', mid: '#80b0da', hor: '#ece2c8', warm: '#ffe2b0', anti: '#c8cada', skyI: 0.96, ambS: '#92b0d8', ambG: '#987e58', ambI: 0.64, fog: [0.07, 280, 0, 1.0], mist: [0.12, 60], halo: [0.15, 0.42, 2.4], cover: 0.7, cirrus: 0.55, exp: 0.92, sat: 1.14, con: 1.05, cloudShadow: 0.7, wind: [6.6, -3.2] },
      { p: 0.82, sun: [26, 9], sunCol: '#ffb866', sunI: 1.5, key: '#ffba70', keyI: 3.3, zen: '#3166a8', mid: '#98aec4', hor: '#fbd49a', warm: '#ffb468', anti: '#ccaabc', skyI: 0.92, ambS: '#90a4c6', ambG: '#94704e', ambI: 0.62, fog: [0.1, 230, 0, 1.0], mist: [0.35, 60], halo: [0.24, 0.62, 3.2], cover: 0.6, cirrus: 0.7, exp: 0.95, sat: 1.15, con: 1.06, lo: '#767a8c', hi: '#92826e', cloudShadow: 0.6, wind: [5.6, -3] },
      { p: 1.0, sun: [30, 1.8], sunCol: '#ff7a38', sunI: 1.7, key: '#ff8244', keyI: 2.0, zen: '#33457e', mid: '#a67c94', hor: '#ffa666', warm: '#ff7440', anti: '#a87c9e', skyI: 0.84, ambS: '#8488b0', ambG: '#7c5a48', ambI: 0.6, fog: [0.13, 190, 0, 1.0], mist: [0.9, 44], halo: [0.3, 0.8, 3.8], cover: 0.55, cirrus: 0.85, exp: 1.02, sat: 1.14, con: 1.05, lo: '#70748c', hi: '#968068', cloudShadow: 0.4, wind: [3, -2] },
    ],
    weather(_r, ts, seed) {
      const rng = makeRng(seed + 3);
      const p = [...thermalPuffs(ts, 380, 0.7, 0.9, rng)];
      // streets: long rows of cumulus lying along the wind
      for (let s = 0; s < 7; s++) {
        const ox = -13000 + s * 4300 + (rng() - 0.5) * 1200;
        for (let i = 0; i < 15; i++) {
          const t = i / 14 - 0.5;
          p.push({ x: ox + t * 16000 * 0.86 + (rng() - 0.5) * 500, z: -t * 16000 * 0.5 + (rng() - 0.5) * 900 - 1500 + s * 900, r: 420 + rng() * 420, tall: 0.45 + rng() * 0.45, amt: 0.8 + rng() * 0.12 });
        }
      }
      return { base: 780, top: 1380, density: 1, field: 0, fieldScale: 3000, fieldTall: 0.4, seed, puffs: p };
    },
    air: { thermals: 6, strength: 6.4, radius: 130, top: 700, ridge: 1.35, glass: 0.5 },
    motes: { kind: 'leaves', color: '#d8782c', amount: 1 },
    age: 0.2,
    music: { root: 45, scale: [0, 3, 5, 7, 10], pace: 0.94, color: 'wood' },
  },

  // ------------------------------------------------------------------ III
  stair: {
    id: 'stair',
    numeral: 'III',
    title: 'The White Stair',
    opening: ['Nothing grows up here', 'but the wind.'],
    closing: ['So this is how high', 'the quiet goes.'],
    style: {
      grassA: '#6c7a48', grassB: '#8a8a54', dry: '#8a7f60', forestA: '#2f4632', forestB: '#3a5238', forestC: '#4a5a3a',
      rockA: '#4e5058', rockB: '#7b7a7e', sand: '#8d8678', mud: '#4a4640', snow: '#eef3fb', canopy: 10, strata: 0, sheen: 0.4,
    },
    trees: [
      { form: 'conifer', weight: 0.8, size: [10, 19], leaf: ['#2a4034', '#24382f', '#33503c'], bark: '#4a3d34' },
      { form: 'pine', weight: 0.2, size: [8, 13], leaf: ['#35503a', '#2c4434', '#41603f'], bark: '#6a5140' },
    ],
    treeGap: 9,
    grass: { tall: 0.4, colorA: '#66703f', colorB: '#8a8250', tip: '#c8b880', flowers: ['#e8e4f4', '#a8b4e8'] },
    water: { deep: '#0c2436', shallow: '#2c5a5c', clarity: 5, chop: 0.2, swell: 0, glow: '#000000', glowAmt: 0 },
    keys: [
      { p: 0.0, sun: [-44, 6], sunCol: '#ffc48c', sunI: 1.4, key: '#ffc694', keyI: 3.1, zen: '#1e4f9a', mid: '#78a4d4', hor: '#f2d8cc', warm: '#ffc294', anti: '#c6b2d2', skyI: 0.92, ambS: '#86a6dc', ambG: '#7c82a0', ambI: 0.7, fog: [0.04, 900, 0, 1.0], mist: [0, 40], halo: [0.18, 0.5, 2.8], cover: 0.9, cirrus: 0.45, exp: 0.92, sat: 1.08, con: 1.05, cloudShadow: 0.25, wind: [3, -5.5] },
      { p: 0.3, sun: [-14, 28], sunCol: '#fff4e2', sunI: 1.1, key: '#fff4e4', keyI: 3.9, zen: '#0f479e', mid: '#5c98dc', hor: '#d2e2f2', warm: '#f6ece0', anti: '#b8cce6', skyI: 1.0, ambS: '#86aee8', ambG: '#8c96b0', ambI: 0.7, fog: [0.026, 1100, 0, 1.0], mist: [0, 40], halo: [0.1, 0.3, 1.8], cover: 0.92, cirrus: 0.35, exp: 0.82, sat: 1.08, con: 1.06, cloudShadow: 0.25, wind: [3.6, -7] },
      { p: 0.6, sun: [20, 18], sunCol: '#ffe6c0', sunI: 1.2, key: '#ffe8c8', keyI: 3.7, zen: '#164c9e', mid: '#6a9eda', hor: '#e6e0e2', warm: '#ffe0bc', anti: '#bcc2e0', skyI: 0.96, ambS: '#86a8e0', ambG: '#8890aa', ambI: 0.7, fog: [0.032, 1000, 0, 1.0], mist: [0, 40], halo: [0.14, 0.4, 2.2], cover: 0.92, cirrus: 0.6, exp: 0.86, sat: 1.09, con: 1.05, cloudShadow: 0.25, wind: [3.6, -7] },
      { p: 0.82, sun: [34, 4], sunCol: '#ff9c66', sunI: 1.6, key: '#ff9a68', keyI: 2.9, zen: '#234686', mid: '#8890be', hor: '#ffc09c', warm: '#ff9264', anti: '#c48cae', skyI: 0.9, ambS: '#8496d4', ambG: '#8078a0', ambI: 0.68, fog: [0.045, 900, 0, 1.0], mist: [0, 40], halo: [0.26, 0.66, 3.4], cover: 0.92, cirrus: 0.8, exp: 0.94, sat: 1.12, con: 1.04, lo: '#757b94', hi: '#90807a', cloudShadow: 0.2, wind: [2.4, -5] },
      { p: 1.0, sun: [40, -2.6], sunCol: '#ff7a5c', sunI: 1.1, key: '#b48ab8', keyI: 0.9, zen: '#16285e', mid: '#4d568f', hor: '#d88c94', warm: '#f47a5e', anti: '#7b5c94', skyI: 0.78, ambS: '#6c80c4', ambG: '#5c6090', ambI: 0.66, fog: [0.06, 700, 0, 1.0], mist: [0.5, 60], halo: [0.2, 0.5, 2], cover: 0.9, cirrus: 0.7, exp: 1.12, sat: 1.1, con: 1.02, lo: '#707a98', hi: '#8c8084', cloudShadow: 0.1, wind: [1, -3], stars: 0.4, moon: [-30, 24] },
    ],
    weather(r, _ts, seed) {
      const [ex, ez] = r.at(1);
      const rng = makeRng(seed + 1);
      const p: Puff[] = [];
      // lenticulars: smooth lenses standing over the summits
      for (let i = 0; i < 9; i++) {
        const t = 0.1 + (i / 9) * 0.8;
        const [x, z] = r.at(t);
        const s = rng() < 0.5 ? -1 : 1;
        p.push({ x: x + s * (1400 + rng() * 2600), z: z + (rng() - 0.5) * 1500, r: 700 + rng() * 500, sx: 1.7, sz: 0.6, rot: 0.4 + (rng() - 0.5) * 0.4, tall: 0.9, amt: 0.0, smooth: 1 });
      }
      return { base: 430, top: 660, density: 1.1, field: 1, fieldScale: 2200, fieldTall: 0.95, sea: true, seed, puffs: [], holes: [{ x: ex, z: ez, r: 1150 }] };
    },
    air: { thermals: 4, strength: 5.6, radius: 150, top: 1350, ridge: 1.1, glass: 0.6 },
    motes: { kind: 'snow', color: '#f4f8ff', amount: 1 },
    age: 0.4,
    music: { root: 52, scale: [0, 2, 4, 6, 7, 11], pace: 0.82, color: 'bell' },
  },

  // ------------------------------------------------------------------ IV
  rooms: {
    id: 'rooms',
    numeral: 'IV',
    title: 'The Red Rooms',
    opening: ['Hot stone, hard light.', 'Let the ground lift you.'],
    closing: ['Rain came through and left.', 'So did you.'],
    style: {
      grassA: '#7e8446', grassB: '#a39a52', dry: '#c08a56', forestA: '#6d7a3c', forestB: '#8a8a40', forestC: '#a09244',
      rockA: '#b0553a', rockB: '#d98f60', sand: '#d2a071', mud: '#7c3f30', snow: '#efd6b4', canopy: 5, strata: 1, sheen: 0.5,
    },
    trees: [
      { form: 'juniper', weight: 0.55, size: [3.5, 6], leaf: ['#5b6b3c', '#4d5f38', '#6f7c46'], bark: '#7a5a46' },
      { form: 'willow', weight: 0.45, size: [6, 9], leaf: ['#97a04a', '#a8a248', '#7f8c42'], bark: '#7b6650' },
    ],
    treeGap: 11,
    grass: { tall: 0.5, colorA: '#8f8a4c', colorB: '#b89a5a', tip: '#e6cf94', flowers: ['#f0d060', '#e86a50'] },
    water: { deep: '#2c3a34', shallow: '#8a6a4a', clarity: 1.4, chop: 0.3, swell: 0, glow: '#000000', glowAmt: 0 },
    keys: [
      { p: 0.0, sun: [-50, 10], sunCol: '#ffd29a', sunI: 1.3, key: '#ffd4a0', keyI: 3.3, zen: '#2468b0', mid: '#80b2d8', hor: '#f4dcb8', warm: '#ffce94', anti: '#ceb4b4', skyI: 0.95, ambS: '#90b0d6', ambG: '#b0765a', ambI: 0.66, fog: [0.055, 420, 0, 1.0], mist: [0.1, 60], halo: [0.18, 0.5, 2.8], cover: 0.5, cirrus: 0.3, exp: 0.9, sat: 1.1, con: 1.05, cloudShadow: 0.6, wind: [-1, -4.4] },
      { p: 0.28, sun: [-10, 48], sunCol: '#fff6e0', sunI: 1.0, key: '#fff4dc', keyI: 4.1, zen: '#1a5cb4', mid: '#6aa8de', hor: '#e6dcc6', warm: '#f8ead0', anti: '#c4ccd4', skyI: 1.02, ambS: '#92b6e0', ambG: '#c48a66', ambI: 0.66, fog: [0.045, 520, 0, 1.0], mist: [0, 60], halo: [0.1, 0.3, 1.8], cover: 0.62, cirrus: 0.25, exp: 0.82, sat: 1.1, con: 1.06, cloudShadow: 0.75, wind: [-1.2, -5] },
      { p: 0.5, sun: [10, 38], sunCol: '#ffeccc', sunI: 0.8, key: '#ffe8c8', keyI: 2.7, zen: '#3f6288', mid: '#7c94a6', hor: '#c8b8a4', warm: '#e8c8a0', anti: '#8c8c9a', skyI: 0.8, ambS: '#8298b2', ambG: '#a07860', ambI: 0.74, fog: [0.075, 420, 0, 1.0], mist: [0.05, 60], halo: [0.1, 0.3, 1.4], cover: 0.8, cirrus: 0.5, exp: 0.96, sat: 1.06, con: 1.05, lo: '#788090', cloudShadow: 0.85, wind: [-2.4, -6.4] },
      { p: 0.72, sun: [20, 20], sunCol: '#ffd090', sunI: 1.2, key: '#ffd098', keyI: 3.5, zen: '#37547e', mid: '#8a96a8', hor: '#e2be94', warm: '#ffc27e', anti: '#80809a', skyI: 0.84, ambS: '#8898ba', ambG: '#a8745a', ambI: 0.7, fog: [0.08, 380, 0, 1.0], mist: [0.16, 60], halo: [0.2, 0.55, 2.6], cover: 0.74, cirrus: 0.6, exp: 0.94, sat: 1.12, con: 1.06, lo: '#747c92', hi: '#8e8274', cloudShadow: 0.7, wind: [-1.8, -5] },
      { p: 0.9, sun: [27, 6], sunCol: '#ff9a4c', sunI: 1.7, key: '#ff9a54', keyI: 3.4, zen: '#2e4c86', mid: '#a090a4', hor: '#ffb87a', warm: '#ff8e4c', anti: '#a87898', skyI: 0.92, ambS: '#8a90ba', ambG: '#a06450', ambI: 0.66, fog: [0.085, 340, 0, 1.0], mist: [0.3, 50], halo: [0.28, 0.72, 3.4], cover: 0.6, cirrus: 0.85, exp: 0.96, sat: 1.14, con: 1.06, lo: '#70748e', hi: '#94806c', cloudShadow: 0.5, wind: [-1, -3.6] },
      { p: 1.0, sun: [30, 0.8], sunCol: '#ff5c2c', sunI: 1.8, key: '#ff6a3c', keyI: 2.0, zen: '#26306e', mid: '#8c5c8c', hor: '#ff8450', warm: '#ff5830', anti: '#7c4c84', skyI: 0.86, ambS: '#7c78ac', ambG: '#84484a', ambI: 0.62, fog: [0.1, 300, 0, 1.0], mist: [0.5, 40], halo: [0.32, 0.85, 4], cover: 0.55, cirrus: 0.95, exp: 1.04, sat: 1.14, con: 1.05, lo: '#6c708c', hi: '#987c68', cloudShadow: 0.3, wind: [-0.6, -2.4] },
    ],
    weather(r, ts, seed) {
      const rng = makeRng(seed + 2);
      const [cx, cz] = r.at(0.56);
      const p = [...thermalPuffs(ts, 420, 0.6, 0.88, rng), ...scatterPuffs(rng, 18, 13000, [320, 640], [0.3, 0.6], 0.84)];
      // the visitor: one tall storm off the left shoulder
      const sx = cx - 3300;
      const sz = cz - 300;
      for (let i = 0; i < 11; i++) p.push({ x: sx + (rng() - 0.5) * 1900, z: sz + (rng() - 0.5) * 1900, r: 900 + rng() * 520, tall: 0.75 + rng() * 0.25, amt: 0.95 });
      p.push({ x: sx - 500, z: sz - 900, r: 2500, sx: 1.4, sz: 0.9, tall: 1, amt: 0.62, smooth: 0.4 });
      return { base: 940, top: 2500, density: 1, field: 0, fieldScale: 3000, fieldTall: 0.3, seed, puffs: p, rain: { x: sx, z: sz, r: 1250, amt: 1 } };
    },
    air: { thermals: 10, strength: 7.4, radius: 125, top: 860, ridge: 1.1, glass: 0.4 },
    motes: { kind: 'dust', color: '#f2c890', amount: 1 },
    age: 0.6,
    music: { root: 47, scale: [0, 1, 4, 5, 7, 8, 11], pace: 1.02, color: 'brass' },
  },

  // ------------------------------------------------------------------ V
  darkwater: {
    id: 'darkwater',
    numeral: 'V',
    title: 'The Long Dark Water',
    opening: ['No one sleeps on the crossing.', 'You are not the only light out here.'],
    closing: ['Halfway is not a place.', 'It only feels like one.'],
    style: {
      grassA: '#4f6a44', grassB: '#6c7c4c', dry: '#80795a', forestA: '#33482f', forestB: '#3c5234', forestC: '#48583a',
      rockA: '#3c3d44', rockB: '#62605f', sand: '#8c8270', mud: '#3a3630', snow: '#ffffff', canopy: 6, strata: 0, sheen: 0.7,
    },
    trees: [
      { form: 'pine', weight: 1, size: [5, 9], leaf: ['#33492f', '#2a3e2c', '#415738'], bark: '#5c483a' },
    ],
    treeGap: 11,
    grass: { tall: 0.5, colorA: '#4c6140', colorB: '#6f7a4c', tip: '#b8b88a', flowers: ['#f0e8f4', '#e0d0e0'] },
    water: { deep: '#03121e', shallow: '#12404a', clarity: 6, chop: 0.75, swell: 1, glow: '#37f0d8', glowAmt: 1 },
    keys: [
      { p: 0.0, sun: [26, 3.2], sunCol: '#ff8a4a', sunI: 1.6, key: '#ff9256', keyI: 2.6, zen: '#2c4684', mid: '#94809e', hor: '#ffb07c', warm: '#ff8450', anti: '#94749e', skyI: 0.86, ambS: '#848cb8', ambG: '#6a5c60', ambI: 0.62, fog: [0.06, 260, 0, 1.0], mist: [0.2, 40], halo: [0.28, 0.75, 3.6], cover: 0.5, cirrus: 0.85, exp: 1.0, sat: 1.12, con: 1.04, lo: '#70768e', hi: '#947f6e', cloudShadow: 0.3, wind: [2.6, -6], moon: [-34, 12], moonlit: 0 },
      { p: 0.14, sun: [29, -2.4], sunCol: '#ff6a48', sunI: 1.3, key: '#c08498', keyI: 1.1, zen: '#16265c', mid: '#545488', hor: '#e08a80', warm: '#f8684c', anti: '#5c4a80', skyI: 0.76, ambS: '#6672aa', ambG: '#484a68', ambI: 0.56, fog: [0.065, 260, 0, 1.0], mist: [0.2, 40], halo: [0.2, 0.5, 2], cover: 0.5, cirrus: 0.7, exp: 1.12, sat: 1.1, con: 1.02, cloudShadow: 0.1, wind: [2.6, -6.4], stars: 0.35, moon: [-34, 17], moonlit: 0.35 },
      { p: 0.32, sun: [32, -9], sunCol: '#a05c6c', sunI: 0.5, key: '#9cb8f0', keyI: 0.95, zen: '#071230', mid: '#122450', hor: '#2c4470', warm: '#4c4c70', anti: '#1c2c54', skyI: 0.8, ambS: '#3c56a0', ambG: '#1c2c4c', ambI: 0.5, fog: [0.055, 280, 0, 1.0], mist: [0.1, 40], halo: [0.1, 0.2, 0.4], cover: 0.5, cirrus: 0.4, exp: 1.42, sat: 1.08, con: 1.02, lo: '#707c98', cloudShadow: 0.4, wind: [2.6, -6.6], stars: 1, moon: [-26, 26], moonlit: 1 },
      { p: 0.6, sun: [36, -18], sunCol: '#405080', sunI: 0.2, key: '#a4c0f4', keyI: 1.05, zen: '#050e28', mid: '#0e2048', hor: '#223c66', warm: '#22385e', anti: '#1c3258', skyI: 0.8, ambS: '#3856a4', ambG: '#1a2c4c', ambI: 0.52, fog: [0.05, 300, 0, 1.0], mist: [0.1, 40], halo: [0.05, 0.1, 0.2], cover: 0.42, cirrus: 0.25, exp: 1.5, sat: 1.1, con: 1.02, lo: '#6c7c98', cloudShadow: 0.4, wind: [2.2, -6], stars: 1.1, aurora: 1, moon: [-10, 33], moonlit: 1 },
      { p: 0.85, sun: [-48, -12], sunCol: '#506090', sunI: 0.3, key: '#a4bcf0', keyI: 0.9, zen: '#091638', mid: '#1a3260', hor: '#3c5884', warm: '#4c6088', anti: '#2c4470', skyI: 0.82, ambS: '#4460a8', ambG: '#24365a', ambI: 0.54, fog: [0.06, 280, 0, 1.0], mist: [0.2, 40], halo: [0.08, 0.15, 0.3], cover: 0.4, cirrus: 0.35, exp: 1.42, sat: 1.1, con: 1.02, cloudShadow: 0.3, wind: [1.6, -4.4], stars: 0.95, aurora: 0.45, moon: [16, 24], moonlit: 1 },
      { p: 1.0, sun: [-44, -5], sunCol: '#e88a78', sunI: 0.8, key: '#a8a8d4', keyI: 0.8, zen: '#15285a', mid: '#3c5a8c', hor: '#b48ca0', warm: '#e8907c', anti: '#5c5c90', skyI: 0.78, ambS: '#6478b4', ambG: '#444c70', ambI: 0.56, fog: [0.08, 240, 0, 1.0], mist: [0.4, 36], halo: [0.14, 0.3, 0.8], cover: 0.4, cirrus: 0.6, exp: 1.25, sat: 1.1, con: 1.02, cloudShadow: 0.1, wind: [1, -3], stars: 0.5, aurora: 0.1, moon: [34, 14], moonlit: 0.6 },
    ],
    weather(_r, ts, seed) {
      const rng = makeRng(seed + 2);
      return { base: 560, top: 980, density: 1, field: 0, fieldScale: 3000, fieldTall: 0.4, seed, puffs: [...thermalPuffs(ts, 340, 0.55, 0.84, rng), ...scatterPuffs(rng, 22, 13000, [280, 620], [0.3, 0.6], 0.8)] };
    },
    air: { thermals: 9, strength: 6.0, radius: 150, top: 520, ridge: 1.2, glass: 0.5 },
    motes: { kind: 'spray', color: '#cfe8ff', amount: 0.7 },
    age: 0.8,
    music: { root: 43, scale: [0, 2, 3, 7, 9], pace: 0.8, color: 'deep' },
  },

  // ------------------------------------------------------------------ VI
  wintering: {
    id: 'wintering',
    numeral: 'VI',
    title: 'Wintering',
    opening: ['Listen.'],
    closing: ['There is always someone', 'still on the way.'],
    style: {
      grassA: '#8c8a3e', grassB: '#b6a24a', dry: '#c6aa62', forestA: '#6c7436', forestB: '#8c8640', forestC: '#b49a46',
      rockA: '#8a8072', rockB: '#a89c88', sand: '#c2a878', mud: '#5a4a38', snow: '#ffffff', canopy: 7, strata: 0, sheen: 1.1,
    },
    trees: [
      { form: 'acacia', weight: 0.6, size: [7, 11], leaf: ['#7c8238', '#8e9040', '#a09a48'], bark: '#6c5644' },
      { form: 'palm', weight: 0.4, size: [8, 13], leaf: ['#8a8c3c', '#7a8038', '#a29a48'], bark: '#7a6650' },
    ],
    treeGap: 13,
    grass: { tall: 1.4, colorA: '#7f8038', colorB: '#b09a46', tip: '#f0d488', flowers: ['#f4ead0', '#f0c8b0'] },
    water: { deep: '#1c3440', shallow: '#6a6448', clarity: 2.4, chop: 0.2, swell: 0, glow: '#000000', glowAmt: 0 },
    keys: [
      { p: 0.0, sun: [-30, -3.5], sunCol: '#ff8a60', sunI: 1.1, key: '#c492a4', keyI: 0.9, zen: '#22427e', mid: '#7a86b4', hor: '#f4b29c', warm: '#ff8a66', anti: '#a084ac', skyI: 0.74, ambS: '#7c8cc0', ambG: '#645c68', ambI: 0.6, fog: [0.12, 150, 0, 1.0], mist: [1.3, 30], halo: [0.2, 0.5, 1.6], cover: 0.5, cirrus: 0.95, exp: 1.08, sat: 1.08, con: 1.02, lo: '#767c92', hi: '#8e8078', cloudShadow: 0.1, wind: [0.4, -3], stars: 0.16, moon: [40, 10] },
      { p: 0.22, sun: [-24, 1.2], sunCol: '#ff9450', sunI: 1.6, key: '#ff9a5c', keyI: 2.0, zen: '#3c62a6', mid: '#9ca8c4', hor: '#ffcaa0', warm: '#ff9658', anti: '#c8a0b6', skyI: 0.84, ambS: '#8e9cc6', ambG: '#7c6a62', ambI: 0.64, fog: [0.12, 150, 0, 1.0], mist: [1.3, 30], halo: [0.28, 0.75, 3.6], cover: 0.5, cirrus: 0.95, exp: 1.02, sat: 1.1, con: 1.03, lo: '#787c90', hi: '#92826f', cloudShadow: 0.3, wind: [0.6, -3.4] },
      { p: 0.55, sun: [-14, 9], sunCol: '#ffc078', sunI: 1.5, key: '#ffc484', keyI: 3.1, zen: '#3a74b8', mid: '#98bcd6', hor: '#fbe0b4', warm: '#ffc27c', anti: '#d2bcc4', skyI: 0.94, ambS: '#98b0d2', ambG: '#8e8066', ambI: 0.68, fog: [0.09, 190, 0, 1.0], mist: [0.7, 28], halo: [0.22, 0.6, 3.2], cover: 0.5, cirrus: 0.8, exp: 0.96, sat: 1.12, con: 1.03, hi: '#908274', cloudShadow: 0.4, wind: [0.8, -3.8] },
      { p: 1.0, sun: [-4, 16], sunCol: '#ffdca4', sunI: 1.4, key: '#ffdeac', keyI: 3.4, zen: '#3478c0', mid: '#90bce0', hor: '#f6e8c8', warm: '#ffdca8', anti: '#d2cad0', skyI: 0.98, ambS: '#9ab6dc', ambG: '#948a6c', ambI: 0.7, fog: [0.075, 230, 0, 1.0], mist: [0.35, 24], halo: [0.2, 0.5, 2.8], cover: 0.5, cirrus: 0.7, exp: 0.94, sat: 1.12, con: 1.03, cloudShadow: 0.4, wind: [0.8, -3.4] },
    ],
    weather(_r, ts, seed) {
      const rng = makeRng(seed + 2);
      return { base: 700, top: 1050, density: 0.9, field: 0, fieldScale: 2600, fieldTall: 0.4, seed, puffs: [...thermalPuffs(ts, 260, 0.45, 0.76, rng), ...scatterPuffs(rng, 10, 14000, [260, 520], [0.3, 0.5], 0.76)] };
    },
    air: { thermals: 9, strength: 6.4, radius: 140, top: 560, ridge: 1, glass: 0.7 },
    motes: { kind: 'down', color: '#fff0d0', amount: 1 },
    age: 1.0,
    music: { root: 50, scale: [0, 2, 4, 7, 9, 11], pace: 1, color: 'choir' },
  },
};
