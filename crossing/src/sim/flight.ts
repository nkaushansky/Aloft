import type { Config } from './config';
import { wingDragScale, wingLiftScale } from './config';
import type { BirdState, FlightInput, TerrainProvider, WindField } from './types';
import { makeWindSample } from './types';
import { clamp, damp, smoothstep } from './math';

/**
 * THE FLIGHT MODEL.
 *
 * One idea, inherited unchanged from Aloft phase 0 and still the whole game:
 *
 *     total energy = altitude + airspeed, bleeding to drag
 *
 * Pitch is the lever that trades one for the other. Drag is the leak. And the
 * only thing in the world that can add to the total is air that was already
 * going up — which is why the sky has to be a place worth reading.
 *
 * Three things are new here:
 *
 *   WING CONFIGURATION. `wing` runs -1 (tucked: less lift, much less drag,
 *   far faster) to +1 (spread: more lift, more drag, slower, tighter). This
 *   is speed-to-fly made physical — fast through sink, slow through lift.
 *
 *   INDUCED DRAG. The cost of making lift, rising with the square of the load
 *   factor. Without it a spread wing would be strictly better than a cruise
 *   wing and the entire skill layer would collapse into "hold one button".
 *   It is also what makes a steep circle genuinely expensive, which is what
 *   makes centring a thermal a decision rather than a reflex.
 *
 *   FULL 3D WIND. The bird flies through air that is itself moving in all
 *   three axes. The vertical component of that motion IS the lift; there is
 *   no separate lift term anywhere in this file.
 *
 * The function writes into `out` and allocates nothing. `state` and `out` may
 * be the same object's neighbours in a double buffer, so every field is read
 * before it is written.
 */

const _wind = makeWindSample();

export function stepFlight(
  state: BirdState,
  input: FlightInput,
  dt: number,
  cfg: Config,
  terrain: TerrainProvider,
  wind: WindField,
  out: BirdState,
): BirdState {
  // ---- read everything out of `state` first, then only write to `out` ----
  let px = state.position.x;
  let py = state.position.y;
  let pz = state.position.z;
  let yaw = state.yaw;
  let pitch = state.pitch;
  let roll = state.roll;
  let airspeed = state.airspeed;
  let stickPitch = state.stickPitch;
  let stickRoll = state.stickRoll;
  let wingCfg = state.wing;
  let settle = state.settle;
  let gForce = state.gForce;

  // ---------------------------------------------------- wing configuration
  // Spread minus tuck, eased. The wings never snap between poses — a bird
  // changing shape mid-air is a smooth thing, and so is the handling change.
  const wingTarget = clamp(input.spread - input.tuck, -1, 1);
  wingCfg = damp(wingCfg, wingTarget, 1 / Math.max(cfg.wingResponse, 1e-3), dt);

  const liftScale = wingLiftScale(cfg, wingCfg);
  const dragScale = wingDragScale(cfg, wingCfg);
  const spread = Math.max(wingCfg, 0);
  const tuck = Math.max(-wingCfg, 0);

  // --------------------------------------------------------- stall envelope
  // A spread wing flies slower before it stops flying — that is most of why
  // you spread to core a narrow thermal.
  const vStall = cfg.minAirspeed * (1 - cfg.spreadStallRelief * spread);
  const flying = smoothstep(vStall, vStall * cfg.stallRecoveryMargin, airspeed);
  // Authority never reaches zero: a stall in this game mushes, it does not
  // take the controls away from you.
  const authority = 0.3 + 0.7 * flying;

  // ------------------------------------------------------------- the stick
  const lambdaStick = 1 / Math.max(cfg.inputResponse, 1e-3);
  stickPitch = damp(stickPitch, input.pitch, lambdaStick, dt);
  stickRoll = damp(stickRoll, input.roll, lambdaStick, dt);

  pitch += stickPitch * cfg.pitchRate * authority * dt;
  roll += stickRoll * cfg.rollRate * authority * dt;

  // Hands off, the nose drifts to its glide trim — slightly nose-down,
  // because a glider trims to its glide and not to level. This is what makes
  // letting go feel like gliding instead of levelling-then-mushing.
  if (Math.abs(input.pitch) < 0.05) {
    pitch = damp(pitch, cfg.trimPitch, cfg.pitchAutoLevel, dt);
  }
  // The wings drift level, but lazily on purpose: a set bank should LINGER so
  // that circling is lean-and-rest rather than constant re-tapping.
  if (Math.abs(input.roll) < 0.05) {
    roll = damp(roll, 0, cfg.rollAutoLevel, dt);
  }

  // Stall recovery: the nose is pushed toward a shallow dive until speed
  // comes back. Scaled by (1 - flying), so it only acts inside the stall.
  pitch += (cfg.stallDiveAngle - pitch) * cfg.stallNoseDrop * (1 - flying) * dt;

  pitch = clamp(pitch, -cfg.maxPitch, cfg.maxPitch);
  roll = clamp(roll, -cfg.maxBank, cfg.maxBank);

  // ---------------------------------------------------- coordinated turn
  // Physically, turn rate is g·tan(bank)/V — so slower flight carves tighter,
  // which is the other half of why you spread inside a thermal.
  const turnV = Math.max(airspeed, 4);
  const turnGain = 1 + cfg.spreadTurnGain * spread;
  yaw += -cfg.bankTurnFactor * ((cfg.gravity * Math.tan(roll)) / turnV) * turnGain * dt;

  // ------------------------------------------------------------- airspeed
  // Load factor: how many g the wing is pulling to hold the turn.
  const loadFactor = 1 / Math.max(Math.cos(roll), 0.2);

  const parasitic = cfg.dragCoeff * dragScale * airspeed * airspeed;
  // Induced drag rises with the square of the load and falls with speed. This
  // is the term that makes slow, steep, spread-wing circling cost real energy
  // and fast straight glides cheap. Delete it and the game loses its spine.
  const induced =
    (cfg.inducedDrag * loadFactor * loadFactor * liftScale) / Math.max(airspeed, 6);

  const accel = -cfg.gravity * Math.sin(pitch) - parasitic - induced;
  const vMax = cfg.maxAirspeed * (1 + (cfg.tuckSpeedGain - 1) * tuck);
  airspeed = clamp(airspeed + accel * dt, 0, vMax);

  // ------------------------------------------------- lift deficit -> settle
  // At or above the speed where the wing can carry itself, the bird goes
  // where the nose points. Below that it mushes downward, and banking sheds
  // lift too, so a tight turn costs height on top of costing energy.
  const liftAccel = cfg.liftPerSpeed * liftScale * airspeed * airspeed * Math.cos(roll);
  const deficit = Math.max(0, cfg.gravity - liftAccel);
  const targetSettle = deficit * cfg.settleResponse;
  settle = damp(settle, targetSettle, 1 / Math.max(cfg.settleResponse, 1e-3), dt);

  // ------------------------------------------------------------- the air
  wind.sample(px, py, pz, _wind);

  // ------------------------------------------------------------ integrate
  // Air velocity along the nose, plus the motion of the air itself. The
  // vertical component of the wind IS the lift — there is no separate term.
  const cp = Math.cos(pitch);
  const fx = -Math.sin(yaw) * cp;
  const fy = Math.sin(pitch);
  const fz = -Math.cos(yaw) * cp;

  const carry = cfg.windCarry;
  const gvx = fx * airspeed + _wind.vx * carry;
  const gvy = fy * airspeed - settle + _wind.vy * carry;
  const gvz = fz * airspeed + _wind.vz * carry;

  px += gvx * dt;
  py += gvy * dt;
  pz += gvz * dt;

  // --------------------------------------------------------------- g-force
  // Damped, because the camera shake and the wingtip vortices read off this
  // and neither should chatter on a single rough frame.
  const rawG = loadFactor + Math.abs(stickPitch) * 0.55 * flying;
  gForce = damp(gForce, rawG, 6, dt);

  // ---------------------------------------------------------------- ground
  // Water counts as ground: a lake sits above its bed, and the bird settles
  // on the surface rather than swimming down to it.
  const groundHeight = Math.max(terrain.heightAt(px, pz), terrain.waterLevel());
  let agl = py - groundHeight;
  let landed = false;
  if (agl <= 0.6) {
    landed = true;
    py = groundHeight + 0.6;
    agl = 0.6;
    // Stop descending, but keep the horizontal motion — a landing bird
    // slides to a stop, it does not hit a wall.
    if (gvy < 0) {
      airspeed *= Math.max(0, 1 - dt * 2.2);
    }
  }

  // ------------------------------------------------------------ write out
  out.position.x = px;
  out.position.y = py;
  out.position.z = pz;
  out.groundVel.x = gvx;
  out.groundVel.y = landed ? 0 : gvy;
  out.groundVel.z = gvz;
  out.yaw = yaw;
  out.pitch = pitch;
  out.roll = roll;
  out.airspeed = airspeed;
  out.stickPitch = stickPitch;
  out.stickRoll = stickRoll;
  out.wing = wingCfg;
  out.settle = settle;
  out.flying = flying;
  out.liftRate = _wind.vy;
  out.climbRate = landed ? 0 : gvy;
  out.airKind = _wind.kind;
  out.airIntensity = _wind.intensity;
  out.turbulence = _wind.turbulence;
  out.agl = agl;
  out.energy = cfg.gravity * py + 0.5 * airspeed * airspeed;
  out.gForce = gForce;
  out.stallBreak = 1 - flying;
  out.landed = landed;
  return out;
}

// =====================================================================
// Readouts. The HUD shows these, and learning to fly by them is most of
// what separates a forty-kilometre day from a two-hundred-kilometre one.
// =====================================================================

/**
 * Instantaneous glide ratio: metres forward per metre down. Clamped, because
 * a bird sitting inside a thermal is momentarily going UP, and "infinity" is
 * not a useful thing to put on an instrument.
 */
export function glideRatio(state: BirdState, cfg: Config): number {
  void cfg;
  const horiz = Math.hypot(state.groundVel.x, state.groundVel.z);
  const sink = -state.climbRate;
  if (!(sink > 0.05)) return 60;
  const ld = horiz / sink;
  return Number.isFinite(ld) ? clamp(ld, 0, 60) : 60;
}

/**
 * The speed that maximises distance for a given wing, in still air.
 *
 * Sink rate at speed V is (parasitic + induced) drag power over weight, so
 * glide ratio is V / sink(V). Differentiating and solving gives the classic
 * result that best glide sits where parasitic drag equals induced drag:
 *
 *     Cd·s·V²  =  k·n²·L / V     →     V = (k / (Cd·s))^(1/3)
 *
 * with the load factor n = 1 in straight flight. It is a cube root rather
 * than the square root you get for a fixed-lift aeroplane because our induced
 * term falls as 1/V rather than 1/V².
 */
export function bestGlideSpeed(cfg: Config, wing: number): number {
  const cd = cfg.dragCoeff * wingDragScale(cfg, wing);
  const k = cfg.inducedDrag * wingLiftScale(cfg, wing);
  const v = Math.cbrt(k / Math.max(cd, 1e-6));
  return clamp(v, cfg.minAirspeed * 1.05, cfg.maxAirspeed * 0.9);
}

/**
 * The speed that minimises sink — how you stay up longest, as opposed to
 * going furthest. Always slower than best glide; in a weak, wide thermal it
 * is the speed you want.
 */
export function minSinkSpeed(cfg: Config, wing: number): number {
  // Minimum sink sits where d/dV of the total drag power is zero, which for
  // these terms lands a fixed fraction below best glide. 0.76 is the analytic
  // ratio for a cubic/linear pair, and it matches the feel in the air.
  return clamp(bestGlideSpeed(cfg, wing) * 0.76, cfg.minAirspeed * 1.02, cfg.maxAirspeed);
}

/**
 * MacCready speed-to-fly: the airspeed you SHOULD be flying given the air you
 * are in right now. Fast through sink, slow through lift. It is the oldest
 * idea in cross-country soaring and the single best teaching tool in the
 * game — the HUD shows it as a small bug on the speed scale, and a player who
 * learns to chase it will fly twice as far without being told why.
 *
 * `netAirVertical` is the vertical speed of the air itself (m/s, positive up).
 */
export function speedToFly(cfg: Config, netAirVertical: number, wing: number): number {
  const base = bestGlideSpeed(cfg, wing);
  // Monotonic and gentle: about 1.6 m/s of extra airspeed per m/s of sink,
  // tapering so that catastrophic sink does not ask for an impossible speed.
  const push = -netAirVertical;
  const adjust = Math.sign(push) * Math.sqrt(Math.abs(push)) * 4.2;
  return clamp(base + adjust, minSinkSpeed(cfg, wing) * 0.92, cfg.maxAirspeed * 0.95);
}
