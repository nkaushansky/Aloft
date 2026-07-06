import type { AircraftState } from '../sim/state';

/**
 * The game's flight instruments — the pleasant HUD, not the debug readout.
 * Born from the Phase 2 playtest: the world teaches the wind, but quiet
 * numbers are a pleasure to have along. Speed and altitude flank the stick
 * guide at the bottom of the frame; a small climb indicator sits above it
 * and warms to amber when the air is carrying you up.
 */
export class FlightHud {
  private readonly speedEl: HTMLDivElement;
  private readonly altEl: HTMLDivElement;
  private readonly climbEl: HTMLDivElement;

  constructor(container: HTMLElement) {
    const base = [
      'position:fixed', 'pointer-events:none', 'z-index:9',
      "font-family:'Avenir Next','Segoe UI',system-ui,sans-serif",
      'color:rgba(41,50,40,0.8)',
      'text-shadow:0 1px 3px rgba(243,245,238,0.65)',
    ];
    const block = (side: string) => {
      const el = document.createElement('div');
      el.style.cssText = [
        ...base,
        'bottom:34px',
        side,
        'text-align:center',
        'min-width:86px',
        'font-variant-numeric:tabular-nums',
      ].join(';');
      container.appendChild(el);
      return el;
    };
    this.speedEl = block('right:calc(50% + 56px)');
    this.altEl = block('left:calc(50% + 56px)');

    this.climbEl = document.createElement('div');
    this.climbEl.style.cssText = [
      ...base,
      'bottom:98px', 'left:50%', 'transform:translateX(-50%)',
      'font-size:13px', 'font-variant-numeric:tabular-nums',
      'letter-spacing:0.04em',
    ].join(';');
    container.appendChild(this.climbEl);
  }

  update(state: AircraftState): void {
    const kmh = state.airspeed * 3.6;
    this.speedEl.innerHTML = readout(kmh.toFixed(0), 'km/h');
    this.altEl.innerHTML = readout(state.position.y.toFixed(0), 'm');

    const c = state.climbRate;
    if (c > 0.25) {
      this.climbEl.style.color = '#b06f2b';
      this.climbEl.textContent = `▲ ${c.toFixed(1)}`;
    } else if (c < -2.5) {
      // only mention sink when it's brisk — ordinary glide descent is silence
      this.climbEl.style.color = 'rgba(41,50,40,0.45)';
      this.climbEl.textContent = `▼ ${Math.abs(c).toFixed(1)}`;
    } else {
      this.climbEl.textContent = '';
    }
  }
}

function readout(value: string, unit: string): string {
  return (
    `<div style="font-size:23px;font-weight:500;line-height:1.1">${value}</div>` +
    `<div style="font-size:10.5px;letter-spacing:0.14em;text-transform:uppercase;opacity:0.6">${unit}</div>`
  );
}
