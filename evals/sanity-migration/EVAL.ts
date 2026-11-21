/**
 * Offline behaviour grader for sanity-migration. The Sanity CLI's own resolver finds the migration; the public dryRun from @sanity/migrate runs it on a
 * hidden export (real documentTypes, filter, system-id and draft rules); applyInCollection from @sanity/mutate applies
 * each batch and rejects writes a server would reject. Each pass runs in a fresh Node process. A message starting
 * "UNKNOWN" means the grader could not observe the attempt, not that the model failed. A pass means "passes the
 * offline fixture contract", not a certified live migration.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { beforeAll, expect, test } from 'vitest';

type Doc = Record<string, unknown> & { _id: string; _type: string };
type Pass = { status: 'ok' | 'fail' | 'unknown'; reason?: string; docs?: Doc[] };
type Mark = 'strong' | 'em' | `link:${string}`;
type Block = {
  text: string;
  style?: string;
  list?: 'bullet' | 'number';
  level?: number;
  marks?: Array<[string, Mark]>;
};
type Obj = Record<string, unknown>;

// Runs one migration pass in its own process. Written into the project so bare imports resolve from its node_modules.
async function runMigrationPass(load: (specifier: string) => Promise<any>, exportPath: string, outputPath: string) {
  const fileSystem = process.getBuiltinModule('node:fs');
  // Read before any project code loads; stdin is then empty. Capture result-writing primitives for the same reason.
  const nonce = fileSystem.readFileSync(0, 'utf8').trim();
  const write = fileSystem.writeFileSync;
  const stringify = JSON.stringify;
  const kill = process.kill.bind(process);
  const pid = process.pid;
  const path = process.getBuiltinModule('node:path');
  const url = process.getBuiltinModule('node:url');
  const network = process.getBuiltinModule('node:net');
  let networkAttempts = 0;
  network.Socket.prototype.connect = function () {
    networkAttempts++;
    process.nextTick(() =>
      this.destroy(
        Object.assign(new Error('connect ECONNREFUSED (the grader runs offline)'), { code: 'ECONNREFUSED' }),
      ),
    );
    return this;
  };
  const done = (outcome: Record<string, any>) => {
    if (networkAttempts)
      outcome = {
        status: 'unknown',
        reason:
          'the migration read other documents or the API (' +
          networkAttempts +
          ' connection attempts), which the offline runner cannot serve' +
          (outcome.reason ? '; then: ' + outcome.reason : ''),
      };
    write(outputPath, stringify({ ...outcome, nonce }));
    kill(pid, 'SIGKILL');
  };
  let resolveMigrations: any;
  let dryRun: any;
  let applyInCollection: any;
  let Transaction: any;
  try {
    ({ resolveMigrations } = await load(
      url.pathToFileURL(path.resolve('node_modules/@sanity/cli/dist/actions/migration/resolveMigrations.js')).href,
    ));
    ({ dryRun } = await load('@sanity/migrate'));
    ({ applyInCollection } = await load('@sanity/mutate/_unstable_apply'));
    ({ Transaction } = await load('@sanity/client'));
  } catch (error) {
    done({
      status: 'unknown',
      reason: 'the grader could not load the Sanity migration runner: ' + (error as Error).message,
    });
  }
  let found: any;
  try {
    found = await resolveMigrations(process.cwd());
  } catch (error) {
    const loadError = error as NodeJS.ErrnoException;
    done({
      status: 'fail',
      reason:
        loadError.code === 'ENOENT' ? 'no migrations/ folder' : 'the migration failed to load: ' + loadError.message,
    });
  }
  if (found.length !== 1)
    done({
      status: 'fail',
      reason:
        'expected exactly one migration the Sanity CLI can load, found ' +
        found.length +
        (found.length
          ? ': ' + found.map((migration: any) => migration.id).join(', ')
          : ' (missing dependency, no default export, or no title/migrate)'),
    });
  let documents = fileSystem
    .readFileSync(exportPath.replace(/\.tar$/, '.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((line: string) => JSON.parse(line));
  const api = {
    projectId: 'xg4e0byh',
    dataset: 'production',
    apiVersion: 'v2025-02-19',
    token: 'placeholder-not-a-secret',
    apiHost: 'http://localhost:65535',
  };
  try {
    for await (const batch of dryRun({ api, exportPath }, found[0].migration)) {
      try {
        const mutations = [batch]
          .flat(Infinity)
          .flatMap((mutation: any) => (mutation && mutation.type === 'transaction' ? mutation.mutations : [mutation]));
        for (const mutation of mutations)
          if (mutation && mutation.document) new Transaction().createOrReplace(mutation.document);
        documents = applyInCollection(documents, mutations);
      } catch (error) {
        const mutationError = error as Error;
        if (/already exist|nonexistent document|not a valid document ID/i.test(mutationError.message))
          done({ status: 'fail', reason: 'a write would be rejected: ' + mutationError.message });
        done({ status: 'unknown', reason: 'the grader cannot apply this mutation form: ' + mutationError.message });
      }
    }
  } catch (error) {
    const runnerError = error as Error & { cause?: { code?: string }; code?: string };
    const text = String(runnerError.stack) + ' ' + runnerError.cause?.code + ' ' + runnerError.code;
    if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|snapshot\.ndjson|fetch failed/.test(text))
      done({
        status: 'unknown',
        reason:
          'the migration read other documents or the API, which the offline runner cannot serve: ' +
          runnerError.message,
      });
    if (text.includes(path.resolve('migrations')))
      done({ status: 'fail', reason: 'the migration threw: ' + runnerError.message });
    done({
      status: 'unknown',
      reason: 'the runner failed with no migration code in the stack: ' + runnerError.message,
    });
  }
  done({ status: 'ok', id: found[0].id, docs: documents });
}

const FEATURES: Block[] = [
  { text: 'Getting started', style: 'h1' },
  {
    text: 'Sanity is a content platform for structured content.',
    marks: [
      ['content platform', 'strong'],
      ['structured', 'em'],
    ],
  },
  { text: 'Install', style: 'h2' },
  { text: 'Read the docs first.', marks: [['docs', 'link:https://www.sanity.io/docs']] },
  { text: 'Create a project', list: 'bullet' },
  { text: 'Add a schema', list: 'bullet' },
  { text: 'Run the CLI', list: 'number' },
  { text: 'Deploy the Studio', list: 'number' },
];
const NESTED: Block[] = [
  { text: 'Shopping:' },
  { text: 'Fruit', list: 'bullet' },
  { text: 'Apple', list: 'bullet', level: 2 },
  { text: 'Bread', list: 'bullet' },
  { text: 'Notes', style: 'h3' },
  {
    text: 'A both line.',
    marks: [
      ['both', 'strong'],
      ['both', 'em'],
    ],
  },
];
const MIXED: Block[] = [
  {
    text: 'Use italics and a link with bold here.',
    marks: [
      ['italics', 'em'],
      ['link with bold', 'link:https://example.com/a'],
      ['bold', 'strong'],
    ],
  },
];
const DRAFT: Block[] = [{ text: 'Draft text with a link.', marks: [['link', 'link:https://example.com/draft']] }];
const PLAIN: Block[] = [{ text: 'A plain paragraph.' }, { text: 'And a second one.' }];
const PT_BODY = [
  {
    _type: 'block',
    _key: 'k1',
    style: 'normal',
    markDefs: [],
    children: [{ _type: 'span', _key: 's1', text: 'Already Portable Text.', marks: [] }],
  },
];
const REF_EXISTING = { _type: 'reference', _ref: 'author-existing' };
// Added to pass 2's input: a later post naming a known author must reuse that author's document.
const LATE: Doc = {
  _id: 'h-late',
  _type: 'post',
  title: 'Late',
  slug: { _type: 'slug', current: 'late' },
  author: '  ann LEE',
  body: PT_BODY,
  related: ['features'],
};
// Already-converted related items stay exactly as they are.
const REL_EXISTING = { _type: 'reference', _ref: 'h-features', _key: 'r0' };
const REL_DONE = [{ _type: 'reference', _ref: 'h-nested', _key: 'x1' }];
const HIDDEN: Doc[] = [
  {
    _id: 'h-features',
    _type: 'post',
    title: 'Features',
    slug: { _type: 'slug', current: 'features' },
    author: 'Ann Lee',
    related: ['nested', 'body-done'],
    body: '# Getting started\n\nSanity is a **content platform** for *structured* content.\n\n## Install\n\nRead the [docs](https://www.sanity.io/docs) first.\n\n- Create a project\n- Add a schema\n\n1. Run the CLI\n2. Deploy the Studio',
  },
  {
    _id: 'drafts.h-features',
    _type: 'post',
    title: 'Features (draft)',
    slug: { _type: 'slug', current: 'features' },
    author: ' ann lee ',
    related: ['nested'],
    body: 'Draft text with a [link](https://example.com/draft).',
  },
  {
    _id: 'h-nested',
    _type: 'post',
    title: 'Nested',
    slug: { _type: 'slug', current: 'nested' },
    publishedAt: '2026-03-01T09:00:00Z',
    author: 'ANN LEE',
    related: ['features'],
    body: 'Shopping:\n\n- Fruit\n  - Apple\n- Bread\n\n### Notes\n\nA ***both*** line.',
  },
  {
    _id: 'h-mixed',
    _type: 'post',
    title: 'Mixed',
    slug: { _type: 'slug', current: 'mixed' },
    author: 'Eve Ng',
    related: [REL_EXISTING, 'nested'],
    body: 'Use *italics* and a [link with **bold**](https://example.com/a) here.',
  },
  {
    _id: 'h-pt-body',
    _type: 'post',
    title: 'Body done',
    slug: { _type: 'slug', current: 'body-done' },
    author: 'Bob Stone',
    body: PT_BODY,
  },
  {
    _id: 'h-ref-author',
    _type: 'post',
    title: 'Author done',
    author: REF_EXISTING,
    body: 'A plain paragraph.\n\nAnd a second one.',
  },
  { _id: 'h-both-done', _type: 'post', title: 'Both done', author: REF_EXISTING, body: PT_BODY, related: REL_DONE },
  {
    _id: 'versions.rel-spring.h-nested',
    _type: 'post',
    title: 'Nested (spring)',
    slug: { _type: 'slug', current: 'nested' },
    author: 'Eve Ng ',
    body: 'A plain paragraph.\n\nAnd a second one.',
    related: ['mixed', 'features'],
  },
  {
    _id: '_.releases.rel-spring',
    _type: 'system.release',
    name: 'rel-spring',
    state: 'active',
    metadata: { title: 'Spring launch', releaseType: 'asap' },
  },
  { _id: 'h-no-author', _type: 'post', title: 'No author', body: 'A plain paragraph.\n\nAnd a second one.' },
  { _id: 'h-empty-body', _type: 'post', title: 'Empty', author: 'Dan Wu', body: '' },
  { _id: 'h-no-body', _type: 'post', title: 'No body', author: 'dan wu' },
  { _id: 'author-existing', _type: 'author', name: 'Cara Diaz' },
  { _id: 'siteSettings', _type: 'settings', title: 'Settings', body: '# Not a post' },
  { _id: 'page-about', _type: 'page', title: 'About', author: 'Ann Lee', body: 'Pages are *out of scope*.' },
];
const EXPECTED_BODY: Record<string, Block[]> = {
  'h-features': FEATURES,
  'drafts.h-features': DRAFT,
  'h-nested': NESTED,
  'h-mixed': MIXED,
  'h-ref-author': PLAIN,
  'h-no-author': PLAIN,
  'versions.rel-spring.h-nested': PLAIN,
};
const EXPECTED_AUTHOR: Record<string, string> = {
  'h-features': 'ann lee',
  'drafts.h-features': 'ann lee',
  'h-nested': 'ann lee',
  'h-mixed': 'eve ng',
  'h-pt-body': 'bob stone',
  'h-empty-body': 'dan wu',
  'h-no-body': 'dan wu',
  'versions.rel-spring.h-nested': 'eve ng',
};
// Each slug belongs to exactly one published post; links from drafts and release versions point to it too.
const EXPECTED_RELATED: Record<string, string[]> = {
  'h-features': ['h-nested', 'h-pt-body'],
  'drafts.h-features': ['h-nested'],
  'h-nested': ['h-features'],
  'h-mixed': ['h-features', 'h-nested'],
  'h-both-done': ['h-nested'],
  'versions.rel-spring.h-nested': ['h-mixed', 'h-features'],
};

const norm = (value: string) => value.trim().toLowerCase();
const isObj = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const strip = ({
  _rev: _revision,
  _updatedAt: _ignoredUpdatedAt,
  _createdAt: _ignoredCreatedAt,
  ...document
}: Doc): Obj => document;
const without = (document: Obj, ...keys: string[]) =>
  Object.fromEntries(Object.entries(document).filter(([key]) => !keys.includes(key)));
const pick = (document: Obj, keys: string[]) =>
  Object.fromEntries(Object.entries(document).filter(([key]) => keys.includes(key)));
const byId = (docs: Doc[]) => new Map(docs.map((document) => [document._id, document]));

let setup = '';
let first: Pass | undefined;
let second: Pass | undefined;
let schema: Obj[] | undefined;
let schemaError = '';
let typeError = '';

/**
 * Grading-integrity tripwire. Project config, schema code, migrations, and scripts run while grading and must not
 * rewrite files that later checks trust. A ctime at or after the marker catches writes even if contents are restored;
 * grader outputs and tool caches are exempted. Any hit makes the attempt UNKNOWN.
 */
const GRADER_WRITES = /^(node_modules|node_modules\/\.(vite|cache)(\/.*)?)$/;
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

function runPass(dir: string, docs: Doc[], passNumber: number): Pass {
  sweep();
  const ndjson = join(dir, `pass${passNumber}.ndjson`);
  writeFileSync(ndjson, docs.map((document) => JSON.stringify(document)).join('\n') + '\n');
  try {
    execFileSync('tar', ['-cf', join(dir, `pass${passNumber}.tar`), '-C', dir, `pass${passNumber}.ndjson`], {
      env: TOOL_ENV,
    });
  } catch (err) {
    return { status: 'unknown', reason: `could not write the export tar: ${(err as Error).message}` };
  }
  const out = join(dir, `pass${passNumber}.json`);
  const env = { PATH: TOOL_ENV.PATH, HOME: dir, JITI_FS_CACHE: 'false' };
  const nonce = randomBytes(16).toString('hex');
  const result = spawnSync(process.execPath, ['.eval-migration-pass.mjs', join(dir, `pass${passNumber}.tar`), out], {
    env,
    input: nonce,
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (!existsSync(out))
    return {
      status: 'unknown',
      reason: `pass ${passNumber} wrote no result (exit ${result.status}, signal ${result.signal}): ${(result.stderr ?? '').slice(-400)}`,
    };
  const written = JSON.parse(readFileSync(out, 'utf8')) as Pass & { nonce?: string };
  if (written.nonce !== nonce)
    return {
      status: 'fail',
      reason: 'the result file does not carry the nonce for this run, so the grader did not write it as read',
    };
  return written;
}

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-migration-'));
  const since = tripwireStart();
  // Typecheck before schema extraction loads project code, using the installed compiler directly.
  const tsc = bin('typescript', 'tsc');
  if (!existsSync(tsc)) setup ||= 'TypeScript is not installed in the project';
  else {
    const typecheck = spawnSync(process.execPath, [tsc, '--noEmit', '-p', 'tsconfig.json'], {
      encoding: 'utf8',
      timeout: 300_000,
      env: TOOL_ENV,
    });
    if (typecheck.status !== 0)
      typeError = `tsc --noEmit failed (exit ${typecheck.status}): ${(typecheck.stdout + typecheck.stderr).slice(0, 600)}`;
  }
  const cli = bin('sanity', 'sanity');
  if (!existsSync(cli)) setup = 'the Sanity CLI is not installed in the project';
  else {
    const result = spawnSync(process.execPath, [cli, 'schema', 'extract', '--path', join(dir, 'schema.json')], {
      encoding: 'utf8',
      timeout: 300_000,
      env: { ...TOOL_ENV, JITI_FS_CACHE: 'false' },
    });
    if (result.status === 0) schema = JSON.parse(readFileSync(join(dir, 'schema.json'), 'utf8')) as Obj[];
    else
      schemaError = `sanity schema extract failed (exit ${result.status}): ${(result.stdout + result.stderr).slice(-600)}`;
  }
  const passSource = `(${runMigrationPass.toString()})((specifier) => import(specifier), ...process.argv.slice(2));`;
  if (/__vite_ssr|__vi_/.test(passSource)) throw new Error('migration pass source contains a Vitest transform marker');
  writeFileSync('.eval-migration-pass.mjs', passSource);
  try {
    first = runPass(dir, HIDDEN, 1);
    if (first.status === 'ok') second = runPass(dir, [...(first.docs ?? []), LATE], 2);
  } finally {
    rmSync('.eval-migration-pass.mjs', { force: true });
  }
  const hit = tripwireCheck(since);
  if (hit) setup = hit;
}, 900_000);

function check(pass: Pass | undefined, label: string): Doc[] {
  expect(setup, `UNKNOWN (grader): ${setup}`).toBe('');
  const prefix = pass?.status === 'unknown' ? 'UNKNOWN (grader)' : label;
  expect(pass?.status, `${prefix}: ${pass?.reason ?? 'not run'}`).toBe('ok');
  return pass!.docs!;
}

function keyProblems(path: string, arr: unknown[], out: string[]) {
  const seen = new Set<unknown>();
  arr.forEach((item, i) => {
    if (!isObj(item)) return;
    if (typeof item._key !== 'string' || !item._key) out.push(`${path}[${i}] has no _key`);
    else if (seen.has(item._key)) out.push(`${path}[${i}] repeats _key ${item._key}`);
    seen.add(item._key);
  });
}

/** Problems with a converted body: block text, order, style, list kind and level, and exactly which text carries which mark. */
function blockProblems(id: string, value: unknown, expected: Block[]): string[] {
  if (!Array.isArray(value)) return [`${id}: body is ${JSON.stringify(value)?.slice(0, 80)}, not a block array`];
  const out: string[] = [];
  keyProblems(`${id}.body`, value, out);
  const normaliseWhitespace = (text: string) => text.replace(/\s+/g, ' ').trim();
  if (value.length !== expected.length) out.push(`${id}: ${value.length} blocks, expected ${expected.length}`);
  expected.forEach((expectedBlock, i) => {
    const block = value[i];
    const at = `${id}.body[${i}]`;
    if (!isObj(block) || block._type !== 'block') return out.push(`${at} is not a block`);
    if (
      !Array.isArray(block.children) ||
      !block.children.every((child) => isObj(child) && child._type === 'span' && typeof child.text === 'string')
    )
      return out.push(`${at}.children must all be spans (_type 'span' with string text)`);
    const children = block.children.filter(isObj);
    const markDefs = Array.isArray(block.markDefs) ? block.markDefs.filter(isObj) : [];
    keyProblems(`${at}.children`, children, out);
    keyProblems(`${at}.markDefs`, markDefs, out);
    const text = children.map((child) => (typeof child.text === 'string' ? child.text : '')).join('');
    if (normaliseWhitespace(text) !== expectedBlock.text)
      return out.push(
        `${at} text ${JSON.stringify(normaliseWhitespace(text))}, expected ${JSON.stringify(expectedBlock.text)}`,
      );
    if ((block.style ?? 'normal') !== (expectedBlock.style ?? 'normal'))
      out.push(`${at} style ${String(block.style)}, expected ${expectedBlock.style ?? 'normal'}`);
    if (block.listItem !== expectedBlock.list)
      out.push(`${at} listItem ${String(block.listItem)}, expected ${String(expectedBlock.list)}`);
    else if (expectedBlock.list && (block.level ?? 1) !== (expectedBlock.level ?? 1))
      out.push(`${at} level ${String(block.level)}, expected ${expectedBlock.level ?? 1}`);
    // Compare marks character by character, ignoring whitespace, so span splits and key values don't matter.
    const defs = new Map(markDefs.map((definition) => [definition._key, definition]));
    const chars: Array<Set<string>> = [];
    for (const child of children) {
      const marks = new Set<string>();
      for (const mark of Array.isArray(child.marks) ? child.marks : []) {
        const def = defs.get(mark);
        if (mark === 'strong' || mark === 'em') marks.add(mark);
        else if (def?._type === 'link') marks.add(`link:${String(def.href)}`);
        else marks.add(def ? String(def._type) : `dangling:${String(mark)}`);
      }
      for (const character of typeof child.text === 'string' ? child.text : '')
        if (!/\s/.test(character)) chars.push(marks);
    }
    const compact = expectedBlock.text.replace(/\s/g, '');
    const want = new Map<string, Set<number>>();
    for (const [phrase, mark] of expectedBlock.marks ?? []) {
      const start = compact.indexOf(phrase.replace(/\s/g, ''));
      const set = want.get(mark) ?? new Set<number>();
      for (let i = start; i < start + phrase.replace(/\s/g, '').length; i++) set.add(i);
      want.set(mark, set);
    }
    const kinds = new Set([...want.keys(), ...chars.flatMap((marks) => [...marks])]);
    for (const kind of kinds) {
      const got = chars.flatMap((marks, i) => (marks.has(kind) ? [i] : []));
      const exp = [...(want.get(kind) ?? [])];
      if (got.join() !== exp.join())
        out.push(
          `${at} mark ${kind} covers ${JSON.stringify(got.map((index) => compact[index]).join(''))}, expected ${JSON.stringify(exp.map((index) => compact[index]).join(''))}`,
        );
    }
  });
  return out;
}

test('one migration runs offline on the hidden export without a rejected write', () => {
  check(first, 'migration');
});

test('Markdown bodies become Portable Text with the same text, structure and formatting', () => {
  const docs = byId(check(first, 'migration'));
  const problems = Object.entries(EXPECTED_BODY).flatMap(([id, exp]) => blockProblems(id, docs.get(id)?.body, exp));
  expect(problems, problems.join('\n')).toEqual([]);
  expect(docs.get('h-pt-body')?.body, 'an already converted body is unchanged').toEqual(PT_BODY);
  expect(docs.get('h-both-done')?.body, 'an already converted body is unchanged').toEqual(PT_BODY);
  for (const id of ['h-empty-body', 'h-no-body']) {
    const body = docs.get(id)?.body;
    expect(
      body === undefined || (Array.isArray(body) && body.length === 0),
      `${id}.body became ${JSON.stringify(body)}, expected unset or []`,
    ).toBe(true);
  }
});

test('author names become references to one author document per person', () => {
  const all = check(first, 'migration');
  const docs = byId(all);
  const authors = all.filter((document) => document._type === 'author' && document._id !== 'author-existing');
  const names = authors.map((author) =>
    typeof author.name === 'string' ? norm(author.name) : `(no name on ${author._id})`,
  );
  expect(names.toSorted(), 'one author document per normalised name').toEqual([
    'ann lee',
    'bob stone',
    'dan wu',
    'eve ng',
  ]);
  for (const [id, name] of Object.entries(EXPECTED_AUTHOR)) {
    const ref = docs.get(id)?.author;
    expect(isObj(ref) && typeof ref._ref === 'string', `${id}.author is ${JSON.stringify(ref)}, not a reference`).toBe(
      true,
    );
    const reference = ref as Obj;
    expect(
      reference._type === undefined || reference._type === 'reference',
      `${id}.author has _type ${String(reference._type)}`,
    ).toBe(true);
    const target = docs.get(String(reference._ref));
    expect(target?._type, `${id}.author points to ${String(reference._ref)}, which is not an author document`).toBe(
      'author',
    );
    expect(/^(drafts|versions)\./.test(String(reference._ref)), `${id}.author points to a draft or version id`).toBe(
      false,
    );
    expect(norm(String(target?.name)), `${id}.author resolves to the wrong person`).toBe(name);
  }
  expect(docs.get('h-ref-author')?.author, 'an existing reference is unchanged').toEqual(REF_EXISTING);
  expect(docs.get('h-both-done')?.author, 'an existing reference is unchanged').toEqual(REF_EXISTING);
  expect(docs.get('h-no-author')?.author, 'a post with no author gets none').toBeUndefined();
});

test('related slugs become references to the published posts, in order, with keys', () => {
  const docs = byId(check(first, 'migration'));
  const problems: string[] = [];
  for (const [id, expected] of Object.entries(EXPECTED_RELATED)) {
    const rel = docs.get(id)?.related;
    if (!Array.isArray(rel)) {
      problems.push(`${id}.related is ${JSON.stringify(rel)?.slice(0, 80)}, not an array`);
      continue;
    }
    keyProblems(`${id}.related`, rel, problems);
    const got = rel.map((reference) =>
      isObj(reference) && reference._type === 'reference' && typeof reference._ref === 'string'
        ? reference._ref
        : `(not a reference: ${JSON.stringify(reference)?.slice(0, 60)})`,
    );
    if (JSON.stringify(got) !== JSON.stringify(expected))
      problems.push(`${id}.related points to ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
  }
  expect(problems, problems.join('\n')).toEqual([]);
  expect(
    (docs.get('h-mixed')?.related as unknown[] | undefined)?.[0],
    'an existing related reference is unchanged',
  ).toEqual(REL_EXISTING);
  expect(docs.get('h-both-done')?.related, 'existing related references are unchanged').toEqual(REL_DONE);
  for (const before of HIDDEN.filter((document) => document._type === 'post' && !('related' in document))) {
    const rel = docs.get(before._id)?.related;
    expect(
      rel === undefined || (Array.isArray(rel) && rel.length === 0),
      `${before._id}.related became ${JSON.stringify(rel)}, expected unset or []`,
    ).toBe(true);
  }
});

test('every other document and field is preserved', () => {
  const docs = byId(check(first, 'migration'));
  for (const before of HIDDEN) {
    const after = docs.get(before._id);
    expect(after, `${before._id} was deleted`).toBeDefined();
    const fields = before._type === 'post' ? ['body', 'author', 'related'] : [];
    // Posts may gain fields (the contract only says existing ones stay unchanged); other documents must be untouched.
    const kept = before._type === 'post' ? pick(strip(after!), Object.keys(before)) : strip(after!);
    expect(without(kept, ...fields), `${before._id} changed outside body/author/related`).toEqual(
      without(before, ...fields),
    );
  }
  const added = [...docs.values()].filter((document) => !HIDDEN.some((hidden) => hidden._id === document._id));
  expect(
    added.map((document) => document._type).filter((type) => type !== 'author'),
    'only author documents are added',
  ).toEqual([]);
});

test('running the migration again, in a fresh process on its output plus one new post, changes nothing and reuses the author', () => {
  const once = check(first, 'migration');
  const twice = check(second, 'second run');
  // Which casing an author's stored name keeps is the agent's choice, so names compare normalised.
  const canon = (docs: Doc[]) =>
    docs
      .filter((document) => document._id !== LATE._id)
      .map((document) => {
        const stripped = strip(document);
        return document._type === 'author' && typeof stripped.name === 'string'
          ? { ...stripped, name: norm(stripped.name) }
          : stripped;
      })
      .toSorted((left, right) => String(left._id).localeCompare(String(right._id)));
  expect(canon(twice)).toEqual(canon(once));
  const ref = (value: unknown) => (isObj(value) ? value._ref : value);
  expect(
    ref(byId(twice).get(LATE._id)?.author),
    'a post added later by Ann Lee points to her existing author document',
  ).toEqual(ref(byId(once).get('h-features')?.author));
  const late = byId(twice).get(LATE._id)?.related;
  expect(Array.isArray(late) ? late.map(ref) : late, 'a post added later links to the published Features post').toEqual(
    ['h-features'],
  );
});

test('the project typechecks, and the schema has a Portable Text body, an author reference, related post references and an author type with a name', () => {
  expect(setup, `UNKNOWN (grader): ${setup}`).toBe('');
  expect(typeError).toBe('');
  expect(schemaError).toBe('');
  const types = new Map((schema ?? []).map((type) => [type.name, type]));
  const deref = (value: unknown): Obj | undefined => {
    if (!isObj(value)) return undefined;
    if (value.type !== 'inline') return value;
    const type = types.get(value.name);
    return isObj(type?.value) ? type.value : undefined;
  };
  const field = (doc: unknown, name: string) => {
    const attrs = isObj(doc) && isObj(doc.attributes) ? doc.attributes : {};
    const attr = attrs[name];
    return deref(isObj(attr) ? attr.value : undefined);
  };
  const post = types.get('post');
  expect(post?.type, 'post is a document type').toBe('document');
  const body = field(post, 'body');
  const of = body?.type === 'array' ? deref(body.of) : undefined;
  const members = of?.type === 'union' && Array.isArray(of.of) ? of.of.map(deref) : [of];
  const isBlock = (member: Obj | undefined) => {
    const type = isObj(member?.attributes) ? member.attributes._type : undefined;
    return isObj(type) && isObj(type.value) && type.value.value === 'block';
  };
  expect(members.some(isBlock), `post.body is ${JSON.stringify(body)?.slice(0, 120)}, not an array of blocks`).toBe(
    true,
  );
  expect(field(post, 'author')?.dereferencesTo, 'post.author is a reference to author').toBe('author');
  const related = field(post, 'related');
  const relOf = related?.type === 'array' ? deref(related.of) : undefined;
  const relMembers = relOf?.type === 'union' && Array.isArray(relOf.of) ? relOf.of.map(deref) : [relOf];
  expect(
    // Array members are keyed objects whose `rest` names the reference type (e.g. post.reference).
    relMembers.some((member) => member?.dereferencesTo === 'post' || deref(member?.rest)?.dereferencesTo === 'post'),
    `post.related is ${JSON.stringify(related)?.slice(0, 120)}, not an array of references to post`,
  ).toBe(true);
  const author = types.get('author');
  expect(author?.type, 'author is a document type').toBe('document');
  expect(field(author, 'name')?.type, 'author has a string name field').toBe('string');
});
