/**
 * app/ extension menu definition example.
 *
 * Usage:
 *   cp -r app.example app
 *   npm run dev
 *
 * Each entry registers a page in the nav menu.
 * The `component` field uses dynamic import for code-splitting.
 * Pages must use `export default` (required by React.lazy).
 */
import type { AppMenuEntry } from '../src/renderer/types/app-types'

export const menuEntries: AppMenuEntry[] = [
  {
    id: 'example',
    label: 'サンプル',
    icon: 'content',
    component: () => import('./pages/ExamplePage'),
  },
]
