import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5180, host: true },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1400,
    assetsInlineLimit: 0,
  },
});
