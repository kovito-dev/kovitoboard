/**
 * Recipes page — tab container for Import, History, and Export.
 */
import { useState } from 'react'
import { RecipeImport } from '../components/RecipeImport'
import { RecipeHistory } from '../components/RecipeHistory'
import { RecipeExport } from '../components/RecipeExport'

type TabId = 'import' | 'history' | 'export'

const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'import', label: '読み込み' },
  { id: 'history', label: '履歴' },
  { id: 'export', label: '書き出し' },
]

export function RecipesPage() {
  const [activeTab, setActiveTab] = useState<TabId>('import')

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-4 pb-0">
        <h1 className="text-lg font-bold text-[var(--text-primary)] mb-3">
          レシピ
        </h1>

        {/* Tab bar */}
        <div className="flex gap-1 border-b border-[var(--border)]">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-2 text-sm font-medium transition-colors relative ${
                activeTab === tab.id
                  ? 'text-[var(--accent-text)]'
                  : 'text-[var(--text-dim)] hover:text-[var(--text-secondary)]'
              }`}
            >
              {tab.label}
              {activeTab === tab.id && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--accent-text)]" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {activeTab === 'import' && <RecipeImport />}
        {activeTab === 'history' && <RecipeHistory />}
        {activeTab === 'export' && <RecipeExport />}
      </div>
    </div>
  )
}
