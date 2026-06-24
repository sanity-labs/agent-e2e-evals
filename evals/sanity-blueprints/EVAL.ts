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
 * Maintainer note: the Blueprints-specific API names below are intentionally
 * left blank. Fill them in from canonical Blueprints info (see README.md,
 * "Blanks to fill"). Until they are filled, the dependent assertions fail with
 * an explicit TODO message rather than silently passing.
 *
 * To (re)generate the fixture lockfile after editing package.json:
 *   cd evals/sanity-blueprints && pnpm install
 * Keep these assertions stable between baseline and comparison runs.
 */
import { existsSync, readdirSync, readFileSync } from 'fs';
import { extname, join } from 'path';
import { test, expect } from 'vitest';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

/** Directories that are not the agent's authored work. */
const IGNORED_DIRS = new Set(['node_modules', 'dist', '.sanity', '.git', 'coverage']);

/** The grader itself must never be scanned — it contains the forbidden-command
 *  patterns below and would otherwise self-match. */
const IGNORED_FILES = new Set(['EVAL.ts']);

// ───────────────────────────────────────────────────────────────────────────
// BLANKS — fill from canonical Blueprints info. See README.md "Blanks to fill".
// ───────────────────────────────────────────────────────────────────────────

/** npm package the function handler imports from. e.g. '@sanity/functions' */
const FUNCTION_SDK_PACKAGE: string = '';

/** Path to that package's type declarations, for the anti-hallucination test. */
const FUNCTION_SDK_DTS = FUNCTION_SDK_PACKAGE ? `node_modules/${FUNCTION_SDK_PACKAGE}/dist/index.d.ts` : '';

/** Identifiers that define a Blueprint / declare resources. e.g. ['defineBlueprint'] */
const BLUEPRINT_DEFINE_APIS: string[] = [];

/** Substrings proving the declared resource is a Sanity Function.
 *  e.g. ["type: 'sanity.function.document'"] */
const FUNCTION_RESOURCE_MARKERS: string[] = [];

/** Substrings proving the function is wired to a document event trigger.
 *  e.g. ['on:', "event: 'publish'"] */
const DOCUMENT_EVENT_MARKERS: string[] = [];

/** Patterns proving a handler is exported.
 *  e.g. [/export\s+default\b/, /export\s+(?:const|async\s+function)\s+handler\b/] */
const HANDLER_EXPORT_PATTERNS: RegExp[] = [];

/** Shared eval target the agent must not change. e.g. 'xg4e0byh' / 'production' */
const PINNED_PROJECT_ID: string = '';
const PINNED_DATASET: string = '';

/** Marker left in the starter stub; a correct solution removes it. */
const STARTER_TODO_MARKER = 'TODO(blueprints-eval)';

/** Server-touching commands the agent must avoid. It should scaffold by hand and
 *  may use only local-only commands (e.g. blueprints `doctor`). Confirm/adjust
 *  this list against the canonical CLI (see README.md). */
const FORBIDDEN_CLI: RegExp[] = [
  /sanity\s+blueprints\s+init\b/,
  /sanity\s+blueprints\s+deploy\b/,
  /sanity\s+blueprints\s+plan\b/,
  /sanity\s+functions\s+deploy\b/,
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

function readPackageScripts(): string {
  if (!existsSync('package.json')) return '';
  const pkg = JSON.parse(readFileSync('package.json', 'utf-8')) as { scripts?: Record<string, string> };
  return Object.values(pkg.scripts ?? {}).join('\n');
}

function usesIdentifier(source: string, names: string[]): boolean {
  return names.some((name) => new RegExp(`\\b${name}\\b`).test(source));
}

function containsAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
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
  expect(DOCUMENT_EVENT_MARKERS, 'TODO: fill DOCUMENT_EVENT_MARKERS in EVAL.ts').not.toEqual([]);
  expect(
    containsAny(readAllSource(), DOCUMENT_EVENT_MARKERS),
    'expected the function to be triggered by a document event',
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

test('does not run server-touching Blueprints commands', () => {
  const haystack = [readAllSource(), readPackageScripts()].join('\n');
  const offenders = FORBIDDEN_CLI.filter((pattern) => pattern.test(haystack)).map((pattern) => pattern.source);
  expect(offenders, 'agent must scaffold by hand; init/deploy/plan hit the server').toEqual([]);
});

test('imports only real symbols from the function SDK', () => {
  // Type declarations only exist after install. If the package is unconfigured
  // or not installed (e.g. under `pnpm test-eval`, which skips install/build)
  // there is nothing meaningful to check.
  if (!FUNCTION_SDK_PACKAGE || !FUNCTION_SDK_DTS || !existsSync(FUNCTION_SDK_DTS)) return;

  const dts = readFileSync(FUNCTION_SDK_DTS, 'utf-8');
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
