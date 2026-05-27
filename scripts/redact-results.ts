#!/usr/bin/env node
import { glob, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const RESULTS_DIR = join(import.meta.dirname, '..', 'results');
const SANITY_AUTH_TOKEN = process.env.SANITY_AUTH_TOKEN!;

for await (const entry of glob('**/*', { cwd: RESULTS_DIR, withFileTypes: true })) {
  if (!entry.isFile()) continue;

  const path = join(entry.parentPath, entry.name);
  const before = await readFile(path, 'utf8');
  if (before.includes(SANITY_AUTH_TOKEN)) {
    await writeFile(path, before.replaceAll(SANITY_AUTH_TOKEN, '[REDACTED]'));
  }
}
