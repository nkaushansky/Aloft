import type { AircraftState } from '../sim/state';

/**
 * The audio layer, second iteration. Playtest verdict on v1: noise-based
 * wind read as "static getting louder" on laptop speakers. New direction —
 * calming tones first:
 *
 *  - chimes: a slow generative melody of soft pentatonic bells. The faster
 *    you fly, the closer together the notes fall — tempo is the speed
 *    readout now, not hiss. Never a beat, never a hurry.
 *  - drone: a barely-there root-and-fifth breathing on a slow swell.
 *  - wind: demoted to a quiet, dark rumble (brown noise, lowpassed) that
 *    only whispers underneath at speed.
 *
 * Still routed through one master gain with full flight state flowing into
 * update() every frame, so the true adaptive score (Q1) slots in later.
 * Starts on first gesture (browser policy); M toggles mute.
 */
export class AudioBed {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private chimeOut!: GainNode;
  private nextNoteTime = 0;
  private muted = false;

  /** A-minor pentatonic, sitting low: meditative, no wrong notes. */
  private static readonly SCALE = [164.81, 196.0, 220.0, 261.63, 293.66, 329.63];

  start(): void {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(ctx.destination);

    // --- wind: brown noise (soft, dark — no hiss) → lowpass → gain --------
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.02 * white) / 1.02;
      data[i] = last * 3.5;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    noise.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'lowpass';
    this.windFilter.frequency.value = 300;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    noise.connect(this.windFilter).connect(this.windGain).connect(this.master);
    noise.start();

    // --- drone: root + fifth, very quiet, breathing slowly ----------------
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0.022;
    const droneFilter = ctx.createBiquadFilter();
    droneFilter.type = 'lowpass';
    droneFilter.frequency.value = 340;
    droneFilter.connect(droneGain).connect(this.master);
    for (const [freq, level] of [
      [110, 1], // A2
      [164.81, 0.5], // E3
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(droneFilter);
      osc.start();
    }
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.04;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.008;
    lfo.connect(lfoDepth).connect(droneGain.gain);
    lfo.start();

    // --- chimes bus, with a soft echo so each bell hangs in space ---------
    this.chimeOut = ctx.createGain();
    this.chimeOut.gain.value = 1;
    this.chimeOut.connect(this.master);
    const delay = ctx.createDelay(2);
    delay.delayTime.value = 0.7;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.32;
    const echoTone = ctx.createBiquadFilter();
    echoTone.type = 'lowpass';
    echoTone.frequency.value = 900; // echoes come back darker, like distance
    this.chimeOut.connect(delay);
    delay.connect(echoTone).connect(feedback).connect(delay);
    feedback.connect(this.master);
    this.nextNoteTime = ctx.currentTime + 1.6;
  }

  /** Follow flight state: wind whispers with speed, chimes quicken with it. */
  update(state: AircraftState): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const speedFactor = Math.min(1, Math.max(0, (state.airspeed - 8) / 40));

    this.windGain.gain.setTargetAtTime(0.006 + 0.045 * speedFactor, t, 0.3);
    this.windFilter.frequency.setTargetAtTime(240 + 550 * speedFactor, t, 0.3);

    // schedule the next bell just ahead of time; spacing shrinks with speed,
    // but never below a meditative floor — at high speed the wind carries
    // the urgency, the bells stay unhurried
    if (t > this.nextNoteTime - 0.15) {
      this.playChime(Math.max(this.nextNoteTime, t + 0.05), speedFactor);
      const base = 7.5 - 4.2 * speedFactor;
      const jitter = 0.65 + Math.random() * 0.7;
      this.nextNoteTime = Math.max(this.nextNoteTime, t) + Math.max(1.8, base * jitter);
    }
  }

  /** One soft bell: a slow bloom rather than a strike, fading over ~6s. */
  private playChime(when: number, speedFactor: number): void {
    const ctx = this.ctx!;
    const scale = AudioBed.SCALE;
    // at speed, allow the upper half of the scale a little more often
    const idx = Math.min(
      scale.length - 1,
      Math.floor(Math.random() * scale.length + speedFactor * 1.5),
    );
    const freq = scale[idx];
    for (const [mult, level] of [
      [1, 0.048],
      [2, 0.008],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq * mult;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, when);
      env.gain.linearRampToValueAtTime(level, when + 0.35); // bloom, don't strike
      env.gain.exponentialRampToValueAtTime(0.0001, when + 6.0);
      osc.connect(env).connect(this.chimeOut);
      osc.start(when);
      osc.stop(when + 6.2);
    }
  }

  toggleMute(): void {
    if (!this.ctx) return;
    this.muted = !this.muted;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 1, this.ctx.currentTime, 0.1);
  }
}
