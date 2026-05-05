/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { defineConfig } from 'vite'
import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// KovitoBoard:
// - Serve static assets from public/ (avatars, docs, etc.)
// - publicDir must be an absolute path because root is src/renderer
// - Build output goes to <repo>/dist
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
    emptyOutDir: true,
    // KovitoBoard is a local-first app, so bundle size has limited practical
    // impact. Raise the threshold to suppress the cosmetic warning; route-based
    // code-splitting as a proper long-term fix is deferred (BL-2026-036).
    chunkSizeWarningLimit: 1500
  },
  server: {
    port: process.env.VITE_PORT ? parseInt(process.env.VITE_PORT, 10) : 5173,
    // The supervisor (`tools/kb-start.mjs`) probes for a free port and
    // hands the chosen one in via VITE_PORT. Vite's default behaviour
    // of silently incrementing on collision would defeat that — the
    // browser URL the supervisor advertises would no longer match the
    // actual listener. With strictPort, Vite either binds to the port
    // we asked for or fails loudly so the supervisor can re-probe.
    strictPort: true,
    host: true,
    proxy: {
      // Proxy both HTTP API and WebSocket to the Express backend.
      // WebSocket lives at /api/ws (not /ws) to avoid Vite's HMR server
      // intercepting the upgrade request (https://github.com/vitejs/vite/issues/864).
      '/api': {
        target: `http://localhost:${process.env.PORT || 3001}`,
        ws: true,
      },
    },
    fs: {
      // Allow `/@fs/<absolute>` requests to reach the user's project
      // root. The renderer dynamic-imports user-defined page modules
      // (declared in `app/menu.ts`) via the `/@fs/` URL scheme so that
      // pages added after dev-server boot are loadable without a
      // supervisor restart. KOVITOBOARD_PROJECT_ROOT is set by
      // `tools/kb-start.mjs` (the supervisor) before spawning Vite.
      allow: [
        // Default: ancestors of the Vite root and the workspace root.
        resolve(__dirname),
        ...(process.env.KOVITOBOARD_PROJECT_ROOT
          ? [resolve(process.env.KOVITOBOARD_PROJECT_ROOT)]
          : []),
      ],
    },
  }
})
