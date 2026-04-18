/**
 * Test Annotations — Tag constants for Playwright project filtering
 *
 * Tags are appended to test titles to control which Playwright project
 * runs which tests. The L1 config uses `grep` and `grepInvert` to filter.
 *
 * @see docs/design/e2e-l1-harness-extension.md §8-2
 */

/** Tag for tests requiring the existing-rich project fixture */
export const RICH_PROJECT_TAG = '@rich-project'

/** Tag for tests requiring the pre-onboarding (blank) project fixture */
export const PREONBOARDING_TAG = '@preonboarding'
