import type { BakedLand } from '../world/generate';
import { HALF, Land } from '../world/lands';
import { makeRng } from '../world/noise';
import { Heightfield, MaskField } from '../sim/terrain';
import type { Thermal } from '../sim/air';
import type { Movement } from './days';

/**
 * Thermals are strung along the road south like rungs: never over open water
 * (except the night sea, whose warmth is its own), rarely under deep forest,
 * always within reach of the last.
 */
export function placeThermals(land: Land, baked: BakedLand, mv: Movement): Thermal[] {
  const rng = makeRng(land.seed * 7919 + 17);
  const hf = new Heightfield(baked.height, baked.n, HALF, baked.far, baked.nFar, baked.farHalf);
  const mask = new MaskField(baked.mask, baked.n, HALF);
  const out: Thermal[] = [];
  const n = mv.air.thermals;
  for (let i = 0; i < n; i++) {
    const t = (i === 0 ? 0.04 : 0.055 + (i / Math.max(1, n - 1)) * 0.8) + (rng() - 0.5) * 0.015;
    const [rx, rz] = land.route.at(t);
    const [dx, dz] = land.route.dir(t);
    let best = -1e9;
    let bx = rx;
    let bz = rz;
    for (let k = 0; k < 14; k++) {
      const off = (rng() - 0.5) * (i === 0 ? 260 : 620);
      const along = (rng() - 0.5) * 260;
      const x = rx - dz * off + dx * along;
      const z = rz + dx * off + dz * along;
      const h = hf.heightAt(x, z);
      let score = rng() * 0.4 - Math.abs(off) / 1200;
      if (h < 0 && land.id !== 'darkwater' && land.id !== 'wintering') score -= 2;
      score -= mask.at(x, z, 0) * 0.8;
      if (land.id === 'stair') score += h / 900;
      if (score > best) {
        best = score;
        bx = x;
        bz = z;
      }
    }
    const ground = Math.max(0, hf.heightAt(bx, bz));
    out.push({
      x: bx,
      z: bz,
      radius: mv.air.radius * (i === 0 ? 1.35 : 0.8 + rng() * 0.5),
      strength: mv.air.strength * (i === 0 ? 1.05 : 0.82 + rng() * 0.36),
      top: Math.max(mv.air.top * (0.85 + rng() * 0.3), ground + 320),
      ground,
    });
  }
  // and a few off the road, for wanderers
  for (let i = 0; i < Math.ceil(n * 0.7); i++) {
    const t = 0.1 + rng() * 0.8;
    const [rx, rz] = land.route.at(t);
    const [dx, dz] = land.route.dir(t);
    const off = (rng() < 0.5 ? -1 : 1) * (1100 + rng() * 1500);
    const x = rx - dz * off;
    const z = rz + dx * off;
    const h = hf.heightAt(x, z);
    if (h < 0 && land.id !== 'darkwater' && land.id !== 'wintering') continue;
    const ground = Math.max(0, h);
    out.push({
      x,
      z,
      radius: mv.air.radius * (0.8 + rng() * 0.6),
      strength: mv.air.strength * (0.8 + rng() * 0.5),
      top: Math.max(mv.air.top * (0.9 + rng() * 0.4), ground + 320),
      ground,
    });
  }
  return out;
}

/** The glowing currents of the night sea: lift you can see in the water. */
export function placeCurrents(land: Land): Array<{ x: number; z: number }[]> {
  if (land.id !== 'darkwater') return [];
  const rng = makeRng(land.seed * 31 + 3);
  const lines: Array<{ x: number; z: number }[]> = [];
  const spans: Array<[number, number, number]> = [
    [0.1, 0.34, -60],
    [0.36, 0.6, 90],
    [0.62, 0.86, -70],
  ];
  for (const [a, b, off0] of spans) {
    const l: { x: number; z: number }[] = [];
    for (let i = 0; i <= 22; i++) {
      const t = a + ((b - a) * i) / 22;
      const [x, z] = land.route.at(t);
      const [dx, dz] = land.route.dir(t);
      const off = off0 + Math.sin(i * 0.7 + rng()) * 70;
      l.push({ x: x - dz * off, z: z + dx * off });
    }
    lines.push(l);
  }
  return lines;
}
