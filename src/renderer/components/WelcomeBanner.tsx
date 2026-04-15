interface WelcomeBannerProps {
  projectName: string
  concept: string | null
  agents: { name: string; role: string; summary: string }[]
  secretaryName: string
  onNavigateToAgents: () => void
}

export function WelcomeBanner({ projectName, concept, agents, secretaryName, onNavigateToAgents }: WelcomeBannerProps) {
  return (
    <div className="flex-1 flex items-center justify-center p-3 md:p-6">
      <div className="max-w-xl w-full">
        <div className="bg-[var(--bg-elevated)] rounded-2xl border border-[var(--border)] p-4 md:p-8 space-y-4 md:space-y-6">
          {/* ヘッダー */}
          <div className="text-center">
            <h1 className="text-xl md:text-2xl font-bold text-[var(--text-primary)] mb-2">
              Welcome to {projectName}!
            </h1>
            {concept ? (
              <p className="text-sm text-[var(--accent-text)]">
                コンセプト: {concept} ✨
              </p>
            ) : (
              <p className="text-sm text-[var(--text-dim)]">
                あなたのAIチームが稼働を開始しました
              </p>
            )}
          </div>

          {/* エージェント一覧 */}
          {agents.length > 0 && (
            <div className="space-y-3">
              <p className="text-sm text-[var(--text-muted)] text-center">
                あなたのAIチームが稼働を開始しました。
              </p>
              <div className="space-y-2">
                {agents.map((agent) => (
                  <div
                    key={agent.name}
                    className="flex items-start gap-3 px-4 py-3 rounded-lg bg-[var(--bg-surface)] border border-[var(--border)]"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-[var(--text-secondary)]">{agent.name}{agent.role ? `（${agent.role}）` : ''}</div>
                      {agent.summary && (
                        <div className="text-xs text-[var(--text-dim)] mt-0.5">{agent.summary}</div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* セパレーター */}
          <div className="border-t border-[var(--border)]" />

          {/* はじめの一歩 */}
          {agents.length > 0 ? (
            <div className="space-y-3">
              <p className="text-sm font-medium text-[var(--text-tertiary)]">
                💡 はじめの一歩:
              </p>
              <p className="text-sm text-[var(--text-muted)]">
                下のボタンから{secretaryName}を選んで、話しかけてみましょう。
              </p>

              <div className="space-y-1.5">
                <p className="text-xs text-[var(--text-dim)]">こんなことを頼めます:</p>
                <div className="space-y-1">
                  <p className="text-xs text-[var(--text-muted)] pl-3">「新しいエージェントを追加したい」</p>
                  <p className="text-xs text-[var(--text-muted)] pl-3">「チームの現状を教えて」</p>
                </div>
              </div>

              <button
                onClick={onNavigateToAgents}
                className="w-full mt-2 px-4 py-2.5 rounded-lg text-sm font-medium bg-[var(--accent-strong)] hover:bg-[var(--accent)] text-white transition-colors"
              >
                {secretaryName}と話す
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm font-medium text-[var(--text-tertiary)]">
                💡 はじめの一歩:
              </p>
              <p className="text-sm text-[var(--text-muted)]">
                まずはエージェント定義ファイルを作成しましょう。
              </p>
              <p className="text-xs text-[var(--text-dim)]">
                プロジェクトの <code className="bg-[var(--bg-surface)] px-1 py-0.5 rounded">.claude/agents/</code> ディレクトリに
                Markdown ファイルを配置すると、KovitoBoard がエージェントとして認識します。
              </p>
              <p className="text-xs text-[var(--text-faint)]">
                詳しくは「エージェント」メニューの空状態ガイドをご覧ください。
              </p>
            </div>
          )}

          {/* 設定ヒント */}
          <p className="text-center text-xs text-[var(--text-faint)]">
            ⚙️ 設定はヘッダーの ⚙ ボタンからいつでも確認できます
          </p>

          {/* コンセプト未設定の場合の追加案内 */}
          {!concept && agents.length > 0 && (
            <div className="bg-[var(--bg-surface)] rounded-lg p-4 border border-[var(--border)]">
              <p className="text-xs text-yellow-400/70 font-medium mb-1">
                💡 コンセプトがまだ設定されていません。
              </p>
              <p className="text-xs text-[var(--text-dim)]">
                {secretaryName}に「コンセプトを設定したい」と話しかけて、チームに世界観を持たせてみましょう！
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
