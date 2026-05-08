/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Handler Registry — Registration and name resolution for 9 Category A handlers.
 *
 * Manages all handler modules and retrieves implementations by handler name.
 * Individual handlers are registered here after being implemented in Phase E.
 *
 * @see recipe-system.md §12-2
 * @stable v0.1.0
 */

import { serverLogger } from '../logger'
import type { CategoryAHandlerName, HandlerDef } from './types.js'

// =========================================
// Registry
// =========================================

const handlers = new Map<CategoryAHandlerName, HandlerDef>()

/**
 * Registers a handler implementation.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function registerHandler(handler: HandlerDef<any, any>): void {
  if (handlers.has(handler.name)) {
    serverLogger.warn(`[handler-registry] Handler "${handler.name}" is already registered, overwriting`)
  }
  handlers.set(handler.name, handler)
}

/**
 * Retrieves a handler implementation by name.
 */
export function getHandler(name: CategoryAHandlerName): HandlerDef | undefined {
  return handlers.get(name)
}

/**
 * Returns all registered handler names.
 */
export function getRegisteredHandlerNames(): CategoryAHandlerName[] {
  return [...handlers.keys()]
}

/**
 * For testing: clears the registry.
 */
export function clearRegistry(): void {
  handlers.clear()
}
