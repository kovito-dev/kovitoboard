/**
 * RecipeInstallModal — レシピインストール時の scope 承認 UI.
 *
 * api: セクションを持つレシピのインストール時に表示される。
 * scope 一覧と使用する handler を提示し、ユーザーの承認/拒否を取得する。
 *
 * @see recipe-system.md §12-4 (インストール時の承認 UX)
 * @stable v0.1.0
 */

import { useEffect, useCallback } from 'react'
import type { RecipeApiSection } from '../../shared/recipe-types'
import { t } from '../i18n'
import type { MessageKey } from '../i18n/ja'

// =========================================
// Types
// =========================================

export interface RecipeInstallModalProps {
  /** レシピ名 */
  recipeName: string
  /** レシピの api: セクション */
  api: RecipeApiSection
  /** インストール中フラグ */
  isInstalling: boolean
  /** 承認ボタン押下時 */
  onConfirm: () => void
  /** 拒否ボタン押下時 */
  onReject: () => void
}

// =========================================
// Scope display config
// =========================================

const SCOPE_ICONS: Record<string, string> = {
  'project-read': '📖',
  'project-write': '📝',
  'agents-read': '🤖',
  'skills-read': '🔧',
  'claude-md-read': '📋',
  'kb-data-read': '📊',
  'own-data': '💾',
}

const HANDLER_ICONS: Record<string, string> = {
  'list-files': '📂',
  'read-file': '📄',
  'write-file': '✏️',
  'kv-get': '🔑',
  'kv-set': '💿',
  'kv-list': '📋',
  'kv-delete': '🗑️',
  'notify': '🔔',
  'export-file': '📤',
}

// =========================================
// Component
// =========================================

export function RecipeInstallModal({
  recipeName,
  api,
  isInstalling,
  onConfirm,
  onReject,
}: RecipeInstallModalProps) {
  // ESC キーで拒否
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isInstalling) {
        onReject()
      }
    },
    [isInstalling, onReject],
  )

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])

  // handler 名の重複排除（複数 call が同じ handler を使う場合）
  const uniqueHandlers = [...new Set(api.calls.map((c) => c.handler))]

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Overlay */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={isInstalling ? undefined : onReject}
      />

      {/* Modal */}
      <div
        className="relative w-full max-w-lg mx-4 bg-[var(--bg-base)] rounded-2xl border border-[var(--border)] shadow-2xl flex flex-col overflow-hidden max-h-[90vh]"
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">
            {t('recipe.install.title', { name: recipeName })}
          </h2>
          {!isInstalling && (
            <button
              onClick={onReject}
              className="p-1 rounded-lg hover:bg-[var(--bg-surface)] text-[var(--text-dim)] transition-colors"
            >
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                <path d="M6 6l8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
          {/* Scope list */}
          <div>
            <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">
              {t('recipe.install.scopeHeading')}
            </h3>
            <div className="space-y-2">
              {api.scopes.map((scope) => (
                <div
                  key={scope}
                  className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[var(--bg-surface)] border border-[var(--border)]"
                >
                  <span className="text-lg">{SCOPE_ICONS[scope] || '🔒'}</span>
                  <div>
                    <span className="text-sm text-[var(--text-primary)]">
                      {t(`recipe.install.scope.${scope}` as MessageKey)}
                    </span>
                    <span className="ml-2 text-xs text-[var(--text-dim)]">
                      ({scope})
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Handler calls */}
          <div>
            <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">
              {t('recipe.install.callsHeading')}
            </h3>
            <div className="flex flex-wrap gap-2">
              {api.calls.map((call) => (
                <div
                  key={call.id}
                  className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md bg-[var(--bg-surface)] border border-[var(--border)] text-sm"
                >
                  <span>{HANDLER_ICONS[call.handler] || '⚙️'}</span>
                  <span className="text-[var(--text-secondary)]">
                    {t(`recipe.install.handler.${call.handler}` as MessageKey)}
                  </span>
                  <span className="text-[var(--text-dim)] text-xs">
                    ({call.id})
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-[var(--border)] bg-[var(--bg-surface)] flex flex-col-reverse sm:flex-row gap-2 sm:justify-end">
          <button
            onClick={onReject}
            disabled={isInstalling}
            className="px-4 py-2 rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:bg-[var(--bg-elevated)] transition-colors disabled:opacity-50"
          >
            {t('recipe.install.reject')}
          </button>
          <button
            onClick={onConfirm}
            disabled={isInstalling}
            className="px-4 py-2 rounded-lg bg-[var(--accent-bg)] text-[var(--accent-text)] border border-[var(--accent-border)] hover:brightness-110 transition-all disabled:opacity-50 font-medium"
          >
            {isInstalling
              ? t('recipe.install.installing')
              : t('recipe.install.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
