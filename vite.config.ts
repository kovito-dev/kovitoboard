import { defineConfig } from 'vite'
import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// KovitoBoard:
// - public/ から静的資産を配信する（avatars, docs 等）
// - root が src/renderer のため publicDir は絶対パスで指定
// - ビルド成果物は <repo>/dist に出力
export default defineConfig({
  root: 'src/renderer',
  publicDir: resolve(__dirname, 'public'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@app': resolve(__dirname, 'app'),
    },
  },
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
