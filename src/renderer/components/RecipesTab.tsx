/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
/**
 * Recipes tab — v0.2.1 preview UI.
 *
 * Disabled mock-up that previews the v0.3.0 KovitoHub recipe-install
 * surface. Renders banner + 2 disabled recipe cards + footnote. No
 * network calls (BS-L10 normative — `/api/recipes/hub/*` and any
 * other v0.3.0 endpoint are never hit). The v0.3.0 wiring will reuse
 * the same DOM scaffold and only flip the disabled state + bind real
 * data, so the layout is intentionally close to the eventual final
 * shape.
 *
 * @see docs/design/discussions/v021-bundled-sample-enable-disable-decision-2026-05-18.md §4.10 / §4'.5
 * @see judgment doc §6.6 (i18n keys, recipeTab.*)
 * @stable v0.2.1
 */
import { t } from '../i18n'

/**
 * Static mock-up data — purely visual. Both cards reuse the same
 * `recipeTab.mockup.exampleRecipeTitle` key per spec §4.10 SSOT
 * (the wireframe shows two identical "Example Recipe" cards).
 */
const MOCKUP_CARDS = [
  { id: 'mockup-1' },
  { id: 'mockup-2' },
] as const

export function RecipesTab() {
  return (
    <div
      data-testid="recipes-tab"
      className="space-y-6"
    >
      {/* Info banner — describes the v0.3.0 KovitoHub model. */}
      <div
        data-testid="recipes-tab-banner"
        className="px-4 py-3 bg-[var(--bg-elevated)] border border-[var(--border)] rounded-lg space-y-1"
      >
        <h3 className="text-sm font-semibold text-[var(--text-primary)]">
          {t('recipeTab.banner.comingSoon')}
        </h3>
        <p className="text-xs text-[var(--text-secondary)]">
          {t('recipeTab.banner.description')}
        </p>
      </div>

      {/* Disabled mock-up section.
          Every interactive surface is `aria-disabled="true"` + tabIndex={-1}
          so keyboard users do not focus dead buttons, and `pointer-events:
          none` is applied to the Install button so a stray click is a no-op
          even if the disabled attribute is overridden in dev tools.
          Network silence (BS-L10) is structurally enforced — there is no
          fetch call anywhere in this component. */}
      <section
        aria-label="Preview recipe cards (disabled)"
        className="grid grid-cols-1 sm:grid-cols-2 gap-3"
      >
        {MOCKUP_CARDS.map((card) => (
          <div
            key={card.id}
            data-testid={`recipes-tab-mockup-card-${card.id}`}
            aria-disabled="true"
            className="
              bg-[var(--bg-surface)] border border-[var(--border)] rounded-lg
              p-4 space-y-2 opacity-60 cursor-not-allowed select-none
            "
          >
            <div className="flex items-center gap-2">
              <h4 className="text-sm font-bold text-[var(--text-primary)] truncate">
                {t('recipeTab.mockup.exampleRecipeTitle')}
              </h4>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-sky-500/20 text-sky-400 shrink-0">
                {t('recipeTab.mockup.signBadge')}
              </span>
            </div>
            <p className="text-xs text-[var(--text-dim)] line-clamp-2">
              {/* No description i18n key — the mockup intentionally
                  shows only the title + sign badge + disabled install
                  button per wireframe §4.10. */}
            </p>
            <button
              type="button"
              aria-disabled="true"
              tabIndex={-1}
              disabled
              data-testid={`recipes-tab-mockup-install-${card.id}`}
              className="
                w-full px-3 py-1.5 text-xs font-medium rounded-lg
                bg-[var(--bg-elevated)] text-[var(--text-dim)]
                cursor-not-allowed
                pointer-events-none
              "
            >
              {t('recipeTab.mockup.installButton')}
            </button>
          </div>
        ))}
      </section>

      {/* Footnote — reinforces the preview-only nature so users do
          not mistake the disabled cards for a broken page. */}
      <p
        data-testid="recipes-tab-footnote"
        className="text-xs text-[var(--text-dim)] text-center"
      >
        {t('recipeTab.footnote.previewOnly')}
      </p>
    </div>
  )
}
