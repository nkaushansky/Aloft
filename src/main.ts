import { Game } from './game/game';

/**
 * Wiring only. The loop draws every animation frame; the sim inside steps at
 * a locked 60 Hz. Resolution breathes to keep the frame rate serene.
 */
const canvas = document.getElementById('stage') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLElement;

function fail(msg: string): void {
  ui.innerHTML = `<div style="position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:10vw;font-size:19px;line-height:1.5">${msg}</div>`;
}

function start(): void {
  let game: Game;
  try {
    const probe = document.createElement('canvas').getContext('webgl2');
    if (!probe) throw new Error('no webgl2');
    game = new Game(canvas, ui);
  } catch (e) {
    console.error(e);
    fail('Aloft needs WebGL 2 to draw its sky.<br>A current browser with hardware acceleration switched on should do it.');
    return;
  }
  (window as unknown as Record<string, unknown>).__game = game;

  // test hook: `?hold` stops the loop so a script can step and draw by hand
  const hold = new URLSearchParams(location.search).has('hold');
  let last = performance.now();
  let acc = 0;
  let n = 0;
  let calm = 0;
  const tick = (now: number): void => {
    requestAnimationFrame(tick);
    const dt = (now - last) / 1000;
    last = now;
    game.frame(dt);

    // adaptive resolution: measured over a second, changed only when sure
    if (document.hidden || dt <= 0) return;
    acc += Math.min(dt, 0.4);
    n++;
    if (acc > 1) {
      const ms = (acc / n) * 1000;
      const e = game.engine;
      if (ms > 22.5 && e.renderScale > 0.5) {
        e.renderScale = Math.max(0.5, e.renderScale - (ms > 34 ? 0.12 : 0.06));
        e.resize();
        calm = 0;
      } else if (ms < 17.4 && e.renderScale < 1) {
        if (++calm > 6) {
          e.renderScale = Math.min(1, e.renderScale + 0.05);
          e.resize();
          calm = 0;
        }
      } else calm = 0;
      acc = 0;
      n = 0;
    }
  };
  void game.boot().then(() => {
    last = performance.now();
    if (!hold) requestAnimationFrame(tick);
  });

  if (new URLSearchParams(location.search).has('tune')) void tune();
}

async function tune(): Promise<void> {
  const [{ default: GUI }, { config }] = await Promise.all([import('lil-gui'), import('./sim/config')]);
  const gui = new GUI({ title: 'Aloft — feel' });
  for (const [k, v] of Object.entries(config)) {
    const span = Math.max(Math.abs(v) * 2, 0.1);
    gui.add(config, k as keyof typeof config, v < 0 ? -span : 0, v < 0 ? 0.1 : span);
  }
}

start();
