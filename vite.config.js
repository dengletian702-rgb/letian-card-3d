import { defineConfig } from 'vite';

// Project site: https://dengletian702-rgb.github.io/letian-card-3d/
export default defineConfig({
  base: '/letian-card-3d/',
  server: {
    host: '127.0.0.1',
    port: 5173,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
  },
  build: {
    target: 'es2020',
    assetsInlineLimit: 4096,
  },
});
