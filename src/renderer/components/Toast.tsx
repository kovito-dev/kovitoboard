/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Minimal toast notification system.
 *
 * Provides `<ToastProvider>` and `useToast()` hook.
 * Toasts auto-dismiss after a configurable duration (default 5 s).
 */
import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react'
import { t } from '../i18n'

export type ToastType = 'info' | 'success' | 'error'

interface ToastItem {
  id: string
  message: string
  type: ToastType
  duration: number
}

interface ToastContextValue {
  addToast: (message: string, type?: ToastType, duration?: number) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>')
  return ctx
}

let toastCounter = 0

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }
  }, [])

  const addToast = useCallback(
    (message: string, type: ToastType = 'info', duration = 5000) => {
      const id = `toast-${++toastCounter}`
      const item: ToastItem = { id, message, type, duration }
      setToasts((prev) => [...prev, item])

      if (duration > 0) {
        const timer = setTimeout(() => removeToast(id), duration)
        timersRef.current.set(id, timer)
      }
    },
    [removeToast],
  )

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      for (const timer of timersRef.current.values()) {
        clearTimeout(timer)
      }
    }
  }, [])

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      {/* Toast container — fixed top-right */}
      {toasts.length > 0 && (
        <div className="fixed top-4 right-4 z-[60] flex flex-col gap-2 pointer-events-none">
          {toasts.map((toast) => (
            <ToastCard
              key={toast.id}
              toast={toast}
              onDismiss={() => removeToast(toast.id)}
            />
          ))}
        </div>
      )}
    </ToastContext.Provider>
  )
}

function ToastCard({
  toast,
  onDismiss,
}: {
  toast: ToastItem
  onDismiss: () => void
}) {
  const bgColor =
    toast.type === 'success'
      ? 'bg-emerald-600'
      : toast.type === 'error'
        ? 'bg-red-600'
        : 'bg-[var(--bg-elevated)]'

  const borderColor =
    toast.type === 'success'
      ? 'border-emerald-500/30'
      : toast.type === 'error'
        ? 'border-red-500/30'
        : 'border-[var(--border)]'

  const textColor =
    toast.type === 'success' || toast.type === 'error'
      ? 'text-white'
      : 'text-[var(--text-secondary)]'

  return (
    <div
      className={`pointer-events-auto ${bgColor} ${textColor} border ${borderColor} rounded-lg shadow-lg px-4 py-3 text-sm max-w-sm animate-[slideIn_0.2s_ease-out]`}
      role="alert"
    >
      <div className="flex items-center gap-2">
        <span className="flex-1">{toast.message}</span>
        <button
          onClick={onDismiss}
          className="shrink-0 opacity-60 hover:opacity-100 transition-opacity text-current"
          aria-label={t('common.dismiss')}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
    </div>
  )
}
