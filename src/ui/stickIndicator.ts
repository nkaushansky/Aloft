import type { AircraftState } from '../sim/state';

/**
 * A soft virtual-stick guide: a circle with a dot that eases toward the edge
 * the longer you hold a direction — a live view of the sim's smoothed stick
 * (stickPitch/stickRoll), so "how hard am I pushing" is always visible.
 * Push forward (nose down) moves the dot up, like leaning a real stick.
 * This is also the seed of the touch control: on mobile the same circle
 * becomes the input surface instead of just the readout.
 */
export class StickIndicator {
  private readonly dot: HTMLDivElement;
  private readonly ring: HTMLDivElement;
  private static readonly RADIUS = 26; // px of dot travel inside the ring

  constructor(container: HTMLElement) {
    this.ring = document.createElement('div');
    this.ring.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:26px', 'width:64px', 'height:64px',
      'margin-left:-32px', 'border-radius:50%',
      'border:1.5px solid rgba(41,50,40,0.35)',
      'background:rgba(243,245,238,0.18)',
      'pointer-events:none', 'z-index:10',
    ].join(';');
    this.dot = document.createElement('div');
    this.dot.style.cssText = [
      'position:absolute', 'left:50%', 'top:50%', 'width:12px', 'height:12px',
      'margin:-6px 0 0 -6px', 'border-radius:50%',
      'background:#c47b34', 'opacity:0.85',
      'transition:none',
    ].join(';');
    this.ring.appendChild(this.dot);
    container.appendChild(this.ring);
  }

  update(state: AircraftState): void {
    const r = StickIndicator.RADIUS;
    // roll right = dot right; nose up (stick pulled back) = dot down
    const x = state.stickRoll * r;
    const y = state.stickPitch * r;
    this.dot.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
  }
}
