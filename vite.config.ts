/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { defineConfig, type Plugin } from 'vite'
import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const KB_LAUNCH_TOKEN_PLACEHOLDER = '<!-- KB:LAUNCH_TOKEN_META -->'
// Mirror of the format the server enforces in
// `src/server/middleware/auth.ts`: 32 lowercase hex characters,
// which is the shape `randomBytes(16).toString('hex')` produces.
// Validating the token here as well keeps dev mode from injecting
// arbitrary HTML / JS into `index.html` if the operator points
// `KB_LAUNCH_TOKEN` at attacker-controlled text — the server would
// refuse such a value at boot, so the renderer must too.
const KB_LAUNCH_TOKEN_FORMAT_RE = /^[0-9a-f]{32}$/

/**
 * Inject the per-launch auth token into `index.html` as a `<meta>`
 * tag. The token arrives via env (`KB_LAUNCH_TOKEN`) from the
 * supervisor (`tools/kb-start.mjs`); this plugin only runs during
 * `vite serve` so production builds keep the placeholder intact and
 * the Express prod fallback in `src/server/index.ts` can perform the
 * same substitution at runtime. The token is hex-only so no further
 * HTML escaping is needed; an empty token (the supervisor was not
 * involved) renders an empty content attribute and the renderer
 * fails closed when it later tries to authenticate. A non-empty
 * value that does not match the 32-hex format is rejected outright
 * to keep the dev path on the same security contract as the server.
 */
function kbLaunchTokenInjectorPlugin(): Plugin {
  return {
    name: 'kb-launch-token-injector',
    apply: 'serve',
    transformIndexHtml(html) {
      const token = process.env.KB_LAUNCH_TOKEN ?? ''
      if (token.length > 0 && !KB_LAUNCH_TOKEN_FORMAT_RE.test(token)) {
        throw new Error(
          'KB_LAUNCH_TOKEN must be 32 lowercase hex characters ' +
            '(the supervisor mints it via randomBytes(16).toString("hex")). ' +
            'Refusing to inject a non-conforming value into index.html ' +
            'so dev mode keeps the same HTML-injection guarantee the ' +
            'server enforces in resolveLaunchTokenOrThrow().',
        )
      }
      return html.replace(
        KB_LAUNCH_TOKEN_PLACEHOLDER,
        `<meta name="kb-launch-token" content="${token}">`,
      )
    },
  }
}

// KovitoBoard:
// - Serve static assets from public/ (avatars, docs, etc.)
// - publicDir must be an absolute path because root is src/renderer
// - Build output goes to <repo>/dist
export default defineConfig({
  root: 'src/renderer',
  publicDir: resolve(__dirname, 'public'),
  plugins: [react(), tailwindcss(), kbLaunchTokenInjectorPlugin()],
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
    // Bind Vite's dev server to the loopback interface only.
    // KovitoBoard is a local-first tool: serving the renderer to the
    // wider LAN exposes the privileged Express API and WebSocket bridge
    // (which proxy through this server) to anyone on the same network.
    // Use 127.0.0.1 explicitly so we are not at the mercy of OS-level
    // localhost resolution differences (e.g. IPv6-first hosts where
    // `localhost` resolves to `::1` while clients dial `127.0.0.1`).
    host: '127.0.0.1',
    proxy: {
      // Proxy both HTTP API and WebSocket to the Express backend.
      // WebSocket lives at /api/ws (not /ws) to avoid Vite's HMR server
      // intercepting the upgrade request (https://github.com/vitejs/vite/issues/864).
      // Use 127.0.0.1 explicitly so the proxy does not depend on whether
      // `localhost` resolves to IPv4 (matching the backend's bind host)
      // or IPv6 on the runtime OS.
      '/api': {
        target: `http://127.0.0.1:${process.env.PORT || 3001}`,
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
