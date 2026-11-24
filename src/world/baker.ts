import type { BakedLand, BakeOptions } from './generate';
import { bakeLand } from './generate';
import BakeWorker from './bake.worker?worker&inline';

/** Bake a land off-thread, or in polite slices on the main thread if workers are refused. */
export function bakeAsync(o: { id: BakeOptions['id']; seed?: number; n: number }, onProgress?: (p: number) => void): Promise<BakedLand> {
  return new Promise((resolve) => {
    let settled = false;
    const fallback = () => {
      if (settled) return;
      settled = true;
      let last = performance.now();
      void bakeLand({
        ...o,
        onProgress,
        breathe: async () => {
          if (performance.now() - last > 14) {
            await new Promise((r) => setTimeout(r, 0));
            last = performance.now();
          }
        },
      }).then(resolve);
    };
    try {
      const w = new BakeWorker();
      let heard = false;
      const timer = setTimeout(() => {
        if (!heard) {
          w.terminate();
          fallback();
        }
      }, 4000);
      w.onmessage = (e: MessageEvent<{ p?: number; b?: BakedLand }>) => {
        heard = true;
        clearTimeout(timer);
        if (e.data.p !== undefined) onProgress?.(e.data.p);
        if (e.data.b && !settled) {
          settled = true;
          w.terminate();
          resolve(e.data.b);
        }
      };
      w.onerror = () => {
        clearTimeout(timer);
        w.terminate();
        fallback();
      };
      w.postMessage(o);
    } catch {
      fallback();
    }
  });
}
