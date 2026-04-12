import { useMemo, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import rehypeHighlight from 'rehype-highlight'
import { FILE_PATH_REGEX, hasPreviewableExtension } from '../utils/path'

/** テキストノード内のファイルパスをクリッカブルに変換 */
function renderTextWithFileLinks(
  text: string,
  onFilePathClick?: (path: string) => void,
): ReactNode[] {
  if (!onFilePathClick) return [text]

  const parts: ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  // グローバル正規表現のリセット
  const regex = new RegExp(FILE_PATH_REGEX.source, 'g')
  while ((match = regex.exec(text)) !== null) {
    const filePath = match[1] || match[0]
    const matchStart = match.index + (match[0].length - filePath.length)
    const matchEnd = matchStart + filePath.length

    if (!hasPreviewableExtension(filePath)) continue

    // マッチ前のテキスト
    if (matchStart > lastIndex) {
      parts.push(text.slice(lastIndex, matchStart))
    }

    // クリッカブルなファイルパスリンク
    parts.push(
      <button
        key={`fp-${matchStart}`}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onFilePathClick(filePath)
        }}
        className="text-blue-400 hover:text-blue-300 underline underline-offset-2 decoration-blue-400/40 hover:decoration-blue-300/60 cursor-pointer transition-colors"
        title={`プレビュー: ${filePath}`}
      >
        {filePath}
      </button>,
    )
    lastIndex = matchEnd
  }

  // 残りのテキスト
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex))
  }

  return parts.length > 0 ? parts : [text]
}

interface MarkdownPreviewProps {
  content: string
  /** compact: チャット向け（密度優先）、document: ドキュメント閲覧向け（読みやすさ優先） */
  variant?: 'compact' | 'document'
  /** 単一改行を <br> に変換するか（デフォルト: false） */
  breaks?: boolean
  /** ファイルパスクリック時のコールバック */
  onFilePathClick?: (path: string) => void
}

export function MarkdownPreview({ content, variant = 'compact', breaks = false, onFilePathClick }: MarkdownPreviewProps) {
  const className = variant === 'document'
    ? 'markdown-body markdown-body--document text-sm leading-relaxed max-w-3xl'
    : 'markdown-body text-sm leading-relaxed'

  // react-markdown のカスタムコンポーネント: テキストノードでファイルパスを検出
  const components = useMemo(() => {
    if (!onFilePathClick) return undefined
    return {
      // p タグ内のテキストをファイルパス検出付きで表示
      p: ({ children }: { children?: ReactNode }) => {
        return <p>{processChildren(children, onFilePathClick)}</p>
      },
      // li タグ
      li: ({ children }: { children?: ReactNode }) => {
        return <li>{processChildren(children, onFilePathClick)}</li>
      },
      // td タグ
      td: ({ children }: { children?: ReactNode }) => {
        return <td>{processChildren(children, onFilePathClick)}</td>
      },
      // インラインコード内のファイルパスもクリッカブルに
      code: ({ children, className }: { children?: ReactNode; className?: string }) => {
        // コードブロック（言語指定あり）はそのまま返す
        if (className) return <code className={className}>{children}</code>
        // インラインコードの中身がファイルパスならリンク化
        if (typeof children === 'string') {
          const parts = renderTextWithFileLinks(children, onFilePathClick)
          if (parts.length === 1 && typeof parts[0] === 'string') {
            return <code>{children}</code>
          }
          return <code>{parts}</code>
        }
        return <code>{children}</code>
      },
    }
  }, [onFilePathClick])

  return (
    <div className={className}>
      <Markdown
        remarkPlugins={breaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {content}
      </Markdown>
    </div>
  )
}

/** children の中の文字列ノードにファイルパス検出を適用 */
function processChildren(
  children: ReactNode,
  onFilePathClick: (path: string) => void,
): ReactNode {
  if (typeof children === 'string') {
    return renderTextWithFileLinks(children, onFilePathClick)
  }
  if (Array.isArray(children)) {
    return children.map((child, i) => {
      if (typeof child === 'string') {
        const parts = renderTextWithFileLinks(child, onFilePathClick)
        return parts.length === 1 && typeof parts[0] === 'string'
          ? parts[0]
          : <span key={i}>{parts}</span>
      }
      return child
    })
  }
  return children
}
