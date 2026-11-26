import { cpSync } from 'node:fs';
import { defineConfig, Plugin } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const ARCADE = 'https://www.nk00.com/arcade/aloft/';

/** nk00 arcade extras: hub card files, share tags, and the arcade's counter. */
const arcade = (): Plugin => ({
  name: 'aloft-arcade',
  transformIndexHtml: () => [
    { tag: 'meta', attrs: { property: 'og:title', content: 'Aloft' }, injectTo: 'head' },
    { tag: 'meta', attrs: { property: 'og:description', content: 'A long way south, one day behind. A quiet flight.' }, injectTo: 'head' },
    { tag: 'meta', attrs: { property: 'og:image', content: `${ARCADE}media/cover.jpg` }, injectTo: 'head' },
    { tag: 'script', attrs: { defer: true, src: 'https://www.nk00.com/nk.js', 'data-site': 'arcade' }, injectTo: 'head' },
  ],
  closeBundle: () => cpSync('arcade', 'dist-arcade', { recursive: true }),
});

// `npm run build`        → dist/ (static site, relative paths: drop it anywhere)
// `npm run build:single` → dist-single/index.html (one self-contained file)
// `npm run build:arcade` → dist-arcade/ (nk00.com/arcade/aloft, the staging area)
export default defineConfig(({ mode }) => {
  const single = mode === 'single';
  const arc = mode === 'arcade';
  return {
    base: './',
    plugins: single ? [viteSingleFile({ removeViteModuleLoader: true })] : arc ? [arcade()] : [],
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 2000,
      outDir: single ? 'dist-single' : arc ? 'dist-arcade' : 'dist',
      assetsInlineLimit: single ? 100_000_000 : 4096,
      rollupOptions: { input: 'index.html' },
    },
    worker: { format: 'es' as const },
  };
});
