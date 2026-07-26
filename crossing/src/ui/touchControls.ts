import type { ButtonInput } from '../input';

/**
 * The wing controls, for thumbs.
 *
 * The floating stick handles pitch and roll well on a phone — you never have
 * to look at it. But tuck and spread were originally only reachable by putting
 * a second finger on the correct half of the screen, which nobody discovers,
 * so on a touch device the entire skill layer of the game was invisible.
 *
 * These are held buttons, one either side of the stick's usual territory, and
 * they light up while held so the connection to the wing readout at the bottom
 * of the screen is obvious the first time you press one.
 */
export class TouchControls {
  private readonly root: HTMLElement;
  private readonly tuckBtn: HTMLElement;
  private readonly spreadBtn: HTMLElement;

  constructor(parent: HTMLElement, buttons: ButtonInput) {
    this.root = document.createElement('div');
    this.root.className = 'wing-pads';

    this.spreadBtn = makePad('SPREAD', 'slow · tight');
    this.tuckBtn = makePad('TUCK', 'fast · low drag');

    bindHold(this.spreadBtn, (on) => {
      buttons.spread = on ? 1 : 0;
      this.spreadBtn.classList.toggle('on', on);
    });
    bindHold(this.tuckBtn, (on) => {
      buttons.tuck = on ? 1 : 0;
      this.tuckBtn.classList.toggle('on', on);
    });

    this.root.append(this.spreadBtn, this.tuckBtn);
    parent.appendChild(this.root);
  }

  setVisible(v: boolean): void {
    this.root.style.display = v ? '' : 'none';
  }

  dispose(): void {
    this.root.remove();
  }
}

function makePad(label: string, sub: string): HTMLElement {
  const b = document.createElement('button');
  b.className = 'wing-pad';
  b.type = 'button';
  const l = document.createElement('b');
  l.textContent = label;
  const s = document.createElement('i');
  s.textContent = sub;
  b.append(l, s);
  return b;
}

/**
 * Press-and-hold that survives the finger sliding off the button, which is
 * constant on a phone. Release is bound on the window rather than the element
 * so a drag-off never leaves the wing stuck in a configuration.
 */
function bindHold(el: HTMLElement, set: (on: boolean) => void): void {
  let id = -1;
  const down = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    id = e.pointerId;
    set(true);
  };
  const up = (e: PointerEvent): void => {
    if (e.pointerId !== id) return;
    id = -1;
    set(false);
  };
  el.addEventListener('pointerdown', down);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', up);
  // A pointer that leaves the document entirely never fires pointerup.
  window.addEventListener('blur', () => {
    id = -1;
    set(false);
  });
}
