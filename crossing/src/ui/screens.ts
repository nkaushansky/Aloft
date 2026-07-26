import type { LogbookEntry, RunStats } from '../sim/types';
import { AirKind } from '../sim/types';
import { airKindColor, airKindLabel } from '../sim/wind';
import { seedFromString } from '../sim/noise';
import { clamp01 } from '../sim/math';

/**
 * The two screens that bookend a crossing.
 *
 * The title has one job beyond starting the game: to make the seed feel like
 * a place rather than a number, because in a deterministic world it is one.
 *
 * The summary has one job beyond showing statistics: to hand you a souvenir.
 * The route map is the whole point of it — a trace of where you actually
 * went, coloured segment by segment with the air that carried you, so you can
 * see at a glance that the first hour was ridge-crawling, the middle was a
 * chain of thermals, and the last forty kilometres were one long wave climb.
 * The sawtooth shape of a soaring flight is beautiful and nobody ever gets to
 * look at it.
 */

// ====================================================================== title

export class TitleScreen {
  private readonly root: HTMLElement;
  private readonly seedName: HTMLElement;
  private readonly seedInput: HTMLInputElement;
  private readonly foot: HTMLElement;
  private readonly keys: HTMLElement;

  private beginFn: (mode: 'crossing' | 'drift') => void = () => {};
  private newSeedFn: () => void = () => {};
  private seedEntryFn: (seed: number) => void = () => {};
  private logbookFn: () => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = parent;

    const block = el('div', 'title-block');

    const eyebrow = el('p', 'title-eyebrow');
    eyebrow.textContent = 'A soaring game';

    const word = el('h1', 'title-word');
    word.append(text('Aloft'), tag('em', '.'));

    const sub = el('p', 'title-eyebrow');
    sub.style.marginTop = '14px';
    sub.textContent = 'The Crossing';

    const tagline = el('p', 'title-tag');
    tagline.textContent =
      'One day, one continent, and an atmosphere you can see. Find the air that is going up — ' +
      'it is the only thing out here that can give you back what you spend.';

    // --- the seed, as an address ----------------------------------------
    const seedRow = el('div', 'title-seed');
    seedRow.append(text('sky'));
    this.seedName = tag('b', '');
    this.seedName.style.cursor = 'text';
    this.seedName.title = 'click to name a sky';
    this.seedInput = document.createElement('input');
    this.seedInput.type = 'text';
    this.seedInput.maxLength = 16;
    this.seedInput.style.display = 'none';
    this.seedInput.style.font = 'inherit';
    this.seedInput.style.background = 'none';
    this.seedInput.style.border = '0';
    this.seedInput.style.borderBottom = '1px solid currentColor';
    this.seedInput.style.color = 'inherit';
    this.seedInput.style.letterSpacing = '.22em';
    this.seedInput.style.width = '10ch';
    this.seedInput.style.outline = 'none';

    this.seedName.addEventListener('click', () => {
      this.seedName.style.display = 'none';
      this.seedInput.style.display = '';
      this.seedInput.value = '';
      this.seedInput.focus();
    });
    const commitSeed = (): void => {
      const v = this.seedInput.value.trim().toUpperCase();
      this.seedInput.style.display = 'none';
      this.seedName.style.display = '';
      if (v) this.seedEntryFn(seedFromString(v));
    };
    this.seedInput.addEventListener('blur', commitSeed);
    this.seedInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commitSeed();
      if (e.key === 'Escape') {
        this.seedInput.value = '';
        commitSeed();
      }
      e.stopPropagation();
    });

    const deal = tag('button', 'deal another');
    deal.addEventListener('click', () => this.newSeedFn());
    seedRow.append(this.seedName, this.seedInput, deal);

    // --- actions ---------------------------------------------------------
    const actions = el('div', 'title-actions');
    const begin = button('Begin the crossing', 'btn primary');
    begin.addEventListener('click', () => this.beginFn('crossing'));
    const drift = button('Drift', 'btn ghost');
    drift.title = 'No clock. Endless golden hour. Just fly.';
    drift.addEventListener('click', () => this.beginFn('drift'));
    const log = button('Logbook', 'btn ghost');
    log.addEventListener('click', () => this.logbookFn());
    actions.append(begin, drift, log);

    // --- controls --------------------------------------------------------
    this.keys = el('div', 'keys');
    const rows: Array<[string, string]> = [
      ['W S / ↑ ↓', 'pitch — trade height for speed and back'],
      ['A D / ← →', 'roll — bank to turn'],
      ['Shift', 'TUCK · fast and low-drag, for crossing sink'],
      ['Space', 'SPREAD · slow and tight, for coring a thermal'],
      ['C', 'fly with the mouse'],
      ['M · R · Esc', 'mute · restart · back to the sky list'],
    ];
    for (const [k, d] of rows) {
      const kbd = document.createElement('kbd');
      kbd.textContent = k;
      const desc = tag('span', d);
      this.keys.append(kbd, desc);
    }
    const pad = document.createElement('kbd');
    pad.textContent = 'Gamepad';
    this.keys.append(pad, tag('span', 'left stick flies · triggers are the wings'));

    block.append(eyebrow, word, sub, tagline, seedRow, actions, this.keys);
    parent.appendChild(block);

    this.foot = el('div', 'title-foot');
    parent.appendChild(this.foot);
  }

  show(opts: { seed: number; seedName: string; best: LogbookEntry | null; isTouch: boolean }): void {
    this.root.classList.remove('hidden');
    this.seedName.textContent = opts.seedName;
    this.keys.style.display = opts.isTouch ? 'none' : '';

    this.foot.replaceChildren();
    const left = el('span', '');
    left.textContent = opts.best
      ? `best crossing · ${(opts.best.distance / 1000).toFixed(1)} km in ${opts.best.seedName}` +
        (opts.best.reachedNight ? ' · reached the night' : '')
      : 'no crossings yet — the first hour is the hardest hour';
    const right = el('span', '');
    right.textContent = 'seven kinds of air · one day';
    this.foot.append(left, right);
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  onBegin(fn: (mode: 'crossing' | 'drift') => void): void {
    this.beginFn = fn;
  }
  onNewSeed(fn: () => void): void {
    this.newSeedFn = fn;
  }
  onSeedEntry(fn: (seed: number) => void): void {
    this.seedEntryFn = fn;
  }
  onLogbook(fn: () => void): void {
    this.logbookFn = fn;
  }
  dispose(): void {
    this.root.replaceChildren();
  }
}

// ==================================================================== summary

/** The order climb sources are stacked in, best-to-worst as a flying story. */
const SOURCE_ORDER: AirKind[] = [
  AirKind.Wave,
  AirKind.Convergence,
  AirKind.Thermal,
  AirKind.Ridge,
  AirKind.Rotor,
];

export class SummaryScreen {
  private readonly root: HTMLElement;
  private readonly card: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly seedEl: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly grid: HTMLElement;
  private readonly sources: HTMLElement;
  private readonly verdictEl: HTMLElement;
  private readonly logList: HTMLElement;

  private againFn: () => void = () => {};
  private newWorldFn: () => void = () => {};
  private titleFn: () => void = () => {};

  constructor(parent: HTMLElement) {
    this.root = parent;
    this.card = el('div', 'sum-card');

    const head = el('div', 'sum-head');
    this.titleEl = el('h2', 'sum-title');
    this.seedEl = el('div', 'sum-seed');
    head.append(this.titleEl, this.seedEl);

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'sum-map';

    this.grid = el('div', 'sum-grid');
    this.sources = el('div', 'sum-sources');
    this.verdictEl = el('p', 'sum-verdict');

    const actions = el('div', 'sum-actions');
    const again = button('Fly this sky again', 'btn primary');
    again.addEventListener('click', () => this.againFn());
    const fresh = button('New sky', 'btn ghost');
    fresh.addEventListener('click', () => this.newWorldFn());
    const back = button('Back', 'btn ghost');
    back.addEventListener('click', () => this.titleFn());
    actions.append(again, fresh, back);

    const logHead = el('h3', '');
    logHead.style.cssText =
      'font-family:var(--mono);font-size:9.5px;letter-spacing:.26em;text-transform:uppercase;' +
      'color:var(--faint);margin:34px 0 0;font-weight:400';
    logHead.textContent = 'Logbook';
    this.logList = el('div', 'log-list');

    this.card.append(
      head,
      this.canvas,
      this.grid,
      this.sources,
      this.verdictEl,
      actions,
      logHead,
      this.logList,
    );
    parent.appendChild(this.card);
  }

  show(
    stats: RunStats,
    verdict: string,
    runTitle: string,
    logbook: readonly LogbookEntry[],
  ): void {
    this.root.style.display = '';
    // A frame's delay so the CSS transition actually runs rather than the
    // element simply appearing at full opacity.
    requestAnimationFrame(() => this.root.classList.add('show'));

    this.titleEl.textContent = runTitle;
    this.seedEl.textContent = stats.seedName;
    this.verdictEl.textContent = verdict;
    this.verdictEl.style.display = verdict ? '' : 'none';

    this.drawRoute(stats);
    this.buildStats(stats);
    this.buildSources(stats);
    this.buildLogbook(logbook, stats.seed);
  }

  hide(): void {
    this.root.classList.remove('show');
    this.root.style.display = 'none';
  }

  onAgain(fn: () => void): void {
    this.againFn = fn;
  }
  onNewWorld(fn: () => void): void {
    this.newWorldFn = fn;
  }
  onTitle(fn: () => void): void {
    this.titleFn = fn;
  }
  dispose(): void {
    this.root.replaceChildren();
  }

  // ------------------------------------------------------------ the map

  /**
   * The souvenir. Plan view of the route, with each segment stroked in the
   * colour of the air that carried the bird through it, plus an altitude
   * trace along the bottom so the sawtooth of a soaring flight is visible.
   */
  private drawRoute(stats: RunStats): void {
    const cv = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = cv.clientWidth || 800;
    const cssH = cv.clientHeight || Math.round((cssW * 7) / 16);
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
    const g = cv.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);

    const route = stats.route;
    if (route.length < 2) {
      g.fillStyle = 'rgba(150,166,190,.45)';
      g.font = '11px "Spline Sans Mono", monospace';
      g.textAlign = 'center';
      g.fillText('too short to draw', cssW / 2, cssH / 2);
      return;
    }

    // Fit the extent, preserving aspect so the shape of the flight is honest.
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    let maxY = 1;
    for (const p of route) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
      if (p.y > maxY) maxY = p.y;
    }
    const pad = 34;
    const traceH = 46; // altitude strip along the bottom
    const mapH = cssH - traceH - pad;
    const spanX = Math.max(maxX - minX, 1);
    const spanZ = Math.max(maxZ - minZ, 1);
    const scale = Math.min((cssW - pad * 2) / spanX, (mapH - pad) / spanZ);
    const ox = (cssW - spanX * scale) / 2 - minX * scale;
    const oy = (mapH - spanZ * scale) / 2 - minZ * scale + pad * 0.4;

    const px = (p: { x: number; z: number }): number => p.x * scale + ox;
    const py = (p: { x: number; z: number }): number => p.z * scale + oy;

    // The route, segment by segment in the colour of the air.
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1];
      const b = route[i];
      const c = airKindColor(b.kind);
      // Width encodes height: a high, fast leg draws heavier than a scratch
      // along a ridge, so the shape of the day is legible at a glance.
      const h = clamp01(b.y / maxY);
      g.lineWidth = 1 + h * 3.4;
      g.strokeStyle = `rgba(${to255(c.r)},${to255(c.g)},${to255(c.b)},${0.5 + h * 0.5})`;
      g.beginPath();
      g.moveTo(px(a), py(a));
      g.lineTo(px(b), py(b));
      g.stroke();
    }

    // Launch and landing.
    const first = route[0];
    const lastP = route[route.length - 1];
    g.strokeStyle = 'rgba(219,228,242,.8)';
    g.lineWidth = 1.2;
    g.beginPath();
    g.arc(px(first), py(first), 4.5, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.moveTo(px(lastP) - 4.5, py(lastP) - 4.5);
    g.lineTo(px(lastP) + 4.5, py(lastP) + 4.5);
    g.moveTo(px(lastP) + 4.5, py(lastP) - 4.5);
    g.lineTo(px(lastP) - 4.5, py(lastP) + 4.5);
    g.stroke();

    // --- altitude trace ---------------------------------------------------
    const ty = cssH - traceH * 0.35;
    g.strokeStyle = 'rgba(219,228,242,.16)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(pad, ty);
    g.lineTo(cssW - pad, ty);
    g.stroke();

    g.beginPath();
    for (let i = 0; i < route.length; i++) {
      const u = i / (route.length - 1);
      const x = pad + u * (cssW - pad * 2);
      const y = ty - (route[i].y / maxY) * (traceH * 0.78);
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.strokeStyle = 'rgba(232,177,102,.75)';
    g.lineWidth = 1.4;
    g.stroke();

    // --- scale bar and north ----------------------------------------------
    g.font = '9.5px "Spline Sans Mono", monospace';
    g.fillStyle = 'rgba(150,166,190,.6)';
    g.textAlign = 'left';
    const kmPx = 1000 * scale;
    // Choose a round number of km that fits comfortably.
    let barKm = 1;
    while (barKm * kmPx < 60) barKm *= 2;
    g.strokeStyle = 'rgba(150,166,190,.5)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(pad, cssH - 10);
    g.lineTo(pad + barKm * kmPx, cssH - 10);
    g.stroke();
    g.fillText(`${barKm} km`, pad, cssH - 15);

    g.textAlign = 'right';
    g.fillText('N ↑', cssW - pad, pad * 0.7);
    g.fillText(`peak ${Math.round(maxY).toLocaleString('en-US')} m`, cssW - pad, cssH - 15);
  }

  // ------------------------------------------------------------- panels

  private buildStats(s: RunStats): void {
    this.grid.replaceChildren();
    const items: Array<[string, string, string, boolean]> = [
      ['crossed', (s.distance / 1000).toFixed(1), 'km', true],
      ['flown', (s.pathLength / 1000).toFixed(1), 'km', false],
      ['peak height', Math.round(s.peakAltitude).toLocaleString('en-US'), 'm', true],
      ['best climb', Math.round(s.bestClimb).toLocaleString('en-US'), 'm', false],
      ['airborne', duration(s.duration), '', false],
      ['top speed', s.peakSpeed.toFixed(0), 'm/s', false],
      ['companions', `${s.peakFlock}`, '', s.peakFlock >= 20],
    ];
    for (const [k, v, unit, hero] of items) {
      const d = el('dl', 'sum-stat' + (hero ? ' hero' : ''));
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      if (unit) {
        const sm = document.createElement('small');
        sm.textContent = unit;
        dd.appendChild(sm);
      }
      d.append(dt, dd);
      this.grid.appendChild(d);
    }
  }

  /** Where every metre of climb actually came from. The honest account. */
  private buildSources(s: RunStats): void {
    this.sources.replaceChildren();
    const h = el('h3', '');
    h.textContent = 'where the height came from';
    this.sources.appendChild(h);

    let total = 0;
    for (const k of SOURCE_ORDER) total += s.climbBySource[k] ?? 0;

    const bar = el('div', 'sum-bar');
    const legend = el('div', 'sum-legend');
    if (total < 1) {
      const empty = el('div', 'log-empty');
      empty.textContent = 'you never climbed — the whole flight was the height you launched with';
      this.sources.appendChild(empty);
      return;
    }
    for (const k of SOURCE_ORDER) {
      const m = s.climbBySource[k] ?? 0;
      if (m < total * 0.005) continue;
      const c = airKindColor(k);
      const css = `rgb(${to255(c.r)},${to255(c.g)},${to255(c.b)})`;
      const seg = document.createElement('span');
      seg.style.background = css;
      seg.style.width = `${((m / total) * 100).toFixed(1)}%`;
      bar.appendChild(seg);

      const item = document.createElement('span');
      const swatch = document.createElement('b');
      swatch.style.background = css;
      item.append(swatch, text(`${airKindLabel(k)} ${Math.round((m / total) * 100)}%`));
      legend.appendChild(item);
    }
    this.sources.append(bar, legend);
  }

  private buildLogbook(entries: readonly LogbookEntry[], currentSeed: number): void {
    this.logList.replaceChildren();
    if (entries.length === 0) {
      const e = el('div', 'log-empty');
      e.textContent = 'nothing logged yet';
      this.logList.appendChild(e);
      return;
    }
    for (const en of entries.slice(0, 10)) {
      const row = el('div', 'log-row');
      const name = tag('b', en.seedName);
      if (en.seed === currentSeed) name.style.color = 'rgb(var(--sky-glow))';
      const badge = el('span', 'badge');
      badge.textContent = en.reachedNight ? 'NIGHT' : en.touchedWave ? 'WAVE' : '';
      row.append(
        name,
        badge,
        tag('span', `${(en.distance / 1000).toFixed(1)} km`),
        tag('span', `${Math.round(en.peakAltitude).toLocaleString('en-US')} m`),
      );
      this.logList.appendChild(row);
    }
  }
}

// ------------------------------------------------------------------ utils

function el(t: string, cls: string): HTMLElement {
  const e = document.createElement(t);
  if (cls) e.className = cls;
  return e;
}

function tag(t: string, content: string): HTMLElement {
  const e = document.createElement(t);
  e.textContent = content;
  return e;
}

function button(labelText: string, cls: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = cls;
  b.textContent = labelText;
  return b;
}

function text(s: string): Text {
  return document.createTextNode(s);
}

const to255 = (v: number): number =>
  Math.round(clamp01(Math.pow(clamp01(v), 1 / 2.2)) * 255);

function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}
