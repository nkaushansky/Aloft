/**
 * The land.
 *
 * Every kind of air in this game is derived from the shape of the ground, so
 * this file is upstream of everything: ridge lift needs long windward faces,
 * mountain wave needs long straight crests standing broadside to the wind,
 * thermals need broad flat sun-baked floors, and convergence lines want
 * valleys and coastlines to run along. A field of round blobs would quietly
 * delete three of the seven air types, so the generator is built around
 * *grain* — the world has a strike, its ranges run along it, and its valleys
 * open between them.
 *
 * The field is infinite, deterministic, and a pure function of cfg.seed. No
 * chunk owns anything; the mesher, the wind, the flock and the camera all ask
 * the same question and get the same answer.
 */

import type { Config } from './config';
import type { TerrainProvider, TerrainSample } from './types';
import { clamp01, lerp, smootherstep, DEG, TAU } from './math';
import { fbm2, ridged2, worley2, hash2, type CellResult } from './noise';

// ====================================================================
// SHAPE CONSTANTS
// Amplitudes and scales live in config; these are the *proportions* that
// make the composition read as land rather than as noise.
// ====================================================================

/**
 * Added to the continental field before it is measured against the waterline.
 * Raising it drains the world, lowering it floods it. 0.14 leaves roughly a
 * third of the map at sea — real coastlines are the best-looking terrain
 * feature you get for free, and the sea-breeze convergence lines need shores.
 */
const LAND_BIAS = 0.14;

/**
 * How much steeper the seabed falls away than the land rises. Deep water is
 * what stops the hill layer from poking a rash of tiny islands through the
 * surface: it keeps the shore a single clean line.
 */
const SEA_DEPTH_GAIN = 2.1;

/**
 * How fast the land climbs away from the shore, as a saturating curve:
 * height = continentAmplitude · (1 − e^(−cont · CONT_RISE)). The land has to
 * outrun the hill layer or the hills simply dig it back under the sea and the
 * map turns to swamp — at 3.1 the interior is clear of the water by the time
 * the hills reach full strength. Raise it and coasts get abrupt.
 */
const CONT_RISE = 3.1;

/**
 * Width of the coastal ramp in continental-noise units — about 3 km. Hills,
 * mountains and detail all fade in across it, so the sea floor stays smooth,
 * the beach arrives before the terrain does, and there is somewhere flat and
 * low to scratch along when a crossing goes badly.
 */
const COAST_BLEND = 0.22;

/**
 * Domain warp on the continental field. Zero gives round, soapy islands; this
 * is the number that makes bays, spits, headlands and inlets. Convergence
 * lines trace the shore, so coastline shape is a gameplay input.
 */
const CONT_WARP = 0.34;
/** Frequency of that warp relative to the continent. Lower = lazier shapes. */
const CONT_WARP_FREQ = 0.55;

/**
 * Massif falloff in worley cell units. Inside MASSIF_CORE the massif is at
 * full height; past MASSIF_EDGE there is none of it. EDGE above ~0.5 lets
 * neighbouring massifs meet along their shared cell boundary, which is what
 * turns a field of lumps into a connected RANGE with cols and passes between
 * the summits. Drop it below 0.5 and the mountains become polka dots.
 */
const MASSIF_CORE = 0.22;
const MASSIF_EDGE = 0.74;

/**
 * Share of a massif's height that comes from its smooth dome rather than from
 * the ridged crests riding on it. The dome is what gives a range long,
 * unbroken flanks for ridge lift to work along; too much of it and the
 * mountains go bald and roundshouldered.
 */
const MASSIF_DOME = 0.26;

/**
 * How far the along-crest axis of the ridged lookup is squashed. 0.24 makes
 * crests about four times longer than they are wide. THIS is the number that
 * makes mountain wave possible — wave needs a straight crest line kilometres
 * long to organise the air behind it, and wave is the only lift left at
 * night. Raise it toward 1 and the ranges break into knobs and the endgame
 * quietly disappears.
 */
const CREST_ANISOTROPY = 0.24;

/**
 * Warp applied to the ridged lookup. The across-grain term is the one that
 * bends crests into curving, branching ranges instead of corduroy; the
 * along-grain term stops every crest being the same crest end to end.
 */
const CREST_WARP_ACROSS = 0.4;
const CREST_WARP_ALONG = 0.12;
/** Warp frequency: ~1.8 cells, so each massif gets its own visible strike. */
const CREST_WARP_FREQ = 0.55;

/** How far the world's grain may swing off square-to-the-wind (radians, ±38°). */
const GRAIN_JITTER = 0.66;

/** Scale of the orogenic belt field, as a multiple of mountainScale. Big, so
 *  ranges arrive in belts with honest plains between them. */
const UPLIFT_SCALE = 3.4;
/** Width of the belt's edge in noise units — wide enough to grow foothills. */
const UPLIFT_BAND = 0.24;
/** Belt threshold at coverage 0 and at coverage 1. mountainCoverage slides
 *  between them: higher coverage, lower bar, more mountain. At the shipped
 *  0.46 this puts about half the land in some kind of upland and a fifth of
 *  it under full-height ranges. */
const UPLIFT_HI = 0.38;
const UPLIFT_LO = -0.36;

/** How hard a massif suppresses the hill layer under it. Mountains should
 *  read as rock and crest, not as hill country wearing a mountain hat. */
const MASSIF_HILL_SUPPRESS = 0.7;

/**
 * EROSION. Ground slope (m/m) at which fine relief is fully preserved. Below
 * it the land is treated as somewhere sediment settles and is progressively
 * flattened toward its own low-frequency shape; above it, bare and jagged.
 */
const EROSION_SLOPE_REF = 0.24;
/**
 * How much of the fine relief survives on dead-flat ground. Low numbers give
 * genuinely flat valley floors and plains — which is what thermals need to
 * bake over, what mist needs to pool in, and what a tired bird needs to land
 * on. Raise it and the whole world turns to gravel.
 */
const EROSION_FLOOR = 0.16;
/** How strongly a mountain crest counts as "steep" for the rule above, even
 *  where the large-scale slope is mild. Keeps summit ridges sharp. */
const EROSION_CREST_GAIN = 2.3;

/**
 * Central-difference step (m) for the surface normal. Small enough to catch a
 * ridge crest, large enough that the 190 m detail layer doesn't make the
 * normal chatter as the bird slides over it.
 */
const NORMAL_STEP = 6;

// -------------------------------------------------------------- memo cache

/** 16384 two-way slots, ~210 KB of typed arrays. Sized so the few thousand
 *  points the wind field, the flock and the camera re-ask about every frame
 *  all stay resident; a streaming chunk build blows straight through it, which
 *  is fine, because a chunk is built once. */
const MEMO_BITS = 14;
const MEMO_SIZE = 1 << MEMO_BITS;
const MEMO_MASK = MEMO_SIZE - 1;
/**
 * Query positions snap to this grid (m) before they are cached, so two
 * callers asking about "the same" point get byte-identical answers and LOD
 * seams cannot crack. 1/8 m displaces the sample by at most 6 cm — a few
 * centimetres of height error on a cliff, invisible from the air.
 */
const MEMO_STEP = 0.125;
const MEMO_INV_STEP = 1 / MEMO_STEP;

// ------------------------------------------------------------- ring tables

/** Points on a unit circle, precomputed once. Used by the roughness probe and
 *  by the launch search — both of which sample rings, neither of which should
 *  be calling Math.cos in a loop. */
const RING_N = 8;
const RING_COS = new Float64Array(RING_N);
const RING_SIN = new Float64Array(RING_N);
for (let i = 0; i < RING_N; i++) {
  const a = (i / RING_N) * TAU;
  RING_COS[i] = Math.cos(a);
  RING_SIN[i] = Math.sin(a);
}

// ==================================================================== NOISE
// A derivative-carrying value noise. We need the *slope* of the hill layer to
// decide where sediment settles, and central-differencing the whole terrain
// stack to get it would cost five times as much as generating it once.

interface NoiseGrad {
  v: number;
  dx: number;
  dz: number;
}

/** Same lattice, same quintic fade, same output as noise.ts's valueNoise2 —
 *  plus the analytic gradient with respect to the input coordinates. */
function vnoiseD(x: number, z: number, seed: number, out: NoiseGrad): void {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const tx = x - ix;
  const tz = z - iz;
  const fx = tx * tx * tx * (tx * (tx * 6 - 15) + 10);
  const fz = tz * tz * tz * (tz * (tz * 6 - 15) + 10);
  // d/dt of the quintic fade: 30 t² (t-1)²
  const dfx = 30 * tx * tx * (tx * (tx - 2) + 1);
  const dfz = 30 * tz * tz * (tz * (tz - 2) + 1);
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  const k1 = b - a;
  const k2 = c - a;
  const k3 = a - b - c + d;
  out.v = a + k1 * fx + k2 * fz + k3 * fx * fz;
  out.dx = (k1 + k3 * fz) * dfx;
  out.dz = (k2 + k3 * fx) * dfz;
}

interface HillField {
  /** Full-detail value, [-1,1] — identical to fbm2 at the same octave count. */
  v: number;
  /** The same field with only its slow octaves: what a flooded, silted-up
   *  version of this ground would look like. */
  vLow: number;
  dx: number;
  dz: number;
}

const HILL_OCTAVES = 4;
/** How many octaves survive in the "settled" version blended toward on flats. */
const HILL_LOW_OCTAVES = 2;

const noiseGradScratch: NoiseGrad = { v: 0, dx: 0, dz: 0 };

/** fbm2 with its gradient, plus the low-octave partial sum, in one pass.
 *  Matches fbm2's seed schedule and lacunarity exactly. */
function hillField(x: number, z: number, seed: number, out: HillField): void {
  let sum = 0;
  let dx = 0;
  let dz = 0;
  let lowSum = 0;
  let lowNorm = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < HILL_OCTAVES; o++) {
    vnoiseD(x * freq, z * freq, seed + o * 131, noiseGradScratch);
    const v = noiseGradScratch.v * 2 - 1;
    sum += v * amp;
    dx += noiseGradScratch.dx * 2 * amp * freq;
    dz += noiseGradScratch.dz * 2 * amp * freq;
    norm += amp;
    if (o < HILL_LOW_OCTAVES) {
      lowSum += v * amp;
      lowNorm += amp;
    }
    freq *= 2.03;
    amp *= 0.5;
  }
  out.v = sum / norm;
  out.dx = dx / norm;
  out.dz = dz / norm;
  out.vLow = lowSum / lowNorm;
}

// Module scratch — field() is called tens of thousands of times a frame and
// must never allocate. Single-threaded and non-reentrant, so sharing is safe.
const cellScratch: CellResult = { dist: 0, fx: 0, fz: 0, id: 0 };
const hillScratch: HillField = { v: 0, vLow: 0, dx: 0, dz: 0 };

// ================================================================== TERRAIN

export class ProceduralTerrain implements TerrainProvider {
  private readonly cfg: Config;

  /** The seed the grain, the height bound and the memo table were built for.
   *  Changing cfg.seed at runtime rebuilds all three on the next query.
   *  (Sliding the *amplitudes* in a debug panel does not invalidate the memo
   *  table — nudge the seed, or build a new ProceduralTerrain.) */
  private builtSeed = -1;

  private seed = 0;
  /** The world's grain, as a rotation. Crests run along it. */
  private grainCos = 1;
  private grainSin = 0;
  private maxH = 0;

  private readonly memoX = new Int32Array(MEMO_SIZE);
  private readonly memoZ = new Int32Array(MEMO_SIZE);
  private readonly memoH = new Float32Array(MEMO_SIZE);
  /** 0 empty, 1 written, 2 written and hit since. A two-state clock: a slot
   *  someone actually asked for twice outlives a slot nobody wanted. */
  private readonly memoUse = new Uint8Array(MEMO_SIZE);

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.rebuild();
  }

  // ---------------------------------------------------------------- public

  heightAt(x: number, z: number): number {
    if (this.cfg.seed !== this.builtSeed) this.rebuild();

    // Snap, then hash. The world is ±10^5 m across, so 1/8 m keys sit
    // comfortably inside int32.
    const qx = Math.round(x * MEMO_INV_STEP) | 0;
    const qz = Math.round(z * MEMO_INV_STEP) | 0;
    let k = Math.imul(qx, 0x27d4eb2d) ^ Math.imul(qz, 0x165667b1);
    k ^= k >>> 15;
    k = Math.imul(k, 0x85ebca6b);
    k ^= k >>> 13;
    const s0 = k & MEMO_MASK;
    const s1 = s0 ^ 1;

    if (this.memoUse[s0] !== 0 && this.memoX[s0] === qx && this.memoZ[s0] === qz) {
      this.memoUse[s0] = 2;
      return this.memoH[s0];
    }
    if (this.memoUse[s1] !== 0 && this.memoX[s1] === qx && this.memoZ[s1] === qz) {
      this.memoUse[s1] = 2;
      return this.memoH[s1];
    }

    // Evaluate at the *snapped* position, and store what we return, so the
    // cached and uncached answers are bit-identical.
    const y = Math.fround(this.field(qx * MEMO_STEP, qz * MEMO_STEP));
    const u0 = this.memoUse[s0];
    const u1 = this.memoUse[s1];
    const slot = u0 === 0 ? s0 : u1 === 0 ? s1 : u0 <= u1 ? s0 : s1;
    this.memoX[slot] = qx;
    this.memoZ[slot] = qz;
    this.memoH[slot] = y;
    this.memoUse[slot] = 1;
    return y;
  }

  /**
   * Height, normal and slope. The normal is a central difference over a 6 m
   * baseline — wide enough that the fine detail layer doesn't make the ground
   * shimmer, narrow enough to keep a crest sharp.
   *
   * `slope` is the sine of the ground's tilt: 0 dead flat, 0.71 at 45°, 1 at
   * vertical. That definition is what config.rockSlope (0.62 ≈ 38°),
   * config.ridgeMinSlope (0.13 ≈ 7.5°) and config.landingSlope (0.30 ≈ 17°)
   * are calibrated against.
   */
  sampleAt(x: number, z: number, out: TerrainSample): TerrainSample {
    const d = NORMAL_STEP;
    const inv2d = 1 / (2 * d);
    const h = this.heightAt(x, z);
    const gx = (this.heightAt(x + d, z) - this.heightAt(x - d, z)) * inv2d;
    const gz = (this.heightAt(x, z + d) - this.heightAt(x, z - d)) * inv2d;
    const g2 = gx * gx + gz * gz;
    const inv = 1 / Math.sqrt(g2 + 1);
    out.height = h;
    out.nx = -gx * inv;
    out.ny = inv;
    out.nz = -gz * inv;
    out.slope = Math.sqrt(g2) * inv;
    return out;
  }

  waterLevel(): number {
    return this.cfg.waterLevel;
  }

  /** A true upper bound, not an estimate: every layer below is clamped by its
   *  own amplitude, so the sum can never be exceeded. The sky and the far
   *  clip plane are sized off this. */
  maxHeight(): number {
    if (this.cfg.seed !== this.builtSeed) this.rebuild();
    return this.maxH;
  }

  // --------------------------------------------------------------- private

  private rebuild(): void {
    const c = this.cfg;
    this.builtSeed = c.seed;
    this.seed = c.seed | 0;

    // The grain: the compass line the mountain crests run along. It is biased
    // to lie square across the prevailing wind, because mountain wave — the
    // only lift left after dark, and the run's mastery moment — needs a crest
    // standing broadside to the airflow. The seed still swings it ±38°, so no
    // two worlds line up the same way, and the domain warp bends individual
    // ranges another ±25° off that. Read once, at build: the weather changes
    // during a crossing, the land does not.
    const jitter = (hash2(this.seed, 4211, 9109) * 2 - 1) * GRAIN_JITTER;
    const grain = Math.PI * 0.5 - c.windDirDeg * DEG + jitter;
    this.grainCos = Math.cos(grain);
    this.grainSin = Math.sin(grain);

    // Every layer below is clamped by its own amplitude, so their sum is a
    // true ceiling rather than a guess.
    this.maxH =
      c.waterLevel +
      c.continentAmplitude +
      c.mountainAmplitude +
      c.hillAmplitude +
      c.detailAmplitude;

    this.memoUse.fill(0);
  }

  /** The generator proper. Pure, allocation-free, deterministic. */
  private field(x: number, z: number): number {
    const c = this.cfg;
    const s = this.seed;

    // ============================================== 1. CONTINENTAL SHAPE
    // Warp before sampling. An unwarped fbm makes round soapy islands; a
    // warped one makes peninsulas, bays and drowned valleys. The shoreline is
    // the single most valuable feature the noise gives us for free — it is
    // where the sea breeze converges — so it is worth two extra lookups.
    const cs = 1 / c.continentScale;
    const cwx = x * cs * CONT_WARP_FREQ;
    const cwz = z * cs * CONT_WARP_FREQ;
    const warpX = fbm2(cwx, cwz, s + 1013, 2) * CONT_WARP;
    const warpZ = fbm2(cwx + 4.37, cwz - 2.11, s + 2027, 2) * CONT_WARP;
    const cont = fbm2(x * cs + warpX, z * cs + warpZ, s + 61, 4) + LAND_BIAS;

    if (cont <= 0) {
      // Below the waterline. Nothing down here is ever seen through the
      // water, and every later layer is gated to zero at the shore anyway —
      // so returning early makes the third of the map that is ocean almost
      // free to sample, and keeps the seabed smooth enough that no stray
      // hill pokes through the surface.
      return c.waterLevel + c.continentAmplitude * cont * SEA_DEPTH_GAIN;
    }

    let h = c.waterLevel + c.continentAmplitude * (1 - Math.exp(-cont * CONT_RISE));

    /** 0 at the waterline, 1 once we are properly ashore. Everything that
     *  follows is multiplied by this, which is what keeps the coast a
     *  continuous ramp instead of a step. */
    const land = smootherstep(0, COAST_BLEND, cont);

    // ================================================ 2. MOUNTAIN MASSIFS
    // Where the ranges are allowed to exist at all. A slow belt field means
    // mountains come in cordilleras with real plains between them, rather
    // than being sprinkled evenly over the map — and plains are where the
    // wide morning thermals live.
    const us = 1 / (c.mountainScale * UPLIFT_SCALE);
    const beltN = fbm2(x * us + 17.3, z * us - 9.7, s + 3319, 3);
    const beltThr = lerp(UPLIFT_HI, UPLIFT_LO, clamp01(c.mountainCoverage));
    const uplift = smootherstep(beltThr, beltThr + UPLIFT_BAND, beltN) * land;

    /** 0..1 how much massif is under this point. Feeds the erosion rule and
     *  the hill suppression as well as the height itself. */
    let presence = 0;
    /** 0..1 how crest-like the ridged field is here. */
    let crest = 0;

    if (uplift > 0) {
      const ms = 1 / c.mountainScale;
      // Worley places one massif per cell. MASSIF_EDGE is deliberately larger
      // than the typical half-separation, so adjacent massifs meet along
      // their shared boundary and grow together into a range; the kink in the
      // cell distance right there reads as the col between two summits.
      const cell = worley2(x * ms, z * ms, s + 4409, cellScratch);
      const mask = 1 - smootherstep(MASSIF_CORE, MASSIF_EDGE, cell.dist);
      if (mask > 0) {
        presence = uplift * mask;

        // Rotate into the world's grain, then squash the along-crest axis of
        // the ridged lookup. Squashing is what turns knots into spines: long,
        // continuous windward faces for ridge lift, and crest lines straight
        // enough to stand a wave train behind.
        //
        // (The grain is a global rotation plus a domain warp rather than a
        // per-massif rotation. A per-cell frame would shear at every Voronoi
        // boundary — a kilometre-high cliff wherever two massifs touch. The
        // warp gives each massif its own visible strike without ever being
        // discontinuous, which is the same result honestly obtained.)
        const gAcross = x * this.grainCos + z * this.grainSin;
        const gAlong = -x * this.grainSin + z * this.grainCos;
        const wu = gAcross * ms * CREST_WARP_FREQ;
        const wv = gAlong * ms * CREST_WARP_FREQ;
        const bendA = fbm2(wu, wv, s + 5501, 2) * CREST_WARP_ACROSS;
        const bendB = fbm2(wu - 7.9, wv + 3.3, s + 6607, 2) * CREST_WARP_ALONG;
        crest = ridged2(
          gAcross * ms + bendA,
          gAlong * ms * CREST_ANISOTROPY + bendB,
          s + 7717,
          5,
        );

        // A smooth dome carries the crests. The dome is the range's shoulder:
        // long, even flanks that a bird can beat back and forth along all
        // morning. The ridged term is the skyline on top of it.
        h += c.mountainAmplitude * presence * (MASSIF_DOME * mask + (1 - MASSIF_DOME) * crest);
      }
    }

    // ==================================================== 3. HILL COUNTRY
    const hs = 1 / c.hillScale;
    hillField(x * hs, z * hs, s + 8821, hillScratch);
    /** How much of the hill layer survives here — nothing at the waterline,
     *  and mostly nothing inside a massif, where the mountain owns the shape. */
    const hillGate = land * (1 - MASSIF_HILL_SUPPRESS * presence);
    /** True world-space slope of the hill layer, in metres per metre. */
    const hillSlope =
      Math.sqrt(hillScratch.dx * hillScratch.dx + hillScratch.dz * hillScratch.dz) *
      c.hillAmplitude *
      hs *
      hillGate;

    // ========================================================= 4. EROSION
    // The one rule: ground that is already steep stays bare and jagged;
    // ground that is gentle collects what washes off the steep ground and
    // gets gentler still. That split does three jobs at once — it gives
    // thermals the broad flat floors they bake over, it keeps ridge faces
    // sharp enough to deflect wind, and it leaves a tired bird somewhere
    // level to put down.
    const steep = clamp01(hillSlope / EROSION_SLOPE_REF + presence * crest * EROSION_CREST_GAIN);
    /** 1 = every fold and every grain of detail survives. EROSION_FLOOR = a
     *  valley floor or a plain, silted almost smooth. */
    const sharp = lerp(EROSION_FLOOR, 1, smootherstep(0, 1, steep));

    // The flattening itself: blend toward the hill field's slow octaves. On a
    // valley floor the small folds are simply not there, rather than being
    // there and scaled down — which is the difference between flat ground and
    // quiet lumpy ground.
    h += c.hillAmplitude * lerp(hillScratch.vLow, hillScratch.v, sharp) * hillGate;

    // ==================================================== 5. FINE DETAIL
    // Enough grain that no slope ever reads as smooth plastic under the low
    // sun, and no more. Erosion gates it too, so plains stay plains.
    const ds = 1 / c.detailScale;
    h += c.detailAmplitude * fbm2(x * ds, z * ds, s + 9931, 3) * sharp * land;

    return h;
  }
}

// =================================================================== LAUNCH

export interface LaunchSite {
  x: number;
  z: number;
  groundHeight: number;
  /** Unit horizontal vector along the crest — the direction height falls off
   *  slowest. Sign is arbitrary; a ridge is a line, not an arrow. */
  ridgeDirX: number;
  ridgeDirZ: number;
}

/** How many spiral candidates the coarse pass throws at the world. */
const LAUNCH_SAMPLES = 1600;
/** First search radius (m), and the fallback if that finds nothing dry. */
const LAUNCH_RADIUS = 30000;
const LAUNCH_RADIUS_WIDE = 90000;
/** How many of the highest candidates get the expensive prominence test. */
const LAUNCH_SHORTLIST = 48;
/** Radius (m) of the ring the launch point must stand above. */
const LAUNCH_RING = 800;
/** A launch must clear the water by this much (m) or it is barely scored. */
const LAUNCH_MIN_ABOVE_WATER = 400;
/** How much raw altitude counts next to prominence. Prominence finds crests;
 *  altitude breaks ties toward the big country. */
const LAUNCH_HEIGHT_WEIGHT = 0.3;
/** Metres of score paid per metre from the origin. Gentle — just enough that
 *  the run doesn't always begin at the rim of the search disc. */
const LAUNCH_DISTANCE_PENALTY = 0.005;
/** Vogel spiral: even coverage of a disc with no clumping and no grid. */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** Headings tried when reading the crest line, and how far out (m). */
const RIDGE_HEADINGS = 12;
const RIDGE_PROBE = 300;
/** Uphill walk that puts the launch on the crest instead of near it. */
const REFINE_ROUNDS = 6;
const REFINE_STEP = 400;
const REFINE_DECAY = 0.55;

/**
 * Find the ridge the crossing starts from.
 *
 * The first thirty seconds of a run are the promise the rest of it keeps, so
 * this has to be spectacular *and* reliable: never water, never the middle of
 * a plain, never a hummock that happens to be tall. A coarse Vogel spiral
 * finds the high ground, the highest candidates are scored on how far they
 * stand above an 800 m ring — a summit scores, the middle of a plateau does
 * not, because you cannot soar a plateau — and the winner then walks uphill
 * until it is standing on the crest itself.
 *
 * Runs once, at world build. The allocations here are deliberate and cheap.
 */
export function findLaunchSite(terrain: TerrainProvider, cfg: Config): LaunchSite {
  const water = terrain.waterLevel();
  // Different worlds start their spiral at a different angle. Free variety.
  const phase = (cfg.seed % 1024) * (TAU / 1024);

  const bestX = new Float64Array(LAUNCH_SHORTLIST);
  const bestZ = new Float64Array(LAUNCH_SHORTLIST);
  const bestH = new Float64Array(LAUNCH_SHORTLIST);
  let count = 0;

  for (let pass = 0; pass < 2; pass++) {
    const radius = pass === 0 ? LAUNCH_RADIUS : LAUNCH_RADIUS_WIDE;
    count = 0;
    for (let i = 0; i < LAUNCH_SAMPLES; i++) {
      // sqrt spreads the samples evenly over area rather than over radius.
      const r = radius * Math.sqrt((i + 0.5) / LAUNCH_SAMPLES);
      const a = i * GOLDEN_ANGLE + phase;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const h = terrain.heightAt(x, z);
      if (h <= water) continue;
      if (count < LAUNCH_SHORTLIST) count++;
      else if (h <= bestH[LAUNCH_SHORTLIST - 1]) continue;
      // Insertion sort, descending. The list is short and the world is built
      // once; this is cheaper than sorting 1600 candidates.
      let j = count - 1;
      while (j > 0 && bestH[j - 1] < h) {
        bestH[j] = bestH[j - 1];
        bestX[j] = bestX[j - 1];
        bestZ[j] = bestZ[j - 1];
        j--;
      }
      bestH[j] = h;
      bestX[j] = x;
      bestZ[j] = z;
    }
    // Good enough to launch from? Otherwise cast the net three times wider.
    if (count > 0 && bestH[0] >= water + LAUNCH_MIN_ABOVE_WATER) break;
  }

  if (count === 0) {
    // Only reachable with a config that drowns the entire world. Put the bird
    // over the origin rather than returning nothing at all.
    return {
      x: 0,
      z: 0,
      groundHeight: terrain.heightAt(0, 0),
      ridgeDirX: 1,
      ridgeDirZ: 0,
    };
  }

  let sx = 0;
  let sz = 0;
  let sh = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < count; i++) {
    const x = bestX[i];
    const z = bestZ[i];
    const h = bestH[i];
    let ring = 0;
    for (let k = 0; k < RING_N; k++) {
      ring += terrain.heightAt(x + RING_COS[k] * LAUNCH_RING, z + RING_SIN[k] * LAUNCH_RING);
    }
    const prominence = h - ring / RING_N;
    let score =
      prominence +
      (h - water) * LAUNCH_HEIGHT_WEIGHT -
      Math.sqrt(x * x + z * z) * LAUNCH_DISTANCE_PENALTY;
    // Too low to be a launch. Scored, not rejected, so there is always an
    // answer even in a world that has no proper mountains at all.
    if (h < water + LAUNCH_MIN_ABOVE_WATER) score -= 1e4;
    if (score > bestScore) {
      bestScore = score;
      sx = x;
      sz = z;
      sh = h;
    }
  }

  // Walk uphill onto the crest. The spiral only ever lands *near* one, and
  // the difference between near and on is the difference between a view and
  // a postcard.
  let step = REFINE_STEP;
  for (let round = 0; round < REFINE_ROUNDS; round++) {
    for (let k = 0; k < RING_N; k++) {
      const nx = sx + RING_COS[k] * step;
      const nz = sz + RING_SIN[k] * step;
      const nh = terrain.heightAt(nx, nz);
      if (nh > sh) {
        sh = nh;
        sx = nx;
        sz = nz;
      }
    }
    step *= REFINE_DECAY;
  }

  // The crest line: the heading that gives up its height most slowly. Probed
  // both ways along each heading, because a ridge continues in both.
  let dirX = 1;
  let dirZ = 0;
  let bestKeep = -Infinity;
  for (let k = 0; k < RIDGE_HEADINGS; k++) {
    const a = (k / RIDGE_HEADINGS) * Math.PI; // a half turn covers every line
    const dx = Math.cos(a);
    const dz = Math.sin(a);
    const keep =
      terrain.heightAt(sx + dx * RIDGE_PROBE, sz + dz * RIDGE_PROBE) +
      terrain.heightAt(sx - dx * RIDGE_PROBE, sz - dz * RIDGE_PROBE);
    if (keep > bestKeep) {
      bestKeep = keep;
      dirX = dx;
      dirZ = dz;
    }
  }

  return { x: sx, z: sz, groundHeight: sh, ridgeDirX: dirX, ridgeDirZ: dirZ };
}

// ================================================================ ROUGHNESS

/**
 * Reference slope for "as rugged as it gets". A patch whose heights vary by
 * a fifth of its own radius reads as full mountain; anything gentler scales
 * down from there.
 */
const ROUGHNESS_REF_SLOPE = 0.2;

/**
 * 0..1 local ruggedness — the standard deviation of a couple of rings of
 * samples, normalised against the radius so the answer means the same thing
 * whether you ask about 200 m or 2 km. The biome layer uses it to decide
 * where scree and bare rock belong; the wind layer uses it to decide where
 * the air is mechanically rough.
 *
 * Seventeen terrain queries — cheap enough per chunk, not something to call
 * per bird per frame.
 */
export function terrainRoughness(
  terrain: TerrainProvider,
  x: number,
  z: number,
  radius: number,
): number {
  const inner = radius * 0.5;
  const centre = terrain.heightAt(x, z);
  let sum = centre;
  let sum2 = centre * centre;
  for (let k = 0; k < RING_N; k++) {
    const cx = RING_COS[k];
    const cz = RING_SIN[k];
    const a = terrain.heightAt(x + cx * radius, z + cz * radius);
    const b = terrain.heightAt(x + cx * inner, z + cz * inner);
    sum += a + b;
    sum2 += a * a + b * b;
  }
  const n = 1 + RING_N * 2;
  const mean = sum / n;
  const variance = sum2 / n - mean * mean;
  const sd = variance > 0 ? Math.sqrt(variance) : 0;
  return clamp01(sd / (radius * ROUGHNESS_REF_SLOPE));
}
