/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Per-locale UI copy for the TODO recipe page.
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
    subtitle:
      'シンプルな ToDo アプリです。機能の追加・変更は、右側のサイドパネルからエージェントに依頼してください。',
    failedToLoadTasks: 'タスクの読み込みに失敗しました',
    failedToSaveTask: 'タスクの保存に失敗しました',
    failedToUpdateTask: 'タスクの更新に失敗しました',
    failedToDeleteTask: 'タスクの削除に失敗しました',
    maxTasksReached: (max: number) =>
      `タスクは最大 ${max} 件までです。新しいタスクを追加する前に、いくつか削除してください。`,
    newTaskPlaceholder: '新しいタスク…',
    newTaskAriaLabel: '新しいタスク',
    add: '追加',
    loading: '読み込み中…',
    delete: '削除',
    emptyState: 'タスクはまだありません。上のフォームから追加してください。',
    completedCount: (done: number, total: number) => `${total} 件中 ${done} 件完了`,
  },
  en: {
    subtitle:
      'A simple to-do app. To add or change features, ask the agent from the side panel on the right.',
    failedToLoadTasks: 'Failed to load tasks',
    failedToSaveTask: 'Failed to save task',
    failedToUpdateTask: 'Failed to update task',
    failedToDeleteTask: 'Failed to delete task',
    maxTasksReached: (max: number) =>
      `Maximum of ${max} tasks reached. Please delete some tasks before adding new ones.`,
    newTaskPlaceholder: 'New task...',
    newTaskAriaLabel: 'New task',
    add: 'Add',
    loading: 'Loading...',
    delete: 'Delete',
    emptyState: 'No tasks yet. Add one using the form above.',
    completedCount: (done: number, total: number) => `${done} of ${total} completed`,
  },
} as const
