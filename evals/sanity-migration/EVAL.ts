/**
 * Offline behaviour grader for sanity-migration (contract: research/migration-task-v2.md plus critic's design-v2
 * amendments). The Sanity CLI's own resolver finds the migration; the public dryRun from @sanity/migrate runs it on a
 * hidden export (real documentTypes, filter, system-id and draft rules); applyInCollection from @sanity/mutate applies
 * each batch and rejects writes a server would reject. Each pass runs in a fresh Node process. A message starting
 * "UNKNOWN" means the grader could not observe the attempt, not that the model failed. A pass means "passes the
 * offline fixture contract", not a certified live migration.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
const PASS_SRC = `import {readFileSync, writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import net from 'node:net'
let netAttempts = 0
net.Socket.prototype.connect = function () {
  netAttempts++
  process.nextTick(() => this.destroy(Object.assign(new Error('connect ECONNREFUSED (the grader runs offline)'), {code: 'ECONNREFUSED'})))
  return this
}
const [exportPath, outPath] = process.argv.slice(2)
const done = (o) => {
  if (netAttempts) o = {status: 'unknown', reason: 'the migration read other documents or the API (' + netAttempts + ' connection attempts), which the offline runner cannot serve' + (o.reason ? '; then: ' + o.reason : '')}
  writeFileSync(outPath, JSON.stringify(o)); process.exit(0)
}
let resolveMigrations, dryRun, applyInCollection, Transaction
try {
  ;({resolveMigrations} = await import(pathToFileURL(resolve('node_modules/@sanity/cli/dist/actions/migration/resolveMigrations.js')).href))
  ;({dryRun} = await import('@sanity/migrate'))
  ;({applyInCollection} = await import('@sanity/mutate/_unstable_apply'))
  ;({Transaction} = await import('@sanity/client'))
} catch (e) { done({status: 'unknown', reason: 'the grader could not load the Sanity migration runner: ' + e.message}) }
let found
try { found = await resolveMigrations(process.cwd()) }
catch (e) { done({status: 'fail', reason: e.code === 'ENOENT' ? 'no migrations/ folder' : 'the migration failed to load: ' + e.message}) }
if (found.length !== 1) done({status: 'fail', reason: 'expected exactly one migration the Sanity CLI can load, found ' + found.length + (found.length ? ': ' + found.map((m) => m.id).join(', ') : ' (missing dependency, no default export, or no title/migrate)')})
let docs = readFileSync(exportPath.replace(/\\.tar$/, '.ndjson'), 'utf8').trim().split('\\n').map((l) => JSON.parse(l))
const api = {projectId: 'xg4e0byh', dataset: 'production', apiVersion: 'v2025-02-19', token: 'placeholder-not-a-secret', apiHost: 'http://localhost:65535'}
try {
  for await (const batch of dryRun({api, exportPath}, found[0].migration)) {
    try {
      for (const m of [batch].flat(Infinity).flatMap((m) => (m && m.type === 'transaction' ? m.mutations : [m])))
        if (m && m.document) new Transaction().createOrReplace(m.document)
      docs = applyInCollection(docs, batch)
    }
    catch (e) {
      if (/already exist|nonexistent document|not a valid document ID/i.test(e.message)) done({status: 'fail', reason: 'a write would be rejected: ' + e.message})
      done({status: 'unknown', reason: 'the grader cannot apply this mutation form: ' + e.message})
    }
  }
} catch (e) {
  const text = String(e && e.stack) + ' ' + (e && e.cause && e.cause.code) + ' ' + (e && e.code)
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|snapshot\\.ndjson|fetch failed/.test(text)) done({status: 'unknown', reason: 'the migration read other documents or the API, which the offline runner cannot serve: ' + e.message})
  if (text.includes(resolve('migrations'))) done({status: 'fail', reason: 'the migration threw: ' + e.message})
  done({status: 'unknown', reason: 'the runner failed with no migration code in the stack: ' + e.message})
}
done({status: 'ok', id: found[0].id, docs})
`;

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
const LATE: Doc = { _id: 'h-late', _type: 'post', title: 'Late', author: '  ann LEE', body: PT_BODY };
const HIDDEN: Doc[] = [
  {
    _id: 'h-features',
    _type: 'post',
    title: 'Features',
    slug: { _type: 'slug', current: 'features' },
    author: 'Ann Lee',
    body: '# Getting started\n\nSanity is a **content platform** for *structured* content.\n\n## Install\n\nRead the [docs](https://www.sanity.io/docs) first.\n\n- Create a project\n- Add a schema\n\n1. Run the CLI\n2. Deploy the Studio',
  },
  {
    _id: 'drafts.h-features',
    _type: 'post',
    title: 'Features (draft)',
    author: ' ann lee ',
    body: 'Draft text with a [link](https://example.com/draft).',
  },
  {
    _id: 'h-nested',
    _type: 'post',
    title: 'Nested',
    publishedAt: '2026-03-01T09:00:00Z',
    author: 'ANN LEE',
    body: 'Shopping:\n\n- Fruit\n  - Apple\n- Bread\n\n### Notes\n\nA ***both*** line.',
  },
  {
    _id: 'h-mixed',
    _type: 'post',
    title: 'Mixed',
    author: 'Eve Ng',
    body: 'Use *italics* and a [link with **bold**](https://example.com/a) here.',
  },
  { _id: 'h-pt-body', _type: 'post', title: 'Body done', author: 'Bob Stone', body: PT_BODY },
  {
    _id: 'h-ref-author',
    _type: 'post',
    title: 'Author done',
    author: REF_EXISTING,
    body: 'A plain paragraph.\n\nAnd a second one.',
  },
  { _id: 'h-both-done', _type: 'post', title: 'Both done', author: REF_EXISTING, body: PT_BODY },
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
};
const EXPECTED_AUTHOR: Record<string, string> = {
  'h-features': 'ann lee',
  'drafts.h-features': 'ann lee',
  'h-nested': 'ann lee',
  'h-mixed': 'eve ng',
  'h-pt-body': 'bob stone',
  'h-empty-body': 'dan wu',
  'h-no-body': 'dan wu',
};

const norm = (s: string) => s.trim().toLowerCase();
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const strip = ({ _rev: _r, _updatedAt: _u, _createdAt: _c, ...d }: Doc): Obj => d;
const without = (d: Obj, ...keys: string[]) => Object.fromEntries(Object.entries(d).filter(([k]) => !keys.includes(k)));
const pick = (d: Obj, keys: string[]) => Object.fromEntries(Object.entries(d).filter(([k]) => keys.includes(k)));
const byId = (docs: Doc[]) => new Map(docs.map((d) => [d._id, d]));

let setup = '';
let first: Pass | undefined;
let second: Pass | undefined;
let schema: Obj[] | undefined;
let schemaError = '';
let typeError = '';

function runPass(dir: string, docs: Doc[], n: number): Pass {
  const ndjson = join(dir, `pass${n}.ndjson`);
  writeFileSync(ndjson, docs.map((d) => JSON.stringify(d)).join('\n') + '\n');
  try {
    execFileSync('tar', ['-cf', join(dir, `pass${n}.tar`), '-C', dir, `pass${n}.ndjson`]);
  } catch (err) {
    return { status: 'unknown', reason: `could not write the export tar: ${(err as Error).message}` };
  }
  const out = join(dir, `pass${n}.json`);
  const env = { PATH: process.env.PATH ?? '', HOME: dir };
  const r = spawnSync(process.execPath, ['.eval-migration-pass.mjs', join(dir, `pass${n}.tar`), out], {
    env,
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (!existsSync(out))
    return {
      status: 'unknown',
      reason: `pass ${n} wrote no result (exit ${r.status}, signal ${r.signal}): ${(r.stderr ?? '').slice(-400)}`,
    };
  return JSON.parse(readFileSync(out, 'utf8')) as Pass;
}

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-migration-'));
  const cli = resolve('node_modules/.bin/sanity');
  if (!existsSync(cli)) setup = 'the Sanity CLI is not installed in the project';
  else {
    const r = spawnSync(cli, ['schema', 'extract', '--path', join(dir, 'schema.json')], {
      encoding: 'utf8',
      timeout: 300_000,
    });
    if (r.status === 0) schema = JSON.parse(readFileSync(join(dir, 'schema.json'), 'utf8')) as Obj[];
    else schemaError = `sanity schema extract failed (exit ${r.status}): ${(r.stdout + r.stderr).slice(-600)}`;
  }
  // Typecheck directly with the installed compiler, so an edited build script cannot skip it. tsconfig.json is a protected path.
  const tsc = resolve('node_modules/.bin/tsc');
  if (!existsSync(tsc)) setup ||= 'TypeScript is not installed in the project';
  else {
    const t = spawnSync(tsc, ['--noEmit', '-p', 'tsconfig.json'], { encoding: 'utf8', timeout: 300_000 });
    if (t.status !== 0) typeError = `tsc --noEmit failed (exit ${t.status}): ${(t.stdout + t.stderr).slice(0, 600)}`;
  }
  writeFileSync('.eval-migration-pass.mjs', PASS_SRC);
  try {
    first = runPass(dir, HIDDEN, 1);
    if (first.status === 'ok') second = runPass(dir, [...(first.docs ?? []), LATE], 2);
  } finally {
    rmSync('.eval-migration-pass.mjs', { force: true });
  }
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
  const ws = (s: string) => s.replace(/\s+/g, ' ').trim();
  if (value.length !== expected.length) out.push(`${id}: ${value.length} blocks, expected ${expected.length}`);
  expected.forEach((e, i) => {
    const b = value[i];
    const at = `${id}.body[${i}]`;
    if (!isObj(b) || b._type !== 'block') return out.push(`${at} is not a block`);
    if (
      !Array.isArray(b.children) ||
      !b.children.every((c) => isObj(c) && c._type === 'span' && typeof c.text === 'string')
    )
      return out.push(`${at}.children must all be spans (_type 'span' with string text)`);
    const children = b.children.filter(isObj);
    const markDefs = Array.isArray(b.markDefs) ? b.markDefs.filter(isObj) : [];
    keyProblems(`${at}.children`, children, out);
    keyProblems(`${at}.markDefs`, markDefs, out);
    const text = children.map((c) => (typeof c.text === 'string' ? c.text : '')).join('');
    if (ws(text) !== e.text)
      return out.push(`${at} text ${JSON.stringify(ws(text))}, expected ${JSON.stringify(e.text)}`);
    if ((b.style ?? 'normal') !== (e.style ?? 'normal'))
      out.push(`${at} style ${String(b.style)}, expected ${e.style ?? 'normal'}`);
    if (b.listItem !== e.list) out.push(`${at} listItem ${String(b.listItem)}, expected ${String(e.list)}`);
    else if (e.list && (b.level ?? 1) !== (e.level ?? 1))
      out.push(`${at} level ${String(b.level)}, expected ${e.level ?? 1}`);
    // Compare marks character by character, ignoring whitespace, so span splits and key values don't matter.
    const defs = new Map(markDefs.map((d) => [d._key, d]));
    const chars: Array<Set<string>> = [];
    for (const c of children) {
      const marks = new Set<string>();
      for (const m of Array.isArray(c.marks) ? c.marks : []) {
        const def = defs.get(m);
        if (m === 'strong' || m === 'em') marks.add(m);
        else if (def?._type === 'link') marks.add(`link:${String(def.href)}`);
        else marks.add(def ? String(def._type) : `dangling:${String(m)}`);
      }
      for (const ch of typeof c.text === 'string' ? c.text : '') if (!/\s/.test(ch)) chars.push(marks);
    }
    const compact = e.text.replace(/\s/g, '');
    const want = new Map<string, Set<number>>();
    for (const [phrase, mark] of e.marks ?? []) {
      const start = compact.indexOf(phrase.replace(/\s/g, ''));
      const set = want.get(mark) ?? new Set<number>();
      for (let k = start; k < start + phrase.replace(/\s/g, '').length; k++) set.add(k);
      want.set(mark, set);
    }
    const kinds = new Set([...want.keys(), ...chars.flatMap((s) => [...s])]);
    for (const kind of kinds) {
      const got = chars.flatMap((s, k) => (s.has(kind) ? [k] : []));
      const exp = [...(want.get(kind) ?? [])];
      if (got.join() !== exp.join())
        out.push(
          `${at} mark ${kind} covers ${JSON.stringify(got.map((k) => compact[k]).join(''))}, expected ${JSON.stringify(exp.map((k) => compact[k]).join(''))}`,
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
  const authors = all.filter((d) => d._type === 'author' && d._id !== 'author-existing');
  const names = authors.map((a) => (typeof a.name === 'string' ? norm(a.name) : `(no name on ${a._id})`));
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
    const r = ref as Obj;
    expect(r._type === undefined || r._type === 'reference', `${id}.author has _type ${String(r._type)}`).toBe(true);
    const target = docs.get(String(r._ref));
    expect(target?._type, `${id}.author points to ${String(r._ref)}, which is not an author document`).toBe('author');
    expect(String(r._ref).startsWith('drafts.'), `${id}.author points to a draft id`).toBe(false);
    expect(norm(String(target?.name)), `${id}.author resolves to the wrong person`).toBe(name);
  }
  expect(docs.get('h-ref-author')?.author, 'an existing reference is unchanged').toEqual(REF_EXISTING);
  expect(docs.get('h-both-done')?.author, 'an existing reference is unchanged').toEqual(REF_EXISTING);
  expect(docs.get('h-no-author')?.author, 'a post with no author gets none').toBeUndefined();
});

test('every other document and field is preserved', () => {
  const docs = byId(check(first, 'migration'));
  for (const before of HIDDEN) {
    const after = docs.get(before._id);
    expect(after, `${before._id} was deleted`).toBeDefined();
    const fields = before._type === 'post' ? ['body', 'author'] : [];
    // Posts may gain fields (the contract only says existing ones stay unchanged); other documents must be untouched.
    const kept = before._type === 'post' ? pick(strip(after!), Object.keys(before)) : strip(after!);
    expect(without(kept, ...fields), `${before._id} changed outside body/author`).toEqual(without(before, ...fields));
  }
  const added = [...docs.values()].filter((d) => !HIDDEN.some((h) => h._id === d._id));
  expect(
    added.map((d) => d._type).filter((t) => t !== 'author'),
    'only author documents are added',
  ).toEqual([]);
});

test('running the migration again, in a fresh process on its output plus one new post, changes nothing and reuses the author', () => {
  const once = check(first, 'migration');
  const twice = check(second, 'second run');
  // Which casing an author's stored name keeps is the agent's choice, so names compare normalised.
  const canon = (docs: Doc[]) =>
    docs
      .filter((d) => d._id !== LATE._id)
      .map((d) => {
        const s = strip(d);
        return d._type === 'author' && typeof s.name === 'string' ? { ...s, name: norm(s.name) } : s;
      })
      .toSorted((a, b) => String(a._id).localeCompare(String(b._id)));
  expect(canon(twice)).toEqual(canon(once));
  const ref = (v: unknown) => (isObj(v) ? v._ref : v);
  expect(
    ref(byId(twice).get(LATE._id)?.author),
    'a post added later by Ann Lee points to her existing author document',
  ).toEqual(ref(byId(once).get('h-features')?.author));
});

test('the project typechecks, and the schema has a Portable Text body, an author reference and an author type with a name', () => {
  expect(setup, `UNKNOWN (grader): ${setup}`).toBe('');
  expect(typeError).toBe('');
  expect(schemaError).toBe('');
  const types = new Map((schema ?? []).map((t) => [t.name, t]));
  const deref = (v: unknown): Obj | undefined => {
    if (!isObj(v)) return undefined;
    if (v.type !== 'inline') return v;
    const t = types.get(v.name);
    return isObj(t?.value) ? t.value : undefined;
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
  const isBlock = (m: Obj | undefined) => {
    const t = isObj(m?.attributes) ? m.attributes._type : undefined;
    return isObj(t) && isObj(t.value) && t.value.value === 'block';
  };
  expect(members.some(isBlock), `post.body is ${JSON.stringify(body)?.slice(0, 120)}, not an array of blocks`).toBe(
    true,
  );
  expect(field(post, 'author')?.dereferencesTo, 'post.author is a reference to author').toBe('author');
  const author = types.get('author');
  expect(author?.type, 'author is a document type').toBe('document');
  expect(field(author, 'name')?.type, 'author has a string name field').toBe('string');
});
