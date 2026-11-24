import type { FlightInput } from '../sim/flightModel';

/** One-shot things a player can ask for, whatever they hold in their hands. */
export type Action = 'call' | 'pause' | 'photo' | 'drift' | 'mute' | 'hud' | 'confirm' | 'back' | 'up' | 'down' | 'left' | 'right';

interface Source {
  read(): FlightInput;
  look?(): { x: number; y: number };
}

/**
 * All devices are peers: their sticks are summed and clamped, their actions
 * funnel into one queue. The sim never learns which was used.
 */
export class Input {
  private readonly sources: Source[] = [];
  private queue: Action[] = [];
  private listeners: Array<(a: Action) => void> = [];
  invertPitch = false;
  /** last device that did something, for prompt glyphs */
  device: 'keyboard' | 'touch' | 'gamepad' = 'keyboard';
  readonly keyboard: Keyboard;
  readonly pointer: Pointer;
  readonly gamepad: Gamepads;

  constructor(surface: HTMLElement) {
    const fire = (a: Action) => {
      this.queue.push(a);
      for (const l of this.listeners) l(a);
    };
    this.keyboard = new Keyboard(fire, () => (this.device = 'keyboard'));
    this.pointer = new Pointer(surface, (t) => {
      if (t) this.device = 'touch';
    });
    this.gamepad = new Gamepads(fire, () => (this.device = 'gamepad'));
    this.sources.push(this.keyboard, this.pointer, this.gamepad);
    if (window.matchMedia('(pointer: coarse)').matches) this.device = 'touch';
  }

  onAction(fn: (a: Action) => void): void {
    this.listeners.push(fn);
  }

  fire(a: Action): void {
    for (const l of this.listeners) l(a);
  }

  read(): FlightInput {
    let pitch = 0;
    let roll = 0;
    let beat = false;
    for (const s of this.sources) {
      const r = s.read();
      pitch += r.pitch;
      roll += r.roll;
      beat = beat || r.beat;
    }
    const c = (v: number) => Math.max(-1, Math.min(1, v));
    return { pitch: c(pitch) * (this.invertPitch ? -1 : 1), roll: c(roll), beat };
  }

  look(): { x: number; y: number } {
    let x = 0;
    let y = 0;
    for (const s of this.sources) {
      const l = s.look?.();
      if (l) {
        x += l.x;
        y += l.y;
      }
    }
    return { x, y };
  }

  clear(): void {
    this.queue.length = 0;
  }
}

/**
 *   W / ↑ : nose down      S / ↓ : nose up      (push = dive)
 *   A / ← : roll left      D / → : roll right
 *   Space : beat the wings   E : call
 */
class Keyboard implements Source {
  private down = new Set<string>();
  enabled = true;

  constructor(fire: (a: Action) => void, used: () => void) {
    const map: Record<string, Action[]> = {
      KeyE: ['call'],
      KeyF: ['call'],
      Escape: ['pause'],
      KeyP: ['photo'],
      KeyQ: ['drift'],
      KeyM: ['mute'],
      KeyH: ['hud'],
      Enter: ['confirm'],
      Space: ['confirm'],
      Backspace: ['back'],
      ArrowUp: ['up'],
      ArrowDown: ['down'],
      ArrowLeft: ['left'],
      ArrowRight: ['right'],
      KeyW: ['up'],
      KeyS: ['down'],
      KeyA: ['left'],
      KeyD: ['right'],
    };
    window.addEventListener('keydown', (e) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT')) return;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (e.repeat || e.metaKey || e.ctrlKey) return;
      used();
      this.down.add(e.code);
      for (const a of map[e.code] ?? []) fire(a);
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  read(): FlightInput {
    const d = this.down;
    let pitch = 0;
    let roll = 0;
    if (d.has('KeyW') || d.has('ArrowUp')) pitch -= 1;
    if (d.has('KeyS') || d.has('ArrowDown')) pitch += 1;
    if (d.has('KeyA') || d.has('ArrowLeft')) roll -= 1;
    if (d.has('KeyD') || d.has('ArrowRight')) roll += 1;
    return { pitch, roll, beat: d.has('Space') };
  }

  look(): { x: number; y: number } {
    const d = this.down;
    return { x: (d.has('KeyL') ? 1 : 0) - (d.has('KeyJ') ? 1 : 0), y: (d.has('KeyI') ? 1 : 0) - (d.has('KeyK') ? 1 : 0) };
  }
}

/**
 * A floating stick: wherever the finger (or mouse button) goes down becomes
 * the stick's centre. Drag up = stick forward = nose down. A second finger,
 * or the on-screen wing button, beats the wings. Right-drag looks around.
 */
class Pointer implements Source {
  private static readonly RADIUS = 78;
  private id: number | null = null;
  private ox = 0;
  private oy = 0;
  private pitch = 0;
  private roll = 0;
  private lookId: number | null = null;
  private lx = 0;
  private ly = 0;
  private lookX = 0;
  private lookY = 0;
  beating = false;
  /** for drawing the stick */
  stick: { x: number; y: number; dx: number; dy: number } | null = null;
  enabled = true;

  constructor(el: HTMLElement, used: (touch: boolean) => void) {
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      if (!this.enabled) return;
      used(e.pointerType === 'touch');
      if (e.button === 2) {
        this.lookId = e.pointerId;
        this.lx = e.clientX;
        this.ly = e.clientY;
        el.setPointerCapture(e.pointerId);
        return;
      }
      if (this.id !== null) return;
      this.id = e.pointerId;
      this.ox = e.clientX;
      this.oy = e.clientY;
      el.setPointerCapture(e.pointerId);
      this.stick = { x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.lookId) {
        this.lookX += (e.clientX - this.lx) * 0.006;
        this.lookY += (e.clientY - this.ly) * 0.006;
        this.lx = e.clientX;
        this.ly = e.clientY;
        return;
      }
      if (e.pointerId !== this.id) return;
      const r = Pointer.RADIUS;
      let dx = (e.clientX - this.ox) / r;
      let dy = (e.clientY - this.oy) / r;
      const l = Math.hypot(dx, dy);
      if (l > 1) {
        // the centre follows a long drag, so full deflection is always near
        this.ox += (dx - dx / l) * r;
        this.oy += (dy - dy / l) * r;
        dx /= l;
        dy /= l;
      }
      const soft = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), 1.35);
      this.roll = soft(dx);
      this.pitch = soft(dy);
      this.stick = { x: this.ox, y: this.oy, dx, dy };
    });
    const up = (e: PointerEvent) => {
      if (e.pointerId === this.lookId) this.lookId = null;
      if (e.pointerId !== this.id) return;
      this.id = null;
      this.pitch = this.roll = 0;
      this.stick = null;
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  release(): void {
    this.id = null;
    this.pitch = this.roll = 0;
    this.stick = null;
    this.beating = false;
  }

  read(): FlightInput {
    return { pitch: this.pitch, roll: this.roll, beat: this.beating };
  }

  look(): { x: number; y: number } {
    const r = { x: this.lookX * 20, y: this.lookY * 20 };
    this.lookX = this.lookY = 0;
    return r;
  }
}

class Gamepads implements Source {
  private prev: boolean[] = [];
  private rx = 0;
  private ry = 0;

  constructor(
    private readonly fire: (a: Action) => void,
    private readonly used: () => void,
  ) {}

  read(): FlightInput {
    let pads: ReadonlyArray<Gamepad | null> = [];
    try {
      pads = navigator.getGamepads?.() ?? [];
    } catch {
      return { pitch: 0, roll: 0, beat: false }; // framed without permission
    }
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const dz = (v: number) => (Math.abs(v) < 0.14 ? 0 : (v - Math.sign(v) * 0.14) / 0.86);
      const x = dz(p.axes[0] ?? 0);
      const y = dz(p.axes[1] ?? 0);
      this.rx = dz(p.axes[2] ?? 0);
      this.ry = dz(p.axes[3] ?? 0);
      const b = p.buttons.map((q) => q.pressed);
      const map: Array<[number, Action]> = [
        [2, 'call'],
        [3, 'call'],
        [9, 'pause'],
        [8, 'photo'],
        [0, 'confirm'],
        [1, 'back'],
        [12, 'up'],
        [13, 'down'],
        [14, 'left'],
        [15, 'right'],
        [11, 'drift'],
      ];
      for (const [i, a] of map) if (b[i] && !this.prev[i]) this.fire(a);
      if (Math.hypot(x, y) > 0.2 || b.some(Boolean)) this.used();
      this.prev = b;
      const s = (v: number) => Math.sign(v) * Math.pow(Math.abs(v), 1.4);
      return { pitch: s(y), roll: s(x), beat: !!(b[0] || b[7]) };
    }
    this.rx = this.ry = 0;
    return { pitch: 0, roll: 0, beat: false };
  }

  look(): { x: number; y: number } {
    return { x: this.rx, y: this.ry };
  }
}
