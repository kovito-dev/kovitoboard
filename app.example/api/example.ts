/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Example API extension.
 *
 * When placed at app/api/example.ts, this mounts at /api/ext/example.
 * Each file must export default as an Express Router.
 */
import { Router } from 'express'

const router = Router()

router.get('/', (_req, res) => {
  res.json({
    message: 'Hello from app/api/example!',
    timestamp: new Date().toISOString(),
  })
})

export default router
