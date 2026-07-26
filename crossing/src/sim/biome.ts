/**
 * THE BIOME LAYER — what the land *is*, and where the air gets its energy.
 *
 * Two jobs, and the second one is the reason this file matters.
 *
 * The first is art direction: every point on the continent gets a kind and a
 * linear-RGB albedo, blended smoothly across boundaries, so the world reads as
 * a *map* from three thousand feet — green river country, khaki scrub, an
 * ochre basin, a range wearing snow on its shaded side. A hard biome edge seen
 * from the air looks like a bug, so nothing here is a hard edge: kinds are
 * membership weights that sum to one, and colour is their blend.
 *
 * The second is `heat` — 0..1, how strongly this ground turns sunlight into
 * rising air. Bare rock and desert bake; forest and water stay cool; snow
 * throws the light back at the sky. The wind field roots every thermal
 * candidate on a heat reading, which means this file quietly decides where the
 * lift lives. Fly over the map and the colours *are* the lift map — that is
 * the whole promise of "every kind of air is sourced from the terrain".
 *
 * Everything derives from the seed and the terrain, so a seed rebuilds an
 * identical continent, biomes and thermal geography included.
 */

import type { Config } from './config';
import type { BiomeProvider, BiomeSample, TerrainProvider, TerrainSample } from './types';
import { BiomeKind } from './types';
import { clamp, clamp01, lerp, smoothstep } from './math';
import { fbm2, valueNoise2 } from './noise';

/** How many entries BiomeKind has. Kept beside the enum it mirrors. */
const KIND_COUNT = 8;

// ============================================================== THE SUN
//
// `heatAt` has no clock — it answers "how much can this ground bake over a
// day", not "right now". So aspect is measured against a single fixed bearing
// standing in for where the sun spends the day.

/**
 * The bearing the sun favours, as a unit XZ vector. +Z is the sunward side
 * (yaw 0 and windDirDeg 0 both face -Z, so -Z is the cold side of the world),
 * pulled a little toward +X so the faces that catch the morning are already
 * the warm ones. Rotating this redraws which side of every hill in the world
 * makes thermals — it is the single most geographic number in the file.
 */
const SUN_ASPECT_X = 0.42;
const SUN_ASPECT_Z = 0.9075;

/**
 * How much a sun-facing slope adds to (and a shaded one takes from) heat.
 * A real soaring fact and a real tactic: at 0.22 a south-east face is worth
 * ~45% more than the north-west face of the same hill. Raise it and the game
 * becomes "always fly the sunny side"; drop it to 0 and hillsides stop
 * mattering at all.
 */
const ASPECT_HEAT = 0.22;

/**
 * Grain on the heat field, so a big dry plain is not one uniform hot slab
 * that thermals could root anywhere on. Gives the wind field somewhere
 * *particular* to put a column.
 */
const HEAT_GRAIN = 0.12;

/**
 * How much the canopy suppresses heat on top of forest's own low value. Trees
 * shade the soil and transpire the water back out; ground under them does not
 * bake. This is what keeps forest a *crossing* rather than a climb — without
 * it the half-forest-half-meadow ground at every forest edge drifts over
 * config.thermalMinHeat and the woods quietly become soarable.
 */
const CANOPY_SHADE = 0.6;

/**
 * Heat above this value is compressed toward 1 instead of clipping at it. The
 * sun and grain terms are proportional, so the hottest desert would otherwise
 * pin at a flat 1.0 across whole basins and throw away the difference between
 * hot ground and the hottest ground on the map — which is exactly the
 * difference the wind field is trying to read when it picks a thermal site.
 */
const HEAT_KNEE = 0.75;

/**
 * Metres between the two terrain probes `heatAt` uses to read aspect. Small
 * reads individual boulders; large reads the hillside, which is what actually
 * bakes. 42 m is "one face of a hill".
 */
const ASPECT_PROBE = 42;

/**
 * One axis of gradient systematically under-reads how steep the land really
 * is — a face running across the probe line reads flat. This restores the
 * average for isotropic terrain. It cannot fix any individual sample, but it
 * stops `heatAt` from being biased cold over rocky country as a whole, which
 * would quietly starve the mountains of thermals.
 */
const SLOPE_PROBE_GAIN = 1.15;

// ========================================================== THE FIELDS

/**
 * Metres per unit of the moisture field. This is climate, not weather:
 * at 9 km the continent divides into a handful of broad wet and dry belts,
 * which is what makes one seed "the green one" and another "the desert one".
 * Shrink it and the map turns into patchy confetti with no geography.
 */
const MOISTURE_SCALE = 9000;
const MOISTURE_FREQ = 1 / MOISTURE_SCALE;

/**
 * How hard the moisture map pushes toward its extremes. High gives clean
 * rainforest and true desert with a narrow transition; low gives one endless
 * middling green.
 */
const MOISTURE_CONTRAST = 0.66;

/** Water finds the low ground: how much wetter the first metres above the shoreline are, and over what height that bonus fades. */
const LOWLAND_WET = 0.26;
const LOWLAND_HEIGHT = 110;

/** How much drier high country reads. This is the skirt of dry scrub a range wears before the rock starts. */
const UPLAND_DRY = 0.2;

/**
 * Metres per unit of the ground-grain field: the noise that wobbles the snow
 * and tree lines, mottles the shore between sand and shingle, and puts hot
 * spots inside hot country. ~640 m is "one hillside's worth of character".
 */
const GRAIN_SCALE = 640;
const GRAIN_FREQ = 1 / GRAIN_SCALE;

/** Metres per unit of canopy clumping — the scale of stands and clearings in a forest. */
const CANOPY_SCALE = 210;
const CANOPY_FREQ = 1 / CANOPY_SCALE;

/** Colour mottle scales (m): speckle you only see on final glide, and patchiness you read from cruising height. */
const FINE_SCALE = 5.5;
const BROAD_SCALE = 46;
const FINE_FREQ = 1 / FINE_SCALE;
const BROAD_FREQ = 1 / BROAD_SCALE;

/**
 * Every field is offset by this before it is sampled, so the world origin
 * isn't sitting exactly on a noise lattice corner. The launch point is at
 * (0,0) and should not be the one place where every field is at a grid node.
 */
const LATTICE_OFF = 137.31;

/** Per-field seed offsets. Spaced well clear of the octave stride fbm2 uses internally (131 per octave) so no two fields correlate. */
const SEED_MOISTURE = 1013;
const SEED_GRAIN = 4409;
const SEED_CANOPY = 7717;
const SEED_MOTTLE = 9931;

// ======================================================= THE BOUNDARIES

/**
 * Metres the snow and tree lines wander with the grain noise. Zero draws them
 * as contour lines on a map, which is instantly readable as fake; too much and
 * you get forests on summits.
 */
const LINE_JITTER = 95;

/**
 * How many metres higher the snow and tree lines sit on a sun-facing slope.
 * The clearest thing you can see from the air over any range: the warm side
 * melts out and grows trees hundreds of feet above the shaded side.
 */
const ASPECT_LINE_LIFT = 130;

/** Metres over which forest thins out as it approaches config.treeLine. */
const TREE_BLEND = 140;

/** Slope band (in TerrainSample.slope units) over which ground turns from soil to bare stone around config.rockSlope. */
const ROCK_BLEND = 0.12;

/**
 * Snow holds on ground far steeper than the point where soil gives up, so it
 * sheds at this multiple of config.rockSlope rather than at it. Set them equal
 * and a real mountain range comes out entirely bare — every high face is
 * steeper than rockSlope — which is the difference between a snow-capped
 * continent and a brown one. Lower it for more exposed stone.
 */
const SNOW_SHED_FACTOR = 1.35;
/** Slope band over which snow gives up. This is what gives a big range its ribs of stone in white. */
const SNOW_SHED_BLEND = 0.16;

/** How much of the ground above the treeline is bare slab even where it is wet enough for tundra. */
const ALPINE_ROCK_MIN = 0.35;

/**
 * Metres above the waterline over which land emerges from water. Anything at
 * or below the waterline is water, full stop — a beach that reached under the
 * surface would hand the wind field a hot thermal source in the middle of a
 * lake. The pale shallows come from the water palette instead, which is both
 * more truthful and prettier.
 */
const WATER_EDGE = 1.5;
/** Metres above the waterline the beach reaches before ordinary land takes over. */
const SHORE_HEIGHT = 14;
/** Slope above which no beach forms — a headland plunges straight in. */
const SHORE_MAX_SLOPE = 0.34;
/** Depth (m) at which water reaches its darkest colour. Short, so only genuinely deep water goes black and every lake gets a readable rim. */
const DEEP_WATER_DEPTH = 30;

// ------------------------------------------------- what grows at what moisture
//
// These four ranges tile the 0..1 moisture axis with soft overlaps. Overlap is
// the point: the ground between two biomes is genuinely a mixture of both.

const DESERT_MOIST_LO = 0.16;
const DESERT_MOIST_HI = 0.36;
const SCRUB_MOIST_LO = 0.14;
const SCRUB_MOIST_HI = 0.5;
const MEADOW_MOIST_LO = 0.32;
/** Deliberately past 1: meadow never runs out at the wet end, so there is always something growing under the forest. */
const MEADOW_MOIST_HI = 1.05;
const FOREST_MOIST_LO = 0.5;
const FOREST_MOIST_HI = 0.78;

// ============================================================== PALETTE
//
// LINEAR RGB, 0..1. The renderer works in linear and tonemaps with ACES, so
// these are NOT pre-brightened — a value that looks right in a colour picker
// would be roughly twice too bright here. Two anchors per kind; a per-kind
// "variation" number blends between them, which is what stops any biome from
// being a flat sheet of one colour.
//
//   A = the kind at rest        B = the kind at its other extreme
//   Water   slate blue-green    →  near-black deep water (A is the shallows,
//                                  which is where every lake gets its rim)
//   Shore   warm sand           →  grey shingle
//   Meadow  soft olive green    →  sun-bleached yellow
//   Forest  deep blue-green     →  darker conifer
//   Scrub   dusty sage          →  dry khaki
//   Desert  warm ochre          →  pale bone
//   Rock    cool violet-grey    →  warm sun-baked stone
//   Snow    sky-tinted white    →  wind-scoured grey-blue
const PALETTE = new Float64Array([
  // r      g      b   |   r      g      b
  0.028, 0.055, 0.06, 0.0035, 0.008, 0.011, // Water
  0.448, 0.377, 0.262, 0.274, 0.263, 0.233, // Shore
  0.163, 0.205, 0.064, 0.263, 0.243, 0.073, // Meadow
  0.033, 0.064, 0.04, 0.02, 0.04, 0.03, // Forest
  0.205, 0.196, 0.1, 0.296, 0.233, 0.119, // Scrub
  0.33, 0.208, 0.104, 0.538, 0.477, 0.319, // Desert
  0.147, 0.14, 0.171, 0.233, 0.179, 0.133, // Rock
  0.7, 0.755, 0.84, 0.571, 0.638, 0.749, // Snow
]);

/** Moisture at which meadow is fully green, and fully sun-bleached. */
const MEADOW_GREEN_AT = 0.72;
const MEADOW_DRY_AT = 0.34;
/** Moisture at which scrub is sage, and khaki. */
const SCRUB_SAGE_AT = 0.36;
const SCRUB_KHAKI_AT = 0.14;
/** How much of the conifer shift comes from altitude, and how much is stand-to-stand variety. */
const FOREST_CONIFER_ALT = 0.75;
const FOREST_CONIFER_GRAIN = 0.3;
/** How much of the desert's shift to bone comes from grain, and how much from altitude (high desert is paler). */
const DESERT_BONE_GRAIN = 0.6;
const DESERT_BONE_ALT = 0.45;
/** How far a sun-baked face warms bare rock. At 0.55 a shaded north wall stays violet-grey while its sunny side goes brown. */
const ROCK_SUN_WARM = 0.55;
/** How much of the snow's scoured look comes from steepness, and how much from grain. */
const SNOW_SCOUR_SLOPE = 0.7;
const SNOW_SCOUR_GRAIN = 0.3;

/** Amplitude of the two colour-mottle scales, and a small extra green-only wobble so mottle isn't pure brightness. */
const MOTTLE_FINE = 0.16;
const MOTTLE_BROAD = 0.13;
const MOTTLE_HUE = 0.05;

/** Weights below this contribute nothing visible and are skipped. */
const COLOR_EPS = 0.0025;

/** Canopy density is remapped from noise across this window — below LO is a clearing, above HI is closed forest. */
const CANOPY_LO = 0.3;
const CANOPY_HI = 0.8;
/** Even the thinnest stand has some trees, so forest never has bald patches with hard edges. */
const CANOPY_MIN = 0.18;
/** How much scattered brush scrubland carries, as a fraction of forest canopy. */
const SCRUB_CANOPY = 0.22;

// ================================================================ HEAT
//
// The numbers the whole lift map is built on. config.thermalMinHeat (0.34) is
// the bar a candidate site has to clear, which is what makes forest and water
// dead air and puts every column over stone, sand and dry grass.
const KIND_HEAT = new Float64Array([
  0.02, // Water — a heat sink. Thermals die crossing a lake, and you feel it.
  0.6, // Shore — dry sand bakes hard, but it is a thin ribbon beside cold water.
  0.52, // Meadow — moderate, and the wet end of it barely clears the bar.
  0.15, // Forest — the canopy sweats and shades. The reason forest is a crossing, not a climb.
  0.66, // Scrub — dry brush over dry dirt. The workhorse of the middle of the day.
  0.95, // Desert — bakes hardest of all. Narrow, violent noon columns come from here.
  0.88, // Rock — bare stone, and it works even above the treeline where nothing else does.
  0.05, // Snow — throws the light straight back at the sky.
]);

/** Canopy density per kind, 0..1, for the scatter system. */
export const BIOME_TREE_DENSITY: Record<BiomeKind, number> = {
  [BiomeKind.Water]: 0,
  [BiomeKind.Shore]: 0.04,
  [BiomeKind.Meadow]: 0.14,
  [BiomeKind.Forest]: 1,
  [BiomeKind.Scrub]: 0.28,
  [BiomeKind.Desert]: 0.02,
  [BiomeKind.Rock]: 0.03,
  [BiomeKind.Snow]: 0,
};

const BIOME_NAMES: Record<BiomeKind, string> = {
  [BiomeKind.Water]: 'open water',
  [BiomeKind.Shore]: 'shoreline',
  [BiomeKind.Meadow]: 'meadow',
  [BiomeKind.Forest]: 'forest',
  [BiomeKind.Scrub]: 'scrubland',
  [BiomeKind.Desert]: 'high desert',
  [BiomeKind.Rock]: 'bare rock',
  [BiomeKind.Snow]: 'snowfield',
};

/** The name the HUD and the summary screen use for a place. */
export function biomeName(kind: BiomeKind): string {
  return BIOME_NAMES[kind];
}

/**
 * A soft plateau over [lo, hi]: zero outside, one across the middle, eased in
 * and out over `soft` of the width at each end. Biome preferences want
 * plateaus rather than spikes — a spike turns a biome into a thin stripe that
 * only ever appears as a boundary between its neighbours.
 */
function band(v: number, lo: number, hi: number, soft = 0.45): number {
  const e = (hi - lo) * soft;
  return smoothstep(lo, lo + e, v) * (1 - smoothstep(hi - e, hi, v));
}

/**
 * The continent's biomes, derived from terrain height, slope, aspect and a
 * seeded climate field. Deterministic, allocation-free, and pure — no Three.js
 * and no clock. The day changes how hard the ground bakes; it never changes
 * what the ground *is*.
 */
export class ProceduralBiomes implements BiomeProvider {
  private readonly cfg: Config;
  private readonly terrain: TerrainProvider;

  /** Membership weights, one per BiomeKind, normalised to sum to 1. Scratch. */
  private readonly w = new Float64Array(KIND_COUNT);
  /** Per-kind blend between its two palette anchors. Scratch. */
  private readonly vary = new Float64Array(KIND_COUNT);
  /** Reused terrain readout, so sampling never allocates. */
  private readonly ts: TerrainSample = { height: 0, nx: 0, ny: 1, nz: 0, slope: 0 };

  constructor(cfg: Config, terrain: TerrainProvider) {
    this.cfg = cfg;
    this.terrain = terrain;
  }

  // ------------------------------------------------------------ sampling

  sampleAt(x: number, z: number, out: BiomeSample): BiomeSample {
    const c = this.cfg;
    const t = this.terrain.sampleAt(x, z, this.ts);
    const h = t.height;
    const slope = t.slope;

    // Aspect straight off the surface normal: +1 the face looks into the
    // sun's side of the sky all day, -1 it lives in its own shadow.
    const sunFacing = clamp(t.nx * SUN_ASPECT_X + t.nz * SUN_ASPECT_Z, -1, 1);

    const moisture = this.moistureField(x, z, h);
    const grain = this.grainField(x, z);

    const kind = this.weigh(h, slope, sunFacing, moisture, grain);
    const w = this.w;
    const vy = this.vary;

    // --- pick where each kind sits between its two anchors ----------------
    // Deep water goes near-black; the shallows keep their slate.
    vy[BiomeKind.Water] = clamp01((c.waterLevel - h) / DEEP_WATER_DEPTH);
    // Sand or shingle, in stretches, the way a real coast alternates.
    vy[BiomeKind.Shore] = grain;
    // Grass follows the rain: green where it falls, bleached where it doesn't.
    vy[BiomeKind.Meadow] = smoothstep(MEADOW_GREEN_AT, MEADOW_DRY_AT, moisture);
    // Broadleaf low and warm, conifer high and cold — the shift you can see
    // as a colour change partway up every big hillside.
    vy[BiomeKind.Forest] = clamp01(
      smoothstep(c.treeLine * 0.3, c.treeLine, h) * FOREST_CONIFER_ALT +
        grain * FOREST_CONIFER_GRAIN,
    );
    vy[BiomeKind.Scrub] = smoothstep(SCRUB_SAGE_AT, SCRUB_KHAKI_AT, moisture);
    // Ochre in the hot basins, bone-pale on the high plateaus.
    vy[BiomeKind.Desert] = clamp01(
      grain * DESERT_BONE_GRAIN + smoothstep(c.treeLine * 0.5, c.snowLine, h) * DESERT_BONE_ALT,
    );
    // Stone remembers the sun: baked faces brown, shaded walls stay violet.
    vy[BiomeKind.Rock] = clamp01(0.5 + sunFacing * ROCK_SUN_WARM);
    // Steep snow is scoured and grey; the flats keep the fresh sky-white.
    vy[BiomeKind.Snow] = clamp01(
      smoothstep(c.rockSlope * 0.45, c.rockSlope, slope) * SNOW_SCOUR_SLOPE +
        grain * SNOW_SCOUR_GRAIN,
    );

    // --- blend the palette ------------------------------------------------
    let r = 0;
    let g = 0;
    let b = 0;
    let used = 0;
    for (let k = 0; k < KIND_COUNT; k++) {
      const wk = w[k];
      if (wk <= COLOR_EPS) continue;
      const i = k * 6;
      const f = vy[k];
      r += wk * (PALETTE[i] + (PALETTE[i + 3] - PALETTE[i]) * f);
      g += wk * (PALETTE[i + 1] + (PALETTE[i + 4] - PALETTE[i + 1]) * f);
      b += wk * (PALETTE[i + 2] + (PALETTE[i + 5] - PALETTE[i + 2]) * f);
      used += wk;
    }
    if (used > 1e-6) {
      const inv = 1 / used;
      r *= inv;
      g *= inv;
      b *= inv;
    }

    // Two scales of mottle. The fine one only resolves on final glide; the
    // broad one is what gives the ground texture from cruising height. The
    // green-only wobble keeps it from reading as flat brightness noise.
    const fine = valueNoise2(x * FINE_FREQ + LATTICE_OFF, z * FINE_FREQ - LATTICE_OFF, c.seed + SEED_MOTTLE) - 0.5;
    const broad = valueNoise2(x * BROAD_FREQ + LATTICE_OFF, z * BROAD_FREQ - LATTICE_OFF, c.seed + SEED_MOTTLE + 233) - 0.5;
    const tint = 1 + fine * MOTTLE_FINE + broad * MOTTLE_BROAD;
    out.r = clamp01(r * tint);
    out.g = clamp01(g * tint * (1 + fine * MOTTLE_HUE));
    out.b = clamp01(b * tint);

    // --- the rest of the readout ------------------------------------------
    out.kind = kind;
    out.heat = this.heatFromWeights(sunFacing, grain);

    // Canopy comes in stands and clearings. A flat 1.0 forest reads as
    // astroturf from the air — and thermals need the holes to exist at all.
    const canopy = clamp01(
      CANOPY_MIN +
        (1 - CANOPY_MIN) *
          smoothstep(
            CANOPY_LO,
            CANOPY_HI,
            valueNoise2(x * CANOPY_FREQ + LATTICE_OFF, z * CANOPY_FREQ - LATTICE_OFF, c.seed + SEED_CANOPY),
          ),
    );
    out.forest = clamp01((w[BiomeKind.Forest] + w[BiomeKind.Scrub] * SCRUB_CANOPY) * canopy);

    // Standing water is, definitionally, wet.
    out.moisture = clamp01(lerp(moisture, 1, w[BiomeKind.Water]));
    return out;
  }

  /**
   * Just the heat. The wind field calls this for every thermal candidate every
   * frame, so it is a deliberately cheap cousin of `sampleAt`: one terrain
   * height, one aspect probe, and two noise fields.
   *
   * The aspect probe is a single offset height sample along the sun bearing.
   * The height difference gives both the aspect (does the ground fall away
   * toward the sun?) and a stand-in for steepness. Reading one axis instead of
   * two means a face running across the sun line reads flatter than it is, so
   * this can miss a hot rock wall it should have found; over a whole map the
   * error averages to a few percent of heat. The wind field only ever consults
   * `heatAt`, so it stays self-consistent — but do not expect the number here
   * to match `sampleAt().heat` sample for sample in steep country.
   */
  heatAt(x: number, z: number): number {
    const h = this.terrain.heightAt(x, z);
    const hs = this.terrain.heightAt(
      x + SUN_ASPECT_X * ASPECT_PROBE,
      z + SUN_ASPECT_Z * ASPECT_PROBE,
    );
    // Positive gradient means the ground drops away toward the sun, i.e. the
    // face is tilted into it. Converting through 1/sqrt(1+g²) turns the
    // gradient into the sine of the tilt, matching the 0-flat..1-vertical
    // shape TerrainSample.slope is documented to use.
    const g = (h - hs) / ASPECT_PROBE;
    const sunFacing = g / Math.sqrt(1 + g * g);
    const slope = clamp01((sunFacing < 0 ? -sunFacing : sunFacing) * SLOPE_PROBE_GAIN);

    const moisture = this.moistureField(x, z, h);
    const grain = this.grainField(x, z);
    this.weigh(h, slope, sunFacing, moisture, grain);
    return this.heatFromWeights(sunFacing, grain);
  }

  // ------------------------------------------------------------- fields

  /**
   * 0..1 wetness. One big slow noise field is the climate; the terrain then
   * argues with it. This is the single decision that gives a seed its
   * character — where the green is.
   */
  private moistureField(x: number, z: number, h: number): number {
    const c = this.cfg;
    const n = fbm2(
      x * MOISTURE_FREQ + LATTICE_OFF,
      z * MOISTURE_FREQ - LATTICE_OFF,
      c.seed + SEED_MOISTURE,
      3,
    );
    let m = 0.5 + n * MOISTURE_CONTRAST;
    // Water runs downhill and stays there: the ground just above a shoreline
    // is greener than the climate map alone would say.
    m += LOWLAND_WET * (1 - smoothstep(c.waterLevel, c.waterLevel + LOWLAND_HEIGHT, h));
    // High country sheds its water and bakes. This is the band of dry scrub a
    // range wears between the forest and the stone, and it is prime lift.
    m -= UPLAND_DRY * smoothstep(c.treeLine * 0.35, c.snowLine, h);
    return clamp01(m);
  }

  /** 0..1 hillside-scale character: wobbles the lines, mottles the shore, puts hot spots inside hot country. */
  private grainField(x: number, z: number): number {
    return valueNoise2(
      x * GRAIN_FREQ + LATTICE_OFF,
      z * GRAIN_FREQ - LATTICE_OFF,
      this.cfg.seed + SEED_GRAIN,
    );
  }

  // ----------------------------------------------------- classification

  /**
   * Soft classification. Fills `this.w` with a membership weight per kind that
   * sums to 1 and returns the strongest, so a caller can name the ground while
   * still blending colour across the boundary. It is a pure function of its
   * arguments — the one place the whole file decides what land is — so the
   * cheap path and the exact path can only ever disagree by how well they
   * measured the ground, never by how they judged it.
   */
  private weigh(
    h: number,
    slope: number,
    sunFacing: number,
    moisture: number,
    grain: number,
  ): BiomeKind {
    const c = this.cfg;
    const w = this.w;

    // Where the *climate* thinks this ground sits. The grain noise wanders the
    // snow and tree lines by tens of metres so neither reads as a drawn
    // contour, and a sun-facing slope pushes both uphill — the warm side of a
    // range melts out and grows trees well above the shaded side.
    const hClimate = h + (grain * 2 - 1) * LINE_JITTER - sunFacing * ASPECT_LINE_LIFT;
    const above = h - c.waterLevel;

    // --- water and its edge ----------------------------------------------
    const wWater = 1 - smoothstep(0, WATER_EDGE, above);
    // A beach only forms where the land meets the water gently; a headland
    // plunges straight in and stays stone.
    const wShore =
      (1 - smoothstep(SHORE_MAX_SLOPE * 0.45, SHORE_MAX_SLOPE, slope)) *
      smoothstep(-WATER_EDGE, WATER_EDGE, above) *
      (1 - smoothstep(SHORE_HEIGHT * 0.4, SHORE_HEIGHT, above));

    const land = 1 - wWater;

    // --- ground with nothing growing on it --------------------------------
    // Snow claims its share first, then rock takes what is left of the bare
    // ground; the product form guarantees the two never sum past one.
    const shedSlope = c.rockSlope * SNOW_SHED_FACTOR;
    const snowShare =
      smoothstep(c.snowLine, c.snowLine + c.snowBlend, hClimate) *
      (1 - smoothstep(shedSlope, shedSlope + SNOW_SHED_BLEND, slope));
    const steep = smoothstep(c.rockSlope - ROCK_BLEND, c.rockSlope + ROCK_BLEND, slope);
    // Above the treeline the ground is scree and slab unless it is wet enough
    // to hold tundra. Combined with `steep` as a probabilistic OR so the two
    // reasons for bare stone blend instead of fighting.
    const alpine =
      smoothstep(c.treeLine, c.snowLine, hClimate) *
      (ALPINE_ROCK_MIN + (1 - ALPINE_ROCK_MIN) * (1 - moisture));
    const bare = steep + alpine - steep * alpine;
    const rockShare = bare * (1 - snowShare);
    const greenShare = (1 - snowShare) * (1 - bare);

    // --- and what grows on the rest ---------------------------------------
    const treeGate = 1 - smoothstep(c.treeLine - TREE_BLEND, c.treeLine, hClimate);
    const pForest = smoothstep(FOREST_MOIST_LO, FOREST_MOIST_HI, moisture) * treeGate;
    const pMeadow = band(moisture, MEADOW_MOIST_LO, MEADOW_MOIST_HI);
    const pScrub = band(moisture, SCRUB_MOIST_LO, SCRUB_MOIST_HI);
    const pDesert = 1 - smoothstep(DESERT_MOIST_LO, DESERT_MOIST_HI, moisture);
    const vegScale = (greenShare * land) / Math.max(pForest + pMeadow + pScrub + pDesert, 1e-6);

    w[BiomeKind.Water] = wWater;
    w[BiomeKind.Shore] = wShore;
    w[BiomeKind.Meadow] = pMeadow * vegScale;
    w[BiomeKind.Forest] = pForest * vegScale;
    w[BiomeKind.Scrub] = pScrub * vegScale;
    w[BiomeKind.Desert] = pDesert * vegScale;
    w[BiomeKind.Rock] = rockShare * land;
    w[BiomeKind.Snow] = snowShare * land;

    // Normalise and take the winner in one pass.
    let sum = 0;
    for (let k = 0; k < KIND_COUNT; k++) sum += w[k];
    const inv = sum > 1e-6 ? 1 / sum : 0;
    let best = 0;
    let bestW = -1;
    for (let k = 0; k < KIND_COUNT; k++) {
      const v = w[k] * inv;
      w[k] = v;
      if (v > bestW) {
        bestW = v;
        best = k;
      }
    }
    return best as BiomeKind;
  }

  /**
   * Blend the per-kind heat by the current weights, shade it under whatever
   * canopy stands here, then let the sun and the grain have their say. The
   * result is the number the whole lift map is drawn from.
   */
  private heatFromWeights(sunFacing: number, grain: number): number {
    const w = this.w;
    let base = 0;
    for (let k = 0; k < KIND_COUNT; k++) base += w[k] * KIND_HEAT[k];
    base *= 1 - CANOPY_SHADE * w[BiomeKind.Forest];

    // Proportional, because "this face gets more sun" is a gain, not an offset.
    const raw = base * (1 + ASPECT_HEAT * sunFacing + HEAT_GRAIN * (grain * 2 - 1));
    if (raw <= HEAT_KNEE) return raw < 0 ? 0 : raw;
    // Soft ceiling: monotonic, so the ordering of hot sites survives intact.
    const head = 1 - HEAT_KNEE;
    return HEAT_KNEE + head * (1 - Math.exp(-(raw - HEAT_KNEE) / head));
  }
}
