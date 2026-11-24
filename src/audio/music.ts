/**
 * The music: one slow harmony per land, breathing; a sparse tune whose pace is
 * the only speed readout; a layer that rises when the air does; and a voice
 * for every bird flying beside you.
 */
import type { LandId } from '../world/lands';
import type { AudioFrame, Scene } from './engine';
import { EVENTUALLY, LATER, NOW, Rng, SOON, clamp, ease, lerp, semis, smooth, spread } from './dsp';
import type { Mixer } from './mixer';
import { Bus, Held, Player } from './player';
import { Chord, HARMONY, Harmony, LandMusic, fit, ladder, maskOf } from './theory';
import type { Bank, NoteKind, PadKind } from './timbres';

interface Palette {
  /** sustained: the land's colour, and what carries the top */
  col: PadKind;
  air: PadKind;
  /** struck: the tune, its companion, and what rises in lift */
  lead: NoteKind;
  second: NoteKind;
  arp: NoteKind;
  /** what lays the chords out */
  roll: NoteKind;
  /** how bright the pads sit (Hz) and a level trim so every land is as loud */
  tone: number;
  trim: number;
}

const PALETTE: Record<LandMusic['color'], Palette> = {
  glass: { col: 'glass', air: 'choir', lead: 'glass', second: 'felt', arp: 'glass', roll: 'felt', tone: 1700, trim: 1.08 },
  wood: { col: 'wood', air: 'strings', lead: 'wood', second: 'harp', arp: 'harp', roll: 'harp', tone: 1750, trim: 1.08 },
  bell: { col: 'bell', air: 'choir', lead: 'bell', second: 'felt', arp: 'glass', roll: 'felt', tone: 2100, trim: 1 },
  brass: { col: 'brass', air: 'strings', lead: 'harp', second: 'horn', arp: 'harp', roll: 'harp', tone: 1700, trim: 1 },
  deep: { col: 'choir', air: 'glass', lead: 'vibes', second: 'felt', arp: 'glass', roll: 'felt', tone: 1400, trim: 0.96 },
  choir: { col: 'choir', air: 'choir', lead: 'harp', second: 'felt', arp: 'glass', roll: 'harp', tone: 1850, trim: 0.96 },
};

/** What each scene asks of each layer. */
interface Mood {
  low: number;
  mid: number;
  col: number;
  air: number;
  lead: number;
  choir: number;
  stars: number;
  /** seconds between notes, multiplier */
  space: number;
  /** chord length multiplier */
  slow: number;
  lull: boolean;
}

const MOODS: Record<Scene, Mood> = {
  title: { low: 0.85, mid: 0.95, col: 1.05, air: 0.9, lead: 1.05, choir: 0.5, stars: 0.35, space: 1.35, slow: 1.1, lull: false },
  flight: { low: 1, mid: 1, col: 1, air: 1, lead: 1, choir: 1, stars: 1, space: 1, slow: 1, lull: false },
  roost: { low: 0.85, mid: 0.95, col: 0.9, air: 0.45, lead: 0.85, choir: 0.8, stars: 0.6, space: 1.7, slow: 1.35, lull: true },
  night: { low: 0.85, mid: 0.86, col: 0.95, air: 0.5, lead: 0.86, choir: 0.65, stars: 1.2, space: 2.4, slow: 1.6, lull: true },
  finale: { low: 1.05, mid: 0.95, col: 1.1, air: 1.1, lead: 1.2, choir: 1.05, stars: 0.5, space: 0.8, slow: 0.86, lull: false },
  silent: { low: 0, mid: 0, col: 0, air: 0, lead: 0, choir: 0, stars: 0, space: 2, slow: 1.4, lull: true },
};

const MOOD_KEYS = ['low', 'mid', 'col', 'air', 'lead', 'choir', 'stars', 'space', 'slow'] as const;

interface Slot {
  bus: Bus;
  kind: PadKind;
  level: number;
  held: Held | null;
  want: number; // midi, or -1
  stagger: number;
  attack: number;
  pan: number;
}

/** rhythm cells, in units of the current spacing; each ends with room */
const CELLS: number[][] = [
  [1, 1, 2.4],
  [1.5, 0.75, 1, 2.6],
  [1, 1, 1, 1.5, 2.8],
  [2, 1, 1, 2.6],
  [1, 1.5, 0.75, 1, 3],
  [1.5, 1.5, 3],
];

/** everything overall, in one place (linear) */
const LEVEL = { low: 0.38, mid: 0.42, col: 0.46, air: 0.3, lead: 1.45, choir: 0.42, lift: 0.2, arp: 1.5, star: 1, bright: 0.95, quote: 0.6 };

/** how far a held voice eases off before the next chord leans in */
const REST = 0.42;

export class Music {
  private low: Bus;
  private mid: Bus;
  private col: Bus;
  private air: Bus;
  private lead: Bus;
  private choir: Bus;
  private lift: Bus[];
  private arp: Bus;
  private star: Bus;
  /** pickups, landmarks, menus: steady, never thinned */
  readonly bright: Bus;
  private buses: Bus[];

  private slots: Slot[] = [];
  private company: Slot[] = [];
  private rising: Slot[] = [];

  private land: LandId | null = null;
  private har: Harmony = HARMONY.stillmere;
  private mus: LandMusic = { root: 50, scale: [0, 2, 4, 7, 9], pace: 1, color: 'glass' };
  private pal: Palette = PALETTE.glass;
  private scene: Scene = 'title';
  private mood: Mood = { ...MOODS.silent, space: 1, slow: 1 };

  private chord = -1; // index in the progression
  private leap = -1; // a chord to go to next, out of turn
  private chordAt = 0;
  private chordLen = 12;
  private nextChord = Infinity;
  private mask = 0;
  private count = 0; // chords since the land began
  private retryAt = 0;
  private stirAt: number[] = new Array<number>(8).fill(Infinity);

  private melody: number[] = [];
  private sparkle: number[] = [];
  private nextNote = Infinity;
  private at = 0; // index on the melody ladder
  private cell = CELLS[0];
  private cellI = 0;
  private phraseOf = 0; // >0: steps left of a motif quotation
  private motifI = 0;
  private lastDir = 1;
  private quoting = false;
  private due: { t: number; midi: number; hold: number; last: boolean; arch: number }[] = [];

  private nextArp = 0;
  private arpI = 0;
  private arpLeft = 0;
  private nextStar = 0;

  private swellT = 0; // a passing warmth (discoveries, arrivals)
  private e = { speed: 20, high: 0, lift: 0, climb: 0, dive: 0, ground: 0, cloud: 0, night: 0, prog: 0, storm: 0, comp: 0 };
  private clock = 0;

  constructor(
    private ctx: BaseAudioContext,
    private mix: Mixer,
    private bank: Bank,
    private player: Player,
    private rng: Rng,
  ) {
    const d = mix.music;
    const w = mix.musicSend;
    this.low = new Bus(ctx, d, w, 0, 700, 0.12);
    this.mid = new Bus(ctx, d, w, 0, 1500, 0.4);
    this.col = new Bus(ctx, d, w, 0, 2600, 0.55);
    this.air = new Bus(ctx, d, w, 0, 3600, 0.75);
    this.lead = new Bus(ctx, d, w, 0, 4200, 0.6);
    this.choir = new Bus(ctx, d, w, 0, 2400, 0.7);
    this.lift = [0, 1, 2].map(() => new Bus(ctx, d, w, 0, 1400, 0.6));
    this.arp = new Bus(ctx, d, w, 0, 3200, 0.9);
    this.star = new Bus(ctx, d, w, 0, 6000, 1.3);
    this.bright = new Bus(ctx, mix.voice, mix.voiceSend, LEVEL.bright, 5200, 0.6);
    this.buses = [this.low, this.mid, this.col, this.air, this.lead, this.choir, ...this.lift, this.arp, this.star, this.bright];

    const slot = (bus: Bus, kind: PadKind, level: number, attack: number, pan = 0): Slot => ({
      bus,
      kind,
      level,
      held: null,
      want: -1,
      stagger: 0,
      attack,
      pan,
    });
    // bass, bass an octave up (for small speakers), four strings, two of the
    // land's colour, one voice of air
    this.slots = [
      slot(this.low, 'deep', 0.85, 1.3),
      slot(this.low, 'strings', 0.6, 1.6),
      slot(this.mid, 'strings', 0.62, 1.5, -0.35),
      slot(this.mid, 'strings', 0.56, 1.7, 0.3),
      slot(this.mid, 'strings', 0.6, 1.6, -0.15),
      slot(this.mid, 'strings', 0.7, 1.4, 0.2),
      slot(this.col, 'glass', 0.6, 1.8, -0.4),
      slot(this.col, 'glass', 0.75, 1.5, 0.4),
      slot(this.air, 'choir', 0.8, 2.2),
    ];
    for (let i = 0; i < 8; i++) this.company.push(slot(this.choir, 'choir', 0.5, 1.5 + 0.15 * i, (i % 2 ? 1 : -1) * (0.25 + 0.08 * i)));
    for (let i = 0; i < 3; i++) this.rising.push(slot(this.lift[i], 'strings', 0.7, 1.2, [0, -0.4, 0.4][i]));

    this.echo();
  }

  /** Two far-off repeats, dark enough to be taken for the hills. */
  private echo(): void {
    const c = this.ctx;
    const tap = c.createGain();
    tap.gain.value = 0.26;
    const lp = c.createBiquadFilter();
    for (const n of [tap, lp]) {
      n.channelCount = 1;
      n.channelCountMode = 'explicit';
    }
    lp.type = 'lowpass';
    lp.frequency.value = 1500;
    lp.Q.value = 0.3;
    this.lead.out.connect(tap);
    tap.connect(lp);
    const a = c.createDelay(2);
    const b = c.createDelay(2);
    a.delayTime.value = 0.69;
    b.delayTime.value = 1.13;
    const fb = c.createGain();
    fb.gain.value = 0.28;
    const merge = c.createChannelMerger(2);
    lp.connect(a);
    a.connect(b);
    b.connect(fb);
    fb.connect(a);
    a.connect(merge, 0, 0);
    b.connect(merge, 0, 1);
    merge.connect(this.mix.music);
    merge.connect(this.mix.musicSend);
  }

  // ------------------------------------------------------------- the land
  get root(): number {
    return this.mus.root;
  }

  setLand(id: LandId, m: LandMusic): void {
    const now = this.ctx.currentTime;
    const first = this.land === null;
    if (this.land === id && this.mus.root === m.root && this.mus.color === m.color) {
      this.mus = m;
      return;
    }
    this.land = id;
    this.mus = m;
    this.har = HARMONY[id];
    this.pal = PALETTE[m.color];
    this.melody = ladder(m.root, m.scale, m.root + this.har.base - 3, m.root + this.har.base + 22).filter((x) => x >= 57 && x <= 86);
    this.sparkle = ladder(m.root, m.scale, 74, 98);
    this.at = Math.floor(this.melody.length * 0.4);
    this.chord = -1;
    this.leap = -1;
    this.count = 0;
    this.mask = 0;

    for (const s of [...this.slots, ...this.company, ...this.rising]) this.let(s, now, 2.4);
    this.slots[6].kind = this.slots[7].kind = this.pal.col;
    this.slots[8].kind = this.pal.air;
    this.nextChord = now + (first ? 0.35 : 4.2);
    this.nextNote = this.nextChord + 5;
    this.phraseOf = 0;
    this.quoting = false;
    this.due.length = 0;

    this.prepare();
  }

  /** Ask for every instrument this land will need, soonest first. */
  private prepare(): void {
    const { bank, har, mus, pal } = this;
    const r = mus.root;
    const pads = new Set<PadKind>(['strings', 'deep', 'choir', pal.col, pal.air]);
    const notes = new Set<NoteKind>(['harp', 'glass', 'felt', 'bell', pal.lead, pal.second, pal.arp]);
    if (har.home) notes.add('horn');
    bank.retain(pads, notes);
    har.chords.forEach((c, i) => {
      const need = i < 2 ? NOW : LATER;
      bank.wantPad('deep', r + c.b, need);
      bank.wantPad('strings', r + c.b + 12, need);
      for (const v of c.v) bank.wantPad('strings', r + v, need);
    });
    const tune = har.motif.flat().map((x) => r + har.base + x);
    for (const m of tune) bank.wantPad(pal.col, m, SOON);
    for (const m of tune) bank.wantNote(pal.lead, m, SOON);
    for (const m of tune) bank.wantNote('harp', m, SOON);
    for (const c of har.chords) {
      bank.wantPad(pal.col, r + c.v[1], LATER);
      bank.wantPad(pal.col, r + c.v[3], LATER);
      bank.wantPad(pal.air, r + c.a, LATER);
    }
    bank.wantNotes(pal.lead, 58, 86, LATER);
    bank.wantNotes('felt', 46, 78, LATER);
    bank.wantNotes('glass', 66, 94, LATER);
    bank.wantNotes(pal.second, 46, 80, LATER);
    for (const c of har.chords) for (const v of c.v) bank.wantPad('choir', this.sung(r + v), EVENTUALLY);
    for (let m = 64; m < 84; m += 3) bank.wantPad('strings', m, EVENTUALLY);
    bank.wantNotes('harp', 46, 86, EVENTUALLY);
    bank.wantNotes('bell', 74, 96, EVENTUALLY);
    if (har.home) bank.wantNotes('horn', 58, 80, EVENTUALLY);
  }

  setScene(s: Scene): void {
    if (s === this.scene) return;
    this.scene = s;
    const now = this.ctx.currentTime;
    if (MOODS[s].lull && this.nextNote > now + 6) this.nextNote = now + 3;
    // arriving: go straight to the last turn of the road, so that the very next
    // thing the harmony does is come home
    if (s === 'finale' && this.har.home && this.chord >= 0) {
      this.leap = this.har.quote[0][0];
      this.quoting = false;
      this.due.length = 0;
      this.nextChord = Math.min(this.nextChord, now + 2.5);
    }
  }

  // ------------------------------------------------------------ voices
  private let(s: Slot, at: number, tau: number): void {
    s.held?.release(at, tau);
    s.held = null;
    s.want = -1;
  }

  /** Bring a slot to a pitch: hold through common tones, cross-bow otherwise. */
  private move(s: Slot, midi: number, at: number, len: number): void {
    const t = at + s.stagger;
    const rest = s.level * REST;
    if (s.held && s.held.midi === midi) {
      s.want = midi;
      s.held.bow(s.level, t + 0.2, 2.2);
      s.held.bow(rest, t + len * 0.5, len * 0.2);
      return;
    }
    s.held?.release(t + 0.25, 1.5);
    s.held = null;
    s.want = midi;
    this.begin(s, t, len);
  }

  private begin(s: Slot, t: number, len: number): void {
    const z = this.bank.pad(s.kind, s.want);
    if (!z) return; // still being grown; asked for again shortly
    s.held = new Held(this.ctx, z, s.bus.in, s.want, t, s.level, s.attack, this.rng(), semis(spread(this.rng, 0.035)), s.pan);
    s.held.bow(s.level * REST, t + len * 0.5, len * 0.2);
  }

  private turn(at: number): void {
    const n = this.har.chords.length;
    const lull = this.mood.slow > 1.2 || this.e.ground > 0.6;
    if (this.leap >= 0) this.chord = this.leap;
    else if (lull) this.chord = this.chord === this.har.lull[0] ? this.har.lull[1] : this.har.lull[0];
    else this.chord = (this.chord + 1) % n;
    this.leap = -1;
    this.count++;
    const c = this.har.chords[this.chord];
    const r = this.mus.root;
    this.mask = maskOf(r, c);
    this.chordAt = at;
    this.chordLen = ((this.har.bar / this.mus.pace) * this.mood.slow * lerp(1, 1.2, this.e.ground)) * (1 + spread(this.rng, 0.04));
    this.nextChord = at + this.chordLen;

    const notes = [r + c.b, r + c.b + 12, r + c.v[0], r + c.v[1], r + c.v[2], r + c.v[3], r + c.v[1], r + c.v[3], r + c.a];
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      s.stagger = i < 2 ? 0 : 0.15 + this.rng() * 1.1;
      this.move(s, notes[i], at, this.chordLen);
    }
    this.gather(at);
    for (let i = 0; i < this.rising.length; i++) {
      const s = this.rising[i];
      if (s.held || this.e.lift > 0.03) {
        s.stagger = 0.1 * i;
        this.move(s, this.rung(i), at, this.chordLen);
      }
    }

    this.remember(at);
    if (this.count > 1 && this.mood.mid > 0.1 && (lull || this.scene === 'finale' || this.rng() < 0.72)) this.roll(at, c, lull);
  }

  /** Companions take chord tones, each entering a little after the last. */
  private gather(at: number): void {
    const c = this.har.chords[this.chord];
    if (!c) return;
    const r = this.mus.root;
    const n = Math.round(clamp(this.e.comp, 0, 8));
    const pool = [c.v[2], c.v[0], c.v[3], c.v[1], c.v[2] + 12, c.v[0], c.a, c.v[3]];
    for (let i = 0; i < 8; i++) {
      const s = this.company[i];
      this.stirAt[i] = Infinity;
      if (i < n) {
        s.stagger = 0.5 + i * 0.42;
        s.level = 0.5 - 0.02 * i;
        this.move(s, this.sung(r + pool[i]), at, this.chordLen);
        // and, partway through, some of them step to a neighbour
        if (i % 2 === 0) this.stirAt[i] = at + this.chordLen * (0.42 + 0.06 * i);
      } else if (s.held || s.want >= 0) this.let(s, at + 0.2, 2);
    }
  }

  /** The i-th rung of the rising layer: chord tones stacked up from the treble. */
  private rung(i: number): number {
    const top = 64 + i * 5.5;
    for (let m = Math.ceil(top); m < top + 12; m++) if (this.mask & (1 << (m % 12))) return m;
    return Math.ceil(top);
  }

  private sung = (m: number): number => (m > 78 ? m - 12 : m < 55 ? m + 12 : m);

  private stir(i: number, now: number): void {
    const s = this.company[i];
    if (!s.held) return;
    const c = this.har.chords[this.chord];
    const r = this.mus.root;
    let best = s.held.midi;
    let bd = 99;
    for (const v of c.v)
      for (const o of [-12, 0, 12]) {
        const m = r + v + o;
        const d = Math.abs(m - s.held.midi);
        if (d > 0 && d < bd && m >= 55 && m <= 79) {
          bd = d;
          best = m;
        }
      }
    s.stagger = 0;
    if (bd <= 7) this.move(s, best, now + 0.05, Math.max(3, this.nextChord - now));
  }

  /** The chord laid out by hand, once, low to high, as it arrives. */
  private roll(at: number, c: Chord, lull: boolean): void {
    const { rng } = this;
    const r = this.mus.root;
    const inst = lull ? 'felt' : this.pal.roll;
    const grand = this.scene === 'finale';
    const notes = [c.b + (r + c.b < 43 ? 12 : 0), c.v[0], c.v[1], c.v[2], c.v[3], c.a];
    const n = lull ? 3 : grand ? 6 : 3 + Math.floor(rng() * 3);
    const gap = (lull ? 0.42 : grand ? 0.2 : 0.26) * (1 + spread(rng, 0.15));
    let t = at + 0.35 + rng() * 0.3;
    for (let i = 0; i < n; i++) {
      const m = r + notes[lull ? [0, 2, 4][i] : i];
      this.strike(inst, m, this.lead, t, (i === 0 ? 0.26 : 0.2 - 0.012 * i) * (grand ? 1.25 : 1), -0.35 + 0.15 * i, true);
      t += gap * (1 + 0.12 * i);
    }
  }

  /**
   * The tune, sung by the land's own colour, as slowly as the chords allow.
   * Each chord that holds part of the plan queues its notes as it begins.
   */
  private remember(at: number): void {
    const plan = this.har.quote;
    if (this.chord === plan[0][0]) this.quoting = this.mood.mid > 0.15 && this.e.dive < 0.4 && !this.mood.lull;
    if (!this.quoting) return;
    for (let i = 0; i < plan.length; i++) {
      if (plan[i][0] !== this.chord) continue;
      const here = at + plan[i][1] * this.chordLen;
      const next = i + 1 < plan.length && plan[i + 1][0] === this.chord ? at + plan[i + 1][1] * this.chordLen : at + this.chordLen;
      const last = i === plan.length - 1;
      this.due.push({ t: here, midi: this.mus.root + this.har.base + this.har.motif[0][i], hold: last ? Math.min(7, this.chordLen * 0.55) : next - here, last, arch: (i + 1) / plan.length });
    }
  }

  /** Play whatever part of the remembered tune has come due. */
  private recall(now: number): void {
    const d = this.due[0];
    if (!d || now + 0.15 < d.t) return;
    this.due.shift();
    const z = this.bank.pad(this.pal.col, d.midi);
    if (z) {
      const level = (LEVEL.quote / LEVEL.col) * (0.8 + 0.2 * Math.sin(Math.PI * d.arch));
      const h = new Held(this.ctx, z, this.col.in, d.midi, d.t, level, 0.42, this.rng(), 1);
      h.release(d.t + (d.last ? d.hold : d.hold * 0.97), d.last ? 1.8 : 0.85);
    }
    // at the end of everything, horns on the far bank know it too
    if (this.scene === 'finale' || (this.har.home && d.last)) this.strike('horn', d.midi > 76 ? d.midi - 12 : d.midi, this.lead, d.t + 0.04, 0.3, 0.25);
    if (this.har.home && d.last) this.swellT = Math.max(this.swellT, 5);
  }

  // -------------------------------------------------------------- notes
  private strike(kind: NoteKind, midi: number, bus: Bus, at: number, vel: number, pan = 0, light = false): void {
    const z = this.bank.note(kind, midi);
    if (!z) return;
    this.player.shot(z.buf, bus.in, at, vel, { rate: z.rate * semis(spread(this.rng, 0.02)), pan, light });
  }

  private sing(now: number): void {
    if (now + 0.12 < this.nextNote || !this.mask || this.melody.length < 4) return;
    if (this.due.length) {
      // the pads have the tune: leave it to them
      this.nextNote = Math.max(this.nextNote, this.due[this.due.length - 1].t + 2.4);
      return;
    }
    const t = Math.max(now + 0.02, this.nextNote);
    const { rng, e, mood } = this;
    const lull = mood.lull || e.ground > 0.6;
    // spacing: the speed readout
    const k = Math.pow(clamp((e.speed - 9) / 40), 0.75);
    const base = lull ? 1.75 : lerp(2.55, 0.92, k);
    const step = (base / this.mus.pace) * lerp(mood.space, 1, lull ? 0.35 : 0) * lerp(1, 1.5, e.night * 0.6) * lerp(1, 1.25, e.cloud);

    if (this.cellI >= this.cell.length) {
      // a new phrase
      this.cellI = 0;
      this.cell = CELLS[Math.floor(rng() * CELLS.length)];
      const p = lull ? 0.62 : this.scene === 'title' ? 0.6 : this.scene === 'finale' ? 0.4 : 0.2;
      this.phraseOf = rng() < p ? this.har.motif[0].length : 0;
      this.motifI = 0;
      this.lastDir = rng() < 0.55 ? 1 : -1;
      // start somewhere that belongs
      const centre = Math.floor(this.melody.length * (0.34 + 0.16 * e.high + 0.1 * rng()));
      let best = centre;
      let bs = -1;
      for (let i = Math.max(0, centre - 4); i <= Math.min(this.melody.length - 1, centre + 4); i++) {
        const s = fit(this.melody[i], this.mask) * (1 - Math.abs(i - centre) * 0.1) + rng() * 0.25;
        if (s > bs) {
          bs = s;
          best = i;
        }
      }
      this.at = best;
    }

    const beats = this.cell[this.cellI];
    const last = this.cellI === this.cell.length - 1;
    let midi: number;
    let gap: number;
    let vel = 0.4 + 0.16 * Math.sin((Math.PI * (this.cellI + 0.6)) / this.cell.length) + spread(rng, 0.06);
    if (this.phraseOf > 0) {
      const p = this.har.motif[0];
      midi = this.settled(this.mus.root + this.har.base + p[this.motifI]);
      gap = step * [1.35, 1.35, 1.35, 1.9, 3][Math.min(4, this.motifI)];
      this.motifI++;
      this.phraseOf--;
      this.cellI = this.phraseOf > 0 ? 0 : this.cell.length;
      if (this.phraseOf === 0) gap = step * 3.4;
      vel = 0.5 + spread(rng, 0.04);
    } else {
      if (this.cellI > 0) this.at = this.stepFrom(this.at, last);
      midi = this.melody[this.at];
      gap = step * beats;
      this.cellI++;
      if (last) vel *= 0.9;
    }
    vel *= lerp(1, 0.75, smooth(74, 88, midi)) * lerp(1, 0.8, e.dive);
    const pan = clamp((midi - 70) / 26, -0.5, 0.5) + spread(rng, 0.12);
    const { lead, second } = this.pal;
    const inst: NoteKind = lull ? 'felt' : this.phraseOf === 0 && rng() < 0.2 ? second : lead;
    this.strike(inst, inst === 'horn' && midi > 71 ? midi - 12 : midi, this.lead, t + spread(rng, 0.02), inst === 'horn' ? vel * 0.7 : vel, pan);

    // sometimes a second hand, underneath
    if (rng() < (lull ? 0.5 : 0.28)) {
      const c = this.har.chords[Math.max(0, this.chord)];
      let under = -1;
      for (const v of c.v) {
        const m = this.mus.root + v;
        if (m < midi - 2 && m > midi - 17 && m >= 50 && (under < 0 || rng() < 0.45)) under = m;
      }
      if (under > 0) this.strike(lull || second === 'horn' ? 'felt' : second, under, this.lead, t + 0.04 + rng() * 0.05, vel * 0.55, -pan, true);
    }
    this.nextNote = t + Math.max(0.28, gap) * (1 + spread(rng, 0.07));
  }

  /** The same note, or its nearest neighbour that does not rub the harmony. */
  private settled(m: number): number {
    if (fit(m, this.mask) > 0.1) return m;
    for (const d of [-1, 1, -2, 2, -3]) if (fit(m + d, this.mask) > 0.9) return m + d;
    return m;
  }

  /** A weighted step along the ladder: near, in the harmony, rarely doubling back. */
  private stepFrom(i: number, ending: boolean): number {
    const { rng, melody } = this;
    const mid = melody.length * 0.42;
    let total = 0;
    let pick = i;
    for (let d = -4; d <= 4; d++) {
      const j = i + d;
      if (j < 0 || j >= melody.length) continue;
      const ad = Math.abs(d);
      let w = ad === 0 ? 0.18 : ad === 1 ? 1 : ad === 2 ? 0.75 : ad === 3 ? 0.28 : 0.16;
      w *= Math.pow(fit(melody[j], this.mask), ending ? 2 : 1);
      if (Math.sign(d) === this.lastDir) w *= 1.5;
      w *= Math.exp(-Math.pow((j - mid) / (melody.length * 0.36), 2));
      total += w;
      if (rng() * total < w) pick = j;
    }
    if (pick !== i) this.lastDir = rng() < 0.72 ? Math.sign(pick - i) : -Math.sign(pick - i);
    return pick;
  }

  /** Rising air, by ear: short upward runs; higher and brighter as you climb. */
  private rise(now: number): void {
    const { e, rng } = this;
    if (e.lift < 0.06 || !this.mask || now + 0.1 < this.nextArp) return;
    const t = Math.max(now + 0.02, this.nextArp);
    const up = clamp(e.climb / 6);
    const s = this.sparkle;
    if (this.arpLeft <= 0) {
      this.arpLeft = 4 + Math.floor(rng() * 3 + up * 2);
      // where the run begins follows the climb
      this.arpI = Math.floor(lerp(0, s.length * 0.42, up) + rng() * 1.5);
    }
    // climb the chord: skip what does not belong
    let guard = 0;
    while (this.arpI < s.length - 1 && fit(s[this.arpI], this.mask) < 0.9 && guard++ < 6) this.arpI++;
    const m = s[Math.min(this.arpI, s.length - 1)];
    const total = 6;
    const k = 1 - this.arpLeft / total;
    const vel = (0.13 + 0.11 * e.lift) * (0.75 + 0.35 * Math.sin(Math.PI * clamp(k, 0.05, 0.95))) * lerp(1, 0.75, smooth(84, 96, m));
    this.strike(this.pal.arp, m, this.arp, t, vel, spread(rng, 0.65), true);
    this.arpI++;
    this.arpLeft = this.arpI >= s.length ? 0 : this.arpLeft - 1;
    const gap = lerp(0.62, 0.34, up) * (1 + spread(rng, 0.08));
    this.nextArp = t + (this.arpLeft > 0 ? gap : gap * (3.2 - 1.2 * up));
  }

  private starlight(now: number): void {
    const { e, rng, mood } = this;
    const amt = mood.stars * Math.max(this.scene === 'night' ? 0.9 : 0, e.night * 0.8, this.scene === 'title' ? 0.4 : 0);
    if (now < this.nextStar) return;
    this.nextStar = now + lerp(7, 3.2, clamp(amt)) * (0.6 + 0.8 * rng());
    if (amt < 0.05 || !this.sparkle.length) return;
    const s = this.sparkle;
    const i = Math.floor(s.length * (0.35 + 0.65 * rng()));
    const m = s[Math.min(s.length - 1, i)];
    if (fit(m, this.mask) < 0.3) return;
    const pan = spread(rng, 0.8);
    this.strike(rng() < 0.5 ? 'bell' : 'glass', m, this.star, now + 0.05, 0.16 * (0.6 + 0.4 * rng()), pan, true);
    if (rng() < 0.3) this.strike('glass', s[Math.max(0, i - 2)], this.star, now + 0.55 + rng() * 0.5, 0.1, -pan, true);
  }

  // ------------------------------------------------------------- moments
  /** The note of HOME that the n-th feather is. */
  private motifNote(n: number): number {
    const m = this.har.motif;
    let k = n;
    let total = 0;
    for (const p of m) total += p.length;
    k = ((k % total) + total) % total;
    for (const p of m) {
      if (k < p.length) return this.mus.root + this.har.base + p[k];
      k -= p.length;
    }
    return this.mus.root + this.har.base;
  }

  feather(index: number): void {
    const t = this.ctx.currentTime + 0.01;
    const m = this.motifNote(index);
    const pan = spread(this.rng, 0.15);
    this.strike('harp', m, this.bright, t, 0.62, pan);
    this.strike('glass', m + 12, this.bright, t + 0.02, 0.2, -pan);
    this.strike('glass', m + 19, this.bright, t + 0.16, 0.07, pan * 2, true);
    this.strike('glass', m + 24, this.bright, t + 0.29, 0.06, -pan * 2, true);
    // the tune's end is gently underlined
    const p = this.har.motif[0].length;
    if ((index + 1) % p === 0) {
      this.swellT = Math.max(this.swellT, 1.2);
      this.strike('felt', m - 12, this.bright, t + 0.03, 0.22, 0, true);
    }
  }

  discover(): void {
    const t = this.ctx.currentTime + 0.05;
    const p = this.har.motif[0];
    let at = t;
    p.forEach((x, i) => {
      const m = this.mus.root + this.har.base + x;
      const pan = -0.3 + 0.2 * i;
      this.strike('harp', m, this.bright, at, 0.46, pan);
      this.strike('glass', m + 12, this.bright, at + 0.03, 0.16, -pan);
      if (i === 0) this.strike('felt', m - 12, this.bright, at + 0.02, 0.3, 0);
      if (i === p.length - 1) this.strike('bell', m + 12, this.bright, at + 0.12, 0.12, 0);
      at += 0.62 + 0.07 * i;
    });
    this.swellT = Math.max(this.swellT, 4);
  }

  welcome(n: number): void {
    const t = this.ctx.currentTime + 0.1;
    const c = this.har.chords[Math.max(0, this.chord)];
    const r = this.mus.root;
    const up = [c.v[0], c.v[1], c.v[2], c.v[3], c.v[1] + 12];
    const k = Math.min(up.length, 3 + (n > 3 ? 1 : 0) + (n > 6 ? 1 : 0));
    for (let i = 0; i < k; i++) {
      this.strike('harp', r + up[i], this.bright, t + i * 0.17, 0.32 + 0.03 * i, -0.3 + 0.2 * i);
      this.strike('felt', r + up[i], this.bright, t + i * 0.17 + 0.02, 0.18, 0.1);
    }
    this.strike('glass', r + c.a, this.bright, t + k * 0.17 + 0.1, 0.18, 0.2);
    this.swellT = Math.max(this.swellT, 3);
  }

  ui(kind: 'move' | 'select' | 'back'): void {
    const t = this.ctx.currentTime + 0.005;
    const b = this.mus.root + this.har.base;
    if (kind === 'move') this.strike('felt', b + 12, this.bright, t, 0.07, 0, true);
    else if (kind === 'select') {
      this.strike('harp', b + 7, this.bright, t, 0.16);
      this.strike('harp', b + 12, this.bright, t + 0.11, 0.17);
    } else this.strike('harp', b, this.bright, t, 0.13);
  }

  /** A warmth that comes and goes by itself (answers, arrivals). */
  swell(seconds: number): void {
    this.swellT = Math.max(this.swellT, seconds);
  }

  /** The nearest sung pitch (Hz) to f in the land's root, third-less and open. */
  tune(f: number): number {
    const r = this.mus.root;
    let best = f;
    let bd = 1e9;
    for (let o = 0; o <= 60; o += 12)
      for (const x of [0, 7]) {
        const h = 440 * Math.pow(2, (r + x + o - 69) / 12);
        const d = Math.abs(Math.log(h / f));
        if (d < bd) {
          bd = d;
          best = h;
        }
      }
    return best;
  }

  // -------------------------------------------------------------- update
  update(f: AudioFrame, now: number, dt: number): void {
    const { e, mood } = this;
    this.clock += dt;
    const target = MOODS[this.scene];
    const km = 1 - Math.exp(-dt / 2.2);
    for (const k of MOOD_KEYS) mood[k] += (target[k] - mood[k]) * km;
    mood.lull = target.lull;

    const grounded = f.mode === 'ground' ? 1 : 0;
    e.speed = ease(e.speed, f.airspeed, 1.4, dt);
    e.high = ease(e.high, smooth(25, 420, f.agl), 4, dt);
    const rising = grounded ? 0 : clamp((f.lift - 0.35) / 4.2);
    e.lift = ease(e.lift, rising, rising > e.lift ? 1.1 : 2.4, dt);
    e.climb = ease(e.climb, Math.max(0, f.climb), 0.9, dt);
    e.dive = ease(e.dive, smooth(-3, -13, f.climb) * smooth(22, 40, f.airspeed), 1.6, dt);
    e.ground = ease(e.ground, grounded, grounded ? 3.5 : 2.2, dt);
    e.cloud = ease(e.cloud, clamp(f.inCloud), 1.3, dt);
    e.night = ease(e.night, clamp(f.night), 4, dt);
    e.prog = ease(e.prog, clamp(f.progress), 5, dt);
    e.storm = ease(e.storm, clamp(f.storm), 5, dt);
    e.comp = ease(e.comp, clamp(f.companions, 0, 8), 0.8, dt);

    this.swellT = Math.max(0, this.swellT - dt);
    const warm = smooth(0, 2.5, this.swellT);

    // --- harmony
    if (now + 0.25 >= this.nextChord && this.land) this.turn(Math.max(now + 0.05, this.nextChord));
    if (now > this.retryAt && this.chord >= 0) {
      this.retryAt = now + 0.4;
      const left = Math.max(2.5, this.nextChord - now);
      for (const s of this.slots) if (!s.held && s.want >= 0) this.begin(s, now + 0.05, left);
      for (const s of this.company) if (!s.held && s.want >= 0) this.begin(s, now + 0.05, left);
      // a companion joining mid-chord is heard straight away
      const n = Math.round(clamp(e.comp, 0, 8));
      for (let i = 0; i < 8; i++) {
        const on = this.company[i].want >= 0;
        if (on !== i < n) {
          this.gather(now);
          break;
        }
      }
      // the rising layer wakes when the air does
      for (let i = 0; i < 3; i++) {
        const s = this.rising[i];
        if (e.lift > 0.03 && !s.held) {
          s.stagger = 0;
          this.move(s, this.rung(i), now + 0.02, left);
        } else if (e.lift < 0.004 && s.held) this.let(s, now, 1.5);
      }
    }
    for (let i = 0; i < 8; i++)
      if (now > this.stirAt[i]) {
        this.stirAt[i] = Infinity;
        this.stir(i, now);
      }

    this.recall(now);
    this.sing(now);
    this.rise(now);
    this.starlight(now);

    // --- the layers
    const trim = this.pal.trim;
    const thin = 1 - 0.55 * e.dive;
    // the whole body of sound leans in and eases off once per chord
    const through = clamp((now - this.chordAt) / Math.max(4, this.chordLen));
    const arch = 0.64 + 0.36 * Math.sin(Math.PI * Math.pow(through, 0.72));
    const bloom = Math.exp(-Math.max(0, now - this.chordAt - 0.5) / 4.5);
    const breath = 0.5 + 0.5 * Math.sin(this.clock * 0.37) * Math.sin(this.clock * 0.113 + 1);
    const g = e.ground;
    const lull = mood.lull ? 1 : 0;
    const nightDim = 1 - 0.22 * e.night;
    const hush = 1 - 0.25 * e.cloud;
    this.low.gain.to(LEVEL.low * trim * mood.low * thin * (1 - 0.5 * e.high) * (1 - 0.4 * g), dt);
    this.mid.gain.to(LEVEL.mid * trim * mood.mid * arch * thin * hush * (1 - 0.4 * g) * (0.9 + 0.18 * warm) * nightDim, dt);
    this.col.gain.to(LEVEL.col * trim * mood.col * (0.5 + 0.5 * arch) * thin * (0.7 + 0.3 * e.prog + 0.35 * warm) * (1 - 0.45 * g) * lerp(0.9, 1.05, breath), dt);
    this.air.gain.to(LEVEL.air * trim * mood.air * (0.45 + 0.75 * e.high + 0.3 * warm) * (1 - 0.35 * e.dive) * (1 - 0.6 * g), dt);
    this.lead.gain.to(LEVEL.lead * mood.lead * (1 - 0.3 * e.cloud) * (1 - 0.3 * g * (1 - lull)), dt);
    this.choir.gain.to(LEVEL.choir * trim * mood.choir * (1 - 0.4 * e.dive) * (1 - 0.35 * g) * (1 + 0.25 * warm), dt);
    const up = clamp(e.climb / 6);
    const warmth = LEVEL.lift * smooth(0, 0.75, e.lift) * Math.min(1, mood.mid);
    this.lift[0].gain.to(warmth * (0.75 + 0.25 * up), dt, 0.9);
    this.lift[1].gain.to(warmth * smooth(0.12, 0.5, up), dt, 0.9);
    this.lift[2].gain.to(warmth * 0.9 * smooth(0.4, 0.85, up), dt, 0.9);
    this.arp.gain.to(LEVEL.arp * smooth(0.05, 0.6, e.lift) * Math.min(1, mood.lead), dt, 0.9);
    this.star.gain.to(LEVEL.star * Math.min(1, mood.stars), dt);

    const tone = this.pal.tone * lerp(1, 0.72, e.night) * lerp(1, 1.35, e.high) * lerp(0.88, 1.12, e.prog) * lerp(1, 0.75, e.storm) * (1 + 0.25 * e.lift) * lerp(1, 0.7, g);
    this.low.cut.to(lerp(620, 900, e.prog), dt);
    this.mid.cut.to(tone * (0.8 + 0.45 * bloom + 0.18 * breath), dt, 1.2);
    this.col.cut.to(tone * (1.35 + 0.5 * bloom) + 400 * warm, dt, 1.2);
    this.air.cut.to(tone * 1.9, dt);
    this.lead.cut.to(lerp(3000, 5200, e.high) * lerp(1, 0.7, e.night) * lerp(1, 0.75, g), dt);
    this.choir.cut.to(tone * 1.5, dt);
    for (const b of this.lift) b.cut.to(lerp(800, 2600, up), dt, 0.9);
    this.arp.cut.to(lerp(2200, 5200, up), dt, 0.9);

    const far = 0.75 + 0.5 * e.high + 0.3 * e.cloud + 0.2 * e.night;
    this.mid.send.to(0.4 * far, dt);
    this.col.send.to(0.5 * far, dt);
    this.air.send.to(0.7 * far, dt);
    this.lead.send.to(0.6 * far, dt);

    this.mix.musicLow.to(-5 * e.high - 2 * e.dive, dt);
    this.mix.musicVeil.to(lerp(9000, 1250, e.cloud * e.cloud * (3 - 2 * e.cloud)), dt);
    this.mix.wet.to(0.3 * (0.85 + 0.3 * e.high + 0.25 * e.cloud + 0.15 * g), dt);
  }

  push(now: number): void {
    for (const b of this.buses) b.push(now);
  }
}
