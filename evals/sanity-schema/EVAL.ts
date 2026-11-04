/**
 * Offline grader for sanity-schema, task version 1 (design: research/schema-task-v1-design.md rev2 plus critic's GO-v2).
 * Loads the schema the Studio actually uses (sanity.config.ts through jiti, as the upgrade grader does), compiles it
 * with Studio's own createSchema, checks the names the frontend reads, then validates hidden twin documents with
 * Sanity's own validateDocument. A rule passes when its valid twin has no error and every invalid twin is flagged.
 * The client given to validation answers GROQ from a local corpus; anything else it is asked for is recorded.
 * A message starting "UNKNOWN (" means the grader could not observe the attempt, not that the agent failed.
 * A pass means content is validated before publishing in this offline check; drafts still save, and the Studio UI is not run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, expect, test } from 'vitest';

type Obj = Record<string, any>;
const block = (text: string) => ({
  _key: 'b1',
  _type: 'block',
  style: 'normal',
  markDefs: [],
  children: [{ _key: 's1', _type: 'span', text, marks: [] }],
});
const ref = (id: string, key = 'r1') => ({ _key: key, _type: 'reference', _ref: id });
const IMAGE = { _type: 'image', asset: { _type: 'reference', _ref: 'image-abc123-10x10-png' } };

/** Other documents in the dataset: referenced post and image, and a page that already has the slug "about". */
const CORPUS = [
  { _id: 'author-ada', _type: 'author', name: 'Ada Lovelace' },
  { _id: 'post-hello', _type: 'post', title: 'Hello world', slug: { _type: 'slug', current: 'hello-world' } },
  {
    _id: 'image-abc123-10x10-png',
    _type: 'sanity.imageAsset',
    url: 'https://cdn.invalid/a.png',
    metadata: { dimensions: { width: 10, height: 10 } },
  },
  {
    _id: 'page-about',
    _type: 'page',
    title: 'About',
    slug: { _type: 'slug', current: 'about' },
    sections: [{ _key: 'h', _type: 'hero', heading: 'About us' }],
  },
];
/** A page that meets every rule. Each twin below changes only the part its rule is about. */
const BASE = {
  _id: 'page-landing',
  _type: 'page',
  title: 'Landing',
  slug: { _type: 'slug', current: 'landing' },
  showInNav: true,
  navLabel: 'Landing',
  sections: [
    { _key: 'h', _type: 'hero', heading: 'Welcome', image: { ...IMAGE, alt: 'A view of the office' } },
    { _key: 't', _type: 'richText', body: [block('Some words.')] },
    { _key: 'p', _type: 'postList', posts: [ref('post-hello')] },
  ],
};
const page = (edit: (d: Obj) => void) => {
  const d = structuredClone(BASE) as Obj;
  edit(d);
  return d;
};
const section = (d: Obj, key: string) => d.sections.find((s: Obj) => s._key === key);

/** One entry per editor rule from the prompt: the valid twin is BASE; every invalid twin breaks only that rule. */
const RULES: Record<string, Obj[]> = {
  'a page needs a title': [page((d) => delete d.title)],
  'a page needs a slug': [page((d) => delete d.slug)],
  'a slug already used by another page is flagged': [page((d) => (d.slug.current = 'about'))],
  'a page needs sections': [page((d) => delete d.sections), page((d) => (d.sections = []))],
  'a page in the navigation needs a nav label': [page((d) => delete d.navLabel)],
  'a hero needs a heading': [page((d) => delete section(d, 'h').heading)],
  'a hero image needs alt text': [page((d) => delete section(d, 'h').image.alt)],
  'a rich text block needs a body': [
    page((d) => delete section(d, 't').body),
    page((d) => (section(d, 't').body = [])),
  ],
  'a post list needs posts': [page((d) => delete section(d, 'p').posts), page((d) => (section(d, 'p').posts = []))],
};
/** Valid pages that an over-strict schema would reject. */
const CONTROLS: Record<string, Obj[]> = {
  'a page not in the navigation needs no nav label': [
    page((d) => ((d.showInNav = false), delete d.navLabel)),
    page((d) => (delete d.showInNav, delete d.navLabel)),
  ],
  'a hero without an image is fine': [page((d) => delete section(d, 'h').image)],
};
const SHAPE = {
  page: ['title', 'slug', 'showInNav', 'navLabel', 'sections'],
  hero: ['heading', 'image'],
  richText: ['body'],
  postList: ['posts'],
};

// Runs in its own Node process inside the project, so bare imports resolve from its node_modules.
const CHECK_SRC = `import {readFileSync, writeFileSync} from 'node:fs'
import {evaluate, parse} from 'groq-js'
const [inPath, outPath] = process.argv.slice(2)
const done = (o) => { writeFileSync(outPath, JSON.stringify(o)); process.exit(0) }
const {corpus, base, rules, controls, shape} = JSON.parse(readFileSync(inPath, 'utf8'))
let createJiti, sanity, validateDocument
// sanity re-exports the older workspace-based validateDocument; @sanity/validation has the {document, schema, client} form.
try { ;({createJiti} = await import('jiti')); sanity = await import('sanity'); ({validateDocument} = await import('@sanity/validation')) }
catch (e) { done({status: 'unknown', reason: 'the grader could not load jiti, sanity or @sanity/validation: ' + e.message}) }
let types
try {
  const mod = await createJiti(import.meta.url, {jsx: true, interopDefault: true}).import('./sanity.config.ts')
  const raw = mod && mod.default !== undefined ? mod.default : mod
  const cfg = Array.isArray(raw) ? raw[0] : raw
  types = typeof cfg?.schema?.types === 'function' ? cfg.schema.types([]) : cfg?.schema?.types
  if (!Array.isArray(types)) done({status: 'fail', reason: 'sanity.config.ts has no schema.types list'})
} catch (e) { done({status: 'fail', reason: 'sanity.config.ts could not be loaded: ' + (e && e.message)}) }
let schema
try { schema = sanity.createSchema({name: 'default', types}) }
catch (e) { done({status: 'fail', reason: 'the schema does not compile: ' + e.message}) }
const schemaErrors = (schema._validation ?? []).flatMap((g) => g.problems.filter((p) => p.severity === 'error')
  .map((p) => g.path.map((s) => s.name ?? s.type).filter(Boolean).join('.') + ': ' + p.message))
const missing = []
const pageType = schema.get('page')
const fieldsOf = (t) => (t?.fields ?? []).map((f) => f.name)
if (!pageType) missing.push('document type page')
for (const f of shape.page) if (pageType && !fieldsOf(pageType).includes(f)) missing.push('page.' + f)
const sectionsType = pageType?.fields?.find((f) => f.name === 'sections')?.type
const member = (name) => (sectionsType?.of ?? []).find((t) => t.name === name)
for (const name of ['hero', 'richText', 'postList']) {
  const t = member(name)
  if (!t) { if (pageType) missing.push('sections block ' + name); continue }
  for (const f of shape[name]) if (!fieldsOf(t).includes(f)) missing.push(name + '.' + f)
}
const image = member('hero')?.fields?.find((f) => f.name === 'image')?.type
if (image && !fieldsOf(image).includes('alt')) missing.push('hero.image.alt')
const posts = member('postList')?.fields?.find((f) => f.name === 'posts')?.type
const postTargets = (posts?.of ?? []).map((m) => (m.to ? m.to.map((t) => t.name) : [m.name]))
if (schemaErrors.length || missing.length) done({status: 'ok', schemaErrors, missing, postTargets})
const unsupported = []
const client = (dataset) => {
  const stop = (m) => () => { unsupported.push(m); throw new Error('the offline grader does not support client.' + m) }
  const c = {
    withConfig: () => c,
    fetch: async (q, params = {}) => (await evaluate(parse(q), {dataset, params})).get(),
    getDataUrl: stop('getDataUrl'), request: stop('request'), observable: {fetch: stop('observable.fetch')},
    config: () => ({projectId: 'offline', dataset: 'offline', apiVersion: '2025-02-19'}),
  }
  return c
}
const check = async (doc) => {
  const dataset = [...corpus, doc]
  const r = await validateDocument({document: doc, schema, client: client(dataset),
    getDocumentExists: async ({id}) => dataset.some((d) => d._id === id)})
  return {complete: r.complete, markers: r.markers.map((m) => ({level: m.level, code: m.code,
    path: m.path.map((p) => (typeof p === 'object' ? p._key : p)).join('.'), message: String(m.message ?? m.item?.message).slice(0, 120)}))}
}
const out = {status: 'ok', schemaErrors, missing, postTargets, base: await check(base), rules: {}, controls: {}, unsupported}
for (const [name, docs] of Object.entries(rules)) { out.rules[name] = []; for (const d of docs) out.rules[name].push(await check(d)) }
for (const [name, docs] of Object.entries(controls)) { out.controls[name] = []; for (const d of docs) out.controls[name].push(await check(d)) }
done(out)
`;

let setup = '';
let tscError = '';
let extractError = '';
let result: Obj = {};

function run(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, SANITY_TELEMETRY_DISABLED: '1', CI: '1' },
  });
  const raw = `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`;
  return {
    status: r.status,
    out: raw
      .replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '')
      .replace(/[ \t]+/g, ' ')
      .trim(),
  };
}

beforeAll(() => {
  if (!existsSync('node_modules/.bin/sanity'))
    setup = 'the Sanity CLI is not installed: the dependencies did not install';
  if (!existsSync('node_modules/.bin/tsc')) setup ||= 'TypeScript is not installed: the dependencies did not install';
  if (setup) return;
  const t = run(resolve('node_modules/.bin/tsc'), ['--noEmit', '-p', 'tsconfig.json']);
  if (t.status !== 0) tscError = `tsc --noEmit failed (exit ${t.status}): ${t.out.slice(0, 800)}`;
  const x = run(resolve('node_modules/.bin/sanity'), [
    'schema',
    'extract',
    '--force',
    '--path',
    '.sanity/eval-schema.json',
  ]);
  if (x.status !== 0) extractError = `sanity schema extract failed (exit ${x.status}): ${x.out.slice(-600)}`;
  writeFileSync(
    '.eval-schema-input.json',
    JSON.stringify({ corpus: CORPUS, base: BASE, rules: RULES, controls: CONTROLS, shape: SHAPE }),
  );
  writeFileSync('.eval-schema-check.mjs', CHECK_SRC);
  try {
    const r = run(process.execPath, ['.eval-schema-check.mjs', '.eval-schema-input.json', '.eval-schema-result.json']);
    result = existsSync('.eval-schema-result.json')
      ? (JSON.parse(readFileSync('.eval-schema-result.json', 'utf8')) as Obj)
      : { status: 'unknown', reason: `the schema check wrote no result (exit ${r.status}): ${r.out.slice(-400)}` };
  } finally {
    for (const f of ['.eval-schema-input.json', '.eval-schema-check.mjs', '.eval-schema-result.json'])
      rmSync(f, { force: true });
  }
}, 900_000);

const errors = (c: Obj) => (c?.markers ?? []).filter((m: Obj) => m.level === 'error');
const flagged = (c: Obj, slug: boolean) =>
  errors(c).length > 0 || (slug && c.markers.some((m: Obj) => m.code === 'slug.not-unique'));
const clean = (c: Obj) =>
  !!c && c.complete && errors(c).length === 0 && !c.markers.some((m: Obj) => m.code === 'slug.not-unique');
const show = (c: Obj) => JSON.stringify(c?.markers ?? c).slice(0, 400);

/** The schema loaded and has the contract's shape; otherwise every validation test fails with this reason. */
function schemaReady() {
  expect(setup, setup).toBe('');
  if (result.status === 'unknown') expect.fail(`UNKNOWN (${result.reason})`);
  expect(result.status, result.reason).toBe('ok');
  expect(result.schemaErrors, `schema errors: ${result.schemaErrors?.join('; ')}`).toEqual([]);
  expect(result.missing, `the Studio's schema is missing: ${result.missing?.join(', ')}`).toEqual([]);
  if (result.unsupported?.length)
    expect.fail(
      `UNKNOWN (a validator used client methods the offline grader cannot serve: ${[...new Set(result.unsupported)].join(', ')})`,
    );
  expect(clean(result.base), `the valid page is rejected: ${show(result.base)}`).toBe(true);
}

test('the project typechecks with the shipped tsconfig, and sanity schema extract works', () => {
  expect(setup, setup).toBe('');
  expect(tscError, tscError).toBe('');
  expect(extractError, extractError).toBe('');
});

test('the Studio uses a page type with the names the frontend reads, and post lists link only to posts', () => {
  schemaReady();
  expect(result.postTargets, `post list targets: ${JSON.stringify(result.postTargets)}`).toEqual([['post']]);
});

test.each(Object.keys(RULES))('%s', (name) => {
  schemaReady();
  result.rules[name].forEach((c: Obj, i: number) => {
    expect(c.complete, `validation did not complete for invalid twin ${i + 1}: ${show(c)}`).toBe(true);
    expect(flagged(c, name.startsWith('a slug')), `invalid twin ${i + 1} is not flagged: ${show(c)}`).toBe(true);
  });
});

test.each(Object.keys(CONTROLS))('%s', (name) => {
  schemaReady();
  result.controls[name].forEach((c: Obj, i: number) =>
    expect(clean(c), `valid control ${i + 1} is rejected: ${show(c)}`).toBe(true),
  );
});
