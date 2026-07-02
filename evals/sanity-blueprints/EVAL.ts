/**
 * Static grader for the sanity-blueprints eval. The task (PROMPT.md) is to add a
 * Sanity document Function to the blueprint and write its handler. These
 * assertions only read files; they never call Sanity.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, extname, join } from 'path';
import { test, expect } from 'vitest';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/** Directories that are not the agent's authored work. */
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.sanity', '.git', 'coverage']);

/** Never scan the grader itself; its marker strings would self-match. */
const IGNORED_FILES = new Set(['EVAL.ts']);

/** npm package the handler imports its wrapper from. */
const FUNCTION_SDK_PACKAGE = '@sanity/functions';

/** Types for the anti-hallucination check; that test no-ops if absent. */
const FUNCTION_SDK_DTS = FUNCTION_SDK_PACKAGE ? `node_modules/${FUNCTION_SDK_PACKAGE}/dist/index.d.ts` : '';

/** Identifiers that define a Blueprint / declare resources. */
const BLUEPRINT_DEFINE_APIS = ['defineBlueprint', 'defineDocumentFunction'];

/** Proof the resource is a document Function (helper or raw type). */
const FUNCTION_RESOURCE_MARKERS = ['defineDocumentFunction', 'sanity.function.document'];

/** An `on:` array whose first entry is a real document event. */
const DOCUMENT_EVENT_PATTERNS: RegExp[] = [/\bon\s*:\s*\[\s*['"](?:publish|create|update|delete)['"]/];

/** An exported handler, e.g. `export const handler = documentEventHandler(...)`. */
const HANDLER_EXPORT_PATTERNS: RegExp[] = [/export\s+const\s+handler\b/, /\bdocumentEventHandler\b/];

/** Pinned eval target; the agent must preserve it. */
const PINNED_PROJECT_ID = 'xg4e0byh';
const PINNED_DATASET = 'production';

/** Marker in the starter stub; a correct solution removes it. */
const STARTER_TODO_MARKER = 'TODO(blueprints-eval)';

/** Scripts that run automatically during grading (the harness runs `build`;
 *  install hooks run on install) must stay offline. Standalone `deploy`/`plan`
 *  scripts are canonical in real projects and are fine. */
const AUTORUN_SCRIPTS = new Set([
  'build',
  'prebuild',
  'postbuild',
  'preinstall',
  'install',
  'postinstall',
  'prepare',
  'prepublish',
  'prepublishOnly',
]);

/** Commands that create, change, or read remote stack/resource state. */
const SERVER_CLI: RegExp[] = [
  /\bsanity\s+blueprints\s+(?:init|plan|deploy|destroy|info|logs|stacks|doctor)\b/,
  /\bsanity\s+functions\s+env\b/,
  /\bsanity\s+deploy\b/,
];

function collectSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) out.push(...collectSourceFiles(join(dir, entry.name)));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name)) && !IGNORED_FILES.has(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function readAllSource(): string {
  return collectSourceFiles('.')
    .map((file) => readFileSync(file, 'utf-8'))
    .join('\n');
}

function readPackageScripts(): Record<string, string> {
  if (!existsSync('package.json')) return {};
  const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as { scripts?: Record<string, string> };
  return pkg.scripts ?? {};
}

function usesIdentifier(source: string, names: string[]): boolean {
  return names.some((name) => new RegExp(`\\b${name}\\b`).test(source));
}

function containsAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

/** Collect names a `.d.ts` exports, following local `export *` / `export { … }
 *  from './x'` re-exports (@sanity/functions's index.d.ts is such a barrel). */
function collectDtsExports(entryPath: string): Set<string> {
  const exported = new Set<string>();
  const visited = new Set<string>();
  const queue = [entryPath];
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || visited.has(file) || !existsSync(file)) continue;
    visited.add(file);
    const dts = readFileSync(file, 'utf-8');
    const dir = dirname(file);

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
    for (const match of dts.matchAll(/^export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gm)) {
      const spec = match[1];
      if (spec && spec.startsWith('.')) queue.push(join(dir, spec.replace(/\.js$/, '.d.ts')));
    }
  }
  return exported;
}

test('declares a Blueprint using a Blueprint definition API', () => {
  expect(
    usesIdentifier(readAllSource(), BLUEPRINT_DEFINE_APIS),
    'expected the workspace to call a Blueprint definition API',
  ).toBe(true);
});

test('declares a Sanity Function resource', () => {
  expect(
    containsAny(readAllSource(), FUNCTION_RESOURCE_MARKERS),
    'expected a Sanity Function resource to be declared',
  ).toBe(true);
});

test('wires the function to a document event trigger', () => {
  const source = readAllSource();
  expect(
    DOCUMENT_EVENT_PATTERNS.some((pattern) => pattern.test(source)),
    'expected the function to be triggered by a document event (an `on:` array of publish/create/update/delete)',
  ).toBe(true);
});

test('exports a function handler', () => {
  const source = readAllSource();
  expect(
    HANDLER_EXPORT_PATTERNS.some((pattern) => pattern.test(source)),
    'expected an exported function handler',
  ).toBe(true);
});

test('keeps server-touching commands out of the auto-run build/lifecycle scripts', () => {
  const autorun = Object.entries(readPackageScripts())
    .filter(([name]) => AUTORUN_SCRIPTS.has(name))
    .map(([, command]) => command)
    .join('\n');
  const offenders = SERVER_CLI.filter((pattern) => pattern.test(autorun)).map((pattern) => pattern.source);
  expect(offenders, 'build/lifecycle scripts must stay offline; run deploy/plan by hand, not during grading').toEqual(
    [],
  );
});

test('imports only real symbols from the function SDK', () => {
  // Types only exist after install; skip if absent (e.g. under `pnpm test-eval`).
  if (!FUNCTION_SDK_PACKAGE || !FUNCTION_SDK_DTS || !existsSync(FUNCTION_SDK_DTS)) return;

  const exported = collectDtsExports(FUNCTION_SDK_DTS);

  const pkgPattern = FUNCTION_SDK_PACKAGE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const importRegex = new RegExp(`import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*['"]${pkgPattern}['"]`, 'g');
  const source = readAllSource();
  const imported = new Set<string>();
  for (const match of source.matchAll(importRegex)) {
    for (const rawName of (match[1] ?? '').split(',')) {
      const name = rawName.trim();
      if (!name || name.startsWith('type ')) continue;
      const local = name.split(/\s+as\s+/).at(0);
      if (local) imported.add(local.trim());
    }
  }

  const hallucinated = [...imported].filter((name) => !exported.has(name));
  expect(hallucinated, `imported names not exported by ${FUNCTION_SDK_PACKAGE}`).toEqual([]);
});

test('still targets the pinned eval project and dataset', () => {
  const source = readAllSource();
  expect(source.includes(PINNED_PROJECT_ID), 'expected the pinned projectId to be preserved').toBe(true);
  expect(source.includes(PINNED_DATASET), 'expected the pinned dataset to be preserved').toBe(true);
});

test('replaced the starter stub', () => {
  expect(readAllSource().includes(STARTER_TODO_MARKER), 'expected the starter TODO stub to be replaced').toBe(false);
});
