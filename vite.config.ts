import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// KovitoBoard Phase 1:
// - gala-ui の vite.config.ts を踏襲。public/ は不要なため publicDir を無効化
// - ビルド成果物は <repo>/dist に出力
export default defineConfig({
  root: 'src/renderer',
  publicDir: false,
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../../dist',
    emptyOutDir: true
  },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': 'http://localhost:3001',
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true
      }
    }
  }
})
