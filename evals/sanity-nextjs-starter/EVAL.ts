import { execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from 'vitest';

// PROMPT.md tells the agent to scaffold into ./app/ but intentionally stays silent
// on the exact internal structure. The official `sanity-io/sanity-template-nextjs-clean`
// template is a workspace monorepo (./app/frontend + ./app/studio), while the
// `--nextjs-embed-studio` flow produces a single Next.js app with the studio mounted
// inline. These helpers discover whichever layout landed in ./app/.

const rootDir = 'app';

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
  for await (const entry of fs.glob(pattern, { exclude: (p) => p.includes('node_modules') })) {
    results.push(entry);
  }
  return results;
}

async function firstExisting(...paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    const content = await readFile(path);
    if (content !== undefined) return path;
  }
  return undefined;
}

async function findNextAppDir(): Promise<string | undefined> {
  for (const pkgPath of await collect(`${rootDir}/**/package.json`)) {
    const pkg = await readJson(pkgPath);
    if (pkg && 'next' in getDeps(pkg)) return path.dirname(pkgPath);
  }
  return undefined;
}

async function findStudioDir(): Promise<string | undefined> {
  const configs = [
    ...(await collect(`${rootDir}/**/sanity.config.ts`)),
    ...(await collect(`${rootDir}/**/sanity.config.tsx`)),
  ];
  return configs[0] ? path.dirname(configs[0]) : undefined;
}

const nextAppDir = await findNextAppDir();
const studioDir = await findStudioDir();

test('a Next.js app was scaffolded', () => {
  expect(nextAppDir, 'expected a package.json with "next" as a dependency under ./app/').not.toBeUndefined();
});

test('Next.js app uses the App Router', async () => {
  expect(nextAppDir).not.toBeUndefined();
  const layout = await firstExisting(
    path.join(nextAppDir!, 'app/layout.tsx'),
    path.join(nextAppDir!, 'src/app/layout.tsx'),
  );
  expect(layout, 'expected app/layout.tsx').not.toBeUndefined();

  const pagesApp = await firstExisting(
    path.join(nextAppDir!, 'pages/_app.tsx'),
    path.join(nextAppDir!, 'pages/_app.js'),
    path.join(nextAppDir!, 'src/pages/_app.tsx'),
  );
  expect(pagesApp, 'expected no pages/_app.*').toBeUndefined();
});

test('project uses next-sanity (Sanity + Next.js integration)', async () => {
  expect(nextAppDir).not.toBeUndefined();
  const pkg = await readJson(path.join(nextAppDir!, 'package.json'));
  expect(getDeps(pkg)).toHaveProperty('next-sanity');
});

test('Sanity Studio was scaffolded via the Sanity CLI', async () => {
  expect(studioDir, 'expected a sanity.config.ts(x) file under ./app/').not.toBeUndefined();
  const studioPkg = await readJson(path.join(studioDir!, 'package.json'));
  expect(getDeps(studioPkg), 'expected `sanity` as a dependency in the studio package').toHaveProperty('sanity');
});

test('sanity.cli.ts exists', async () => {
  const files = [...(await collect(`${rootDir}/**/sanity.cli.ts`)), ...(await collect(`${rootDir}/**/sanity.cli.js`))];
  expect(files.length, 'expected a sanity.cli.{ts,js} file somewhere under ./app/').toBeGreaterThan(0);
});

test('env files reference the canonical Sanity env vars', async () => {
  const envFiles = [
    ...(await collect(`${rootDir}/**/.env`)),
    ...(await collect(`${rootDir}/**/.env.local`)),
    ...(await collect(`${rootDir}/**/.env.development`)),
    ...(await collect(`${rootDir}/**/.env.development.local`)),
  ];
  const env = (await Promise.all(envFiles.map((p) => readFile(p))))
    .filter((c): c is string => c !== undefined)
    .join('\n');
  expect(env).toMatch(/NEXT_PUBLIC_SANITY_PROJECT_ID/);
  expect(env).toMatch(/NEXT_PUBLIC_SANITY_DATASET/);
});

test('app builds successfully', () => {
  expect(nextAppDir).not.toBeUndefined();
  execSync('npm run build', { stdio: 'pipe', cwd: nextAppDir! });
});
