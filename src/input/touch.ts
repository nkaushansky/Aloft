import type { FlightInput } from '../sim/flightModel';

/**
 * Touch → normalized { pitch, roll }, the mobile half of the input plan
 * (design doc, P-mobile): a floating virtual stick. Wherever a finger lands
 * becomes the stick's center; dragging deflects it. Drag up = stick forward
 * = nose down, matching the keyboard's W. Deflection saturates at RADIUS px
 * so full control never needs a big reach.
 *
 * Feeds the exact same eased input path as the keyboard, so the feel tuned
 * on desktop carries to a phone untouched.
 */
export class TouchInput {
  private static readonly RADIUS = 70; // px of drag for full deflection
  private pointerId: number | null = null;
  private originX = 0;
  private originY = 0;
  private pitch = 0;
  private roll = 0;

  constructor(target: HTMLElement) {
    target.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch' || this.pointerId !== null) return;
      this.pointerId = e.pointerId;
      this.originX = e.clientX;
      this.originY = e.clientY;
    });
    const clear = (e: PointerEvent) => {
      if (e.pointerId !== this.pointerId) return;
      this.pointerId = null;
      this.pitch = 0;
      this.roll = 0;
    };
    target.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.pointerId) return;
      const r = TouchInput.RADIUS;
      this.roll = clamp((e.clientX - this.originX) / r);
      this.pitch = clamp((e.clientY - this.originY) / r);
    });
    target.addEventListener('pointerup', clear);
    target.addEventListener('pointercancel', clear);
  }

  read(): FlightInput {
    return { pitch: this.pitch, roll: this.roll };
  }
}

const clamp = (v: number) => Math.min(1, Math.max(-1, v));
