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
   * How fast the wings ease back to level hands-off (per second). Stronger
   * than pitch — rolling out of a turn on its own is pure forgiveness and
   * doesn't fight the glide the way pitch recentering does.
   */
  rollAutoLevel: 0.7,

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
  /** Height (m) you relaunch from — the size of your starting energy tank. */
  launchAltitude: 120,

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
};

export type Config = typeof config;
