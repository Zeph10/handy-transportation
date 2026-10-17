import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@handy/core': fileURLToPath(new URL('../../core/src/index.ts', import.meta.url)),
    },
  },
  server: { port: 5173 },
  build: { sourcemap: true, chunkSizeWarningLimit: 900 },
});
