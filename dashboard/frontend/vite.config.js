import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'url';

export default defineConfig({
  plugins: [react()],

  server: {
    // Bind to all interfaces for phone/network testing
    host: true,
    port: 3000,

    proxy: {
      // Proxies /api/something to http://127.0.0.1:8000/something
      '/api': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
      // Proxies /simulation/something to http://127.0.0.1:8000/simulation/something
      '/simulation': {
        target: 'http://127.0.0.1:8000',
        changeOrigin: true,
      },
      // WebSocket support
      '/ws': {
        target: 'ws://127.0.0.1:8000',
        ws: true,
        changeOrigin: true,
      },
    },
  },

  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});