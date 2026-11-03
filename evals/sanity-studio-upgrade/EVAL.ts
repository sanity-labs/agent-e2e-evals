/**
 * Offline grader for sanity-studio-upgrade (contract: /workspace/evals/upgrade/CONTRACT.md).
 * Runs in the separate verifier after the harness's npm install and `npm run build`. It checks installed
 * versions, regenerates TypeGen output with the project's own script, typechecks with the shipped tsconfig,
 * loads sanity.config.ts in Node to read config values, and compares the extracted schema with the v3 one.
 * A message starting "UNKNOWN (" means the grader could not observe the attempt, not that the agent failed.
 * Not checked: the Studio in a browser, deploys, runtime behaviour beyond the config values read here.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { beforeAll, expect, test } from 'vitest';

type Obj = Record<string, any>;

// Loads sanity.config.ts with jiti (a dependency of the v6 CLI) in its own process; prints JSON.
const CONFIG_SRC = `import {writeFileSync} from 'node:fs'
const out = process.argv[2]
const done = (o) => { writeFileSync(out, JSON.stringify(o)); process.exit(0) }
let createJiti
try { ;({createJiti} = await import('jiti')) } catch (e) { done({status: 'unknown', reason: 'could not load jiti: ' + e.message}) }
try {
  const jiti = createJiti(import.meta.url, {jsx: true, interopDefault: true})
  const mod = await jiti.import('./sanity.config.ts')
  const raw = mod && mod.default !== undefined ? mod.default : mod
  const cfg = Array.isArray(raw) ? raw[0] : raw
  const prev = [{name: 'eval-builtin', title: 'Built-in', url: 'https://eval.invalid/builtin'}]
  const auth = cfg.auth ?? {}
  const providers = typeof auth.providers === 'function' ? await auth.providers(prev) : auth.providers
  const types = typeof cfg.schema?.types === 'function' ? cfg.schema.types([]) : cfg.schema?.types ?? []
  const post = types.find((t) => t && t.name === 'post')
  const title = post?.fields?.find((f) => f.name === 'title')
  done({status: 'ok', search: cfg.search ?? null, authKeys: Object.keys(auth), redirectOnSingle: auth.redirectOnSingle,
    providers: (providers ?? []).map((p) => (p ? {name: p.name, title: p.title, url: p.url} : p)),
    plugins: (cfg.plugins ?? []).map((p) => p && p.name), titleInput: typeof title?.components?.input === 'function' ? title.components.input.name : null})
} catch (e) { done({status: 'fail', reason: 'sanity.config.ts could not be loaded: ' + (e && e.message)}) }
`;

const EXPECTED_ATTRS: Record<string, Record<string, Obj>> = {
  post: {
    title: { type: 'string' },
    slug: { type: 'inline', name: 'slug' },
    author: { type: 'inline', name: 'author.reference' },
    publishedAt: { type: 'string' },
  },
  author: { name: { type: 'string' }, bio: { type: 'string' } },
};

let setup = '';
const typegenRuns: Array<{ status: number | null; out: string }> = [];
let typesExist = false;
let tscError = '';
let config: Obj | undefined;
let schema: Obj[] | undefined;

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, SANITY_TELEMETRY_DISABLED: '1', CI: '1' },
  });
  const raw = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`;
  // Strip colour codes and box-drawing padding so failure messages show the CLI's actual words.
  return {
    status: r.status,
    out: raw
      .replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '')
      .replace(/[│╭╮╰╯─]+/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim(),
  };
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (['node_modules', 'dist', '.sanity', '.git'].includes(name) || name.startsWith('.eval-')) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name) && name !== 'EVAL.ts') out.push(p);
  }
  return out;
}

beforeAll(() => {
  // package.json belongs to the agent here, so a project whose dependencies do not install is the agent's failure.
  if (!existsSync('node_modules/.bin/sanity'))
    setup = 'the Sanity CLI is not installed: the dependencies did not install';
  if (!existsSync('node_modules/.bin/tsc')) setup ||= 'TypeScript is not installed: the dependencies did not install';
  if (setup) return;
  // The generated types must come from the project's own `npm run typegen`, run twice like a developer would.
  rmSync('src/sanity.types.ts', { force: true });
  for (let i = 0; i < 2; i++) typegenRuns.push(run('npm', ['run', 'typegen']));
  typesExist = existsSync('src/sanity.types.ts');
  const t = run(resolve('node_modules/.bin/tsc'), ['--noEmit', '-p', 'tsconfig.json']);
  if (t.status !== 0) tscError = `tsc --noEmit failed (exit ${t.status}): ${t.out.slice(0, 800)}`;
  if (existsSync('schema.json')) {
    try {
      schema = JSON.parse(readFileSync('schema.json', 'utf8')) as Obj[];
    } catch {
      schema = undefined;
    }
  }
  writeFileSync('.eval-upgrade-config.mjs', CONFIG_SRC);
  try {
    const r = run(process.execPath, ['.eval-upgrade-config.mjs', '.eval-upgrade-config.json']);
    config = existsSync('.eval-upgrade-config.json')
      ? (JSON.parse(readFileSync('.eval-upgrade-config.json', 'utf8')) as Obj)
      : { status: 'unknown', reason: `the config loader wrote no result (exit ${r.status}): ${r.out.slice(-400)}` };
  } finally {
    rmSync('.eval-upgrade-config.mjs', { force: true });
    rmSync('.eval-upgrade-config.json', { force: true });
  }
}, 900_000);

function noSetupProblem() {
  expect(setup, setup).toBe('');
}

function major(pkg: string): string {
  const p = join('node_modules', pkg, 'package.json');
  return existsSync(p) ? String(JSON.parse(readFileSync(p, 'utf8')).version) : 'missing';
}

function atLeast(version: string, min: [number, number, number]): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) return false;
  const v: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (v[0] !== min[0]) return v[0] > min[0];
  if (v[1] !== min[1]) return v[1] > min[1];
  return v[2] >= min[2];
}

test('Studio v6, Vision v6 and React 19.2.2 or newer are installed', () => {
  noSetupProblem();
  expect(major('sanity'), 'sanity version').toMatch(/^6\./);
  expect(major('@sanity/vision'), '@sanity/vision version').toMatch(/^6\./);
  for (const pkg of ['react', 'react-dom'])
    expect(atLeast(major(pkg), [19, 2, 2]), `${pkg} ${major(pkg)} is not >= 19.2.2`).toBe(true);
});

test('npm run typegen succeeds twice and regenerates the types the app code uses', () => {
  noSetupProblem();
  typegenRuns.forEach((r, i) =>
    expect(r.status, `npm run typegen (run ${i + 1}) failed: ${r.out.slice(-600)}`).toBe(0),
  );
  expect(typesExist, 'npm run typegen did not write src/sanity.types.ts').toBe(true);
  const latest = existsSync('src/latest.ts') ? readFileSync('src/latest.ts', 'utf8') : '';
  expect(
    /from\s+['"]\.\/sanity\.types['"]/.test(latest),
    'src/latest.ts no longer imports its type from ./sanity.types',
  ).toBe(true);
});

test('the project typechecks with the shipped tsconfig', () => {
  noSetupProblem();
  expect(tscError, tscError).toBe('');
});

test('no type errors are suppressed', () => {
  noSetupProblem();
  const suppressed = sourceFiles('.').filter((f) => /@ts-(ignore|expect-error|nocheck)/.test(readFileSync(f, 'utf8')));
  expect(suppressed, `type errors are suppressed in: ${suppressed.join(', ')}`).toEqual([]);
});

test('search keeps the legacy strategy and sign-in keeps the built-in providers plus SSO', () => {
  noSetupProblem();
  expect(
    config?.status,
    `${config?.status === 'unknown' ? 'UNKNOWN (grader)' : 'config'}: ${config?.reason ?? ''}`,
  ).toBe('ok');
  expect(config!.search?.strategy, `search is ${JSON.stringify(config!.search)}`).toBe('groqLegacy');
  expect('enableLegacySearch' in (config!.search ?? {}), 'search.enableLegacySearch is still set').toBe(false);
  expect(config!.authKeys.includes('mode'), 'auth.mode is still set').toBe(false);
  // The built-in providers must pass through untouched, followed by the same SSO provider as in v3.
  expect(config!.providers, 'auth providers should be the built-in ones followed by Acme SSO').toEqual([
    { name: 'eval-builtin', title: 'Built-in', url: 'https://eval.invalid/builtin' },
    { name: 'saml', title: 'Acme SSO', url: 'https://sso.acme.example/login' },
  ]);
  expect(config!.redirectOnSingle, 'auth.redirectOnSingle changed').toBe(false);
});

test('the plugins and the custom title input are kept', () => {
  noSetupProblem();
  expect(
    config?.status,
    `${config?.status === 'unknown' ? 'UNKNOWN (grader)' : 'config'}: ${config?.reason ?? ''}`,
  ).toBe('ok');
  expect(config!.plugins, `plugins are ${JSON.stringify(config!.plugins)}`).toEqual(
    expect.arrayContaining(['sanity/structure', '@sanity/vision']),
  );
  expect(config!.titleInput, 'post.title no longer uses TitleInput').toBe('TitleInput');
});

test('the listed schema field types are unchanged', () => {
  noSetupProblem();
  expect(schema, 'schema.json is missing or unreadable after npm run typegen').toBeDefined();
  for (const [doc, attrs] of Object.entries(EXPECTED_ATTRS)) {
    const t = schema!.find((s) => s.name === doc && s.type === 'document');
    expect(t, `document type ${doc} is missing`).toBeDefined();
    const own = Object.keys(t!.attributes).filter((k) => !k.startsWith('_'));
    expect(own.sort(), `${doc} fields`).toEqual([...Object.keys(attrs), ...(doc === 'post' ? ['body'] : [])].sort());
    for (const [k, v] of Object.entries(attrs)) expect(t!.attributes[k].value, `${doc}.${k}`).toMatchObject(v);
  }
  const body = schema!.find((s) => s.name === 'post')!.attributes.body.value;
  const members = body?.of?.type === 'union' ? body.of.of : [body?.of];
  expect(body?.type, 'post.body is not an array').toBe('array');
  expect(
    members.some((m: Obj) => m?.attributes?.children),
    'post.body lost its Portable Text blocks',
  ).toBe(true);
  expect(
    members.some((m: Obj) => m?.attributes?._type?.value?.value === 'image'),
    'post.body lost its images',
  ).toBe(true);
  const ref = schema!.find((s) => s.name === 'author.reference');
  expect(ref?.value?.dereferencesTo, 'post.author must still reference author').toBe('author');
});
