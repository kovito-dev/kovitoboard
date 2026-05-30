/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * @vitest-environment jsdom
 *
 * Unit tests for the Document Viewer sample recipe's `buildTree`
 * pure function (recipes/document-viewer, v1.2.0), which converts the
 * flat file list into the hierarchical tree the left pane renders.
 */
import { describe, it, expect } from 'vitest'
import { buildTree } from '../../recipes/document-viewer/pages/DocumentViewer'

type FileEntry = {
  name: string
  path: string
  isDirectory: boolean
  size: number
  modifiedAt: string
}

function file(path: string): FileEntry {
  const name = path.split('/').pop() ?? path
  return { name, path, isDirectory: false, size: 1, modifiedAt: '2026-01-01T00:00:00Z' }
}

describe('buildTree', () => {
  it('keeps top-level files at the root', () => {
    const tree = buildTree([file('README.md'), file('NOTES.md')])
    expect(tree).toHaveLength(2)
    expect(tree.every((n) => n.kind === 'file')).toBe(true)
  })

  it('creates intermediate directory nodes for nested paths', () => {
    const tree = buildTree([file('docs/guide/intro.md')])
    expect(tree).toHaveLength(1)
    const docs = tree[0]
    expect(docs.kind).toBe('dir')
    if (docs.kind !== 'dir') throw new Error('expected dir')
    expect(docs.name).toBe('docs')
    expect(docs.path).toBe('docs')
    const guide = docs.children[0]
    expect(guide.kind).toBe('dir')
    if (guide.kind !== 'dir') throw new Error('expected dir')
    expect(guide.path).toBe('docs/guide')
    expect(guide.children[0].kind).toBe('file')
    expect(guide.children[0].name).toBe('intro.md')
  })

  it('merges files that share a directory prefix', () => {
    const tree = buildTree([file('docs/a.md'), file('docs/b.html')])
    expect(tree).toHaveLength(1)
    const docs = tree[0]
    if (docs.kind !== 'dir') throw new Error('expected dir')
    expect(docs.children).toHaveLength(2)
  })

  it('sorts directories before files, then alphabetically', () => {
    const tree = buildTree([file('z.md'), file('docs/x.md'), file('a.md')])
    expect(tree[0].kind).toBe('dir')
    expect(tree[1].kind).toBe('file')
    expect(tree[1].name).toBe('a.md')
    expect(tree[2].name).toBe('z.md')
  })

  it('nests Windows backslash-separated paths and preserves the original leaf path', () => {
    // The backend derives entry paths with path.relative(), which yields
    // `\`-separated paths on Windows. The tree must still nest, and the leaf
    // node must keep the exact original path for the read-doc round-trip.
    const winFile: FileEntry = {
      name: 'intro.md',
      path: 'docs\\guide\\intro.md',
      isDirectory: false,
      size: 1,
      modifiedAt: '2026-01-01T00:00:00Z',
    }
    const tree = buildTree([winFile])
    expect(tree).toHaveLength(1)
    const docs = tree[0]
    if (docs.kind !== 'dir') throw new Error('expected dir')
    expect(docs.name).toBe('docs')
    const guide = docs.children[0]
    if (guide.kind !== 'dir') throw new Error('expected dir')
    expect(guide.name).toBe('guide')
    const leaf = guide.children[0]
    if (leaf.kind !== 'file') throw new Error('expected file')
    expect(leaf.name).toBe('intro.md')
    // Original separator preserved on the leaf for the backend round-trip.
    expect(leaf.path).toBe('docs\\guide\\intro.md')
  })

  it('assigns each file a stable fileIndex matching its flat-list position', () => {
    // Input order is the sorted flat list the component passes in.
    const tree = buildTree([file('a.md'), file('docs/b.md'), file('c.md')])
    const indices: number[] = []
    const walk = (nodes: ReturnType<typeof buildTree>) => {
      for (const n of nodes) {
        if (n.kind === 'file') indices.push(n.fileIndex)
        else walk(n.children)
      }
    }
    walk(tree)
    expect(indices.sort((x, y) => x - y)).toEqual([0, 1, 2])
  })
})
