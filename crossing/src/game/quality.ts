import type { QualitySettings, QualityTier } from '../sim/types';

/**
 * Quality tiers. The game has to run on a phone and on a desktop with a real
 * GPU, and the honest way to do that is to decide up front what gets cut in
 * what order rather than scaling one master slider.
 *
 * The ordering of the cuts is deliberate: draw distance and ribbon count go
 * first because you barely notice them, post-processing goes last because it
 * is most of what makes the frame look expensive.
 */
const TIERS: Record<QualityTier, QualitySettings> = {
  low: {
    tier: 'low',
    pixelRatioCap: 1.25,
    terrainRings: 3,
    chunkResolution: 48,
    windRibbons: 320,
    cloudPuffs: 4,
    scatterDensity: 0.3,
    bloom: false,
    godrays: false,
    motionBlur: false,
    shadowMap: false,
    waterReflection: false,
  },
  medium: {
    tier: 'medium',
    pixelRatioCap: 1.5,
    terrainRings: 4,
    chunkResolution: 64,
    windRibbons: 900,
    cloudPuffs: 6,
    scatterDensity: 0.6,
    bloom: true,
    godrays: false,
    motionBlur: false,
    shadowMap: false,
    waterReflection: false,
  },
  high: {
    tier: 'high',
    pixelRatioCap: 1.85,
    terrainRings: 5,
    chunkResolution: 96,
    windRibbons: 1700,
    cloudPuffs: 8,
    scatterDensity: 1,
    bloom: true,
    godrays: true,
    motionBlur: true,
    shadowMap: false,
    waterReflection: true,
  },
  ultra: {
    tier: 'ultra',
    pixelRatioCap: 2,
    terrainRings: 6,
    chunkResolution: 128,
    windRibbons: 2600,
    cloudPuffs: 10,
    scatterDensity: 1.35,
    bloom: true,
    godrays: true,
    motionBlur: true,
    shadowMap: false,
    waterReflection: true,
  },
};

export function qualityFor(tier: QualityTier): QualitySettings {
  return { ...TIERS[tier] };
}

/**
 * First guess at a tier from what the browser will tell us. Deliberately
 * conservative — it is far better to start at medium and get promoted by the
 * adaptive monitor than to open at ultra and stutter through the first
 * thirty seconds, which is the only impression that matters.
 */
export function detectQuality(): QualityTier {
  if (typeof navigator === 'undefined') return 'high';
  const coarse =
    typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency ?? 4;
  const mem = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;

  if (coarse) return cores >= 6 && mem >= 4 ? 'medium' : 'low';
  if (cores >= 12 && mem >= 8) return 'ultra';
  if (cores >= 8 && mem >= 8) return 'high';
  if (cores >= 4) return 'medium';
  return 'low';
}

export const QUALITY_ORDER: readonly QualityTier[] = ['low', 'medium', 'high', 'ultra'];

/**
 * Watches frame time and moves the tier up or down. Two rules keep it from
 * oscillating: it needs a long, consistent run of evidence before it acts,
 * and it will only ever promote once — a machine that had to be demoted is
 * not a machine to keep experimenting on.
 */
export class AdaptiveQuality {
  private samples: number[] = [];
  private cooldown = 4;
  private demoted = false;
  private promotions = 0;

  constructor(
    public tier: QualityTier,
    private readonly onChange: (q: QualitySettings) => void,
  ) {}

  /** Feed the last frame's duration in seconds. */
  sample(dt: number): void {
    if (this.cooldown > 0) {
      this.cooldown -= dt;
      return;
    }
    // Ignore obvious hitches (tab switches, chunk builds) — we want the
    // sustained cost of a frame, not the worst one.
    if (dt > 0.25) return;
    this.samples.push(dt);
    if (this.samples.length < 180) return;

    this.samples.sort((a, b) => a - b);
    // The 80th percentile, not the mean: a frame budget is about the bad
    // frames, and the mean happily hides a third of them stuttering.
    const p80 = this.samples[Math.floor(this.samples.length * 0.8)];
    this.samples.length = 0;
    this.cooldown = 3;

    const idx = QUALITY_ORDER.indexOf(this.tier);
    if (p80 > 1 / 40 && idx > 0) {
      this.tier = QUALITY_ORDER[idx - 1];
      this.demoted = true;
      this.onChange(qualityFor(this.tier));
    } else if (p80 < 1 / 110 && idx < QUALITY_ORDER.length - 1 && !this.demoted && this.promotions < 1) {
      this.tier = QUALITY_ORDER[idx + 1];
      this.promotions++;
      this.onChange(qualityFor(this.tier));
    }
  }
}
