import * as THREE from 'three';
import { Engine, QUALITY, Quality } from '../render/engine';
import { G } from '../render/globals';
import { CameraRig } from '../render/cameraRig';
import { Crane, glidePose, Pose } from '../render/crane';
import { World, MAX_COMPANIONS } from './world';
import { Input } from '../input/input';
import { Ui, MenuItem } from '../ui/ui';
import { config } from '../sim/config';
import { BirdState, createState, forwardOf } from '../sim/state';
import { FlightInput, step } from '../sim/flightModel';
import { Flock, Companion } from '../sim/flock';
import { Autopilot } from '../sim/autopilot';
import { bakeAsync } from '../world/baker';
import type { BakedLand } from '../world/generate';
import { LAND_ORDER, LandId } from '../world/lands';
import { Feather, layFeathers } from './trails';
import { MOVEMENTS } from './days';
import { SaveData, load, save, landAt, DayRecord } from './save';
import { AudioEngine, AudioFrame } from './audioStub';

type Phase = 'boot' | 'title' | 'wake' | 'fly' | 'arrive' | 'roost' | 'night' | 'finale' | 'photo';

const SIM_DT = 1 / 60;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const sm = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const ease = (from: number, to: number, rate: number, dt: number) => from + (to - from) * (1 - Math.exp(-rate * dt));
const wrapA = (a: number) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

/** Companions gathered in each land (two a day, then one, then one). */
const WAITING: Record<LandId, number> = { stillmere: 2, copper: 2, stair: 2, rooms: 1, darkwater: 1, wintering: 0 };
/** How far ahead the flock keeps, and how many you can see of it. */
const LEAD: Record<LandId, number> = { stillmere: 2500, copper: 2100, stair: 1800, rooms: 1500, darkwater: 1150, wintering: 0 };

export class Game {
  readonly engine: Engine;
  readonly world: World;
  readonly rig = new CameraRig();
  readonly input: Input;
  readonly ui: Ui;
  readonly audio = new AudioEngine();
  readonly data: SaveData = load();
  readonly flock = new Flock();
  readonly pilot = new Autopilot();

  phase: Phase = 'boot';
  private prevPhase: Phase = 'fly';
  bird: BirdState = createState(config, 0, 10, 0, 0);
  private prev: BirdState = this.bird;
  private acc = 0;
  private readonly drawn = new THREE.Vector3();
  private readonly focus = new THREE.Vector3();
  private pose: Pose = glidePose();
  private cposes: Pose[] = [];
  /** the phase clock */
  private t = 0;
  private time = 0;
  private slow = 1;
  paused = false;
  drift = false;
  private free = false;
  private landIdx = 0;

  /** how far along the road, 0..1, and the eased value the light follows */
  progress = 0;
  lightP = 0;
  private night = 0;
  private fadeTarget = 1;
  private fadeRate = 0.5;

  private feathers: Feather[] = [];
  private readonly fdata = new Float32Array(160 * 4);
  private featherCount = 0;
  private motif = 0;
  private rec: DayRecord = this.freshRec();
  private glideDist = 0;
  private lastPos = new THREE.Vector3();
  private discovered = new Set<string>();

  private callAt = -99;
  private answerDue = -1;
  private answerPos = new THREE.Vector3();
  private leadT = 0;
  private hints = new Set<string>();
  private hintQueue: Array<[string, number]> = [];
  private hintUntil = 0;
  private offRoad = 0;
  private liftTime = 0;
  private ringT = 0;
  private timeline: Array<{ at: number; fn: () => void }> = [];
  private land0 = { p: new THREE.Vector3(), v: new THREE.Vector3(), q: new THREE.Vector3(), w: new THREE.Vector3(), T: 8, t: 0 };
  private nextBake: Promise<BakedLand> | null = null;
  private baking = '';
  private rise = 0;
  private riseTarget = 0;
  private photoP = 0;
  private storm = 0;
  private thunderT = 12;
  private wakeSleep = 0;
  private flyover = -1;
  private readyToLeave = false;
  private breathLow = false;

  constructor(canvas: HTMLCanvasElement, uiRoot: HTMLElement) {
    this.engine = new Engine(canvas, this.pickQuality());
    this.world = new World(this.engine);
    this.ui = new Ui(uiRoot);
    this.input = new Input(canvas);
    for (let i = 0; i < MAX_COMPANIONS; i++) this.cposes.push(glidePose());
    this.input.onAction((a) => {
      this.audio.start();
      if (a === 'pause') this.onPause();
      else if (a === 'back') this.onBack();
      else if (a === 'up' || a === 'down') {
        if (this.ui.panelOpen || this.phase === 'title') this.ui.nav(a);
      } else if (a === 'confirm') {
        if (this.ui.panelOpen || this.phase === 'title') this.ui.nav('confirm');
      } else if (a === 'mute') {
        this.muted = !this.muted;
        this.audio.setMuted(this.muted);
        this.ui.toast(this.muted ? 'Silent' : 'Sound');
      } else if (a === 'hud') {
        this.data.settings.hud = !this.data.settings.hud;
        save(this.data);
      } else if (!this.paused) {
        if (a === 'call') this.call();
        else if (a === 'photo') this.togglePhoto();
        else if (a === 'drift') this.toggleDrift();
      }
    });
    this.ui.onWing = (d) => {
      this.audio.start();
      this.input.pointer.beating = d;
    };
    this.ui.onCall = () => {
      this.audio.start();
      this.call();
    };
    this.ui.onPause = () => this.onPause();
    this.ui.onUi = (k) => this.audio.ui(k);
    const wake = () => this.audio.start();
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    window.addEventListener('resize', () => this.engine.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.engine.resize(), 250));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.audio.suspend();
        if (this.phase === 'fly' && !this.paused) this.onPause();
      } else this.audio.resume();
    });
    this.applySettings();
    this.engine.resize(true);
  }

  private muted = false;

  private freshRec(): DayRecord {
    return { distance: 0, highest: 0, longestGlide: 0, feathers: 0, feathersTotal: 0, seconds: 0 };
  }

  private pickQuality(): Quality {
    const q = this.data.settings.quality;
    if (q !== 'auto') return QUALITY[q];
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    const cores = navigator.hardwareConcurrency || 4;
    if (coarse) return cores >= 6 ? QUALITY.medium : QUALITY.low;
    return cores >= 8 ? QUALITY.high : QUALITY.medium;
  }

  applySettings(): void {
    const s = this.data.settings;
    this.audio.setVolumes({ master: s.master, music: s.music, world: s.world });
    this.input.invertPitch = s.invert;
    this.engine.painterly = s.painterly;
    this.rig.sway = s.motion;
    const q = this.pickQuality();
    if (q.name !== this.engine.quality.name) {
      this.engine.setQuality(q);
      this.world.applyQuality(q);
    }
    save(this.data);
  }

  // ---------------------------------------------------------------- loading
  async boot(): Promise<void> {
    this.ui.loading(0.02, '');
    this.engine.clouds.buildVolume(this.engine.quality.name === 'low' ? 48 : 96);
    const id = landAt(this.data.day);
    await this.enter(id, undefined, true);
    this.toTitle(true);
    this.ui.loaded();
  }

  private bake(id: LandId, seed?: number, onP?: (p: number) => void): Promise<BakedLand> {
    const key = `${id}:${seed ?? 'home'}`;
    if (this.baking === key && this.nextBake) return this.nextBake;
    this.baking = key;
    this.nextBake = bakeAsync({ id, seed, n: this.engine.quality.heightN }, onP);
    return this.nextBake;
  }

  private async enter(id: LandId, seed: number | undefined, first = false): Promise<void> {
    const lines = ['Raising the hills', 'Letting the rain find its way', 'Filling the low places', 'Planting what will grow'];
    const b = await this.bake(id, seed, (p) => {
      if (first) this.ui.loading(0.05 + p * 0.9, lines[Math.min(3, Math.floor(p * 4))]);
    });
    this.nextBake = null;
    this.baking = '';
    this.world.load(b, seed);
    this.landIdx = LAND_ORDER.indexOf(id);
    const mv = this.world.mv;
    this.audio.setLand(id, mv.music);
    this.feathers = layFeathers(this.world);
    this.featherCount = 0;
    this.motif = 0;
    this.rec = this.freshRec();
    this.rec.feathersTotal = this.feathers.length;
    this.discovered.clear();
    this.progress = 0;
    this.lightP = 0;
    this.night = 0;
    this.rise = this.riseTarget = 0;
    this.storm = 0;
    this.drift = false;
    this.pilot.reset();
    const [x, z] = this.world.land.route.at(0);
    const [dx, dz] = this.world.land.route.dir(0.01);
    const y = Math.max(this.world.terrain.heightAt(x, z), -0.4);
    this.bird = createState(config, x, y, z, Math.atan2(-dx, -dz));
    this.bird.mode = 'ground';
    this.bird.airspeed = 0;
    this.bird.modeTime = 5;
    this.prev = this.bird;
    this.lastPos.set(x, y, z);
    this.leadT = 0;
    this.placeCompanions();
    if (id === 'wintering') {
      const [ex, ez] = this.world.land.route.at(1);
      this.world.multitude.mesh.visible = true;
      this.world.multitude.u.uCenter.value.set(ex, 0, ez - 20);
      this.world.multitude.u.uSpread.value = 430;
      this.rise = this.riseTarget = 0.14;
    }
    this.world.light(0);
    this.world.fx.resetTrail(new THREE.Vector3(x, y, z));
  }

  private placeCompanions(): void {
    this.flock.clear();
    const w = this.world;
    const id = w.land.id;
    // those already with you slept beside you
    const have = Math.min(MAX_COMPANIONS, this.free ? Math.max(this.data.companions, 4) : this.data.companions);
    const b = this.bird;
    for (let i = 0; i < have; i++) {
      const a = b.yaw + Math.PI * (0.35 + (i / Math.max(1, have)) * 1.3) + Math.sin(i * 7) * 0.2;
      const r = 5 + ((i * 2.3) % 6);
      const x = b.position.x + Math.sin(a) * r;
      const z = b.position.z + Math.cos(a) * r;
      const y = Math.max(w.terrain.heightAt(x, z), -0.5);
      this.flock.add({ x, y, z, state: 'waiting', yaw: b.yaw + Math.sin(i * 3.7) * 0.9, hr: 1 });
    }
    // and those still waiting to be found
    const n = this.free ? 0 : Math.min(WAITING[id], MAX_COMPANIONS - have);
    for (let i = 0; i < n; i++) {
      if (i % 2 === 0) {
        const t = w.thermals.thermals[Math.min(w.thermals.thermals.length - 1, 1 + i)];
        const y = t.ground + Math.min(150, (t.top - t.ground) * 0.42);
        this.flock.add({ x: t.x, y, z: t.z, state: 'circling', hx: t.x, hy: y, hz: t.z, hr: t.radius * 0.45 });
      } else {
        const l = w.baked.landmarks[Math.min(w.baked.landmarks.length - 1, 1)];
        const x = l.x + 16;
        const z = l.z + 12;
        const g = w.terrain.heightAt(x, z);
        if (g < -0.6) {
          // nowhere to stand: wheel above the place instead
          this.flock.add({ x, y: 46, z, state: 'circling', hx: l.x, hy: 46, hz: l.z, hr: 40 });
        } else this.flock.add({ x, y: g, z, state: 'waiting', hr: 2 });
      }
    }
  }

  // ------------------------------------------------------------------ phases
  private go(p: Phase): void {
    this.phase = p;
    this.t = 0;
    this.timeline = [];
  }

  private at(sec: number, fn: () => void): void {
    this.timeline.push({ at: sec, fn });
  }

  private toTitle(first = false): void {
    this.go('title');
    this.free = false;
    this.paused = false;
    this.ui.closePanel();
    this.ui.hideCredit();
    this.ui.hideLog();
    this.ui.hideVerse();
    this.ui.hideChapter();
    this.ui.hush();
    this.ui.hud(false);
    this.ui.touch(false);
    this.rig.mode = 'orbit';
    const o = this.rig.orbit;
    o.radius = 9.5;
    o.height = 0.95;
    o.lookUp = 2.2;
    o.fov = 40;
    o.speed = 0.012;
    o.shift = window.innerWidth > window.innerHeight ? -3.1 : 0;
    o.angle = this.bird.yaw + Math.PI * 0.14;
    if (!first) this.rig.ease(this.engine.camera, 4);
    this.wakeSleep = 1;
    this.lightP = 0.03;
    this.fadeTarget = 0;
    this.fadeRate = first ? 0.35 : 0.6;
    this.audio.setScene('title');
    const d = this.data;
    const items: MenuItem[] = [];
    if (d.day === 0 && !Object.keys(d.days).length) items.push({ label: 'Begin', run: () => this.startDay(0) });
    else if (d.day <= 5) {
      const mv = MOVEMENTS[landAt(d.day)];
      items.push({ label: 'Go on', note: `${mv.numeral}. ${mv.title}`, run: () => this.startDay(d.day) });
    } else items.push({ label: 'Fly again', note: 'from the beginning', run: () => this.restart() });
    items.push({ label: 'The road', run: () => this.openRoad() });
    items.push({ label: 'How to fly', run: () => this.openHow(() => this.ui.closePanel()) });
    items.push({ label: 'Settings', run: () => this.openSettings(() => this.ui.closePanel()) });
    this.ui.showTitle(d.arrived ? 'The water is full tonight.' : 'A long way south, one day behind.', items);
  }

  private restart(): void {
    this.data.day = 0;
    this.data.companions = 0;
    save(this.data);
    this.startDay(0);
  }

  private openRoad(): void {
    this.ui.road(this.data, (id, seed) => void this.freeFlight(id, seed), () => {
      this.ui.closePanel();
      if (this.phase === 'title') this.toTitle();
    });
  }
  private openHow(back: () => void): void {
    this.ui.howto(this.input.device === 'touch', () => {
      back();
      if (this.phase === 'title') this.toTitle();
    });
  }
  private openSettings(back: () => void): void {
    this.ui.settings(this.data.settings, () => this.applySettings(), () => {
      back();
      if (this.phase === 'title') this.toTitle();
    });
  }

  private async freeFlight(id: LandId, seed?: number): Promise<void> {
    this.ui.closePanel();
    this.ui.hideTitle();
    this.fadeTarget = 1;
    this.fadeRate = 1.2;
    await this.wait(1.1);
    this.free = true;
    this.ui.loading(0.02, '');
    await this.enter(id, seed, true);
    this.ui.loaded();
    this.beginWake();
  }

  private startDay(i: number): void {
    this.ui.hideTitle();
    this.ui.closePanel();
    const id = landAt(i);
    if (this.world.land.id === id && !this.free) {
      this.beginWake();
      return;
    }
    void (async () => {
      this.fadeTarget = 1;
      this.fadeRate = 1.2;
      await this.wait(1.1);
      this.free = false;
      this.ui.loading(0.02, '');
      await this.enter(id, undefined, true);
      this.ui.loaded();
      this.beginWake();
    })();
  }

  private wait(s: number): Promise<void> {
    return new Promise((r) => setTimeout(r, s * 1000));
  }

  /** Morning: you wake where you slept. */
  private beginWake(): void {
    const mv = this.world.mv;
    const first = this.world.land.id === 'stillmere' && !this.free;
    this.go('wake');
    this.fadeTarget = 0;
    this.fadeRate = 0.4;
    this.audio.setScene('flight');
    this.rig.mode = 'orbit';
    const o = this.rig.orbit;
    o.shift = 0;
    o.radius = 7.4;
    o.height = 1.5;
    o.lookUp = 1.35;
    o.fov = 44;
    o.speed = 0.055;
    o.angle = this.bird.yaw + Math.PI * 0.62;
    this.rig.ease(this.engine.camera, 3.5);
    this.readyToLeave = false;
    this.lightP = Math.max(this.lightP, 0);
    const kbd = this.input.device !== 'touch';
    const K = (k: string) => `<kbd>${k}</kbd>`;
    if (first) {
      this.wakeSleep = 1;
      this.flyover = -1;
      this.at(1.2, () => {
        this.flyover = 0;
        this.audio.answer(0.42, -0.2, 0.35);
      });
      this.at(4.6, () => this.audio.answer(0.34, 0.15, 0.4));
      this.at(6.4, () => this.ui.verse(mv.opening, 5200));
      this.at(8.2, () => this.audio.answer(0.16, 0.3, 0.3));
      this.at(9.4, () => (this.wakeSleep = 0.999));
      this.at(13.2, () => {
        this.readyToLeave = true;
        this.ui.whisper(kbd ? `${K('E')} to call after them` : 'Tap call, after them', 0);
        this.ui.touch(this.input.device === 'touch');
      });
      this.at(30, () => {
        if (this.phase === 'wake' && this.callAt < 0) this.ui.whisper(kbd ? `${K('Space')} to rise` : 'Hold wings to rise', 0);
      });
    } else {
      this.wakeSleep = 1;
      this.at(1.0, () => (this.wakeSleep = 0.999));
      this.at(1.4, () => this.ui.chapter(mv.numeral, mv.title, 4600));
      this.at(5.4, () => this.ui.verse(mv.opening, 4600));
      this.at(this.free ? 2.6 : 8.6, () => {
        this.readyToLeave = true;
        this.ui.whisper(kbd ? `${K('Space')} to rise` : 'Hold wings to rise', 0);
        this.ui.touch(this.input.device === 'touch');
      });
      this.at(3.0, () => this.audio.companionCall(0.2));
    }
  }

  private beginFly(): void {
    this.go('fly');
    this.ui.hush();
    this.ui.hideVerse();
    this.ui.hideChapter();
    this.rig.ease(this.engine.camera, 3.2);
    this.rig.snap(this.bird);
    this.rig.ease(this.engine.camera, 3.2);
    this.rig.mode = 'chase';
    this.ui.touch(this.input.device === 'touch');
    this.audio.setScene('flight');
    this.glideDist = 0;
    if (this.world.land.id === 'stillmere' && !this.free) this.at(5.5, () => this.ui.chapter(this.world.mv.numeral, this.world.mv.title, 4600));
    // the others rise after you, one by one
    let i = 0;
    for (const c of this.flock.birds) {
      if (c.state === 'waiting' && Math.hypot(c.x - this.bird.position.x, c.z - this.bird.position.z) < 40) {
        const k = c;
        this.at(1.2 + i * 0.7, () => this.flock.join(k));
        i++;
      }
    }
  }

  // ------------------------------------------------------------------- verbs
  private leadPos(out: THREE.Vector3): THREE.Vector3 {
    const r = this.world.land.route;
    const t = Math.min(1, this.leadT + LEAD[this.world.land.id] / r.total);
    const [x, z] = r.at(t);
    const y = this.world.surfaceY(x, z);
    const h = this.world.land.id === 'stair' ? Math.max(y + 190, 900) : y + 170 - 120 * sm(0.94, 1, t);
    return out.set(x, h, z);
  }

  call(): void {
    if (this.phase === 'title' || this.phase === 'boot' || this.phase === 'night' || this.phase === 'photo') return;
    if (this.time - this.callAt < 2.2) return;
    this.callAt = this.time;
    const p = this.bird.position;
    this.audio.call(this.world.mv.age);
    this.world.fx.sendCall(p.x, p.y + 0.4, p.z);
    this.answerDue = this.time + 1.5 + Math.random() * 0.7;
    for (const c of this.flock.birds) {
      if ((c.state === 'with' || c.state === 'joining') && Math.random() < 0.5) {
        const pan = Math.sin(c.seed) * 0.5;
        setTimeout(() => this.audio.companionCall(pan), 500 + Math.random() * 900);
      }
    }
    // a called bird comes
    for (const c of this.flock.birds) {
      if ((c.state === 'waiting' || c.state === 'circling') && this.phase === 'fly' && Math.hypot(c.x - p.x, c.z - p.z) < 130) this.welcome(c);
    }
    if (this.phase === 'wake' && this.world.land.id === 'stillmere' && this.readyToLeave) {
      const kbd = this.input.device !== 'touch';
      this.ui.hush();
      this.at(this.t + 4.2, () => this.ui.whisper(kbd ? '<kbd>Space</kbd> to rise' : 'Hold wings to rise', 0));
    }
    if (this.phase === 'finale') this.finaleCall();
  }

  private answer(): void {
    const lead = this.leadPos(this.answerPos);
    const p = this.bird.position;
    const cam = this.engine.camera;
    const id = this.world.land.id;
    const d = Math.hypot(lead.x - p.x, lead.z - p.z);
    const dir = new THREE.Vector3().subVectors(lead, cam.position);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const pan = dir.clone().normalize().dot(right);
    const size = 0.25 + this.landIdx * 0.13;
    this.audio.answer(clamp01(1 - d / 3200) * 0.7 + this.landIdx * 0.05, pan * 0.85, Math.min(1, size));
    // where on screen, or which edge
    const v = lead.clone();
    if (id !== 'wintering') v.y = Math.max(v.y, p.y - 200);
    v.project(cam);
    let sx = (v.x * 0.5 + 0.5) * window.innerWidth;
    let sy = (-v.y * 0.5 + 0.5) * window.innerHeight;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(cam.quaternion);
    if (dir.dot(fwd) < 0 || v.x < -0.94 || v.x > 0.94 || Math.abs(v.y) > 0.94) {
      sx = pan > 0 ? window.innerWidth - 54 : 54;
      sy = window.innerHeight * 0.42;
    }
    this.ui.answer(sx, sy);
  }

  private welcome(c: Companion): void {
    this.flock.join(c);
    const n = this.flock.with;
    this.audio.companionCall(Math.sin(c.seed) * 0.4);
    this.audio.companionJoin(n);
    if (!this.free) {
      this.data.companions = Math.min(MAX_COMPANIONS, Math.max(this.data.companions, n));
      save(this.data);
    }
    this.ui.whisper(n === 1 ? 'Someone else was late, too.' : n === 2 ? 'Now there are three of you.' : n >= 7 ? 'The sky is getting crowded.' : 'Another falls in beside you.', 5200);
    for (let i = 0; i < 14; i++) this.world.fx.spark(c.x, c.y + 0.5, c.z, (Math.random() - 0.5) * 3, Math.random() * 2, (Math.random() - 0.5) * 3, 2);
  }

  private toggleDrift(): void {
    if (this.phase !== 'fly') return;
    this.drift = !this.drift;
    this.pilot.reset();
    this.ui.whisper(this.drift ? 'Drifting. Lean to take back the air.' : 'The air is yours.', 3600);
  }

  // ------------------------------------------------------------------- menus
  private onPause(): void {
    if (this.phase === 'photo') {
      this.togglePhoto();
      return;
    }
    if (this.paused) {
      this.resume();
      return;
    }
    if (this.phase === 'title') {
      if (this.ui.panelOpen) {
        this.ui.closePanel();
        this.toTitle();
      }
      return;
    }
    if (this.phase !== 'fly' && this.phase !== 'wake' && this.phase !== 'roost' && this.phase !== 'finale' && this.phase !== 'arrive') return;
    this.paused = true;
    this.input.pointer.release();
    this.pauseMenu();
  }

  private pauseMenu(): void {
    const items: MenuItem[] = [
      { label: 'Go on', run: () => this.resume() },
      { label: this.drift ? 'Take back the air' : 'Drift', note: this.drift ? '' : 'let the bird fly itself', disabled: this.phase !== 'fly', run: () => { this.resume(); this.toggleDrift(); } },
      { label: 'Postcard', disabled: this.phase !== 'fly' && this.phase !== 'roost', run: () => { this.resume(); this.togglePhoto(); } },
      { label: 'The road', run: () => this.ui.road(this.data, (id, seed) => { this.paused = false; void this.freeFlight(id, seed); }, () => this.pauseMenu()) },
      { label: 'How to fly', run: () => this.ui.howto(this.input.device === 'touch', () => this.pauseMenu()) },
      { label: 'Settings', run: () => this.ui.settings(this.data.settings, () => this.applySettings(), () => this.pauseMenu()) },
      { label: 'Leave the sky', note: 'the day will keep', run: () => void this.leave() },
    ];
    this.ui.pause('Resting', items);
  }

  private resume(): void {
    this.paused = false;
    this.ui.closePanel();
    this.audio.ui('back');
  }

  private onBack(): void {
    if (this.ui.panelOpen && this.phase === 'title') {
      this.ui.closePanel();
      this.toTitle();
    } else if (this.paused) this.resume();
  }

  private async leave(): Promise<void> {
    this.paused = false;
    this.ui.closePanel();
    this.fadeTarget = 1;
    this.fadeRate = 1;
    this.ui.hud(false);
    this.ui.hush();
    await this.wait(1.4);
    this.free = false;
    await this.enter(landAt(this.data.day), undefined, false);
    this.toTitle();
  }

  private togglePhoto(): void {
    if (this.phase === 'photo') {
      this.ui.hidePhoto();
      this.phase = this.prevPhase;
      this.rig.mode = this.prevPhase === 'roost' || this.prevPhase === 'wake' ? 'orbit' : 'chase';
      this.rig.ease(this.engine.camera, 1.6);
      this.ui.touch(this.input.device === 'touch' && this.phase === 'fly');
      return;
    }
    if (this.phase !== 'fly' && this.phase !== 'roost' && this.phase !== 'wake') return;
    this.prevPhase = this.phase;
    this.phase = 'photo';
    this.photoP = this.lightP;
    this.ui.hud(false);
    this.ui.hush();
    this.ui.touch(false);
    const cam = this.engine.camera;
    const f = this.rig.free;
    const d = new THREE.Vector3().subVectors(cam.position, this.drawn);
    f.dist = Math.max(4, d.length());
    f.yaw = Math.atan2(d.x, d.z);
    f.pitch = Math.asin(Math.max(-0.9, Math.min(0.9, d.y / d.length())));
    f.fov = cam.fov;
    f.up = 0;
    this.rig.mode = 'fixed';
    this.rig.ease(cam, 0.8);
    this.ui.photo({
      time: this.lightP,
      fov: cam.fov,
      onTime: (v) => {
        this.photoP = v;
        this.engine.invalidateShadows();
      },
      onFov: (v) => (f.fov = v),
      shoot: () => this.shoot(),
      close: () => this.togglePhoto(),
    });
  }

  private shoot(): void {
    this.world.draw(0, this.focus, 20);
    const src = this.engine.gl.domElement;
    const c = document.createElement('canvas');
    const W = src.width;
    const H = src.height;
    const m = Math.round(Math.min(W, H) * 0.045);
    const foot = Math.round(m * 2.1);
    c.width = W + m * 2;
    c.height = H + m + foot;
    const x = c.getContext('2d')!;
    x.fillStyle = '#f6f0e4';
    x.fillRect(0, 0, c.width, c.height);
    x.drawImage(src, m, m);
    x.fillStyle = '#3a342c';
    x.font = `${Math.round(foot * 0.34)}px Forum, serif`;
    x.textBaseline = 'middle';
    x.fillText(this.world.mv.title, m, H + m + foot * 0.5);
    x.textAlign = 'right';
    x.font = `italic ${Math.round(foot * 0.26)}px Spectral, serif`;
    x.fillStyle = '#7a7062';
    x.fillText(`Aloft · ${this.world.mv.numeral}`, W + m, H + m + foot * 0.5);
    this.audio.ui('select');
    this.ui.postcard(c.toDataURL('image/jpeg', 0.93), `aloft-${this.world.land.id}.jpg`);
  }

  // ---------------------------------------------------------------- the frame
  frame(dt: number): void {
    dt = Math.min(dt, 0.1);
    this.time += this.paused ? 0 : dt;
    if (this.phase === 'boot' || !this.world.loaded) return;
    const inp = this.input.read();
    const look = this.input.look();
    if (!this.paused) {
      this.t += dt;
      for (let i = this.timeline.length - 1; i >= 0; i--) {
        if (this.timeline[i].at <= this.t) {
          const e = this.timeline[i];
          this.timeline.splice(i, 1);
          e.fn();
        }
      }
      G.uTime.value += this.phase === 'photo' ? 0 : dt;
      this.advance(dt, inp);
    }
    this.present(dt, look, inp);
  }

  private advance(dt: number, inp: FlightInput): void {
    const ph = this.phase;
    if (ph === 'photo') return;
    const w = this.world;
    const active = ph === 'fly' || ((ph === 'wake' || ph === 'title') && false);

    // the sim always runs at 60 Hz
    if (ph === 'arrive') this.stepArrive(dt);
    else {
      let use: FlightInput = { pitch: 0, roll: 0, beat: false };
      if (active) {
        use = inp;
        if (this.drift) {
          if (Math.abs(inp.pitch) + Math.abs(inp.roll) > 0.3 || inp.beat) {
            this.drift = false;
            this.ui.whisper('The air is yours.', 2600);
          } else use = this.bird.mode === 'ground' ? { pitch: 0, roll: 0, beat: this.bird.modeTime > 4 } : this.pilot.fly(this.bird, w.terrain, w.thermals, w.land.route, dt);
        }
      } else if (ph === 'wake' && this.readyToLeave) use = { pitch: 0, roll: 0, beat: inp.beat };
      this.acc += dt * this.slow;
      let n = 0;
      while (this.acc >= SIM_DT && n++ < 8) {
        this.prev = this.bird;
        const draft = Math.min(config.draftMax, this.flock.with * config.draftPerBird);
        this.bird = step(this.bird, use, SIM_DT, config, { terrain: w.terrain, lift: w.lift, wind: w.wind, draft });
        this.acc -= SIM_DT;
      }
      if (ph === 'wake') {
        this.bird.breath = 1;
        if (this.bird.mode === 'leap') this.beginFly();
      }
    }
    this.flock.step(this.bird, dt, w.terrain);
    if (ph === 'fly') this.flyLogic(dt, inp);
    if (ph === 'roost' || ph === 'finale') {
      this.bird.breath = 1;
      if (ph === 'roost' && this.readyToLeave && inp.beat) this.beginNight();
    }
    if (this.answerDue > 0 && this.time > this.answerDue) {
      this.answerDue = -1;
      if (ph !== 'finale') this.answer();
    }
    if (this.wakeSleep > 0 && this.wakeSleep < 1) this.wakeSleep = Math.max(0, this.wakeSleep - dt / 3.2);
    if (this.flyover >= 0) this.flyover += dt;
    this.rise = ease(this.rise, this.riseTarget, 0.16, dt);
    w.multitude.u.uRise.value = this.rise;
  }

  private flyLogic(dt: number, inp: FlightInput): void {
    const b = this.bird;
    const p = b.position;
    const w = this.world;
    const r = w.land.route;

    // how far along the road
    const off = r.dist(p.x, p.z);
    const t = r.qt;
    if (t > this.progress && t - this.progress < 0.3) this.progress = t;
    this.leadT = ease(this.leadT, this.progress, 0.35, dt);
    this.lightP = ease(this.lightP, Math.max(this.progress, 0.02), 0.12, dt);

    // the log
    const d = Math.hypot(p.x - this.lastPos.x, p.z - this.lastPos.z);
    if (b.mode === 'air' && d < 20) {
      this.rec.distance += d;
      if (inp.beat || b.touch > 0.5) {
        this.glideDist = 0;
      } else {
        this.glideDist += d;
        this.rec.longestGlide = Math.max(this.rec.longestGlide, this.glideDist);
      }
    }
    this.rec.highest = Math.max(this.rec.highest, p.y);
    this.rec.seconds += dt;
    this.lastPos.set(p.x, p.y, p.z);

    // the edge of the known world is only a wind that turns you round
    const lim = 7300;
    const e = Math.max(Math.abs(p.x), Math.abs(p.z));
    if (e > lim) {
      const want = Math.atan2(p.x, p.z);
      b.yaw += wrapA(want - b.yaw) * Math.min(1, dt * 0.5 * sm(lim, lim + 500, e));
      this.hint('edge', 'The wind turns you back toward the road.');
    }

    this.pickFeathers(dt);
    this.meet();
    this.discover();
    this.surfaceFx(dt);
    this.guide(dt, inp, off);

    // home
    const [ex, ez] = r.at(1);
    const dh = Math.hypot(ex - p.x, ez - p.z);
    if (b.mode === 'air' && dh < 300 && b.agl < 190 && (this.progress > 0.9 || this.free)) this.beginArrive();
    else if (b.mode === 'air' && dh < 900 && this.progress > 0.9) this.hint('home', w.land.id === 'wintering' ? 'There they are.' : 'There is water ahead for the night.');
    if (b.mode === 'ground' && dh < 120) this.beginRoost();

    // weather
    if (w.land.id === 'rooms') {
      this.storm = sm(0.34, 0.5, this.progress) * (1 - sm(0.7, 0.86, this.progress));
      this.thunderT -= dt;
      if (this.thunderT < 0 && this.storm > 0.25) {
        this.thunderT = 9 + Math.random() * 14;
        this.flashT = 0.5;
        setTimeout(() => this.audio.thunder(0.35), 2600);
      }
    }
    if (this.flashT > 0) {
      this.flashT = Math.max(0, this.flashT - dt);
      const f = Math.max(0, Math.sin(this.flashT * 20)) * this.flashT;
      this.engine.clouds.flash(f * 0.9);
    } else this.engine.clouds.flash(0);
    const wp = w.landmarks.whalePos();
    if (wp && Math.hypot(wp.x - p.x, wp.z - p.z) < 900) {
      this.whaleT -= dt;
      if (this.whaleT < 0) {
        this.whaleT = 16 + Math.random() * 10;
        this.audio.whale();
      }
    }
  }
  private flashT = 0;
  private whaleT = 2;

  private pickFeathers(dt: number): void {
    const p = this.bird.position;
    for (const f of this.feathers) {
      if (f.taken) {
        if (f.a > 0) f.a = Math.max(0, f.a - dt * 2.5);
        continue;
      }
      const dx = f.x - p.x;
      const dy = f.y - p.y;
      const dz = f.z - p.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < 900 && d2 > 1) {
        // they lean toward you a little, on your own wake
        const k = (dt * 5) / Math.sqrt(d2);
        f.x -= dx * k * 0.6;
        f.y -= dy * k * 0.6;
        f.z -= dz * k * 0.6;
      }
      if (d2 < 52) {
        f.taken = true;
        this.featherCount++;
        this.rec.feathers = this.featherCount;
        this.bird.breath = clamp01(this.bird.breath + config.breathFeather);
        this.audio.feather(this.motif++);
        for (let i = 0; i < 9; i++) this.world.fx.spark(f.x, f.y, f.z, (Math.random() - 0.5) * 3 + -dx, (Math.random() - 0.2) * 2, (Math.random() - 0.5) * 3 - dz, 1);
        this.hint('feather', 'The flock lets feathers fall along the good air.');
      }
    }
  }

  private meet(): void {
    const p = this.bird.position;
    for (const c of this.flock.birds) {
      if (c.state !== 'waiting' && c.state !== 'circling') continue;
      const d = Math.hypot(c.x - p.x, (c.y - p.y) * 0.7, c.z - p.z);
      if (d < (c.state === 'circling' ? 52 : 46) && this.bird.mode === 'air' && this.t > 4) this.welcome(c);
      else if (d < 260) this.hint('meet', this.input.device === 'touch' ? 'Someone is there. Call, or fly alongside.' : 'Someone is there. <kbd>E</kbd> to call, or fly alongside.');
    }
  }

  private discover(): void {
    const p = this.bird.position;
    for (const l of this.world.landmarks.list) {
      const key = `${this.world.land.id}:${l.def.id}`;
      if (this.discovered.has(key)) continue;
      const wp = l.def.kind === 'whale' ? this.world.landmarks.whalePos() : null;
      const x = wp ? wp.x : l.def.x;
      const z = wp ? wp.z : l.def.z;
      if (Math.hypot(x - p.x, z - p.z) < l.def.reach && p.y - l.def.y < l.top + 170) {
        this.discovered.add(key);
        if (!this.data.landmarks.includes(key)) {
          this.data.landmarks.push(key);
          save(this.data);
        }
        this.ui.place(l.def.name);
        if (l.def.kind === 'bell') {
          this.audio.bell();
          this.world.landmarks.bellSwing = 1;
        } else if (l.def.kind === 'whale') this.audio.whale();
        else this.audio.discover();
      }
    }
  }

  private surfaceFx(dt: number): void {
    const b = this.bird;
    const p = b.position;
    if (b.mode !== 'air') return;
    this.ringT -= dt;
    if (b.overWater && b.agl < 3.6 && this.ringT < 0) {
      this.ringT = 0.22;
      this.world.water.ring(p.x, p.z, b.touch > 0 ? 1 : 0.5 * sm(3.6, 1.2, b.agl));
      if (b.touch > 0.2) this.audio.splash(0.25 + 0.3 * b.touch);
    }
    if (b.touch > 0.4 && b.overWater) {
      const f = forwardOf(b);
      for (let i = 0; i < 3; i++) {
        const s = Math.random() < 0.5 ? -1 : 1;
        this.world.fx.spark(p.x - f.z * s * 0.6, 0.15, p.z + f.x * s * 0.6, f.x * b.airspeed * 0.4 - f.z * s * 1.6, 1.4 + Math.random() * 1.6, f.z * b.airspeed * 0.4 + f.x * s * 1.6, 0);
      }
    }
  }

  // ------------------------------------------------------------------ guidance
  private hint(key: string, html: string, hold = 6200): void {
    if (this.hints.has(key) || !this.data.settings.hints) return;
    this.hints.add(key);
    this.hintQueue.push([html, hold]);
  }

  private guide(dt: number, inp: FlightInput, off: number): void {
    const b = this.bird;
    const first = this.world.land.id === 'stillmere' && !this.free;
    const touch = this.input.device === 'touch';
    if (first) {
      if (this.t > 4.5) this.hint('lean', touch ? 'Drag to lean. Down lifts the nose, up lets it fall.' : '<kbd>A</kbd><kbd>D</kbd> to lean, <kbd>W</kbd><kbd>S</kbd> to fall and rise');
      if (this.t > 15) this.hint('trade', 'Height and speed are one thing. Dive for one, climb for the other.');
      const n = this.world.thermals.nearest(b.position.x, b.position.z);
      if (n && n.d < 420 && this.t > 22) this.hint('thermal', 'Warm air climbs where the light turns. Circle inside it.');
    }
    this.liftTime = b.lift > 1.6 ? this.liftTime + dt : 0;
    if (this.liftTime > 3) this.hint('lift', 'Rising air gives back height, and breath.');
    if (b.breath < 0.22 && !this.breathLow) {
      this.breathLow = true;
      this.hint('breath', 'Wingbeats cost breath. Gliding is free.');
    }
    if (b.mode === 'ground' && b.modeTime > 1.4) this.hint('rest', touch ? 'Rest as long as you like. Hold wings to rise.' : 'Rest as long as you like. <kbd>Space</kbd> to rise.');
    // lost?
    const f = forwardOf(b);
    const [dx, dz] = this.world.land.route.dir(this.world.land.route.qt);
    const away = f.x * dx + f.z * dz < -0.25 || off > 1500;
    this.offRoad = away && b.lift < 1 ? this.offRoad + dt : 0;
    if (this.offRoad > 22 && this.time - this.callAt > 20) {
      this.offRoad = 0;
      this.ui.whisper(touch ? 'If you lose the road, call.' : 'If you lose the road, <kbd>E</kbd> to call.', 5000);
    }
    if (this.time > this.hintUntil && this.hintQueue.length) {
      const [h, hold] = this.hintQueue.shift()!;
      this.ui.whisper(h, hold);
      this.hintUntil = this.time + hold / 1000 + 1.4;
    }
    void inp;
  }

  // -------------------------------------------------------------------- arriving
  private beginArrive(): void {
    const b = this.bird;
    this.go('arrive');
    this.drift = false;
    this.ui.hush();
    this.hintQueue = [];
    const w = this.world;
    const [x, z] = w.land.route.at(1);
    const y = Math.max(w.terrain.heightAt(x, z), -0.4);
    const f = forwardOf(b);
    const A = this.land0;
    A.p.set(b.position.x, b.position.y, b.position.z);
    A.v.set(f.x * b.airspeed, b.climbRate, f.z * b.airspeed);
    A.q.set(x, y, z);
    const [dx, dz] = w.land.route.dir(0.995);
    A.w.set(dx * 3.2, -0.5, dz * 3.2);
    const d = A.p.distanceTo(A.q);
    A.T = Math.max(7, d / 11.5);
    A.t = 0;
    this.ui.hud(false);
    this.ui.touch(false);
    this.nextDayBake();
  }

  private stepArrive(dt: number): void {
    const A = this.land0;
    const b: BirdState = { ...this.bird, position: { ...this.bird.position } };
    this.prev = this.bird;
    A.t += dt;
    const k = clamp01(A.t / A.T);
    const h = (u: number, out: THREE.Vector3) => {
      const u2 = u * u;
      const u3 = u2 * u;
      out.set(0, 0, 0)
        .addScaledVector(A.p, 2 * u3 - 3 * u2 + 1)
        .addScaledVector(A.v, (u3 - 2 * u2 + u) * A.T)
        .addScaledVector(A.q, -2 * u3 + 3 * u2)
        .addScaledVector(A.w, (u3 - u2) * A.T);
      return out;
    };
    const a = h(k, new THREE.Vector3());
    const c = h(Math.min(1, k + 0.004), new THREE.Vector3());
    const v = c.sub(a).divideScalar(0.004 * A.T);
    const g = this.world.surfaceY(a.x, a.z) + 0.7 * (1 - sm(0.93, 1, k));
    b.position.x = a.x;
    b.position.y = Math.max(a.y, k < 0.97 ? g : A.q.y);
    b.position.z = a.z;
    const sp = Math.hypot(v.x, v.z);
    if (sp > 0.5) {
      const want = Math.atan2(-v.x, -v.z);
      const dy = wrapA(want - b.yaw);
      b.yaw += dy * (1 - Math.exp(-dt * 4));
      b.roll = ease(b.roll, Math.max(-0.7, Math.min(0.7, (-dy / Math.max(dt, 1e-3)) * 0.35 * (1 - sm(0.7, 0.95, k)))), 2.2, dt);
    }
    b.pitch = ease(b.pitch, Math.atan2(v.y, Math.max(4, sp)) * 0.5 * (1 - k), 2, dt);
    b.airspeed = Math.max(3, Math.hypot(sp, v.y));
    b.climbRate = v.y;
    b.agl = b.position.y - this.world.surfaceY(a.x, a.z);
    b.flare = ease(b.flare, sm(0.62, 0.86, k), 3, dt);
    b.beat = ease(b.beat, sm(0.8, 0.9, k) * (1 - sm(0.97, 1, k)) * 0.85, 4, dt);
    b.beatPhase += dt * (1.2 + 6.4 * b.beat);
    b.lift = 0;
    b.modeTime += dt;
    this.lightP = ease(this.lightP, 1, 0.25, dt);
    if (k >= 1) {
      b.mode = 'ground';
      b.modeTime = 0;
      b.airspeed = 1.4;
      b.flare = 0.7;
      const water = this.world.terrain.heightAt(a.x, a.z) < 0;
      this.audio.land(water);
      if (water) for (let i = 0; i < 4; i++) setTimeout(() => this.world.water.ring(A.q.x, A.q.z, 1.3 - i * 0.25), i * 260);
      this.bird = b;
      this.beginRoost();
      return;
    }
    this.bird = b;
  }

  private nextDayBake(): void {
    if (this.free) return;
    if (this.landIdx < 5) void this.bake(LAND_ORDER[this.landIdx + 1]);
  }

  private beginRoost(): void {
    if (this.phase === 'roost' || this.phase === 'finale') return;
    const id = this.world.land.id;
    this.progress = 1;
    this.readyToLeave = false;
    const finale = id === 'wintering' && !this.free;
    this.go(finale ? 'finale' : 'roost');
    this.ui.hud(false);
    this.ui.touch(false);
    this.audio.setScene('roost');
    this.nextDayBake();
    // remember the day
    const old = this.data.days[id];
    this.data.days[id] = {
      distance: Math.max(old?.distance ?? 0, this.rec.distance),
      highest: Math.max(old?.highest ?? 0, this.rec.highest),
      longestGlide: Math.max(old?.longestGlide ?? 0, this.rec.longestGlide),
      feathers: Math.max(old?.feathers ?? 0, this.rec.feathers),
      feathersTotal: this.rec.feathersTotal,
      seconds: this.rec.seconds,
    };
    if (!this.free && this.landIdx >= this.data.day) this.data.day = Math.min(6, this.landIdx + 1);
    save(this.data);

    // the company comes down around you
    let i = 0;
    for (const c of this.flock.birds) {
      if (c.state !== 'with' && c.state !== 'joining') continue;
      const a = this.bird.yaw + 0.9 + i * 0.83;
      const r = 3.8 + (i % 3) * 1.5;
      c.hx = this.bird.position.x + Math.sin(a) * r;
      c.hz = this.bird.position.z + Math.cos(a) * r;
      const k = c;
      this.at(0.4 + i * 0.5, () => {
        k.state = 'landing';
        k.t = 0;
      });
      i++;
    }
    this.rig.mode = 'orbit';
    const o = this.rig.orbit;
    o.shift = 0;
    o.radius = 12;
    o.height = 1.5;
    o.lookUp = 1.4;
    o.fov = 42;
    o.speed = 0.035;
    const cam = this.engine.camera.position;
    o.angle = Math.atan2(cam.x - this.bird.position.x, cam.z - this.bird.position.z);
    this.rig.ease(this.engine.camera, 6);

    if (finale) {
      this.beginFinale();
      return;
    }
    const kbd = this.input.device !== 'touch';
    const r = this.rec;
    this.at(4.2, () => this.ui.verse(this.world.mv.closing, 6200));
    this.at(11.5, () => {
      this.ui.log([
        ['flown', `${(r.distance / 1000).toFixed(1)} km`],
        ['highest', `${Math.round(r.highest)} m`],
        ['longest glide', r.longestGlide > 950 ? `${(r.longestGlide / 1000).toFixed(1)} km` : `${Math.round(r.longestGlide)} m`],
        ['feathers', `${r.feathers} of ${r.feathersTotal}`],
      ]);
    });
    this.at(13.0, () => {
      this.readyToLeave = true;
      this.ui.whisper(this.free ? (kbd ? '<kbd>Space</kbd> to fly again, <kbd>Esc</kbd> for the road' : 'Hold wings to fly again') : kbd ? '<kbd>Space</kbd> to sleep' : 'Hold wings to sleep', 0);
      this.ui.touch(this.input.device === 'touch');
    });
  }

  private beginNight(): void {
    this.ui.hush();
    this.ui.hideLog();
    this.ui.hideVerse();
    this.ui.touch(false);
    if (this.free) {
      const id = this.world.land.id;
      const seed = this.world.land.seed;
      void this.freeFlight(id, seed);
      this.go('night');
      return;
    }
    this.go('night');
    this.audio.setScene('night');
    this.wakeSleep = 0;
    this.rig.orbit.speed = 0.02;
    this.at(9, () => {
      this.fadeTarget = 1;
      this.fadeRate = 0.55;
    });
    this.at(11.4, () => {
      void (async () => {
        await this.enter(LAND_ORDER[this.landIdx + 1], undefined, false);
        this.engine.invalidateShadows();
        this.beginWake();
      })();
    });
  }

  private beginFinale(): void {
    this.finaleStage = 0;
    this.at(5, () => this.ui.verse(['Here you are.'], 5200));
    this.at(8, () => this.audio.answer(0.95, 0.1, 1));
    this.at(17, () => {
      // from far behind, north: someone else, late
      this.audio.call(0.05);
      this.finaleStage = 1;
    });
    this.at(19.5, () => this.ui.verse(['From a long way north, one voice.'], 5200));
    this.at(23, () => {
      this.audio.call(0.05);
    });
    this.at(25, () => {
      this.finaleStage = 2;
      this.ui.whisper(this.input.device === 'touch' ? 'Tap call to answer' : '<kbd>E</kbd> to answer', 0);
      this.ui.touch(this.input.device === 'touch');
    });
    this.at(60, () => {
      if (this.finaleStage === 2) this.finaleCall();
    });
  }
  private finaleStage = 0;

  private finaleCall(): void {
    if (this.finaleStage !== 2) return;
    this.finaleStage = 3;
    this.ui.hush();
    this.ui.touch(false);
    this.audio.setScene('finale');
    this.riseTarget = 1;
    const base = this.t;
    this.at(base + 2, () => this.audio.answer(1, -0.3, 1));
    this.at(base + 3.2, () => this.audio.answer(1, 0.4, 1));
    this.at(base + 5, () => {
      this.rig.orbit.radius = 17;
      this.rig.orbit.height = 2.2;
      this.rig.orbit.lookUp = 6.5;
      this.rig.orbit.fov = 62;
      this.rig.orbit.speed = 0.06;
      this.rig.ease(this.engine.camera, 9);
      this.audio.answer(1, 0, 1);
    });
    this.at(base + 13, () => this.ui.verse(this.world.mv.closing, 9000, 2400));
    this.at(base + 27, () => this.ui.credit('Aloft', 'for everyone still on the way'));
    this.at(base + 29, () => {
      this.data.arrived = true;
      this.data.day = 6;
      save(this.data);
    });
    this.at(base + 40, () => {
      this.fadeTarget = 1;
      this.fadeRate = 0.35;
    });
    this.at(base + 45, () => {
      this.ui.hideCredit();
      this.free = false;
      void this.enter('wintering', undefined, false).then(() => {
        this.riseTarget = this.rise = 0.22;
        this.toTitle();
      });
    });
  }

  // ------------------------------------------------------------------ presenting
  private present(dt: number, look: { x: number; y: number }, inp: FlightInput): void {
    const w = this.world;
    const b = this.bird;
    const a = Math.min(1, this.acc / SIM_DT);
    const l = (x: number, y: number) => x + (y - x) * a;
    const pb = this.prev;
    const s: BirdState = {
      ...b,
      position: { x: l(pb.position.x, b.position.x), y: l(pb.position.y, b.position.y), z: l(pb.position.z, b.position.z) },
      yaw: pb.yaw + wrapA(b.yaw - pb.yaw) * a,
      pitch: l(pb.pitch, b.pitch),
      roll: l(pb.roll, b.roll),
    };
    if (this.phase === 'arrive' || this.phase === 'photo') {
      s.position = { ...b.position };
      s.yaw = b.yaw;
      s.pitch = b.pitch;
      s.roll = b.roll;
    }
    this.drawn.set(s.position.x, s.position.y, s.position.z);
    const pdt = this.paused || this.phase === 'photo' ? 0 : dt;

    // light
    const nightTarget = this.phase === 'night' && !this.free ? sm(0.4, 7, this.t) : 0;
    this.night = this.phase === 'night' ? nightTarget : 0;
    const lp = this.phase === 'photo' ? this.photoP : this.lightP;
    w.light(clamp01(lp), this.night);

    // birds
    w.feathers.begin();
    this.posePlayer(s, pdt);
    const tips = this.tipsOf(s);
    w.player.age = w.mv.age;
    w.player.update(s.position, s.yaw, s.pitch, s.roll, this.pose, pdt);
    this.drawCompanions(pdt);
    w.feathers.end();
    this.drawFarBirds();

    G.uBirdPos.value.set(s.position.x, s.position.y, s.position.z, 4.6);

    // wing threads
    const g = Math.abs(b.roll) * 0.5 + sm(24, 40, b.airspeed) + b.lift * 0.04;
    const mark = b.mode === 'air' && this.phase !== 'arrive' ? clamp01(g - 0.25) * 0.75 + b.touch * 0.4 : 0;
    if (pdt > 0) w.fx.tips(tips[0], tips[1], mark, this.engine.camera.position);

    // feathers on the air
    let n = 0;
    const P = s.position;
    for (const f of this.feathers) {
      if (f.a <= 0) continue;
      const dx = f.x - P.x;
      const dz = f.z - P.z;
      if (dx * dx + dz * dz > 1500 * 1500 || n >= 160) continue;
      this.fdata[n * 4] = f.x;
      this.fdata[n * 4 + 1] = f.y;
      this.fdata[n * 4 + 2] = f.z;
      this.fdata[n * 4 + 3] = f.a;
      n++;
    }
    w.fx.setFeathers(this.fdata, this.phase === 'fly' || this.phase === 'photo' ? n : 0);

    // camera
    if (this.phase === 'photo') {
      const f = this.rig.free;
      f.yaw -= inp.roll * dt * 1.2 - look.x * 0.02;
      f.pitch = Math.max(-0.5, Math.min(1.2, f.pitch - inp.pitch * dt * 0.8 + look.y * 0.02));
      f.dist = Math.max(3, Math.min(60, f.dist + (inp.beat ? dt * 8 : 0)));
    }
    this.rig.update(this.engine.camera, s, dt, w.terrain, look, this.pose.legs);
    const f = forwardOf(s);
    this.focus.set(P.x + f.x * 70, P.y, P.z + f.z * 70);
    if (this.phase !== 'fly') this.focus.set(P.x, P.y, P.z);
    const gy = w.surfaceY(P.x, P.z);
    // shadows matter most where the bird meets the ground
    this.focus.y = Math.max(gy, P.y - 60);

    this.engine.fade += (this.fadeTarget - this.engine.fade) * (1 - Math.exp(-dt * this.fadeRate * 3));
    if (Math.abs(this.engine.fade - this.fadeTarget) < 0.004) this.engine.fade = this.fadeTarget;

    w.draw(pdt, this.focus, this.t < 1 ? 400 : 24);

    // instruments
    const st = this.data.settings;
    this.ui.hud(st.hud && this.phase === 'fly' && !this.paused && this.t > 2);
    this.ui.instruments(b.agl, b.airspeed * 3.6, b.breath, b.mode === 'air' ? b.lift : 0);
    this.ui.stick(this.input.pointer.stick, this.phase === 'fly' && this.input.device === 'touch');
    this.sound(dt);
  }

  private posePlayer(s: BirdState, dt: number): void {
    const p = this.pose;
    const ground = s.mode === 'ground' ? 1 : 0;
    const leap = s.mode === 'leap' ? sm(0.15, 0.6, s.modeTime) : 0;
    const standing = ground || (s.mode === 'leap' && s.modeTime < 0.5 ? 1 : 0);
    const flare = s.flare;
    p.fold = ease(p.fold, ground * (s.modeTime > 0.5 ? 1 : 0.2) * (1 - leap), ground ? 2.4 : 5, dt);
    p.legs = ease(p.legs, standing ? 1 : flare * 0.4, standing ? 5 : 3, dt);
    p.neck = ease(p.neck, standing ? 1 : flare * 0.35, 2.2, dt);
    p.flare = ease(p.flare, flare * (1 - ground), 4, dt);
    const speed = s.airspeed;
    p.tuck = ease(p.tuck, ground ? 0 : sm(27, 46, speed) * 0.9 * (1 - s.beat), 2, dt);
    p.flapAmp = ease(p.flapAmp, ground ? 0 : s.beat, 4, dt);
    p.flapPhase = s.beatPhase;
    p.dihedral = ease(p.dihedral, 0.05 + 0.1 * sm(0, 5, s.lift) + 0.09 * Math.abs(s.roll) - 0.03 * p.tuck, 2, dt);
    p.load = ease(p.load, clamp01(0.3 + 0.13 * Math.max(0, s.lift) + 0.5 * Math.abs(s.roll) + Math.max(0, s.stickPitch) * 0.6), 2.5, dt);
    p.bank = ease(p.bank, s.roll, 5, dt);
    p.tailFan = ease(p.tailFan, clamp01(0.22 + Math.abs(s.roll) * 0.5 + flare * 0.8 + sm(16, 11, speed) * 0.5), 2.5, dt);
    p.neckYaw = ease(p.neckYaw, ground ? Math.sin(this.time * 0.23) * 0.7 * sm(2, 5, s.modeTime) : s.stickRoll * 0.35, 1.4, dt);
    p.neckPitch = ease(p.neckPitch, (ground ? Math.sin(this.time * 0.31) * 0.15 : s.stickPitch * 0.25) + this.headToss, 5, dt);
    p.step += dt * speed * 2.4 * (standing ? 1 : 0);
    p.stepAmp = ease(p.stepAmp, standing * clamp01(speed / 5), 6, dt);
    const asleep = this.phase === 'title' || this.phase === 'wake' || this.phase === 'night' ? this.wakeSleep : 0;
    const sl = this.phase === 'night' ? sm(1.5, 6, this.t) : asleep;
    p.sleep = ease(p.sleep, sl, 1.6, dt);
    p.oneLeg = ease(p.oneLeg, this.phase === 'title' || this.phase === 'night' || (this.phase === 'wake' && this.wakeSleep > 0.3) ? 1 : 0, 1, dt);
    // calling throws the head up
    const ca = this.time - this.callAt;
    const toss = ca < 1.6 ? Math.sin(Math.PI * clamp01(ca / 1.6)) * 0.55 : 0;
    this.headToss = ease(this.headToss, toss, 8, dt);
  }

  private headToss = 0;
  private readonly tl = new THREE.Vector3();
  private readonly tr = new THREE.Vector3();
  private tipsOf(s: BirdState): [THREE.Vector3, THREE.Vector3] {
    const e = new THREE.Euler(s.pitch, s.yaw, -s.roll, 'YXZ');
    this.tl.set(-2.45, 0.3, -0.05).applyEuler(e).add(this.drawn);
    this.tr.set(2.45, 0.3, -0.05).applyEuler(e).add(this.drawn);
    return [this.tl, this.tr];
  }

  private drawCompanions(dt: number): void {
    const w = this.world;
    const birds = this.flock.birds;
    for (let i = 0; i < MAX_COMPANIONS; i++) {
      const cr: Crane = w.cranes[i];
      const c = birds[i];
      const vis = !!c && Math.hypot(c.x - this.drawn.x, c.y - this.drawn.y, c.z - this.drawn.z) < 700;
      cr.group.visible = cr.shadowGroup.visible = vis;
      if (!vis) continue;
      const p = this.cposes[i];
      const standing = c.state === 'waiting' || c.state === 'roosted' ? 1 : 0;
      const near = c.state === 'landing' ? sm(14, 2, Math.hypot(c.hx - c.x, c.hz - c.z)) : 0;
      p.fold = ease(p.fold, standing, standing ? 2 : 4, dt);
      p.legs = ease(p.legs, standing || near * 0.5, 3, dt);
      p.neck = ease(p.neck, standing, 2, dt);
      p.flare = ease(p.flare, near, 3, dt);
      p.flapAmp = ease(p.flapAmp, c.beat, 4, dt);
      p.flapPhase = c.beatPhase + c.seed;
      p.dihedral = 0.07 + 0.08 * Math.abs(c.roll);
      p.load = 0.4 + 0.4 * Math.abs(c.roll);
      p.bank = c.roll;
      p.tailFan = ease(p.tailFan, 0.25 + near * 0.7 + Math.abs(c.roll) * 0.4, 2, dt);
      const tt = this.time * 0.2 + c.seed;
      p.neckYaw = standing ? Math.sin(tt * 1.3) * 0.9 : c.roll * 0.3;
      p.neckPitch = standing ? Math.sin(tt * 1.9) * 0.22 - 0.1 : 0;
      p.oneLeg = standing && c.id % 2 ? 1 : 0;
      p.sleep = this.phase === 'night' || this.phase === 'title' ? ease(p.sleep, c.id % 3 ? 1 : 0, 0.8, dt) : ease(p.sleep, 0, 1, dt);
      cr.age = 1 - 0.55 * Math.abs(Math.sin(c.seed * 3.1)) * (c.id % 3 === 0 ? 1 : 0.25);
      cr.scale = c.scale;
      cr.update(c, c.yaw, c.pitch, c.roll, p, dt);
    }
  }

  private drawFarBirds(): void {
    const w = this.world;
    const fb = w.farBirds;
    fb.begin();
    const T = G.uTime.value;
    // kettles over the nearest thermals — birds already know
    const P = this.drawn;
    if (w.thermals.vigor > 0.4) {
      const ts = w.thermals.thermals;
      let shown = 0;
      for (const t of ts) {
        const d = Math.hypot(t.x - P.x, t.z - P.z);
        if (d > 2600 || shown > 6) continue;
        shown++;
        for (let i = 0; i < 6; i++) {
          const R = t.radius * (0.3 + 0.09 * i);
          const sp = 12 / R;
          const ph = T * sp + i * 1.9 + t.x;
          const y = t.ground + (t.top - t.ground) * (0.36 + 0.09 * i) + Math.sin(T * 0.2 + i) * 8;
          fb.put(t.x + Math.cos(ph) * R, y, t.z + Math.sin(ph) * R, Math.atan2(Math.sin(ph), -Math.cos(ph)), 0.45, T * 2 + i * 9, 0.62, Math.sin(T * 0.3 + i * 4) > 0.82 ? 0.7 : 0.03);
        }
      }
    }
    // the flock ahead
    const id = w.land.id;
    const lead = LEAD[id];
    if (lead > 0 && (this.phase === 'fly' || this.phase === 'arrive' || this.phase === 'photo') && this.leadT + lead / w.land.route.total < 0.998) {
      const L = this.leadPos(new THREE.Vector3());
      const [dx, dz] = w.land.route.dir(Math.min(0.99, this.leadT + lead / w.land.route.total));
      const yaw = Math.atan2(-dx, -dz);
      const n = 19 + this.landIdx * 4;
      for (let i = 0; i < n; i++) {
        const side = i % 2 ? 1 : -1;
        const k = Math.ceil(i / 2);
        const lat = side * k * 6.4 + Math.sin(T * 0.2 + i) * 1.5;
        const back = k * 7.2 + Math.sin(T * 0.17 + i * 2) * 2;
        fb.put(L.x - dx * back - dz * lat, L.y + Math.sin(T * 0.4 + i) * 1.6, L.z - dz * back + dx * lat, yaw, 0, T * 5.4 + i * 0.9, 1.0, 0.55 + 0.45 * Math.sin(T * 0.5 + i * 0.6));
      }
    }
    // the first morning: they go over, and on
    if (this.flyover >= 0 && this.flyover < 30) {
      const f = this.flyover;
      const b = this.bird;
      const fw = forwardOf({ yaw: b.yaw, pitch: 0 });
      const s = -160 + f * 24;
      for (let i = 0; i < 27; i++) {
        const side = i % 2 ? 1 : -1;
        const k = Math.ceil(i / 2);
        const lat = side * k * 4.6 + 26;
        const back = k * 5.4;
        fb.put(b.position.x + fw.x * (s - back) - fw.z * lat, b.position.y + 52 + Math.sin(T * 0.6 + i) * 1.4 + f * 1.1, b.position.z + fw.z * (s - back) + fw.x * lat, b.yaw, 0, T * 6 + i * 0.8, 1.05, 0.8);
      }
    }
    fb.end();
  }

  // --------------------------------------------------------------------- sound
  private readonly af: AudioFrame = { airspeed: 0, agl: 0, alt: 0, lift: 0, climb: 0, beat: 0, beatPhase: 0, touch: 0, overWater: false, mode: 'ground', companions: 0, progress: 0, night: 0, inCloud: 0, forest: 0, water: 0, wind: 0, storm: 0, bank: 0 };
  private ambT = 0;
  private prevMode: BirdState['mode'] = 'ground';

  private sound(dt: number): void {
    const b = this.bird;
    const f = this.af;
    const w = this.world;
    f.airspeed = b.mode === 'ground' ? 0 : b.airspeed;
    f.agl = b.agl;
    f.alt = b.position.y;
    f.lift = b.lift;
    f.climb = b.climbRate;
    f.beat = b.beat;
    f.beatPhase = b.beatPhase;
    f.touch = b.touch;
    f.overWater = b.overWater;
    f.mode = b.mode;
    f.companions = this.flock.with;
    f.progress = this.lightP;
    f.night = Math.max(this.night, Math.min(1, w.frame.stars));
    f.wind = Math.hypot(w.wind.x, w.wind.z);
    f.storm = this.storm;
    f.bank = b.roll;
    this.ambT -= dt;
    if (this.ambT < 0) {
      this.ambT = 0.4;
      const p = b.position;
      let forest = 0;
      let water = 0;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * 6.283;
        const x = p.x + Math.cos(a) * 45;
        const z = p.z + Math.sin(a) * 45;
        forest += w.mask.at(x, z, 0) / 8;
        water += (w.terrain.heightAt(x, z) < 0 ? 1 : 0) / 8;
      }
      f.forest = forest;
      f.water = water;
      const sp = w.engine.clouds.spec;
      const inSlab = sp ? sm(sp.base - 20, sp.base + 40, p.y) * (1 - sm(sp.top - 60, sp.top, p.y)) : 0;
      f.inCloud = inSlab * sm(0.3, 0.75, w.engine.clouds.coverage(p.x, p.z));
    }
    if (this.prevMode !== b.mode) {
      if (b.mode === 'leap') this.audio.leap();
      if (b.mode === 'ground' && this.phase === 'fly') this.audio.land(b.overWater);
      this.prevMode = b.mode;
    }
    this.audio.update(f, dt);
  }
}
