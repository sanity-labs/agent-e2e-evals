/**
 * Offline grader for sanity-studio-upgrade (contract: /workspace/evals/upgrade/CONTRACT.md).
 * Runs in the separate verifier after the harness's npm install. It checks installed versions, runs the
 * project's own typegen script twice from a clean state, then runs schema extract and typegen itself and grades
 * only that output: typecheck with the shipped tsconfig, config values loaded in Node, and the extracted schema.
 * A message starting "UNKNOWN (" means the grader could not observe the attempt, not that the agent failed.
 * Not checked: the Studio in a browser, deploys, runtime behaviour beyond the config values read here.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { beforeAll, expect, test } from 'vitest';

type Obj = Record<string, any>;

/** Stand-ins for the built-in sign-in providers the Studio passes to an `auth.providers` callback. */
const BUILTIN = ['google', 'github', 'sanity'].map((name) => ({
  name,
  title: `Built-in ${name} (grader stand-in)`,
  url: `https://eval.invalid/${name}`,
}));
const SSO = { name: 'saml', title: 'Acme SSO', url: 'https://sso.acme.example/login' };

// Loads sanity.config.ts with jiti (a dependency of the v6 CLI) in its own process; prints JSON.
async function loadStudioConfig(
  load: (specifier: string) => Promise<any>,
  baseUrl: string,
  outputPath: string,
  builtInProviders: Array<{ name: string; title: string; url: string }>,
) {
  const fileSystem = process.getBuiltinModule('node:fs');
  // Read before any project code loads; stdin is then empty. Capture result-writing primitives for the same reason.
  const nonce = fileSystem.readFileSync(0, 'utf8').trim();
  const write = fileSystem.writeFileSync;
  const stringify = JSON.stringify;
  const kill = process.kill.bind(process);
  const pid = process.pid;
  const done = (outcome: Record<string, any>) => {
    write(outputPath, stringify({ ...outcome, nonce }));
    kill(pid, 'SIGKILL');
  };
  let createJiti: any;
  try {
    ({ createJiti } = await load('jiti'));
  } catch (error) {
    done({ status: 'unknown', reason: 'could not load jiti: ' + (error as Error).message });
  }
  try {
    const jiti = createJiti(baseUrl, { jsx: true, interopDefault: true });
    const module = await jiti.import('./sanity.config.ts');
    const raw = module && module.default !== undefined ? module.default : module;
    const config = Array.isArray(raw) ? raw[0] : raw;
    const auth = config.auth ?? {};
    const providers = typeof auth.providers === 'function' ? await auth.providers(builtInProviders) : auth.providers;
    const types = typeof config.schema?.types === 'function' ? config.schema.types([]) : (config.schema?.types ?? []);
    const post = types.find((type: any) => type && type.name === 'post');
    const title = post?.fields?.find((field: any) => field.name === 'title');
    done({
      status: 'ok',
      search: config.search ?? null,
      authKeys: Object.keys(auth),
      redirectOnSingle: auth.redirectOnSingle,
      providers: (providers ?? []).map((provider: any) =>
        provider ? { name: provider.name, title: provider.title, url: provider.url } : provider,
      ),
      plugins: (config.plugins ?? []).map((plugin: any) => plugin && plugin.name),
      titleInput: typeof title?.components?.input === 'function' ? title.components.input.name : null,
    });
  } catch (error) {
    done({ status: 'fail', reason: 'sanity.config.ts could not be loaded: ' + (error as Error).message });
  }
}

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
let scriptTypes: string | null = null;
let graderTypes: string | null = null;
let extractError = '';
let generateError = '';
let tscError = '';
let config: Obj | undefined;
let schema: Obj[] | undefined;
/** Installed versions and source files captured before any project code runs. */
const versions: Record<string, string> = {};
const sources = new Map<string, string>();

/**
 * Grading-integrity tripwire. Project config, schema code, and scripts run while grading and must not rewrite files
 * that later checks trust. A ctime at or after the marker catches writes even if their contents are restored; grader
 * outputs and tool caches are exempted. Any hit makes the attempt UNKNOWN so rewritten files can never produce a pass.
 */
const GRADER_WRITES =
  /^(node_modules|node_modules\/\.(vite|cache)(\/.*)?|\.sanity|src|src\/sanity\.types\.ts|schema\.json)$/;
const CACHES = /^node_modules\/\.(vite|cache)$/;
function tripwireStart(): bigint {
  const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); // ctime ticks can be coarse
  const mark = '.eval-tripwire-mark'; // same filesystem as the files it is compared with
  pause();
  writeFileSync(mark, '');
  const time = lstatSync(mark, { bigint: true }).ctimeNs;
  rmSync(mark, { force: true });
  pause();
  return time;
}
function changedSince(time: bigint, directory = '.', out: string[] = []): string[] {
  for (const name of readdirSync(directory)) {
    const path = directory === '.' ? name : `${directory}/${name}`;
    // An allowed path is not reported, but a directory is still searched: node_modules itself changes, its files must not.
    const stats = lstatSync(path, { bigint: true });
    if (stats.ctimeNs >= time && !GRADER_WRITES.test(path)) out.push(path);
    if (stats.isDirectory() && !stats.isSymbolicLink() && !CACHES.test(path)) changedSince(time, path, out);
  }
  return out;
}
function tripwireCheck(time: bigint): string {
  sweep();
  const changed = [...changedSince(time), ...toolDirsChangedSince(time)];
  if (leftovers.length)
    return leftovers[0]?.startsWith('no /proc')
      ? `grading integrity: ${leftovers[0]}`
      : `grading integrity: the verifier observed ${leftovers.length} matching process(es) still running (pid ${leftovers.slice(0, 4).join(', ')})`;
  return changed.length
    ? `grading integrity: the verifier observed changes to ${changed.length} file(s) while the grader ran, so its checks may have read rewritten files: ${changed.slice(0, 8).join(', ')}`
    : '';
}

/**
 * Grader tools run under a fixed PATH and by absolute script path, so a file added to a directory on the verifier's
 * PATH is not run in place of node, npm, tsc, sanity or tar. The tripwire also watches those directories.
 */
const TOOL_DIRS = [...new Set([dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'])];
const TOOL_ENV = { ...process.env, PATH: TOOL_DIRS.join(':') };
const bin = (packageName: string, name: string) => resolve('node_modules', packageName, 'bin', name);
function toolDirsChangedSince(time: bigint): string[] {
  const out: string[] = [];
  for (const directory of TOOL_DIRS.filter((entry) => existsSync(entry)))
    for (const path of [directory, ...readdirSync(directory).map((name) => join(directory, name))])
      if (lstatSync(path, { bigint: true }).ctimeNs >= time) out.push(path);
  return out;
}

/**
 * A process left running (a detached daemon, say) could rewrite what later steps read. Sampled between selected grader
 * steps and at the end: any process of this user that appeared since the grader loaded and does not currently descend
 * from it must exit within a grace period (the Sanity CLI's own telemetry worker takes a few seconds), or the attempt is
 * UNKNOWN. This is bounded detection, not isolation. Nothing is killed, so a grader run on a shared machine cannot stop
 * unrelated work.
 */
const leftovers: string[] = [];
const BASELINE = existsSync('/proc/self/status') ? new Set(Object.keys(processTable())) : null;
function processTable(): Record<string, { parent: string; uid: string; state: string }> {
  const table: Record<string, { parent: string; uid: string; state: string }> = {};
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name)))
    try {
      const status = readFileSync(`/proc/${pid}/status`, 'utf8');
      const field = (name: string) => status.match(new RegExp(`^${name}:\\s+(\\S+)`, 'm'))?.[1] ?? '';
      table[pid] = { parent: field('PPid'), uid: field('Uid'), state: field('State') };
    } catch {}
  return table;
}
function strays(): string[] {
  const table = processTable();
  const self = String(process.pid);
  // The grader's own children have finished when this runs; a detached grandchild is re-parented away from the grader.
  const mine = (pid: string): boolean =>
    pid === self || (!!table[pid] && pid !== '1' && mine(table[pid]?.parent ?? ''));
  const uid = table[self]?.uid;
  return Object.entries(table)
    .filter(([pid, entry]) => !BASELINE!.has(pid) && entry.uid === uid && entry.state !== 'Z' && !mine(pid))
    .map(([pid]) => pid);
}
function sweep() {
  if (!BASELINE) return void leftovers.splice(0, Infinity, 'no /proc, so leftover processes cannot be checked');
  const pause = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  for (let wait = 0; wait < 100 && strays().length; wait++) pause();
  const found = new Set<string>();
  for (let look = 0; look < 3; look++, pause()) for (const pid of strays()) found.add(pid);
  // Process IDs only: argument strings could carry secrets into saved output.
  for (const pid of found) if (!leftovers.includes(pid)) leftovers.push(pid);
}

const fingerprint = (file: string) => `${lstatSync(file, { bigint: true }).ctimeNs}:${readFileSync(file, 'utf8')}`;

function run(command: string, arguments_: string[], input = '') {
  sweep();
  const result = spawnSync(command, arguments_, {
    encoding: 'utf8',
    input,
    timeout: 300_000,
    env: { ...TOOL_ENV, SANITY_TELEMETRY_DISABLED: '1', CI: '1', JITI_FS_CACHE: 'false' },
  });
  const raw = `${result.stdout ?? ''}${result.stderr ?? ''}${result.error ? String(result.error) : ''}`;
  // Strip colour codes and box-drawing padding so failure messages show the CLI's actual words.
  return {
    status: result.status,
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
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name) && name !== 'EVAL.ts') out.push(path);
  }
  return out;
}

beforeAll(() => {
  // package.json belongs to the agent here, so a project whose dependencies do not install is the agent's failure.
  if (!existsSync(bin('sanity', 'sanity'))) setup = 'the Sanity CLI is not installed: the dependencies did not install';
  if (!existsSync(bin('typescript', 'tsc'))) setup ||= 'TypeScript is not installed: the dependencies did not install';
  if (setup) return;
  // Snapshot every value judged from project-controlled files before scripts or config code can rewrite it.
  for (const packageName of ['sanity', '@sanity/vision', 'react', 'react-dom'])
    versions[packageName] = installed(packageName);
  for (const file of sourceFiles('.')) sources.set(file, readFileSync(file, 'utf8'));
  const since = tripwireStart();
  // The project's own script, twice from a clean state: the first run must create schema.json, the second must
  // cope with it already existing (v6 extract refuses to overwrite without --force).
  rmSync('src/sanity.types.ts', { force: true });
  rmSync('schema.json', { force: true });
  for (let i = 0; i < 2; i++) typegenRuns.push(run('npm', ['run', 'typegen']));
  scriptTypes = existsSync('src/sanity.types.ts') ? readFileSync('src/sanity.types.ts', 'utf8') : null;
  // Then the grader's own extract and generate, so no later check rests on what the script wrote. The extract goes
  // to a directory the project does not know and is read at once: the project's script writes schema.json itself, so
  // the grader never trusts that file. The grader's copy feeds typegen and must be unchanged afterwards.
  const sanity = bin('sanity', 'sanity');
  const extractDirectory = mkdtempSync(join(tmpdir(), 'eval-upgrade-'));
  const extractPath = join(extractDirectory, 'schema.json');
  const extracted = run(process.execPath, [sanity, 'schema', 'extract', '--path', extractPath, '--force']);
  const schemaText = extracted.status === 0 && existsSync(extractPath) ? readFileSync(extractPath, 'utf8') : null;
  rmSync(extractDirectory, { recursive: true, force: true });
  if (schemaText === null)
    extractError = `sanity schema extract failed (exit ${extracted.status}): ${extracted.out.slice(-600)}`;
  else writeFileSync('schema.json', schemaText);
  // Pin each file the grader writes and later steps read: any write to it after this point voids the attempt. Pinned
  // before typegen generate, because generate loads the project's CLI config.
  const pins = new Map<string, string>();
  const pin = (file: string) => existsSync(file) && pins.set(file, fingerprint(file));
  pin('schema.json');
  rmSync('src/sanity.types.ts', { force: true });
  const generated = run(process.execPath, [sanity, 'typegen', 'generate']);
  pin('src/sanity.types.ts');
  graderTypes = existsSync('src/sanity.types.ts') ? readFileSync('src/sanity.types.ts', 'utf8') : null;
  if (generated.status !== 0 || graderTypes === null)
    generateError = `sanity typegen generate failed (exit ${generated.status}) or wrote no src/sanity.types.ts: ${generated.out.slice(-600)}`;
  const typecheck = run(process.execPath, [bin('typescript', 'tsc'), '--noEmit', '-p', 'tsconfig.json']);
  if (typecheck.status !== 0)
    tscError = `tsc --noEmit failed (exit ${typecheck.status}): ${typecheck.out.slice(0, 800)}`;
  if (!extractError) {
    try {
      schema = JSON.parse(schemaText!) as Obj[];
    } catch {
      extractError = 'the schema.json written by sanity schema extract is not valid JSON';
    }
  }
  const configSource = `(${loadStudioConfig.toString()})((specifier) => import(specifier), import.meta.url, process.argv[2], ${JSON.stringify(BUILTIN)});`;
  if (/__vite_ssr|__vi_/.test(configSource)) throw new Error('config loader source contains a Vitest transform marker');
  writeFileSync('.eval-upgrade-config.mjs', configSource);
  try {
    const nonce = randomBytes(16).toString('hex');
    const result = run(process.execPath, ['.eval-upgrade-config.mjs', '.eval-upgrade-config.json'], nonce);
    const written = existsSync('.eval-upgrade-config.json')
      ? (JSON.parse(readFileSync('.eval-upgrade-config.json', 'utf8')) as Obj)
      : null;
    config =
      written && written.nonce === nonce
        ? written
        : written
          ? {
              status: 'fail',
              reason: 'the result file does not carry the nonce for this run, so the grader did not write it as read',
            }
          : {
              status: 'unknown',
              reason: `the config loader wrote no result (exit ${result.status}): ${result.out.slice(-400)}`,
            };
  } finally {
    rmSync('.eval-upgrade-config.mjs', { force: true });
    rmSync('.eval-upgrade-config.json', { force: true });
  }
  const hit =
    tripwireCheck(since) ||
    [...pins]
      .filter(([file, print]) => !existsSync(file) || fingerprint(file) !== print)
      .map(([file]) => `grading integrity: ${file} changed after the grader wrote it`)[0] ||
    '';
  if (hit) setup = `UNKNOWN (${hit})`;
}, 900_000);

function noSetupProblem() {
  expect(setup, setup).toBe('');
}

/** Source text without comments, so a commented-out line can't satisfy a check. */
function code(file: string): string {
  return sources.has(file)
    ? sources
        .get(file)!
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
    : '';
}

function major(packageName: string): string {
  return versions[packageName] ?? 'missing';
}

function installed(packageName: string): string {
  const path = join('node_modules', packageName, 'package.json');
  return existsSync(path) ? String(JSON.parse(readFileSync(path, 'utf8')).version) : 'missing';
}

function atLeast(version: string, min: [number, number, number]): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const parts: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (parts[0] !== min[0]) return parts[0] > min[0];
  if (parts[1] !== min[1]) return parts[1] > min[1];
  return parts[2] >= min[2];
}

test('Studio v6, Vision v6 and React 19.2.2 or newer are installed', () => {
  noSetupProblem();
  expect(major('sanity'), 'sanity version').toMatch(/^6\./);
  expect(major('@sanity/vision'), '@sanity/vision version').toMatch(/^6\./);
  for (const pkg of ['react', 'react-dom'])
    expect(atLeast(major(pkg), [19, 2, 2]), `${pkg} ${major(pkg)} is not >= 19.2.2`).toBe(true);
});

test('npm run typegen succeeds twice from a clean project and writes what TypeGen generates', () => {
  noSetupProblem();
  typegenRuns.forEach((result, i) =>
    expect(result.status, `npm run typegen (run ${i + 1}) failed: ${result.out.slice(-600)}`).toBe(0),
  );
  expect(scriptTypes, 'npm run typegen did not write src/sanity.types.ts').not.toBeNull();
  expect(generateError, generateError).toBe('');
  expect(
    scriptTypes === graderTypes,
    'the src/sanity.types.ts written by npm run typegen is not byte-for-byte what sanity typegen generate writes (formatting counts)',
  ).toBe(true);
});

test('src/latest.ts uses the generated types', () => {
  noSetupProblem();
  const src = code('src/latest.ts');
  const from = String.raw`from\s*['"]\.\/sanity\.types(?:\.ts|\.js)?['"];?`;
  const named = new RegExp(String.raw`import\s+(?:type\s+)?\{([^}]*)\}\s*` + from).exec(src);
  const namespace = new RegExp(String.raw`import\s+(?:type\s+)?\*\s+as\s+(\w+)\s*` + from).exec(src);
  const match = named ?? namespace;
  expect(match, 'src/latest.ts does not import from ./sanity.types (comments ignored)').not.toBeNull();
  const names = named
    ? named[1]!
        .split(',')
        .map((name) =>
          name
            .replace(/^\s*type\s+/, '')
            .split(/\s+as\s+/)
            .pop()!
            .trim(),
        )
        .filter(Boolean)
    : [`${namespace![1]}.`];
  const rest = src.replace(match![0], '');
  const used = names.filter((name) =>
    name.endsWith('.') ? rest.includes(name) : new RegExp(String.raw`\b${name}\b`).test(rest),
  );
  expect(used, `src/latest.ts imports ${names.join(', ')} from ./sanity.types but never uses it`).not.toEqual([]);
});

test('the project typechecks with the shipped tsconfig', () => {
  noSetupProblem();
  expect(tscError, tscError).toBe('');
});

test('no type errors are suppressed', () => {
  noSetupProblem();
  const suppressed = [...sources.keys()].filter((file) => /@ts-(ignore|expect-error|nocheck)/.test(sources.get(file)!));
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
  const names = (config!.providers as Obj[]).map((provider) => provider?.name).join(', ');
  expect(
    config!.providers,
    `auth.providers was given the built-in providers (google, github, sanity: grader stand-ins) and should return all of them unchanged, then Acme SSO; it returned: ${names}`,
  ).toEqual([...BUILTIN, SSO]);
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
  // @sanity/ui 4 ignores Stack's old `space` prop at runtime (it reads `gap`), so a cast hides lost spacing.
  const stale = [...sources.keys()].filter((file) => /<Stack\b[^>]*\bspace=/.test(code(file)));
  expect(stale, `<Stack space=…> is ignored by @sanity/ui 4 (use gap) in: ${stale.join(', ')}`).toEqual([]);
});

test('the listed schema field types are unchanged', () => {
  noSetupProblem();
  expect(extractError, extractError).toBe('');
  for (const [doc, attrs] of Object.entries(EXPECTED_ATTRS)) {
    const type = schema!.find((schemaType) => schemaType.name === doc && schemaType.type === 'document');
    expect(type, `document type ${doc} is missing`).toBeDefined();
    const own = Object.keys(type!.attributes).filter((key) => !key.startsWith('_'));
    expect(own.sort(), `${doc} fields`).toEqual([...Object.keys(attrs), ...(doc === 'post' ? ['body'] : [])].sort());
    for (const [key, value] of Object.entries(attrs))
      expect(type!.attributes[key].value, `${doc}.${key}`).toMatchObject(value);
  }
  const body = schema!.find((schemaType) => schemaType.name === 'post')!.attributes.body.value;
  const members = body?.of?.type === 'union' ? body.of.of : [body?.of];
  expect(body?.type, 'post.body is not an array').toBe('array');
  expect(
    members.some((member: Obj) => member?.attributes?.children),
    'post.body lost its Portable Text blocks',
  ).toBe(true);
  expect(
    members.some((member: Obj) => member?.attributes?._type?.value?.value === 'image'),
    'post.body lost its images',
  ).toBe(true);
  const ref = schema!.find((schemaType) => schemaType.name === 'author.reference');
  expect(ref?.value?.dereferencesTo, 'post.author must still reference author').toBe('author');
});
