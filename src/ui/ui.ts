import './style.css';
import type { SaveData, Settings } from '../game/save';
import { MOVEMENTS } from '../game/days';
import { LAND_ORDER, LandId } from '../world/lands';

export interface MenuItem {
  label: string;
  note?: string;
  disabled?: boolean;
  run: () => void;
}

const GRAD: Record<LandId, string> = {
  stillmere: 'linear-gradient(165deg,#4d6a9a,#d9a68c 58%,#8d7a5c)',
  copper: 'linear-gradient(165deg,#5b7fae,#e2a65c 52%,#8d3c1e)',
  stair: 'linear-gradient(165deg,#163f8a,#7aa4dc 52%,#e6e9f4)',
  rooms: 'linear-gradient(165deg,#3a6ea6,#e8b27a 45%,#9a3f2a)',
  darkwater: 'linear-gradient(165deg,#050d28,#123a6a 55%,#1f8f8c)',
  wintering: 'linear-gradient(165deg,#6d7fb6,#f2b48c 55%,#b39a4c)',
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

/** All the words and the few instruments. Nothing here knows the sim. */
export class Ui {
  readonly root: HTMLElement;
  private readonly loadEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly card: HTMLElement;
  private readonly verseEl: HTMLElement;
  private readonly whisperEl: HTMLElement;
  private readonly placeEl: HTMLElement;
  private readonly hudEl: HTMLElement;
  private readonly alt: HTMLElement;
  private readonly spd: HTMLElement;
  private readonly clip: SVGRectElement;
  private readonly rays: SVGElement[] = [];
  private readonly markEl: HTMLElement;
  private readonly panelEl: HTMLElement;
  private readonly logEl: HTMLElement;
  private readonly photoEl: HTMLElement;
  private readonly creditEl: HTMLElement;
  private readonly toastEl: HTMLElement;
  private readonly touchEl: HTMLElement;
  private readonly pauseEl: HTMLElement;
  private readonly stickEl: HTMLElement;
  private timers = new Map<string, number>();
  private items: HTMLButtonElement[] = [];
  private sel = -1;
  onWing: (down: boolean) => void = () => {};
  onCall: () => void = () => {};
  onPause: () => void = () => {};
  onUi: (k: 'move' | 'select' | 'back') => void = () => {};
  panelOpen = false;

  constructor(root: HTMLElement) {
    this.root = root;
    this.loadEl = el('div', 'load', `<div class="in"><div class="w">ALOFT</div><div class="bar"><i></i></div><div class="t"></div></div>`);
    this.titleEl = el('div', 'title', `<h1 class="mark">Aloft</h1><div class="sub"></div><div class="menu"></div>`);
    this.card = el('div', 'card', `<div class="num"></div><div class="name"></div>`);
    this.verseEl = el('div', 'verse');
    this.whisperEl = el('div', 'whisper');
    this.placeEl = el('div', 'place', `<div class="n"></div><div class="r"></div>`);
    this.hudEl = el(
      'div',
      'hud',
      `<div class="v l"><span></span><i>m</i></div>
      <svg viewBox="0 0 84 46" aria-hidden="true"><defs><clipPath id="fc"><rect x="4" y="0" width="76" height="46"/></clipPath></defs>
      <g clip-path="url(#fc)"><path class="fill" d="M8 34 C20 17 46 6 78 8 C70 24 46 37 21 35 C16 35 12 35 8 34Z"/></g>
      <path class="vane" d="M8 34 C20 17 46 6 78 8 C70 24 46 37 21 35 C16 35 12 35 8 34Z"/>
      <path class="quill" d="M2 39 C22 30 48 19 72 11"/>
      <circle class="ray" cx="36" cy="-4" r="1.7"/><circle class="ray" cx="42" cy="-10" r="1.7"/><circle class="ray" cx="48" cy="-16" r="1.7"/></svg>
      <div class="v r"><span></span><i>km/h</i></div>`,
    );
    this.alt = this.hudEl.querySelector('.l span')!;
    this.spd = this.hudEl.querySelector('.r span')!;
    this.clip = this.hudEl.querySelector('#fc rect') as SVGRectElement;
    this.rays = Array.from(this.hudEl.querySelectorAll('.ray')) as unknown as SVGElement[];
    this.markEl = el('div', 'mark-a');
    this.panelEl = el('div', 'panel');
    this.logEl = el('div', 'log');
    this.photoEl = el('div', 'photo');
    this.creditEl = el('div', 'credit');
    this.toastEl = el('div', 'toast');
    this.stickEl = el('div', 'stick', '<i></i>');
    this.touchEl = el('div', 'touch', `<div class="tb small" data-k="call">call</div><div class="tb" data-k="wing">wings</div>`);
    this.pauseEl = el('div', 'tp');
    root.append(this.stickEl, this.hudEl, this.markEl, this.placeEl, this.whisperEl, this.card, this.verseEl, this.logEl, this.touchEl, this.pauseEl, this.titleEl, this.creditEl, this.photoEl, this.panelEl, this.toastEl, this.loadEl);

    const wing = this.touchEl.querySelector('[data-k=wing]') as HTMLElement;
    wing.addEventListener('pointerdown', (e) => {
      wing.setPointerCapture(e.pointerId);
      wing.classList.add('act');
      this.onWing(true);
    });
    const up = () => {
      wing.classList.remove('act');
      this.onWing(false);
    };
    wing.addEventListener('pointerup', up);
    wing.addEventListener('pointercancel', up);
    const call = this.touchEl.querySelector('[data-k=call]') as HTMLElement;
    call.addEventListener('pointerdown', () => {
      call.classList.add('act');
      setTimeout(() => call.classList.remove('act'), 500);
      this.onCall();
    });
    this.pauseEl.addEventListener('click', () => this.onPause());
  }

  private later(key: string, ms: number, fn: () => void): void {
    clearTimeout(this.timers.get(key));
    this.timers.set(key, window.setTimeout(fn, ms));
  }

  // --- loading -------------------------------------------------------------
  loading(p: number, text: string): void {
    this.loadEl.classList.remove('gone');
    (this.loadEl.querySelector('i') as HTMLElement).style.width = `${Math.round(p * 100)}%`;
    this.loadEl.querySelector('.t')!.textContent = text;
  }
  loaded(): void {
    this.loadEl.classList.add('gone');
  }

  // --- title ----------------------------------------------------------------
  showTitle(sub: string, items: MenuItem[]): void {
    this.titleEl.querySelector('.sub')!.textContent = sub;
    this.fillMenu(this.titleEl.querySelector('.menu') as HTMLElement, items);
    this.titleEl.classList.add('on');
    (this.titleEl as HTMLElement).style.pointerEvents = 'auto';
  }
  hideTitle(): void {
    this.titleEl.classList.remove('on');
    this.titleEl.style.pointerEvents = 'none';
    this.items = [];
    (this.titleEl.querySelector('.menu') as HTMLElement).innerHTML = '';
  }

  private fillMenu(host: HTMLElement, items: MenuItem[]): void {
    host.innerHTML = '';
    this.items = [];
    this.sel = -1;
    for (const it of items) {
      const b = el('button', '', `${it.label}${it.note ? `<small>${it.note}</small>` : ''}`);
      if (it.disabled) b.disabled = true;
      b.addEventListener('click', () => {
        this.onUi('select');
        it.run();
      });
      b.addEventListener('pointerenter', () => this.onUi('move'));
      host.append(b);
      if (!it.disabled) this.items.push(b);
    }
  }

  /** keyboard / gamepad menu movement; returns true if consumed */
  nav(a: 'up' | 'down' | 'confirm'): boolean {
    if (!this.items.length) return false;
    if (a === 'confirm') {
      if (this.sel < 0) this.sel = 0;
      this.items[this.sel]?.click();
      return true;
    }
    this.sel = (this.sel + (a === 'down' ? 1 : -1) + this.items.length) % this.items.length;
    if (this.sel < 0) this.sel = 0;
    this.items.forEach((b, i) => b.classList.toggle('sel', i === this.sel));
    this.onUi('move');
    return true;
  }

  // --- words ------------------------------------------------------------------
  chapter(num: string, name: string, hold = 5200): void {
    this.card.querySelector('.num')!.textContent = num;
    this.card.querySelector('.name')!.textContent = name;
    this.card.classList.add('on');
    this.later('card', hold, () => this.card.classList.remove('on'));
  }
  hideChapter(): void {
    this.card.classList.remove('on');
  }

  verse(lines: string[], hold = 7000, gap = 1900): void {
    this.verseEl.innerHTML = '';
    lines.forEach((l, i) => {
      const s = el('span');
      s.textContent = l;
      this.verseEl.append(s);
      setTimeout(() => s.classList.add('on'), 80 + i * gap);
    });
    this.verseEl.classList.add('on');
    this.later('verse', hold + (lines.length - 1) * gap, () => this.verseEl.classList.remove('on'));
  }
  hideVerse(): void {
    this.verseEl.classList.remove('on');
  }

  whisper(html: string, hold = 6500): void {
    this.whisperEl.innerHTML = html;
    this.whisperEl.classList.add('on');
    if (hold > 0) this.later('whisper', hold, () => this.whisperEl.classList.remove('on'));
    else clearTimeout(this.timers.get('whisper'));
  }
  hush(): void {
    this.whisperEl.classList.remove('on');
  }

  place(name: string): void {
    this.placeEl.querySelector('.n')!.textContent = name;
    this.placeEl.classList.add('on');
    this.later('place', 5600, () => this.placeEl.classList.remove('on'));
  }

  toast(text: string): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add('on');
    this.later('toast', 2200, () => this.toastEl.classList.remove('on'));
  }

  log(parts: Array<[string, string]>): void {
    this.logEl.innerHTML = parts.map(([k, v]) => `<span>${k} <b>${v}</b></span>`).join('');
    this.logEl.classList.add('on');
  }
  hideLog(): void {
    this.logEl.classList.remove('on');
  }

  credit(main: string, sub: string): void {
    this.creditEl.innerHTML = `<div><div class="m">${main}</div><div class="s">${sub}</div></div>`;
    this.creditEl.classList.add('on');
  }
  hideCredit(): void {
    this.creditEl.classList.remove('on');
  }

  // --- instruments -------------------------------------------------------------
  private hudOn = false;
  hud(on: boolean): void {
    if (on === this.hudOn) return;
    this.hudOn = on;
    this.hudEl.classList.toggle('on', on);
  }
  private lastA = -1;
  private lastS = -1;
  instruments(agl: number, kmh: number, breath: number, lift: number): void {
    if (!this.hudOn) return;
    const a = Math.max(0, Math.round(agl));
    const s = Math.round(kmh);
    if (a !== this.lastA) this.alt.textContent = String((this.lastA = a));
    if (s !== this.lastS) this.spd.textContent = String((this.lastS = s));
    this.clip.setAttribute('width', String(4 + 72 * Math.max(0, Math.min(1, breath))));
    this.hudEl.classList.toggle('lift', lift > 0.8);
    this.rays.forEach((r, i) => ((r as unknown as HTMLElement).style.opacity = String(Math.max(0, Math.min(1, (lift - 0.6 - i * 1.7) / 1.4)))));
  }

  touch(on: boolean): void {
    this.touchEl.classList.toggle('on', on);
    this.pauseEl.classList.toggle('on', on);
  }
  stick(s: { x: number; y: number; dx: number; dy: number } | null, show: boolean): void {
    this.stickEl.classList.toggle('on', !!s && show);
    if (s) {
      this.stickEl.style.transform = `translate(${s.x}px,${s.y}px)`;
      (this.stickEl.firstElementChild as HTMLElement).style.transform = `translate(${s.dx * 50}px,${s.dy * 50}px)`;
    }
  }

  /** ring the place on screen (or at its edge) the answer came from */
  answer(x: number, y: number): void {
    const m = this.markEl;
    m.style.transform = `translate(${x}px,${y}px)`;
    m.classList.remove('go');
    void m.offsetWidth;
    m.classList.add('go');
  }

  // --- panels --------------------------------------------------------------------
  closePanel(): void {
    this.panelEl.classList.remove('on');
    this.root.classList.remove('paneled');
    this.panelOpen = false;
    this.items = [];
  }

  private openPanel(): HTMLElement {
    this.panelEl.innerHTML = '';
    const w = el('div', 'wrap');
    this.panelEl.append(w);
    this.panelEl.classList.add('on');
    this.root.classList.add('paneled');
    this.panelEl.scrollTop = 0;
    this.panelOpen = true;
    return w;
  }

  pause(title: string, items: MenuItem[]): void {
    const w = this.openPanel();
    w.append(el('h2', '', title));
    const m = el('div', 'menu');
    w.append(m);
    this.fillMenu(m, items);
  }

  settings(s: Settings, change: () => void, back: () => void): void {
    const w = this.openPanel();
    w.append(el('h2', '', 'Settings'));
    const g = el('div', 'set');
    w.append(g);
    const range = (label: string, key: 'master' | 'music' | 'world' | 'painterly') => {
      const l = el('label', '', label);
      const i = el('input');
      i.type = 'range';
      i.min = '0';
      i.max = '1';
      i.step = '0.01';
      i.value = String(s[key]);
      i.addEventListener('input', () => {
        s[key] = Number(i.value);
        change();
      });
      g.append(l, i);
    };
    const seg = <T extends string | boolean>(label: string, key: keyof Settings, opts: Array<[T, string]>) => {
      const l = el('label', '', label);
      const d = el('div', 'seg');
      for (const [v, t] of opts) {
        const b = el('button', s[key] === v ? 'on' : '', t);
        b.addEventListener('click', () => {
          (s as unknown as Record<string, unknown>)[key] = v;
          for (const c of Array.from(d.children)) c.classList.remove('on');
          b.classList.add('on');
          this.onUi('select');
          change();
        });
        d.append(b);
      }
      g.append(l, d);
    };
    range('Volume', 'master');
    range('Music', 'music');
    range('World', 'world');
    range('Brushwork', 'painterly');
    seg('Picture', 'quality', [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['ultra', 'Ultra']]);
    seg('Up and down', 'invert', [[false, 'Push to dive'], [true, 'Inverted']]);
    seg('Instruments', 'hud', [[true, 'Shown'], [false, 'Hidden']]);
    seg('Camera sway', 'motion', [[true, 'On'], [false, 'Off']]);
    seg('Guidance', 'hints', [[true, 'On'], [false, 'Off']]);
    const m = el('div', 'menu');
    w.append(m);
    this.fillMenu(m, [{ label: 'Back', run: back }]);
  }

  howto(touch: boolean, back: () => void): void {
    const w = this.openPanel();
    w.append(el('h2', '', 'How to fly'));
    const k = el('div', 'keys');
    const row = (a: string, b: string) => k.append(el('div', '', a), el('div', '', b));
    if (touch) {
      row('Drag anywhere', 'Lean. Up is nose down, down is nose up.');
      row('Wings', 'Hold to beat. It costs breath; rising air and rest give it back.');
      row('Call', 'The flock answers from where it is. Your voice also shows you the air.');
    } else {
      row('<kbd>W</kbd><kbd>S</kbd>', 'Nose down for speed, nose up to spend it on height');
      row('<kbd>A</kbd><kbd>D</kbd>', 'Lean left and right');
      row('<kbd>Space</kbd>', 'Beat your wings. It costs breath; rising air and rest give it back.');
      row('<kbd>E</kbd>', 'Call. The flock answers from where it is, and your voice shows you the air.');
      row('<kbd>Q</kbd>', 'Drift: let the bird fly itself, and just look');
      row('<kbd>P</kbd>', 'Take a postcard');
      row('<kbd>Esc</kbd>', 'Rest');
    }
    w.append(k);
    w.append(el('p', '', 'Height and speed are one thing in two forms: trade them freely. Only rising air adds more. Look for spirals of light under small clouds, for birds already turning, for wind meeting a hill, and late in the day for the whole land breathing out.'));
    w.append(el('p', '', 'There is nothing to fail. Touch down anywhere and rest. The day waits for you.'));
    const m = el('div', 'menu');
    w.append(m);
    this.fillMenu(m, [{ label: 'Back', run: back }]);
  }

  road(d: SaveData, pick: (id: LandId, seed: number | undefined) => void, back: () => void): void {
    const w = this.openPanel();
    w.append(el('h2', '', 'The road south'));
    w.append(el('p', '', d.arrived ? 'Every land is open. Fly any of them, as long as you like.' : 'Lands you have reached stay open. Go back and fly them as long as you like.'));
    const g = el('div', 'road');
    const seedIn = el('input');
    seedIn.type = 'text';
    seedIn.inputMode = 'numeric';
    seedIn.placeholder = 'home';
    LAND_ORDER.forEach((id, i) => {
      const mv = MOVEMENTS[id];
      const open = d.arrived || i <= d.day;
      const rec = d.days[id];
      const b = el('button', 'land');
      b.style.setProperty('--g', GRAD[id]);
      if (!open) b.disabled = true;
      const found = d.landmarks.filter((l) => l.startsWith(id + ':')).map((l) => l.split(':')[1]);
      b.innerHTML = `<div class="num">${mv.numeral}</div><div class="name">${open ? mv.title : '—'}</div><div class="meta">${
        rec ? `${(rec.distance / 1000).toFixed(1)} km · highest ${Math.round(rec.highest)} m · ${rec.feathers} of ${rec.feathersTotal} feathers` : open ? 'Not yet flown' : ''
      }${found.length ? `<br>${found.length} place${found.length > 1 ? 's' : ''} known` : ''}</div>`;
      b.addEventListener('click', () => {
        this.onUi('select');
        const v = parseInt(seedIn.value, 10);
        pick(id, Number.isFinite(v) ? v : undefined);
      });
      g.append(b);
    });
    w.append(g);
    const r = el('div', 'seedrow');
    const dice = el('button', '');
    dice.textContent = 'Deal another';
    dice.style.cssText = 'all:unset;cursor:pointer;pointer-events:auto;font-family:Forum,serif;font-size:18px;border-bottom:1px solid rgba(253,246,234,.3)';
    dice.addEventListener('click', () => {
      seedIn.value = String(1 + Math.floor(Math.random() * 9998));
      this.onUi('move');
    });
    r.append(el('span', '', 'A number is a whole country. The same number is always the same place.'), seedIn, dice);
    w.append(r);
    const m = el('div', 'menu');
    w.append(m);
    this.fillMenu(m, [{ label: 'Back', run: back }]);
  }

  // --- photo -----------------------------------------------------------------------
  photo(o: { time: number; fov: number; onTime: (v: number) => void; onFov: (v: number) => void; shoot: () => void; close: () => void }): void {
    this.photoEl.innerHTML = `<div class="bar"><label>Light <input type="range" data-k="t" min="0" max="1" step="0.002" value="${o.time}"></label><label>Lens <input type="range" data-k="f" min="18" max="90" step="0.5" value="${o.fov}"></label><button data-k="s">Keep</button><button data-k="x">Back</button></div><div class="shot"></div>`;
    const q = (k: string) => this.photoEl.querySelector(`[data-k=${k}]`) as HTMLInputElement;
    q('t').addEventListener('input', () => o.onTime(Number(q('t').value)));
    q('f').addEventListener('input', () => o.onFov(Number(q('f').value)));
    q('s').addEventListener('click', () => o.shoot());
    q('x').addEventListener('click', () => o.close());
    this.photoEl.classList.add('on');
  }
  postcard(url: string, name: string): void {
    const s = this.photoEl.querySelector('.shot') as HTMLElement;
    s.innerHTML = `<div style="text-align:center"><img src="${url}" alt="Postcard"><div style="margin-top:18px;display:flex;gap:14px;justify-content:center"><button data-k="d">Save</button><button data-k="c">Close</button></div></div>`;
    s.classList.add('on');
    (s.querySelector('[data-k=d]') as HTMLElement).addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
    });
    (s.querySelector('[data-k=c]') as HTMLElement).addEventListener('click', () => s.classList.remove('on'));
  }
  hidePhoto(): void {
    this.photoEl.classList.remove('on');
    this.photoEl.innerHTML = '';
  }
}
