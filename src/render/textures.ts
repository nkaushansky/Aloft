import * as THREE from 'three';
import { makeRng } from '../world/noise';

/** Tileable lattice noise helpers for the shared texture. */
function tileNoise(seed: number) {
  const rng = makeRng(seed);
  const T = 256;
  const gx = new Float32Array(T * T);
  const gy = new Float32Array(T * T);
  for (let i = 0; i < T * T; i++) {
    const a = rng() * Math.PI * 2;
    gx[i] = Math.cos(a);
    gy[i] = Math.sin(a);
  }
  return (x: number, y: number, period: number): number => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const w = (i: number) => ((i % period) + period) % period;
    const g = (i: number, j: number, dx: number, dy: number) => {
      const k = w(j) * T + w(i);
      return gx[k] * dx + gy[k] * dy;
    };
    const a = g(xi, yi, fx, fy);
    const b = g(xi + 1, yi, fx - 1, fy);
    const c = g(xi, yi + 1, fx, fy - 1);
    const d = g(xi + 1, yi + 1, fx - 1, fy - 1);
    return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 1.45;
  };
}

/**
 * The one noise texture everything samples: R fbm, G cellular, B painted
 * brush-dabs, A white noise. Tileable, mipmapped, generated at boot.
 */
export function makeNoiseTexture(size = 512): THREE.DataTexture {
  const data = new Uint8Array(size * size * 4);
  const n = tileNoise(7);
  const rng = makeRng(99);

  // R — fbm
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let s = 0;
      let a = 0.5;
      let p = 8;
      for (let o = 0; o < 5; o++) {
        s += n((x / size) * p, (y / size) * p, p) * a;
        a *= 0.52;
        p *= 2;
      }
      data[(y * size + x) * 4] = Math.max(0, Math.min(255, Math.round((s * 0.95 * 0.5 + 0.5) * 255)));
    }
  }

  // G — cellular (two octaves), tileable
  const cells = (per: number, salt: number) => {
    const r = makeRng(salt);
    const pts: number[] = [];
    for (let i = 0; i < per * per; i++) pts.push(r(), r());
    return (u: number, v: number) => {
      const x = u * per;
      const y = v * per;
      const cx = Math.floor(x);
      const cy = Math.floor(y);
      let best = 9;
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const gx = cx + i;
          const gy = cy + j;
          const k = ((((gy % per) + per) % per) * per + (((gx % per) + per) % per)) * 2;
          const dx = gx + pts[k] - x;
          const dy = gy + pts[k + 1] - y;
          const d = dx * dx + dy * dy;
          if (d < best) best = d;
        }
      return Math.sqrt(best);
    };
  };
  const c1 = cells(32, 5);
  const c2 = cells(64, 6);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = c1(x / size, y / size) * 0.72 + c2(x / size, y / size) * 0.28;
      data[(y * size + x) * 4 + 1] = Math.max(0, Math.min(255, Math.round((1 - d) * 255)));
    }
  }

  // B — brush dabs: thousands of soft strokes laid over one another
  const dab = new Float32Array(size * size).fill(0.5);
  const strokes = Math.floor(size * size * 0.028);
  for (let s = 0; s < strokes; s++) {
    const cx = rng() * size;
    const cy = rng() * size;
    const len = 9 + rng() * 20;
    const wid = 2.2 + rng() * 4.2;
    const ang = (rng() - 0.5) * 1.1;
    const tone = 0.5 + (rng() - 0.5) * 0.9;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const R = Math.ceil(len);
    for (let j = -R; j <= R; j++) {
      for (let i = -R; i <= R; i++) {
        const u = (i * ca + j * sa) / len;
        const v = (-i * sa + j * ca) / wid;
        const bristle = 0.8 + 0.2 * Math.sin(v * 9 + s);
        const d = u * u + v * v;
        if (d > 1) continue;
        const a = Math.pow(1 - d, 0.7) * 0.6 * bristle;
        const xx = (((Math.floor(cx) + i) % size) + size) % size;
        const yy = (((Math.floor(cy) + j) % size) + size) % size;
        const k = yy * size + xx;
        dab[k] += (tone - dab[k]) * a;
      }
    }
  }
  for (let i = 0; i < size * size; i++) {
    data[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(dab[i] * 255)));
    data[i * 4 + 3] = Math.floor(rng() * 256);
  }

  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}
