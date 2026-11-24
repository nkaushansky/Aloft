import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build` → dist/ (static site, relative paths: drop it anywhere)
// `npm run build:single` → dist-single/index.html (one self-contained file)
export default defineConfig(({ mode }) => {
  const single = mode === 'single';
  return {
    base: './',
    plugins: single ? [viteSingleFile({ removeViteModuleLoader: true })] : [],
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 2000,
      outDir: single ? 'dist-single' : 'dist',
      assetsInlineLimit: single ? 100_000_000 : 4096,
      rollupOptions: { input: 'index.html' },
    },
    worker: { format: 'es' as const },
  };
});
