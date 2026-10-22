import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The dashboard is served by the API process under /app; in dev, Vite proxies
// everything that isn't the SPA to the API on :4100.
export default defineConfig({
  root: 'web',
  base: '/app/',
  plugins: [react()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4100',
      '/auth': 'http://localhost:4100',
      '/o': 'http://localhost:4100',
      '/l': 'http://localhost:4100',
    },
  },
});
