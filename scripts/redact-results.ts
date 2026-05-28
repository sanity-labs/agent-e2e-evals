#!/usr/bin/env node
import { glob, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scrubSecrets } from '../experiments/lib/redact-secrets.js';

const RESULTS_DIR = join(import.meta.dirname, '..', 'results');

// Redact any secrets from the results dir, in case any slipped through the onRunComplete hook
for await (const entry of glob('**/*', { cwd: RESULTS_DIR, withFileTypes: true })) {
  if (!entry.isFile()) continue;

  const path = join(entry.parentPath, entry.name);
  const before = await readFile(path, 'utf8');
  const after = scrubSecrets(before);
  if (after !== before) {
    await writeFile(path, after);
  }
}
