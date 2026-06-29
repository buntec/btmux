import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  optimizeDeps: {
    exclude: ['ghostty-web'],
  },
  server: {
    port: 5173,
    proxy: {
      // Dev backend runs on 8044 (see `dev_port` in the justfile) so it doesn't
      // clash with a production/service instance on the default 8004.
      '/ws': {
        target: 'http://localhost:8044',
        ws: true,
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:8044',
        changeOrigin: true,
      },
    },
  },
});
