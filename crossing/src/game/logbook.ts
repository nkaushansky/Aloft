import type { LogbookEntry, RunStats } from '../sim/types';

const KEY = 'aloft.crossing.logbook.v1';
const MAX_ENTRIES = 40;

/**
 * The Logbook. Deliberately not a leaderboard: it is a list of days you had,
 * each one identified by the seed that built the sky it happened in.
 *
 * That is the whole point of a deterministic world — "GLASSWING, 214 km,
 * reached the night" is not a score, it is an address. You can go back.
 */
export class Logbook {
  private entries: LogbookEntry[] = [];

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.entries = parsed.filter(
          (e): e is LogbookEntry =>
            !!e && typeof e === 'object' && typeof (e as LogbookEntry).seed === 'number',
        );
      }
    } catch {
      // A corrupt or unavailable store is not worth interrupting a flight for.
      this.entries = [];
    }
  }

  private save(): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(this.entries.slice(0, MAX_ENTRIES)));
    } catch {
      /* private browsing, quota, whatever — the flight still happened. */
    }
  }

  all(): readonly LogbookEntry[] {
    return this.entries;
  }

  /** Best crossing by distance, if there is one. */
  best(): LogbookEntry | null {
    let best: LogbookEntry | null = null;
    for (const e of this.entries) if (!best || e.distance > best.distance) best = e;
    return best;
  }

  record(stats: RunStats): LogbookEntry {
    const entry: LogbookEntry = {
      seed: stats.seed,
      seedName: stats.seedName,
      distance: stats.distance,
      peakAltitude: stats.peakAltitude,
      duration: stats.duration,
      flock: stats.peakFlock,
      reachedNight: stats.reachedNight,
      touchedWave: stats.touchedWave,
      endPhase: stats.endPhase,
      when: Date.now(),
    };
    this.entries.unshift(entry);
    this.entries.sort((a, b) => b.distance - a.distance);
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES;
    this.save();
    return entry;
  }

  clear(): void {
    this.entries = [];
    this.save();
  }
}
