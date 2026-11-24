import { LAND_ORDER, LandId } from '../world/lands';

export interface DayRecord {
  distance: number;
  highest: number;
  longestGlide: number;
  feathers: number;
  feathersTotal: number;
  seconds: number;
}

export interface SaveData {
  v: 2;
  /** next movement to fly, 0..5; 6 = journey complete */
  day: number;
  companions: number;
  landmarks: string[];
  days: Partial<Record<LandId, DayRecord>>;
  arrived: boolean;
  settings: Settings;
}

export interface Settings {
  quality: 'auto' | 'low' | 'medium' | 'high' | 'ultra';
  master: number;
  music: number;
  world: number;
  invert: boolean;
  hud: boolean;
  painterly: number;
  hints: boolean;
  motion: boolean;
}

const KEY = 'aloft.journey.v2';

export function defaults(): SaveData {
  return {
    v: 2,
    day: 0,
    companions: 0,
    landmarks: [],
    days: {},
    arrived: false,
    settings: { quality: 'auto', master: 0.85, music: 0.9, world: 0.9, invert: false, hud: true, painterly: 0.35, hints: true, motion: true },
  };
}

export function load(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const d = JSON.parse(raw) as SaveData;
      const b = defaults();
      if (d.v === 2) return { ...b, ...d, settings: { ...b.settings, ...d.settings } };
    }
  } catch {
    /* private window, blocked storage — the journey simply isn't remembered */
  }
  return defaults();
}

export function save(d: SaveData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    /* as above */
  }
}

export function landAt(day: number): LandId {
  return LAND_ORDER[Math.max(0, Math.min(LAND_ORDER.length - 1, day))];
}
