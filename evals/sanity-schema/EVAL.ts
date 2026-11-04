/**
 * Offline grader for sanity-schema, task version 2 (design: research/schema-task-v2-design.md rev2; v1 is commit 0069140).
 * Loads the schema the Studio actually uses (sanity.config.ts through jiti, as the upgrade grader does), compiles it
 * with Studio's own createSchema, checks the names and kinds of the fields the frontend reads, then validates hidden
 * twin documents with Sanity's own validation in Studio mode, as editors see it. A rule passes when its valid twin has
 * no error and every invalid twin has an error (for the duplicate slug, a warning the valid page does not get also counts).
 * The client given to validation answers GROQ from a local corpus; anything else it is asked for is recorded.
 * A message starting "UNKNOWN (" means the grader could not observe the attempt, not that the agent failed.
 * A pass means content is validated before publishing in this offline check; drafts still save, and the Studio UI is not run.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, expect, test } from 'vitest';

type Obj = Record<string, any>;
const block = (text: string, key = 'b1') => ({
  _key: key,
  _type: 'block',
  style: 'normal',
  markDefs: [],
  children: [{ _key: 's1', _type: 'span', text, marks: [] }],
});
const ref = (id: string, key = 'r1') => ({ _key: key, _type: 'reference', _ref: id });
const IMAGE = { _type: 'image', asset: { _type: 'reference', _ref: 'image-abc123-10x10-png' } };
const EARLY = '2025-12-01T10:00:00.000Z';
const START = '2026-01-01T10:00:00.000Z';
const LATE = '2026-02-01T10:00:00.000Z';

/** Other documents in the dataset: posts, an image, one page per language whose slug a twin reuses, and an unpublished draft. */
const CORPUS = [
  { _id: 'author-ada', _type: 'author', name: 'Ada Lovelace' },
  { _id: 'post-hello', _type: 'post', title: 'Hello world', slug: { _type: 'slug', current: 'hello-world' } },
  { _id: 'post-second', _type: 'post', title: 'Second post', slug: { _type: 'slug', current: 'second-post' } },
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
    language: 'en',
    sections: [{ _key: 'h', _type: 'hero', heading: 'About us' }],
  },
  {
    _id: 'page-om-oss',
    _type: 'page',
    title: 'Om oss',
    slug: { _type: 'slug', current: 'om-oss' },
    language: 'nb',
    sections: [{ _key: 'h', _type: 'hero', heading: 'Om oss' }],
  },
  {
    _id: 'drafts.page-coming-soon',
    _type: 'page',
    title: 'Coming soon',
    slug: { _type: 'slug', current: 'coming-soon' },
    language: 'en',
    sections: [{ _key: 'h', _type: 'hero', heading: 'Coming soon' }],
  },
];
/** A page that meets every rule. Each twin below changes only the part its rule is about. */
const BASE = {
  _id: 'page-landing',
  _type: 'page',
  title: 'Landing',
  slug: { _type: 'slug', current: 'landing' },
  language: 'en',
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
const dated = (key: string, from?: string, until?: string) =>
  page((d) => Object.assign(section(d, key), from ? { visibleFrom: from } : {}, until ? { visibleUntil: until } : {}));

/** One entry per editor rule from the prompt: the valid twin is BASE; every invalid twin breaks only that rule. */
const RULES: Record<string, Obj[]> = {
  'a page needs a title': [page((d) => delete d.title)],
  'a page needs a slug': [page((d) => delete d.slug)],
  'a page needs a language, en or nb': [page((d) => delete d.language), page((d) => (d.language = 'de'))],
  'a slug already used by another page in the same language is flagged': [
    page((d) => (d.slug.current = 'about')),
    page((d) => ((d.language = 'nb'), (d.slug.current = 'om-oss'))),
    page((d) => (d.slug.current = 'coming-soon')),
  ],
  'a page needs sections': [page((d) => delete d.sections), page((d) => (d.sections = []))],
  'a page in the navigation needs a nav label': [page((d) => delete d.navLabel)],
  'a page has at most one hero, and it comes first': [
    page((d) => d.sections.splice(2, 0, { _key: 'h2', _type: 'hero', heading: 'Again' })),
    page((d) => d.sections.push(d.sections.shift())),
  ],
  'a hero needs a heading': [page((d) => delete section(d, 'h').heading)],
  'a hero image needs alt text': [page((d) => delete section(d, 'h').image.alt)],
  'a rich text block needs text': [
    page((d) => delete section(d, 't').body),
    page((d) => (section(d, 't').body = [])),
    page((d) => (section(d, 't').body = [block('')])),
    page((d) => (section(d, 't').body = [block(' \t\n ')])),
  ],
  'a post list needs posts': [page((d) => delete section(d, 'p').posts), page((d) => (section(d, 'p').posts = []))],
  'a post list cannot repeat a post': [
    page((d) => (section(d, 'p').posts = [ref('post-hello', 'r1'), ref('post-hello', 'r2')])),
  ],
  "a block's end must be later than its start": [
    dated('t', START, EARLY),
    dated('h', START, START),
    dated('p', LATE, START),
  ],
};
/** Valid pages that an over-strict schema would reject. */
const CONTROLS: Record<string, Obj[]> = {
  'a page not in the navigation needs no nav label': [
    page((d) => ((d.showInNav = false), delete d.navLabel)),
    page((d) => (delete d.showInNav, delete d.navLabel)),
  ],
  'a hero without an image is fine': [page((d) => delete section(d, 'h').image)],
  // A draft of an already-published page shares its slug with the published copy; that is not a duplicate.
  'a draft of a published page keeps its own slug': [
    page((d) => ((d._id = 'drafts.page-about'), (d.slug.current = 'about'))),
  ],
  'the same slug in another language is fine': [
    page((d) => ((d.language = 'nb'), (d.slug.current = 'about'))),
    page((d) => (d.slug.current = 'om-oss')),
    page((d) => ((d.language = 'nb'), (d.slug.current = 'coming-soon'))),
  ],
  'a page without a hero is fine': [page((d) => d.sections.shift())],
  'a post can be in two lists, and a list can have different posts': [
    page((d) => d.sections.push({ _key: 'p2', _type: 'postList', posts: [ref('post-hello')] })),
    page((d) => (section(d, 'p').posts = [ref('post-hello', 'r1'), ref('post-second', 'r2')])),
  ],
  'a blank paragraph next to text is fine': [
    page((d) => (section(d, 't').body = [block('  ', 'b0'), block('Some words.', 'b1')])),
  ],
  'a block may have one date, or both in order': [
    dated('h', START),
    dated('t', undefined, LATE),
    dated('h', START, LATE),
    dated('t', START, LATE),
    dated('p', START, LATE),
  ],
};
/** Names the frontend reads, with the kind each must be. Scalars match by JSON type; others by the type chain. */
const DATES = { visibleFrom: 'datetime', visibleUntil: 'datetime' };
const SHAPE = {
  page: {
    title: 'string',
    slug: 'slug',
    language: 'string',
    showInNav: 'boolean',
    navLabel: 'string',
    sections: 'array',
  },
  hero: { heading: 'string', image: 'image', ...DATES },
  richText: { body: 'array', ...DATES },
  postList: { posts: 'array', ...DATES },
};

// Runs in its own Node process inside the project, so bare imports resolve from its node_modules.
const CHECK_SRC = `import {readFileSync, writeFileSync} from 'node:fs'
import {evaluate, parse} from 'groq-js'
const [inPath, outPath] = process.argv.slice(2)
const done = (o) => { writeFileSync(outPath, JSON.stringify(o)); process.exit(0) }
const {corpus, base, rules, controls, shape} = JSON.parse(readFileSync(inPath, 'utf8'))
let createJiti, sanity, evaluateDocumentInternal
// Studio-mode validation. The public validateDocument runs in CLI mode, which turns custom object- and document-level
// rules into warnings even when they say .error(); evaluateDocumentInternal is what it calls, with the mode fixed.
try { ;({createJiti} = await import('jiti')); sanity = await import('sanity'); ({evaluateDocumentInternal} = await import('@sanity/validation/_internal')) }
catch (e) { done({status: 'unknown', reason: 'the grader could not load jiti, sanity or @sanity/validation: ' + e.message}) }
let types
try {
  const mod = await createJiti(import.meta.url, {jsx: true, interopDefault: true}).import('./sanity.config.ts')
  const raw = mod && mod.default !== undefined ? mod.default : mod
  const cfg = Array.isArray(raw) ? raw[0] : raw
  // Studio's own resolution: schema.types from the config and from every plugin it uses.
  types = sanity.resolveSchemaTypes({config: cfg, context: {projectId: cfg?.projectId, dataset: cfg?.dataset}})
  if (!Array.isArray(types)) done({status: 'fail', reason: 'sanity.config.ts gives no schema types'})
} catch (e) { done({status: 'fail', reason: 'sanity.config.ts could not be loaded: ' + (e && e.message)}) }
let schema
try { schema = sanity.createSchema({name: 'default', types}) }
catch (e) { done({status: 'fail', reason: 'the schema does not compile: ' + e.message}) }
const schemaErrors = (schema._validation ?? []).flatMap((g) => g.problems.filter((p) => p.severity === 'error')
  .map((p) => g.path.map((s) => s.name ?? s.type).filter(Boolean).join('.') + ': ' + p.message))
const missing = []
const pageType = schema.get('page')
const isKind = (t, k) => { for (let x = t; x; x = x.type) if (x.name === k) return true; return ['string', 'boolean', 'array'].includes(k) && t?.jsonType === k }
const fieldType = (t, name) => t?.fields?.find((f) => f.name === name)?.type
const need = (owner, t, kinds) => { for (const [f, k] of Object.entries(kinds)) { const ft = fieldType(t, f); if (!ft) missing.push(owner + '.' + f); else if (!isKind(ft, k)) missing.push(owner + '.' + f + ' as ' + k) } }
if (!pageType) missing.push('document type page')
else { if (!isKind(pageType, 'document')) missing.push('page as a document type'); need('page', pageType, shape.page) }
const sectionsType = fieldType(pageType, 'sections')
const member = (name) => (sectionsType?.of ?? []).find((t) => t.name === name)
for (const name of ['hero', 'richText', 'postList']) {
  const t = member(name)
  if (!t) { if (pageType) missing.push('sections block ' + name); continue }
  if (!isKind(t, 'object')) missing.push(name + ' as an object')
  need(name, t, shape[name])
}
const image = fieldType(member('hero'), 'image')
if (image && isKind(image, 'image')) { const alt = fieldType(image, 'alt'); if (!alt) missing.push('hero.image.alt'); else if (!isKind(alt, 'string')) missing.push('hero.image.alt as string') }
const body = fieldType(member('richText'), 'body')
if (body && isKind(body, 'array') && !(body.of ?? []).some((m) => isKind(m, 'block'))) missing.push('richText.body as rich text blocks')
const posts = member('postList')?.fields?.find((f) => f.name === 'posts')?.type
if (posts && isKind(posts, 'array') && !(posts.of ?? []).every((m) => isKind(m, 'reference'))) missing.push('postList.posts as references')
const postTargets = (posts?.of ?? []).map((m) => (m.to ? m.to.map((t) => t.name) : [m.name]))
if (schemaErrors.length || missing.length) done({status: 'ok', schemaErrors, missing, postTargets})
const unsupported = []
// Like the pinned Studio's client: perspective starts as raw, withConfig keeps earlier settings, a fetch option overrides.
const client = (dataset, cfg = {apiVersion: '2025-02-19', perspective: 'raw'}) => {
  const stop = (m) => () => { unsupported.push(m); throw new Error('the offline grader does not support client.' + m) }
  const view = (p) => {
    if (p === undefined) p = String(cfg.apiVersion).replace(/^v/, '') >= '2025-02-19' ? 'published' : 'raw'
    if (p === 'raw') return dataset
    if (p === 'published') return dataset.filter((d) => !d._id.startsWith('drafts.') && !d._id.startsWith('versions.'))
    return stop('fetch with perspective ' + JSON.stringify(p))()
  }
  return {
    withConfig: (o = {}) => client(dataset, {...cfg, ...o}),
    fetch: async (q, params = {}, opts = {}) =>
      (await evaluate(parse(q), {dataset: view('perspective' in opts ? opts.perspective : cfg.perspective), params})).get(),
    getDataUrl: stop('getDataUrl'), request: stop('request'), observable: {fetch: stop('observable.fetch')},
    config: () => ({projectId: 'offline', dataset: 'offline', ...cfg}),
  }
}
const check = async (doc) => {
  const dataset = [...corpus, doc]
  const r = await evaluateDocumentInternal({document: doc, schema, environment: 'studio',
    getClient: ({apiVersion}) => client(dataset).withConfig({apiVersion}),
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
const markerKey = (m: Obj) => [m.level, m.code, m.path, m.message].join('|');
/** The prompt allows a warning for a duplicate slug: any warning the valid page does not also get counts. */
const newWarnings = (c: Obj) => {
  const onValid = new Set((result.base?.markers ?? []).map(markerKey));
  return (c?.markers ?? []).filter((m: Obj) => m.level === 'warning' && !onValid.has(markerKey(m))).map(markerKey);
};
const flagged = (c: Obj, slug: boolean) => errors(c).length > 0 || (slug && newWarnings(c).length > 0);
/** A draft gets the duplicate twin's own uniqueness warning: the rule mistook the published copy for a duplicate. */
const DUPLICATE = 'a slug already used by another page in the same language is flagged';
const dupWarning = (c: Obj) => {
  const dup = new Set((result.rules?.[DUPLICATE] ?? []).flatMap(newWarnings));
  return newWarnings(c).some((k: string) => dup.has(k));
};
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

const SLUG_CONTROLS = ['a draft of a published page keeps its own slug', 'the same slug in another language is fine'];
test.each(Object.keys(CONTROLS))('%s', (name) => {
  schemaReady();
  result.controls[name].forEach((c: Obj, i: number) =>
    expect(
      clean(c) && !(SLUG_CONTROLS.includes(name) && dupWarning(c)),
      `valid control ${i + 1} is rejected: ${show(c)}`,
    ).toBe(true),
  );
});
