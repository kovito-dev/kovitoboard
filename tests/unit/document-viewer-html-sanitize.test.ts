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
 * The recipe renders project HTML files via `dangerouslySetInnerHTML`
 * after passing the raw string through `DOMPurify.sanitize()`. Bundled
 * sample recipes run as `code-trusted (bundled)`, but the *content*
 * they read (arbitrary project HTML) is untrusted and executes in the
 * same realm as the host renderer. This test pins the sanitizer's
 * behavior so a future dependency bump or config change cannot silently
 * reopen the XSS surface.
 *
 * `DOMPurify.sanitize` is invoked here exactly as the recipe page calls
 * it (default config) so the assertions track the real render path.
 */
import { describe, it, expect } from 'vitest'
import DOMPurify from 'dompurify'

describe('Document Viewer HTML sanitization', () => {
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

  it('preserves benign formatting markup and inline styles', () => {
    const out = DOMPurify.sanitize(
      '<h1>Title</h1><p style="color: red;">Body <strong>bold</strong> <a href="https://ok.test">link</a></p>',
    )
    expect(out).toContain('<h1>')
    expect(out).toContain('<strong>')
    expect(out).toContain('https://ok.test')
    // Inline styles survive sanitization; the host CSP already allows
    // them via `style-src 'unsafe-inline'`, so no CSP change is needed.
    expect(out).toContain('style')
  })

  it('returns an empty-ish string for a script-only payload', () => {
    const out = DOMPurify.sanitize('<script>alert(1)</script>')
    expect(out.toLowerCase()).not.toContain('<script')
    expect(out).not.toContain('alert(1)')
  })
})
