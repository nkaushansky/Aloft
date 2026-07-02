import type { FlightInput } from '../sim/flightModel';

/**
 * Keyboard → normalized { pitch, roll } in [-1, 1]. The sim only ever sees
 * FlightInput, so gamepad/touch later are new files here, not sim changes.
 *
 *   W / ↑ : nose down      S / ↓ : nose up      (airplane-style: push = dive)
 *   A / ← : roll left      D / → : roll right
 */
export class KeyboardInput {
  private down = new Set<string>();
  private actions = new Map<string, () => void>();

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.down.add(e.code);
      const action = this.actions.get(e.code);
      if (action) action();
    });
    window.addEventListener('keyup', (e) => this.down.delete(e.code));
    window.addEventListener('blur', () => this.down.clear());
  }

  /** Register a one-shot action key (e.g. R = reset, H = HUD). */
  onKey(code: string, action: () => void): void {
    this.actions.set(code, action);
  }

  read(): FlightInput {
    let pitch = 0;
    let roll = 0;
    if (this.down.has('KeyW') || this.down.has('ArrowUp')) pitch -= 1; // nose down
    if (this.down.has('KeyS') || this.down.has('ArrowDown')) pitch += 1; // nose up
    if (this.down.has('KeyA') || this.down.has('ArrowLeft')) roll -= 1;
    if (this.down.has('KeyD') || this.down.has('ArrowRight')) roll += 1;
    return { pitch, roll };
  }
}
