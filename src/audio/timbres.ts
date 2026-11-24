/**
 * The instruments. Sustained colours are grown in the frequency domain (each
 * partial is a little cloud rather than a line, so one voice is already an
 * ensemble) and struck ones are summed from decaying partials. Both end up as
 * plain AudioBuffers, so playing a note costs one source node.
 */
import { FFT_N, Job, LATER, Need, Rng, TAU, bell, clamp, fadeEnds, fft, fftScratch, gauss, mtof, settleLevel, semis, sinTurns, spread, toBuffer } from './dsp';
import type { Workshop } from './dsp';

// ------------------------------------------------------------ sustained
export type PadKind = 'strings' | 'deep' | 'glass' | 'wood' | 'bell' | 'brass' | 'choir';

/** Pads are dark, so they live happily at a low rate. */
export const PAD_RATE = 24000;

interface Part {
  /** ratio to the fundamental */
  r: number;
  a: number;
  /** half-width of the partial's cloud, cents */
  w: number;
}

function partsOf(kind: PadKind, f0: number): Part[] {
  const out: Part[] = [];
  const top = Math.min(6500, PAD_RATE * 0.42);
  const n = Math.max(1, Math.min(40, Math.floor(top / f0)));
  const harm = (amp: (k: number, f: number) => number, w: (k: number) => number): void => {
    for (let k = 1; k <= n; k++) {
      const a = amp(k, k * f0);
      if (a > 1e-4) out.push({ r: k, a, w: w(k) });
    }
  };
  switch (kind) {
    case 'strings':
      harm(
        (k, f) => (Math.pow(k, -1.2) * (0.55 + 0.65 * bell(f, 310, 150) + 0.75 * bell(f, 760, 320) + 0.45 * bell(f, 1500, 520))) / (1 + Math.pow(f / 2800, 4)),
        (k) => 17 + 3.2 * Math.sqrt(k),
      );
      break;
    case 'deep':
      harm(
        (k, f) => (Math.pow(k, -1.12) * (0.5 + 0.8 * bell(f, 250, 120) + 0.6 * bell(f, 540, 220) + 0.3 * bell(f, 1050, 300))) / (1 + Math.pow(f / 1500, 4)),
        (k) => 10 + 2 * Math.sqrt(k),
      );
      break;
    case 'choir':
      harm(
        (k, f) =>
          Math.pow(k, -0.55) *
          (0.12 + 0.95 * bell(f, 460, 150) + 0.62 * bell(f, 870, 170) + 0.13 * bell(f, 2650, 330) + 0.05 * bell(f, 3300, 300)),
        (k) => 22 + 2.4 * Math.sqrt(k),
      );
      // breath around the voices
      out.push({ r: 1, a: 0.07, w: 230 }, { r: 2, a: 0.045, w: 200 });
      break;
    case 'brass':
      harm(
        (k, f) => (Math.pow(k, -0.75) * (0.6 + 0.8 * bell(f, 520, 260))) / (1 + Math.pow(f / 1050, 4.2)),
        (k) => 8 + 1.2 * Math.sqrt(k),
      );
      break;
    case 'wood':
      // reeds and bowed wood: odd harmonics, a hollow middle
      harm(
        (k, f) => ((k % 2 ? 1 : 0.2) * Math.pow(k, -1.15) * (0.6 + 0.6 * bell(f, 600, 300))) / (1 + Math.pow(f / 2100, 4)),
        (k) => 11 + 1.6 * Math.sqrt(k),
      );
      break;
    case 'glass':
      for (const [r, a, w] of [
        [1, 1, 8],
        [2, 0.34, 8],
        [3, 0.12, 9],
        [4, 0.085, 9],
        [5, 0.03, 10],
        [6, 0.022, 10],
      ])
        out.push({ r, a, w });
      out.push({ r: 1, a: 0.05, w: 160 });
      break;
    case 'bell':
      // bowed metal, tuned so the twelfth and the double octave ring true
      for (const [r, a, w] of [
        [0.5, 0.18, 5],
        [1, 1, 5],
        [2, 0.4, 5],
        [3, 0.2, 6],
        [4.02, 0.12, 6],
        [5.43, 0.035, 6],
        [6.8, 0.015, 6],
      ])
        out.push({ r, a, w });
      out.push({ r: 2, a: 0.03, w: 120 });
      break;
  }
  return out.filter((p) => p.r * f0 < top);
}

function* renderPad(ctx: BaseAudioContext, kind: PadKind, midi: number, rng: Rng, done: (b: AudioBuffer) => void): Job {
  const f0 = mtof(midi);
  const { re, im } = fftScratch();
  re.fill(0);
  im.fill(0);
  const bin = FFT_N / PAD_RATE;
  const half = FFT_N / 2;
  // magnitudes into re[]
  for (const p of partsOf(kind, f0)) {
    const c = p.r * f0 * bin;
    const s = Math.max(0.35, c * (semis(p.w / 100) - 1));
    const lo = Math.max(2, Math.floor(c - 4 * s - 1));
    const hi = Math.min(half - 1, Math.ceil(c + 4 * s + 1));
    const k = p.a / Math.sqrt(s);
    for (let i = lo; i <= hi; i++) {
      const d = (i - c) / s;
      re[i] += k * Math.exp(-0.5 * d * d);
    }
  }
  yield;
  let pow = 0;
  for (let i = 2; i < half; i++) {
    const m = re[i];
    if (m < 1e-7) {
      re[i] = 0;
      continue;
    }
    pow += m * m;
    // independent phases either side of zero: left and right become two
    // different rooms of the same players
    const a = rng() * TAU;
    const b = rng() * TAU;
    re[i] = m * Math.cos(a);
    im[i] = m * Math.sin(a);
    re[FFT_N - i] = m * Math.cos(b);
    im[FFT_N - i] = m * Math.sin(b);
    if ((i & 8191) === 0) yield;
  }
  yield;
  yield* fft(re, im);
  // per-channel mean square of the sum is `pow`
  const g = 0.1 / Math.sqrt(Math.max(1e-12, pow));
  const out = ctx.createBuffer(2, FFT_N, PAD_RATE);
  const L = out.getChannelData(0);
  const R = out.getChannelData(1);
  for (let i = 0; i < FFT_N; i++) {
    L[i] = re[i] * g;
    R[i] = im[i] * g;
    if ((i & 65535) === 65535) yield;
  }
  done(out);
}

// --------------------------------------------------------------- struck
export type NoteKind = 'felt' | 'harp' | 'glass' | 'wood' | 'bell' | 'vibes' | 'horn';

export const NOTE_RATE = 32000;

/** Adds one decaying sinusoid. tau: seconds to fall to 1/e. */
function addPartial(out: Float32Array, rate: number, f: number, amp: number, tau: number, phase: number): void {
  if (f > rate * 0.42 || amp < 1e-5) return;
  const w = (TAU * f) / rate;
  const r = Math.exp(-1 / (tau * rate));
  const c = Math.cos(w) * r;
  const s = Math.sin(w) * r;
  let x = Math.cos(phase) * amp;
  let y = Math.sin(phase) * amp;
  const n = Math.min(out.length, Math.ceil(tau * rate * 7));
  for (let i = 0; i < n; i++) {
    out[i] += y;
    const nx = x * c - y * s;
    y = x * s + y * c;
    x = nx;
  }
}

/** A breath of dark noise at the start of a note: felt, fingertip, mallet. */
function addThump(out: Float32Array, rate: number, rng: Rng, cutoff: number, tau: number, amp: number): void {
  const k = 1 - Math.exp((-TAU * cutoff) / rate);
  let a = 0;
  let b = 0;
  const n = Math.min(out.length, Math.ceil(tau * rate * 6));
  const atk = 0.004 * rate;
  for (let i = 0; i < n; i++) {
    a += (gauss(rng) - a) * k;
    b += (a - b) * k;
    const e = Math.exp(-i / (tau * rate)) * Math.min(1, i / atk);
    out[i] += b * e * amp;
  }
}

function* renderNote(ctx: BaseAudioContext, kind: NoteKind, midi: number, rng: Rng, done: (b: AudioBuffer) => void): Job {
  const f0 = mtof(midi);
  const sr = NOTE_RATE;
  const high = clamp((midi - 48) / 44);
  const len = { felt: 5.2 - 2 * high, harp: 4.2 - 1.6 * high, glass: 5.2 - 1.2 * high, wood: 2.4 - 0.8 * high, bell: 6.4 - 1.4 * high, vibes: 5.6 - 1.4 * high, horn: 3.6 }[kind];
  const out = new Float32Array(Math.floor(len * sr));
  let attack = 0.006;
  switch (kind) {
    case 'felt': {
      // a hammer wrapped in wool: few partials, each a pair that slowly beats
      attack = 0.011;
      const B = 0.00032 * Math.pow(2, (midi - 60) / 14);
      for (let k = 1; k <= 14; k++) {
        const f = k * f0 * Math.sqrt(1 + B * k * k);
        const a = Math.exp(-0.62 * (k - 1)) * (0.35 + 0.65 * Math.abs(Math.sin(Math.PI * k * 0.13))) * (k === 1 ? 1.15 : 1.5);
        const slow = (2.0 - 1.1 * high) / (1 + 0.16 * (k - 1));
        const fast = 0.34 * slow;
        const d = semis(0.006 + 0.004 * rng());
        addPartial(out, sr, f, a * 0.62, fast, rng() * TAU);
        addPartial(out, sr, f * d, a * 0.36, slow, rng() * TAU);
        addPartial(out, sr, f / d, a * 0.3, slow * 0.92, rng() * TAU);
        if (k % 2 === 0) yield;
      }
      addThump(out, sr, rng, 260, 0.034, 1.0);
      break;
    }
    case 'harp': {
      attack = 0.009;
      for (let k = 1; k <= 18; k++) {
        const f = k * f0 * Math.sqrt(1 + 0.00009 * k * k);
        const a = (Math.abs(Math.sin(Math.PI * k * 0.37)) / Math.pow(k, 1.15)) * Math.exp(-0.1 * k);
        const tau = (1.35 - 0.75 * high) / (1 + 0.2 * (k - 1));
        addPartial(out, sr, f, a, tau, rng() * TAU);
        addPartial(out, sr, f * semis(0.01), a * 0.35, tau * 1.25, rng() * TAU);
        if (k % 3 === 0) yield;
      }
      addThump(out, sr, rng, 620, 0.016, 0.4);
      break;
    }
    case 'glass': {
      attack = 0.028;
      const parts = [
        [1, 1, 1.5],
        [2.0, 0.3, 1.1],
        [3.0, 0.1, 0.7],
        [4.02, 0.07, 0.5],
        [5.4, 0.03, 0.34],
      ];
      for (const [r, a, t] of parts) {
        const d = semis(0.012 + 0.008 * rng());
        const tau = t * (1.1 - 0.3 * high);
        addPartial(out, sr, f0 * r * d, a * 0.6, tau, rng() * TAU);
        addPartial(out, sr, (f0 * r) / d, a * 0.55, tau * 0.94, rng() * TAU);
        yield;
      }
      break;
    }
    case 'wood': {
      // a low marimba bar over its tuned tube
      attack = 0.011;
      const t0 = 0.66 - 0.36 * high;
      addPartial(out, sr, f0, 1, t0, 0);
      addPartial(out, sr, f0 * semis(0.015), 0.28, t0 * 1.35, rng() * TAU);
      yield;
      addPartial(out, sr, f0 * 2.0, 0.07, t0 * 0.6, rng() * TAU);
      addPartial(out, sr, f0 * 3.97, 0.2, t0 * 0.24, rng() * TAU);
      addPartial(out, sr, f0 * 9.3, 0.035, t0 * 0.07, rng() * TAU);
      addThump(out, sr, rng, 420, 0.02, 0.6);
      break;
    }
    case 'bell': {
      attack = 0.009;
      const parts = [
        [0.5, 0.16, 2.4],
        [1, 1, 1.9],
        [2, 0.34, 1.4],
        [3.0, 0.14, 0.9],
        [4.18, 0.11, 0.62],
        [5.43, 0.045, 0.36],
        [6.8, 0.02, 0.22],
      ];
      for (const [r, a, t] of parts) {
        const d = semis(0.008 + 0.012 * rng());
        const tau = t * (1.1 - 0.35 * high);
        addPartial(out, sr, f0 * r * d, a * 0.6, tau, rng() * TAU);
        addPartial(out, sr, (f0 * r) / d, a * 0.5, tau * 0.9, rng() * TAU);
        yield;
      }
      break;
    }
    case 'vibes': {
      attack = 0.012;
      addPartial(out, sr, f0 * 0.5, 0.2, 1.3, rng() * TAU);
      addPartial(out, sr, f0, 1, 1.7 - 0.5 * high, 0);
      addPartial(out, sr, f0 * semis(0.02), 0.35, 1.9 - 0.5 * high, rng() * TAU);
      yield;
      addPartial(out, sr, f0 * 2.0, 0.16, 1.1, rng() * TAU);
      addPartial(out, sr, f0 * 3.99, 0.12, 0.6, rng() * TAU);
      addThump(out, sr, rng, 320, 0.022, 0.8);
      yield;
      // the slow fan
      for (let i = 0; i < out.length; i++) out[i] *= 1 + 0.13 * sinTurns((i / sr) * 3.4);
      break;
    }
    case 'horn': {
      // a horn two hills away: the harmonics arrive in order and leave in order
      attack = 0.02;
      const kMax = Math.min(12, Math.floor(3400 / f0));
      const inc = f0 / sr;
      const rise = 0.34;
      const hold = 1.15;
      for (let k = 1; k <= kMax; k++) {
        const f = k * f0;
        const a = (Math.pow(k, -0.6) * (0.55 + 0.75 * bell(f, 540, 280))) / (1 + Math.pow(f / 1300, 3.4));
        if (a < 1e-3) continue;
        const det = 1 + spread(rng, 0.0004);
        const ph = rng();
        const pw = 1 + 0.34 * (k - 1);
        let env = 0;
        let step = 0;
        for (let i = 0; i < out.length; i++) {
          if ((i & 63) === 0) {
            const t = (i + 64) / sr;
            const up = clamp(t / rise);
            const e = up * up * (3 - 2 * up) * (t < hold ? 0.86 + 0.14 * Math.sin((Math.PI * t) / hold) : 0.86 * Math.exp(-(t - hold) / 0.5));
            const next = a * Math.pow(e, pw);
            step = (next - env) / 64;
          }
          env += step;
          const t = i / sr;
          const vib = 0.0011 * Math.min(1, t / 0.9) * sinTurns(t * 4.7);
          out[i] += env * sinTurns(ph + i * inc * k * det + vib * 12 * k);
        }
        yield;
      }
      break;
    }
  }
  settleLevel(out, sr, 0.16);
  fadeEnds(out, sr, attack, Math.min(0.9, len * 0.3));
  // a hair of air taken off, so nothing ever ticks
  let z = out[0];
  const lpHz = kind === 'felt' ? 5200 : kind === 'wood' ? 5200 : 7200;
  const k = 1 - Math.exp((-TAU * lpHz) / sr);
  for (let i = 0; i < out.length; i++) {
    z += (out[i] - z) * k;
    out[i] = z;
  }
  yield;
  done(toBuffer(ctx, [out], sr));
}

// ------------------------------------------------------------------ bank
export interface Zone {
  buf: AudioBuffer;
  rate: number;
}

/** Grows instruments on request and lends them out. */
export class Bank {
  private pads = new Map<string, AudioBuffer | null>();
  private notes = new Map<string, AudioBuffer | null>();

  constructor(
    private ctx: BaseAudioContext,
    private shop: Workshop,
    private rng: Rng,
  ) {}

  private padZone = (m: number): number => Math.round((m - 36) / 5) * 5 + 36;
  private noteZone = (m: number): number => Math.round((m - 48) / 4) * 4 + 48;

  wantPad(kind: PadKind, midi: number, need: Need = LATER): void {
    const z = this.padZone(midi);
    const key = kind + z;
    if (this.pads.has(key)) return;
    this.pads.set(key, null);
    this.shop.add(
      renderPad(this.ctx, kind, z, this.rng, (b) => this.pads.set(key, b)),
      need,
    );
  }

  wantNote(kind: NoteKind, midi: number, need: Need = LATER): void {
    const z = this.noteZone(midi);
    const key = kind + z;
    if (this.notes.has(key)) return;
    this.notes.set(key, null);
    this.shop.add(
      renderNote(this.ctx, kind, z, this.rng, (b) => this.notes.set(key, b)),
      need,
    );
  }

  wantNotes(kind: NoteKind, lo: number, hi: number, need: Need = LATER): void {
    for (let m = lo; m <= hi; m += 2) this.wantNote(kind, m, need);
  }

  pad(kind: PadKind, midi: number): Zone | null {
    const z0 = this.padZone(midi);
    for (let d = 0; d <= 5; d += 5) {
      for (const z of d === 0 ? [z0] : [z0 + d, z0 - d]) {
        const b = this.pads.get(kind + z);
        if (b) return { buf: b, rate: semis(midi - z) };
      }
    }
    return null;
  }

  note(kind: NoteKind, midi: number): Zone | null {
    const z0 = this.noteZone(midi);
    for (let d = 0; d <= 12; d += 4) {
      for (const z of d === 0 ? [z0] : [z0 + d, z0 - d]) {
        const b = this.notes.get(kind + z);
        if (b) return { buf: b, rate: semis(midi - z) };
      }
    }
    return null;
  }

  /** Let go of instruments no land is using any more. */
  retain(pads: Set<PadKind>, notes: Set<NoteKind>): void {
    const name = (k: string): string => k.replace(/-?\d+$/, '');
    for (const k of [...this.pads.keys()]) if (!pads.has(name(k) as PadKind)) this.pads.delete(k);
    for (const k of [...this.notes.keys()]) if (!notes.has(name(k) as NoteKind)) this.notes.delete(k);
  }
}
