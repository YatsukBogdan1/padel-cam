import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Builds straight into worker/public, which wrangler serves as static assets.
// `npm run dev` proxies API and share routes to a local `wrangler dev` so the
// React dev server behaves like production.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  build: {
    outDir: '../worker/public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      // Regex, not a prefix: a plain '/s' key also matches '/src/main.tsx' and
      // proxies the app's own modules to the Worker. '^/s/' matches only the
      // share route, because '/src/' has no slash after the 's'.
      '^/s/': 'http://127.0.0.1:8787',
    },
  },
});
