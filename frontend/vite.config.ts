import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// Dev backend runs on 8044 (see `dev_port` in the justfile) so it doesn't
// clash with a production/service instance on the default 8004. The browser
// test harness overrides it.
const backend = `http://localhost:${process.env.BTMUX_BACKEND_PORT ?? 8044}`;

// Keep only woff2 sources in @font-face rules so fallback formats aren't bundled.
// `Once` runs before Vite's url-rewriting `Once`, which emits the assets.
type FontFaceRoot = {
  walkAtRules(
    name: string,
    cb: (rule: { walkDecls(prop: string, cb: (decl: { value: string }) => void): void }) => void,
  ): void;
};
const woff2Only = {
  postcssPlugin: 'woff2-only',
  Once(root: FontFaceRoot) {
    root.walkAtRules('font-face', (rule) => {
      rule.walkDecls('src', (decl) => {
        const woff2 = decl.value
          .split(/,(?![^(]*\))/)
          .filter((source) => /format\(\s*['"]?woff2['"]?\s*\)/.test(source));
        if (woff2.length) decl.value = woff2.map((source) => source.trim()).join(', ');
      });
    });
  },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  css: {
    postcss: { plugins: [woff2Only] },
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  optimizeDeps: {
    exclude: ['@wterm/ghostty'],
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
      '/ws': {
        target: backend,
        ws: true,
        changeOrigin: true,
      },
      '/wallpaper': {
        target: backend,
        changeOrigin: true,
      },
      '/api': {
        target: backend,
        changeOrigin: true,
      },
      // Exactly the pairing links of the tailnet QR code.
      '^/pair(\\?|$)': {
        target: backend,
        changeOrigin: true,
      },
      // Keep Host: VS Code builds its WebSocket URLs from it.
      '/vscode': {
        target: backend,
        ws: true,
      },
    },
  },
});
