/**
 * THE CHASE CAMERA — where most of "does this feel AA" actually lives.
 *
 * Two springs, never a lerp. The camera *body* is soft (cfg.camStiffness) so
 * it lags, overshoots gently and drifts; the *aim point* is stiffer
 * (cfg.camAimStiffness) so the bird stays framed no matter how far behind the
 * body falls. That difference — a loose body with a tight eye — is the whole
 * trick. A single spring on a lookAt target gives you a tripod; two springs
 * give you an operator.
 *
 * The second trick: the camera sits behind the bird along its GROUND VELOCITY,
 * not its nose. In a crosswind a soaring bird crabs, and a camera locked to
 * the nose hides that completely — the world just slides sideways for no
 * reason. Following the track shows the crab honestly. We blend a little back
 * toward the nose (NOSE_BIAS) so the frame never goes fully abeam.
 *
 * Speed is sold twice, both eased and both laggy: the FOV opens by up to
 * cfg.camFovSpeedGain and the body pulls back cfg.camSpeedPullback. A tuck
 * should feel like the horizon is being pulled through the lens; this is most
 * of how that happens.
 *
 * No allocation per frame — module scratch vectors below, everything else is
 * scalar state on the instance.
 */

import * as THREE from 'three';
import type { Config } from '../../sim/config';
import { cruiseSpeed } from '../../sim/config';
import { clamp, clamp01, damp, easeInOutCubic, lerp, smoothstep } from '../../sim/math';
import { valueNoise2 } from '../../sim/noise';
import type { BirdState, SkyState, TerrainProvider } from '../../sim/types';

export type CameraMode = 'chase' | 'orbit' | 'landing' | 'launch';

// ------------------------------------------------------------- framing

/**
 * Ground speed under VEL_TRUST_LO is numerical noise (a parked bird, a stall
 * break) and its direction must not be allowed to spin the camera; over
 * VEL_TRUST_HI the track is the truth. Between the two we cross-fade to the
 * nose, which is always well defined.
 */
const VEL_TRUST_LO = 0.5;
const VEL_TRUST_HI = 6;

/** How far the framing is pulled back toward the nose from the track. */
const NOSE_BIAS = 0.22;

/** Rise-over-run of the flight path is clamped here before it moves anything. */
const SLOPE_LIMIT = 1.2;
/** How much of that slope the body follows — the camera climbs in a dive. */
const DIVE_FOLLOW = 0.35;
/** How much of it the aim point follows. Under 1 so steep dives stay readable. */
const AIM_SLOPE = 0.7;

// ---------------------------------------------------------------- speed

/**
 * Soft saturation on the speed term: quadratic at the bottom so cruising
 * never wobbles the FOV, and it keeps growing past cfg.maxAirspeed so a full
 * tuck (which can beat that number by half again) still has somewhere to go.
 */
const SPEED_CURVE = 1.6;
/** Speed effects trail the airspeed on purpose — exact tracking reads as a bug. */
const SPEED_LAG = 2.2;

/** How fast the horizon tilt catches up to the bird's bank. */
const ROLL_LAG = 4.5;

// ----------------------------------------------------------- turbulence

/** Rattle and sway, in Hz-ish. The fast one is what makes rotor feel violent. */
const SHAKE_FAST = 11;
const SHAKE_SLOW = 3.3;
const SHAKE_SEED = 9137;
/** Vertical shake is damped — handheld reads as lateral, not bouncing. */
const SHAKE_VERTICAL = 0.6;
/** Aim-point jitter per metre of body shake. Converts the rattle into rotation. */
const SHAKE_AIM = 1.6;
/** Roll jitter (radians) per metre of body shake. */
const SHAKE_ROLL = 0.06;

// ------------------------------------------------------------ clearance

/** Ground push releases at this rate. It engages instantly — never clip a hill. */
const CLEAR_RELEASE = 3;
/** When pushed up off the ground, drop the aim this much per metre of push. */
const AIM_DROP = 0.35;

// ----------------------------------------------------------------- modes

/** Landing: wider, lower, slower — the shot settles while the bird does. */
const LANDING_DIST = 1.5;
const LANDING_HEIGHT = 0.5;
const LANDING_AHEAD = 0.55;
const LANDING_SPRING = 0.5;

/** Launch: an establishing shot on a long lens that sweeps down into the chase. */
const LAUNCH_DIST_MUL = 9;
const LAUNCH_HEIGHT = 150;
const LAUNCH_FOV_TIGHTEN = 8;
const LAUNCH_SPRING = 0.55;
/** How far the opening angle swings toward the sun's side, in radians. */
const LAUNCH_SUN_BIAS = 0.45;

/** Title orbit: one revolution every ~2.5 minutes, breathing in height. */
const ORBIT_RATE = 0.041;
const ORBIT_HEIGHT = 0.28;
const ORBIT_DRIFT_RATE = 0.07;
const ORBIT_DRIFT_AMP = 0.11;
const ORBIT_SPRING = 0.35;

/** damp() with this dt collapses to the target exactly — used by snap(). */
const SNAP_DT = 1e6;

// Module scratch. Nothing in update() may allocate.
const _out = new THREE.Vector3();
const _look = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();

export class ChaseCamera {
  readonly camera: THREE.PerspectiveCamera;

  private readonly cfg: Config;
  private readonly terrain: TerrainProvider;
  /** Cached once — the camera must not dive under a lake either. */
  private readonly waterLevel: number;

  /** The two springs. `pos` is the body, `aim` is the eye. */
  private readonly pos = new THREE.Vector3();
  private readonly aim = new THREE.Vector3();
  /** This frame's ideals, before the springs get hold of them. */
  private readonly wantPos = new THREE.Vector3();
  private readonly wantAim = new THREE.Vector3();

  private readonly orbitTarget = new THREE.Vector3();
  private orbitRadius = 900;
  private orbitAngle = 0;

  private mode: CameraMode = 'chase';
  private blend = 1;
  private time = 0;

  private speed01 = 0;
  private rollAngle = 0;
  /** Metres of ground-clearance push currently applied. */
  private ground = 0;
  private shakeAmt = 0;

  private wantFov: number;
  private wantStiff: number;
  private wantAimStiff: number;

  constructor(cfg: Config, terrain: TerrainProvider) {
    this.cfg = cfg;
    this.terrain = terrain;
    this.waterLevel = terrain.waterLevel();
    this.wantFov = cfg.camFov;
    this.wantStiff = cfg.camStiffness;
    this.wantAimStiff = cfg.camAimStiffness;

    // near 0.5 keeps the bird's own feathers out of the near plane; far is the
    // whole draw distance, because the sky dome and the far ranges live there.
    this.camera = new THREE.PerspectiveCamera(cfg.camFov, 1, 0.5, cfg.viewDistance);
    this.camera.position.set(0, 0, 0);
  }

  // ------------------------------------------------------------- control

  setMode(mode: CameraMode, opts?: { target?: THREE.Vector3; radius?: number }): void {
    // main.ts calls setMode('landing') every frame once the bird is down, so
    // re-entering a mode has to be free and side-effect free.
    if (mode === this.mode && !opts) return;
    if (mode !== this.mode) {
      this.mode = mode;
      // The launch sweep owns the blend; everything else is fully arrived.
      this.blend = mode === 'launch' ? 0 : 1;
    }
    if (opts?.target) this.orbitTarget.copy(opts.target);
    if (opts?.radius !== undefined) this.orbitRadius = Math.max(1, opts.radius);
  }

  /** 0 = fully at the launch establishing shot, 1 = fully in the chase. */
  setBlend(t: number): void {
    this.blend = clamp01(t);
  }

  /** Current shake, 0..1. The post chain shakes the frame off the same number. */
  get shake(): number {
    return this.shakeAmt;
  }

  // -------------------------------------------------------------- update

  update(dt: number, bird: BirdState, sky: SkyState, aspect: number): void {
    // A backgrounded tab hands back a huge dt; clamping here stops the camera
    // teleporting a kilometre on the first frame after a resume.
    const d = dt > 0.1 ? 0.1 : dt;
    this.time += d;
    if (this.mode === 'orbit') this.orbitAngle += ORBIT_RATE * d;

    this.desire(bird, sky, d);

    // THE SPRINGS. Body soft, eye stiff — see the header.
    this.pos.x = damp(this.pos.x, this.wantPos.x, this.wantStiff, d);
    this.pos.y = damp(this.pos.y, this.wantPos.y, this.wantStiff, d);
    this.pos.z = damp(this.pos.z, this.wantPos.z, this.wantStiff, d);
    this.aim.x = damp(this.aim.x, this.wantAim.x, this.wantAimStiff, d);
    this.aim.y = damp(this.aim.y, this.wantAim.y, this.wantAimStiff, d);
    this.aim.z = damp(this.aim.z, this.wantAim.z, this.wantAimStiff, d);

    // Ground clearance, asymmetric: instant on the way up so a ridge can never
    // eat the lens, slow on the way down so the release is invisible.
    const floor =
      Math.max(this.terrain.heightAt(this.pos.x, this.pos.z), this.waterLevel) +
      this.cfg.camGroundClearance;
    const need = floor - this.pos.y;
    this.ground =
      need > this.ground ? need : damp(this.ground, need > 0 ? need : 0, CLEAR_RELEASE, d);
    if (this.ground < 0) this.ground = 0;

    // Horizon tilt: copy a fraction of the bank, smoothed so snap rolls swell.
    this.rollAngle = damp(this.rollAngle, this.cfg.camRollFollow * bird.roll, ROLL_LAG, d);

    // Turbulence, from noise on the clock rather than Math.random, so it is a
    // continuous wobble instead of per-frame static. Squaring the turbulence
    // keeps wave and smooth thermals glass-still and lets rotor really rattle.
    const turb = clamp01(bird.turbulence);
    this.shakeAmt = turb * turb;
    const amp = this.cfg.camShake * this.shakeAmt;
    const sx = amp * this.wobble(0);
    const sy = amp * SHAKE_VERTICAL * this.wobble(37.1);
    const sz = amp * this.wobble(71.3);

    // Compose the output. The spring state itself stays clean — clearance and
    // shake are applied on the way out, never folded back into `pos`.
    _out.set(this.pos.x + sx, this.pos.y + this.ground + sy, this.pos.z + sz);
    _look.set(
      this.aim.x + sx * SHAKE_AIM,
      this.aim.y + sy * SHAKE_AIM - this.ground * AIM_DROP,
      this.aim.z + sz * SHAKE_AIM,
    );

    // Roll the up vector about the view axis before lookAt — that tilts the
    // horizon smoothly without ever fighting the aim.
    _fwd.subVectors(_look, _out);
    const flen = _fwd.length();
    if (flen > 1e-4) {
      _fwd.multiplyScalar(1 / flen);
      _up.set(0, 1, 0).applyAxisAngle(_fwd, this.rollAngle + amp * SHAKE_ROLL * this.wobble(13.7));
    } else {
      _up.set(0, 1, 0);
    }

    this.camera.position.copy(_out);
    this.camera.up.copy(_up);
    this.camera.lookAt(_look);

    if (
      Math.abs(this.camera.fov - this.wantFov) > 1e-3 ||
      Math.abs(this.camera.aspect - aspect) > 1e-6
    ) {
      this.camera.fov = this.wantFov;
      this.camera.aspect = aspect;
      this.camera.updateProjectionMatrix();
    }
    // Everything downstream this frame (sun projection, culling, streaming)
    // reads the camera immediately, so it must not be a frame stale.
    this.camera.updateMatrixWorld();
  }

  /** Place the camera at its ideal with no spring lag at all. */
  snap(bird: BirdState): void {
    // SNAP_DT drives every damp() inside desire() straight to its target.
    this.desire(bird, undefined, SNAP_DT);
    this.pos.copy(this.wantPos);
    this.aim.copy(this.wantAim);
    this.rollAngle = this.cfg.camRollFollow * bird.roll;
    this.shakeAmt = 0;

    const floor =
      Math.max(this.terrain.heightAt(this.pos.x, this.pos.z), this.waterLevel) +
      this.cfg.camGroundClearance;
    this.ground = Math.max(0, floor - this.pos.y);

    _out.copy(this.pos);
    _out.y += this.ground;
    _look.copy(this.aim);
    _look.y -= this.ground * AIM_DROP;
    _fwd.subVectors(_look, _out);
    const flen = _fwd.length();
    _up.set(0, 1, 0);
    if (flen > 1e-4) _up.applyAxisAngle(_fwd.multiplyScalar(1 / flen), this.rollAngle);

    this.camera.position.copy(_out);
    this.camera.up.copy(_up);
    this.camera.lookAt(_look);
    this.camera.fov = this.wantFov;
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
  }

  dispose(): void {
    // No geometry, material or texture is owned here — the camera is pure
    // state. Kept for symmetry with every other renderer module.
    this.camera.clear();
  }

  // ------------------------------------------------------------ internals

  /** Continuous [-1,1] wobble: a fast rattle over a slow sway. */
  private wobble(phase: number): number {
    const fast = valueNoise2(this.time * SHAKE_FAST + phase, phase * 0.5, SHAKE_SEED) * 2 - 1;
    const slow = valueNoise2(this.time * SHAKE_SLOW + phase, phase * 0.5 + 19, SHAKE_SEED) * 2 - 1;
    return fast * 0.6 + slow * 0.4;
  }

  /**
   * Fills wantPos / wantAim / wantFov / spring rates for this frame. `dt` only
   * drives the internal easings, so snap() can pass SNAP_DT and get the fully
   * arrived answer. Never advances this.time or the orbit angle.
   */
  private desire(bird: BirdState, sky: SkyState | undefined, dt: number): void {
    const cfg = this.cfg;

    if (this.mode === 'orbit') {
      // The title shot: a slow circle that breathes in height. The bird is
      // irrelevant here, so nothing about it may enter the framing.
      const r = this.orbitRadius;
      const bob = Math.sin(this.time * ORBIT_DRIFT_RATE) * ORBIT_DRIFT_AMP;
      this.wantPos.set(
        this.orbitTarget.x + Math.cos(this.orbitAngle) * r,
        this.orbitTarget.y + r * (ORBIT_HEIGHT + bob),
        this.orbitTarget.z + Math.sin(this.orbitAngle) * r,
      );
      // Aim a touch above the target so the horizon sits low and the sky —
      // which is the actual subject of this game — gets the frame.
      this.wantAim.set(this.orbitTarget.x, this.orbitTarget.y + r * 0.06, this.orbitTarget.z);
      this.speed01 = damp(this.speed01, 0, SPEED_LAG, dt);
      this.wantFov = cfg.camFov;
      this.wantStiff = cfg.camStiffness * ORBIT_SPRING;
      this.wantAimStiff = cfg.camAimStiffness * ORBIT_SPRING;
      return;
    }

    // --- the direction the shot is built on -----------------------------
    // Nose, from yaw: yaw 0 faces -Z and positive yaw turns left.
    const nx = -Math.sin(bird.yaw);
    const nz = -Math.cos(bird.yaw);
    const gvx = bird.groundVel.x;
    const gvz = bird.groundVel.z;
    const gs = Math.hypot(gvx, gvz);
    const trust = smoothstep(VEL_TRUST_LO, VEL_TRUST_HI, gs);
    const inv = gs > 1e-4 ? 1 / gs : 0;
    // Track first, then bias back toward the nose so a strong crosswind crabs
    // the frame visibly without ever swinging the camera fully sideways.
    let dx = lerp(nx, gvx * inv, trust);
    let dz = lerp(nz, gvz * inv, trust);
    dx = lerp(dx, nx, NOSE_BIAS);
    dz = lerp(dz, nz, NOSE_BIAS);
    const dl = Math.hypot(dx, dz);
    if (dl > 1e-4) {
      dx /= dl;
      dz /= dl;
    } else {
      dx = nx;
      dz = nz;
    }
    // Rise over run of the actual flight path, clamped so a vertical dive
    // cannot fling the camera.
    const slope = clamp(bird.groundVel.y / Math.max(gs, 6), -SLOPE_LIMIT, SLOPE_LIMIT);

    // --- speed, eased and lagged ----------------------------------------
    const cruise = cruiseSpeed(cfg, bird.wing);
    const over = Math.max(0, (bird.airspeed - cruise) / Math.max(cfg.maxAirspeed - cruise, 1));
    const target = 1 - Math.exp(-over * over * SPEED_CURVE);
    this.speed01 = damp(this.speed01, target, SPEED_LAG, dt);
    const s = this.speed01;

    // --- mode shaping ----------------------------------------------------
    const landing = this.mode === 'landing';
    let dist = cfg.camDistance * (landing ? LANDING_DIST : 1) + cfg.camSpeedPullback * s;
    let height = cfg.camHeight * (landing ? LANDING_HEIGHT : 1);
    const ahead = cfg.camLookAhead * (landing ? LANDING_AHEAD : 1);
    let fov = cfg.camFov + cfg.camFovSpeedGain * s;
    let spring = landing ? LANDING_SPRING : 1;

    let bx = -dx;
    let bz = -dz;

    if (this.mode === 'launch') {
      const be = easeInOutCubic(this.blend);
      const away = 1 - be;
      // Swing the opening angle toward whichever side the sun is on, so the
      // establishing shot gets raking light across the ridge instead of the
      // flat frontal light you get from sitting straight behind.
      if (sky) {
        const sunSide = clamp(sky.sunDir.x * -dz + sky.sunDir.z * dx, -1, 1);
        const a = LAUNCH_SUN_BIAS * sunSide * away;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        const rx = bx * ca - bz * sa;
        const rz = bx * sa + bz * ca;
        bx = rx;
        bz = rz;
      }
      dist = lerp(dist * LAUNCH_DIST_MUL, dist, be);
      height = lerp(LAUNCH_HEIGHT, height, be);
      // A longer lens on the establishing shot; it opens out into the chase.
      fov -= LAUNCH_FOV_TIGHTEN * away;
      spring = lerp(LAUNCH_SPRING, 1, be);
    }

    // --- compose ---------------------------------------------------------
    this.wantPos.set(
      bird.position.x + bx * dist,
      // Sitting behind the bird *along its flight path* means climbing when it
      // dives — that is what keeps a tuck framed instead of showing bare sky.
      bird.position.y + height - slope * dist * DIVE_FOLLOW,
      bird.position.z + bz * dist,
    );
    // The eye leads the bird down the track, so the bird sits low in frame and
    // the player looks at where they are going rather than what they are on.
    const lead = this.mode === 'launch' ? ahead * easeInOutCubic(this.blend) : ahead;
    this.wantAim.set(
      bird.position.x + dx * lead,
      bird.position.y + slope * lead * AIM_SLOPE,
      bird.position.z + dz * lead,
    );

    this.wantFov = fov;
    this.wantStiff = cfg.camStiffness * spring;
    this.wantAimStiff = cfg.camAimStiffness * spring;
  }
}
