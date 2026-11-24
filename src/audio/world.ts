/**
 * The world, under the music: dark soft wind that hums in key, wings, water,
 * and whoever happens to be singing nearby. Loud only ever means close.
 */
import type { LandId } from '../world/lands';
import type { AudioFrame, Scene } from './engine';
import { CraneCall, renderCrane } from './crane';
import { EVENTUALLY, LATER, Need, Rng, SOON, Workshop, clamp, ease, lerp, mtof, semis, smooth, spread, stereo } from './dsp';
import type { Mixer } from './mixer';
import type { Music } from './music';
import * as N from './nature';
import { Bus, Player } from './player';

type SampleSet = AudioBuffer[];

/** Who lives where, and how often they speak (mean seconds). */
interface Resident {
  set: string;
  every: number;
  gain: number;
  rate: [number, number];
  cut: number;
  /** 0..1 given what is around */
  when: (f: AudioFrame) => number;
}

const near = (f: AudioFrame, lo: number, hi: number): number => 1 - smooth(lo, hi, f.agl);

const RESIDENTS: Record<LandId, Resident[]> = {
  stillmere: [
    { set: 'frog', every: 2.6, gain: 0.125, rate: [0.85, 1.15], cut: 1700, when: (f) => near(f, 15, 150) * (0.35 + 0.65 * Math.max(f.water, f.night)) * (0.45 + 0.55 * Math.max(f.night, Math.abs(f.progress - 0.4) * 1.7)) },
    { set: 'peeper', every: 2.2, gain: 0.055, rate: [0.9, 1.1], cut: 3600, when: (f) => near(f, 15, 130) * (0.15 + 0.85 * Math.max(f.night, smooth(0.6, 1, f.progress), smooth(0.2, 0, f.progress))) },
    { set: 'warbler', every: 9, gain: 0.075, rate: [0.85, 1.05], cut: 4200, when: (f) => near(f, 25, 200) * (1 - f.night) },
    { set: 'lap', every: 2.4, gain: 0.133, rate: [0.8, 1.15], cut: 2200, when: (f) => near(f, 4, 40) * Math.max(f.water, f.overWater ? 1 : 0) },
  ],
  copper: [
    { set: 'songbird', every: 5.5, gain: 0.08, rate: [0.82, 1.08], cut: 4600, when: (f) => near(f, 30, 230) * (0.25 + 0.75 * f.forest) * (1 - f.night) },
    { set: 'lap', every: 3.4, gain: 0.095, rate: [0.8, 1.1], cut: 2000, when: (f) => near(f, 4, 35) * f.water },
  ],
  stair: [{ set: 'lap', every: 4, gain: 0.076, rate: [0.8, 1], cut: 1800, when: (f) => near(f, 4, 30) * f.water }],
  rooms: [
    { set: 'wren', every: 15, gain: 0.075, rate: [0.86, 1.04], cut: 3800, when: (f) => near(f, 40, 320) * (1 - f.night) * (1 - 0.7 * f.storm) },
    { set: 'lap', every: 3, gain: 0.095, rate: [0.8, 1.1], cut: 2000, when: (f) => near(f, 4, 35) * f.water },
  ],
  darkwater: [{ set: 'lap', every: 2.8, gain: 0.095, rate: [0.65, 0.95], cut: 1700, when: (f) => near(f, 3, 26) * Math.max(f.water, f.overWater ? 1 : 0) }],
  wintering: [
    { set: 'warbler', every: 13, gain: 0.05, rate: [0.8, 1], cut: 3800, when: (f) => near(f, 25, 180) },
    { set: 'frog', every: 6, gain: 0.075, rate: [0.9, 1.15], cut: 1600, when: (f) => near(f, 12, 100) * f.water * (1 - smooth(0.2, 0.6, f.progress)) },
    { set: 'lap', every: 2.8, gain: 0.114, rate: [0.8, 1.15], cut: 2200, when: (f) => near(f, 4, 40) * Math.max(f.water, f.overWater ? 1 : 0) },
  ],
};

/** per-land wind: how much of it there is, and the pitch it hums (semitones above root) */
const WIND: Record<LandId, { amt: number; hum: [number, number, number]; humAmt: number; hush: number; leaves: number; waves: number }> = {
  stillmere: { amt: 0.8, hum: [12, 19, 24], humAmt: 0.8, hush: 0.1, leaves: 0.35, waves: 0.15 },
  copper: { amt: 1, hum: [12, 19, 24], humAmt: 0.9, hush: 0.1, leaves: 1, waves: 0.05 },
  stair: { amt: 1.1, hum: [19, 24, 31], humAmt: 1.5, hush: 0.55, leaves: 0.1, waves: 0 },
  rooms: { amt: 0.85, hum: [12, 19, 24], humAmt: 1.0, hush: 0.05, leaves: 0.15, waves: 0.05 },
  darkwater: { amt: 0.8, hum: [12, 19, 24], humAmt: 0.8, hush: 0.1, leaves: 0.05, waves: 1 },
  wintering: { amt: 0.7, hum: [12, 16, 19], humAmt: 0.7, hush: 0.08, leaves: 0.3, waves: 0.2 },
};

const HUM_MIX = [1, 0.75, 0.42];

const SCENE_WORLD: Record<Scene, { bed: number; wind: number; life: number }> = {
  title: { bed: 0.8, wind: 0.55, life: 0.8 },
  flight: { bed: 1, wind: 1, life: 1 },
  roost: { bed: 0.9, wind: 0.4, life: 0.8 },
  night: { bed: 0.75, wind: 0.35, life: 0.55 },
  finale: { bed: 1, wind: 0.6, life: 0.8 },
  silent: { bed: 0, wind: 0, life: 0 },
};

export class World {
  private sets = new Map<string, SampleSet>();
  private calls: CraneCall[] = []; // the player's own, at their present age
  private callsAge = -1;
  private flock: CraneCall[] = []; // grown birds

  private windLow: Bus;
  private windOpen: Bus;
  private hums: { f: BiquadFilterNode; g: Bus; hz: number }[] = [];
  private hush: Bus;
  private leaves: Bus;
  private waves: Bus;
  private foam: Bus;
  private skim: Bus;
  private brush: Bus;
  private insects: Bus;
  private murmur: Bus;
  private life: Bus;
  private wings: Bus;
  private near: Bus;
  private buses: Bus[];
  private bedsOn = false;
  private insectsOn: AudioBufferSourceNode | null = null;
  private murmurOn: AudioBufferSourceNode | null = null;

  private land: LandId | null = null;
  private landAt = 0;
  private scene: Scene = 'title';
  private next = new Float64Array(8);
  private thunderAt = 0;
  private thunderLast = -99;
  private lastSin = 0;
  private lastTouch = 0;
  private lastSkim = 0;
  private clock = 0;
  private e = { speed: 20, agl: 50, dive: 0, cloud: 0, storm: 0, forest: 0, water: 0, wind: 2, air: 0, touch: 0, bank: 0 };
  private sc = { bed: 0, wind: 0, life: 0 };

  constructor(
    private ctx: BaseAudioContext,
    private mix: Mixer,
    private shop: Workshop,
    private player: Player,
    private music: Music,
    private rng: Rng,
  ) {
    const d = mix.world;
    const w = mix.worldSend;
    this.windLow = new Bus(ctx, d, w, 0, 320, 0.05);
    this.windOpen = new Bus(ctx, d, w, 0, 700, 0.06);
    for (let i = 0; i < 3; i++) {
      const f = stereo(ctx.createBiquadFilter());
      f.type = 'bandpass';
      f.Q.value = 26;
      f.frequency.value = 400;
      const g = new Bus(ctx, d, w, 0, 2400, 0.9);
      f.connect(g.in);
      this.hums.push({ f, g, hz: 0 });
    }
    this.hush = new Bus(ctx, d, w, 0, 1300, 0.25);
    this.leaves = new Bus(ctx, d, w, 0, 2000, 0.15);
    this.waves = new Bus(ctx, d, w, 0, 420, 0.25);
    this.foam = new Bus(ctx, d, w, 0, 1100, 0.3);
    this.skim = new Bus(ctx, d, w, 0, 2400, 0.25);
    this.brush = new Bus(ctx, d, w, 0, 1500, 0.1);
    this.insects = new Bus(ctx, d, w, 0, 3400, 0.5);
    this.murmur = new Bus(ctx, d, w, 0, 1900, 0.9);
    this.life = new Bus(ctx, d, w, 0, 5200, 0.8);
    this.wings = new Bus(ctx, d, w, 1, 900, 0.08);
    this.near = new Bus(ctx, d, w, 1, 4200, 0.35);
    this.buses = [this.windLow, this.windOpen, this.hush, this.leaves, this.waves, this.foam, this.skim, this.brush, this.insects, this.murmur, this.life, this.wings, this.near];
    for (const h of this.hums) this.buses.push(h.g);

    // the essentials, in the order they will be missed
    this.grow('pink', 1, N.renderPink, SOON);
    this.grow('whuff', 4, N.renderWhuff, SOON);
    this.cranes(2, SOON);
    this.grow('splash', 2, N.renderSplash, LATER);
    this.grow('rustle', 2, N.renderRustle, LATER);
    this.grow('trickle', 1, N.renderTrickle, LATER);
    this.cranes(4, LATER);
  }

  private grow(name: string, n: number, make: (ctx: BaseAudioContext, rng: Rng, done: (b: AudioBuffer) => void) => Generator<void, void, void>, need: Need = EVENTUALLY): void {
    if (this.sets.has(name)) return;
    const set: SampleSet = [];
    this.sets.set(name, set);
    for (let i = 0; i < n; i++) this.shop.add(make(this.ctx, this.rng, (b) => set.push(b)), need);
  }

  private cranes(n: number, need: Need): void {
    for (let i = 0; i < n; i++)
      this.shop.add(
        renderCrane(this.ctx, 1, this.rng, (c) => {
          this.flock.push(c);
        }),
        need,
      );
  }

  private one(name: string): AudioBuffer | null {
    const s = this.sets.get(name);
    return s && s.length ? s[Math.floor(this.rng() * s.length)] : null;
  }

  // ------------------------------------------------------------------ land
  setLand(id: LandId): void {
    if (this.land === id) return;
    this.land = id;
    this.landAt = this.ctx.currentTime;
    const t = this.ctx.currentTime;
    for (let i = 0; i < this.next.length; i++) this.next[i] = t + 3 + this.rng() * 5;
    this.thunderAt = t + 12;
    if (id !== 'rooms') this.stopLoop('insects', t);
    if (id !== 'wintering') this.stopLoop('murmur', t);
    switch (id) {
      case 'stillmere':
        this.grow('lap', 3, N.renderLap);
        this.grow('frog', 5, N.renderFrog);
        this.grow('peeper', 3, N.renderPeeper);
        this.grow('warbler', 3, N.renderWarbler);
        break;
      case 'copper':
        this.grow('songbird', 6, N.renderSongbird);
        this.grow('lap', 3, N.renderLap);
        break;
      case 'stair':
        this.grow('lap', 3, N.renderLap);
        this.growBell();
        break;
      case 'rooms':
        this.grow('thunder', 2, N.renderThunder);
        this.grow('wren', 3, N.renderWren);
        this.grow('insects', 1, N.renderInsects);
        this.grow('lap', 3, N.renderLap);
        break;
      case 'darkwater':
        this.grow('whale', 2, N.renderWhale);
        this.grow('lap', 3, N.renderLap);
        break;
      case 'wintering':
        this.grow('warbler', 3, N.renderWarbler);
        this.grow('frog', 5, N.renderFrog);
        this.grow('lap', 3, N.renderLap);
        if (!this.sets.has('murmur')) {
          const set: SampleSet = [];
          this.sets.set('murmur', set);
          const self = this;
          this.shop.add(
            (function* () {
              yield* N.renderMurmur(
                self.ctx,
                self.flock.map((c) => c.buf),
                self.rng,
                (b) => set.push(b),
              );
            })(),
            EVENTUALLY,
          );
        }
        break;
    }
    const age = { stillmere: 0, copper: 0.2, stair: 0.4, rooms: 0.6, darkwater: 0.8, wintering: 1 }[id];
    this.learn(age);
  }

  private bellPrime = 62;
  private growBell(): void {
    if (this.sets.has('bell')) return;
    const set: SampleSet = [];
    this.sets.set('bell', set);
    // its prime sits on the land's own note, so it belongs to the harmony
    this.bellPrime = this.music.root;
    this.shop.add(N.renderGreatBell(this.ctx, this.bellPrime, this.rng, (b) => set.push(b)), EVENTUALLY);
  }

  setScene(s: Scene): void {
    this.scene = s;
  }

  private stopLoop(which: 'insects' | 'murmur', t: number): void {
    const k = which === 'insects' ? 'insectsOn' : 'murmurOn';
    this[k]?.stop(t + 14);
    this[k] = null;
  }

  // ------------------------------------------------------------------ beds
  private loop(buf: AudioBuffer, into: AudioNode[], rate: number, offset: number): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.value = rate;
    for (const n of into) s.connect(n);
    s.onended = () => s.disconnect();
    s.start(this.ctx.currentTime + 0.02, offset * buf.duration);
    return s;
  }

  private startBeds(): void {
    const pink = this.one('pink');
    if (!pink) return;
    this.bedsOn = true;
    this.loop(pink, [this.windLow.in, this.windOpen.in, this.waves.in], 1, 0.1);
    this.loop(pink, [...this.hums.map((h) => h.f), this.hush.in, this.brush.in], 1.07, 0.45);
    this.loop(pink, [this.leaves.in, this.foam.in], 0.93, 0.77);
  }

  private tryLoops(): void {
    if (!this.bedsOn) this.startBeds();
    if (this.land === 'rooms' && !this.insectsOn) {
      const b = this.one('insects');
      if (b) this.insectsOn = this.loop(b, [this.insects.in], 0.94, 0);
    }
    if (this.land === 'wintering' && !this.murmurOn) {
      const b = this.one('murmur');
      if (b) this.murmurOn = this.loop(b, [this.murmur.in], 1, this.rng());
    }
    if (!this.skimOn) {
      const b = this.one('trickle');
      if (b) {
        this.loop(b, [this.skim.in], 1, 0);
        this.skimOn = true;
      }
    }
  }
  private skimOn = false;
  private tryAt = 0;

  // ---------------------------------------------------------------- voices
  private learn(age: number): void {
    if (Math.abs(age - this.callsAge) < 0.02) return;
    this.callsAge = age;
    const fresh: CraneCall[] = [];
    for (let i = 0; i < 3; i++)
      this.shop.add(
        renderCrane(this.ctx, age, this.rng, (c) => {
          fresh.push(c);
          if (fresh.length === 1) this.calls = fresh;
        }),
        SOON,
      );
  }

  /** The player's own voice. */
  call(age: number): void {
    this.learn(age);
    const t = this.ctx.currentTime + 0.01;
    const c = this.calls.length ? this.calls[Math.floor(this.rng() * this.calls.length)] : null;
    if (!c) return;
    const g = lerp(0.38, 0.54, smooth(0, 0.9, age));
    const rate = this.keyed(c.f0, 0.6) * semis(spread(this.rng, 0.12));
    this.player.shot(c.buf, this.mix.voice, t, g, { rate, cut: lerp(4600, 5600, age) });
    this.player.shot(c.buf, this.mix.voiceSend, t + 0.02, g * 0.55, { rate, cut: 2800 });
    // a hillside answers, late and small
    this.player.shot(c.buf, this.mix.voiceSend, t + 0.62, g * 0.16, { rate, cut: 1700, pan: spread(this.rng, 0.6), light: true });
    // and then the air is kept a little clear, to listen in
    this.mix.lean(0.32, c.buf.duration + 2.2);
  }

  /** rate that brings a call partway (amt) onto the land's root or fifth */
  private keyed(f0: number, amt: number): number {
    const want = this.music.tune(f0);
    return Math.pow(want / f0, amt);
  }

  /** The flock, from wherever they have got to. */
  answer(nearness: number, pan: number, size: number): void {
    const n = clamp(nearness);
    const s = clamp(size);
    const { ctx, rng, player } = this;
    if (!this.flock.length) return;
    const t0 = ctx.currentTime + 0.02;
    // everything in this reply shares one distance
    const lp = stereo(ctx.createBiquadFilter());
    lp.type = 'lowpass';
    lp.Q.value = 0.3;
    lp.frequency.value = lerp(1350, 4200, Math.pow(n, 1.2));
    const dry = stereo(ctx.createGain());
    const wet = stereo(ctx.createGain());
    const voices = Math.round(2 + 18 * Math.pow(s, 1.15) * lerp(0.7, 1, n));
    const each = lerp(0.48, 0.95, Math.pow(n, 1.15)) * (0.75 + 0.45 * s) * Math.pow(2 / voices, 0.28);
    dry.gain.value = lerp(0.22, 0.8, Math.pow(n, 1.3));
    wet.gain.value = lerp(1.15, 0.7, n);
    lp.connect(dry);
    dry.connect(this.mix.voice);
    lp.connect(wet);
    wet.connect(this.mix.voiceSend);
    let left = 0;
    const done = (): void => {
      if (--left > 0) return;
      lp.disconnect();
      dry.disconnect();
      wet.disconnect();
    };
    const span = 0.35 + 3 * s;
    const width = lerp(0.1, 0.32, n) + 0.5 * s;
    for (let i = 0; i < voices; i++) {
      const c = this.flock[Math.floor(rng() * this.flock.length)];
      // a leader, then the rest, thickening then thinning
      const u = i === 0 ? 0 : 0.18 + 0.82 * ((i - 1 + rng()) / voices);
      const at = t0 + u * span;
      const rate = this.keyed(c.f0, 0.75) * semis(i === 0 ? 0 : spread(rng, 0.5) + (rng() < 0.24 ? -5 : 0));
      const g = each * (i === 0 ? 1.25 : 0.55 + 0.5 * rng()) * (1 - 0.35 * u);
      if (player.shot(c.buf, lp, at, g, { rate, pan: clamp(pan * (1 - 0.3 * s) + spread(rng, width), -0.95, 0.95), after: done })) left++;
    }
    if (left === 0) done();
    // the music makes room, and warms
    this.mix.lean(lerp(0.42, 0.28, n), span + 1.3);
    if (n * (0.3 + s) > 0.25) this.music.swell(1 + 2.5 * s);
  }

  companionCall(pan: number): void {
    if (!this.flock.length) return;
    const c = this.flock[Math.floor(this.rng() * this.flock.length)];
    const t = this.ctx.currentTime + 0.01;
    const rate = this.keyed(c.f0, 0.7) * semis(spread(this.rng, 0.3));
    const p = clamp(pan, -0.8, 0.8);
    this.player.shot(c.buf, this.mix.voice, t, 0.28, { rate, pan: p, cut: 3000, ease: 0.05 });
    this.player.shot(c.buf, this.mix.voiceSend, t, 0.16, { rate, pan: p, cut: 2200, light: true });
  }

  // --------------------------------------------------------------- moments
  bell(): void {
    this.growBell();
    const b = this.one('bell');
    if (!b) {
      // still being cast: ring a breath later
      if (!this.shop.idle) setTimeout(() => this.one('bell') && this.bell(), 900);
      return;
    }
    const rate = semis(((((this.music.root - this.bellPrime) % 12) + 18) % 12) - 6);
    const t = this.ctx.currentTime + 0.02;
    this.player.shot(b, this.mix.voice, t, 0.72, { rate, cut: 4200 });
    this.player.shot(b, this.mix.voiceSend, t, 0.5, { rate, cut: 2600 });
    this.mix.lean(0.25, 4);
  }

  whale(): void {
    this.grow('whale', 2, N.renderWhale);
    const b = this.one('whale');
    if (!b) return;
    const t = this.ctx.currentTime + 0.02;
    const rate = semis(spread(this.rng, 1.5));
    const pan = spread(this.rng, 0.4);
    this.player.shot(b, this.mix.voice, t, 0.34, { rate, pan, cut: 1500, ease: 0.4 });
    this.player.shot(b, this.mix.voiceSend, t + 0.05, 0.5, { rate, pan: -pan, cut: 1300, ease: 0.4 });
    this.mix.lean(0.2, 7);
  }

  thunder(nearness: number): void {
    this.grow('thunder', 2, N.renderThunder);
    const b = this.one('thunder');
    if (!b) return;
    const n = clamp(nearness);
    const t = this.ctx.currentTime + 0.02;
    this.thunderLast = t;
    const pan = spread(this.rng, 0.35);
    const rate = lerp(0.82, 1, n) * semis(spread(this.rng, 0.6));
    this.player.shot(b, this.mix.world, t, lerp(0.16, 0.42, n), { rate, pan, cut: lerp(260, 620, n), ease: 0.6 });
    this.player.shot(b, this.mix.worldSend, t, lerp(0.1, 0.16, n), { rate, pan, cut: 420, ease: 0.6 });
  }

  splash(strength: number): void {
    const s = clamp(strength);
    const t = this.ctx.currentTime + 0.005;
    this.player.shot(this.one('splash'), this.near.in, t, lerp(0.1, 0.42, s), { rate: lerp(1.25, 0.88, s) * semis(spread(this.rng, 0.7)), cut: lerp(1800, 3000, s) });
  }

  touchDown(water: boolean): void {
    const t = this.ctx.currentTime + 0.005;
    if (water) {
      this.player.shot(this.one('splash'), this.near.in, t, 0.2, { rate: 0.95, cut: 1900 });
      this.player.shot(this.one('lap'), this.near.in, t + 0.5, 0.18, { rate: 0.9 });
    } else this.player.shot(this.one('rustle'), this.near.in, t, 0.3, { rate: 0.92 * semis(spread(this.rng, 0.6)) });
    this.player.shot(this.one('whuff'), this.wings.in, t, 0.24, { rate: 0.78 });
  }

  leap(): void {
    const t = this.ctx.currentTime + 0.005;
    this.player.shot(this.one('rustle'), this.near.in, t, 0.2, { rate: 1.1 });
    this.player.shot(this.one('whuff'), this.wings.in, t + 0.12, 0.36, { rate: 0.84 });
  }

  // ---------------------------------------------------------------- update
  update(f: AudioFrame, now: number, dt: number): void {
    this.clock += dt;
    const e = this.e;
    const grounded = f.mode === 'ground' ? 1 : 0;
    e.speed = ease(e.speed, f.airspeed, 0.8, dt);
    e.agl = ease(e.agl, f.agl, 1.2, dt);
    e.dive = ease(e.dive, smooth(-3, -13, f.climb) * smooth(22, 42, f.airspeed), 1.2, dt);
    e.cloud = ease(e.cloud, clamp(f.inCloud), 1, dt);
    e.storm = ease(e.storm, clamp(f.storm), 3, dt);
    e.forest = ease(e.forest, clamp(f.forest), 2.5, dt);
    e.water = ease(e.water, f.overWater ? 1 : clamp(f.water), 2, dt);
    e.wind = ease(e.wind, Math.max(0, f.wind), 3, dt);
    e.air = ease(e.air, grounded, 1.5, dt);
    e.touch = ease(e.touch, f.mode === 'air' ? clamp(f.touch) : 0, f.touch > e.touch ? 0.12 : 0.5, dt);
    e.bank = ease(e.bank, Math.abs(f.bank), 0.8, dt);
    const S = SCENE_WORLD[this.scene];
    this.sc.bed = ease(this.sc.bed, S.bed, 2.5, dt);
    this.sc.wind = ease(this.sc.wind, S.wind, 2.5, dt);
    this.sc.life = ease(this.sc.life, S.life, 2.5, dt);

    if (now > this.tryAt) {
      this.tryAt = now + 0.3;
      this.tryLoops();
    }
    const land = this.land;
    if (!land) return;
    const W = WIND[land];
    const arrive = smooth(0, 5, now - this.landAt);

    // --- wind: pressure first, never hiss
    const T = this.clock;
    const gust = 0.5 + 0.28 * Math.sin(T * 0.43) * Math.sin(T * 0.171 + 2) + 0.22 * Math.sin(T * 0.83 + 1) * Math.sin(T * 0.097);
    const sp = clamp((e.speed - 7) / 46);
    const flying = 1 - e.air;
    const still = smooth(0, 9, e.wind);
    const rush = flying * (0.2 + 0.8 * Math.pow(sp, 1.15));
    const wa = this.sc.wind * W.amt * arrive;
    const low = wa * (0.14 * rush + 0.05 * still + 0.05 * flying * smooth(40, 500, e.agl)) * (0.75 + 0.5 * gust);
    this.windLow.gain.to(low * 0.46, dt, 0.7);
    this.windLow.cut.to(lerp(220, 430, sp) + 60 * gust, dt, 0.7);
    this.windOpen.gain.to(wa * flying * (0.014 * Math.pow(sp, 2) + 0.034 * e.dive + 0.004 * e.bank) * (0.8 + 0.4 * gust), dt, 0.8);
    this.windOpen.cut.to(lerp(480, 1050, clamp(sp * 0.7 + e.dive * 0.4)), dt, 0.8);

    // the wind's own notes
    const root = this.music.root;
    for (let i = 0; i < 3; i++) {
      const h = this.hums[i];
      let m = root + W.hum[i];
      while (m < 57) m += 12;
      const hz = mtof(m);
      if (h.hz !== hz) {
        h.hz = hz;
        h.f.frequency.setTargetAtTime(hz, now, 1.2);
      }
      const sway = 0.5 + 0.5 * Math.sin(T * (0.19 + 0.07 * i) + i * 2.1);
      h.g.gain.to(wa * W.humAmt * sway * (0.34 * rush + 0.22 * still + 0.16 * e.dive) * HUM_MIX[i] * (1 - 0.5 * e.cloud), dt, 1);
    }

    // --- beds
    const bed = this.sc.bed * arrive;
    const low0 = 1 - smooth(8, 130, e.agl);
    const close = 1 - smooth(4, 45, e.agl);
    this.hush.gain.to(bed * (W.hush * (0.018 + 0.02 * gust) + 0.03 * e.storm + 0.03 * e.cloud * flying), dt);
    this.hush.cut.to(lerp(1200, 700, e.cloud) + 200 * gust, dt);
    this.leaves.gain.to(bed * W.leaves * Math.max(e.forest, 0.15) * low0 * (0.25 + 0.75 * smooth(0.5, 7, e.wind)) * (0.014 + 0.06 * gust * gust), dt, 0.9);
    this.leaves.cut.to(1300 + 600 * gust, dt);
    // swell: a wave every ten seconds or so, never quite
    const sw = Math.pow(0.5 + 0.5 * Math.sin(T * 0.62 + 0.9 * Math.sin(T * 0.11)), 2.2);
    const sw2 = Math.pow(0.5 + 0.5 * Math.sin(T * 0.62 - 0.55 + 0.9 * Math.sin(T * 0.11)), 4);
    const sea = 1.25 * bed * W.waves * Math.max(e.water, 0.3) * (0.3 + 0.7 * (1 - smooth(15, 220, e.agl)));
    this.waves.gain.to(sea * (0.04 + 0.13 * sw), dt, 0.5);
    this.waves.cut.to(260 + 220 * sw, dt, 0.5);
    this.foam.gain.to(sea * close * 0.028 * sw2, dt, 0.5);
    this.insects.gain.to(land === 'rooms' ? bed * 0.075 * (0.35 + 0.65 * (1 - smooth(20, 260, e.agl))) * (1 - 0.85 * e.storm) * (0.8 + 0.2 * gust) : 0, dt);
    this.murmur.gain.to(land === 'wintering' ? bed * (0.05 + 0.11 * smooth(0.1, 1, f.progress)) * (0.55 + 0.45 * (1 - smooth(60, 400, e.agl))) : 0, dt, 3);
    this.murmur.cut.to(lerp(1000, 2300, smooth(0, 1, f.progress)), dt, 3);
    this.life.gain.to(this.sc.life * arrive * (1 - 0.6 * e.cloud), dt);

    // --- touching
    const onWater = f.overWater ? 1 : 0;
    this.skim.gain.to(e.touch * onWater * (0.12 + 0.16 * sp), dt, 0.14);
    this.skim.cut.to(1500 + 1400 * sp, dt, 0.3);
    this.brush.gain.to(e.touch * (onWater ? 0.05 : 0.11) * (0.4 + 0.6 * sp), dt, 0.14);
    if (e.touch > 0.35 && this.lastTouch <= 0.35 && now > this.lastSkim + 1.1) {
      this.lastSkim = now;
      if (onWater) this.splash(0.12 + 0.2 * sp);
    }
    this.lastTouch = e.touch;

    // --- wings: the push on the way down
    const s = Math.sin(f.beatPhase);
    if (f.beat > 0.12 && this.lastSin > 0 && s <= 0) {
      const b = this.one('whuff');
      const g = 0.1 + 0.24 * f.beat;
      this.player.shot(b, this.wings.in, now + 0.005, g * lerp(1, 0.8, this.rng()), { rate: lerp(0.94, 1.08, f.beat) * semis(spread(this.rng, 0.5)), pan: spread(this.rng, 0.08) });
    }
    this.lastSin = f.beat > 0.02 ? s : 0;

    // --- whoever is about
    const list = RESIDENTS[land];
    for (let i = 0; i < list.length; i++) {
      if (now < this.next[i]) continue;
      const r = list[i];
      const p = clamp(r.when(f)) * this.sc.life;
      this.next[i] = now + r.every * (0.45 + 1.1 * this.rng()) * lerp(2.2, 1, p);
      if (this.rng() > p * 1.15) continue;
      const far = this.rng();
      const buf = this.one(r.set);
      this.player.shot(buf, this.life.in, now + 0.01, r.gain * lerp(1, 0.4, far) * (0.4 + 0.6 * p), {
        rate: lerp(r.rate[0], r.rate[1], this.rng()),
        pan: spread(this.rng, 0.85),
        cut: lerp(r.cut, r.cut * 0.6, far),
        light: true,
      });
    }

    // --- a storm keeping its distance
    if (e.storm > 0.15 && now > this.thunderAt) {
      this.thunderAt = now + lerp(26, 13, e.storm) * (0.7 + 0.6 * this.rng());
      if (now - this.thunderLast > 11 && this.sc.bed > 0.3) this.thunder(0.15 + 0.35 * e.storm * this.rng());
    }

    this.mix.worldVeil.to(lerp(9000, 900, e.cloud), dt);
  }

  push(now: number): void {
    for (const b of this.buses) b.push(now);
  }
}

