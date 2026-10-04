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
  build: {
    chunkSizeWarningLimit: Infinity,
  },
  server: {
    port: 5173,
    // The backend only trusts this origin (`--public-url` in the justfile), so
    // fail instead of silently moving to a port it would reject.
    strictPort: true,
    proxy: {
      // Dev backend runs on 8044 (see `dev_port` in the justfile) so it doesn't
      // clash with a production/service instance on the default 8004.
      '/ws': {
        target: 'http://localhost:8044',
        ws: true,
        changeOrigin: true,
      },
      '/wallpaper': {
        target: 'http://localhost:8044',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:8044',
        changeOrigin: true,
      },
    },
  },
});
