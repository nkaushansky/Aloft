/**
 * Every tunable in the game, in one object, commented in feel terms.
 *
 * Inherited discipline from Aloft: no magic numbers in the flight model. If a
 * number changes how something feels, it lives here with a sentence saying
 * what raising it does.
 */

export const config = {
  // ==================================================================
  // FLIGHT — the keystone: total energy = altitude + airspeed,
  // bleeding to drag, restored only by air you found in the world.
  // ==================================================================

  /** Downward pull (m/s²). Half of every energy trade. */
  gravity: 9.81,

  /**
   * Base lift coefficient: lift accel = liftPerSpeed · airspeed² · cos(bank).
   * Sets cruise speed — the speed where lift exactly cancels gravity.
   * cruise = sqrt(gravity / liftPerSpeed). At 0.0230 that is ~20.6 m/s.
   */
  liftPerSpeed: 0.023,

  /**
   * Parasitic drag: bleeds airspeed as dragCoeff · airspeed². The slow leak.
   * Tuned so a hands-off glide at trim holds its speed — raise it and the air
   * turns to syrup, lower it and dives never end.
   */
  dragCoeff: 0.00165,

  /**
   * Induced drag: extra bleed proportional to how hard the wing is working,
   * scaled by 1/V². This is what makes slow, tight, banked circling *cost*
   * something and makes fast straight glides efficient. Without it, spread
   * wings would be free.
   */
  inducedDrag: 2.6,

  /** How quickly a lift deficit becomes sink (seconds of lag). */
  settleResponse: 0.32,

  // ---------------------------------------------- wing configuration
  /**
   * THE SKILL LAYER. Tuck (-1) sweeps the wings: less lift, much less drag,
   * higher top speed — how you cross sink without bleeding out. Spread (+1)
   * opens them: more lift, more drag, slower and tighter — how you core a
   * narrow thermal. Real soaring calls this speed-to-fly; birds just do it.
   */

  /** How much the lift coefficient scales at full spread (multiplier). */
  spreadLiftGain: 0.62,
  /** How much drag scales at full spread (multiplier). */
  spreadDragGain: 1.35,
  /** How much lift is lost at full tuck (multiplier, negative direction). */
  tuckLiftLoss: 0.42,
  /** How much drag is shed at full tuck (multiplier, negative direction). */
  tuckDragLoss: 0.58,
  /** Extra turn rate at full spread — spread wings carve tighter. */
  spreadTurnGain: 0.45,
  /** How much slower you can fly before stalling at full spread. */
  spreadStallRelief: 0.3,
  /** Seconds for the wings to ease between configurations. Never snaps. */
  wingResponse: 0.28,
  /** Top speed multiplier when fully tucked. */
  tuckSpeedGain: 1.55,

  // -------------------------------------------------- control authority
  /**
   * Seconds for the virtual stick to ease toward the commanded input. The
   * single biggest calm-vs-twitchy knob: raise it and every manoeuvre becomes
   * a lean instead of a jerk.
   */
  inputResponse: 0.26,

  /** How fast the nose answers the stick (rad/s at full deflection). */
  pitchRate: 1.35,
  /** How fast the wings answer the stick (rad/s at full deflection). */
  rollRate: 2.6,

  /**
   * Multiplier on the coordinated-turn rate produced by bank
   * (turn = factor · g · tan(bank) / V). 1.0 is physically coordinated.
   */
  bankTurnFactor: 1.05,

  /**
   * Hands-off trim attitude (radians). Slightly nose-down, because a glider
   * trims to its glide, not to level — this is what makes letting go feel
   * like gliding rather than levelling-then-mushing. ~ -4.6°.
   */
  trimPitch: -0.08,

  /** How fast the nose eases home hands-off (per second). Deliberately lazy. */
  pitchAutoLevel: 0.5,
  /**
   * How fast the wings ease level hands-off (per second). Kept lazy so a set
   * bank *lingers* — circling is lean-and-rest, not constant re-tapping.
   */
  rollAutoLevel: 0.34,

  /** Hard attitude limits (radians). */
  maxPitch: 1.15, // ~66° — a real wingover
  maxBank: 1.28, // ~73° — a hard carve without flipping

  // --------------------------------------------------- limits & stall
  /** Stall threshold (m/s) at cruise wing. */
  minAirspeed: 9.5,
  /** Control softens across this multiple of minAirspeed, so stall warns. */
  stallRecoveryMargin: 1.32,
  /** How firmly a stall pushes the nose down (per second). */
  stallNoseDrop: 1.7,
  /** The nose-down attitude a stall recovers toward (radians). */
  stallDiveAngle: -0.55,
  /** Terminal speed at cruise wing (m/s); tuck multiplies it. */
  maxAirspeed: 62,

  // ==================================================================
  // WORLD
  // ==================================================================

  /** The seed. A seed IS a map — same number, same world, forever. */
  seed: 20873,

  /** Water surface height (m). Basins below it become lakes and sea. */
  waterLevel: 0,

  /** Metres per terrain chunk edge. */
  chunkSize: 1024,

  /** Continental relief: the biggest, slowest shape of the land (m). */
  continentAmplitude: 260,
  continentScale: 14000,

  /** Mountain massifs: sharp ridged crests that make ridge lift and wave. */
  mountainAmplitude: 1450,
  mountainScale: 5200,
  /** How much of the map is mountainous, 0..1. Higher = more range. */
  mountainCoverage: 0.46,

  /** Rolling hill country between the ranges (m). */
  hillAmplitude: 150,
  hillScale: 1350,

  /** Fine detail so slopes never read as smooth plastic (m). */
  detailAmplitude: 22,
  detailScale: 190,

  /** Snow starts here (m) and is total this far above (m). */
  snowLine: 1150,
  snowBlend: 320,
  /** Above this slope, ground reads as bare rock regardless of height. */
  rockSlope: 0.62,

  /** Trees stop above this height (m). */
  treeLine: 1000,

  // ==================================================================
  // AIR — seven kinds, all sourced from terrain + sun + wind.
  // ==================================================================

  /** Prevailing wind speed at 1000 m (m/s). */
  windSpeed: 11,
  /** Direction the wind travels *toward*, degrees. 0 = toward -Z. */
  windDirDeg: 24,
  /**
   * How much the wind carries the bird (0..1). At 1.0 the air is a river you
   * are truly floating in; below that it is a cheat that keeps upwind legs
   * from feeling hopeless. 0.85 reads as honest without being cruel.
   */
  windCarry: 0.85,
  /** Wind gradient: how much faster the wind blows per 1000 m of height. */
  windShear: 0.42,
  /** How much the wind veers (degrees) per 1000 m of height. Coriolis-ish. */
  windVeer: 14,

  // ----------------------------------------------------------- thermals
  /** How many live thermals exist near the bird at once. */
  thermalCount: 26,
  /** Radius (m) the search keeps thermals within, around the bird. */
  thermalHorizon: 5200,
  /** Average core radius (m). Varies ±45% per thermal. */
  thermalRadius: 155,
  /** Average core strength (m/s) at full day activity. Varies ±40%. */
  thermalStrength: 6.4,
  /** How high above its base a thermal reaches, as a multiple of cloudBase. */
  thermalTopFactor: 1.0,
  /** Seconds a thermal lives before dying and being reborn elsewhere. */
  thermalLifetime: 210,
  /** Fraction of life spent fading in / out. */
  thermalFadeFraction: 0.22,
  /**
   * How far downwind a thermal leans per metre of height. Real thermals tilt
   * with the wind — this is why you have to *drift* with a climb instead of
   * hovering over the hot spot, and it's a genuine skill.
   */
  thermalTilt: 0.16,
  /** How fast the whole column drifts downwind (fraction of wind speed). */
  thermalDrift: 0.55,
  /** Minimum ground heat (0..1) a thermal will root itself over. */
  thermalMinHeat: 0.34,
  /** Ring of sink around every thermal, as a fraction of core strength. */
  thermalSinkRing: 0.28,
  /** Turbulence at the core edge, 0..1. */
  thermalTurbulence: 0.45,

  // -------------------------------------------------------- ridge lift
  /** Multiplier on the wind's upslope component. */
  ridgeGain: 1.15,
  /** Height above ground (m) where ridge lift fades to nothing. */
  ridgeCeiling: 420,
  /** Minimum slope before a face makes usable ridge lift. */
  ridgeMinSlope: 0.13,
  /** Sink on the lee side, as a fraction of the windward lift. */
  ridgeLeeSink: 0.55,

  // ------------------------------------------------------ mountain wave
  /**
   * The endgame lift. Downwind of a big range, stable air bounces in a
   * standing train of waves — smooth, silent, and reaching far higher than
   * any thermal. It doesn't need the sun, so it is the *only* lift left at
   * night. Marked by lenticular clouds that hang motionless while everything
   * else streams past.
   */
  waveEnabled: true,
  /** Minimum crest height (m) for a ridge to generate wave. */
  waveMinCrest: 900,
  /** Distance between successive crests (m), at reference wind. */
  waveLength: 5800,
  /** Peak vertical velocity in the primary wave (m/s). */
  waveAmplitude: 7.5,
  /** How many crests march downwind before it dies out. */
  waveCrests: 4,
  /** Height (m) above the generating crest where wave lift starts working. */
  waveBaseOffset: 260,
  /** How high the wave reaches (m). This is where the stars are. */
  waveTop: 7200,
  /** Half-width across the wind (m). */
  waveHalfWidth: 2400,
  /** Half-length along the crest (m). */
  waveHalfLength: 6000,
  /** Wave strength at night, as a multiple of daytime (stable air = better). */
  waveNightGain: 1.45,

  // ------------------------------------------------------------- rotor
  /** Rough tumbling air below the wave crests. The doorway, and the toll. */
  rotorStrength: 5.2,
  /** How turbulent, 0..1. */
  rotorTurbulence: 1.0,
  /** Height band (m) below waveBase where rotor lives. */
  rotorDepth: 520,

  // ------------------------------------------------------- convergence
  /**
   * Lines where two air masses meet — a sea breeze pushing inland, a valley
   * exhaling. You fly them *straight* and climb the whole way, which is the
   * fastest travel in the game and the reason the afternoon is the best air.
   */
  convergenceCount: 3,
  convergenceStrength: 3.4,
  convergenceHalfWidth: 340,
  convergenceTopFactor: 1.15,
  /** Time of day when convergence lines start and stop forming. */
  convergenceStartT: 0.42,
  convergenceEndT: 0.86,

  // -------------------------------------------------------------- sink
  /** Baseline sink between features (m/s). The tax on crossing country. */
  ambientSink: 0.55,
  /** How much extra sink downwind of terrain (multiplier). */
  leeSinkGain: 1.0,

  // -------------------------------------------------------- turbulence
  /** Scale (m) of ambient bumpiness. */
  gustScale: 320,
  /** Ambient gust strength (m/s). */
  gustStrength: 1.1,
  /** How fast gusts evolve (Hz-ish). */
  gustSpeed: 0.16,

  // ==================================================================
  // THE DAY — one crossing is one day, and the day is the difficulty curve.
  // ==================================================================

  /** Seconds for a full dawn-to-night crossing. */
  dayLength: 900,
  /** Where the run starts. 0.06 is just-before-sunrise. */
  startTimeOfDay: 0.06,
  /** Whether time advances on its own. Drift mode pins it. */
  dayAuto: true,

  /**
   * Thermal activity lags the sun by this fraction of a day — the ground
   * takes hours to bank its heat, which is why the best air is at 3pm and
   * not at noon.
   */
  heatLag: 0.075,
  /** Cloudbase at dawn and at peak heating (m). */
  cloudBaseDawn: 620,
  cloudBasePeak: 2350,
  /** Depth of the cumulus layer (m). */
  cloudDepth: 620,

  // ==================================================================
  // THE FLOCK — companions, score, and the best wind-tell in the game.
  // ==================================================================

  /** Maximum companions that can fly with you at once. */
  flockMax: 64,
  /** Metres of climb needed to earn one new companion. */
  climbPerCompanion: 130,
  /** How far out companions spread (m). */
  flockRadius: 46,
  /** Seconds for a joining bird to fade in. */
  flockJoinTime: 2.4,
  /** How strongly companions seek lift they can sense (0..1). */
  flockLiftSeek: 0.75,
  /** How strongly they hold formation on the player. */
  flockCohesion: 0.9,
  flockSeparation: 1.35,
  flockAlignment: 0.55,
  /** Speed cap for companions (m/s). */
  flockMaxSpeed: 34,
  /** Time of day when companions start peeling away to roost. */
  roostStartT: 0.86,
  /** Time of day when the last one is gone. */
  roostEndT: 0.955,

  // ==================================================================
  // CAMERA — cinematic, springy, never locked.
  // ==================================================================

  camDistance: 15.5,
  camHeight: 4.2,
  /** How far ahead of the bird the camera looks (m). */
  camLookAhead: 22,
  /** Spring stiffness for the camera position. Low = dreamy lag. */
  camStiffness: 5.2,
  /** Spring stiffness for the look target. Higher = the nose stays framed. */
  camAimStiffness: 7.5,
  /** Base FOV, and how far it opens at top speed. */
  camFov: 62,
  camFovSpeedGain: 21,
  /** How much of the bird's bank the camera copies (0..1). */
  camRollFollow: 0.34,
  /** How far the camera pulls back at top speed (m). */
  camSpeedPullback: 7,
  /** Handheld shake amplitude at full turbulence (m). */
  camShake: 0.42,
  /** Minimum height above ground the camera will hold (m). */
  camGroundClearance: 3.2,

  // ==================================================================
  // LAUNCH & LANDING
  // ==================================================================

  /** Launch height above the starting ridge (m). */
  launchAltitude: 540,
  launchAirspeed: 26,
  /** Below this AGL and this speed, near flat ground, a landing is offered. */
  landingAgl: 24,
  landingSpeed: 15,
  landingSlope: 0.3,
  /** Seconds of settled contact before the run closes. */
  landingSettleTime: 1.1,

  // ==================================================================
  // RENDER / FEEL — the numbers the renderer is allowed to have.
  // ==================================================================

  /** Draw distance (m). Beyond this is fog and imagination. */
  viewDistance: 22000,
  /** How many wind ribbons live around the bird at ultra quality. */
  windRibbons: 1300,
  /** The box (m) ribbons are kept inside, centred on the bird. */
  ribbonBox: 900,
  /** Length of a ribbon in seconds of air travel. */
  ribbonLife: 1.25,
  /** Cumulus puffs per cloud. */
  cloudPuffs: 9,
  /** Contrail appears above this height (m). */
  contrailAltitude: 3400,
  /** Wingtip vortices appear above this g. */
  vortexG: 1.9,

  // ==================================================================
  // AUDIO
  // ==================================================================

  masterVolume: 0.72,
  musicVolume: 0.62,
  windVolume: 0.55,
};

export type Config = typeof config;

/** Cruise speed implied by the current lift coefficient. */
export function cruiseSpeed(cfg: Config, wing = 0): number {
  const cl = cfg.liftPerSpeed * wingLiftScale(cfg, wing);
  return Math.sqrt(cfg.gravity / cl);
}

/** Lift multiplier for a wing configuration in [-1, 1]. */
export function wingLiftScale(cfg: Config, wing: number): number {
  return wing >= 0
    ? 1 + wing * cfg.spreadLiftGain
    : 1 + wing * cfg.tuckLiftLoss; // wing negative → reduces
}

/** Drag multiplier for a wing configuration in [-1, 1]. */
export function wingDragScale(cfg: Config, wing: number): number {
  return wing >= 0 ? 1 + wing * cfg.spreadDragGain : 1 + wing * cfg.tuckDragLoss;
}
