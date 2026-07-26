import type { Config } from './config';
import type { DayPhase, SkyState, Vec3 } from './types';
import { clamp01, lerp, smootherstep, smoothstep } from './math';

/**
 * THE COLOUR SCRIPT.
 *
 * This file decides what colour everything in the game is at every moment,
 * which means it has more effect on whether the thing looks good than any
 * shader does. It is a table of hand-authored keyframes across one day,
 * interpolated in linear RGB, plus the handful of physical quantities the
 * rest of the game reads off the sun.
 *
 * The most important of those is `thermalActivity`. It does NOT track the
 * sun — it tracks the *ground*, which takes hours to bank the sun's heat and
 * hours to give it back. That lag is why the best soaring of the day is at
 * three in the afternoon and not at noon, and because every thermal in the
 * world is scaled by this one number, the lag is also the game's entire
 * difficulty curve. Nobody tuned it. It falls out of modelling the day.
 */

interface Keyframe {
  t: number;
  sunColor: [number, number, number];
  sunIntensity: number;
  skyZenith: [number, number, number];
  skyHorizon: [number, number, number];
  groundBounce: [number, number, number];
  fogColor: [number, number, number];
  fogDensity: number;
  ambient: [number, number, number];
  ambientIntensity: number;
  exposure: number;
}

/**
 * Eleven moments. The extremes are deliberately extreme: noon is almost
 * white-blue and a little boring *on purpose*, so that golden hour has
 * somewhere to land. Blue hour is a saturated indigo rather than a grey,
 * because grey is what happens when nobody made a decision.
 *
 * All values are LINEAR. The renderer tonemaps with ACES, so a sun intensity
 * above 1 is expected and is what the bloom eats.
 */
const KEYS: Keyframe[] = [
  {
    // 0.00 — deep pre-dawn. Moonlight, and the first hint of the east.
    t: 0.0,
    sunColor: [0.16, 0.2, 0.34],
    sunIntensity: 0.1,
    skyZenith: [0.008, 0.014, 0.036],
    skyHorizon: [0.03, 0.045, 0.088],
    groundBounce: [0.012, 0.016, 0.028],
    fogColor: [0.026, 0.038, 0.072],
    fogDensity: 0.000042,
    ambient: [0.06, 0.09, 0.17],
    ambientIntensity: 0.4,
    exposure: 1.55,
  },
  {
    // 0.045 — civil twilight. The east goes rose before the sun is anywhere.
    t: 0.045,
    sunColor: [0.55, 0.36, 0.36],
    sunIntensity: 0.34,
    skyZenith: [0.024, 0.04, 0.098],
    skyHorizon: [0.26, 0.19, 0.24],
    groundBounce: [0.035, 0.035, 0.05],
    fogColor: [0.16, 0.14, 0.19],
    fogDensity: 0.000062,
    ambient: [0.13, 0.15, 0.24],
    ambientIntensity: 0.55,
    exposure: 1.35,
  },
  {
    // 0.075 — sunrise, the disc on the horizon. The most violent colour of
    // the day: hot orange against a zenith that is still last night's violet.
    t: 0.075,
    sunColor: [1.6, 0.62, 0.24],
    sunIntensity: 1.15,
    skyZenith: [0.055, 0.09, 0.2],
    skyHorizon: [0.85, 0.42, 0.26],
    groundBounce: [0.1, 0.075, 0.06],
    fogColor: [0.5, 0.32, 0.27],
    fogDensity: 0.00007,
    ambient: [0.24, 0.26, 0.36],
    ambientIntensity: 0.72,
    exposure: 1.12,
  },
  {
    // 0.13 — golden morning. Long shadows, warm ground, cold sky.
    t: 0.13,
    sunColor: [1.6, 1.05, 0.62],
    sunIntensity: 1.5,
    skyZenith: [0.09, 0.17, 0.36],
    skyHorizon: [0.7, 0.62, 0.55],
    groundBounce: [0.15, 0.13, 0.1],
    fogColor: [0.52, 0.48, 0.46],
    fogDensity: 0.00005,
    ambient: [0.3, 0.36, 0.5],
    ambientIntensity: 0.85,
    exposure: 1.0,
  },
  {
    // 0.28 — clear mid-morning. The air has cleaned up; distance opens out.
    t: 0.28,
    sunColor: [1.55, 1.35, 1.05],
    sunIntensity: 1.75,
    skyZenith: [0.13, 0.26, 0.55],
    skyHorizon: [0.6, 0.68, 0.78],
    groundBounce: [0.18, 0.18, 0.15],
    fogColor: [0.55, 0.62, 0.72],
    fogDensity: 0.000034,
    ambient: [0.34, 0.44, 0.62],
    ambientIntensity: 0.95,
    exposure: 0.94,
  },
  {
    // 0.45 — high noon. Flat, white, and slightly dull by design.
    t: 0.45,
    sunColor: [1.5, 1.46, 1.36],
    sunIntensity: 1.9,
    skyZenith: [0.14, 0.29, 0.62],
    skyHorizon: [0.62, 0.71, 0.83],
    groundBounce: [0.2, 0.2, 0.18],
    fogColor: [0.6, 0.68, 0.79],
    fogDensity: 0.000028,
    ambient: [0.36, 0.47, 0.68],
    ambientIntensity: 1.0,
    exposure: 0.9,
  },
  {
    // 0.60 — warm afternoon. The best air of the day, and the light softens.
    t: 0.6,
    sunColor: [1.6, 1.34, 0.98],
    sunIntensity: 1.8,
    skyZenith: [0.13, 0.25, 0.55],
    skyHorizon: [0.72, 0.7, 0.7],
    groundBounce: [0.21, 0.19, 0.15],
    fogColor: [0.63, 0.63, 0.66],
    fogDensity: 0.000033,
    ambient: [0.36, 0.44, 0.6],
    ambientIntensity: 0.95,
    exposure: 0.94,
  },
  {
    // 0.75 — golden hour. Everything the art direction exists to deliver.
    t: 0.75,
    sunColor: [1.85, 1.05, 0.5],
    sunIntensity: 1.65,
    skyZenith: [0.1, 0.18, 0.42],
    skyHorizon: [1.0, 0.62, 0.36],
    groundBounce: [0.2, 0.14, 0.09],
    fogColor: [0.68, 0.46, 0.34],
    fogDensity: 0.000048,
    ambient: [0.32, 0.34, 0.46],
    ambientIntensity: 0.86,
    exposure: 1.0,
  },
  {
    // 0.83 — the disc touching the horizon.
    t: 0.83,
    sunColor: [1.9, 0.52, 0.2],
    sunIntensity: 1.05,
    skyZenith: [0.06, 0.09, 0.26],
    skyHorizon: [0.95, 0.36, 0.22],
    groundBounce: [0.12, 0.07, 0.06],
    fogColor: [0.52, 0.26, 0.23],
    fogDensity: 0.000068,
    ambient: [0.22, 0.22, 0.34],
    ambientIntensity: 0.72,
    exposure: 1.12,
  },
  {
    // 0.88 — blue hour. Saturated indigo, and the land goes to silhouette.
    t: 0.88,
    sunColor: [0.42, 0.28, 0.4],
    sunIntensity: 0.3,
    skyZenith: [0.022, 0.036, 0.12],
    skyHorizon: [0.2, 0.16, 0.3],
    groundBounce: [0.032, 0.032, 0.055],
    fogColor: [0.13, 0.13, 0.22],
    fogDensity: 0.00007,
    ambient: [0.11, 0.14, 0.26],
    ambientIntensity: 0.56,
    exposure: 1.38,
  },
  {
    // 0.93 — nightfall. Dark, but never black: this is moonlight, and you
    // still have to be able to see a ridge to soar it.
    t: 0.93,
    sunColor: [0.15, 0.19, 0.32],
    sunIntensity: 0.11,
    skyZenith: [0.007, 0.012, 0.032],
    skyHorizon: [0.028, 0.042, 0.082],
    groundBounce: [0.011, 0.015, 0.026],
    fogColor: [0.024, 0.036, 0.068],
    fogDensity: 0.000044,
    ambient: [0.055, 0.085, 0.165],
    ambientIntensity: 0.42,
    exposure: 1.6,
  },
];

/** Phase boundaries. Each one is a different flying problem. */
const PHASE_BOUNDS: Array<[DayPhase, number, number]> = [
  ['dawn', 0.0, 0.12],
  ['morning', 0.12, 0.34],
  ['noon', 0.34, 0.55],
  ['afternoon', 0.55, 0.75],
  ['evening', 0.75, 0.88],
  ['night', 0.88, 1.0],
];

const PHASE_LABELS: Record<DayPhase, string> = {
  dawn: 'Dawn',
  morning: 'Morning',
  noon: 'Midday',
  afternoon: 'Afternoon',
  evening: 'Golden hour',
  night: 'Night',
};

/**
 * One line each, shown when the day turns. Spare, observational, a little
 * awed — and every one of them is also a piece of tactical advice, because
 * the phases genuinely change what works.
 */
const PHASE_DESCRIPTIONS: Record<DayPhase, string> = {
  dawn: 'The ground is cold. Nothing is rising yet — stay on the slopes and spend your height carefully.',
  morning: 'The first columns are coming up. Wide, gentle, forgiving. Take what you are offered.',
  noon: 'The air has gone hard. Narrow cores, heavy sink between them, and over the dry country nothing marks them at all.',
  afternoon: 'The air organises. The clouds are lining up — find a street and run it.',
  evening: 'It is dying from the ground up. Get high while there is still something to climb in.',
  night: 'The thermals are gone. Only the wind on the ridges, and the wave — which has been waiting all day.',
};

const v3of = (a: [number, number, number]): Vec3 => ({ x: a[0], y: a[1], z: a[2] });

export class SkyModel {
  readonly state: SkyState;
  private elapsed = 0;

  constructor(private readonly cfg: Config) {
    this.state = {
      t: cfg.startTimeOfDay,
      phase: 'dawn',
      phaseBlend: 0,
      sunDir: { x: 0, y: 0.2, z: -1 },
      sunElevation: 0,
      moonDir: { x: 0, y: -0.2, z: 1 },
      thermalActivity: 0,
      cloudBase: cfg.cloudBaseDawn,
      cloudDepth: cfg.cloudDepth,
      streetFactor: 0,
      starVisibility: 0,
      auroraStrength: 0,
      mistStrength: 0,
      sunColor: v3of(KEYS[0].sunColor),
      sunIntensity: 0,
      skyZenith: v3of(KEYS[0].skyZenith),
      skyHorizon: v3of(KEYS[0].skyHorizon),
      groundBounce: v3of(KEYS[0].groundBounce),
      fogColor: v3of(KEYS[0].fogColor),
      fogDensity: KEYS[0].fogDensity,
      ambient: v3of(KEYS[0].ambient),
      ambientIntensity: 1,
      exposure: 1,
    };
    this.recompute();
  }

  setAuto(auto: boolean): void {
    this.cfg.dayAuto = auto;
  }

  setTime(t: number): void {
    this.state.t = ((t % 1) + 1) % 1;
    this.recompute();
  }

  update(dt: number): SkyState {
    this.elapsed += dt;
    if (this.cfg.dayAuto) {
      this.state.t = (this.state.t + dt / Math.max(this.cfg.dayLength, 1)) % 1;
    }
    this.recompute();
    return this.state;
  }

  // ------------------------------------------------------------ internals

  private recompute(): void {
    const s = this.state;
    const t = s.t;

    this.interpolateColors(t);
    this.solar(t);
    this.phaseOf(t);
    this.convection(t);
    this.nightSky(t);
  }

  /** Walk the keyframe table and blend the two we sit between. */
  private interpolateColors(t: number): void {
    const s = this.state;
    let i = 0;
    while (i < KEYS.length - 1 && KEYS[i + 1].t <= t) i++;

    const a = KEYS[i];
    // Past the last keyframe we wrap around to the first one, which is the
    // same moment a day later — so the loop is seamless.
    const b = i + 1 < KEYS.length ? KEYS[i + 1] : { ...KEYS[0], t: 1 };
    const span = Math.max(b.t - a.t, 1e-6);
    const u = smootherstep(0, 1, clamp01((t - a.t) / span));

    mixInto(s.sunColor, a.sunColor, b.sunColor, u);
    mixInto(s.skyZenith, a.skyZenith, b.skyZenith, u);
    mixInto(s.skyHorizon, a.skyHorizon, b.skyHorizon, u);
    mixInto(s.groundBounce, a.groundBounce, b.groundBounce, u);
    mixInto(s.fogColor, a.fogColor, b.fogColor, u);
    mixInto(s.ambient, a.ambient, b.ambient, u);
    s.sunIntensity = lerp(a.sunIntensity, b.sunIntensity, u);
    s.fogDensity = lerp(a.fogDensity, b.fogDensity, u);
    s.ambientIntensity = lerp(a.ambientIntensity, b.ambientIntensity, u);
    s.exposure = lerp(a.exposure, b.exposure, u);
  }

  /**
   * Where the sun is. Rises in the east (+X), sets in the west (-X), peaks a
   * little past 60 degrees at t = 0.45. Below the horizon from about 0.855
   * to 0.045, which is what makes night night.
   */
  private solar(t: number): void {
    const s = this.state;
    const PEAK = 1.09; // ~62 degrees at the top of the arc
    const RISE = 0.045;
    const SET = 0.855;
    const dayLen = SET - RISE;

    // Day fraction, extended smoothly past both ends so the sun keeps going
    // (below the horizon) rather than stopping dead at the boundary.
    const u = (t - RISE) / dayLen;
    const elev = Math.sin(u * Math.PI) * PEAK;
    s.sunElevation = elev;

    // Azimuth sweeps continuously through the day: east at sunrise, south at
    // noon, west at sunset. (Northern hemisphere; the sun crosses toward -Z.)
    const az = lerp(-Math.PI * 0.5, Math.PI * 0.5, clamp01(u));
    const ce = Math.cos(elev);
    s.sunDir.x = Math.cos(az) * ce;
    s.sunDir.y = Math.sin(elev);
    s.sunDir.z = -Math.sin(az) * ce * 0.65 - 0.35 * ce;
    normalize(s.sunDir);

    // The moon runs the opposite arc with a tilt, so it is up when the sun
    // is not and is never sitting exactly behind it.
    s.moonDir.x = -s.sunDir.x;
    s.moonDir.y = -s.sunDir.y * 0.92 + 0.24;
    s.moonDir.z = -s.sunDir.z * 0.85;
    normalize(s.moonDir);
  }

  private phaseOf(t: number): void {
    const s = this.state;
    for (const [name, lo, hi] of PHASE_BOUNDS) {
      if (t >= lo && t < hi) {
        s.phase = name;
        s.phaseBlend = clamp01((t - lo) / (hi - lo));
        return;
      }
    }
    s.phase = 'night';
    s.phaseBlend = 1;
  }

  /**
   * The convective day. thermalActivity is the master gain on every thermal
   * in the world.
   *
   * The shape: take the sun's elevation curve, shift it LATER by cfg.heatLag,
   * and raise it to a power slightly above one so the shoulders are steeper
   * than the sine. Then gate it hard at both ends — nothing before the ground
   * has had an hour of sun, and exactly zero once the sun is down, because
   * convection is not a thing that limps on into the night.
   */
  private convection(t: number): void {
    const s = this.state;
    const c = this.cfg;

    const RISE = 0.045;
    const SET = 0.855;
    // The lagged clock: at t, the ground is only as warm as the sun was
    // heatLag ago, so the peak lands well after solar noon.
    const lagged = t - c.heatLag;
    const u = (lagged - RISE) / (SET - RISE);
    const raw = u > 0 && u < 1 ? Math.pow(Math.sin(u * Math.PI), 1.35) : 0;

    // Morning gate: the first hour of sun goes into warming the ground, not
    // into lifting anything off it.
    const morningGate = smoothstep(0.085, 0.165, t);
    // Evening gate: convection collapses fast once the sun gets low, and is
    // over before the sun is actually down.
    const eveningGate = 1 - smoothstep(0.79, 0.868, t);
    s.thermalActivity = clamp01(raw * morningGate * eveningGate);

    // Cloudbase climbs all day and keeps climbing into the evening as the air
    // dries out, so it lags even the lagged heat curve.
    const baseCurve = smoothstep(0.08, 0.62, t) * (1 - 0.25 * smoothstep(0.8, 1, t));
    s.cloudBase = lerp(c.cloudBaseDawn, c.cloudBasePeak, clamp01(baseCurve));
    s.cloudDepth = c.cloudDepth * (0.45 + 0.55 * s.thermalActivity);

    // Cloud streets are an afternoon phenomenon: they need convection AND a
    // steady wind to organise it into lines.
    s.streetFactor = clamp01(
      smoothstep(0.55, 0.66, t) * (1 - smoothstep(0.79, 0.87, t)) * (0.35 + 0.65 * s.thermalActivity),
    );
  }

  private nightSky(t: number): void {
    const s = this.state;
    // Stars come in through dusk and go out through dawn.
    const dusk = smoothstep(0.855, 0.94, t);
    const dawn = 1 - smoothstep(0.0, 0.055, t);
    s.starVisibility = clamp01(Math.max(dusk, dawn));

    // The aurora arrives a little after the stars and breathes slowly. Two
    // incommensurable sines so it never repeats in a way you can hear.
    const window = smoothstep(0.885, 0.955, t) * (1 - smoothstep(0.0, 0.04, t < 0.5 ? t : 0));
    const pulse =
      0.62 +
      0.26 * Math.sin(this.elapsed * 0.13) +
      0.16 * Math.sin(this.elapsed * 0.047 + 1.7);
    s.auroraStrength = clamp01(window * pulse);

    // Valley mist: heaviest just before sunrise, burned off by mid-morning,
    // with a small return as the ground cools at dusk.
    const morning = smoothstep(0.0, 0.03, t) * (1 - smoothstep(0.1, 0.2, t));
    const evening = smoothstep(0.86, 0.93, t) * 0.45;
    s.mistStrength = clamp01(Math.max(morning, evening));
  }
}

function mixInto(out: Vec3, a: [number, number, number], b: [number, number, number], u: number): void {
  out.x = a[0] + (b[0] - a[0]) * u;
  out.y = a[1] + (b[1] - a[1]) * u;
  out.z = a[2] + (b[2] - a[2]) * u;
}

function normalize(v: Vec3): void {
  const l = Math.hypot(v.x, v.y, v.z) || 1;
  v.x /= l;
  v.y /= l;
  v.z /= l;
}

// -------------------------------------------------------- presentation

export function phaseLabel(phase: DayPhase): string {
  return PHASE_LABELS[phase] ?? 'Day';
}

export function phaseDescription(phase: DayPhase): string {
  return PHASE_DESCRIPTIONS[phase] ?? '';
}

/**
 * A diegetic clock. t = 0 is 04:30, so dawn lands around five, golden hour
 * around six in the evening, and dark a little after eight — a plausible
 * long summer day, which is the day you would want to go soaring on.
 */
export function timeLabel(t: number): string {
  const START_MINUTES = 4 * 60 + 30;
  const total = (START_MINUTES + ((t % 1) + 1) % 1 * 24 * 60) % (24 * 60);
  const h = Math.floor(total / 60);
  const m = Math.floor(total % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
