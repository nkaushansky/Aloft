/**
 * THE CONTRACT.
 *
 * Every interface the sim and the renderer share lives here. Nothing in this
 * file imports Three.js or touches the DOM; the renderer is free to import
 * from the sim, never the reverse.
 *
 * The architectural bet inherited from Aloft: the flight model never knows
 * where the ground came from, where the air came from, or what device is
 * pushing the stick. It asks providers. That is what makes it possible to
 * swap procedural terrain for real elevation data, or seven kinds of air for
 * one, without touching the thing that actually has to feel good.
 */

import type { Vec3 } from './math';

export type { Vec3 };

// ============================================================== TERRAIN

export interface TerrainSample {
  /** Ground height (m) above datum. */
  height: number;
  /** Surface normal, unit length. */
  nx: number;
  ny: number;
  nz: number;
  /** 0 (flat) .. 1 (vertical) — cheap slope readout derived from the normal. */
  slope: number;
}

export interface TerrainProvider {
  /** Ground height (m) at a world XZ point. Hot path — keep it cheap. */
  heightAt(x: number, z: number): number;
  /** Height plus normal and slope. `out` is reused to avoid allocation. */
  sampleAt(x: number, z: number, out: TerrainSample): TerrainSample;
  /** The height the water surface sits at. Terrain below this is lakebed. */
  waterLevel(): number;
  /** Highest ground the generator can produce — used to size the sky. */
  maxHeight(): number;
}

// =============================================================== BIOME

export enum BiomeKind {
  Water = 0,
  Shore = 1,
  Meadow = 2,
  Forest = 3,
  Scrub = 4,
  Desert = 5,
  Rock = 6,
  Snow = 7,
}

export interface BiomeSample {
  kind: BiomeKind;
  /**
   * 0..1 how strongly this ground converts sunlight into rising air. Bare
   * rock and desert bake; forest and water stay cool. This is the single
   * number that turns the map into a lift map.
   */
  heat: number;
  /** 0..1 canopy density — drives tree scatter and suppresses thermals. */
  forest: number;
  /** 0..1 wetness — drives colour and shore detail. */
  moisture: number;
  /** Base albedo, linear 0..1. The renderer tints and shades from here. */
  r: number;
  g: number;
  b: number;
}

export interface BiomeProvider {
  sampleAt(x: number, z: number, out: BiomeSample): BiomeSample;
  /** Just the heat term — the wind field calls this a lot. */
  heatAt(x: number, z: number): number;
}

// ================================================================= SKY

export type DayPhase = 'dawn' | 'morning' | 'noon' | 'afternoon' | 'evening' | 'night';

export const DAY_PHASES: readonly DayPhase[] = [
  'dawn',
  'morning',
  'noon',
  'afternoon',
  'evening',
  'night',
];

/**
 * Everything about the sun, the light and the state of the atmosphere at a
 * moment in the day. The renderer reads it for colour; the wind field reads
 * it for how much energy the sky has to give.
 */
export interface SkyState {
  /** 0..1 through the crossing's single day. */
  t: number;
  phase: DayPhase;
  /** 0..1 progress within the current phase. */
  phaseBlend: number;
  /** Unit vector from the world toward the sun. */
  sunDir: Vec3;
  /** Sun elevation in radians. Negative once it is below the horizon. */
  sunElevation: number;
  /** Unit vector toward the moon (roughly opposite the sun). */
  moonDir: Vec3;

  /**
   * 0..1 how much convective energy the ground has banked. Lags the sun —
   * peaks mid-afternoon, not at noon, exactly like real air. This is the
   * master gain on every thermal in the world.
   */
  thermalActivity: number;
  /** Height (m) where cumulus condense. Rises through the day. */
  cloudBase: number;
  /** Depth (m) of the cumulus layer above cloudBase. */
  cloudDepth: number;
  /** 0..1 how organised the convection is — drives cloud-street formation. */
  streetFactor: number;

  /** 0..1 visibility of stars and aurora. */
  starVisibility: number;
  auroraStrength: number;
  /** 0..1 valley mist at dawn. */
  mistStrength: number;

  // --- colour, linear RGB, for the renderer -----------------------------
  sunColor: Vec3;
  sunIntensity: number;
  skyZenith: Vec3;
  skyHorizon: Vec3;
  groundBounce: Vec3;
  fogColor: Vec3;
  /** Fog density coefficient — the renderer's exponential-squared fog. */
  fogDensity: number;
  ambient: Vec3;
  ambientIntensity: number;
  /** 0..1 how much bloom/exposure the grade should push. */
  exposure: number;
}

// ================================================================= AIR

/**
 * The seven kinds of air. Every one of these is a real thing a sailplane
 * pilot learns to find; the whole design of the game is that they are
 * *visible* and *sourced from the terrain* rather than sprinkled on it.
 */
export enum AirKind {
  /** Nothing much happening. Glide and lose height. */
  Still = 0,
  /** A rising column over sun-baked ground. Circle to climb. */
  Thermal = 1,
  /** Wind deflected up a windward slope. Beat back and forth along it. */
  Ridge = 2,
  /** Standing wave downwind of a range. Smooth, enormous, reaches the stars. */
  Wave = 3,
  /** Tumbling turbulence under a wave or in a lee. Rough — and the doorway. */
  Rotor = 4,
  /** A line where two air masses meet. Fly it straight, climb the whole way. */
  Convergence = 5,
  /** Descending air. The price of everything above. Cross it fast. */
  Sink = 6,
}

export const AIR_KIND_NAMES: Record<AirKind, string> = {
  [AirKind.Still]: 'still',
  [AirKind.Thermal]: 'thermal',
  [AirKind.Ridge]: 'ridge',
  [AirKind.Wave]: 'wave',
  [AirKind.Rotor]: 'rotor',
  [AirKind.Convergence]: 'convergence',
  [AirKind.Sink]: 'sink',
};

export interface WindSample {
  /** Total air velocity in world space (m/s). y positive is rising. */
  vx: number;
  vy: number;
  vz: number;
  /** Which feature dominates here — drives visuals, audio and the vario. */
  kind: AirKind;
  /** 0..1 how strongly the dominant feature is expressed. */
  intensity: number;
  /** 0..1 roughness. Shakes the camera, roughens the wing, colours the sound. */
  turbulence: number;
}

export function makeWindSample(): WindSample {
  return { vx: 0, vy: 0, vz: 0, kind: AirKind.Still, intensity: 0, turbulence: 0 };
}

// --- the individual air features, exposed so the renderer can draw them ---

export interface ThermalInfo {
  /** Current centre (thermals drift downwind as they live). */
  x: number;
  z: number;
  /** Where it was born — the ground source stays put. */
  sourceX: number;
  sourceZ: number;
  radius: number;
  /** Core vertical velocity (m/s) at full life. */
  strength: number;
  /** Ground height under the source. */
  base: number;
  /** Height where the column dissolves. */
  top: number;
  /** 0..1 lifecycle: fades in, matures, dies. Reborn elsewhere afterwards. */
  life: number;
  /** Age in seconds. */
  age: number;
  /** Downwind lean (m of horizontal offset per m of height). */
  tiltX: number;
  tiltZ: number;
  /** Whether it caps with a cumulus — false over dry air ("blue thermal"). */
  hasCloud: boolean;
  /** Stable per-thermal random, for uncorrelated visual variation. */
  jitter: number;
}

export interface WaveInfo {
  /** The ridge crest that generates it. */
  crestX: number;
  crestZ: number;
  /** Unit vector pointing downwind (the direction the wave train marches). */
  dirX: number;
  dirZ: number;
  /** Distance between successive crests (m). */
  wavelength: number;
  /** Peak vertical velocity (m/s) in the first crest. */
  amplitude: number;
  /** Half-width of the wave bar, across the wind (m). */
  halfWidth: number;
  /** Length of the wave bar, along the crest (m). */
  halfLength: number;
  /** Lowest height the wave works at, and where it tops out. */
  base: number;
  top: number;
  /** How many crests downwind before it dies out. */
  crests: number;
}

export interface ConvergenceInfo {
  /** Polyline of the convergence line in XZ. At least two points. */
  points: Array<{ x: number; z: number }>;
  strength: number;
  halfWidth: number;
  base: number;
  top: number;
  /** 0..1 how developed the line is right now. */
  life: number;
}

/**
 * The air abstraction. `sample` is called several times per frame per actor,
 * so it must be allocation-free and cheap.
 */
export interface WindField {
  sample(x: number, y: number, z: number, out: WindSample): WindSample;
  /** Advance thermal lifecycles, wave strength, convergence development. */
  update(dt: number, sky: SkyState): void;
  /** The prevailing wind at a height (m/s, world space). */
  prevailingAt(y: number, out: Vec3): Vec3;

  // --- read-only feature lists for the renderer -------------------------
  thermals(): readonly ThermalInfo[];
  waves(): readonly WaveInfo[];
  convergences(): readonly ConvergenceInfo[];
}

// ============================================================== ACTOR

/** Wing configuration: -1 fully tucked, 0 cruise, +1 fully spread. */
export type WingConfig = number;

/** Normalized, device-agnostic control input. */
export interface FlightInput {
  /** +1 nose up, -1 nose down. */
  pitch: number;
  /** +1 roll right, -1 roll left. */
  roll: number;
  /** 0..1 how hard the wings are tucked (sweep back, dive fast). */
  tuck: number;
  /** 0..1 how hard the wings are spread (slow, tight, high drag). */
  spread: number;
}

export function makeInput(): FlightInput {
  return { pitch: 0, roll: 0, tuck: 0, spread: 0 };
}

/** Everything about the bird, for one sim step. */
export interface BirdState {
  position: Vec3;
  /** yaw 0 faces -Z; positive yaw turns left. */
  yaw: number;
  /** positive is nose-up. */
  pitch: number;
  /** positive is right-wing-down. */
  roll: number;

  /** Speed through the air along the nose (m/s). */
  airspeed: number;
  /** Ground velocity (m/s) — air velocity plus wind. For the HUD and trails. */
  groundVel: Vec3;

  /** Smoothed stick, in [-1,1]. */
  stickPitch: number;
  stickRoll: number;
  /** Smoothed wing configuration, -1..+1. */
  wing: WingConfig;

  /** Extra sink from flying below the wing's cruise speed (m/s). */
  settle: number;
  /** 1 fully flying, 0 fully stalled. */
  flying: number;

  /** Vertical air speed at our position (m/s) — the vario's soul. */
  liftRate: number;
  /** Net vertical speed (m/s): flight path + air - settle. */
  climbRate: number;
  /** Which kind of air we are in right now. */
  airKind: AirKind;
  /** 0..1 how strongly. */
  airIntensity: number;
  /** 0..1 how rough. */
  turbulence: number;

  /** Height above the ground directly below (m). */
  agl: number;
  /** Specific total energy (J/kg): g*h + v^2/2. */
  energy: number;

  /** Wing loading in g — drives vortices, wing bend and camera. */
  gForce: number;
  /** 0..1 how deep in a stall break the bird is. */
  stallBreak: number;
  /** True once the bird has settled on the ground. */
  landed: boolean;
}

// ============================================================== FLOCK

export interface FlockBird {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Banking angle for the renderer. */
  roll: number;
  pitch: number;
  yaw: number;
  /** 0..1 — fades in when joining, out when leaving. */
  presence: number;
  /** Wing-beat phase for the renderer. */
  flap: number;
  /** Per-bird size and colour variation. */
  scale: number;
  tint: number;
  /** 0 = following the player, 1 = peeling away to roost. */
  leaving: number;
  /** Stable id. */
  id: number;
}

// ============================================================== SESSION

export type RunPhase =
  | 'title'
  | 'launching'
  | 'flying'
  | 'landing'
  | 'summary';

export interface RunStats {
  seed: number;
  seedName: string;
  /** Great-circle-ish distance from launch, in metres. */
  distance: number;
  /** Total path length flown, metres. */
  pathLength: number;
  peakAltitude: number;
  peakSpeed: number;
  /** Seconds airborne. */
  duration: number;
  /** Metres of altitude gained, split by the air that gave it. */
  climbBySource: Record<AirKind, number>;
  /** Biggest single unbroken climb, metres. */
  bestClimb: number;
  /** Companions currently flying with you, and the most you ever held. */
  flock: number;
  peakFlock: number;
  /** Day phase at touchdown. */
  endPhase: DayPhase;
  /** Time of day at touchdown, 0..1. */
  endTime: number;
  /** Did the bird reach the night? */
  reachedNight: boolean;
  /** Did the bird ever climb in wave? */
  touchedWave: boolean;
  /** Sampled route for the summary map: world XZ plus altitude. */
  route: Array<{ x: number; z: number; y: number; t: number; kind: AirKind }>;
}

export interface LogbookEntry {
  seed: number;
  seedName: string;
  distance: number;
  peakAltitude: number;
  duration: number;
  flock: number;
  reachedNight: boolean;
  touchedWave: boolean;
  endPhase: DayPhase;
  /** Epoch ms. */
  when: number;
}

// ============================================================== QUALITY

export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';

export interface QualitySettings {
  tier: QualityTier;
  pixelRatioCap: number;
  /** Radius, in chunks, of streamed terrain. */
  terrainRings: number;
  /** Vertices per side of a terrain chunk at LOD0. */
  chunkResolution: number;
  windRibbons: number;
  cloudPuffs: number;
  scatterDensity: number;
  bloom: boolean;
  godrays: boolean;
  motionBlur: boolean;
  shadowMap: boolean;
  waterReflection: boolean;
}
