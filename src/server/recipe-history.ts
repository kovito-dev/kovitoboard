/**
 * Recipe history — read/write .kovitoboard/recipe-history.jsonl
 */
import { join } from 'path'
import type { FileAccessLayer } from './fs-layer'
import { getKovitoboardDir } from './paths'
import type { RecipeHistoryEntry } from '../shared/recipe-types'

const HISTORY_FILENAME = 'recipe-history.jsonl'

/** Get the path to the recipe history JSONL file. */
export function getRecipeHistoryPath(fs: FileAccessLayer): string {
  return join(getKovitoboardDir(fs), HISTORY_FILENAME)
}

/** Read all recipe history entries. Returns empty array if file doesn't exist. */
export function readRecipeHistory(fs: FileAccessLayer): RecipeHistoryEntry[] {
  const path = getRecipeHistoryPath(fs)
  if (!fs.existsSync(path)) return []

  try {
    const content = fs.readFileSync(path, 'utf-8')
    return content
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as RecipeHistoryEntry)
  } catch (err) {
    console.error('[recipe-history] Failed to read history:', err)
    return []
  }
}

/** Append a single history entry to the JSONL file. */
export function appendRecipeHistory(fs: FileAccessLayer, entry: RecipeHistoryEntry): void {
  const path = getRecipeHistoryPath(fs)
  const dir = getKovitoboardDir(fs)

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const line = JSON.stringify(entry) + '\n'

  // Append to file (create if not exists)
  if (fs.existsSync(path)) {
    const existing = fs.readFileSync(path, 'utf-8')
    fs.writeFileSync(path, existing + line, 'utf-8')
  } else {
    fs.writeFileSync(path, line, 'utf-8')
  }
}

/**
 * Generate a unique history ID in the format r_YYYYMMDD_NNN.
 * NNN is a zero-padded sequence number within the current date.
 */
export function generateHistoryId(fs: FileAccessLayer): string {
  const now = new Date()
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '')

  const history = readRecipeHistory(fs)
  const todayPrefix = `r_${dateStr}_`
  const todayEntries = history.filter((e) => e.id.startsWith(todayPrefix))
  const nextNum = todayEntries.length + 1

  return `${todayPrefix}${String(nextNum).padStart(3, '0')}`
}
