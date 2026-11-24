/**
 * Small sounds of the world, each grown once and kept: water, wings, frogs,
 * far birds, weather, and one very old bell. All of them are soft-edged and
 * none of them has anything to say above the music.
 */
import { FFT_N, Job, Rng, TAU, bell, clamp, fadeEnds, fft, fftScratch, gauss, lerp, mtof, semis, settleLevel, sinTurns, smooth, spread, toBuffer } from './dsp';
import { PAD_RATE } from './timbres';

const SR = 24000;
type Done = (b: AudioBuffer) => void;

/** One gliding sine with a smooth window, mixed in (optionally wrapping). */
function chirp(out: Float32Array, at: number, len: number, f0: number, f1: number, amp: number, curve = 1, h2 = 0, wrap = false): void {
  const n = Math.floor(len * SR);
  const i0 = Math.floor(at * SR);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const u = i / n;
    const f = f0 + (f1 - f0) * Math.pow(u, curve);
    ph += f / SR;
    const e = Math.sin(Math.PI * Math.pow(u, 0.8));
    const y = (sinTurns(ph) + h2 * sinTurns(ph * 2)) * e * e * amp;
    let j = i0 + i;
    if (wrap) j %= out.length;
    if (j >= 0 && j < out.length) out[j] += y;
  }
}

/** A bubble: a round little rising tone that dies away. */
function bubble(out: Float32Array, at: number, f: number, tau: number, amp: number, rise: number, wrap = false): void {
  const n = Math.floor(tau * 6 * SR);
  const i0 = Math.floor(at * SR);
  let ph = 0;
  const atk = 0.004 * SR;
  for (let i = 0; i < n; i++) {
    ph += (f * (1 + (rise * i) / n)) / SR;
    const e = Math.exp(-i / (tau * SR)) * Math.min(1, i / atk) * Math.min(1, (n - i) / (n * 0.2));
    let j = i0 + i;
    if (wrap) j %= out.length;
    if (j < out.length) out[j] += sinTurns(ph) * e * amp;
  }
}

/** Gaussian noise under an envelope, through a two-pole lowpass that may move. */
function puff(out: Float32Array, rng: Rng, env: (u: number) => number, cut: (u: number) => number, amp: number): void {
  let a = 0;
  let b = 0;
  let h = 0;
  for (let i = 0; i < out.length; i++) {
    const u = i / out.length;
    const k = 1 - Math.exp((-TAU * cut(u)) / SR);
    a += (gauss(rng) - a) * k;
    b += (a - b) * k;
    h += (b - h) * 0.02; // no rumble, no DC
    out[i] += (b - h) * env(u) * amp;
  }
}

// ----------------------------------------------------------------- noise bed
/** Seamless stereo noise, already dark: the raw stuff of wind and water. */
export function* renderPink(ctx: BaseAudioContext, rng: Rng, done: Done): Job {
  const { re, im } = fftScratch();
  re.fill(0);
  im.fill(0);
  const half = FFT_N / 2;
  let pow = 0;
  for (let i = 1; i < half; i++) {
    const f = (i * PAD_RATE) / FFT_N;
    if (f < 45 || f > 7000) continue;
    const m = (Math.pow(f / 300, -0.75) * smooth(45, 120, f)) / (1 + Math.pow(f / 2600, 3));
    pow += m * m;
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
  const g = 0.16 / Math.sqrt(pow);
  const L = new Float32Array(FFT_N);
  const R = new Float32Array(FFT_N);
  for (let i = 0; i < FFT_N; i++) {
    L[i] = re[i] * g;
    R[i] = im[i] * g;
  }
  done(toBuffer(ctx, [L, R], PAD_RATE));
}

// --------------------------------------------------------------------- water
/** Liquid running under a wingtip: hundreds of tiny bubbles, seamless. */
export function* renderTrickle(ctx: BaseAudioContext, rng: Rng, done: Done): Job {
  const n = Math.floor(4.7 * SR);
  const ch = [new Float32Array(n), new Float32Array(n)];
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < 210; i++) {
      const f = 420 * Math.pow(4.2, rng());
      bubble(ch[c], rng() * 4.7, f, 0.008 + 0.022 * rng() * (600 / f + 0.4), 0.12 + 0.3 * rng() * rng(), 0.15 + 0.5 * rng(), true);
      if (i % 60 === 59) yield;
    }
    settleLevel(ch[c], SR, 0.12, 2);
  }
  done(toBuffer(ctx, ch, SR));
}

/** Water lapping against reeds. */
export function* renderLap(ctx: BaseAudioContext, rng: Rng, done: Done): Job {
  const out = new Float32Array(Math.floor(1.5 * SR));
  puff(out, rng, (u) => Math.sin(Math.PI * Math.pow(u, 0.55)) ** 2 * 0.8, (u) => 480 - 220 * u, 0.5);
  const k = 4 + Math.floor(rng() * 5);
  for (let i = 0; i < k; i++) bubble(out, 0.15 + rng() * 0.7, 330 + 420 * rng(), 0.025 + 0.03 * rng(), 0.05 + 0.07 * rng(), 0.35);
  settleLevel(out, SR, 0.1, 0.3);
  fadeEnds(out, SR, 0.08, 0.3);
  yield;
  done(toBuffer(ctx, [out], SR));
}

/** Splash: the softest possible arrival into water. */
export function* renderSplash(ctx: BaseAudioContext, rng: Rng, done: Done): Job {
  const ch = [new Float32Array(Math.floor(1.9 * SR)), new Float32Array(Math.floor(1.9 * SR))];
  for (const out of ch) {
    puff(out, rng, (u) => smooth(0, 0.025, u) * Math.exp(-u * 7), (u) => lerp(1500, 420, Math.pow(u, 0.4)), 0.55);
    puff(out, rng, (u) => smooth(0, 0.12, u) * Math.exp(-u * 4), () => 380, 0.5);
    for (let i = 0; i < 34; i++) {
      const at = 0.05 + 1.3 * rng() * rng();
      bubble(out, at, 320 + 900 * rng(), 0.014 + 0.03 * rng(), (0.1 + 0.12 * rng()) * Math.exp(-at * 1.6), 0.45);
    }
    settleLevel(out, SR, 0.15, 0.2);
    fadeEnds(out, SR, 0.01, 0.5);
    yield;
  }
  done(toBuffer(ctx, ch, SR));
}

// --------------------------------------------------------------------- wings
/** One downstroke: a felt push of air, more pressure than sound. */
export function* renderWhuff(ctx: BaseAudioContext, rng: Rng, done: Done): Job {
  const out = new Float32Array(Math.floor(0.62 * SR));
  const peak = 0.3 + 0.06 * rng();
  puff(out, rng, (u) => (u < peak ? smooth(0, peak, u) : Math.pow(1 - smooth(peak, 1, u), 1.4)), (u) => 250 + 430 * Math.sin(Math.PI * Math.pow(u, 0.7)), 1);
  // the primaries sing very slightly as they part
  const f = 205 + 25 * rng();
  let ph = 0;
  for (let i = 0; i < out.length; i++) {
    const u = i / out.length;
    ph += (f * (1.1 - 0.3 * u)) / SR;
    out[i] += sinTurns(ph) * 0.05 * bell(u, peak + 0.04, 0.13);
  }
  settleLevel(out, SR, 0.15, 0.2);
  fadeEnds(out, SR, 0.07, 0.2);
  yield;
  done(toBuffer(ctx, [out], SR));
}

/** Grass or snow taking a bird's weight. */
export function* renderRustle(ctx: BaseAudioContext, rng: Rng, done: Done): Job {
  const out = new Float32Array(Math.floor(0.9 * SR));
  let g = 0;
  let gt = 0;
  const grain = new Float32Array(out.length);
  for (let i = 0; i < out.length; i++) {
    if (i % 500 === 0) gt = 0.3 + 0.7 * rng();
    g += (gt - g) * 0.004;
    grain[i] = g;
  }
  puff(out, rng, (u) => Math.sin(Math.PI * Math.pow(u, 0.5)) ** 2 * grain[Math.min(grain.length - 1, Math.floor(u * out.length))], (u) => 950 - 450 * u, 1);
  bubble(out, 0.02, 92, 0.05, 0.12, -0.2);
  settleLevel(out, SR, 0.12, 0.2);
  fadeEnds(out, SR, 0.04, 0.3);
  yield;
  done(toBuffer(ctx, [out], SR));
}

// ----------------------------------------------------------------- creatures
/** A marsh frog some way off: a low purr, not a croak. */
export function* renderFrog(ctx: BaseAudioContext, rng: Rng, done: Done): Job {
  const len = 0.5 + 0.5 * rng();
  const out = new Float32Array(Math.floor((len + 0.1) * SR));
  const f = 420 + 260 * rng();
  const rate = 17 + 9 * rng();
  let ph = 0;
  for (let i = 0; i < len * SR; i++) {
    const t = i / SR;
    const u = t / len;
    ph += (f * (0.96 + 0.06 * Math.sin(Math.PI * u))) / SR;
    const p = Math.pow(0.5 - 0.5 * Math.cos(TAU * rate * t), 1.6);
    const e = Math.sin(Math.PI * Math.pow(u, 0.7)) ** 1.2;
    out[i] += (sinTurns(ph) + 0.42 * sinTurns(ph * 2.01) + 0.16 * sinTurns(ph * 3)) * p * e * 0.4;
  }
  settleLevel(out, SR, 0.12, 0.2);
  fadeEnds(out, SR, 0.02, 0.1);
  yield;
  done(toBuffer(ctx, [out], SR));
}

/** A tree frog's single glassy note. */
export function* renderPeeper(ctx: BaseAudioContext, rng: Rng, done: Done): Job {
  const out = new Float32Array(Math.floor(0.3 * SR));
  const f = 2050 + 500 * rng();
  chirp(out, 0.01, 0.2 + 0.06 * rng(), f, f * 1.06, 0.4, 0.5);
  settleLevel(out, SR, 0.1, 0.1);
  yield;
  done(toBuffer(ctx, [out], SR));
}

/** Reed warbler: an unhurried, chuckling run of doubled notes. */
export function* renderWarbler(ctx: BaseAudioContext, rng: Rng, done: Done): Job {
  const len = 2.4;
  const out = new Float32Array(Math.floor(len * SR));
  let t = 0.05;
  while (t < len - 0.4) {
    const f = 1900 + 1500 * rng();
    const reps = 2 + Math.floor(rng() * 2);
    const kind = rng();
    const d = 0.07 + 0.05 * rng();
    for (let i = 0; i < reps && t < len - 0.2; i++) {
      const a = 0.2 + 0.16 * rng();
      if (kind < 0.4) chirp(out, t, d, f * 0.86, f * 1.1, a, 0.8, 0.12);
      else if (kind < 0.75) chirp(out, t, d, f * 1.15, f * 0.85, a, 0.8, 0.12);
      else chirp(out, t, d * 1.5, f, f * 1.02, a * 0.9, 1, 0.06);
      t += d * 1.35 + 0.03;
    }
    t += 0.06 + 0.1 * rng();
  }
  settleLevel(out, SR, 0.1, 0.3);
  fadeEnds(out, SR, 0.15, 0.4);
  yield;
  done(toBuffer(ctx, [out], SR));
}

/** Songbird: two to four clear, falling whistles with room between. */
export function* renderSongbird(ctx: BaseAudioContext, rng: Rng, done: Done): Job {
  const out = new Float32Array(Math.floor(2.3 * SR));
  const notes = 2 + Math.floor(rng() * 3);
  let t = 0.04;
  const base = 2100 + 900 * rng();
  const steps = [1, 1.122, 0.891, 1.26, 0.794, 1.498];
  for (let i = 0; i < notes; i++) {
    const f = base * steps[Math.floor(rng() * steps.length)];
    const d = 0.16 + 0.2 * rng();
    if (rng() < 0.22) {
      // a little roll
      for (let k = 0; k < 4; k++) chirp(out, t + k * 0.055, 0.06, f * 1.06, f * 0.95, 0.22, 1);
      t += 0.26;
    } else {
      chirp(out, t, d, f * (1.03 + 0.04 * rng()), f * 0.96, 0.32, 0.7, 0.04);
      t += d + 0.05;
    }
    t += 0.05 + 0.1 * rng();
  }
  settleLevel(out, SR, 0.1, 0.25);
  fadeEnds(out, SR, 0.01, 0.2);
  yield;
  done(toBuffer(ctx, [out], SR));
}

/** Canyon wren: a cascade of whistles walking down the rock, slowing. */
export function* renderWren(ctx: BaseAudioContext, rng: Rng, done: Done): Job {
  const out = new Float32Array(Math.floor(3.4 * SR));
  const n = 9 + Math.floor(rng() * 4);
  let t = 0.05;
  for (let i = 0; i < n; i++) {
    const u = i / (n - 1);
    const f = lerp(3300, 1550, Math.pow(u, 0.85)) * (1 + spread(rng, 0.01));
    const d = lerp(0.11, 0.24, u);
    chirp(out, t, d, f * 1.07, f * 0.9, (0.2 + 0.16 * Math.sin(Math.PI * u)) * (1 - 0.3 * u), 0.9, 0.05);
    t += d + lerp(0.035, 0.13, u);
    if (t > 3.1) break;
  }
  settleLevel(out, SR, 0.1, 0.3);
  fadeEnds(out, SR, 0.02, 0.3);
  yield;
  done(toBuffer(ctx, [out], SR));
}

/** Warm insect shimmer: mellow crickets, breathing in and out together. */
export function* renderInsects(ctx: BaseAudioContext, rng: Rng, done: Done): Job {
  const len = 6.2;
  const n = Math.floor(len * SR);
  const ch = [new Float32Array(n), new Float32Array(n)];
  for (let v = 0; v < 9; v++) {
    const f = 1850 + 1150 * rng();
    const cyc = Math.max(3, Math.round(len / (0.55 + 0.5 * rng()))); // whole chirps per loop
    const pulses = 3 + Math.floor(rng() * 2);
    const ph0 = rng();
    const pan = rng();
    const cycles = Math.round(f * len); // whole waves per loop
    const a = 0.3 + 0.7 * rng();
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const c = (u * cyc + ph0) % 1;
      const w = c < 0.5 ? Math.sin(Math.PI * (c / 0.5)) : 0;
      if (w <= 0) continue;
      const pl = 0.5 - 0.5 * Math.cos(TAU * pulses * (c / 0.5));
      const breath = 0.6 + 0.4 * Math.sin(TAU * (u + ph0));
      const y = sinTurns(u * cycles) * w * pl * breath * a * 0.1;
      ch[0][i] += y * Math.cos((pan * Math.PI) / 2);
      ch[1][i] += y * Math.sin((pan * Math.PI) / 2);
    }
    yield;
  }
  settleLevel(ch[0], SR, 0.08, 2);
  settleLevel(ch[1], SR, 0.08, 2);
  done(toBuffer(ctx, ch, SR));
}

/**
 * Ten thousand cranes heard from the other side of a delta: a soft, seamless
 * weave of many far voices. `voices` are finished crane calls.
 */
export function* renderMurmur(ctx: BaseAudioContext, voices: AudioBuffer[], rng: Rng, done: Done): Job {
  const len = 11;
  const n = Math.floor(len * SR);
  const ch = [new Float32Array(n), new Float32Array(n)];
  if (voices.length) {
    for (let v = 0; v < 150; v++) {
      const src = voices[Math.floor(rng() * voices.length)];
      const d = src.getChannelData(0);
      const step = (src.sampleRate / SR) * semis(spread(rng, 4.5) - 1);
      const at = Math.floor(rng() * n);
      const far = rng();
      const a = 0.2 + 0.8 * Math.pow(1 - far, 2);
      const k = lerp(0.4, 0.14, far);
      const pan = rng();
      const gl = Math.cos((pan * Math.PI) / 2) * a;
      const gr = Math.sin((pan * Math.PI) / 2) * a;
      let z = 0;
      let z2 = 0;
      const m = Math.floor(d.length / step) - 1;
      for (let i = 0; i < m; i++) {
        z += (d[Math.floor(i * step)] - z) * k;
        z2 += (z - z2) * k;
        let j = at + i;
        if (j >= n) j -= n;
        ch[0][j] += z2 * gl;
        ch[1][j] += z2 * gr;
      }
      if (v % 4 === 3) yield;
    }
  }
  settleLevel(ch[0], SR, 0.1, 3);
  settleLevel(ch[1], SR, 0.1, 3);
  done(toBuffer(ctx, ch, SR));
}

// ------------------------------------------------------------------- weather
/** Thunder with all the crack taken out: a long furniture-moving roll. */
export function* renderThunder(ctx: BaseAudioContext, rng: Rng, done: Done): Job {
  const len = 8.5;
  const n = Math.floor(len * SR);
  const ch = [new Float32Array(n), new Float32Array(n)];
  // one shared shape of rolls, slightly different in each ear
  const rolls: number[][] = [];
  for (let i = 0; i < 9; i++) rolls.push([0.5 + 5.2 * Math.pow(rng(), 1.25), 0.35 + 0.8 * rng(), (0.35 + 0.65 * rng()) * Math.exp(-i * 0.06)]);
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let e = 0;
    for (const r of rolls) e += r[2] * bell(t, r[0], r[1] * 0.5);
    env[i] = e * smooth(0, 1.0, t) * (1 - smooth(5.4, len, t));
  }
  yield;
  for (const out of ch) {
    let a = 0;
    let b = 0;
    let c = 0;
    let h = 0;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      const k = 1 - Math.exp((-TAU * lerp(260, 120, u)) / SR);
      const x = gauss(rng);
      a += (x - a) * k;
      b += (a - b) * k;
      c += (x - c) * 0.1;
      h += (b - h) * 0.006;
      out[i] = (b - h) * env[i] + (c - a) * 0.02 * env[i] * env[i];
    }
    settleLevel(out, SR, 0.16, 0.6);
    fadeEnds(out, SR, 0.4, 2);
    yield;
  }
  done(toBuffer(ctx, ch, SR));
}

// ---------------------------------------------------------------- the bell
/** A great bronze bell, struck with wood wrapped in cloth. 16 seconds. */
export function* renderGreatBell(ctx: BaseAudioContext, prime: number, rng: Rng, done: Done): Job {
  const len = 16;
  const n = Math.floor(len * SR);
  const out = new Float32Array(n);
  const f = mtof(prime);
  // hum, prime, tierce, quint, nominal and up: each a warbling doublet
  const parts = [
    [0.5, 0.42, 6.4, 0.0016],
    [1, 0.7, 4.8, 0.0013],
    [1.183, 0.42, 3.5, 0.0011],
    [1.506, 0.28, 2.8, 0.0012],
    [2, 0.95, 3.2, 0.0009],
    [2.514, 0.26, 2.0, 0.001],
    [2.662, 0.24, 1.8, 0.001],
    [3.011, 0.5, 1.9, 0.0008],
    [4.166, 0.4, 1.35, 0.0008],
    [5.433, 0.24, 0.9, 0.0008],
    [6.796, 0.13, 0.6, 0.0008],
    [8.215, 0.07, 0.42, 0.0008],
    [9.7, 0.03, 0.3, 0.0008],
  ];
  for (const [r, a, tau, d] of parts) {
    for (const s of [-1, 1]) {
      const w = (TAU * f * r * (1 + s * d)) / SR;
      const k = Math.exp(-1 / (tau * SR));
      const c = Math.cos(w) * k;
      const q = Math.sin(w) * k;
      const p0 = rng() * TAU;
      let x = Math.cos(p0) * a * (s < 0 ? 0.6 : 0.5);
      let y = Math.sin(p0) * a * (s < 0 ? 0.6 : 0.5);
      for (let i = 0; i < n; i++) {
        out[i] += y;
        const nx = x * c - y * q;
        y = x * q + y * c;
        x = nx;
      }
    }
    yield;
  }
  // the cloth
  let lp = 0;
  for (let i = 0; i < 0.25 * SR; i++) {
    lp += (gauss(rng) - lp) * 0.06;
    out[i] += lp * 1.2 * Math.exp(-i / (0.04 * SR));
  }
  settleLevel(out, SR, 0.2, 0.3);
  fadeEnds(out, SR, 0.018, 5);
  yield;
  done(toBuffer(ctx, [out], SR));
}

// --------------------------------------------------------------------- whale
/** A whale's line: long low glides, with enough voice in them to be heard. */
export function* renderWhale(ctx: BaseAudioContext, rng: Rng, done: Done): Job {
  const len = 9;
  const n = Math.floor(len * SR);
  const out = new Float32Array(n);
  // three utterances: [start, dur, f0, f1, f2]
  const lines = [
    [0.1, 3.1, 118, 208, 164],
    [3.35, 1.9, 247, 233, 311],
    [5.4, 3.3, 196, 147, 87],
  ];
  const tone = (f: number): number => 0.25 + 0.9 * bell(f, 330, 150) + 0.7 * bell(f, 640, 220) + 0.22 * bell(f, 1150, 320);
  for (const [at, dur, a, b, c] of lines) {
    const i0 = Math.floor(at * SR);
    const m = Math.floor(dur * SR);
    const j1 = 1 + spread(rng, 0.03);
    for (let k = 1; k <= 8; k++) {
      let ph = rng();
      let amp = 0;
      let step = 0;
      for (let i = 0; i < m && i0 + i < n; i++) {
        const u = i / m;
        const f = (u < 0.5 ? lerp(a, b, smooth(0, 0.5, u)) : lerp(b, c, smooth(0.5, 1, u))) * j1 * (1 + 0.004 * sinTurns((i / SR) * 3.1));
        if ((i & 63) === 0) {
          const e = Math.sin(Math.PI * Math.pow(u, 0.8)) ** 1.5;
          const want = Math.pow(k, -0.9) * tone(f * k) * Math.pow(e, 1 + 0.2 * (k - 1));
          step = (want - amp) / 64;
        }
        amp += step;
        ph += (f * k) / SR;
        out[i0 + i] += sinTurns(ph) * amp * 0.3;
      }
      if (k % 2 === 0) yield;
    }
  }
  settleLevel(out, SR, 0.16, 0.6);
  fadeEnds(out, SR, 0.2, 0.6);
  done(toBuffer(ctx, [out], SR));
}

// --------------------------------------------------------------------- space
/**
 * The hall: no hall at all, really — open country after the birds have gone.
 * A bloom of early diffusion, then a long tail that darkens as it travels.
 */
export function* renderSpace(ctx: BaseAudioContext, seconds: number, rng: Rng, done: Done): Job {
  const sr = ctx.sampleRate;
  const n = Math.floor(seconds * sr);
  const ch = [new Float32Array(n), new Float32Array(n)];
  const pre = Math.floor(0.018 * sr);
  for (let c = 0; c < 2; c++) {
    const out = ch[c];
    // early: a thickening scatter of reflections
    for (let i = 0; i < 46; i++) {
      const t = 0.018 + 0.13 * Math.pow(rng(), 0.8);
      const j = Math.floor(t * sr);
      const a = 0.5 * Math.exp(-t * 11) * (rng() < 0.5 ? -1 : 1) * (0.4 + 0.6 * rng());
      // each is a little smear, not a tick
      const w = Math.floor((0.0006 + 0.0022 * rng()) * sr);
      for (let k = 0; k < w && j + k < n; k++) out[j + k] += (a * (0.5 - 0.5 * Math.cos((TAU * k) / w)) * 6) / Math.sqrt(w);
    }
    yield;
    // tail: three bands, each with its own life
    let l1 = 0;
    let l2 = 0;
    let h1 = 0;
    let hp = 0;
    const kLow = 1 - Math.exp((-TAU * 420) / sr);
    const kMid = 1 - Math.exp((-TAU * 2100) / sr);
    const kHi = 1 - Math.exp((-TAU * 6200) / sr);
    const kHp = 1 - Math.exp((-TAU * 110) / sr);
    const m1 = rng() * TAU;
    const m2 = rng() * TAU;
    for (let i = pre; i < n; i++) {
      const t = (i - pre) / sr;
      const x = gauss(rng);
      h1 += (x - h1) * kHi;
      l2 += (h1 - l2) * kMid;
      l1 += (l2 - l1) * kLow;
      const low = l1;
      const mid = l2 - l1;
      const hi = h1 - l2;
      const bloom = 1 - Math.exp(-t / 0.07);
      const drift = 1 + 0.12 * Math.sin(TAU * 0.9 * t + m1);
      const drift2 = 1 + 0.16 * Math.sin(TAU * 1.37 * t + m2);
      const y = low * 1.55 * Math.exp(-t * (6.9 / 4.6)) + mid * 1.0 * drift * Math.exp(-t * (6.9 / 3.9)) + hi * 0.62 * drift2 * Math.exp(-t * (6.9 / 1.9));
      hp += (y - hp) * kHp;
      const end = clamp((n - i) / (0.5 * sr));
      out[i] += (y - hp) * bloom * 0.5 * end;
      if ((i & 16383) === 0) yield;
    }
  }
  // unit energy, so the mix means the same thing on every device
  let e = 0;
  for (const out of ch) for (let i = 0; i < n; i++) e += out[i] * out[i];
  const g = 1 / Math.sqrt(e / 2);
  for (const out of ch) for (let i = 0; i < n; i++) out[i] *= g;
  yield;
  done(toBuffer(ctx, ch, sr));
}
