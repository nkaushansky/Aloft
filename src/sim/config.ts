/**
 * ALL tunable feel constants live here — this file is the point of Phase 0.
 *
 * Every value below is a starting guess and is expected to be re-tuned live
 * (the whole object is wired to a lil-gui panel). Comments describe what each
 * knob does to the *feel*, not just its units.
 *
 * The sim reads this object every step, so edits from the GUI apply instantly.
 */
export const config = {
  // ---------------------------------------------------------------- forces
  /** Downward pull (m/s²). The other half of every energy trade. */
  gravity: 9.8,

  /**
   * How strongly airspeed becomes lift: lift accel = liftPerSpeed * airspeed².
   * This sets the cruise speed — the speed where lift exactly cancels gravity
   * (cruise = sqrt(gravity / liftPerSpeed); 0.0245 → ~20 m/s). Raise it and
   * the craft floats at lower speeds; lower it and you must fly fast to stay up.
   */
  liftPerSpeed: 0.0245,

  /**
   * Parasitic drag — bleeds airspeed as dragCoeff * airspeed². This is the
   * slow leak in the energy tank. At 0.0018, drag at trim exactly balances
   * gravity's pull along the glide path at cruise speed, so a hands-off
   * glide holds its speed. Bigger values make the air feel like syrup;
   * smaller makes dives keep forever.
   */
  dragCoeff: 0.0018,

  /**
   * How quickly a lift deficit turns into sink (seconds). When flying slower
   * than cruise the craft "mushes" downward; this is the lag before that sink
   * fully arrives. Short = twitchy settling, long = floaty and forgiving.
   */
  settleResponse: 0.35,

  // ---------------------------------------------------- control authority
  /**
   * Seconds for the virtual stick to ease toward the pressed key. Keyboard
   * input is a hard on/off step; this turns a tap into a gentle deflection
   * that swells and releases. The single biggest "calm vs twitchy" knob —
   * raise it and every maneuver becomes a lean instead of a jerk.
   */
  inputResponse: 0.4,

  /** How fast the nose answers the stick (rad/s at full deflection). */
  pitchRate: 1.2,

  /** How fast the wings answer the stick (rad/s at full deflection). */
  rollRate: 2.2,

  /**
   * Multiplier on the coordinated-turn rate produced by bank
   * (turn rate = factor * gravity * tan(bank) / airspeed). 1.0 is a
   * physically coordinated turn; raise it for snappier carving.
   */
  bankTurnFactor: 1.0,

  /**
   * The attitude the nose settles to hands-off (radians). Slightly nose-down
   * — a real glider trims to its glide, not to level. This is what makes
   * releasing the stick feel like *gliding* instead of leveling-then-mushing.
   * ~ -4°.
   */
  trimPitch: -0.07,

  /**
   * How fast the nose eases back to trimPitch hands-off (per second).
   * Deliberately lazy: the craft should drift home, not snap back. Raise for
   * more forgiveness, lower toward 0 for fully manual pitch.
   */
  pitchAutoLevel: 0.35,

  /**
   * How fast the wings ease back to level hands-off (per second). Kept lazy
   * on purpose: a set bank should *linger* so circling in a thermal is
   * "lean and rest", not constant re-tapping. It still drifts level
   * eventually — forgiveness, in no hurry.
   */
  rollAutoLevel: 0.3,

  /** Hard attitude limits (radians) — keeps the arcade model well-behaved. */
  maxPitch: 1.0, // ~57° — enough for a dramatic dive or zoom-climb
  maxBank: 1.1, // ~63° — enough for a tight carve without flipping

  // -------------------------------------------------------- limits / stall
  /**
   * Stall threshold (m/s). Below this, lift collapses and the nose drops.
   * Keep it well under cruise so normal flying never brushes against it.
   */
  minAirspeed: 9,

  /**
   * Control softens between minAirspeed and minAirspeed * this margin, so the
   * stall announces itself (mushy stick) before it happens. 1.0 = cliff edge.
   */
  stallRecoveryMargin: 1.3,

  /**
   * How firmly a stall pushes the nose down toward stallDiveAngle (per
   * second). Higher = the craft insists on recovering; lower = a longer,
   * floatier mush. This is what keeps the stall gentle and self-recovering.
   */
  stallNoseDrop: 1.4,

  /** The nose-down attitude (radians) a stall recovers toward. ~ -29°. */
  stallDiveAngle: -0.5,

  /** Terminal speed in a dive (m/s). A hard cap so dives stay readable. */
  maxAirspeed: 55,

  // --------------------------------------------------------- launch / reset
  /** Height (m) you relaunch from — the size of your starting energy tank.
   *  At a ~13:1 glide that's ~2.6km of still-air range: enough to reach the
   *  home thermal with room to explore on the way. */
  launchAltitude: 200,

  /** Speed (m/s) you relaunch at. Slightly above cruise: a confident start. */
  launchAirspeed: 24,

  // ----------------------------------------------------------------- camera
  /** How far behind the craft the chase cam sits (m). */
  camDistance: 13,

  /** How far above the craft the chase cam sits (m). */
  camHeight: 4.5,

  /**
   * Follow smoothing (0..1 per 60Hz frame). Low = the camera lags and drifts
   * (dreamy, shows speed through separation); high = locked on (twitchy).
   */
  camLerp: 0.08,

  /** How far ahead of the craft the camera looks (m) — sells forward motion. */
  camLookAhead: 14,

  /** Field of view (degrees). Wider = faster-feeling, smaller-feeling craft. */
  camFov: 60,

  // ------------------------------------------- phase 1: the world & the air
  /** The one hill: a smooth gaussian rise. Height/radius set its character —
   *  tall & tight reads as a peak, low & wide as a long soarable ridge. */
  hillHeight: 220,
  hillRadius: 500,
  hillX: 0,
  hillZ: -1100,

  /** Steady wind speed (m/s). Drives ridge lift; more wind = stronger lift
   *  on windward slopes. */
  windSpeed: 9,

  /** Direction the wind travels toward, degrees. 0 = the way you launch, so
   *  by default the wind is at your back and strikes the hill's near face. */
  windDirDeg: 0,

  /** The thermal field: how many columns dot the land and the average
   *  personality they vary around (±~35% each, per seed). Strength 7 vs a
   *  ~1.4 m/s glide sink means an average core lifts you at ~5.5 m/s — a
   *  boost you feel in your stomach, arriving smoothly because the column's
   *  edge is a gaussian, never a wall. */
  thermalCount: 9,
  thermalSeed: 3,
  thermalRadius: 100,
  thermalStrength: 7,
  thermalTop: 450,

  /** Multiplier on ridge lift (1 = the wind's upslope component, straight). */
  ridgeGain: 1.0,

  /** Height above the ground (m) where ridge lift fades to nothing. */
  ridgeCeiling: 300,

  // --------------------------------------- phase 2: a world worth exploring
  /** Seed for the rolling terrain — a new number is a new countryside. */
  terrainSeed: 7,

  /** How tall the rolling hills get (m). Character of the countryside:
   *  low = plains with soft swells, high = proper hill country. */
  terrainAmplitude: 90,

  /** Wavelength of the rolling (m) — how far apart the swells sit. */
  terrainScale: 700,

  // -------------------------------------- phase 4: the world grows heart
  /**
   * The water surface height (m). Terrain basins below this become lakes —
   * raise it and the world floods into an archipelago, lower it and the
   * lakes shrink to ponds. Water is a wind-tell (ripples), a thermal
   * suppressor (cool ground), and later Q6's shorelines.
   */
  waterLevel: 14,

  /** Free-drifting clouds beyond the thermal caps. Postcard machinery. */
  cloudCount: 6,

  /** How dark a cloud's shadow falls on the land (0 = off). The shadows are
   *  the real prize: the land breathes as they drift over it. */
  cloudShadow: 0.13,

  // ------------------------------------------------ phase 3: face & voice
  /**
   * Where in the day you are, 0..1: golden dawn → noon → golden dusk → back.
   * Never full night — dusk is as dark as Aloft gets. A free sunset to
   * chase, exactly as the art direction promised.
   */
  timeOfDay: 0.15,

  /** Whether time drifts on its own (the slider still works either way). */
  dayAuto: true,

  /** Seconds for a full day loop. Long enough to feel like weather. */
  dayLength: 480,
};

export type Config = typeof config;
