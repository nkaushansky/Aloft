/**
 * What Aloft sings. Six lands, six slow harmonies, and one tune.
 *
 * The tune — HOME — is the crane's own call written large: a step out into
 * open air (1 → 5), a reach (→ 3'), and a sigh that hangs (→ 2'). In five lands
 * it never lands. In Wintering it does: 1 5 3' 2' 1'.
 *
 * Chords are hand-voiced (bass, four inner voices, one "air" voice) so that
 * every change is one or two voices moving by step while the rest hold.
 */
import type { LandId } from '../world/lands';

export interface LandMusic {
  root: number;
  scale: number[];
  pace: number;
  color: 'glass' | 'wood' | 'bell' | 'brass' | 'deep' | 'choir';
}

export interface Chord {
  /** bass, in semitones from the land's root */
  b: number;
  /** four inner voices, low to high */
  v: [number, number, number, number];
  /** the air voice */
  a: number;
}

export interface Harmony {
  chords: Chord[];
  /** seconds per chord at pace 1 */
  bar: number;
  /** chords the land rests between when it sleeps */
  lull: [number, number];
  /** HOME, as phrases of semitones above the motif's base note */
  motif: number[][];
  /** the tune's first note, in semitones from root */
  base: number;
  /** whether the tune may finally come to rest */
  home: boolean;
  /**
   * Where the pads remember HOME: [chord, how far through it], one per note,
   * placed so that every note belongs to the chord beneath it.
   */
  quote: [number, number][];
}

/** rows of [bass, v0, v1, v2, v3, air] in MIDI, about a nominal root */
function voiced(root: number, rows: number[][]): Chord[] {
  return rows.map((r) => ({
    b: r[0] - root,
    v: [r[1] - root, r[2] - root, r[3] - root, r[4] - root],
    a: r[5] - root,
  }));
}

export const HARMONY: Record<LandId, Harmony> = {
  // I — D, no third is ever pressed and no leading tone exists yet: open water
  stillmere: {
    bar: 12,
    lull: [0, 2],
    base: 12,
    home: false,
    quote: [[0, 0.16], [0, 0.36], [0, 0.56], [0, 0.78]],
    motif: [
      [0, 7, 16, 14],
      [9, 16, 14, 7],
    ],
    chords: voiced(50, [
      [38, 57, 62, 66, 69, 76], // D add9
      [47, 57, 62, 66, 71, 78], // Bm7
      [43, 59, 62, 66, 69, 74], // Gmaj9
      [45, 57, 62, 64, 71, 76], // Asus
      [42, 57, 62, 64, 69, 78], // D/F#
      [40, 55, 62, 66, 71, 74], // Em9
      [43, 55, 59, 62, 69, 74], // G add9
      [45, 57, 62, 64, 69, 76], // Asus, waiting
    ]),
  },
  // II — A minor, leaves coming down by thirds
  copper: {
    bar: 12,
    lull: [0, 1],
    base: 12,
    home: false,
    quote: [[0, 0.16], [0, 0.36], [0, 0.56], [0, 0.78]],
    motif: [
      [0, 7, 15, 14],
      [10, 15, 14, 7],
    ],
    chords: voiced(45, [
      [45, 57, 60, 64, 67, 76], // Am7
      [41, 57, 60, 64, 69, 79], // Fmaj7
      [48, 55, 60, 64, 67, 74], // C add9
      [43, 55, 59, 62, 69, 74], // G add9
      [38, 57, 60, 65, 69, 76], // Dm9
      [45, 57, 60, 64, 71, 76], // Am9
      [41, 57, 60, 64, 67, 72], // Fmaj9
      [40, 55, 59, 62, 67, 74], // Em7
    ]),
  },
  // III — E lydian: the raised fourth is the light off the snow
  stair: {
    bar: 12,
    lull: [0, 3],
    base: 12,
    home: false,
    quote: [[0, 0.16], [0, 0.36], [0, 0.56], [0, 0.78]],
    motif: [
      [0, 7, 16, 14],
      [11, 16, 14, 7],
    ],
    chords: voiced(52, [
      [40, 59, 64, 66, 68, 80], // E add9
      [40, 58, 61, 66, 70, 78], // F#/E
      [44, 59, 63, 66, 71, 75], // G#m7
      [47, 59, 63, 66, 70, 78], // Bmaj7
      [37, 59, 64, 68, 71, 75], // C#m7
      [42, 58, 61, 66, 68, 78], // F# add9
      [44, 59, 63, 66, 70, 80], // G#m9
      [47, 59, 61, 66, 71, 78], // Bsus
    ]),
  },
  // IV — B, with C leaning on it: red stone, hot and then cool
  rooms: {
    bar: 12,
    lull: [0, 3],
    base: 12,
    home: false,
    quote: [[0, 0.18], [0, 0.44], [0, 0.7], [1, 0.04]],
    motif: [
      [0, 7, 16, 13],
      [11, 16, 12, 7],
    ],
    chords: voiced(47, [
      [47, 54, 59, 63, 66, 71], // B
      [48, 55, 60, 64, 67, 76], // C
      [39, 54, 59, 63, 70, 75], // Bmaj7/D#
      [40, 55, 59, 64, 66, 71], // Em add9
      [36, 55, 59, 64, 67, 76], // Cmaj7
      [43, 55, 59, 64, 71, 76], // Em/G
      [40, 54, 59, 64, 66, 71], // E, open
      [47, 54, 59, 64, 66, 71], // Bsus
    ]),
  },
  // V — G, dorian: dark, with the sixth glowing under it
  darkwater: {
    bar: 12,
    lull: [0, 6],
    base: 12,
    home: false,
    quote: [[0, 0.16], [0, 0.36], [0, 0.56], [0, 0.78]],
    motif: [
      [0, 7, 15, 14],
      [9, 14, 12, 7],
    ],
    chords: voiced(43, [
      [43, 58, 62, 65, 67, 74], // Gm7
      [40, 55, 60, 64, 67, 74], // C/E
      [46, 57, 62, 65, 69, 77], // Bbmaj7
      [38, 57, 60, 65, 67, 76], // Dm11
      [45, 55, 60, 64, 67, 76], // Am7
      [46, 58, 62, 65, 69, 74], // Bbmaj7, close
      [48, 55, 62, 64, 69, 74], // C6/9
      [38, 57, 62, 67, 69, 74], // Dsus
    ]),
  },
  // VI — D again, but now the leading tone exists, so there is a way home
  wintering: {
    bar: 12,
    lull: [0, 3],
    base: 12,
    home: true,
    quote: [[6, 0.2], [6, 0.46], [6, 0.72], [7, 0.06], [0, 0.04]],
    motif: [
      [0, 7, 16, 14, 12],
      [9, 16, 14, 7, 12],
    ],
    chords: voiced(50, [
      [38, 57, 62, 66, 69, 76], // D
      [37, 57, 61, 64, 69, 76], // A/C#
      [47, 57, 62, 66, 73, 78], // Bm9
      [43, 59, 62, 66, 69, 78], // Gmaj9
      [42, 57, 62, 66, 69, 74], // D/F#
      [40, 55, 62, 66, 71, 74], // Em9
      [43, 59, 62, 66, 71, 74], // Gmaj7
      [45, 57, 61, 64, 69, 76], // A
    ]),
  },
};

/** Every scale note between two MIDI bounds. */
export function ladder(root: number, scale: number[], lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let m = lo; m <= hi; m++) {
    const pc = (((m - root) % 12) + 12) % 12;
    if (scale.includes(pc)) out.push(m);
  }
  return out;
}

/** 0..1: how settled a pitch sounds over a chord (pitch classes as a bitmask). */
export function fit(m: number, chordMask: number): number {
  const pc = ((m % 12) + 12) % 12;
  if (chordMask & (1 << pc)) return 1;
  const up = chordMask & (1 << ((pc + 1) % 12));
  const dn = chordMask & (1 << ((pc + 11) % 12));
  return up || dn ? 0.06 : 0.42;
}

export function maskOf(root: number, c: Chord): number {
  let m = 0;
  const add = (x: number) => {
    m |= 1 << ((((root + x) % 12) + 12) % 12);
  };
  add(c.b);
  for (const x of c.v) add(x);
  add(c.a);
  return m;
}
