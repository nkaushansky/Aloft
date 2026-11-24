/** Buses, one-shot notes and sustained voices: the parts that touch nodes. */
import { Ctl, makePan, relaxed, stereo } from './dsp';
import type { Zone } from './timbres';

/** A place to play into: tone, level, and how much of it goes into the air. */
export class Bus {
  readonly in: GainNode;
  readonly gain: Ctl;
  readonly cut: Ctl;
  readonly send: Ctl;
  readonly out: GainNode;

  constructor(ctx: BaseAudioContext, dry: AudioNode, wet: AudioNode, gain: number, cut: number, send: number, q = 0.35) {
    this.in = stereo(ctx.createGain());
    const lp = stereo(ctx.createBiquadFilter());
    lp.type = 'lowpass';
    lp.Q.value = q;
    this.out = stereo(ctx.createGain());
    const s = stereo(ctx.createGain());
    this.in.connect(lp);
    lp.connect(this.out);
    this.out.connect(dry);
    this.out.connect(s);
    s.connect(wet);
    this.gain = new Ctl(this.out.gain, gain, 1.8, 0.01);
    this.cut = new Ctl(relaxed(lp.frequency), cut, 1.8, 40);
    this.send = new Ctl(s.gain, send, 3, 0.02);
  }

  push(now: number): void {
    this.gain.push(now);
    this.cut.push(now);
    this.send.push(now);
  }
}

export interface Shot {
  rate?: number;
  pan?: number;
  /** lowpass, Hz */
  cut?: number;
  /** highpass, Hz */
  low?: number;
  /** ease-in seconds on top of the sample's own */
  ease?: number;
  /** seconds into the sample to begin */
  from?: number;
  /** counts as decoration: first to be left out when it is busy */
  light?: boolean;
  /** called when the last of it has gone */
  after?: () => void;
}

/** Plays finished buffers once, keeps count, and cleans up after itself. */
export class Player {
  live = 0;
  constructor(
    readonly ctx: BaseAudioContext,
    private cap = 46,
  ) {}

  shot(buf: AudioBuffer | null | undefined, into: AudioNode, at: number, gain: number, o?: Shot): boolean {
    if (!buf || !(gain >= 0.0005)) return false;
    if (this.live >= (o?.light ? this.cap * 0.7 : this.cap)) return false;
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = o?.rate ?? 1;
    const g = c.createGain();
    const t = Math.max(at, c.currentTime + 0.005);
    if (o?.ease) {
      g.gain.value = 0;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + o.ease);
    } else g.gain.value = gain;
    const chain: AudioNode[] = [src, g];
    if (o?.cut) {
      const f = c.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = o.cut;
      f.Q.value = 0.4;
      chain.push(f);
    }
    if (o?.low) {
      const f = c.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = o.low;
      f.Q.value = 0.4;
      chain.push(f);
    }
    if (o?.pan) chain.push(makePan(c, o.pan));
    for (let i = 0; i + 1 < chain.length; i++) chain[i].connect(chain[i + 1]);
    chain[chain.length - 1].connect(into);
    this.live++;
    const after = o?.after;
    src.onended = () => {
      this.live--;
      for (const n of chain) n.disconnect();
      if (after) after();
    };
    src.start(t, o?.from ?? 0);
    return true;
  }
}

/** One long breath of a sustained instrument. */
export class Held {
  private src: AudioBufferSourceNode;
  private g: GainNode;
  private pan: AudioNode | null = null;
  private gone = false;

  constructor(
    ctx: BaseAudioContext,
    z: Zone,
    into: AudioNode,
    readonly midi: number,
    at: number,
    level: number,
    attack: number,
    offset: number,
    detune: number,
    pan = 0,
  ) {
    this.src = ctx.createBufferSource();
    this.src.buffer = z.buf;
    this.src.loop = true;
    this.src.playbackRate.value = z.rate * detune;
    this.g = ctx.createGain();
    this.g.gain.value = 0;
    this.g.gain.setValueAtTime(0, at);
    this.g.gain.setTargetAtTime(level, at, attack);
    this.src.connect(this.g);
    if (pan) {
      this.pan = makePan(ctx, pan);
      this.g.connect(this.pan);
      this.pan.connect(into);
    } else this.g.connect(into);
    this.src.onended = () => {
      this.src.disconnect();
      this.g.disconnect();
      this.pan?.disconnect();
    };
    this.src.start(at, offset * z.buf.duration);
  }

  /** Lean the bow in, or ease it off. */
  bow(level: number, at: number, tau: number): void {
    if (!this.gone) this.g.gain.setTargetAtTime(level, at, tau);
  }

  /** Drop whatever swells were still to come and fade. */
  release(at: number, tau: number): void {
    if (this.gone) return;
    this.gone = true;
    this.g.gain.cancelScheduledValues(at);
    this.g.gain.setTargetAtTime(0, at, tau);
    this.src.stop(at + tau * 7);
  }
}
