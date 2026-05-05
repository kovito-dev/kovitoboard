/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * /sessions — Auto-redirects to the latest session when one exists.
 *
 * Rationale: opening the sessions menu used to land on a blank pane and
 * required the user to manually pick a session from the sidebar. The
 * latest session (by lastEventAt, computed once in `useIPC` initial load)
 * is almost always the one the user wants to look at, so we redirect
 * straight to it. SessionList is still shown as the sidebar by the
 * parent layout, so picking a different session remains one click away.
 *
 * Falls back to the previous empty-state message when no session exists
 * yet (e.g. fresh installs before the first agent sends anything).
 */
import { Navigate } from 'react-router-dom'
import { t } from '../i18n'

interface SessionsPageProps {
  /** Latest session id, computed in `useIPC` initial load. */
  defaultSessionId: string | null
}

export function SessionsPage({ defaultSessionId }: SessionsPageProps) {
  if (defaultSessionId) {
    return <Navigate to={`/sessions/${defaultSessionId}`} replace />
  }
  return (
    <div className="flex-1 flex items-center justify-center text-[var(--text-dim)] text-sm">
      {t('session.empty')}
    </div>
  )
}
