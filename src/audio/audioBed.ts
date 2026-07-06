import type { AircraftState } from '../sim/state';

/**
 * The audio layer, phase 3 edition: a simple ambient bed, architected so the
 * adaptive score (Q1: layers that swell with climb, a motif on catching a
 * thermal) can slot in later — everything routes through one master gain and
 * update() already receives full flight state every frame.
 *
 * Two voices for now:
 *  - wind: filtered noise whose loudness and brightness follow airspeed —
 *    the craft's speed made audible, diegetic and free
 *  - bed: a very quiet two-note drone (A2 + E3) breathing on a slow swell
 *
 * Browsers require a user gesture before audio; start() is called on the
 * first keydown/pointerdown. M toggles mute.
 */
export class AudioBed {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private windGain!: GainNode;
  private windFilter!: BiquadFilterNode;
  private muted = false;

  start(): void {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 1;
    this.master.connect(ctx.destination);

    // --- wind: looped white noise → bandpass → gain -----------------------
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    noise.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 500;
    this.windFilter.Q.value = 0.6;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    noise.connect(this.windFilter).connect(this.windGain).connect(this.master);
    noise.start();

    // --- bed: two soft detuned drones on a slow breath --------------------
    const padGain = ctx.createGain();
    padGain.gain.value = 0.035;
    const padFilter = ctx.createBiquadFilter();
    padFilter.type = 'lowpass';
    padFilter.frequency.value = 420;
    padFilter.connect(padGain).connect(this.master);
    for (const [freq, type, level] of [
      [110, 'sine', 1],
      [164.8, 'sine', 0.6],
      [110.7, 'triangle', 0.22],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(padFilter);
      osc.start();
    }
    // the breath: a very slow LFO easing the pad in and out
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.045;
    const lfoDepth = ctx.createGain();
    lfoDepth.gain.value = 0.012;
    lfo.connect(lfoDepth).connect(padGain.gain);
    lfo.start();
  }

  /** Follow flight state — for now, only the wind listens. */
  update(state: AircraftState): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const speedFactor = Math.min(1, Math.max(0, (state.airspeed - 8) / 40));
    this.windGain.gain.setTargetAtTime(0.015 + 0.16 * speedFactor, t, 0.25);
    this.windFilter.frequency.setTargetAtTime(320 + 1400 * speedFactor, t, 0.25);
  }

  toggleMute(): void {
    if (!this.ctx) return;
    this.muted = !this.muted;
    this.master.gain.setTargetAtTime(this.muted ? 0 : 1, this.ctx.currentTime, 0.1);
  }
}
