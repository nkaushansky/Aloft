/**
 * Two quiet round buttons for touch devices, standing in for the R and M
 * keys. Only shown on coarse-pointer screens — a desktop never sees them.
 */
export class TouchButtons {
  constructor(container: HTMLElement, onReset: () => void, onSound: () => void) {
    if (!window.matchMedia('(pointer: coarse)').matches) return;
    const make = (label: string, top: number, action: () => void) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.cssText = [
        'position:fixed', `top:${top}px`, 'right:14px', 'width:46px', 'height:46px',
        'border-radius:50%', 'border:1.5px solid rgba(41,50,40,0.3)',
        'background:rgba(243,245,238,0.55)', 'color:rgba(41,50,40,0.8)',
        'font-size:20px', 'z-index:12', 'touch-action:manipulation',
        '-webkit-tap-highlight-color:transparent',
      ].join(';');
      btn.addEventListener('pointerdown', (e) => e.stopPropagation()); // don't fly while tapping
      btn.addEventListener('click', action);
      container.appendChild(btn);
    };
    make('↺', 14, onReset);
    make('♪', 70, onSound);
  }
}
