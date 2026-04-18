/**
 * TODO Page — simple task list with add/toggle/delete.
 *
 * Customization hint: change Tailwind classes below to adjust colors.
 * e.g. ask your concierge "change the TODO background color to blue"
 */
import { useState, useEffect, useCallback } from 'react'

const TASK_PREFIX = 'task:'
const MAX_TASKS = 100

type Task = {
  id: string
  title: string
  done: boolean
  createdAt: string
}

type HandlerResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } }

declare global {
  interface Window {
    kb: {
      call: <T = unknown>(callId: string, input?: Record<string, unknown>) => Promise<HandlerResponse<T>>
    }
  }
}

export default function TodoPage() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [inputValue, setInputValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  const loadAll = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const listRes = await window.kb.call<{ keys: string[]; hasMore: boolean }>('list-tasks')
      if (!listRes.ok) {
        setError(listRes.error.message)
        setIsLoading(false)
        return
      }
      const items: Task[] = []
      for (const key of listRes.data.keys) {
        const r = await window.kb.call<{ value: string | null }>('get-task', { key })
        if (r.ok && r.data.value) {
          try {
            items.push(JSON.parse(r.data.value) as Task)
          } catch {
            // Skip invalid data
          }
        }
      }
      items.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      setTasks(items)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tasks')
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  const handleAdd = useCallback(async () => {
    const title = inputValue.trim()
    if (!title) return

    if (tasks.length >= MAX_TASKS) {
      setError(`Maximum of ${MAX_TASKS} tasks reached. Please delete some tasks before adding new ones.`)
      return
    }

    const task: Task = {
      id: crypto.randomUUID(),
      title,
      done: false,
      createdAt: new Date().toISOString(),
    }

    setInputValue('')
    setTasks((prev) => [...prev, task]) // Optimistic update

    try {
      const res = await window.kb.call('save-task', {
        key: `${TASK_PREFIX}${task.id}`,
        value: JSON.stringify(task),
      })
      if (!res.ok) {
        setError(res.error.message)
        setTasks((prev) => prev.filter((t) => t.id !== task.id)) // Rollback
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save task')
      setTasks((prev) => prev.filter((t) => t.id !== task.id))
    }
  }, [inputValue, tasks.length])

  const handleToggle = useCallback(async (id: string) => {
    const target = tasks.find((t) => t.id === id)
    if (!target) return

    const updated: Task = { ...target, done: !target.done }
    setTasks((prev) => prev.map((t) => (t.id === id ? updated : t)))

    try {
      const res = await window.kb.call('save-task', {
        key: `${TASK_PREFIX}${id}`,
        value: JSON.stringify(updated),
      })
      if (!res.ok) {
        setError(res.error.message)
        setTasks((prev) => prev.map((t) => (t.id === id ? target : t))) // Rollback
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update task')
      setTasks((prev) => prev.map((t) => (t.id === id ? target : t)))
    }
  }, [tasks])

  const handleDelete = useCallback(async (id: string) => {
    const snapshot = tasks
    setTasks((prev) => prev.filter((t) => t.id !== id))

    try {
      const res = await window.kb.call('delete-task', { key: `${TASK_PREFIX}${id}` })
      if (!res.ok) {
        setError(res.error.message)
        setTasks(snapshot) // Rollback
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete task')
      setTasks(snapshot)
    }
  }, [tasks])

  const doneCount = tasks.filter((t) => t.done).length

  return (
    <div className="flex flex-col h-full" data-testid="todo">
      <div className="max-w-2xl mx-auto w-full px-4 py-6 flex flex-col gap-4">
        {/* Header */}
        <h1 className="text-lg font-bold text-[var(--text-primary)]">TODO</h1>

        {/* Error banner */}
        {error && (
          <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400 flex items-center justify-between">
            <span>{error}</span>
            <button
              onClick={() => setError(null)}
              className="text-red-400 hover:text-red-300 ml-2 shrink-0"
            >
              ✕
            </button>
          </div>
        )}

        {/* Input form */}
        <div className="flex gap-2">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            placeholder="New task..."
            aria-label="New task"
            data-testid="todo-input"
            className="flex-1 px-3 py-2 bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-dim)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-border)]"
          />
          <button
            onClick={handleAdd}
            disabled={!inputValue.trim() || tasks.length >= MAX_TASKS}
            data-testid="todo-add"
            className="px-4 py-2 bg-[var(--accent-bg)] text-[var(--accent-text)] rounded-lg text-sm font-medium hover:opacity-80 disabled:opacity-40 transition-opacity"
          >
            Add
          </button>
        </div>

        {/* Task list */}
        {isLoading && tasks.length === 0 && (
          <div className="text-sm text-[var(--text-dim)] text-center py-4">
            Loading...
          </div>
        )}

        <div className="space-y-1">
          {tasks.map((task, index) => (
            <div
              key={task.id}
              data-testid={`todo-item-${index}`}
              className="flex items-center justify-between py-2 px-3 bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg hover:bg-[var(--bg-hover)] transition-colors"
            >
              <label className="flex items-center gap-3 flex-1 min-w-0 cursor-pointer">
                <input
                  type="checkbox"
                  checked={task.done}
                  onChange={() => handleToggle(task.id)}
                  data-testid={`todo-toggle-${index}`}
                  className="w-4 h-4 shrink-0 accent-[var(--accent-bg)]"
                />
                <span
                  className={`text-sm truncate ${
                    task.done
                      ? 'line-through text-[var(--text-dim)]'
                      : 'text-[var(--text-primary)]'
                  }`}
                >
                  {task.title}
                </span>
              </label>
              <button
                onClick={() => handleDelete(task.id)}
                data-testid={`todo-delete-${index}`}
                className="text-red-400 hover:text-red-300 text-xs font-bold ml-2 shrink-0"
              >
                Delete
              </button>
            </div>
          ))}
        </div>

        {/* Empty state */}
        {!isLoading && tasks.length === 0 && (
          <div className="text-sm text-[var(--text-dim)] text-center py-4">
            No tasks yet. Add one using the form above.
          </div>
        )}

        {/* Footer: count */}
        {tasks.length > 0 && (
          <div className="text-xs text-[var(--text-dim)] text-right">
            {doneCount} of {tasks.length} completed
          </div>
        )}
      </div>
    </div>
  )
}
