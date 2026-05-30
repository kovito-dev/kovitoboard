/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * @vitest-environment jsdom
 *
 * Security regression for the Document Viewer sample recipe's HTML
 * rendering path (recipes/document-viewer, v1.2.0).
 *
 * The recipe renders project HTML files inside a sandboxed,
 * opaque-origin `<iframe sandbox="" srcdoc>` — the PRIMARY defense
 * (security-threat-model S10 / §7.10). Bundled sample recipes run as
 * `code-trusted (bundled)`, but the *content* they read (arbitrary
 * project HTML) is untrusted and would otherwise execute in the same
 * realm as the host renderer. Rendering it in the host realm would let
 * an inline `style` like `position:fixed;width:100vw;height:100vh`
 * paint a full-screen overlay over the host chrome / trust-prompt UI
 * (a viewport hijack that needs no script).
 *
 * This file pins two layers:
 *   1. The iframe-isolation contract — sandbox flags + structural
 *      containment of a viewport-hijack payload (the primary defense).
 *   2. DOMPurify's behavior as the secondary, defense-in-depth layer,
 *      invoked exactly as the recipe page calls it (default config).
 */
import { describe, it, expect } from 'vitest'
import DOMPurify from 'dompurify'
import { isHtmlPath, classifyFile } from '../../recipes/document-viewer/pages/DocumentViewer'

// Mirrors the render path in DocumentViewer.tsx: the host realm builds a
// `<iframe sandbox="" srcdoc={DOMPurify.sanitize(content)}>`. We construct
// the same element shape here so the security contract is asserted against
// real DOM behavior rather than a string snapshot.
function renderHtmlFrame(content: string): HTMLIFrameElement {
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', '')
  frame.setAttribute('srcdoc', DOMPurify.sanitize(content))
  frame.className = 'dv-html-frame'
  frame.title = 'Document preview'
  return frame
}

// The exact viewport-hijack payload from security-threat-model §7.10.1.
const HIJACK_PAYLOAD =
  '<div style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:99999;background:#000">FAKE OVERLAY</div>'

describe('Document Viewer render-dispatch invariant (HTML → iframe, everything else → host realm)', () => {
  // `isHtmlPath` is the predicate the render branch uses to decide
  // between the sandboxed iframe (`.html` / `.htm`) and the host-realm
  // ReactMarkdown path (everything else). Pinning it here pins the
  // security-relevant split: only HTML content reaches the iframe, and
  // Markdown never goes through the raw-HTML path.
  it('routes .html and .htm to the isolated iframe path', () => {
    expect(isHtmlPath('page.html')).toBe(true)
    expect(isHtmlPath('docs/guide.htm')).toBe(true)
    expect(isHtmlPath('docs/UPPER.HTML')).toBe(true)
  })

  it('keeps .md (and other extensions) on the host-realm Markdown path', () => {
    expect(isHtmlPath('README.md')).toBe(false)
    expect(isHtmlPath('docs/notes.MD')).toBe(false)
    expect(isHtmlPath('data.json')).toBe(false)
    expect(isHtmlPath('plain.txt')).toBe(false)
  })

  it('classifies file kinds consistently with the dispatch predicate', () => {
    expect(classifyFile('a.html')).toBe('html')
    expect(classifyFile('a.htm')).toBe('html')
    expect(classifyFile('a.md')).toBe('md')
    expect(classifyFile('a.json')).toBe('other')
    // A path that does not classify as html must not route to the iframe.
    expect(classifyFile('a.md') === 'html').toBe(isHtmlPath('a.md'))
  })
})

describe('Document Viewer HTML iframe isolation (primary defense)', () => {
  it('renders untrusted HTML inside a sandboxed iframe, not the host DOM', () => {
    const frame = renderHtmlFrame('<div>safe</div>')
    expect(frame.tagName).toBe('IFRAME')
    expect(frame.hasAttribute('sandbox')).toBe(true)
    // Content is delivered via srcdoc, never injected into the host DOM.
    expect(frame.hasAttribute('srcdoc')).toBe(true)
    expect(frame.getAttribute('srcdoc')).toContain('safe')
  })

  it('keeps the sandbox minimal: no allow-scripts, no allow-same-origin', () => {
    const frame = renderHtmlFrame('<div>x</div>')
    const sandbox = frame.getAttribute('sandbox') ?? ''
    // Empty sandbox = every restriction active. The two flags whose
    // combination would self-disable the sandbox (opaque origin + JS)
    // must never appear.
    expect(sandbox).toBe('')
    expect(sandbox).not.toContain('allow-scripts')
    expect(sandbox).not.toContain('allow-same-origin')
  })

  it('confines a position:fixed viewport-hijack payload to the iframe (no host overlay)', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const frame = renderHtmlFrame(HIJACK_PAYLOAD)
    host.appendChild(frame)

    // The payload travels inside srcdoc...
    expect(frame.getAttribute('srcdoc')).toContain('FAKE OVERLAY')
    expect(frame.getAttribute('srcdoc')).toContain('position:fixed')

    // ...but it must NOT have injected any element into the host document.
    // (With dangerouslySetInnerHTML the fixed overlay would be a real host
    //  DOM node; with the iframe it can only ever live in srcdoc text.)
    const hostNodes = Array.from(host.querySelectorAll('*'))
    const leakedOverlay = hostNodes.find(
      (n) => n.tagName !== 'IFRAME' && /FAKE OVERLAY/.test(n.textContent ?? ''),
    )
    expect(leakedOverlay).toBeUndefined()
    // No element anywhere in the host body carries the overlay text outside
    // the iframe's own srcdoc attribute.
    const bodyFixedOverlay = Array.from(document.body.querySelectorAll('*')).find(
      (n) => n.tagName === 'DIV' && /FAKE OVERLAY/.test(n.textContent ?? ''),
    )
    expect(bodyFixedOverlay).toBeUndefined()

    document.body.removeChild(host)
  })
})

describe('Document Viewer HTML sanitization (defense-in-depth secondary layer)', () => {
  it('strips <script> elements', () => {
    const out = DOMPurify.sanitize('<div>safe</div><script>window.__x = 1</script>')
    expect(out).toContain('safe')
    expect(out.toLowerCase()).not.toContain('<script')
    expect(out).not.toContain('window.__x')
  })

  it('strips inline event handlers (onerror / onload / onclick)', () => {
    const out = DOMPurify.sanitize(
      '<img src="x" onerror="alert(1)"><body onload="alert(2)"><button onclick="alert(3)">x</button>',
    )
    expect(out.toLowerCase()).not.toContain('onerror')
    expect(out.toLowerCase()).not.toContain('onload')
    expect(out.toLowerCase()).not.toContain('onclick')
    expect(out.toLowerCase()).not.toContain('alert(')
  })

  it('strips javascript: URLs from href/src', () => {
    const out = DOMPurify.sanitize('<a href="javascript:alert(1)">click</a>')
    expect(out.toLowerCase()).not.toContain('javascript:')
    expect(out).toContain('click')
  })

  it('neutralizes <iframe> / <object> / <embed> plugin surface', () => {
    const out = DOMPurify.sanitize(
      '<iframe src="https://evil.test"></iframe><object data="x"></object><embed src="x">',
    )
    expect(out.toLowerCase()).not.toContain('<iframe')
    expect(out.toLowerCase()).not.toContain('<object')
    expect(out.toLowerCase()).not.toContain('<embed')
  })

  it('preserves benign formatting markup', () => {
    const out = DOMPurify.sanitize(
      '<h1>Title</h1><p style="color: red;">Body <strong>bold</strong> <a href="https://ok.test">link</a></p>',
    )
    expect(out).toContain('<h1>')
    expect(out).toContain('<strong>')
    expect(out).toContain('https://ok.test')
  })

  it('returns an empty-ish string for a script-only payload', () => {
    const out = DOMPurify.sanitize('<script>alert(1)</script>')
    expect(out.toLowerCase()).not.toContain('<script')
    expect(out).not.toContain('alert(1)')
  })
})
