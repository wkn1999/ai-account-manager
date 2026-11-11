import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 渲染进程使用相对路径，便于 Electron 以 file:// 加载
export default defineConfig({
  plugins: [react()],
  base: './',
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  server: {
    port: 5173,
    strictPort: true
  }
})
