/**
 * Fixture provenance
 *
 * This eval's workspace is a snapshot of the `app-quickstart` template,
 * generated with `npx sanity@latest init --template app-quickstart` (sanity ^5.30).
 * Everything except this file and PROMPT.md is copied into the agent's
 * workspace, so keep maintenance notes here rather than in a README.
 *
 * Intentional deviations from the raw scaffold:
 * - package.json: added `vitest` (needed to run these assertions)
 * - src/App.tsx: projectId pinned to the shared eval project `xg4e0byh`,
 *   dataset `production` (same project as the sanity-live-content eval)
 * - sanity.cli.ts: organizationId pinned to `onTtibhNi`, the org that owns
 *   that project
 *
 * To regenerate after a template change: scaffold fresh (for pre-release
 * template changes, use the locally built CLI from the `cli` repo), copy it
 * over this directory, then re-apply the deviations above. Do not change the
 * assertions between baseline and comparison runs.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { extname, join } from 'path';
import { test, expect } from 'vitest';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

/** Hooks that read documents from a dataset */
const DATA_HOOKS = [
  'useDocuments',
  'usePaginatedDocuments',
  'useDocumentProjection',
  'useDocument',
  'useQuery',
];

/** Hooks that write/edit documents */
const EDIT_HOOKS = ['useEditDocument', 'useApplyDocumentActions'];

function collectSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name)))
    .map((entry) => join(entry.parentPath, entry.name));
}

function readAllSource(): string {
  return collectSourceFiles('src')
    .map((file) => readFileSync(file, 'utf-8'))
    .join('\n');
}

test('uses an SDK hook to read documents', () => {
  const source = readAllSource();
  const used = DATA_HOOKS.filter((hook) => new RegExp(`\\b${hook}\\b`).test(source));
  expect(used.length).toBeGreaterThan(0);
});

test('uses an SDK hook to edit documents', () => {
  const source = readAllSource();
  const used = EDIT_HOOKS.filter((hook) => new RegExp(`\\b${hook}\\b`).test(source));
  expect(used.length).toBeGreaterThan(0);
});

test('does not fall back to raw @sanity/client', () => {
  const source = readAllSource();
  expect(source).not.toMatch(/from\s+['"]@sanity\/client['"]/);
  expect(source).not.toMatch(/\bcreateClient\s*\(/);
});

test('does not import hooks that @sanity/sdk-react does not export', () => {
  // Type declarations are only present after install; if they're missing the
  // build test has already failed, so there's nothing meaningful to check.
  const dtsPath = 'node_modules/@sanity/sdk-react/dist/index.d.ts';
  if (!existsSync(dtsPath)) return;

  const dts = readFileSync(dtsPath, 'utf-8');
  const exported = new Set<string>();
  for (const match of dts.matchAll(
    /^export declare (?:abstract )?(?:function|const|class|interface|type|enum|let|var) (\w+)/gm,
  )) {
    if (match[1]) exported.add(match[1]);
  }
  for (const match of dts.matchAll(/^export \{([^}]+)\}/gm)) {
    for (const rawName of (match[1] ?? '').split(',')) {
      const name = rawName.trim().replace(/^type\s+/, '');
      if (!name) continue;
      const alias = name.split(/\s+as\s+/).at(-1);
      if (alias) exported.add(alias.trim());
    }
  }

  const source = readAllSource();
  const imported = new Set<string>();
  const importRegex = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@sanity\/sdk-react['"]/g;
  for (const match of source.matchAll(importRegex)) {
    for (const rawName of (match[1] ?? '').split(',')) {
      const name = rawName.trim();
      if (!name || name.startsWith('type ')) continue;
      const local = name.split(/\s+as\s+/).at(0);
      if (local) imported.add(local.trim());
    }
  }

  const hallucinated = [...imported].filter((name) => !exported.has(name));
  expect(hallucinated).toEqual([]);
});

test('wraps data fetching in a Suspense boundary', () => {
  const source = readAllSource();
  expect(source).toMatch(/<\s*(?:React\.)?Suspense\b/);
});

test('replaced the example component', () => {
  const appSource = readFileSync('src/App.tsx', 'utf-8');
  expect(appSource).not.toMatch(/<ExampleComponent\s*\/?>/);
});

test('still points at the original project and dataset', () => {
  const source = readAllSource();
  expect(source).toMatch(/xg4e0byh/);
  expect(source).toMatch(/['"]production['"]/);
});
