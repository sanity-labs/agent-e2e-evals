/**
 * Fixture provenance
 *
 * This eval's workspace is a minimal Sanity Blueprints project. The agent's
 * task (see PROMPT.md) is to scaffold a Blueprint *by hand* that declares a
 * Sanity Function wired to a document event, and to author the function
 * handler — WITHOUT running any server-touching CLI command (e.g. the
 * blueprints `init`, `deploy`, or `plan` subcommands). Grading is fully static:
 * these assertions only read files, they never call Sanity.
 *
 * Keep these assertions stable between baseline and comparison runs.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { dirname, extname, join } from 'path';
import { test, expect } from 'vitest';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/** Directories that are not the agent's authored work. */
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.sanity', '.git', 'coverage']);

/** The grader itself must never be scanned — it contains the forbidden-command
 *  patterns below and would otherwise self-match. */
const IGNORED_FILES = new Set(['EVAL.ts']);

// ───────────────────────────────────────────────────────────────────────────
// Blueprints API specifics — filled from canonical Blueprints material.
// ───────────────────────────────────────────────────────────────────────────

/** npm package the function handler imports the handler wrapper from. */
const FUNCTION_SDK_PACKAGE = '@sanity/functions';

/** Path to that package's type declarations, for the anti-hallucination test.
 *  NOTE: verify this resolves after `pnpm install` — if the package ships its
 *  types elsewhere (e.g. a different `dist/` path or per-export `.d.ts`), update
 *  this. When the file is absent the check no-ops (see the test below), so a
 *  wrong path silently disables it rather than failing. */
const FUNCTION_SDK_DTS = FUNCTION_SDK_PACKAGE ? `node_modules/${FUNCTION_SDK_PACKAGE}/dist/index.d.ts` : '';

/** Identifiers that define a Blueprint / declare resources (from @sanity/blueprints). */
const BLUEPRINT_DEFINE_APIS = ['defineBlueprint', 'defineDocumentFunction'];

/** Substrings proving the declared resource is a Sanity document Function.
 *  Canonical authored code uses the `defineDocumentFunction` helper; the raw
 *  underlying resource type is accepted too for the hand-rolled style. */
const FUNCTION_RESOURCE_MARKERS = ['defineDocumentFunction', 'sanity.function.document'];

/** Patterns proving the function is wired to a document event trigger — an
 *  `on:` array whose first entry is a known document event. Tolerant of quote
 *  style and whitespace. (A plain `event:` is too weak to assert on its own.) */
const DOCUMENT_EVENT_PATTERNS: RegExp[] = [/\bon\s*:\s*\[\s*['"](?:publish|create|update|delete)['"]/];

/** Patterns proving a handler is exported. Canonical shape is a named export
 *  `export const handler = documentEventHandler<T>(async (...) => { ... })`. */
const HANDLER_EXPORT_PATTERNS: RegExp[] = [/export\s+const\s+handler\b/, /\bdocumentEventHandler\b/];

/** Shared eval target the agent must not change (mirrors sanity-sdk-app). It is
 *  pinned in sanity.blueprint.ts via `values`; grading is static, so no real
 *  project is contacted. */
const PINNED_PROJECT_ID = 'xg4e0byh';
const PINNED_DATASET = 'production';

/** Marker left in the starter stub; a correct solution removes it. */
const STARTER_TODO_MARKER = 'TODO(blueprints-eval)';

/** Scripts that run automatically during grading: the harness runs `build`, and
 *  install/prepare lifecycle hooks run on `pnpm install`. These must stay
 *  offline. Standalone action scripts (`deploy`, `plan`, `info`, `logs`, …) are
 *  canonical in real Blueprint projects, so they are NOT penalized — the agent
 *  just shouldn't wire a server-touching command into this auto-run path. */
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

/** Commands that create, change, or read remote stack/resource state. NB:
 *  `blueprints doctor` is NOT offline either — it inspects the deployed stack's
 *  scope. */
const SERVER_CLI: RegExp[] = [
  /\bsanity\s+blueprints\s+(?:init|plan|deploy|destroy|info|logs|stacks|doctor)\b/,
  /\bsanity\s+functions\s+env\b/,
  /\bsanity\s+deploy\b/,
];

// ───────────────────────────────────────────────────────────────────────────

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

/** Collect the names a `.d.ts` entry exports, following local `export *` /
 *  `export { … } from './x'` re-exports (barrel files like @sanity/functions's
 *  index.d.ts, which only re-exports from ./definers.js and ./types.js). */
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
    // Follow re-exports: `export * from './x.js'` and `export { … } from './x.js'`.
    for (const match of dts.matchAll(/^export\s+(?:\*|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gm)) {
      const spec = match[1];
      if (spec && spec.startsWith('.')) queue.push(join(dir, spec.replace(/\.js$/, '.d.ts')));
    }
  }
  return exported;
}

test('declares a Blueprint using a Blueprint definition API', () => {
  expect(BLUEPRINT_DEFINE_APIS, 'TODO: fill BLUEPRINT_DEFINE_APIS in EVAL.ts').not.toEqual([]);
  expect(
    usesIdentifier(readAllSource(), BLUEPRINT_DEFINE_APIS),
    'expected the workspace to call a Blueprint definition API',
  ).toBe(true);
});

test('declares a Sanity Function resource', () => {
  expect(FUNCTION_RESOURCE_MARKERS, 'TODO: fill FUNCTION_RESOURCE_MARKERS in EVAL.ts').not.toEqual([]);
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
  expect(HANDLER_EXPORT_PATTERNS.length, 'TODO: fill HANDLER_EXPORT_PATTERNS in EVAL.ts').toBeGreaterThan(0);
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
  expect(offenders, 'build/lifecycle scripts must stay offline — run deploy/plan by hand, not during grading').toEqual(
    [],
  );
});

test('imports only real symbols from the function SDK', () => {
  // Type declarations only exist after install. If the package is unconfigured
  // or not installed (e.g. under `pnpm test-eval`, which skips install/build)
  // there is nothing meaningful to check.
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
  expect(PINNED_PROJECT_ID, 'TODO: set PINNED_PROJECT_ID in EVAL.ts').not.toBe('');
  expect(PINNED_DATASET, 'TODO: set PINNED_DATASET in EVAL.ts').not.toBe('');
  const source = readAllSource();
  expect(source.includes(PINNED_PROJECT_ID), 'expected the pinned projectId to be preserved').toBe(true);
  expect(source.includes(PINNED_DATASET), 'expected the pinned dataset to be preserved').toBe(true);
});

test('replaced the starter stub', () => {
  expect(readAllSource().includes(STARTER_TODO_MARKER), 'expected the starter TODO stub to be replaced').toBe(false);
});
