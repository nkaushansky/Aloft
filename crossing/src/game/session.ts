import type { Config } from '../sim/config';
import type { BirdState, RunPhase, RunStats, SkyState, TerrainProvider } from '../sim/types';
import { AirKind } from '../sim/types';
import { clamp01, smoothstep } from '../sim/math';
import { nameFromSeed } from '../sim/noise';
import { Logbook } from './logbook';

/**
 * The session layer: what a run IS.
 *
 * A crossing is one day. You launch off a ridge before sunrise and you fly
 * until you land — by choice, or because the air ran out. There is no fail
 * state and no timer beating you; the sun is the only clock, and it is a
 * clock that gives you the best air halfway through and takes it away at the
 * end. The difficulty curve is literally the day.
 *
 * This class owns the state machine, the honest accounting of where your
 * height came from, and the decision about when a run has ended.
 */

export type RunMode = 'crossing' | 'drift';

export interface SessionEvents {
  onPhaseChange?: (phase: RunPhase) => void;
  onDayPhaseChange?: (phase: SkyState['phase']) => void;
  /** Fired when companions are earned, so the audio and UI can react. */
  onCompanions?: (gained: number, total: number) => void;
  /** A transient line for the HUD: 'wave', 'blue thermal', 'convergence'. */
  onNote?: (text: string) => void;
  onLanded?: (stats: RunStats) => void;
}

/** How long a climb must persist before it counts as "a climb". */
const CLIMB_LATCH_SECONDS = 1.2;
/** Route samples are taken this often (seconds). ~450 points over a long run. */
const ROUTE_SAMPLE_INTERVAL = 2;
const ROUTE_MAX_POINTS = 900;

export class Session {
  phase: RunPhase = 'title';
  mode: RunMode = 'crossing';
  readonly stats: RunStats;
  readonly logbook = new Logbook();

  /** Metres of climb banked but not yet paid out as companions. */
  private climbCredit = 0;
  /** Seconds of continuous climb, for latching a "real" climb. */
  private climbHold = 0;
  private climbStartAlt = 0;
  private currentClimb = 0;
  private lastAltitude = 0;
  private routeTimer = 0;
  private elapsed = 0;
  private launchX = 0;
  private launchZ = 0;
  private groundTimer = 0;
  private lastDayPhase: SkyState['phase'] = 'dawn';
  private seenKinds = new Set<AirKind>();
  private noteCooldown = 0;

  constructor(
    private readonly cfg: Config,
    private readonly terrain: TerrainProvider,
    private readonly events: SessionEvents = {},
  ) {
    this.stats = Session.blankStats(cfg.seed);
  }

  static blankStats(seed: number): RunStats {
    return {
      seed,
      seedName: nameFromSeed(seed),
      distance: 0,
      pathLength: 0,
      peakAltitude: 0,
      peakSpeed: 0,
      duration: 0,
      climbBySource: {
        [AirKind.Still]: 0,
        [AirKind.Thermal]: 0,
        [AirKind.Ridge]: 0,
        [AirKind.Wave]: 0,
        [AirKind.Rotor]: 0,
        [AirKind.Convergence]: 0,
        [AirKind.Sink]: 0,
      },
      bestClimb: 0,
      flock: 0,
      peakFlock: 0,
      endPhase: 'dawn',
      endTime: 0,
      reachedNight: false,
      touchedWave: false,
      route: [],
    };
  }

  setPhase(p: RunPhase): void {
    if (this.phase === p) return;
    this.phase = p;
    this.events.onPhaseChange?.(p);
  }

  /** Begin a run. `bird` must already be positioned at the launch site. */
  begin(bird: BirdState, seed: number, mode: RunMode): void {
    this.mode = mode;
    const s = this.stats;
    const blank = Session.blankStats(seed);
    Object.assign(s, blank, { route: [] });
    this.climbCredit = 0;
    this.climbHold = 0;
    this.currentClimb = 0;
    this.climbStartAlt = bird.position.y;
    this.lastAltitude = bird.position.y;
    this.routeTimer = 0;
    this.elapsed = 0;
    this.groundTimer = 0;
    this.launchX = bird.position.x;
    this.launchZ = bird.position.z;
    this.seenKinds.clear();
    this.noteCooldown = 0;
    this.setPhase('launching');
  }

  /**
   * Advance the accounting. Returns the number of companions earned this
   * step so the caller can hand them to the flock.
   */
  update(dt: number, bird: BirdState, sky: SkyState, flockCount: number): number {
    if (this.phase !== 'flying' && this.phase !== 'launching' && this.phase !== 'landing') return 0;

    const s = this.stats;
    this.elapsed += dt;
    s.duration = this.elapsed;

    // --- distance and path ------------------------------------------------
    const dx = bird.position.x - this.launchX;
    const dz = bird.position.z - this.launchZ;
    s.distance = Math.hypot(dx, dz);
    s.pathLength += Math.hypot(bird.groundVel.x, bird.groundVel.z) * dt;
    if (bird.position.y > s.peakAltitude) s.peakAltitude = bird.position.y;
    if (bird.airspeed > s.peakSpeed) s.peakSpeed = bird.airspeed;
    s.flock = flockCount;
    if (flockCount > s.peakFlock) s.peakFlock = flockCount;

    // --- where the height came from ---------------------------------------
    // Credit gained altitude to whatever air was dominant while it was gained.
    // This is the flight's honest account: it is entirely possible to finish a
    // long crossing having never once climbed in a thermal, and the summary
    // should be able to say so.
    const gain = bird.position.y - this.lastAltitude;
    this.lastAltitude = bird.position.y;
    if (gain > 0) {
      s.climbBySource[bird.airKind] += gain;
      this.climbCredit += gain;
      this.climbHold += dt;
      if (this.climbHold >= CLIMB_LATCH_SECONDS) {
        this.currentClimb = bird.position.y - this.climbStartAlt;
        if (this.currentClimb > s.bestClimb) s.bestClimb = this.currentClimb;
      }
    } else {
      this.climbHold = 0;
      this.climbStartAlt = bird.position.y;
      this.currentClimb = 0;
    }

    if (bird.airKind === AirKind.Wave && bird.airIntensity > 0.25) s.touchedWave = true;
    if (sky.phase === 'night') s.reachedNight = true;

    // --- first-time notes --------------------------------------------------
    this.noteCooldown = Math.max(0, this.noteCooldown - dt);
    if (
      this.noteCooldown === 0 &&
      bird.airIntensity > 0.35 &&
      bird.airKind !== AirKind.Still &&
      bird.airKind !== AirKind.Sink &&
      !this.seenKinds.has(bird.airKind)
    ) {
      this.seenKinds.add(bird.airKind);
      this.noteCooldown = 6;
      this.events.onNote?.(FIRST_TIME_NOTES[bird.airKind]);
    }

    // --- the day turning ---------------------------------------------------
    if (sky.phase !== this.lastDayPhase) {
      this.lastDayPhase = sky.phase;
      this.events.onDayPhaseChange?.(sky.phase);
    }

    // --- companions --------------------------------------------------------
    let earned = 0;
    while (this.climbCredit >= this.cfg.climbPerCompanion && flockCount + earned < this.cfg.flockMax) {
      this.climbCredit -= this.cfg.climbPerCompanion;
      earned++;
    }
    if (earned > 0) this.events.onCompanions?.(earned, flockCount + earned);

    // --- route trace -------------------------------------------------------
    this.routeTimer += dt;
    if (this.routeTimer >= ROUTE_SAMPLE_INTERVAL && s.route.length < ROUTE_MAX_POINTS) {
      this.routeTimer = 0;
      s.route.push({
        x: bird.position.x,
        z: bird.position.z,
        y: bird.position.y,
        t: sky.t,
        kind: bird.airKind,
      });
    }

    // --- has the flight ended? ---------------------------------------------
    if (bird.landed) {
      this.groundTimer += dt;
      if (this.groundTimer >= this.cfg.landingSettleTime) {
        s.endPhase = sky.phase;
        s.endTime = sky.t;
        this.finish();
      }
    } else {
      this.groundTimer = Math.max(0, this.groundTimer - dt * 2);
    }

    return earned;
  }

  /** 0..1 how close the bird is to a clean landing — drives the landing UI. */
  landingReadiness(bird: BirdState): number {
    if (bird.agl > this.cfg.landingAgl * 3) return 0;
    const low = 1 - smoothstep(this.cfg.landingAgl * 0.5, this.cfg.landingAgl * 3, bird.agl);
    const slow = 1 - smoothstep(this.cfg.landingSpeed, this.cfg.landingSpeed * 1.7, bird.airspeed);
    const level = 1 - smoothstep(0.25, 0.7, Math.abs(bird.roll));
    const ground = this.terrain.sampleAt(bird.position.x, bird.position.z, SCRATCH_TERRAIN);
    const flat = 1 - smoothstep(this.cfg.landingSlope, this.cfg.landingSlope * 2.2, ground.slope);
    return clamp01(low * slow * level * flat);
  }

  finish(): void {
    if (this.phase === 'summary') return;
    this.logbook.record(this.stats);
    this.setPhase('summary');
    this.events.onLanded?.(this.stats);
  }

  /** The one line of prose the summary screen leads with. */
  verdict(): string {
    const s = this.stats;
    const km = s.distance / 1000;
    if (s.reachedNight && s.touchedWave)
      return 'You found the wave and rode it into the dark. Very few birds ever see the sky from up there.';
    if (s.reachedNight)
      return 'The thermals died beneath you and you were still flying. The night sky is a reward you cannot be given, only reach.';
    if (s.touchedWave)
      return 'You climbed in wave — smooth, silent, and rising far past anything the sun could offer.';
    if (km > 120)
      return 'A long day in good air. You read the ground and it told you the truth.';
    if (s.bestClimb > 900)
      return 'One climb carried most of this flight. When the air offers you a column like that, you take all of it.';
    if (s.peakFlock >= 20)
      return 'You gathered a crowd. Flying well is a thing other birds can see from a long way off.';
    if (km > 45) return 'Honest work between the ridges. The air was there if you were patient with it.';
    if (s.endPhase === 'dawn')
      return 'Down early. The ground is cold before the sun has done its work — the first hour is the hardest hour.';
    return 'Every crossing teaches the same lesson: height is a bank account, and only the world makes deposits.';
  }

  /** A short, specific title for the run. Shown above the route map. */
  runTitle(): string {
    const s = this.stats;
    if (s.reachedNight && s.touchedWave) return 'Into the dark';
    if (s.reachedNight) return 'Past the last thermal';
    if (s.touchedWave) return 'The elevator';
    if (s.distance > 120000) return 'A long crossing';
    if (s.peakAltitude > 4000) return 'High country';
    if (s.peakFlock >= 20) return 'In good company';
    if (s.endPhase === 'dawn') return 'A short morning';
    return 'A day in the air';
  }
}

const SCRATCH_TERRAIN = { height: 0, nx: 0, ny: 1, nz: 0, slope: 0 };

/**
 * The first time the player meets each kind of air, the HUD names it once and
 * never again. Naming a thing is most of learning to find it.
 */
const FIRST_TIME_NOTES: Record<AirKind, string> = {
  [AirKind.Still]: '',
  [AirKind.Thermal]: 'thermal — circle to stay in it',
  [AirKind.Ridge]: 'ridge lift — track the slope, do not turn away from it',
  [AirKind.Wave]: 'wave — hold still and let it carry you',
  [AirKind.Rotor]: 'rotor — rough air, the wave is above it',
  [AirKind.Convergence]: 'convergence — fly the line straight',
  [AirKind.Sink]: 'sink — tuck and cross it fast',
};
