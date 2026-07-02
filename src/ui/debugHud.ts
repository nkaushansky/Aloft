import type { AircraftState } from '../sim/state';
import { totalEnergy } from '../sim/state';
import { config } from '../sim/config';

/**
 * Toggleable on-screen readout (H). Measurement, not game UI: airspeed,
 * altitude, total energy, bank, and a stall indicator, plus the controls.
 */
export class DebugHud {
  private readonly el: HTMLDivElement;
  private visible = true;

  constructor(container: HTMLElement) {
    this.el = document.createElement('div');
    this.el.style.cssText = [
      'position:fixed', 'top:12px', 'left:12px', 'padding:10px 14px',
      'background:rgba(24,32,26,0.72)', 'color:#dfe8dc', 'border-radius:8px',
      'font:13px/1.5 ui-monospace,Menlo,Consolas,monospace',
      'white-space:pre', 'pointer-events:none', 'z-index:10',
    ].join(';');
    container.appendChild(this.el);
  }

  toggle(): void {
    this.visible = !this.visible;
    this.el.style.display = this.visible ? 'block' : 'none';
  }

  update(state: AircraftState): void {
    if (!this.visible) return;
    const bankDeg = (state.roll * 180) / Math.PI;
    const stall =
      state.flying >= 0.999 ? 'ok' : state.flying > 0.3 ? 'SLOW — nearing stall' : 'STALL';
    this.el.textContent =
      `airspeed  ${state.airspeed.toFixed(1).padStart(6)} m/s\n` +
      `altitude  ${state.position.y.toFixed(1).padStart(6)} m\n` +
      `energy    ${totalEnergy(state, config).toFixed(0).padStart(6)} J/kg\n` +
      `bank      ${bankDeg.toFixed(0).padStart(6)}°\n` +
      `stall     ${stall}\n` +
      `\n` +
      `W/S pitch · A/D roll · R reset · H hud`;
  }
}
