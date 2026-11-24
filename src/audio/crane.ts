/**
 * The voice. One model from fledgling to bugle: a pulsed, two-sided source
 * (a bird sings with both halves of its syrinx) pushed through the resonances
 * of a long coiled windpipe. Age lengthens the pipe: the thin reedy trill of a
 * first autumn drops, cracks, roughens and finally opens into the rolling
 * "kar-r-roo" that carries for miles.
 */
import { Job, Rng, TAU, bell, clamp, gauss, lerp, settleLevel, sinTurns, smooth, spread, toBuffer } from './dsp';

export const CRANE_RATE = 32000;
/** pitch of the held part of an adult call (Hz); callers retune from here */
export const ADULT_F0 = 640;

export interface CraneCall {
  buf: AudioBuffer;
  /** sustained pitch, Hz */
  f0: number;
  age: number;
}

/** Held pitch by age: a long easy fall of a little over two octaves. */
export const pitchOf = (age: number): number => 2850 * Math.pow(ADULT_F0 / 2850, Math.pow(clamp(age), 0.92));

export function* renderCrane(ctx: BaseAudioContext, ageIn: number, rng: Rng, done: (c: CraneCall) => void): Job {
  const age = clamp(ageIn);
  const sr = CRANE_RATE;
  const grown = smooth(0.3, 0.95, age); // two-part shape, pulses, resonance
  const breakV = bell(age, 0.5, 0.17); // the years the voice cracks
  const f0 = pitchOf(age) * (1 + spread(rng, 0.012));
  const dur = lerp(0.66, 1.18, smooth(0, 0.85, age)) * (1 + spread(rng, 0.06));
  const tail = 0.12;
  const n = Math.floor((dur + tail) * sr);
  const out = new Float32Array(n);

  // --- control curves, every 32 samples
  const H = 32;
  const m = Math.ceil(n / H) + 2;
  const pitch = new Float32Array(m); // multiplier on f0
  const amp = new Float32Array(m);
  const puls = new Float32Array(m); // amplitude pulse 0..1
  const bright = new Float32Array(m);

  const split = 0.3 * dur; // where "kar-r" opens into "roo"
  const rate = lerp(31, 25.5, grown) * (1 + spread(rng, 0.05)); // pulses a second
  let pp = rng();
  let wob = 0;
  let wobT = 0;
  let fast = 0;
  let pulseAmp = 1;
  for (let i = 0; i < m; i++) {
    const t = (i * H) / sr;
    const u = clamp(t / dur);
    // slow wander and a fine grain
    if (i % 60 === 0) wobT = spread(rng, 0.007);
    wob += (wobT - wob) * 0.02;
    fast += (spread(rng, 0.004) - fast) * 0.3;

    // adult shape: an approach, a step up, an arch, a fall
    const step = smooth(split - 0.05, split + 0.09, t);
    const adultP = lerp(0.82 + 0.08 * smooth(0, split, t), 1, step) + 0.045 * Math.sin(Math.PI * smooth(0.28, 1, u)) - 0.085 * smooth(0.74, 1, u);
    // young shape: one falling reed
    const youngP = 1.07 - 0.04 * u - 0.15 * smooth(0.45, 1, u) + 0.05 * Math.sin(Math.PI * smooth(0, 0.35, u));
    let p = lerp(youngP, adultP, grown);

    // pulses: slow a touch as the breath runs out
    const r = rate * (1 - 0.1 * u);
    const before = Math.floor(pp);
    pp += (r * H) / sr;
    if (Math.floor(pp) !== before) pulseAmp = 1 + spread(rng, 0.1);
    const c = 0.5 + 0.5 * Math.cos(TAU * (pp - Math.floor(pp)));
    const shape = Math.pow(c, lerp(1.2, 1.9, grown));
    const depthAdult = lerp(0.94, 0.62, smooth(split * 0.8, dur * 0.95, t));
    const depth = lerp(0.7, depthAdult, grown);
    puls[i] = 1 - depth + depth * shape * pulseAmp;
    // the trill rides on pitch in the young, barely in the old
    p *= 1 + (c - 0.5) * lerp(0.15, 0.022, smooth(0, 0.8, age));
    // a crack: the pitch slips and finds itself again
    p *= 1 + 0.12 * breakV * bell(u, 0.36, 0.05) - 0.07 * breakV * bell(u, 0.64, 0.06);
    pitch[i] = p * (1 + wob + fast);

    // breath
    const on = smooth(0, lerp(0.05, 0.055, grown), t);
    const off = 1 - smooth(lerp(0.62, 0.72, grown), 1, u);
    const dip = 1 - 0.5 * grown * bell(t, split, 0.035);
    const kar = lerp(1, 0.66, grown * (1 - step));
    const swell = 0.82 + 0.18 * Math.sin(Math.PI * clamp((u - 0.2) / 0.8));
    amp[i] = on * off * dip * kar * swell;
    bright[i] = lerp(0.72, 1, smooth(0, 0.3, u)) * (1 - 0.45 * smooth(0.6, 1, u));
  }
  yield;

  // --- the windpipe: where each harmonic lands
  const tract = (f: number): number => {
    const a =
      0.18 + 0.42 * bell(f, 660, 190) + 1.05 * bell(f, 1120, 230) + 1.25 * bell(f, 1700, 320) + 0.8 * bell(f, 2400, 340) + 0.13 * bell(f, 3300, 420);
    const y = 0.25 + 1.0 * bell(f, 2700, 800) + 0.35 * bell(f, 1500, 500);
    return lerp(y, a, smooth(0.1, 0.85, age)) / (1 + Math.pow(f / lerp(6200, 4300, age), 6));
  };

  // two sides of the syrinx, a hair apart, and in the breaking years a third:
  // the old small voice, still there
  const sides = [
    { mul: 1, a: 1, kMax: 14 },
    { mul: 1 + lerp(0.006, 0.0125, grown) + spread(rng, 0.003), a: lerp(0.28, 0.42, grown), kMax: 12 },
    { mul: (pitchOf(0.12) / f0) * 1.0, a: 0.2 * breakV, kMax: 1 },
  ];
  const roll = lerp(1.5, 0.5, smooth(0.05, 0.8, age));
  for (const s of sides) {
    if (s.a < 0.01) continue;
    for (let k = 1; k <= s.kMax; k++) {
      const fk = f0 * s.mul * k;
      if (fk > 6800) break;
      const a0 = s.a * Math.pow(k, -roll) * tract(fk);
      if (a0 < 0.004) continue;
      let ph = rng();
      let env = 0;
      let inc = (fk * pitch[0]) / sr;
      // upper harmonics open with the breath and sharpen the pulse
      const open = 1 + 0.1 * (k - 1);
      for (let j = 0; j + 1 < m; j++) {
        const i0 = j * H;
        if (i0 >= n) break;
        const i1 = Math.min(n, i0 + H);
        const e1 = a0 * amp[j + 1] * Math.pow(puls[j + 1], open) * Math.pow(bright[j + 1], k - 1);
        const inc1 = (fk * pitch[j + 1]) / sr;
        const de = (e1 - env) / H;
        const di = (inc1 - inc) / H;
        for (let i = i0; i < i1; i++) {
          env += de;
          inc += di;
          ph += inc;
          out[i] += env * sinTurns(ph);
        }
        env = e1;
        inc = inc1;
      }
      if (k % 2 === 0) yield;
    }
    yield;
  }

  // --- breath noise, through the same pipe, riding the pulses
  const fc = lerp(2900, 1250, smooth(0, 0.8, age));
  const q = 2.2;
  const w0 = (TAU * fc) / sr;
  const alpha = Math.sin(w0) / (2 * q);
  const b0 = alpha / (1 + alpha);
  const a1 = (-2 * Math.cos(w0)) / (1 + alpha);
  const a2 = (1 - alpha) / (1 + alpha);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  const nz = lerp(0.2, 0.16, grown);
  for (let i = 0; i < n; i++) {
    const x = gauss(rng);
    const y = b0 * (x - x2) - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    const j = (i / H) | 0;
    out[i] += y * nz * amp[j] * puls[j];
  }
  yield;

  settleLevel(out, sr, 0.17, 0.25);
  // everything leaves and arrives softly
  const inN = Math.floor(0.012 * sr);
  for (let i = 0; i < inN; i++) out[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / inN);
  const outN = Math.floor(0.1 * sr);
  for (let i = 0; i < outN; i++) out[n - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / outN);
  done({ buf: toBuffer(ctx, [out], sr), f0, age });
}
