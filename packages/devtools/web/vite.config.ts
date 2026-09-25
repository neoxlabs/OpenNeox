import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 7400,
    // 开发时把 /api 代理到 node 桥接服务(neox-devtools serve)
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7399',
        changeOrigin: true,
      },
    },
  },
});
