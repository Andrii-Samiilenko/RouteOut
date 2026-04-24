import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'url';

export default defineConfig({
  plugins: [react()],

  server: {
    // Bind to all interfaces so a phone on the same WiFi can reach the dev server
    host: true,
    port: 3000,

    proxy: {
      // REST API: /api/... → http://localhost:8000/...
      '/api': {
        target: 'http://localhost:8001',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
      // WebSocket: ws://[host]:3000/ws → ws://localhost:8000/ws
      '/ws': {
        target: 'ws://localhost:8001',
        ws: true,
        changeOrigin: true,
      },
    },
  },

  resolve: {
    alias: {
      // fileURLToPath + import.meta.url is the ESM-safe equivalent of
      // path.resolve(__dirname, './src') — works on all Node versions
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
