/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Per-locale UI copy for the Document Viewer recipe page.
 *
 * Kept in a dedicated module so the recipe page component itself stays
 * free of non-ASCII source text. This file is the recipe-local
 * equivalent of the host i18n catalog (`src/renderer/i18n/ja.ts`): a
 * recipe page lives outside the host build graph (`/@fs` dynamic
 * import) and cannot reach the host `t()` catalog, so it carries its
 * own strings and selects the set matching `window.kb.locale`
 * (app-directory-extension.md v1.7 §5.4.4 authoring convention).
 *
 * Like `i18n/ja.ts`, this file is allow-listed in the release-hygiene
 * Japanese-character check (`tools/check-release-hygiene.mjs`).
 */
export const STRINGS = {
  ja: {
    // BCP 47 tag passed to `Date.prototype.toLocaleDateString` so the
    // file-modified timestamp follows the active UI locale.
    dateLocale: 'ja-JP',
    title: 'ドキュメントビューア',
    subtitle:
      'Markdown / HTML ファイルのビューアです。機能の追加・変更は、右側のサイドパネルからエージェントに依頼してください。',
    reload: '再読み込み',
    loading: '読み込み中…',
    failedToListFiles: 'ファイル一覧の取得に失敗しました',
    failedToReadFile: 'ファイルの読み込みに失敗しました',
    failedToLoadFileList: 'ファイル一覧の読み込みに失敗しました',
    retry: '再試行',
    noFilesFound: (exts: string) => `${exts} ファイルが見つかりません`,
    selectFile: '左のパネルからファイルを選択してください',
    documentPreview: 'ドキュメントプレビュー',
  },
  en: {
    dateLocale: 'en-US',
    title: 'Document Viewer',
    subtitle:
      'A viewer for Markdown and HTML files. To add or change features, ask the agent from the side panel on the right.',
    reload: 'Reload',
    loading: 'Loading...',
    failedToListFiles: 'Failed to list files',
    failedToReadFile: 'Failed to read file',
    failedToLoadFileList: 'Failed to load file list',
    retry: 'Retry',
    noFilesFound: (exts: string) => `No ${exts} files found`,
    selectFile: 'Select a file from the left panel to view',
    documentPreview: 'Document preview',
  },
} as const
