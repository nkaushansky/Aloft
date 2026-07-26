import type { FlightInput } from '../sim/types';
import { clamp, damp, deadzone, signedPow } from '../sim/math';

/**
 * Every device funnels into one normalized FlightInput. The sim never learns
 * what a keyboard is — new hardware is a new reader in this file, and the
 * tuned feel carries over untouched.
 */
export interface InputReader {
  /** Accumulate this device's contribution into `out`. */
  read(out: FlightInput, dt: number): void;
  dispose(): void;
}

export type InputKind = 'keyboard' | 'pointer' | 'touch' | 'gamepad';

// ================================================================ keyboard

const KEY_BINDINGS: Record<string, keyof FlightInput | 'none'> = {
  KeyW: 'pitch',
  ArrowUp: 'pitch',
  KeyS: 'pitch',
  ArrowDown: 'pitch',
  KeyA: 'roll',
  ArrowLeft: 'roll',
  KeyD: 'roll',
  ArrowRight: 'roll',
  ShiftLeft: 'tuck',
  ShiftRight: 'tuck',
  Space: 'spread',
};

export class KeyboardInput implements InputReader {
  private readonly down = new Set<string>();
  private readonly actions = new Map<string, () => void>();

  private readonly onDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    if (KEY_BINDINGS[e.code] || e.code === 'Space') e.preventDefault();
    this.down.add(e.code);
    const fn = this.actions.get(e.code);
    if (fn) fn();
  };

  private readonly onUp = (e: KeyboardEvent): void => {
    this.down.delete(e.code);
  };

  private readonly onBlur = (): void => {
    // A window that loses focus mid-turn must not leave the stick pinned.
    this.down.clear();
  };

  constructor() {
    window.addEventListener('keydown', this.onDown);
    window.addEventListener('keyup', this.onUp);
    window.addEventListener('blur', this.onBlur);
  }

  /** Register a one-shot action key (reset, mute, pause…). */
  onKey(code: string, fn: () => void): void {
    this.actions.set(code, fn);
  }

  isDown(code: string): boolean {
    return this.down.has(code);
  }

  read(out: FlightInput, _dt: number): void {
    const d = this.down;
    // Nose down is W/Up — pushing the stick forward. Matches every flight sim
    // and the original Aloft; inverting it is a settings problem, not a
    // default problem.
    if (d.has('KeyW') || d.has('ArrowUp')) out.pitch -= 1;
    if (d.has('KeyS') || d.has('ArrowDown')) out.pitch += 1;
    if (d.has('KeyA') || d.has('ArrowLeft')) out.roll -= 1;
    if (d.has('KeyD') || d.has('ArrowRight')) out.roll += 1;
    if (d.has('ShiftLeft') || d.has('ShiftRight')) out.tuck += 1;
    if (d.has('Space')) out.spread += 1;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onDown);
    window.removeEventListener('keyup', this.onUp);
    window.removeEventListener('blur', this.onBlur);
    this.down.clear();
  }
}

// ================================================================= pointer

/**
 * Mouse flying: the cursor is a virtual stick centred on the screen. Held
 * pointer-lock is deliberately NOT used — a game you can look away from and
 * come back to is friendlier than one that swallows your cursor. Instead the
 * stick self-centres when the pointer leaves the window.
 */
export class PointerInput implements InputReader {
  private x = 0;
  private z = 0;
  private active = false;
  /** Fraction of the shorter screen axis that equals full deflection. */
  private readonly range = 0.28;

  private readonly onMove = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    const span = Math.min(w, h) * this.range;
    this.x = clamp((e.clientX - w * 0.5) / span, -1, 1);
    this.z = clamp((e.clientY - h * 0.5) / span, -1, 1);
    this.active = true;
  };

  private readonly onLeave = (): void => {
    this.active = false;
    this.x = 0;
    this.z = 0;
  };

  constructor(private readonly enabled: () => boolean) {
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerout', this.onLeave);
  }

  read(out: FlightInput, _dt: number): void {
    if (!this.active || !this.enabled()) return;
    // A gentle expo curve: precise near centre for coring a thermal, still
    // reaching full deflection at the edge for a hard carve.
    out.roll += signedPow(this.x, 1.6);
    out.pitch -= signedPow(this.z, 1.6);
  }

  dispose(): void {
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerout', this.onLeave);
  }
}

// =================================================================== touch

/**
 * The floating stick, inherited from the original Aloft's mobile pass: touch
 * anywhere and that point becomes the stick's centre, drag to deflect. It
 * works because you never have to look at your thumb.
 *
 * A second finger anywhere on the right half tucks; on the left half, spreads.
 */
export class TouchInput implements InputReader {
  private stickId = -1;
  private originX = 0;
  private originY = 0;
  private dx = 0;
  private dy = 0;
  private modId = -1;
  private modSide: 'left' | 'right' | null = null;
  /** Pixels of drag that equals full deflection. */
  private readonly span = 84;

  /** Where the stick currently is, for the on-screen indicator. */
  readonly visual = { active: false, ox: 0, oy: 0, dx: 0, dy: 0 };

  private readonly onDown = (e: PointerEvent): void => {
    if (e.pointerType !== 'touch') return;
    if (this.stickId === -1) {
      this.stickId = e.pointerId;
      this.originX = e.clientX;
      this.originY = e.clientY;
      this.dx = 0;
      this.dy = 0;
    } else if (this.modId === -1) {
      this.modId = e.pointerId;
      this.modSide = e.clientX > window.innerWidth * 0.5 ? 'right' : 'left';
    }
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.stickId) return;
    this.dx = clamp((e.clientX - this.originX) / this.span, -1, 1);
    this.dy = clamp((e.clientY - this.originY) / this.span, -1, 1);
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (e.pointerId === this.stickId) {
      this.stickId = -1;
      this.dx = 0;
      this.dy = 0;
    } else if (e.pointerId === this.modId) {
      this.modId = -1;
      this.modSide = null;
    }
  };

  constructor(private readonly target: HTMLElement) {
    target.addEventListener('pointerdown', this.onDown);
    target.addEventListener('pointermove', this.onMove);
    target.addEventListener('pointerup', this.onUp);
    target.addEventListener('pointercancel', this.onUp);
  }

  read(out: FlightInput, _dt: number): void {
    if (this.stickId !== -1) {
      out.roll += signedPow(this.dx, 1.5);
      // Drag up = nose down, like pushing a stick forward.
      out.pitch -= signedPow(this.dy, 1.5);
    }
    if (this.modSide === 'right') out.tuck += 1;
    if (this.modSide === 'left') out.spread += 1;

    this.visual.active = this.stickId !== -1;
    this.visual.ox = this.originX;
    this.visual.oy = this.originY;
    this.visual.dx = this.dx;
    this.visual.dy = this.dy;
  }

  dispose(): void {
    this.target.removeEventListener('pointerdown', this.onDown);
    this.target.removeEventListener('pointermove', this.onMove);
    this.target.removeEventListener('pointerup', this.onUp);
    this.target.removeEventListener('pointercancel', this.onUp);
  }
}

// ================================================================= gamepad

/** The best way to fly this. Analog triggers map beautifully onto the wings. */
export class GamepadInput implements InputReader {
  private index = -1;
  private prevButtons: boolean[] = [];
  private readonly actions = new Map<number, () => void>();

  onButton(button: number, fn: () => void): void {
    this.actions.set(button, fn);
  }

  get connected(): boolean {
    return this.index !== -1;
  }

  read(out: FlightInput, _dt: number): void {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    let pad: Gamepad | null = null;
    for (const p of pads) {
      if (p && p.connected) {
        pad = p;
        break;
      }
    }
    if (!pad) {
      this.index = -1;
      return;
    }
    this.index = pad.index;

    const lx = deadzone(pad.axes[0] ?? 0, 0.12);
    const ly = deadzone(pad.axes[1] ?? 0, 0.12);
    out.roll += signedPow(lx, 1.5);
    out.pitch -= signedPow(ly, 1.5);

    // Triggers are analog, so the wings are analog: a feathered half-tuck is
    // a real and useful thing to be able to hold.
    const lt = pad.buttons[6]?.value ?? 0;
    const rt = pad.buttons[7]?.value ?? 0;
    out.spread += lt;
    out.tuck += rt;

    for (let i = 0; i < pad.buttons.length; i++) {
      const pressed = pad.buttons[i].pressed;
      if (pressed && !this.prevButtons[i]) {
        const fn = this.actions.get(i);
        if (fn) fn();
      }
      this.prevButtons[i] = pressed;
    }
  }

  dispose(): void {
    this.actions.clear();
  }
}

// ================================================================ manager

/**
 * Sums every connected device, clamps, and applies one final easing pass so
 * that no matter what you fly with, the stick swells rather than snaps.
 */
export class InputManager {
  private readonly readers: InputReader[] = [];
  private readonly raw: FlightInput = { pitch: 0, roll: 0, tuck: 0, spread: 0 };
  readonly value: FlightInput = { pitch: 0, roll: 0, tuck: 0, spread: 0 };
  /** Which device most recently produced meaningful deflection. */
  lastKind: InputKind = 'keyboard';

  readonly keyboard: KeyboardInput;
  readonly touch: TouchInput;
  readonly gamepad: GamepadInput;
  readonly pointer: PointerInput;

  constructor(target: HTMLElement, mouseFlying: () => boolean) {
    this.keyboard = new KeyboardInput();
    this.touch = new TouchInput(target);
    this.gamepad = new GamepadInput();
    this.pointer = new PointerInput(mouseFlying);
    this.readers.push(this.keyboard, this.touch, this.gamepad, this.pointer);
  }

  update(dt: number): FlightInput {
    const r = this.raw;
    r.pitch = 0;
    r.roll = 0;
    r.tuck = 0;
    r.spread = 0;
    for (const reader of this.readers) reader.read(r, dt);

    r.pitch = clamp(r.pitch, -1, 1);
    r.roll = clamp(r.roll, -1, 1);
    r.tuck = clamp(r.tuck, 0, 1);
    r.spread = clamp(r.spread, 0, 1);

    if (Math.abs(r.pitch) > 0.15 || Math.abs(r.roll) > 0.15) {
      this.lastKind = this.gamepad.connected
        ? 'gamepad'
        : this.touch.visual.active
          ? 'touch'
          : 'keyboard';
    }

    // A light pre-smoothing on top of the sim's own stick easing. Two gentle
    // filters in series read as "the bird has weight" rather than as lag.
    const lambda = 26;
    this.value.pitch = damp(this.value.pitch, r.pitch, lambda, dt);
    this.value.roll = damp(this.value.roll, r.roll, lambda, dt);
    this.value.tuck = damp(this.value.tuck, r.tuck, lambda * 0.6, dt);
    this.value.spread = damp(this.value.spread, r.spread, lambda * 0.6, dt);
    return this.value;
  }

  dispose(): void {
    for (const r of this.readers) r.dispose();
  }
}
