/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Throwaway proof-of-concept: a zero-dependency stdio MCP server that
 * exposes a single read-only tool, `read_page_title`.
 *
 * Claude Code spawns this process per invocation via `--mcp-config`. On a
 * tool call it forwards the action to the KovitoBoard backend's loopback
 * PoC endpoint, blocks until the Chrome-extension round-trip completes, and
 * returns the active tab's `document.title` synchronously (the MCP stdio
 * transport has no async continuation — a tool must return within timeout).
 *
 * This is NOT a production component. It is reachable only when the backend
 * is started with KBEXT_BROWSER_CONTROL_POC=1, which is the only condition
 * under which KovitoBoard injects this server into the Claude Code launch.
 *
 * Protocol: the MCP stdio transport is newline-delimited JSON-RPC 2.0.
 */

const ENDPOINT =
  process.env.KB_BC_ENDPOINT || 'http://127.0.0.1:3001/_poc/browser-control/action'
const DEFAULT_PROTOCOL_VERSION = '2024-11-05'
const FETCH_TIMEOUT_MS = 60_000

function write(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

function reply(id, result) {
  write({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } })
}

const TOOLS = [
  {
    name: 'read_page_title',
    description:
      "Read the document.title of the user's currently active browser tab " +
      'via the KovitoBoard Chrome extension. Takes no arguments.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

async function callReadPageTitle(id) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'read_page_title' }),
      signal: controller.signal,
    })
    const json = await res.json().catch(() => null)
    if (!res.ok || !json || json.ok !== true) {
      const detail = (json && json.error) || `HTTP ${res.status}`
      reply(id, {
        content: [{ type: 'text', text: `read_page_title failed: ${detail}` }],
        isError: true,
      })
      return
    }
    const title = json.data && typeof json.data.title === 'string' ? json.data.title : ''
    reply(id, { content: [{ type: 'text', text: title }] })
  } catch (err) {
    reply(id, {
      content: [
        { type: 'text', text: `read_page_title error: ${err?.message || String(err)}` },
      ],
      isError: true,
    })
  } finally {
    clearTimeout(timer)
  }
}

async function handle(msg) {
  const { id, method } = msg
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion:
          (msg.params && msg.params.protocolVersion) || DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'browser-control', version: '0.0.0-poc' },
      })
      return
    case 'notifications/initialized':
    case 'initialized':
      // Notification — no response.
      return
    case 'ping':
      reply(id, {})
      return
    case 'tools/list':
      reply(id, { tools: TOOLS })
      return
    case 'tools/call':
      if (msg.params && msg.params.name === 'read_page_title') {
        await callReadPageTitle(id)
      } else {
        replyError(id, -32602, `Unknown tool: ${msg.params && msg.params.name}`)
      }
      return
    default:
      // Respond with method-not-found only to requests (which carry an id);
      // ignore unknown notifications.
      if (id !== undefined && id !== null) {
        replyError(id, -32601, `Method not found: ${method}`)
      }
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let nl
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      continue
    }
    void handle(msg)
  }
})
process.stdin.on('end', () => process.exit(0))
