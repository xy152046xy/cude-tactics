import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发期：前端 5173，Socket.io 由 Vite 代理到本机 3000。
// 这样同一局域网内的 B 直接访问 http://<A的IP>:5173 即可完成 WebSocket 连接，
// 无需在前端写死后端地址，也无需处理跨域。
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    proxy: {
      '/socket.io': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        ws: true,
      },
      // 大厅的局域网地址 / 二维码信息由服务端权威探测，开发模式也走同一接口
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: 5173,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
