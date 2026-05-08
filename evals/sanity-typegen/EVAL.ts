import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from 'vitest';

// The upstream template (sanity-io/sanity-template-nextjs-clean) extracts the
// studio schema to a root-level ./sanity.schema.json. We accept a few common
// locations for the extracted schema, and locate the generated TypeGen output
// by scanning for its characteristic `*QueryResult` type exports rather than
// a specific filename — the Sanity CLI lets callers choose the output path.

async function readFile(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function readJson(filePath: string): Promise<unknown> {
  const content = await readFile(filePath);
  if (content === undefined) return undefined;
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

async function firstExisting(...paths: string[]): Promise<string | undefined> {
  for (const p of paths) {
    if ((await readFile(p)) !== undefined) return p;
  }
  return undefined;
}

// Locate the generated TypeGen output file anywhere under `frontend/` by
// looking for the signature `*QueryResult` type exports it always produces.
// Uses the native `fs.promises.glob` (Node 22+) so we avoid a third-party dep.
async function findGeneratedTypesFile(): Promise<string | undefined> {
  const signature = /export type \w+QueryResult\b/;
  for await (const filePath of fs.glob('frontend/**/*.{ts,tsx}', {
    exclude: ['**/node_modules/**', '**/.next/**', '**/.sanity/**', '**/dist/**', '**/.git/**'],
  })) {
    const content = await readFile(filePath);
    if (content && signature.test(content)) return filePath;
  }
  return undefined;
}

const extractedSchemaPath = await firstExisting(
  'sanity.schema.json',
  'studio/sanity.schema.json',
  'studio/schema.json',
  'frontend/sanity.schema.json',
);

const frontendTypesPath = await findGeneratedTypesFile();

test('studio schema was extracted to a schema.json', async () => {
  expect(
    extractedSchemaPath,
    'expected a `sanity.schema.json` (or `schema.json`) file produced by `sanity schema extract`',
  ).not.toBeUndefined();

  const schema = await readJson(extractedSchemaPath!);
  expect(Array.isArray(schema), 'schema.json should be a JSON array of type definitions').toBe(true);

  const names = new Set((schema as Array<{ name?: string }>).map((t) => t?.name));
  for (const expected of ['post', 'page', 'person', 'settings']) {
    expect(names, `schema.json should contain the "${expected}" type`).toContain(expected);
  }
});

test('frontend sanity.types.ts was generated', () => {
  expect(frontendTypesPath, 'expected a generated `sanity.types.ts` in the frontend workspace').not.toBeUndefined();
});

test('generated frontend types include schema types and at least one GROQ query result', async () => {
  expect(frontendTypesPath).not.toBeUndefined();
  const content = (await readFile(frontendTypesPath!))!;

  for (const typeName of ['Post', 'Page', 'Person', 'Settings']) {
    expect(content, `expected \`export type ${typeName}\` in generated types`).toMatch(
      new RegExp(`export type ${typeName}\\b`),
    );
  }

  expect(content, 'expected at least one `*QueryResult` type, indicating GROQ queries were picked up').toMatch(
    /export type \w+QueryResult\b/,
  );
});

test('typegen is configured via `sanity.cli.{ts,js}`, not the deprecated `sanity-typegen.json`', async () => {
  // `sanity-typegen.json` was deprecated in Sanity CLI 4.19.0 in favor of a
  // `typegen` block inside `sanity.cli.{ts,js}`. Ensure the agent took the
  // modern path.
  // https://www.sanity.io/docs/help/configuring-typegen-in-sanity-cli-config
  const typegenJsonPath = await firstExisting(
    'frontend/sanity-typegen.json',
    'studio/sanity-typegen.json',
    'sanity-typegen.json',
  );
  expect(
    typegenJsonPath,
    `found deprecated \`${typegenJsonPath ?? 'sanity-typegen.json'}\` — typegen should be configured in \`sanity.cli.{ts,js}\` instead`,
  ).toBeUndefined();

  const cliPath = await firstExisting(
    'frontend/sanity.cli.ts',
    'frontend/sanity.cli.js',
    'studio/sanity.cli.ts',
    'studio/sanity.cli.js',
    'sanity.cli.ts',
    'sanity.cli.js',
  );
  expect(cliPath, 'expected a `sanity.cli.{ts,js}` in the frontend, studio, or repo root').not.toBeUndefined();

  const content = (await readFile(cliPath!))!;
  expect(content, `${cliPath} should contain a \`typegen\` block`).toMatch(/typegen\s*:/);
});

test('a workspace has a script that runs typegen', async () => {
  const pkgPaths = ['frontend/package.json', 'studio/package.json', 'package.json'];
  const allScripts: string[] = [];
  for (const p of pkgPaths) {
    const pkg = (await readJson(p)) as { scripts?: Record<string, string> } | undefined;
    if (pkg?.scripts) allScripts.push(...Object.values(pkg.scripts));
  }
  expect(
    allScripts.join(' '),
    'expected a script in frontend, studio, or root package.json that invokes `sanity typegen generate`',
  ).toMatch(/sanity\s+typegen\s+generate/);
});

// The fixture ships with a handful of files where the query data is typed as
// `any` — these are the "symptoms" the agent is asked to fix. A successful run
// should both remove those `any` annotations and wire the consuming code up to
// the generated Sanity types.
const seededAnyFiles = [
  'frontend/app/components/Posts.tsx',
  'frontend/app/components/InfoSection.tsx',
  'frontend/app/components/PageBuilder.tsx',
  'frontend/sanity/lib/types.ts',
  'frontend/sanity/lib/utils.ts',
];

test('query-consuming files no longer use `any` for Sanity data', async () => {
  // Matches shapes like `: any`, `any[]`, `= any`, `any |`, `| any`, `<any`, `any>`.
  const anyAnnotation = /(?::\s*any\b|\bany\s*\[\]|=\s*any\b|\bany\s*[|<>]|[|<,]\s*any\b)/;
  for (const filePath of seededAnyFiles) {
    const content = await readFile(filePath);
    expect(content, `expected fixture file ${filePath} to still exist`).not.toBeUndefined();
    expect(content!, `expected \`any\` annotations in ${filePath} to be replaced with real Sanity types`).not.toMatch(
      anyAnnotation,
    );
  }
});

test('query-consuming files reference the generated types module', async () => {
  expect(frontendTypesPath, 'expected to locate the generated types file before checking imports').not.toBeUndefined();

  // Derive a module specifier suffix from the discovered types file path so we
  // can match imports regardless of whether they go through a TS path alias
  // (e.g. `@/sanity.types`) or a relative path (e.g. `../sanity/lib/types.gen`).
  // We match the basename (without extension) plus an optional trailing segment
  // so both styles resolve.
  const basename = path.basename(frontendTypesPath!).replace(/\.d\.ts$|\.ts$|\.tsx$/, '');
  const importSuffixPattern = new RegExp(`from ['"][^'"]*${basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);

  const referencesGeneratedTypes = await Promise.all(
    seededAnyFiles.map(async (filePath) => {
      const content = (await readFile(filePath)) ?? '';
      return importSuffixPattern.test(content);
    }),
  );
  expect(
    referencesGeneratedTypes.some(Boolean),
    `expected at least one of ${seededAnyFiles.join(', ')} to import from the generated types module (\`${basename}\`)`,
  ).toBe(true);
});
