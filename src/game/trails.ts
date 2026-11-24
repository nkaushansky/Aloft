import type { World } from './world';
import { makeRng } from '../world/noise';

export interface Feather {
  x: number;
  y: number;
  z: number;
  /** which phrase it belongs to */
  trail: number;
  taken: boolean;
  a: number;
}

/**
 * The flock sheds feathers along the good air. Each trail is a lesson drawn
 * as a line: a spiral up a thermal, a run along a ridge, a skim over water.
 */
export function layFeathers(w: World): Feather[] {
  const rng = makeRng(w.land.seed * 97 + 41);
  const out: Feather[] = [];
  let trail = 0;
  const route = w.land.route;
  const surf = (x: number, z: number) => w.surfaceY(x, z);
  const push = (x: number, y: number, z: number) => out.push({ x, y: Math.max(y, surf(x, z) + 4), z, trail, taken: false, a: 1 });

  // up the thermals near the road
  for (const t of w.thermals.thermals.slice(0, w.mv.air.thermals)) {
    if (rng() < 0.25 && trail > 1) continue;
    const n = 9;
    const R = t.radius * 0.36;
    const a0 = rng() * 6.28;
    const y0 = t.ground + 46;
    const y1 = Math.min(t.top * 0.78, y0 + 190);
    for (let i = 0; i < n; i++) {
      const a = a0 + (i / n) * 8.2;
      push(t.x + Math.cos(a) * R, y0 + ((y1 - y0) * i) / (n - 1), t.z + Math.sin(a) * R);
    }
    trail++;
  }

  // along the road, a gentle wandering line
  const segs = 8;
  for (let s = 0; s < segs; s++) {
    const t0 = 0.07 + (s / segs) * 0.86;
    const n = 7;
    const off0 = (rng() - 0.5) * 120;
    const base = 46 + rng() * 60;
    const [x0, z0] = route.at(t0);
    const water = w.terrain.heightAt(x0, z0) < -0.8;
    const skim = water && rng() < 0.65;
    for (let i = 0; i < n; i++) {
      const t = t0 + (i * 42) / route.total;
      const [x, z] = route.at(t);
      const [dx, dz] = route.dir(t);
      const off = off0 + Math.sin(i * 0.5 + s) * 18;
      const px = x - dz * off;
      const pz = z + dx * off;
      const y = skim ? surf(px, pz) + 3.4 : surf(px, pz) + base - i * 2.6;
      push(px, y, pz);
    }
    trail++;
  }

  // through and over the places
  for (const l of w.baked.landmarks) {
    const n = 5;
    const dx = -Math.sin(l.yaw);
    const dz = -Math.cos(l.yaw);
    const lift = l.kind === 'viaduct' ? 20 : l.kind === 'arch' ? 42 : l.kind === 'whale' ? 7 : 26;
    for (let i = 0; i < n; i++) {
      const u = (i - (n - 1) / 2) * 17;
      const side = l.kind === 'viaduct' ? 17 : l.kind === 'arch' || l.kind === 'whale' ? 0 : 24;
      const gx = l.kind === 'viaduct' ? Math.cos(l.yaw) * side - Math.sin(l.yaw) * u : l.x + 0;
      const gz = l.kind === 'viaduct' ? -Math.sin(l.yaw) * side - Math.cos(l.yaw) * u : l.z + 0;
      if (l.kind === 'viaduct') {
        const y = Math.max(surf(l.x + gx, l.z + gz) + 7, 18);
        push(l.x + gx, y, l.z + gz);
      } else push(gx + dx * u - dz * side, surf(l.x, l.z) + lift + Math.sin(i) * 2, gz + dz * u + dx * side);
    }
    trail++;
  }
  return out;
}
