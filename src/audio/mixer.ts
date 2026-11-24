/**
 * The desk. Three families of sound (music, voices, world), one shared space,
 * and a master that can only ever round things off.
 *
 *   music ─ shelf ─ veil ─ tape ─ duck ─┐
 *   voice ──────── veil ────────────────┼─ sum ─ dc ─ glue ─ round ─ out
 *   world ──────── veil ────────────────┤
 *   sends ─ drift ─ space ──────────────┘
 */
import { Ctl, clamp, relaxed, stereo } from './dsp';

/** tanh tape with the faintest second harmonic */
function tapeCurve(): Float32Array<ArrayBuffer> {
  const n = 2049;
  const c = new Float32Array(n);
  const k = 1.25;
  const b = 0.06;
  const z = Math.tanh(k * b);
  const s = k * (1 - z * z);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = (Math.tanh(k * (x + b)) - z) / s;
  }
  return c;
}

/** Straight through the middle, rounding over to a ceiling that is never passed. */
function roundCurve(): Float32Array<ArrayBuffer> {
  const n = 4097;
  const c = new Float32Array(n);
  const knee = 0.5;
  const top = 0.84;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a < knee ? a : knee + (top - knee) * Math.tanh((a - knee) / (top - knee));
    c[i] = Math.sign(x) * y;
  }
  return c;
}

export class Mixer {
  readonly music: GainNode;
  readonly voice: GainNode;
  readonly world: GainNode;
  readonly musicSend: GainNode;
  readonly voiceSend: GainNode;
  readonly worldSend: GainNode;

  readonly musicLow: Ctl; // low shelf, dB
  readonly musicVeil: Ctl; // Hz
  readonly worldVeil: Ctl; // Hz
  readonly musicDuck: Ctl;
  readonly wet: Ctl;

  private master: GainNode;
  private convolver: ConvolverNode;
  private volM: GainNode[] = [];
  private volW: GainNode[] = [];
  private duckUntil = 0;
  private duckTo = 1;
  private level = 1;
  private muted = false;
  private awake = true;

  constructor(private ctx: BaseAudioContext) {
    const c = ctx;
    const gain = (v = 1): GainNode => {
      const g = stereo(c.createGain());
      g.gain.value = v;
      return g;
    };
    const lowpass = (hz: number): BiquadFilterNode => {
      const f = stereo(c.createBiquadFilter());
      f.type = 'lowpass';
      f.frequency.value = hz;
      f.Q.value = 0.4;
      return f;
    };

    const sum = gain();

    // --- music
    this.music = gain();
    const shelf = stereo(c.createBiquadFilter());
    shelf.type = 'lowshelf';
    shelf.frequency.value = 210;
    shelf.gain.value = 0;
    const veil = lowpass(9000);
    const tape = stereo(c.createWaveShaper());
    tape.curve = tapeCurve();
    const duck = gain();
    const volMusic = gain();
    this.music.connect(shelf);
    shelf.connect(veil);
    veil.connect(tape);
    tape.connect(duck);
    duck.connect(volMusic);
    volMusic.connect(sum);

    // --- voices: calls, bells, pickups — close, unducked
    this.voice = gain();
    const volVoice = gain();
    this.voice.connect(volVoice);
    volVoice.connect(sum);

    // --- world
    this.world = gain();
    const wveil = lowpass(9000);
    const volWorld = gain();
    this.world.connect(wveil);
    wveil.connect(volWorld);
    volWorld.connect(sum);

    // --- the space
    this.musicSend = gain();
    this.voiceSend = gain();
    this.worldSend = gain();
    const sendM = gain();
    const sendW = gain();
    const sendV = gain();
    const into = gain();
    this.musicSend.connect(sendM);
    this.voiceSend.connect(sendV);
    this.worldSend.connect(sendW);
    sendM.connect(into);
    sendV.connect(into);
    sendW.connect(into);
    this.volM.push(volMusic, sendM);
    this.volW.push(volVoice, volWorld, sendW, sendV);

    const hp = stereo(c.createBiquadFilter());
    hp.type = 'highpass';
    hp.frequency.value = 130;
    hp.Q.value = 0.5;
    into.connect(hp);
    // a slow drift in the air, so the tail never freezes
    const split = c.createChannelSplitter(2);
    const merge = c.createChannelMerger(2);
    hp.connect(split);
    [0.117, 0.083].forEach((hz, i) => {
      const d = c.createDelay(0.1);
      d.delayTime.value = 0.016 + i * 0.005;
      const o = c.createOscillator();
      o.frequency.value = hz;
      const g = c.createGain();
      g.gain.value = 0.0016;
      o.connect(g);
      g.connect(d.delayTime);
      o.start();
      split.connect(d, i);
      d.connect(merge, 0, i);
    });
    this.convolver = c.createConvolver();
    this.convolver.normalize = false;
    merge.connect(this.convolver);
    const ret = gain(0.3);
    this.convolver.connect(ret);
    ret.connect(sum);

    // --- master
    this.master = gain(0);
    const dc = stereo(c.createBiquadFilter());
    dc.type = 'highpass';
    dc.frequency.value = 32;
    dc.Q.value = 0.6;
    const glue = c.createDynamicsCompressor();
    glue.threshold.value = -18;
    glue.knee.value = 18;
    glue.ratio.value = 3;
    glue.attack.value = 0.03;
    glue.release.value = 0.5;
    // the compressor adds its own make-up; give most of it back
    const back = gain(0.56);
    const round = stereo(c.createWaveShaper());
    round.curve = roundCurve();
    sum.connect(dc);
    dc.connect(glue);
    glue.connect(back);
    back.connect(this.master);
    this.master.connect(round);
    round.connect(c.destination);

    this.musicLow = new Ctl(relaxed(shelf.gain), 0, 2.5, 1);
    this.musicVeil = new Ctl(relaxed(veil.frequency), 9000, 1.4, 50);
    this.worldVeil = new Ctl(relaxed(wveil.frequency), 9000, 1.4, 50);
    this.musicDuck = new Ctl(duck.gain, 1, 0.8);
    this.wet = new Ctl(ret.gain, 0.3, 3);
  }

  setSpace(b: AudioBuffer): void {
    this.convolver.buffer = b;
  }

  /** Fade the whole evening up (or down). */
  fadeIn(seconds: number): void {
    this.awake = true;
    this.apply(seconds / 3);
  }

  fadeOut(seconds: number): void {
    this.awake = false;
    this.apply(seconds / 4);
  }

  setVolumes(master: number, music: number, world: number): void {
    const now = this.ctx.currentTime;
    this.level = clamp(master);
    // squared: the slider's middle sounds like the middle
    for (const g of this.volM) g.gain.setTargetAtTime(clamp(music) ** 2, now, 0.15);
    for (const g of this.volW) g.gain.setTargetAtTime(clamp(world) ** 2, now, 0.15);
    this.apply(0.15);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.apply(0.2);
  }

  private apply(tau: number): void {
    const v = this.awake && !this.muted ? this.level * this.level : 0;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(v, now, Math.max(0.02, tau));
  }

  /** The music leans back for a moment so a voice can be heard. */
  lean(amount: number, seconds: number): void {
    const until = this.ctx.currentTime + seconds;
    this.duckTo = Math.min(this.duckTo, 1 - amount);
    this.duckUntil = Math.max(this.duckUntil, until);
  }

  update(now: number, dt: number): void {
    if (now > this.duckUntil) this.duckTo = 1;
    this.musicDuck.to(this.duckTo, dt, this.duckTo < 1 ? 0.45 : 1.6);
  }

  push(now: number): void {
    this.musicLow.push(now);
    this.musicVeil.push(now);
    this.worldVeil.push(now);
    this.musicDuck.push(now);
    this.wet.push(now);
  }
}
