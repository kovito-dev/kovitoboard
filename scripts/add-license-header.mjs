#!/usr/bin/env node
/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Adds the AGPL-3.0-or-later license header to KovitoBoard source files.
 * Files that already contain `SPDX-License-Identifier` are skipped (idempotent).
 * Shebang lines are preserved.
 *
 * Usage:
 *   # Bulk mode (no file args): scan all eligible source files in repo
 *   node scripts/add-license-header.mjs --dry-run   # preview only
 *   node scripts/add-license-header.mjs             # write changes
 *
 *   # Targeted mode (file args): only process the listed files (lefthook usage)
 *   node scripts/add-license-header.mjs src/server/foo.ts src/renderer/bar.tsx
 *
 * Bulk-mode targets: src/, scripts/, tools/, tests/, recipes/, app.example/,
 * and root-level *.ts / *.mjs / *.js config files (playwright/vite/vitest).
 *
 * Lefthook integration: invoked from `lefthook.yml` pre-commit with
 * `{staged_files}` so that newly added/modified source files automatically
 * receive the header before commit. See DEC-012 §3 for the rationale.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HEADER = `/*
 * KovitoBoard
 * Copyright (C) 2026 Anode LLC
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
`;

const SPDX_MARKER = 'SPDX-License-Identifier';

const VALID_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js']);

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const fileArgs = args.filter((a) => !a.startsWith('--'));

let files;
if (fileArgs.length > 0) {
  // Targeted mode: only process the listed files (lefthook integration)
  files = fileArgs
    // Normalize to relative paths from repoRoot
    .map((f) => f.replace(new RegExp(`^${repoRoot}/`), '').replace(/^\.\//, ''))
    // Filter to valid source extensions only (silently skip the rest)
    .filter((f) => {
      const dot = f.lastIndexOf('.');
      return dot >= 0 && VALID_EXTENSIONS.has(f.slice(dot));
    });
  if (files.length === 0) {
    // Nothing to process — exit cleanly so lefthook does not fail
    process.exit(0);
  }
} else {
  // Bulk mode: enumerate all eligible source files via find
  const findCmd = [
    // Root-level config files
    `find . -maxdepth 1 -type f \\( -name "*.ts" -o -name "*.mjs" -o -name "*.js" \\)`,
    // Sub-directory targets
    `find src scripts tools tests recipes app.example -type f \\( -name "*.ts" -o -name "*.tsx" -o -name "*.mjs" -o -name "*.js" \\) 2>/dev/null`,
  ].join(' ; ');

  const stdout = execSync(findCmd, {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: '/bin/bash',
  });

  files = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((f) => f.replace(/^\.\//, ''))
    // De-dup just in case
    .filter((f, i, arr) => arr.indexOf(f) === i);
}

console.log(`Found ${files.length} target files`);
if (dryRun) console.log('(--dry-run mode: no files will be modified)\n');

let added = 0;
let skipped = 0;
const errors = [];

for (const file of files) {
  const fullPath = resolve(repoRoot, file);
  try {
    const content = await readFile(fullPath, 'utf8');

    if (content.includes(SPDX_MARKER)) {
      skipped++;
      continue;
    }

    let newContent;
    if (content.startsWith('#!')) {
      // Preserve shebang on first line
      const newlineIdx = content.indexOf('\n');
      if (newlineIdx === -1) {
        // shebang only, no newline — append newline + header + (empty)
        newContent = content + '\n' + HEADER;
      } else {
        const shebang = content.slice(0, newlineIdx + 1);
        const rest = content.slice(newlineIdx + 1);
        newContent = shebang + HEADER + rest;
      }
    } else {
      newContent = HEADER + content;
    }

    if (!dryRun) {
      await writeFile(fullPath, newContent, 'utf8');
    }
    added++;
  } catch (e) {
    errors.push({ file, error: e.message });
  }
}

console.log(`\nResult: added=${added}, skipped(existing)=${skipped}, errors=${errors.length}`);
if (errors.length) {
  console.log('\nErrors:');
  for (const { file, error } of errors) {
    console.log(`  ${file}: ${error}`);
  }
  process.exit(1);
}
