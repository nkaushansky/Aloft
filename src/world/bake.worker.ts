import { bakeLand, BakeOptions } from './generate';

self.onmessage = async (e: MessageEvent<BakeOptions>) => {
  const post = self as unknown as { postMessage(m: unknown, t?: Transferable[]): void };
  const b = await bakeLand({ ...e.data, onProgress: (p) => post.postMessage({ p }) });
  post.postMessage({ b }, [b.height.buffer, b.normal.buffer, b.mask.buffer, b.far.buffer] as Transferable[]);
};
