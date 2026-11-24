/**
 * Aloft's ear. One object the game talks to; everything it plays is grown at
 * run time from sines, noise and patience.
 *
 * Calm is the specification: nothing arrives suddenly, nothing hisses, nothing
 * keeps time. Speed is heard as how close together the notes fall; rising air
 * is heard rising; company is heard as more voices in the same chord.
 */
import type { LandId } from '../world/lands';
import { NOW, Workshop, clamp, makeRng } from './dsp';
import { Mixer } from './mixer';
import { Music } from './music';
import * as N from './nature';
import { Player } from './player';
import { Bank } from './timbres';
import { World } from './world';
import type { LandMusic } from './theory';

export interface AudioFrame {
  airspeed: number; // m/s, ~0..55, cruise ≈ 20
  agl: number;
  alt: number; // metres above surface / sea
  lift: number;
  climb: number; // m/s
  beat: number;
  beatPhase: number; // wingbeat effort 0..1, phase rad
  touch: number; // skimming a surface 0..1
  overWater: boolean;
  mode: 'air' | 'ground' | 'leap';
  companions: number; // 0..8
  progress: number; // 0..1 of the day's journey
  night: number; // 0..1
  inCloud: number; // 0..1
  forest: number;
  water: number; // 0..1 ambience nearby
  wind: number; // m/s
  storm: number; // 0..1
  bank: number; // rad
}

export type Scene = 'title' | 'flight' | 'roost' | 'night' | 'finale' | 'silent';

export interface AudioOptions {
  /** render into this context instead of opening one (offline checks) */
  context?: BaseAudioContext;
  seed?: number;
}

/** how often the audio thread hears about eased controls (s) */
const PUSH = 0.05;

/** Browsers may refuse; that is their business and never ours to complain of. */
function hush(p: Promise<void> | undefined): void {
  if (p && typeof p.catch === 'function') p.catch(() => undefined);
}

type CtxCtor = new (o?: AudioContextOptions) => AudioContext;

export class AudioEngine {
  private ctx: BaseAudioContext | null = null;
  private live: AudioContext | null = null;
  private failed = false;
  private asleep = false;
  private shop!: Workshop;
  private mix!: Mixer;
  private bank!: Bank;
  private player!: Player;
  private music!: Music;
  private world!: World;
  private since = 0;

  // asked for before the first gesture
  private place: { id: LandId; music: LandMusic } | null = null;
  private scene: Scene = 'title';
  private vol = { master: 1, music: 1, world: 1 };
  private muted = false;

  constructor(private opts: AudioOptions = {}) {}

  get ready(): boolean {
    return this.ctx !== null;
  }

  start(): void {
    if (this.ctx) {
      // a context can be put to sleep behind our back (iOS, device changes)
      if (this.live && !this.asleep && this.live.state !== 'running') hush(this.live.resume());
      return;
    }
    if (this.failed) return;
    try {
      let ctx: BaseAudioContext;
      if (this.opts.context) ctx = this.opts.context;
      else {
        const w = window as unknown as { AudioContext?: CtxCtor; webkitAudioContext?: CtxCtor };
        const C = w.AudioContext ?? w.webkitAudioContext;
        if (!C) throw new Error('no audio');
        let live: AudioContext;
        try {
          live = new C({ latencyHint: 'balanced' });
        } catch {
          live = new C();
        }
        hush(live.resume());
        this.live = live;
        ctx = live;
      }
      this.build(ctx);
      this.ctx = ctx;
    } catch {
      this.failed = true;
      return;
    }
    if (this.place) this.applyLand();
    this.music.setScene(this.scene);
    this.world.setScene(this.scene);
    this.mix.setVolumes(this.vol.master, this.vol.music, this.vol.world);
    this.mix.setMuted(this.muted);
    this.mix.fadeIn(3);
  }

  private build(ctx: BaseAudioContext): void {
    const rng = makeRng(this.opts.seed ?? (Date.now() & 0x7fffffff));
    this.shop = new Workshop(!!this.opts.context);
    this.mix = new Mixer(ctx);
    this.player = new Player(ctx);
    this.bank = new Bank(ctx, this.shop, rng);
    this.shop.add(N.renderSpace(ctx, 4.6, rng, (b) => this.mix.setSpace(b)), NOW);
    this.music = new Music(ctx, this.mix, this.bank, this.player, rng);
    this.world = new World(ctx, this.mix, this.shop, this.player, this.music, rng);
  }

  /** Finish growing every instrument now. For offline rendering only. */
  settle(): void {
    if (this.ctx) this.shop.drain();
  }

  // ------------------------------------------------------------------ where
  setLand(id: LandId, music: LandMusic): void {
    this.place = { id, music };
    if (this.ctx) this.applyLand();
  }

  private applyLand(): void {
    if (!this.place) return;
    this.music.setLand(this.place.id, this.place.music);
    this.world.setLand(this.place.id);
  }

  setScene(s: Scene): void {
    this.scene = s;
    if (!this.ctx) return;
    this.music.setScene(s);
    this.world.setScene(s);
  }

  // ------------------------------------------------------------- each frame
  update(f: AudioFrame, dt: number): void {
    const ctx = this.ctx;
    if (!ctx || this.asleep) return;
    const d = clamp(dt, 0, 0.25);
    const now = ctx.currentTime;
    this.music.update(f, now, d);
    this.world.update(f, now, d);
    this.mix.update(now, d);
    this.since += d;
    if (this.since >= PUSH) {
      this.since = 0;
      this.music.push(now);
      this.world.push(now);
      this.mix.push(now);
    }
  }

  // ---------------------------------------------------------------- moments
  call(age: number): void {
    if (this.ctx) this.world.call(clamp(age));
  }
  answer(nearness: number, pan: number, size: number): void {
    if (this.ctx) this.world.answer(nearness, pan, size);
  }
  companionCall(pan: number): void {
    if (this.ctx) this.world.companionCall(pan);
  }
  feather(index: number): void {
    if (this.ctx) this.music.feather(Math.max(0, Math.floor(index)));
  }
  companionJoin(n: number): void {
    if (!this.ctx) return;
    this.music.welcome(n);
    this.world.companionCall(n % 2 ? 0.35 : -0.35);
  }
  discover(): void {
    if (this.ctx) this.music.discover();
  }
  bell(): void {
    if (this.ctx) this.world.bell();
  }
  whale(): void {
    if (this.ctx) this.world.whale();
  }
  thunder(nearness: number): void {
    if (this.ctx) this.world.thunder(nearness);
  }
  splash(strength: number): void {
    if (this.ctx) this.world.splash(strength);
  }
  land(water: boolean): void {
    if (this.ctx) this.world.touchDown(water);
  }
  leap(): void {
    if (this.ctx) this.world.leap();
  }
  ui(kind: 'move' | 'select' | 'back'): void {
    if (this.ctx) this.music.ui(kind);
  }

  // ------------------------------------------------------------------ levels
  setVolumes(v: { master: number; music: number; world: number }): void {
    this.vol = { master: v.master, music: v.music, world: v.world };
    if (this.ctx) this.mix.setVolumes(v.master, v.music, v.world);
  }
  setMuted(m: boolean): void {
    this.muted = m;
    if (this.ctx) this.mix.setMuted(m);
  }

  suspend(): void {
    if (!this.ctx || this.asleep) return;
    this.asleep = true;
    this.mix.fadeOut(0.5);
    const live = this.live;
    if (live)
      setTimeout(() => {
        if (this.asleep) hush(live.suspend());
      }, 420);
  }

  resume(): void {
    if (!this.ctx || !this.asleep) return;
    this.asleep = false;
    if (this.live) hush(this.live.resume());
    this.mix.fadeIn(2.4);
  }
}
