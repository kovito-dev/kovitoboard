/**
 * useNavigationHistory — ブラウザの戻る/進むボタンで KovitoBoard 内のナビゲーションを制御するフック
 *
 * History API (pushState / popstate) を使い、ビュー遷移のたびにブラウザ履歴を積む。
 * 戻る/進むで popstate が発火したら、保存した状態を復元する。
 */
import { useEffect, useRef, useCallback } from 'react'

/** ブラウザ履歴に保存するナビゲーション状態 */
export interface NavState {
  activeMenuId: string
  selectedSessionId: string | null
  selectedAgentId: string | null
  inlineSessionId: string | null
}

interface UseNavigationHistoryOptions {
  /** 現在のナビゲーション状態 */
  state: NavState
  /** popstate で状態を復元するコールバック */
  onRestore: (state: NavState) => void
}

/**
 * pushState するための関数を返す。
 * popstate イベントを監視して onRestore を呼ぶ。
 */
export function useNavigationHistory({ state, onRestore }: UseNavigationHistoryOptions) {
  // popstate からの復元中は pushState しないためのガード
  const isRestoringRef = useRef(false)
  // 初回 replaceState 済みフラグ
  const initializedRef = useRef(false)
  // onRestore の最新参照を保持
  const onRestoreRef = useRef(onRestore)
  onRestoreRef.current = onRestore

  // 初回マウント時: 現在の状態で replaceState（リロード対応）
  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true
      history.replaceState({ nav: state }, '')
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // popstate リスナー
  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      const navState = e.state?.nav as NavState | undefined
      if (navState) {
        isRestoringRef.current = true
        onRestoreRef.current(navState)
        // 次の React レンダーサイクル後にガードを解除
        requestAnimationFrame(() => {
          isRestoringRef.current = false
        })
      }
    }
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  /** ナビゲーション遷移時に呼ぶ。ブラウザ履歴にエントリを追加する */
  const pushNavState = useCallback((newState: NavState) => {
    if (isRestoringRef.current) return
    history.pushState({ nav: newState }, '')
  }, [])

  return { pushNavState }
}
