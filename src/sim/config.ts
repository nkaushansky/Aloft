/**
 * ALL tunable feel constants live here. The glide itself — gravity, lift, drag,
 * trim, the eased stick — was tuned by hand over the first prototype and is
 * the one thing the re-envisioning did not touch. Comments describe what each
 * knob does to the *feel*, not just its units.
 *
 * The sim reads this object every step; `?tune` opens a live panel over it.
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

  // ---------------------------------------------------------------- breath
  /**
   * Wingbeats cost breath; gliding is free. A full breath is this many
   * seconds of beating — enough to leave a lakeshore and find the first
   * rising air, never enough to ignore it.
   */
  breathSeconds: 9,

  /** Push along the nose while beating (m/s²). Felt as a lean, not a kick. */
  beatThrust: 4.6,

  /** Upward carry while beating at cruise (m/s). */
  beatLift: 2.6,

  /** Breath returned per second: gliding / in rising air / at rest. */
  breathGlide: 0.018,
  breathLift: 0.1,
  breathRest: 0.34,

  /** Breath returned by one of the flock's dropped feathers. */
  breathFeather: 0.07,

  // ------------------------------------------------------- ground and water
  /** How near the surface (m) the air starts to cushion you. */
  cushionHeight: 7,

  /** Fraction of sink the cushion takes away right at the surface. */
  cushion: 0.6,

  /** The bird's belly clearance (m) when skimming. */
  clearance: 1.1,

  /** Below this airspeed, a level touch becomes a landing. */
  landSpeed: 13.5,

  /** Water deeper than this can't be stood in; the bird skims it instead. */
  wadeDepth: 0.62,

  /** Speed at which a leap leaves the ground (m/s). */
  leapSpeed: 13,

  // ---------------------------------------------------------------- the air
  /**
   * How much the wind carries the craft (0..1). Airspeed is speed *through*
   * the air — but the air itself moves. Downwind is visibly faster, upwind
   * is honest work.
   */
  windCarry: 0.6,

  /** Multiplier on ridge lift (1 = the wind's upslope component, straight). */
  ridgeGain: 1.0,

  /** Height above the ground (m) where ridge lift fades to nothing. */
  ridgeCeiling: 320,

  /** Flying in company: drag saved per companion, up to the cap. */
  draftPerBird: 0.035,
  draftMax: 0.2,

  // --------------------------------------------------------- launch / reset
  launchAltitude: 60,
  launchAirspeed: 21,

  // ----------------------------------------------------------------- camera
  /** How far behind the bird the chase cam sits (m). */
  camDistance: 9.6,

  /** How far above the bird the chase cam sits (m). */
  camHeight: 2.9,

  /**
   * Follow smoothing (per second). Low = the camera lags and drifts (dreamy,
   * shows speed through separation); high = locked on (twitchy).
   */
  camFollow: 4.2,

  /** How far ahead of the bird the camera looks (m). */
  camLookAhead: 16,

  /** How much of the bird's bank the horizon shares. */
  camRoll: 0.22,

  /** Field of view (degrees), and how much speed opens it. */
  camFov: 56,
  camFovSpeed: 12,
};

export type Config = typeof config;
