/**
 * The six lands of the journey — geography only. Each land is a pure height
 * function plus ground masks; `generate.ts` turns it into a baked world
 * (erosion, normals, occlusion). Water lies at y = 0 in every land.
 *
 * Travel runs roughly from +Z to -Z. A seed is a map: the journey uses each
 * land's home seed; free flight can deal any other.
 */
import { Noise, Route, clamp, lerp, smoothstep } from './noise';

export type LandId = 'stillmere' | 'copper' | 'stair' | 'rooms' | 'darkwater' | 'wintering';

export const LAND_ORDER: LandId[] = ['stillmere', 'copper', 'stair', 'rooms', 'darkwater', 'wintering'];

/** Half-extent of the detailed core (m). */
export const HALF = 8192;

export interface LandmarkDef {
  id: string;
  name: string;
  kind:
    | 'steeple'
    | 'boathouse'
    | 'oldtree'
    | 'viaduct'
    | 'waterfall'
    | 'stones'
    | 'bell'
    | 'arch'
    | 'lighthouse'
    | 'whale'
    | 'cairn'
    | 'stilt';
  /** position along the route (0..1) and lateral offset in metres (+ = right of travel) */
  t: number;
  off: number;
  /** yaw offset relative to route direction, radians */
  yaw?: number;
  /** flatten a pad of this radius; null keeps the land as it is */
  pad?: number;
  /** pad height: 'water' sits it just at the waterline */
  padY?: number;
  /** how near counts as finding it */
  reach: number;
}

export interface Land {
  id: LandId;
  seed: number;
  route: Route;
  /** Un-eroded height (m). */
  base(x: number, z: number): number;
  /** [forest, lush, rock, special] — each 0..1 */
  masks(x: number, z: number, h: number, slope: number, out: Float64Array): void;
  /** erosion droplets per cell of the coarse grid, and strength */
  erosion: { droplets: number; strength: number };
  /** amplitude (m) of fine detail added after erosion on steep ground */
  detail: number;
  landmarks: LandmarkDef[];
}

export function makeLand(id: LandId, seed?: number): Land {
  switch (id) {
    case 'stillmere':
      return stillmere(seed ?? 11);
    case 'copper':
      return copper(seed ?? 23);
    case 'stair':
      return stair(seed ?? 5);
    case 'rooms':
      return rooms(seed ?? 42);
    case 'darkwater':
      return darkwater(seed ?? 9);
    case 'wintering':
      return wintering(seed ?? 71);
  }
}

/** Keep land decisively above or below the waterline so shores read cleanly. */
function shore(h: number, k = 1.2): number {
  return h + k * Math.tanh(h * 0.9);
}

// ---------------------------------------------------------------- I Stillmere
function stillmere(seed: number): Land {
  const n = new Noise(seed);
  const m = new Noise(seed + 101);
  const route = new Route([
    [0, 5200],
    [250, 4200],
    [-500, 2700],
    [350, 1100],
    [900, -500],
    [100, -2200],
    [-450, -3700],
    [0, -5000],
  ]);
  const grid = route.bake(HALF, 160);
  const rd = (x: number, z: number) => sampleGrid(grid.d, grid.n, grid.half, x, z);

  const base = (x: number, z: number): number => {
    const wx = x + 160 * n.n(x / 700, z / 700);
    const wz = z + 160 * m.n(x / 700 + 9, z / 700 - 4);
    // the marsh: hummocks and a lacework of pools and channels
    const hum = 1.6 + 2.2 * n.fbm(x / 240, z / 240, 3);
    const p1 = n.fbm(wx / 620, wz / 620, 3);
    const chan = Math.abs(m.n(wx / 900 + 3, wz / 520));
    let marsh = lerp(hum, -2.6, smoothstep(0.02, 0.26, p1));
    marsh = lerp(-2.2, marsh, smoothstep(0.02, 0.13, chan));
    // two great mirrors: the hatching water and the evening water
    const l0 = Math.hypot(x - 80, (z - 5050) * 1.15) + 190 * n.n(x / 520, z / 520);
    marsh = lerp(-4.5, marsh, smoothstep(520, 980, l0));
    const l1 = Math.hypot((x + 30) * 0.8, z + 5000) + 260 * n.n(x / 640 + 4, z / 640);
    marsh = lerp(-5.5, marsh, smoothstep(760, 1350, l1));
    // start and roost sandbars
    const s0 = Math.hypot((x - 0) * 0.55, z - 5200);
    marsh = lerp(0.5, marsh, smoothstep(10, 46, s0));
    const s1 = Math.hypot(x, (z + 5000) * 0.5);
    marsh = lerp(-0.18, marsh, smoothstep(36, 120, s1));
    // the country rises gently away from the water road
    const d = rd(x, z) + 420 * m.fbm(x / 1500, z / 1500, 3);
    const v = smoothstep(900, 3600, d);
    const hills =
      34 + 120 * (0.5 + 0.5 * n.n(x / 2300 + 2, z / 2300)) * (0.6 + 0.6 * n.fbm(x / 900, z / 900, 4) + 0.2);
    const far = smoothstep(3800, 9000, d) * (170 + 260 * n.ridged(x / 4200, z / 4200, 4));
    // low wooded knolls inside the marsh
    const kn = smoothstep(0.28, 0.6, n.fbm(x / 1300 + 7, z / 1300 - 3, 2)) * smoothstep(340, 700, rd(x, z));
    return shore(lerp(marsh + kn * 26, hills, v) + far);
  };

  return {
    id: 'stillmere',
    seed,
    route,
    base,
    erosion: { droplets: 0.12, strength: 0.6 },
    detail: 0.6,
    masks(x, z, h, slope, out) {
      const f = n.fbm(x / 520 + 41, z / 520 + 13, 3);
      const g = m.fbm(x / 180, z / 180, 2);
      const dry = smoothstep(2.5, 9, h);
      out[0] = clamp(dry * smoothstep(-0.02, 0.28, f + 0.12 * g + smoothstep(8, 70, h) * 0.22) * (1 - smoothstep(0.5, 0.9, slope)), 0, 1);
      out[1] = clamp(smoothstep(0.1, 1.2, h) * (0.75 + 0.35 * g), 0, 1);
      out[2] = smoothstep(0.75, 1.1, slope);
      out[3] = 1 - smoothstep(0.2, 1.4, Math.abs(h - 0.5)); // wet mud rim
    },
    landmarks: [
      { id: 'steeple', name: 'The Drowned Steeple', kind: 'steeple', t: 0.3, off: 120, reach: 150, pad: 70, padY: -3.2 },
      { id: 'boathouse', name: 'The Heron Posts', kind: 'stilt', t: 0.62, off: -150, reach: 150, pad: 80, padY: -1.8 },
      { id: 'lone', name: 'Candle Birch', kind: 'oldtree', t: 0.84, off: 170, reach: 150, pad: 34, padY: 2.6 },
    ],
  };
}

// --------------------------------------------------------------- II The Copper Wood
function copper(seed: number): Land {
  const n = new Noise(seed);
  const m = new Noise(seed + 77);
  const route = new Route([
    [-250, 5200],
    [120, 4000],
    [520, 2600],
    [380, 1100],
    [-150, -100],
    [-520, -1500],
    [-300, -3100],
    [150, -4300],
    [60, -5150],
  ]);
  const SP = 1750; // ridge spacing
  const axis = (x: number, z: number) =>
    x + 340 * Math.sin(z / 2500 + 0.6) + 300 * n.n(x / 3300, z / 3300) + 120 * m.n(x / 1200, z / 1200);
  // the river keeps the valley beside the long ridge and cuts one gap
  const riverX = (z: number) => -620 + 210 * Math.sin(z / 780) + 120 * Math.sin(z / 330 + 1.3);

  const base = (x: number, z: number): number => {
    const u = axis(x, z);
    const c = 0.5 + 0.5 * Math.cos(((u - 780) / SP) * Math.PI * 2);
    const crestVar = 0.78 + 0.42 * n.fbm(x / 2600 + 5, z / 1500, 3);
    let ridge = Math.pow(c, 1.7) * 255 * crestVar;
    // water gaps — the old river was here before the mountains were
    const gap1 = smoothstep(140, 620, Math.abs(z - 500 + 120 * n.n(x / 800, 3)));
    const gap2 = smoothstep(120, 560, Math.abs(z + 3500 + 160 * n.n(x / 700, 8)));
    ridge *= lerp(0.12, 1, gap1) * lerp(0.2, 1, gap2);
    const floor = 9 + 9 * n.fbm(x / 420, z / 420, 3) + 14 * smoothstep(-0.1, 0.6, m.n(x / 1500, z / 1500));
    let h = floor + ridge + 26 * n.fbm(x / 520 + 3, z / 520, 4) * smoothstep(10, 120, ridge);
    // the river
    const rx = riverX(z) + 40 * m.n(x / 260, z / 260);
    const dr = Math.abs(u - rx + 340);
    const rv = smoothstep(46, 170, dr);
    h = lerp(-3.2, h, rv);
    // cross-stream in the gap
    const gx = Math.abs(z - 500 + 130 * Math.sin(x / 420) + 40 * n.n(x / 200, z / 200));
    h = lerp(-2.4, h, lerp(1, smoothstep(26, 120, gx), smoothstep(2600, 1800, Math.abs(x))));
    // roost: a quiet mere under the last ridge
    const l1 = Math.hypot((x - 60) * 0.9, z + 5150) + 130 * n.n(x / 420, z / 420);
    h = lerp(-3.6, h, smoothstep(300, 660, l1));
    const s1 = Math.hypot(x - 60, (z + 5150) * 0.6);
    h = lerp(-0.16, h, smoothstep(26, 90, s1));
    // high meadow launch
    const s0 = Math.hypot(x + 250, z - 5200);
    h = lerp(172, h, smoothstep(60, 420, s0));
    const far = smoothstep(6000, 12000, Math.hypot(x, z)) * 260 * n.ridged(x / 5200, z / 5200, 3);
    return shore(h + far);
  };

  return {
    id: 'copper',
    seed,
    route,
    base,
    erosion: { droplets: 0.5, strength: 0.9 },
    detail: 1.6,
    masks(x, z, h, slope, out) {
      const clear = n.fbm(x / 430 + 3, z / 430 + 21, 3);
      const g = m.fbm(x / 140, z / 140, 2);
      const dry = smoothstep(1.5, 6, h);
      const meadow = smoothstep(0.16, 0.34, clear + 0.08 * g);
      const launch = smoothstep(220, 90, Math.hypot(x + 250, z - 5200));
      out[0] = clamp(dry * (1 - meadow) * (1 - launch) * (1 - smoothstep(1.1, 1.5, slope)), 0, 1);
      out[1] = clamp(dry * (0.7 + 0.3 * g), 0, 1);
      out[2] = smoothstep(0.95, 1.3, slope + 0.12 * g);
      out[3] = smoothstep(0.1, 0.5, m.n(x / 600 + 50, z / 600)); // which way the autumn turns
    },
    landmarks: [
      { id: 'viaduct', name: 'The Nine Arches', kind: 'viaduct', t: 0.45, off: -80, yaw: Math.PI / 2, reach: 220 },
      { id: 'oldtree', name: 'The Old Tree', kind: 'oldtree', t: 0.2, off: 210, reach: 150, pad: 46 },
      { id: 'tower', name: 'The Roofless Tower', kind: 'waterfall', t: 0.72, off: 260, reach: 200, pad: 30 },
    ],
  };
}

// --------------------------------------------------------------- III The White Stair
function stair(seed: number): Land {
  const n = new Noise(seed);
  const m = new Noise(seed + 303);
  const route = new Route([
    [300, 5200],
    [500, 4100],
    [-400, 2900],
    [-700, 1500],
    [200, 200],
    [800, -1200],
    [300, -2600],
    [-250, -3800],
    [0, -5000],
  ]);
  const grid = route.bake(HALF, 160);
  const rd = (x: number, z: number) => sampleGrid(grid.d, grid.n, grid.half, x, z);

  const base = (x: number, z: number): number => {
    const wx = x + 420 * n.n(x / 2400 + 8, z / 2400);
    const wz = z + 420 * m.n(x / 2400, z / 2400 + 5);
    const r = n.ridged(wx / 3000, wz / 3000, 6, 2.05, 0.5, 2.0);
    const broad = 0.5 + 0.5 * m.n(x / 5200 + 2, z / 5200);
    let h = 60 + 1500 * Math.pow(clamp(r, 0, 1.4), 1.35) * (0.6 + 0.65 * broad);
    const d = rd(x, z);
    // the high road: a chain of saddles between summits
    const corridor = smoothstep(150, 1500, d + 240 * n.fbm(x / 700, z / 700, 2));
    h *= lerp(0.7, 1.06, corridor);
    // the stair: cross-ridges that stand clear of the cloud, one after another
    const step = Math.pow(0.5 + 0.5 * Math.cos(z / 255 + 1.4 * n.n(x / 900, z / 900) + x / 1400), 3);
    h += step * (1 - corridor) * 330 * (0.6 + 0.6 * m.n(x / 500 + 3, z / 700));
    h += 60 * n.fbm(x / 420, z / 420, 3) * smoothstep(100, 500, h);
    // gullies
    const gx = n.n(x / 900 + 3, z / 900) * 0.5;
    const gul = Math.abs(m.n(wx / 240 + gx, wz / 240));
    h -= (1 - gul) * 34 * smoothstep(400, 1100, h);
    // launch shoulder, high above the cloud sea
    const s0 = Math.hypot(x - 300, z - 5200);
    h = lerp(842, h, smoothstep(50, 620, s0));
    // roost: a deep bowl with a tarn at its floor, a hole in the cloud
    const b = Math.hypot(x, (z + 5000) * 0.9) + 170 * n.n(x / 620, z / 620);
    h = lerp(-9, h, smoothstep(420, 1500, b));
    const s1 = Math.hypot(x, (z + 5000) * 0.6);
    h = lerp(-0.18, h, smoothstep(22, 80, s1));
    return shore(h);
  };

  return {
    id: 'stair',
    seed,
    route,
    base,
    erosion: { droplets: 0.9, strength: 1.2 },
    detail: 5.5,
    masks(x, z, h, slope, out) {
      const g = m.fbm(x / 160, z / 160, 3);
      const snow = smoothstep(430, 720, h + 120 * g) * (1 - smoothstep(0.75, 1.25, slope + 0.25 * g));
      out[0] = clamp(smoothstep(4, 16, h) * (1 - smoothstep(380, 560, h + 90 * g)) * (1 - smoothstep(0.75, 1.1, slope)) * smoothstep(-0.2, 0.1, n.fbm(x / 520, z / 520, 2)), 0, 1);
      out[1] = clamp(smoothstep(0.5, 3, h) * (1 - smoothstep(350, 620, h)), 0, 1);
      out[2] = smoothstep(0.62, 1.0, slope + 0.15 * g);
      out[3] = snow;
    },
    landmarks: [
      { id: 'stones', name: 'The Windstones', kind: 'stones', t: 0.28, off: 60, reach: 170, pad: 46 },
      { id: 'bell', name: 'The Bell That Waits', kind: 'bell', t: 0.56, off: -140, reach: 190, pad: 26 },
      { id: 'cairn', name: 'The Last Cairn', kind: 'cairn', t: 0.78, off: 130, reach: 170, pad: 20 },
    ],
  };
}

// --------------------------------------------------------------- IV The Red Rooms
function rooms(seed: number): Land {
  const n = new Noise(seed);
  const m = new Noise(seed + 19);
  const route = new Route([
    [0, 5200],
    [420, 4200],
    [-300, 2900],
    [-620, 1500],
    [250, 250],
    [760, -1100],
    [60, -2400],
    [-480, -3700],
    [0, -5000],
  ]);
  const grid = route.bake(HALF, 192);
  const rd = (x: number, z: number) => sampleGrid(grid.d, grid.n, grid.half, x, z);

  const terrace = (h: number, step: number, sharp: number): number => {
    const t = h / step;
    const f = Math.floor(t);
    const fr = t - f;
    const s = smoothstep(0.5 - sharp, 0.5 + sharp, fr);
    return (f + lerp(fr * 0.25, 0.75 + fr * 0.25, s)) * step;
  };

  const base = (x: number, z: number): number => {
    const wx = x + 190 * n.n(x / 900, z / 900) + 60 * m.n(x / 260, z / 260);
    const wz = z + 190 * m.n(x / 900 + 4, z / 900) + 60 * n.n(x / 260, z / 260);
    const d = rd(wx, wz);
    const plateau = 318 + 60 * n.fbm(x / 2400, z / 2400, 3);
    const floor = 10 + 18 * (0.5 + n.fbm(x / 600, z / 600, 3)) + smoothstep(200, 900, d) * 26;
    const v = smoothstep(420, 1150, d + 260 * m.fbm(x / 800, z / 800, 2));
    let h = lerp(floor, plateau, v);
    // side canyons bite back into the plateau
    const k = Math.abs(n.fbm(wx / 1500 + 7, wz / 1500, 3));
    const cut = (1 - smoothstep(0.015, 0.15, k)) * smoothstep(300, 900, d);
    h = lerp(h, floor + 34, cut * 0.94);
    // buttes standing in the open rooms
    const wd = n.worley(wx / 760, wz / 760, 0.9, 3);
    const id = n.wid;
    if (id > 0.42) {
      const rr = 0.16 + 0.2 * ((id * 7.3) % 1);
      const bh = (150 + 190 * ((id * 13.7) % 1)) * smoothstep(120, 260, rd(n.wx * 760, n.wy * 760));
      const prof = 1 - smoothstep(rr * 0.78, rr * 1.25, wd);
      h = Math.max(h, floor + bh * prof);
    }
    // small spires
    const sd = m.worley(wx / 300, wz / 300, 0.95, 11);
    if (m.wid > 0.82) {
      const prof = 1 - smoothstep(0.05, 0.2, sd);
      h = Math.max(h, floor + (60 + 70 * ((m.wid * 31) % 1)) * prof * smoothstep(90, 200, d));
    }
    // talus aprons keep cliffs from meeting the floor at a knife edge
    const ter = terrace(h, 47, 0.12);
    h = lerp(h, ter, 0.86 * smoothstep(40, 80, h));
    // the river
    const rv = rd(x + 70 * n.n(z / 420, x / 420), z) + 26 * m.n(x / 120, z / 120);
    h = lerp(-2.4, h, smoothstep(28, 92, rv));
    const s0 = Math.hypot(x, z - 5200);
    h = lerp(96, h, smoothstep(40, 190, s0));
    const l1 = Math.hypot(x * 0.8, z + 5000) + 60 * n.n(x / 200, z / 200);
    h = lerp(-2.0, h, smoothstep(150, 380, l1));
    const s1 = Math.hypot(x, (z + 5000) * 0.5);
    h = lerp(-0.15, h, smoothstep(24, 70, s1));
    return shore(h, 0.8);
  };

  return {
    id: 'rooms',
    seed,
    route,
    base,
    erosion: { droplets: 0.22, strength: 0.55 },
    detail: 2.4,
    masks(x, z, h, slope, out) {
      const g = m.fbm(x / 120, z / 120, 3);
      const wet = smoothstep(16, 2, h);
      out[0] = clamp(wet * smoothstep(0.6, 1.6, h) * (1 - smoothstep(0.5, 0.8, slope)) * smoothstep(-0.1, 0.3, n.n(x / 140, z / 140)) * 0.8, 0, 1);
      out[1] = clamp(wet * 0.9 + 0.22 * smoothstep(0.05, 0.4, g) * (1 - smoothstep(0.4, 0.7, slope)), 0, 1);
      out[2] = smoothstep(0.55, 0.95, slope);
      out[3] = clamp(0.5 + g, 0, 1); // sand drift
    },
    landmarks: [
      { id: 'arch', name: 'The Open Eye', kind: 'arch', t: 0.4, off: 0, yaw: 0, reach: 220 },
      { id: 'stonesr', name: 'The Listeners', kind: 'stones', t: 0.66, off: -230, reach: 170, pad: 44 },
      { id: 'cairnr', name: 'Thirst Cairn', kind: 'cairn', t: 0.16, off: 260, reach: 160, pad: 20 },
    ],
  };
}

// --------------------------------------------------------------- V The Long Dark Water
function darkwater(seed: number): Land {
  const n = new Noise(seed);
  const m = new Noise(seed + 55);
  const route = new Route([
    [0, 5300],
    [300, 4300],
    [-380, 2900],
    [120, 1400],
    [760, 100],
    [300, -1400],
    [-380, -2800],
    [-150, -4000],
    [0, -5000],
  ]);

  const base = (x: number, z: number): number => {
    const wx = x + 130 * n.n(x / 420, z / 420);
    const wz = z + 130 * m.n(x / 420, z / 420);
    let h = -42 + 10 * n.fbm(x / 900, z / 900, 2);
    // mainland cliffs behind the start
    const coast = z - 5000 - 520 * n.fbm(x / 1500, 3, 3) - 180 * m.n(x / 420, 1) + Math.pow(Math.abs(x) / 2600, 2) * 300;
    const land = 118 + 60 * n.fbm(x / 700, z / 700, 3) + smoothstep(600, 3200, coast) * 210;
    h = lerp(h, land, smoothstep(-40, 46, coast));
    // islands
    const wd = n.worley(wx / 1900 + 0.37, wz / 1900 + 0.21, 0.7, 5);
    if (n.wid > 0.34) {
      const rr = 0.1 + 0.11 * ((n.wid * 9.1) % 1);
      const prof = 1 - smoothstep(rr * 0.82, rr * 1.12, wd);
      const top = 46 + 110 * ((n.wid * 17.3) % 1) + 46 * n.fbm(x / 240, z / 240, 4);
      h = Math.max(h, lerp(-42, top, prof));
    }
    // sea stacks
    const sd = m.worley(wx / 520, wz / 520, 0.95, 2);
    if (m.wid > 0.66) {
      const rr = 0.05 + 0.06 * ((m.wid * 23.7) % 1);
      const prof = 1 - smoothstep(rr * 0.7, rr * 1.25, sd);
      h = Math.max(h, lerp(-42, 34 + 90 * ((m.wid * 5.3) % 1), prof));
    }
    // roost: a ring of low rock around a moonlit lagoon
    const r = Math.hypot(x, z + 5000) + 60 * n.n(x / 260, z / 260);
    const ring = 1 - smoothstep(60, 170, Math.abs(r - 560));
    const open = smoothstep(120, 260, Math.hypot(x, z + 4450)); // the mouth
    h = r < 900 ? lerp(h, -3.4, smoothstep(900, 620, r)) : h;
    h = Math.max(h, lerp(-30, 38 + 26 * n.fbm(x / 150, z / 150, 3), ring * open));
    const s1 = Math.hypot(x, (z + 5000) * 0.6);
    h = lerp(-0.16, h, smoothstep(26, 100, s1));
    const s0 = Math.hypot(x, z - 5300);
    h = lerp(126, h, smoothstep(50, 240, s0));
    return shore(h);
  };

  return {
    id: 'darkwater',
    seed,
    route,
    base,
    erosion: { droplets: 0.3, strength: 0.7 },
    detail: 3.2,
    masks(x, z, h, slope, out) {
      const g = m.fbm(x / 130, z / 130, 3);
      out[0] = clamp(smoothstep(22, 50, h) * (1 - smoothstep(0.4, 0.7, slope)) * smoothstep(0.05, 0.4, n.fbm(x / 220, z / 220, 2)) * 0.55, 0, 1);
      out[1] = clamp(smoothstep(8, 26, h + 10 * g) * (1 - smoothstep(0.6, 0.9, slope)), 0, 1);
      out[2] = smoothstep(0.5, 0.85, slope + 0.1 * g);
      out[3] = 1 - smoothstep(1, 9, h);
    },
    landmarks: [
      { id: 'light', name: 'The Keeper’s Light', kind: 'lighthouse', t: 0.42, off: 190, reach: 240, pad: 60, padY: 34 },
      { id: 'whale', name: 'The Old Swimmer', kind: 'whale', t: 0.66, off: -60, reach: 260 },
      { id: 'cairnd', name: 'Halfway Rock', kind: 'cairn', t: 0.2, off: -170, reach: 170, pad: 30, padY: 22 },
    ],
  };
}

// --------------------------------------------------------------- VI Wintering
function wintering(seed: number): Land {
  const n = new Noise(seed);
  const m = new Noise(seed + 7);
  const route = new Route([
    [0, 5000],
    [-350, 3900],
    [300, 2600],
    [520, 1200],
    [-250, -200],
    [-480, -1600],
    [150, -3000],
    [0, -4300],
  ]);
  const grid = route.bake(HALF, 128);
  const rd = (x: number, z: number) => sampleGrid(grid.d, grid.n, grid.half, x, z);

  const base = (x: number, z: number): number => {
    const wx = x + 260 * n.n(x / 1100, z / 1600) + 70 * m.n(x / 300, z / 300);
    const wz = z + 200 * m.n(x / 900, z / 900 + 3);
    // braided channels, all running home
    const c1 = Math.abs(n.n(wx / 760, wz / 2900));
    const c2 = Math.abs(m.n(wx / 420 + 5, wz / 1900));
    const c3 = Math.abs(n.n(wx / 210 + 9, wz / 900));
    let h = 1.9 + 1.5 * n.fbm(x / 260, z / 260, 3);
    h = lerp(-3.4, h, smoothstep(0.05, 0.2, c1));
    h = lerp(-2.2, h, smoothstep(0.03, 0.13, c2));
    h = lerp(-1.2, h, smoothstep(0.02, 0.09, c3));
    // it all opens into one wide shallow water
    const open = smoothstep(-1900, -4600, z + 420 * n.fbm(x / 900, z / 900, 2)) * smoothstep(3600, 1800, Math.abs(x));
    h = lerp(h, -0.85 + 1.15 * n.fbm(x / 300, z / 300, 3), open);
    const d = rd(x, z) + 500 * m.fbm(x / 1700, z / 1700, 3);
    const v = smoothstep(2600, 6200, d);
    h = lerp(h, 20 + 120 * (0.5 + 0.5 * n.n(x / 2600, z / 2600)) + 40 * n.fbm(x / 800, z / 800, 4), v);
    h += smoothstep(5200, 12000, d) * 420 * n.ridged(x / 5600, z / 5600, 4);
    const s0 = Math.hypot(x * 0.6, z - 5000);
    h = lerp(0.6, h, smoothstep(12, 60, s0));
    const s1 = Math.hypot(x, (z + 4300) * 0.7);
    h = lerp(-0.16, h, smoothstep(160, 420, s1));
    return shore(h, 0.7);
  };

  return {
    id: 'wintering',
    seed,
    route,
    base,
    erosion: { droplets: 0.06, strength: 0.4 },
    detail: 0.5,
    masks(x, z, h, slope, out) {
      const f = n.fbm(x / 420 + 4, z / 420 + 19, 3);
      const g = m.fbm(x / 160, z / 160, 2);
      const dry = smoothstep(1.6, 4, h);
      out[0] = clamp(dry * smoothstep(0.05, 0.4, f) * 0.6 * (1 - smoothstep(0.5, 0.8, slope)), 0, 1);
      out[1] = clamp(smoothstep(0.15, 0.9, h) * (0.85 + 0.3 * g), 0, 1);
      out[2] = smoothstep(0.7, 1.0, slope);
      out[3] = 1 - smoothstep(0.2, 1.3, Math.abs(h - 0.3));
    },
    landmarks: [
      { id: 'stilt', name: 'The Lamp Houses', kind: 'stilt', t: 0.36, off: -130, reach: 170, pad: 90, padY: -1.6 },
      { id: 'tree6', name: 'The Waiting Tree', kind: 'oldtree', t: 0.66, off: 130, reach: 150, pad: 36, padY: 2.4 },
    ],
  };
}

export function sampleGrid(a: Float32Array, n: number, half: number, x: number, z: number): number {
  let u = (x / (2 * half) + 0.5) * (n - 1);
  let v = (z / (2 * half) + 0.5) * (n - 1);
  // outside the baked core, extend by straight distance from the edge
  let extra = 0;
  const m = n - 1.001;
  if (u < 0) {
    extra += -u;
    u = 0;
  } else if (u > m) {
    extra += u - m;
    u = m;
  }
  if (v < 0) {
    extra += -v;
    v = 0;
  } else if (v > m) {
    extra += v - m;
    v = m;
  }
  const i = u | 0;
  const j = v | 0;
  const fx = u - i;
  const fz = v - j;
  const k = j * n + i;
  const t0 = a[k] + (a[k + 1] - a[k]) * fx;
  const t1 = a[k + n] + (a[k + n + 1] - a[k + n]) * fx;
  return t0 + (t1 - t0) * fz + extra * ((2 * half) / (n - 1));
}
