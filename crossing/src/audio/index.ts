import type { Config } from '../sim/config';
import type { BirdState, DayPhase, SkyState } from '../sim/types';
import { AirKind } from '../sim/types';
import { clamp, clamp01, lerp } from '../sim/math';

/**
 * EVERYTHING SYNTHESISED. No files, no libraries.
 *
 * Three layers, in order of how much they matter:
 *
 *   THE VARIO. Real sailplane pilots fly by ear — the audio variometer tells
 *   you that you have found lift before your eyes get to the instrument, and
 *   it is how you centre a thermal without looking at anything. It beeps
 *   faster and higher as you climb, and drops to a low continuous tone in
 *   sink. Its timbre changes with the KIND of air, so wave — pure, glassy,
 *   bell-like — announces itself before any part of the interface does.
 *
 *   THE WIND. Filtered noise tracking airspeed. Kept deliberately DARK: the
 *   first audio pass on the original Aloft failed because noise-based wind
 *   read as static on laptop speakers. It should be felt more than heard,
 *   until you tuck, at which point it should roar.
 *
 *   THE SCORE. A slow generative bed that follows the day: a drone whose root
 *   moves through six harmonic centres, one per phase, and a sparse pentatonic
 *   bell voice whose note spacing TIGHTENS AS YOU CLIMB. Tempo is a readout,
 *   never a groove. At night almost everything drops away, because by then
 *   the silence is the reward.
 *
 * Notes are scheduled with a lookahead against audioContext.currentTime —
 * scheduling from requestAnimationFrame jitters audibly.
 */

/** How far ahead the scheduler queues events, and how often it wakes. */
const LOOKAHEAD = 0.15;
const SCHEDULE_INTERVAL = 45; // ms

/**
 * The day's harmony. One root per phase, walking down a fifth at a time and
 * landing somewhere unresolved at night. The scale is pentatonic throughout,
 * so nothing can ever clash with the drone no matter what the climb rate
 * decides to play.
 */
const PHASE_ROOT: Record<DayPhase, number> = {
  dawn: 146.83, // D3
  morning: 164.81, // E3
  noon: 196.0, // G3
  afternoon: 174.61, // F3
  evening: 130.81, // C3
  night: 110.0, // A2
};

/** Minor pentatonic degrees, in semitones. Melancholy without being maudlin. */
const PENT = [0, 3, 5, 7, 10, 12, 15, 17, 19, 22, 24];

const semi = (n: number): number => Math.pow(2, n / 12);

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private started = false;
  private _muted = false;

  // graph
  private master!: GainNode;
  private musicBus!: GainNode;
  private windBus!: GainNode;
  private varioBus!: GainNode;
  private reverbSend!: GainNode;

  // wind
  private windSrc!: AudioBufferSourceNode;
  private windFilter!: BiquadFilterNode;
  private windGain!: GainNode;
  private rumbleSrc!: AudioBufferSourceNode;
  private rumbleFilter!: BiquadFilterNode;
  private rumbleGain!: GainNode;
  private edgeFilter!: BiquadFilterNode;
  private edgeGain!: GainNode;

  // drone
  private droneOscs: OscillatorNode[] = [];
  private droneGain!: GainNode;
  private droneFilter!: BiquadFilterNode;

  // vario
  private varioOsc!: OscillatorNode;
  private varioGain!: GainNode;
  private varioFilter!: BiquadFilterNode;
  private varioBeatPhase = 0;

  // scheduler
  private timer: number | null = null;
  private nextNoteAt = 0;

  // smoothed drivers
  private climb = 0;
  private speed01 = 0;
  private altitude01 = 0;
  private turbulence = 0;
  private phase: DayPhase = 'dawn';
  private kind: AirKind = AirKind.Still;
  private nightness = 0;

  constructor(private readonly cfg: Config) {}

  get muted(): boolean {
    return this._muted;
  }

  setMuted(m: boolean): void {
    this._muted = m;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(m ? 0 : this.cfg.masterVolume, this.ctx.currentTime, 0.15);
    }
  }

  async start(): Promise<void> {
    if (this.started) {
      if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      this.ctx = new Ctor();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      this.build();
      this.started = true;
      this.nextNoteAt = this.ctx.currentTime + 0.3;
      this.timer = window.setInterval(() => this.schedule(), SCHEDULE_INTERVAL);
    } catch {
      // A browser that will not give us audio is not a reason to stop flying.
      this.ctx = null;
    }
  }

  // ------------------------------------------------------------- the graph

  private build(): void {
    const ctx = this.ctx;
    if (!ctx) return;

    // A compressor on the master so a violent rotor and a quiet night both
    // land somewhere usable, and nothing ever clips.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 22;
    comp.ratio.value = 3.2;
    comp.attack.value = 0.006;
    comp.release.value = 0.28;

    this.master = ctx.createGain();
    this.master.gain.value = this._muted ? 0 : this.cfg.masterVolume;
    comp.connect(this.master);
    this.master.connect(ctx.destination);

    // Reverb from a generated impulse: exponentially decaying noise. Cheap,
    // and at altitude we push the wet mix up so that height sounds like space.
    const convolver = ctx.createConvolver();
    convolver.buffer = impulse(ctx, 3.4, 2.6);
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.25;
    this.reverbSend.connect(convolver);
    convolver.connect(comp);

    this.musicBus = ctx.createGain();
    this.musicBus.gain.value = this.cfg.musicVolume;
    this.musicBus.connect(comp);
    this.musicBus.connect(this.reverbSend);

    this.windBus = ctx.createGain();
    this.windBus.gain.value = this.cfg.windVolume;
    this.windBus.connect(comp);

    this.varioBus = ctx.createGain();
    this.varioBus.gain.value = 0.32;
    this.varioBus.connect(comp);
    this.varioBus.connect(this.reverbSend);

    this.buildWind(ctx);
    this.buildDrone(ctx);
    this.buildVario(ctx);
  }

  private buildWind(ctx: AudioContext): void {
    const noise = noiseBuffer(ctx, 4);

    // Main band: the body of the airflow. Its centre frequency rides
    // airspeed, so the pitch of the wind IS the speedometer.
    this.windSrc = ctx.createBufferSource();
    this.windSrc.buffer = noise;
    this.windSrc.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 320;
    this.windFilter.Q.value = 0.7;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windSrc.connect(this.windFilter);
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.windBus);
    this.windSrc.start();

    // Rumble: everything below 120 Hz, driven by turbulence. This is the
    // layer that makes rotor frightening without making it loud.
    this.rumbleSrc = ctx.createBufferSource();
    this.rumbleSrc.buffer = noise;
    this.rumbleSrc.loop = true;
    this.rumbleSrc.playbackRate.value = 0.6;
    this.rumbleFilter = ctx.createBiquadFilter();
    this.rumbleFilter.type = 'lowpass';
    this.rumbleFilter.frequency.value = 120;
    this.rumbleFilter.Q.value = 1.4;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    this.rumbleSrc.connect(this.rumbleFilter);
    this.rumbleFilter.connect(this.rumbleGain);
    this.rumbleGain.connect(this.windBus);
    this.rumbleSrc.start();

    // Edge: a bright top band that only arrives near top speed, so a full
    // tuck has a sound nothing else in the game has.
    this.edgeFilter = ctx.createBiquadFilter();
    this.edgeFilter.type = 'highpass';
    this.edgeFilter.frequency.value = 2400;
    this.edgeGain = ctx.createGain();
    this.edgeGain.gain.value = 0;
    this.windSrc.connect(this.edgeFilter);
    this.edgeFilter.connect(this.edgeGain);
    this.edgeGain.connect(this.windBus);
  }

  private buildDrone(ctx: AudioContext): void {
    this.droneFilter = ctx.createBiquadFilter();
    this.droneFilter.type = 'lowpass';
    this.droneFilter.frequency.value = 520;
    this.droneFilter.Q.value = 0.6;
    this.droneGain = ctx.createGain();
    this.droneGain.gain.value = 0.0;
    this.droneFilter.connect(this.droneGain);
    this.droneGain.connect(this.musicBus);

    // Three oscillators, slightly detuned. The beating between them is what
    // stops a sustained tone from sounding like a test signal.
    const detunes = [-6, 0, 7];
    for (const d of detunes) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = PHASE_ROOT.dawn;
      o.detune.value = d;
      const g = ctx.createGain();
      g.gain.value = d === 0 ? 0.16 : 0.09;
      o.connect(g);
      g.connect(this.droneFilter);
      o.start();
      this.droneOscs.push(o);
    }
  }

  private buildVario(ctx: AudioContext): void {
    this.varioOsc = ctx.createOscillator();
    this.varioOsc.type = 'triangle';
    this.varioOsc.frequency.value = 440;
    this.varioFilter = ctx.createBiquadFilter();
    this.varioFilter.type = 'lowpass';
    this.varioFilter.frequency.value = 2600;
    this.varioGain = ctx.createGain();
    this.varioGain.gain.value = 0;
    this.varioOsc.connect(this.varioFilter);
    this.varioFilter.connect(this.varioGain);
    this.varioGain.connect(this.varioBus);
    this.varioOsc.start();
  }

  // ---------------------------------------------------------------- update

  update(dt: number, bird: BirdState, sky: SkyState, flockCount: number): void {
    void flockCount;
    const ctx = this.ctx;
    if (!ctx || !this.started) return;
    const now = ctx.currentTime;
    const k = 1 - Math.exp(-dt * 4);

    // Smooth every driver — audio parameters that track raw sim values
    // chatter, and chatter is the difference between a soundscape and a bug.
    this.climb += (bird.climbRate - this.climb) * k;
    this.speed01 += (clamp01(bird.airspeed / this.cfg.maxAirspeed) - this.speed01) * k;
    this.altitude01 += (clamp01(bird.position.y / 5000) - this.altitude01) * k;
    this.turbulence += (bird.turbulence - this.turbulence) * k;
    this.phase = sky.phase;
    this.kind = bird.airKind;
    this.nightness += (clamp01(1 - sky.thermalActivity * 3) * (sky.starVisibility * 0.8 + 0.2) - this.nightness) * k * 0.4;

    // --- wind --------------------------------------------------------------
    const s = this.speed01;
    this.windFilter.frequency.setTargetAtTime(180 + s * 900, now, 0.1);
    this.windFilter.Q.setTargetAtTime(0.6 + s * 1.4, now, 0.15);
    // Deliberately gentle curve: the wind should not be the loudest thing in
    // the mix until you are genuinely moving.
    this.windGain.gain.setTargetAtTime(0.05 + s * s * 0.5, now, 0.12);
    this.rumbleGain.gain.setTargetAtTime(0.06 + this.turbulence * 0.42 + s * 0.1, now, 0.1);
    this.rumbleFilter.frequency.setTargetAtTime(90 + this.turbulence * 110, now, 0.2);
    this.edgeGain.gain.setTargetAtTime(Math.max(0, s - 0.66) * 0.34, now, 0.15);

    // --- drone -------------------------------------------------------------
    const root = PHASE_ROOT[this.phase];
    for (const o of this.droneOscs) o.frequency.setTargetAtTime(root, now, 2.5);
    // The drone opens up with height: more level, brighter filter. Being high
    // should feel like being somewhere with more room in it.
    this.droneGain.gain.setTargetAtTime(0.16 + this.altitude01 * 0.16, now, 1.2);
    this.droneFilter.frequency.setTargetAtTime(380 + this.altitude01 * 900, now, 1.5);
    this.reverbSend.gain.setTargetAtTime(0.18 + this.altitude01 * 0.42, now, 1.5);

    // --- vario -------------------------------------------------------------
    this.updateVario(dt, now);
  }

  /**
   * The audio variometer. Above a small deadband it beeps; the beep rate and
   * pitch both rise with climb rate. Below it, a low continuous tone that
   * gets lower the faster you are sinking. Between the two, silence — level
   * flight should not make a sound.
   */
  private updateVario(dt: number, now: number): void {
    const v = this.climb;
    const DEADBAND = 0.35;

    if (v > DEADBAND) {
      const strength = clamp01((v - DEADBAND) / 5);
      // 1.6 Hz at the threshold up to ~9 Hz in a screamer.
      const rate = 1.6 + strength * 7.4;
      this.varioBeatPhase += dt * rate;
      const duty = this.varioBeatPhase % 1;

      // Wave gets a pure, sustained, bell-like voice instead of a beep — the
      // smoothest air in the game should sound like the smoothest air.
      const isWave = this.kind === AirKind.Wave;
      this.varioOsc.type = isWave ? 'sine' : 'triangle';
      const pitch = (isWave ? 520 : 330) * semi(Math.round(strength * 14));
      this.varioFilter.frequency.setTargetAtTime(isWave ? 4200 : 2200, now, 0.2);
      this.varioOsc.frequency.setTargetAtTime(pitch, now, 0.05);

      const on = isWave ? 1 : duty < 0.55 ? 1 : 0;
      this.varioGain.gain.setTargetAtTime(on * (0.06 + strength * 0.14), now, 0.02);
    } else if (v < -2.2) {
      // Sink: a low, continuous, slightly unpleasant tone. Not an alarm — a
      // pressure. You want to leave.
      this.varioBeatPhase = 0;
      this.varioOsc.type = 'sine';
      const depth = clamp01((-v - 2.2) / 5);
      this.varioOsc.frequency.setTargetAtTime(150 - depth * 55, now, 0.25);
      this.varioFilter.frequency.setTargetAtTime(700, now, 0.3);
      this.varioGain.gain.setTargetAtTime(0.03 + depth * 0.06, now, 0.2);
    } else {
      this.varioBeatPhase = 0;
      this.varioGain.gain.setTargetAtTime(0, now, 0.14);
    }
  }

  // ------------------------------------------------------------- scheduler

  /**
   * The melodic layer. Note spacing tightens as the bird climbs, so the music
   * itself is a variometer — but a slow one, operating on the scale of a whole
   * climb rather than a second. At night it thins almost to nothing.
   */
  private schedule(): void {
    const ctx = this.ctx;
    if (!ctx || this._muted) return;
    const horizon = ctx.currentTime + LOOKAHEAD;

    while (this.nextNoteAt < horizon) {
      const t = this.nextNoteAt;

      // Interval: eight seconds when gliding quietly, under two when going up
      // hard. Night stretches everything out.
      const climbing = clamp01(this.climb / 4);
      const base = lerp(7.5, 1.9, climbing);
      const gap = base * lerp(1, 2.1, this.nightness);

      // Density: fewer notes at night, and none at all in the deep of it —
      // reaching the dark should feel like the score stepping back to let you
      // hear how quiet it is up there.
      const play = this.nightness < 0.72 || climbing > 0.4;
      if (play) {
        const root = PHASE_ROOT[this.phase];
        // Higher notes when higher up, so the melody drifts upward with you.
        const spread = Math.floor(this.altitude01 * 4);
        const idx = clamp(
          Math.floor(pseudoRandom(t) * (PENT.length - spread)) + spread,
          0,
          PENT.length - 1,
        );
        const freq = root * 2 * semi(PENT[idx]);
        this.bell(t, freq, 0.09 * (1 - this.nightness * 0.45));
        // An occasional lower fifth underneath, so the line has a floor.
        if (pseudoRandom(t + 91.3) > 0.78) this.bell(t + 0.14, freq * 0.5, 0.055);
      }

      this.nextNoteAt += gap;
    }
  }

  /** One plucked bell: fast attack, long exponential tail, a little detune. */
  private bell(at: number, freq: number, level: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = freq;
    const o2 = ctx.createOscillator();
    o2.type = 'triangle';
    o2.frequency.value = freq * 2.01;
    const g = ctx.createGain();
    const g2 = ctx.createGain();
    g2.gain.value = 0.22;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(level, at + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 3.4);
    o.connect(g);
    o2.connect(g2);
    g2.connect(g);
    g.connect(this.musicBus);
    o.start(at);
    o2.start(at);
    o.stop(at + 3.6);
    o2.stop(at + 3.6);
  }

  // ------------------------------------------------------------------ cues

  cue(event: 'launch' | 'thermal' | 'wave' | 'companion' | 'landing' | 'phase' | 'ui'): void {
    const ctx = this.ctx;
    if (!ctx || !this.started || this._muted) return;
    const t = ctx.currentTime + 0.02;
    const root = PHASE_ROOT[this.phase];

    switch (event) {
      case 'companion':
        // Two rising notes. Small, warm, and easy to miss if you are busy.
        this.bell(t, root * 3 * semi(7), 0.075);
        this.bell(t + 0.16, root * 3 * semi(12), 0.065);
        break;
      case 'wave':
        // The pad opens. This should feel like a door.
        this.bell(t, root * 2, 0.11);
        this.bell(t + 0.05, root * 3 * semi(7), 0.08);
        this.bell(t + 0.1, root * 4, 0.06);
        break;
      case 'thermal':
        this.bell(t, root * 2 * semi(5), 0.07);
        break;
      case 'launch':
        this.bell(t, root, 0.1);
        this.bell(t + 0.3, root * 1.5, 0.07);
        break;
      case 'landing':
        // A long resolving chord. The only fully consonant thing in the game.
        this.bell(t, root, 0.11);
        this.bell(t + 0.09, root * semi(7), 0.09);
        this.bell(t + 0.18, root * 2, 0.075);
        this.bell(t + 0.3, root * 2 * semi(4), 0.06);
        break;
      case 'phase':
        this.bell(t, root * 4 * semi(12), 0.035);
        break;
      case 'ui':
        this.bell(t, root * 4, 0.03);
        break;
    }
  }

  dispose(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    if (!this.ctx) return;
    try {
      for (const o of this.droneOscs) o.stop();
      this.varioOsc.stop();
      this.windSrc.stop();
      this.rumbleSrc.stop();
      void this.ctx.close();
    } catch {
      /* already torn down */
    }
    this.ctx = null;
    this.started = false;
  }
}

// ------------------------------------------------------------------ helpers

/** A few seconds of white noise, generated once and looped. */
function noiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    // Slightly pink rather than white — white noise is hissy and fatiguing,
    // and wind is not hissy.
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = 0.97 * last + 0.03 * w;
      d[i] = last * 3.2 + w * 0.35;
    }
  }
  return buf;
}

/** Exponentially decaying noise — a serviceable convolution reverb tail. */
function impulse(ctx: AudioContext, seconds: number, decay: number): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

/** Deterministic-enough hash on the schedule time, so the melody is varied
 *  without being random from frame to frame. */
function pseudoRandom(t: number): number {
  const x = Math.sin(t * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}
