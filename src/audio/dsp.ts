/**
 * Small tools the whole audio layer leans on: easing, randomness, a sliced
 * FFT, and the Workshop — everything Aloft plays is synthesised at run time,
 * a few milliseconds at a time, so nothing ever costs a frame.
 */
export const TAU = Math.PI * 2;

/** Also the place where a stray NaN quietly becomes the lower bound. */
export const clamp = (x: number, a = 0, b = 1): number => (x > a ? (x < b ? x : b) : a);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smooth = (a: number, b: number, x: number): number => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
export const semis = (n: number): number => Math.pow(2, n / 12);
/** One frame of easing from v toward x with time constant tau. */
export const ease = (v: number, x: number, tau: number, dt: number): number => (x === x ? v + (x - v) * (1 - Math.exp(-dt / tau)) : v);
export const bell = (x: number, c: number, w: number): number => {
  const d = (x - c) / w;
  return Math.exp(-0.5 * d * d);
};

export type Rng = () => number;
export function makeRng(seed: number): Rng {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export const spread = (r: Rng, w: number): number => (r() * 2 - 1) * w;
/** A pair's worth of gaussian, one at a time. */
export const gauss = (r: Rng): number => Math.sqrt(-2 * Math.log(1 - r() * 0.999999)) * Math.cos(TAU * r());

// ------------------------------------------------------------------ workshop
/** A piece of synthesis that yields often. */
export type Job = Generator<void, void, void>;

/** What is missed soonest is made first. */
export type Need = 0 | 1 | 2 | 3;
/** the first chord, and the air it hangs in */
export const NOW: Need = 0;
/** the first things a player will do */
export const SOON: Need = 1;
/** the rest of the music */
export const LATER: Need = 2;
/** colour, company, landmarks */
export const EVENTUALLY: Need = 3;

/**
 * Work done in thin slices between frames. Jobs run strictly one at a time,
 * so they may share scratch memory.
 */
export class Workshop {
  private queues: Job[][] = [[], [], [], []];
  private current: Job | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** when true nothing runs by itself (offline rendering drains by hand) */
  constructor(private manual = false) {}

  add(job: Job, need: Need = LATER): void {
    this.queues[need].push(job);
    this.wake();
  }

  get idle(): boolean {
    return !this.current && this.queues.every((q) => q.length === 0);
  }

  /** Run everything now. Only for offline rendering. */
  drain(): void {
    while (this.run(1e9));
  }

  private take(): Job | null {
    for (const q of this.queues) {
      const j = q.shift();
      if (j) return j;
    }
    return null;
  }

  private wake(): void {
    if (this.manual || this.timer !== null) return;
    this.timer = setTimeout(this.tick, 4);
  }

  private tick = (): void => {
    this.timer = null;
    if (this.run(5)) this.timer = setTimeout(this.tick, 9);
  };

  private run(ms: number): boolean {
    const end = performance.now() + ms;
    do {
      if (!this.current) {
        this.current = this.take();
        if (!this.current) return false;
      }
      let done = true;
      try {
        done = !!this.current.next().done;
      } catch {
        // one lost timbre is never worth a lost evening
      }
      if (done) this.current = null;
    } while (performance.now() < end);
    return true;
  }
}

// ----------------------------------------------------------------------- fft
export const FFT_N = 1 << 17;
let cosT: Float64Array | null = null;
let sinT: Float64Array | null = null;
let scratchRe: Float64Array | null = null;
let scratchIm: Float64Array | null = null;

export function fftScratch(): { re: Float64Array; im: Float64Array } {
  if (!scratchRe || !scratchIm) {
    scratchRe = new Float64Array(FFT_N);
    scratchIm = new Float64Array(FFT_N);
  }
  return { re: scratchRe, im: scratchIm };
}

/** In-place complex FFT of the shared scratch arrays, yielding between stages. */
export function* fft(re: Float64Array, im: Float64Array): Job {
  const n = FFT_N;
  if (!cosT || !sinT) {
    cosT = new Float64Array(n / 2);
    sinT = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cosT[i] = Math.cos((TAU * i) / n);
      sinT[i] = Math.sin((TAU * i) / n);
    }
    yield;
  }
  const C = cosT;
  const S = sinT;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const a = re[i];
      re[i] = re[j];
      re[j] = a;
      const b = im[i];
      im[i] = im[j];
      im[j] = b;
    }
    if ((i & 32767) === 0) yield;
  }
  yield;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const a = i + k;
        const b = a + half;
        const wr = C[t];
        const wi = S[t];
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
      if (size === n || (i & 65535) === 0) yield;
    }
    yield;
  }
}

// ------------------------------------------------------------- shared tables
const SINE_BITS = 13;
export const SINE_N = 1 << SINE_BITS;
export const SINE = new Float32Array(SINE_N + 1);
for (let i = 0; i <= SINE_N; i++) SINE[i] = Math.sin((TAU * i) / SINE_N);
/** sin(2π·turns), table-read. */
export const sinTurns = (t: number): number => {
  const x = (t - Math.floor(t)) * SINE_N;
  const i = x | 0;
  return SINE[i] + (SINE[i + 1] - SINE[i]) * (x - i);
};

export function toBuffer(ctx: BaseAudioContext, chans: Float32Array<ArrayBuffer>[], rate: number): AudioBuffer {
  const b = ctx.createBuffer(chans.length, chans[0].length, rate);
  for (let c = 0; c < chans.length; c++) b.getChannelData(c).set(chans[c]);
  return b;
}

/** Scale so the loudest short stretch has the given RMS, and the ends are silent. */
export function settleLevel(x: Float32Array, rate: number, rms: number, win = 0.12): void {
  const w = Math.max(1, Math.floor(win * rate));
  let acc = 0;
  let best = 1e-12;
  for (let i = 0; i < x.length; i++) {
    acc += x[i] * x[i];
    if (i >= w) acc -= x[i - w] * x[i - w];
    if (acc > best) best = acc;
  }
  const g = rms / Math.sqrt(best / w);
  for (let i = 0; i < x.length; i++) x[i] *= g;
}

export function fadeEnds(x: Float32Array, rate: number, inS: number, outS: number): void {
  const a = Math.min(x.length, Math.floor(inS * rate));
  const b = Math.min(x.length, Math.floor(outS * rate));
  for (let i = 0; i < a; i++) x[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / a);
  for (let i = 0; i < b; i++) x[x.length - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / b);
}

// ------------------------------------------------------------------- control
/**
 * One eased control. The value drifts toward its target in JS; the audio
 * thread is only told at a relaxed rate, and only when something moved.
 */
export class Ctl {
  v: number;
  private sent: number;
  constructor(
    private p: AudioParam,
    v: number,
    private tau: number,
    private floor = 0.02,
  ) {
    this.v = v;
    this.sent = v;
    p.value = v;
  }
  to(x: number, dt: number, tau = this.tau): void {
    if (x === x) this.v += (x - this.v) * (1 - Math.exp(-dt / Math.max(tau, 1e-3)));
  }
  push(now: number): void {
    const d = Math.abs(this.v - this.sent);
    if (d === 0) return;
    const ref = Math.max(Math.abs(this.v), Math.abs(this.sent), this.floor);
    if (d / ref < 0.006) return;
    if (this.v < 1e-5 && this.v > -1e-5) this.v = 0;
    this.sent = this.v;
    this.p.setTargetAtTime(this.v, now, 0.07);
  }
}

/**
 * Let a slowly moving filter be recomputed once a block rather than once a
 * sample: inaudible at these speeds, and most of the cost of having many.
 */
export function relaxed(p: AudioParam): AudioParam {
  try {
    p.automationRate = 'k-rate';
  } catch {
    // older engines only know one way
  }
  return p;
}

/**
 * Pin a node to two channels. Otherwise it narrows to mono whenever its last
 * wide input ends, and a filter that narrows forgets itself, audibly.
 */
export function stereo<T extends AudioNode>(n: T): T {
  n.channelCount = 2;
  n.channelCountMode = 'explicit';
  n.channelInterpretation = 'speakers';
  return n;
}

/** A stereo placer that also works where StereoPanner is missing. */
export function makePan(ctx: BaseAudioContext, pan: number): AudioNode {
  if (typeof ctx.createStereoPanner === 'function') {
    const p = ctx.createStereoPanner();
    p.pan.value = clamp(pan, -1, 1);
    return p;
  }
  const p = ctx.createPanner();
  p.panningModel = 'equalpower';
  const x = clamp(pan, -1, 1);
  p.setPosition(x, 0, 1 - Math.abs(x));
  return p;
}
