import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://backend:4000',
        changeOrigin: true
      },
      '/ws': {
        target: 'ws://backend:4000',
        ws: true
      }
    }
  }
});
