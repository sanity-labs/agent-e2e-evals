import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from 'vitest';

// PROMPT.md tells the agent to initialize a Sanity App SDK app into ./app and
// then build a posts list/edit screen. It gives no further details on structure / layout.
// `npx sanity@latest init --template app-quickstart` drops files directly into the target dir:
// @sanity/sdk-react, deps, and a sanity.cli.ts with an `app` config pointing at a React entry component.
// These helpers discover whatever landed under ./app/ rather than assuming a fixed path.

const rootDir = 'app';

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/** Hooks that read documents from a dataset */
const DATA_LIST_HOOKS = ['useDocuments', 'usePaginatedDocuments'];

const DATA_DISPLAY_HOOKS = ['useDocumentProjection', 'useDocument'];

/** Hooks that write/edit documents */
const EDIT_HOOKS = ['useEditDocument', 'useApplyDocumentActions'];

async function readFile(path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  const content = await readFile(path);
  if (content === undefined) return undefined;
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

function getDeps(pkg: Record<string, unknown> | undefined): Record<string, string> {
  const deps = (pkg?.dependencies ?? {}) as Record<string, string>;
  const devDeps = (pkg?.devDependencies ?? {}) as Record<string, string>;
  return { ...deps, ...devDeps };
}

async function collect(pattern: string): Promise<string[]> {
  const results: string[] = [];
  for await (const entry of fs.glob(pattern, {
    exclude: (p) => p.includes('node_modules'),
  })) {
    results.push(entry);
  }
  return results;
}

// Find the package.json of the SDK app — the one depending on @sanity/sdk-react.
async function findAppDir(): Promise<string | undefined> {
  for (const pkgPath of await collect(`${rootDir}/**/package.json`)) {
    const pkg = await readJson(pkgPath);
    if (pkg && '@sanity/sdk-react' in getDeps(pkg)) return path.dirname(pkgPath);
  }
  return undefined;
}

async function findCliConfig(): Promise<string | undefined> {
  return (await collect(`${rootDir}/**/sanity.cli.ts`))[0];
}

/** Concatenate every source file under ./app/ (excluding node_modules). */
async function readAllSource(): Promise<string> {
  const files: string[] = [];
  for (const ext of SOURCE_EXTENSIONS) {
    files.push(...(await collect(`${rootDir}/**/*${ext}`)));
  }
  const contents = await Promise.all(files.map((file) => readFile(file)));
  return contents.filter((c): c is string => c !== undefined).join('\n');
}

const appDir = await findAppDir();
const cliConfigPath = await findCliConfig();
const source = await readAllSource();

test('an SDK app was initialized under ./app', () => {
  expect(appDir, 'expected a package.json depending on @sanity/sdk-react under ./app/').not.toBeUndefined();
});

test('uses the App SDK React bindings', async () => {
  expect(appDir).not.toBeUndefined();
  const deps = getDeps(await readJson(path.join(appDir!, 'package.json')));
  expect(deps).toHaveProperty('@sanity/sdk-react');
  expect(deps, 'expected react as a dependency').toHaveProperty('react');
});

test('is configured as a Sanity app (sanity.cli has an app entry)', async () => {
  expect(cliConfigPath, 'expected a sanity.cli.ts under ./app/').not.toBeUndefined();
  const cli = (await readFile(cliConfigPath!)) ?? '';
  // App SDK apps configure `app: { entry: ... }`; a Studio would set
  // `studioHost`/`project` instead. Require the `app` block + an entry path.
  expect(cli, 'expected an `app` config block in sanity.cli').toMatch(/\bapp\s*:/);
  expect(cli, 'expected an `entry` pointing at the app component').toMatch(/\bentry\s*:/);
});

test('the configured entry component exists', async () => {
  expect(cliConfigPath).not.toBeUndefined();
  const cli = (await readFile(cliConfigPath!)) ?? '';
  const match = cli.match(/entry\s*:\s*['"]([^'"]+)['"]/);
  expect(match, 'expected an entry path in sanity.cli').not.toBeNull();

  const cliDir = path.dirname(cliConfigPath!);
  const entry = await readFile(path.join(cliDir, match![1]!));
  expect(entry, `expected the entry file ${match?.[1]} to exist`).not.toBeUndefined();
});

test('the app was deployed (sanity.cli records a deployment appId)', async () => {
  // `sanity deploy` doesn't sanity.cli itself — it prints the new app's
  // id and suggests adding it. A persisted `appId` therefore implies both a
  // successful deploy (the id is server-generated) and that the agent followed
  // through and wired it in for future redeploys. Matched anywhere in the
  // config so it holds whether it lands under `deployment:` or `app:`.
  expect(cliConfigPath, 'expected a sanity.cli.{ts,js} under ./app/').not.toBeUndefined();
  const cli = (await readFile(cliConfigPath!)) ?? '';
  const match = cli.match(/appId\s*:\s*['"]([^'"]+)['"]/);
  expect(match, 'expected a deployment appId in sanity.cli (written after `sanity deploy`)').not.toBeNull();
  // guard against the docs placeholder being copy/pasted
  expect(['', 'your-app-id', 'your-app-id-here']).not.toContain(match?.[1]);
});

test('uses an SDK hook to read documents', () => {
  const used = DATA_LIST_HOOKS.filter((hook) => new RegExp(`\\b${hook}\\b`).test(source));
  expect(used.length).toBeGreaterThan(0);
});

test('uses an SDK hook to display documents', () => {
  const used = DATA_DISPLAY_HOOKS.filter((hook) => new RegExp(`\\b${hook}\\b`).test(source));
  expect(used.length).toBeGreaterThan(0);
});

test('uses an SDK hook to edit documents', () => {
  const used = EDIT_HOOKS.filter((hook) => new RegExp(`\\b${hook}\\b`).test(source));
  expect(used.length).toBeGreaterThan(0);
});

test('does not fall back to raw @sanity/client', () => {
  expect(source).not.toMatch(/from\s+['"]@sanity\/client['"]/);
  expect(source).not.toMatch(/\bcreateClient\s*\(/);
});

test('does not import hooks that @sanity/sdk-react does not export', async () => {
  // Type declarations are only present after install; if they're missing the
  // build test has already failed, so there's nothing meaningful to check.
  const dtsPath = appDir
    ? path.join(appDir, 'node_modules/@sanity/sdk-react/dist/index.d.ts')
    : 'node_modules/@sanity/sdk-react/dist/index.d.ts';
  const dts = await readFile(dtsPath);
  if (dts === undefined) return;

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
  expect(source).toMatch(/<\s*(?:React\.)?Suspense\b/);
});

test('replaced the example component', () => {
  expect(source).not.toMatch(/<ExampleComponent\s*\/?>/);
});
