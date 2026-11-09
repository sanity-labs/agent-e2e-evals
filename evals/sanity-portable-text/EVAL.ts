/**
 * Offline grader for sanity-portable-text: two rich text fields on `post` must offer editors exactly the requested
 * options. Loads the schema the Studio uses (sanity.config.ts through jiti, Studio's resolveSchemaTypes and createSchema),
 * reads each field's offered styles, lists, decorators, annotations, inline objects and block objects with the editor's
 * own adapter (createPortableTextMemberSchemaTypes from @portabletext/sanity-bridge), then validates hidden documents in
 * Studio mode for the link scheme and image alt rules. Text block type names are read from the schema, so a named block
 * type works; the prompt names `link`, `href`, `image` and `alt`, and the documents use those names.
 * A message starting "UNKNOWN (" means the grader could not observe the attempt, not that the agent failed.
 * Not graded: Studio appearance, custom components, missing or empty href, whitespace-only alt, other existing fields.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, expect, test } from 'vitest';

type Obj = Record<string, any>;
const span = (text: string, marks: string[] = [], key = 's1') => ({ _key: key, _type: 'span', text, marks });
const text = (key: string, children: Obj[], extra: Obj = {}, markDefs: Obj[] = []) => ({
  _key: key,
  _type: 'block',
  style: 'normal',
  markDefs,
  children,
  ...extra,
});
const ASSET = { _type: 'reference', _ref: 'image-abc123-10x10-png' };
const image = (extra: Obj = { alt: 'A diagram' }) => ({ _key: 'im', _type: 'image', asset: ASSET, ...extra });

const CORPUS = [
  { _id: 'author-ada', _type: 'author', name: 'Ada Lovelace' },
  {
    _id: 'image-abc123-10x10-png',
    _type: 'sanity.imageAsset',
    url: 'https://cdn.invalid/a.png',
    metadata: { dimensions: { width: 10, height: 10 } },
  },
];
const EXCERPT = [text('e1', [span('Bold ', ['strong'], 's1'), span('and italic', ['em'], 's2')])];
const BODY: Obj[] = [
  text('b1', [
    span('Plain, '),
    span('bold, ', ['strong'], 's2'),
    span('italic ', ['em'], 's3'),
    span('code', ['code'], 's4'),
  ]),
  text('b2', [span('A heading')], { style: 'h2' }),
  text('b3', [span('A smaller heading')], { style: 'h3' }),
  text('b4', [span('A bullet')], { listItem: 'bullet', level: 1 }),
  text('b5', [span('A number')], { listItem: 'number', level: 1 }),
  text('b6', [span('Secure', ['l1'])], {}, [{ _key: 'l1', _type: 'link', href: 'https://www.sanity.io/docs' }]),
  text('b7', [span('Mail', ['l2'])], {}, [{ _key: 'l2', _type: 'link', href: 'mailto:hello@example.com' }]),
  image(),
];
const post = (body: Obj[] = BODY, excerpt: Obj[] = EXCERPT) => ({
  _id: 'post-rich',
  _type: 'post',
  title: 'Rich text',
  slug: { _type: 'slug', current: 'rich-text' },
  excerpt,
  body,
});
/** The valid post with the body's https link changed to `href`; nothing else differs from the control. */
const withHref = (href: string) =>
  post(BODY.map((b) => (b._key === 'b6' ? { ...b, markDefs: [{ ...b.markDefs[0], href }] } : b)));

/** Each document must get at least one validation error. */
const RULES: Record<string, Obj[]> = {
  'a body link that uses another scheme than https or mailto is an error': [
    withHref('http://example.com'),
    withHref('javascript:alert(1)'),
    withHref('tel:+4712345678'),
    withHref('/about'),
    withHref('example.com'),
    withHref('http://www.example.com/a/long/path/to/a/page'),
    withHref('https.example.com/docs/getting-started'),
    withHref('http://www.example.com/redirect?to=https://www.sanity.io'),
    withHref('ftp://files.example.com/archive/report.pdf'),
  ],
  'a body image without alt text is an error': [
    post([...BODY.slice(0, -1), image({})]),
    post([...BODY.slice(0, -1), image({ alt: '' })]),
  ],
};
/** Each document must get no errors. */
const CONTROLS: Record<string, Obj[]> = {
  'an excerpt with bold and italic text and a body using every requested option are valid': [
    post(),
    withHref('https://example.org/another/page?q=1'),
  ],
};
/** Exactly what each field offers; `normal` is always added by Sanity. Names are sorted before comparing. */
const EXPECTED: Record<string, Record<string, string[]>> = {
  excerpt: {
    styles: ['normal'],
    lists: [],
    decorators: ['em', 'strong'],
    annotations: [],
    inlineObjects: [],
    blockObjects: [],
  },
  body: {
    styles: ['h2', 'h3', 'normal'],
    lists: ['bullet', 'number'],
    decorators: ['code', 'em', 'strong'],
    annotations: ['link'],
    inlineObjects: [],
    blockObjects: ['image'],
  },
};

// Runs in its own Node process inside the project, so bare imports resolve from its node_modules.
const CHECK_SRC = `import {readFileSync, writeFileSync} from 'node:fs'
import {evaluate, parse} from 'groq-js'
const [inPath, outPath] = process.argv.slice(2)
const done = (o) => { writeFileSync(outPath, JSON.stringify(o)); process.exit(0) }
const {corpus, rules, controls} = JSON.parse(readFileSync(inPath, 'utf8'))
let createJiti, sanity, evaluateDocumentInternal, memberTypes
// Studio-mode validation: the public validateDocument runs in CLI mode, which turns custom object- and document-level
// rules into warnings even when they say .error(); evaluateDocumentInternal is what it calls, with the mode fixed.
try { ;({createJiti} = await import('jiti')); sanity = await import('sanity'); ({evaluateDocumentInternal} = await import('@sanity/validation/_internal')); ({createPortableTextMemberSchemaTypes: memberTypes} = await import('@portabletext/sanity-bridge')) }
catch (e) { done({status: 'unknown', reason: 'the grader could not load jiti, sanity, @sanity/validation or @portabletext/sanity-bridge: ' + e.message}) }
let types
try {
  const mod = await createJiti(import.meta.url, {jsx: true, interopDefault: true}).import('./sanity.config.ts')
  const raw = mod && mod.default !== undefined ? mod.default : mod
  const cfg = Array.isArray(raw) ? raw[0] : raw
  types = sanity.resolveSchemaTypes({config: cfg, context: {projectId: cfg?.projectId, dataset: cfg?.dataset}})
  if (!Array.isArray(types)) done({status: 'fail', reason: 'sanity.config.ts gives no schema types'})
} catch (e) { done({status: 'fail', reason: 'sanity.config.ts could not be loaded: ' + (e && e.message)}) }
let schema
try { schema = sanity.createSchema({name: 'default', types}) }
catch (e) { done({status: 'fail', reason: 'the schema does not compile: ' + e.message}) }
const schemaErrors = (schema._validation ?? []).flatMap((g) => g.problems.filter((p) => p.severity === 'error')
  .map((p) => g.path.map((s) => s.name ?? s.type).filter(Boolean).join('.') + ': ' + p.message))
const missing = []
const offered = {}
const blockNames = {}
const postType = schema.get('post')
const isKind = (t, k) => { for (let x = t; x; x = x.type) if (x.name === k) return true; return false }
const fieldType = (t, name) => t?.fields?.find((f) => f.name === name)?.type
if (!postType) missing.push('document type post')
else if (!isKind(postType, 'document')) missing.push('post as a document type')
for (const field of ['excerpt', 'body']) {
  const t = fieldType(postType, field)
  if (!t) { if (postType) missing.push('post.' + field); continue }
  if (t.jsonType !== 'array' || !(t.of ?? []).some((m) => isKind(m, 'block'))) { missing.push('post.' + field + ' as rich text'); continue }
  try {
    const v = memberTypes(t)
    blockNames[field] = v.block.name
    offered[field] = {styles: v.styles.map((x) => x.value), lists: v.lists.map((x) => x.value),
      decorators: v.decorators.map((x) => x.value), annotations: v.annotations.map((x) => x.name),
      inlineObjects: v.inlineObjects.map((x) => x.name), blockObjects: v.blockObjects.map((x) => x.name)}
    const linkType = v.annotations.find((a) => a.name === 'link')
    if (linkType && !fieldType(linkType, 'href')) missing.push('post.' + field + ' link.href')
    const imageType = v.blockObjects.find((o) => o.name === 'image')
    if (imageType && !fieldType(imageType, 'alt')) missing.push('post.' + field + ' image.alt')
  } catch (e) { missing.push('post.' + field + ' as rich text the editor can read (' + e.message + ')') }
}
if (schemaErrors.length || missing.length) done({status: 'ok', schemaErrors, missing, offered})
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
      (await evaluate(parse(q), {dataset: view(opts.perspective || cfg.perspective), params})).get(),
    getDataUrl: stop('getDataUrl'), request: stop('request'), observable: {fetch: stop('observable.fetch')},
    config: () => ({projectId: 'offline', dataset: 'offline', ...cfg}),
  }
}
// Text blocks take the field's own block type name, so a named block type is graded the same as 'block'.
const named = (doc) => { const d = structuredClone(doc); for (const f of ['excerpt', 'body']) for (const b of d[f] ?? []) if (b._type === 'block') b._type = blockNames[f]; return d }
const check = async (raw) => {
  const doc = named(raw)
  const dataset = [...corpus, doc]
  const r = await evaluateDocumentInternal({document: doc, schema, environment: 'studio',
    getClient: ({apiVersion}) => client(dataset).withConfig({apiVersion}),
    getDocumentExists: async ({id}) => dataset.some((d) => d._id === id)})
  return {complete: r.complete, markers: r.markers.map((m) => ({level: m.level,
    path: m.path.map((p) => (typeof p === 'object' ? p._key : p)).join('.'), message: String(m.message ?? m.item?.message).slice(0, 120)}))}
}
const out = {status: 'ok', schemaErrors, missing, offered, rules: {}, controls: {}, unsupported}
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
  writeFileSync('.eval-pt-input.json', JSON.stringify({ corpus: CORPUS, rules: RULES, controls: CONTROLS }));
  writeFileSync('.eval-pt-check.mjs', CHECK_SRC);
  try {
    const r = run(process.execPath, ['.eval-pt-check.mjs', '.eval-pt-input.json', '.eval-pt-result.json']);
    result = existsSync('.eval-pt-result.json')
      ? (JSON.parse(readFileSync('.eval-pt-result.json', 'utf8')) as Obj)
      : { status: 'unknown', reason: `the rich text check wrote no result (exit ${r.status}): ${r.out.slice(-400)}` };
  } finally {
    for (const f of ['.eval-pt-input.json', '.eval-pt-check.mjs', '.eval-pt-result.json']) rmSync(f, { force: true });
  }
}, 900_000);

const errors = (c: Obj) => (c?.markers ?? []).filter((m: Obj) => m.level === 'error');
const show = (c: Obj) => JSON.stringify(c?.markers ?? c).slice(0, 400);

/** The schema loaded and both fields are rich text the editor can read; otherwise every later test fails with this reason. */
function schemaReady() {
  expect(setup, setup).toBe('');
  if (result.status === 'unknown') expect.fail(`UNKNOWN (${result.reason})`);
  expect(result.status, result.reason).toBe('ok');
  expect(result.schemaErrors, `schema errors: ${result.schemaErrors?.join('; ')}`).toEqual([]);
  expect(result.missing, `the Studio's schema is missing: ${result.missing?.join(', ')}`).toEqual([]);
}
function validated() {
  schemaReady();
  if (result.unsupported?.length)
    expect.fail(
      `UNKNOWN (a validator used client methods the offline grader cannot serve: ${[...new Set(result.unsupported)].join(', ')})`,
    );
}

test('the project typechecks with the shipped tsconfig, and sanity schema extract works', () => {
  expect(setup, setup).toBe('');
  expect(tscError, tscError).toBe('');
  expect(extractError, extractError).toBe('');
});

const OFFERED = Object.entries(EXPECTED).flatMap(([field, sets]) =>
  Object.keys(sets).map((group) => [field, group] as const),
);
test.each(OFFERED)('the %s editor offers exactly the requested %s', (field, group) => {
  schemaReady();
  const got = [...(result.offered?.[field]?.[group] ?? [])].sort();
  expect(got, `${field} offers ${group}: ${JSON.stringify(got)}`).toEqual(EXPECTED[field]![group]);
});

test.each(Object.keys(RULES))('%s', (name) => {
  validated();
  result.rules[name].forEach((c: Obj, i: number) => {
    expect(c.complete, `validation did not complete for document ${i + 1}: ${show(c)}`).toBe(true);
    expect(errors(c).length, `document ${i + 1} gets no error: ${show(c)}`).toBeGreaterThan(0);
  });
});

test.each(Object.keys(CONTROLS))('%s', (name) => {
  validated();
  result.controls[name].forEach((c: Obj, i: number) =>
    expect(c.complete && errors(c).length === 0, `valid document ${i + 1} is rejected: ${show(c)}`).toBe(true),
  );
});
