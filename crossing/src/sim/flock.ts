import type { Config } from './config';
import type {
  BirdState,
  FlockBird,
  SkyState,
  TerrainProvider,
  WindField,
  WindSample,
} from './types';
import { makeWindSample } from './types';
import { clamp, clamp01, damp, smoothstep, TAU } from './math';
import { makeRng } from './noise';

/**
 * THE FLOCK.
 *
 * Three jobs, and it has to do all three or it is just particles with wings.
 *
 *   1. IT IS THE SCORE. Companions join when you climb. By late afternoon a
 *      good flight is flying inside a crowd, and you can feel how well you
 *      are doing without reading a number anywhere.
 *
 *   2. IT IS THE BEST WIND-TELL IN THE GAME. Companions sample the real wind
 *      field ahead of themselves and steer toward rising air. Following the
 *      flock into a thermal is simultaneously the tutorial for a new player
 *      and a genuine shortcut for an expert — and neither of them has to be
 *      told that is what is happening.
 *
 *   3. IT IS THE ENDING. Between dusk and nightfall they peel away one at a
 *      time to roost. Not all at once — a slow drip over minutes, so that by
 *      the time the stars are out you are alone in the wave with the aurora,
 *      and the game has said something it never had to write down.
 */

// --- how the birds fly ---------------------------------------------------

/** Seconds between wind probes for a single bird. The flock round-robins its
 *  probes so the cost is a handful of samples per frame no matter how many
 *  birds are up. Raise it and the flock reacts to lift more sluggishly. */
const PROBE_INTERVAL = 0.55;
/** How far ahead a bird looks for lift (m). About four seconds of flight —
 *  far enough to turn toward a core before flying past it. */
const PROBE_AHEAD = 130;
/** Lateral offset of the two side probes (m). The bird compares left, ahead
 *  and right and banks toward whichever is going up fastest. */
const PROBE_SIDE = 95;

/** Metres above ground a bird tries never to go below. */
const GROUND_CLEARANCE = 45;
/** How hard terrain avoidance pushes, relative to everything else. */
const AVOID_GAIN = 2.6;

/** Sustained bank (rad) that reads as "the player is circling". Past this the
 *  flock stops holding formation and stacks into a thermalling gaggle. */
const CIRCLING_BANK = 0.4;
/** Seconds of sustained bank before the flock believes it. */
const CIRCLING_LATCH = 1.6;

/** Radius (m) of the gaggle when circling, and how far it stacks vertically.
 *  Real birds in a thermal spread into a rotating column at many heights;
 *  copying that is most of why a thermalling flock looks extraordinary. */
const GAGGLE_RADIUS = 78;
const GAGGLE_STACK = 130;

/** Seconds a departing bird takes to fade out once it has decided to roost. */
const LEAVE_FADE = 7;

const _probe: WindSample = makeWindSample();

export class Flock {
  readonly birds: FlockBird[] = [];

  private readonly rng: () => number;
  /** Index of the next bird due a wind probe. */
  private probeCursor = 0;
  private probeClock = 0;
  private circlingFor = 0;
  private circling = 0;
  /** Cached per-bird lift gradient from the last probe: which way is up. */
  private readonly seekX: Float32Array;
  private readonly seekZ: Float32Array;
  private readonly seekUp: Float32Array;
  /** How many have been granted but not yet spawned. */
  private pending = 0;
  private spawnTimer = 0;
  private roostTimer = 0;
  /** How many were with us when the evening began. -1 = not yet measured. */
  private roostBaseline = -1;

  constructor(
    private readonly cfg: Config,
    private readonly terrain: TerrainProvider,
    private readonly wind: WindField,
    seed: number,
  ) {
    this.rng = makeRng(seed * 1103515245 + 12345);
    this.seekX = new Float32Array(cfg.flockMax);
    this.seekZ = new Float32Array(cfg.flockMax);
    this.seekUp = new Float32Array(cfg.flockMax);

    for (let i = 0; i < cfg.flockMax; i++) {
      this.birds.push({
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        roll: 0,
        pitch: 0,
        yaw: 0,
        presence: 0,
        flap: this.rng() * TAU,
        // Stable per-bird variation, so the flock is a crowd of individuals
        // rather than one bird drawn sixty-four times.
        scale: 0.72 + this.rng() * 0.5,
        tint: this.rng(),
        leaving: 0,
        id: i,
      });
    }
  }

  get count(): number {
    let n = 0;
    for (const b of this.birds) if (b.presence > 0.02 && b.leaving < 0.5) n++;
    return n;
  }

  reset(): void {
    for (const b of this.birds) {
      b.presence = 0;
      b.leaving = 0;
    }
    this.pending = 0;
    this.spawnTimer = 0;
    this.roostTimer = 0;
    this.roostBaseline = -1;
    this.circling = 0;
    this.circlingFor = 0;
  }

  /** Earn companions. They arrive over the next few seconds, not instantly —
   *  a bird appearing out of nothing beside your wing looks like a bug. */
  grant(n: number): void {
    this.pending += n;
  }

  disperse(): void {
    for (const b of this.birds) if (b.presence > 0) b.leaving = 1;
  }

  update(dt: number, player: BirdState, sky: SkyState): void {
    const c = this.cfg;

    // --- is the player circling? ----------------------------------------
    if (Math.abs(player.roll) > CIRCLING_BANK) this.circlingFor += dt;
    else this.circlingFor = Math.max(0, this.circlingFor - dt * 2);
    const wantCircle = this.circlingFor > CIRCLING_LATCH ? 1 : 0;
    this.circling = damp(this.circling, wantCircle, 1.4, dt);

    this.spawnPending(dt, player);
    this.roost(dt, sky);
    this.probe(dt);

    const px = player.position.x;
    const py = player.position.y;
    const pz = player.position.z;
    // The flock forms up behind and slightly below — where a bird actually
    // sits relative to the one it is following, and where it does not block
    // the view of where you are going.
    const heading = Math.atan2(-player.groundVel.x, -player.groundVel.z);
    const backX = Math.sin(heading) * 34;
    const backZ = Math.cos(heading) * 34;

    for (let i = 0; i < this.birds.length; i++) {
      const b = this.birds[i];
      if (b.presence <= 0 && b.leaving === 0) continue;

      // --- fade in / fade out -------------------------------------------
      if (b.leaving > 0) {
        b.presence = Math.max(0, b.presence - dt / LEAVE_FADE);
        if (b.presence === 0) {
          b.leaving = 0;
          continue;
        }
      } else if (b.presence < 1) {
        b.presence = Math.min(1, b.presence + dt / Math.max(c.flockJoinTime, 0.1));
      }

      // --- where does this bird want to be? -----------------------------
      let tx: number;
      let ty: number;
      let tz: number;

      if (b.leaving > 0) {
        // Peeling off: bank away from the flock and settle toward the ground.
        const a = (b.id / c.flockMax) * TAU;
        tx = b.x + Math.cos(a) * 400;
        tz = b.z + Math.sin(a) * 400;
        ty = this.terrain.heightAt(tx, tz) + 30;
      } else {
        // Formation slot: a loose echelon when cruising, a rotating stack
        // when the player is circling.
        const slot = b.id;
        const side = slot % 2 === 0 ? 1 : -1;
        const rank = Math.floor(slot / 2) + 1;

        // Echelon: staggered back and out to the sides.
        const spreadOut = Math.min(rank * 11, c.flockRadius);
        const ex = px + backX * rank * 0.5 + Math.cos(heading) * side * spreadOut;
        const ez = pz + backZ * rank * 0.5 - Math.sin(heading) * side * spreadOut;
        const ey = py - rank * 1.6 - 4;

        // Gaggle: spread around a ring at staggered heights, all turning the
        // same way the player is.
        const ga = (slot / c.flockMax) * TAU * 3 + this.probeClock * 0.5;
        const gr = GAGGLE_RADIUS * (0.45 + ((slot * 37) % 100) / 140);
        const gx = px + Math.cos(ga) * gr;
        const gz = pz + Math.sin(ga) * gr;
        const gy = py + (((slot * 53) % 100) / 100 - 0.45) * GAGGLE_STACK;

        const k = this.circling;
        tx = ex + (gx - ex) * k;
        ty = ey + (gy - ey) * k;
        tz = ez + (gz - ez) * k;
      }

      // --- steering ------------------------------------------------------
      let ax = (tx - b.x) * c.flockCohesion * 0.3;
      let ay = (ty - b.y) * c.flockCohesion * 0.45;
      let az = (tz - b.z) * c.flockCohesion * 0.3;

      // Separation: keep out of each other's wingtips. O(n²) at 64 birds is
      // fine as long as the inner loop stays allocation-free.
      for (let j = 0; j < this.birds.length; j++) {
        if (j === i) continue;
        const o = this.birds[j];
        if (o.presence <= 0.02) continue;
        const dx = b.x - o.x;
        const dy = b.y - o.y;
        const dz = b.z - o.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > 400 || d2 < 1e-4) continue; // 20 m
        const inv = c.flockSeparation * 22 / d2;
        ax += dx * inv;
        ay += dy * inv;
        az += dz * inv;
      }

      // Alignment: match the player's direction of travel.
      ax += (player.groundVel.x - b.vx) * c.flockAlignment * 0.35;
      ay += (player.groundVel.y - b.vy) * c.flockAlignment * 0.2;
      az += (player.groundVel.z - b.vz) * c.flockAlignment * 0.35;

      // Lift seeking — the thing that makes them worth following.
      if (b.leaving === 0) {
        ax += this.seekX[i] * c.flockLiftSeek * 9;
        az += this.seekZ[i] * c.flockLiftSeek * 9;
        ay += this.seekUp[i] * c.flockLiftSeek * 1.6;
      }

      // Terrain avoidance. Non-negotiable — a companion clipping a ridge is
      // the single most immersion-breaking thing this system can do.
      const ground = Math.max(this.terrain.heightAt(b.x, b.z), this.terrain.waterLevel());
      const agl = b.y - ground;
      if (agl < GROUND_CLEARANCE && b.leaving === 0) {
        ay += (GROUND_CLEARANCE - agl) * AVOID_GAIN;
      }

      // --- integrate ------------------------------------------------------
      b.vx += ax * dt;
      b.vy += ay * dt;
      b.vz += az * dt;

      // Mild drag so the boids settle instead of oscillating forever.
      const drag = Math.exp(-1.1 * dt);
      b.vx *= drag;
      b.vy *= drag;
      b.vz *= drag;

      const sp = Math.hypot(b.vx, b.vy, b.vz);
      if (sp > c.flockMaxSpeed) {
        const k = c.flockMaxSpeed / sp;
        b.vx *= k;
        b.vy *= k;
        b.vz *= k;
      }

      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.z += b.vz * dt;
      if (b.y < ground + 1.5) {
        b.y = ground + 1.5;
        if (b.vy < 0) b.vy = 0;
      }

      // --- attitude from motion -------------------------------------------
      const newYaw = Math.atan2(-b.vx, -b.vz);
      // Roll comes from the RATE of turn — banking into the turn is most of
      // what makes a shape read as a bird rather than as a paper dart.
      let dYaw = newYaw - b.yaw;
      while (dYaw > Math.PI) dYaw -= TAU;
      while (dYaw < -Math.PI) dYaw += TAU;
      const targetRoll = clamp(-dYaw / Math.max(dt, 1e-3) * 0.42, -1.15, 1.15);
      b.roll = damp(b.roll, targetRoll, 5, dt);
      b.yaw = newYaw;
      const horiz = Math.hypot(b.vx, b.vz);
      b.pitch = damp(b.pitch, Math.atan2(b.vy, Math.max(horiz, 0.5)), 4, dt);

      // --- the wing beat ---------------------------------------------------
      // Soarers hold set wings. The phase only advances when a bird WANTS to
      // climb and the air is not giving it to it — so a sky of gliding shapes
      // with the occasional lazy beat, never a mobile-game flutter.
      const working = ay > 3 && b.vy < 1.5 ? 1 : 0;
      if (working) b.flap += dt * 3.4;
      else b.flap = damp(b.flap % TAU, 0, 2.2, dt);
    }
  }

  // ---------------------------------------------------------- internals

  /** Bring in granted companions a couple of seconds apart, from off to one
   *  side and behind, converging — so they arrive as arrivals. */
  private spawnPending(dt: number, player: BirdState): void {
    if (this.pending <= 0) return;
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnTimer = 0.45 + this.rng() * 0.7;

    for (const b of this.birds) {
      if (b.presence > 0 || b.leaving > 0) continue;
      const a = this.rng() * TAU;
      const r = 110 + this.rng() * 130;
      b.x = player.position.x + Math.cos(a) * r;
      b.z = player.position.z + Math.sin(a) * r;
      b.y = player.position.y + (this.rng() - 0.4) * 60;
      b.vx = player.groundVel.x;
      b.vy = player.groundVel.y;
      b.vz = player.groundVel.z;
      b.yaw = Math.atan2(-b.vx, -b.vz);
      b.roll = 0;
      b.pitch = 0;
      b.presence = 0.001;
      b.leaving = 0;
      this.pending--;
      return;
    }
    // No free slot — the flock is full, and that is a fine problem to have.
    this.pending = 0;
  }

  /**
   * Dusk. Between roostStartT and roostEndT the flock drains away, one bird
   * at a time, at a rate that finishes exactly as the light does.
   *
   * The target is measured against how many were with us when the evening
   * STARTED, not against how many are left — otherwise it is a fraction of a
   * shrinking number, which converges on a handful of birds that never go.
   */
  private roost(dt: number, sky: SkyState): void {
    const c = this.cfg;
    const t = sky.t;

    if (t < c.roostStartT) {
      // Still daylight. Re-arm, so a run that loops past midnight starts the
      // evening's accounting fresh.
      this.roostBaseline = -1;
      return;
    }

    if (this.roostBaseline < 0) this.roostBaseline = this.count;

    // Past the end of the evening nobody is still out. This also covers a run
    // that jumps straight to night, which the summary and the tests both do.
    if (t >= c.roostEndT) {
      for (const b of this.birds) if (b.presence > 0 && b.leaving === 0) b.leaving = 1;
      return;
    }

    const through = clamp01((t - c.roostStartT) / Math.max(c.roostEndT - c.roostStartT, 1e-3));
    const staying = Math.round(this.roostBaseline * (1 - smoothstep(0, 1, through)));
    if (this.count <= Math.max(staying, 0)) return;

    // Drip, do not dump: at most one departure every couple of seconds, so
    // the sky empties gradually enough that you notice it happening.
    this.roostTimer -= dt;
    if (this.roostTimer > 0) return;
    this.roostTimer = 1.6 + this.rng() * 2.2;

    for (const b of this.birds) {
      if (b.presence > 0.3 && b.leaving === 0) {
        b.leaving = 1;
        return;
      }
    }
  }

  /**
   * Round-robin wind probing. Each bird samples three points ahead of itself
   * — left, centre, right — and remembers which way the air was going up.
   * At 64 birds and a half-second interval this is a few hundred samples a
   * second, not tens of thousands.
   */
  private probe(dt: number): void {
    this.probeClock += dt;
    const n = this.birds.length;
    const perSecond = n / PROBE_INTERVAL;
    let budget = Math.max(1, Math.round(perSecond * dt));

    while (budget-- > 0) {
      const i = this.probeCursor;
      this.probeCursor = (this.probeCursor + 1) % n;
      const b = this.birds[i];
      if (b.presence <= 0.02 || b.leaving > 0) {
        this.seekX[i] = 0;
        this.seekZ[i] = 0;
        this.seekUp[i] = 0;
        continue;
      }

      const sp = Math.hypot(b.vx, b.vz) || 1;
      const dirX = b.vx / sp;
      const dirZ = b.vz / sp;
      const sideX = -dirZ;
      const sideZ = dirX;

      const cx = b.x + dirX * PROBE_AHEAD;
      const cz = b.z + dirZ * PROBE_AHEAD;

      this.wind.sample(cx, b.y, cz, _probe);
      const centre = _probe.vy;
      this.wind.sample(cx + sideX * PROBE_SIDE, b.y, cz + sideZ * PROBE_SIDE, _probe);
      const right = _probe.vy;
      this.wind.sample(cx - sideX * PROBE_SIDE, b.y, cz - sideZ * PROBE_SIDE, _probe);
      const left = _probe.vy;

      // Steer toward the better side; climb if straight ahead is rising.
      const bias = clamp((right - left) / 4, -1, 1);
      this.seekX[i] = sideX * bias;
      this.seekZ[i] = sideZ * bias;
      this.seekUp[i] = clamp(centre / 3, -1, 1.5);
    }
  }
}
