/**
 * Offline grader for sanity-singletons: three fixed documents in an existing Studio. Loads sanity.config.ts through
 * jiti, resolves every workspace offline with createSourceFromConfig (a fake signed-in user, a client pointed at a
 * closed local port), walks every structure tool's sidebar the way the Studio does (child resolvers included), then
 * asks the Studio's own resolvers: new-document options in the global menu, in every reached list (menu create items
 * included) and in every reached document pane; document actions; and the initial value of each fixed campaign pane,
 * resolved with the template that pane would pick (its own template, otherwise the type's only template). Lists are
 * checked with groq-js against hidden sample documents using each list's own filter and params, and a row counts only
 * if opening it opens that document. A config or sidebar that queries the dataset, or a custom action on site settings
 * the grader cannot identify, ends as UNKNOWN.
 * Any method passes: the built-in singletons API or a hand-built setup. A message starting "UNKNOWN (" means the
 * grader could not observe the attempt, not that the agent failed.
 * Not graded: rendering, titles, ordering, delete, and documents opened from a list rather than a fixed sidebar item.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, expect, test } from 'vitest';

type Obj = Record<string, any>;
/** The fixed documents are absent, as on first open. Each type has a document the agent has never seen. */
const DATASET = [
  { _id: 'author-ada', _type: 'author', name: 'Ada Lovelace' },
  { _id: 'author-grace', _type: 'author', name: 'Grace Hopper' },
  { _id: 'post-hello', _type: 'post', title: 'Hello world', author: { _type: 'reference', _ref: 'author-ada' } },
  { _id: 'post-launch', _type: 'post', title: 'Launch notes' },
  { _id: 'page-about', _type: 'page', title: 'About us' },
  { _id: 'page-contact', _type: 'page', title: 'Contact' },
  { _id: 'campaign-black-friday', _type: 'campaign', title: 'Black Friday', season: 'autumn' },
  { _id: 'campaign-flash-sale', _type: 'campaign', title: 'Flash sale' },
];
const FIXED = [
  { id: 'siteSettings', type: 'siteSettings' },
  { id: 'springCampaign', type: 'campaign', season: 'spring' },
  { id: 'summerCampaign', type: 'campaign', season: 'summer' },
];
const ORDINARY = ['campaign', 'post', 'author', 'page'];

// Runs in its own Node process inside the project, so bare imports resolve from its node_modules.
const CHECK_SRC = `import {readFileSync, writeFileSync} from 'node:fs'
const [inPath, outPath] = process.argv.slice(2)
const done = (o) => { writeFileSync(outPath, JSON.stringify(o)); process.exit(0) }
const {dataset} = JSON.parse(readFileSync(inPath, 'utf8'))
let createJiti, sanity, structure, createClient, groq
try {
  ;({createJiti} = await import('jiti')); sanity = await import('sanity'); structure = await import('sanity/structure')
  ;({createClient} = await import('@sanity/client')); groq = await import('groq-js')
  // Initial value resolution needs a window; set it after loading sanity, which expects a full DOM if one exists at import.
  const {JSDOM} = await import('jsdom'); globalThis.window = new JSDOM('').window
} catch (e) { done({status: 'unknown', reason: 'the grader could not load jsdom, jiti, sanity or groq-js: ' + e.message}) }
const why = (e) => [e && e.message, ...((e && e.causes) || []).map((c) => c && c.message)].filter(Boolean).join('; ').slice(0, 600)
let cfgs
try {
  const mod = await createJiti(import.meta.url, {jsx: true, interopDefault: true}).import('./sanity.config.ts')
  const raw = mod && mod.default !== undefined ? mod.default : mod
  cfgs = Array.isArray(raw) ? raw : [raw]
} catch (e) { done({status: 'fail', reason: 'sanity.config.ts could not be loaded: ' + why(e)}) }
const currentUser = {id: 'u1', name: 'Eval', email: 'eval@example.invalid', role: 'administrator', roles: [{name: 'administrator', title: 'Administrator'}]}
const client = createClient({projectId: 'offline', dataset: 'production', apiVersion: '2025-01-01', useCdn: false, apiHost: 'http://127.0.0.1:65535'})
// Any dataset request means the sidebar or config depends on data, which this empty offline dataset cannot represent.
let queried = ''
const watch = (c) => new Proxy(c, {get(t, k) {
  const v = Reflect.get(t, k)
  if (k === 'withConfig' || k === 'clone') return (...a) => watch(v.apply(t, a))
  if (k === 'observable') return watch(v)
  if (k === 'config') return (...a) => { const r = v.apply(t, a); return r === t ? watch(t) : r }
  if (typeof v === 'function' && /^(fetch|listen|getDocuments?)$/.test(String(k))) return (...a) => { queried ||= String(k); return v.apply(t, a) }
  return typeof v === 'function' ? v.bind(t) : v
}})
const getClient = ({apiVersion}) => watch(client.withConfig({apiVersion}))
const offline = (e) => /ECONNREFUSED|fetch failed|127\\.0\\.0\\.1:65535/.test(why(e))
let source, S
const nodes = [], allGlobal = [], allActions = []
let truncated = false, builtIn = false, toolCount = 0
for (const [wi, cfg] of cfgs.entries()) {
try {
  source = await sanity.createSourceFromConfig({basePath: '/', ...cfg, currentUser, getClient})
} catch (e) { done({status: offline(e) ? 'unknown' : 'fail', reason: (offline(e) ? 'the config reads the dataset while loading, which the offline grader cannot serve: ' : 'the Studio config does not resolve: ') + why(e)}) }
// Every structure tool, renamed or not, shares the native component (one object at the pinned version).
const structureComponent = structure.structureTool().tools[0].component
const tools = source.tools.filter((t) => t.component === structureComponent)
const hasSettings = !!source.schema.get('siteSettings')
if (!tools.length && hasSettings) done({status: 'fail', reason: 'a workspace with site settings has no structure tool, so editors have no sidebar'})
toolCount += tools.length
// Template ids are local to a workspace, so each id is resolved to its type in the workspace that offers it.
const typed = (ids) => ids.map((id) => ({id, type: id === '?' ? '?' : source.templates.find((t) => t.id === id)?.schemaType || id}))
const firstNode = nodes.length
builtIn ||= (source.document.singletons || []).length > 0
const settle = async (v) => { v = await v; if (v && typeof v.subscribe === 'function') v = await new Promise((res, rej) => v.subscribe({next: res, error: rej})); return v }
async function walk(value, id, parent, index, path, depth) {
  if (depth > 8 || nodes.length > 400) { truncated = true; return }
  if (typeof value === 'function') value = await value(id, {parent, index, splitIndex: 0, path, params: {}, structureContext: S.context})
  value = await settle(value)
  value = value && value.serialize ? value.serialize({path}) : value
  if (!value || typeof value !== 'object') return
  const node = {path: path.join('/'), type: value.type, schemaTypeName: value.schemaTypeName, options: value.options,
    create: [...(value.initialValueTemplates || []).map((t) => t.templateId), ...(value.menuItems || []).filter((m) => m.intent && m.intent.type === 'create').map((m) => { const p = Array.isArray(m.intent.params) ? m.intent.params[0] : m.intent.params; return (p && (p.template || p.type)) || '?' })]}
  nodes.push(node)
  if (value.type === 'document') {
    const o = value.options || {}
    node.create = source.document.resolveNewDocumentOptions({type: 'document', schemaType: o.type, documentId: o.id}).map((t) => t.templateId)
    const typeTemplates = source.templates.filter((t) => t.schemaType === o.type)
    const templateId = o.template || (typeTemplates.length === 1 ? typeTemplates[0].id : undefined)
    const template = source.templates.find((t) => t.id === templateId)
    node.template = templateId ?? null
    try { node.initial = template ? await sanity.resolveInitialValue(source.schema, template, o.templateParameters || {}, S.context) : null }
    catch (e) { node.initialError = why(e) }
  }
  if (value.type === 'documentList') {
    const result = await groq.evaluate(groq.parse('*[' + (value.options?.filter || 'false') + ']'), {dataset, params: value.options?.params || {}})
    node.listed = (await result.get()).map((d) => d._id)
    if (value.child) {
      node.rowOpens = []
      for (const id of node.listed) {
        try {
          // A list's child is a resolver called with the row id, or one fixed builder for every row.
          let c = await settle(typeof value.child === 'function' ? await value.child(id, {parent: value, index: 0, splitIndex: 0, path: [...path, id], params: {}, structureContext: S.context}) : value.child)
          c = c && c.serialize ? c.serialize({path: [...path, id]}) : c
          node.rowOpens.push([id, c && c.options ? c.options.id : null])
        } catch (e) { node.rowOpens.push([id, 'error: ' + why(e)]) }
      }
    }
  }
  for (const [i, item] of (value.items || []).entries()) if (item && item.child) await walk(item.child, item.id, value, i, [...path, item.id], depth + 1)
}
try {
  for (const tool of tools) {
    S = structure.createStructureBuilder({source, defaultDocumentNode: tool.options?.defaultDocumentNode})
    const root = tool.options?.structure ? await settle(tool.options.structure(S, S.context)) : S.defaults()
    await walk(root, 'root', null, 0, [cfg.name || String(wi), tool.name], 0)
  }
} catch (e) { done({status: offline(e) ? 'unknown' : 'fail', reason: (offline(e) ? 'the sidebar reads the dataset, which the offline grader cannot serve: ' : 'the sidebar could not be resolved: ') + why(e)}) }
// A partial walk has not seen every create surface, so it cannot pass.
for (const n of nodes.slice(firstNode)) { n.create = typed(n.create); n.settingsRules = hasSettings }
allGlobal.push(...typed(source.document.resolveNewDocumentOptions({type: 'global'}).map((t) => t.templateId)).map((t) => ({...t, settingsRules: hasSettings})))
// 4. actions: built-ins are named; anything else this config adds or wraps is unidentified
if (hasSettings) {
const plain = await sanity.createSourceFromConfig({basePath: '/', ...cfg, document: {...(cfg.document || {}), actions: undefined}, currentUser, getClient})
const builtin = plain.document.actions({schemaType: 'siteSettings', documentId: 'siteSettings'})
allActions.push(...source.document.actions({schemaType: 'siteSettings', documentId: 'siteSettings'}).map((a) => a.action || (builtin.includes(a) ? a.name : 'unidentified:' + (a.name || 'anonymous'))))
}
}
if (!toolCount) done({status: 'fail', reason: 'the Studio has no structure tool, so editors have no sidebar'})
if (truncated) done({status: 'unknown', reason: 'the sidebar is deeper than 8 levels or has more than 400 panes, which the grader does not walk'})
if (queried) done({status: 'unknown', reason: 'the config or sidebar queries the dataset (client.' + queried + '), so it can change once documents exist, which the offline grader cannot serve'})
const global = allGlobal
const settingsCreate = [{where: 'the global create menu', ids: global.filter((t) => t.settingsRules)}, ...nodes.filter((n) => n.settingsRules).map((n) => ({where: n.type + ' ' + n.path, ids: n.create}))]
  .filter((c) => c.ids.some((t) => t.type === 'siteSettings' || t.type === '?')).map((c) => c.where)
const actions = allActions
done({status: 'ok', builtIn, global,
  settingsCreate, actions, nodes})
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
  writeFileSync('.eval-sg-input.json', JSON.stringify({ dataset: DATASET }));
  writeFileSync('.eval-sg-check.mjs', CHECK_SRC);
  try {
    const r = run(process.execPath, ['.eval-sg-check.mjs', '.eval-sg-input.json', '.eval-sg-result.json']);
    result = existsSync('.eval-sg-result.json')
      ? (JSON.parse(readFileSync('.eval-sg-result.json', 'utf8')) as Obj)
      : { status: 'unknown', reason: `the Studio check wrote no result (exit ${r.status}): ${r.out.slice(-400)}` };
  } finally {
    for (const f of ['.eval-sg-input.json', '.eval-sg-check.mjs', '.eval-sg-result.json']) rmSync(f, { force: true });
  }
}, 900_000);

/** The Studio resolved and its sidebar was walked; otherwise every later test fails with this reason. */
function resolved() {
  expect(setup, setup).toBe('');
  if (result.status === 'unknown') expect.fail(`UNKNOWN (${result.reason})`);
  expect(result.status, result.reason).toBe('ok');
}
const nodes = (): Obj[] => result.nodes ?? [];
const pane = (id: string) => nodes().find((n) => n.type === 'document' && n.options?.id === id);
const lists = () =>
  nodes()
    .filter((n) => n.type === 'documentList')
    .map((n) => `${n.path}: ${JSON.stringify(n.listed)}`);

test('the project typechecks with the shipped tsconfig, and sanity schema extract works', () => {
  expect(setup, setup).toBe('');
  expect(tscError, tscError).toBe('');
  expect(extractError, extractError).toBe('');
});

test.each(FIXED)('the sidebar opens the $id document as a $type', ({ id, type }) => {
  resolved();
  const p = pane(id);
  expect(p, `no sidebar item opens a document pane for ${id}`).toBeTruthy();
  expect(p!.options?.type, `the ${id} pane has type ${p!.options?.type}`).toBe(type);
});

test('editors are not offered a new site settings document anywhere', () => {
  resolved();
  expect(result.settingsCreate, `site settings can be created from: ${result.settingsCreate?.join(', ')}`).toEqual([]);
});

test('the site settings document cannot be duplicated', () => {
  resolved();
  expect(result.actions, `actions on siteSettings: ${result.actions?.join(', ')}`).not.toContain('duplicate');
  const odd = (result.actions ?? []).filter((a: string) => a.startsWith('unidentified:'));
  if (odd.length) expect.fail(`UNKNOWN (custom actions on siteSettings the grader cannot identify: ${odd.join(', ')})`);
});

test.each(FIXED.filter((f) => f.season))('the $id document starts with season $season', ({ id, season }) => {
  resolved();
  const p = pane(id);
  expect(p, `no sidebar item opens a document pane for ${id}`).toBeTruthy();
  const got = `template ${p!.template}, initial value ${JSON.stringify(p!.initial)}${p!.initialError ? `, error ${p!.initialError}` : ''}`;
  expect(p!.initial?.season, `the ${id} pane starts with ${got}`).toBe(season);
});

test.each(ORDINARY)('editors can still create %s documents and browse every existing one', (type) => {
  resolved();
  const creatable = (result.global ?? []).filter((t: Obj) => t.type === type);
  expect(
    creatable.length,
    `the global create menu offers no ${type}: ${JSON.stringify(result.global)}`,
  ).toBeGreaterThan(0);
  const want = DATASET.filter((d) => d._type === type).map((d) => d._id);
  // Editors may split a type over several lists, so the reached lists together must show every document.
  // A listed row counts only if clicking it opens that same document.
  const opens = (n: Obj, id: string) =>
    !n.rowOpens || n.rowOpens.some(([r, got]: [string, string]) => r === id && got === id);
  const shown = new Set(
    nodes().flatMap((n) => (n.type === 'documentList' ? (n.listed ?? []).filter((id: string) => opens(n, id)) : [])),
  );
  const missing = want.filter((id) => !shown.has(id));
  expect(missing, `no sidebar list shows ${missing.join(', ')}; lists reached: ${lists().join(' | ')}`).toEqual([]);
});
