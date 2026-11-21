/**
 * Offline grader for sanity-schema.
 * Loads the schema the Studio actually uses (sanity.config.ts through jiti, as the upgrade grader does), compiles it
 * with Studio's own createSchema, checks the names and kinds of the fields the frontend reads, then validates hidden
 * twin documents with Sanity's own validation in Studio mode, as editors see it. A rule passes when its valid twin has
 * no error and every invalid twin has an error (for the duplicate slug, a warning the valid page does not get also counts).
 * The client given to validation answers GROQ from a local corpus; anything else it is asked for is recorded.
 * A message starting "UNKNOWN (" means the grader could not observe the attempt, not that the agent failed.
 * A pass means content is validated before publishing in this offline check; drafts still save, and the Studio UI is not run.
 */
type DynamicValue = any;
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
const page = (edit: (document: Obj) => void) => {
  const document = structuredClone(BASE) as Obj;
  edit(document);
  return document;
};
const section = (document: Obj, key: string) => document.sections.find((schemaEntry: Obj) => schemaEntry._key === key);
const dated = (key: string, from?: string, until?: string) =>
  page((document) =>
    Object.assign(section(document, key), from ? { visibleFrom: from } : {}, until ? { visibleUntil: until } : {}),
  );
/** One entry per editor rule from the prompt: the valid twin is BASE; every invalid twin breaks only that rule. */
const RULES: Record<string, Obj[]> = {
  'a page needs a title': [page((document) => delete document.title)],
  'a page needs a slug': [page((document) => delete document.slug)],
  'a page needs a language, en or nb': [
    page((document) => delete document.language),
    page((document) => (document.language = 'de')),
    page((document) => (document.language = 'EN')),
    page((document) => (document.language = 'en-GB')),
  ],
  'a slug already used by another page in the same language is flagged': [
    page((document) => (document.slug.current = 'about')),
    page((document) => ((document.language = 'nb'), (document.slug.current = 'om-oss'))),
    page((document) => (document.slug.current = 'coming-soon')),
  ],
  'a page needs sections': [page((document) => delete document.sections), page((document) => (document.sections = []))],
  'a page in the navigation needs a nav label': [page((document) => delete document.navLabel)],
  'a page has at most one hero, and it comes first': [
    page((document) => document.sections.splice(2, 0, { _key: 'h2', _type: 'hero', heading: 'Again' })),
    page((document) => document.sections.push(document.sections.shift())),
  ],
  'a hero needs a heading': [page((document) => delete section(document, 'h').heading)],
  'a hero image needs alt text': [page((document) => delete section(document, 'h').image.alt)],
  'a rich text block needs text': [
    page((document) => delete section(document, 't').body),
    page((document) => (section(document, 't').body = [])),
    page((document) => (section(document, 't').body = [block('')])),
    page((document) => (section(document, 't').body = [block(' \t\n ')])),
  ],
  'a post list needs posts': [
    page((document) => delete section(document, 'p').posts),
    page((document) => (section(document, 'p').posts = [])),
  ],
  'a post list cannot repeat a post': [
    page((document) => (section(document, 'p').posts = [ref('post-hello', 'r1'), ref('post-hello', 'r2')])),
    page(
      (document) =>
        (section(document, 'p').posts = [ref('post-hello', 'r1'), ref('post-second', 'r2'), ref('post-hello', 'r3')]),
    ),
  ],
  "a block's end must be later than its start": [
    dated('t', START, EARLY),
    // The same instant written with an offset: equal in time, but later as text.
    dated('h', START, '2026-01-01T11:00:00.000+01:00'),
    dated('p', LATE, START),
  ],
};
/** Valid pages that an over-strict schema would reject. */
const CONTROLS: Record<string, Obj[]> = {
  'a page not in the navigation needs no nav label': [
    page((document) => ((document.showInNav = false), delete document.navLabel)),
    page((document) => (delete document.showInNav, delete document.navLabel)),
  ],
  'a hero without an image is fine': [page((document) => delete section(document, 'h').image)],
  // A draft of an already-published page shares its slug with the published copy; that is not a duplicate.
  'a draft of a published page keeps its own slug': [
    page((document) => ((document._id = 'drafts.page-about'), (document.slug.current = 'about'))),
  ],
  'the same slug in another language is fine': [
    page((document) => ((document.language = 'nb'), (document.slug.current = 'about'))),
    page((document) => (document.slug.current = 'om-oss')),
    page((document) => ((document.language = 'nb'), (document.slug.current = 'coming-soon'))),
  ],
  'a page without a hero is fine': [page((document) => document.sections.shift())],
  'a post can be in two lists, and a list can have different posts': [
    page((document) => document.sections.push({ _key: 'p2', _type: 'postList', posts: [ref('post-hello')] })),
    page((document) => (section(document, 'p').posts = [ref('post-hello', 'r1'), ref('post-second', 'r2')])),
  ],
  'a blank paragraph next to text is fine': [
    page((document) => (section(document, 't').body = [block('  ', 'b0'), block('Some words.', 'b1')])),
  ],
  'a block may have one date, or both in order': [
    dated('h', START),
    dated('t', undefined, LATE),
    dated('h', START, LATE),
    dated('t', START, LATE),
    dated('p', START, LATE),
    dated('t', START, '2026-01-01T14:00:00.000Z'),
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
async function checkSchema(
  load: (specifier: string) => Promise<any>,
  moduleUrl: string,
  inputPath: string,
  outputPath: string,
): Promise<void> {
  type DynamicValue = any;
  const { readFileSync, writeFileSync } = process.getBuiltinModule('node:fs');
  // Read before any project code loads; stdin is then empty. Capture result-writing primitives for the same reason.
  const nonce = readFileSync(0, 'utf8').trim();
  const write = writeFileSync;
  const stringify = JSON.stringify;
  const kill = process.kill.bind(process);
  const pid = process.pid;
  const { evaluate, parse } = await load('groq-js');
  const done = (optionsValue: DynamicValue) => {
    write(outputPath, stringify({ ...optionsValue, nonce }));
    kill(pid, 'SIGKILL');
  };
  const { corpus, base, rules, controls, shape } = JSON.parse(readFileSync(inputPath, 'utf8'));
  let createJiti: DynamicValue, sanity: DynamicValue, evaluateDocumentInternal: DynamicValue;
  // Studio-mode validation. The public validateDocument runs in CLI mode, which turns custom object- and document-level
  // rules into warnings even when they say .error(); evaluateDocumentInternal is what it calls, with the mode fixed.
  try {
    ({ createJiti } = await load('jiti'));
    sanity = await load('sanity');
    ({ evaluateDocumentInternal } = await load('@sanity/validation/_internal'));
  } catch (caughtError: DynamicValue) {
    done({
      status: 'unknown',
      reason: 'the grader could not load jiti, sanity or @sanity/validation: ' + caughtError.message,
    });
  }
  let types: DynamicValue;
  try {
    const mod = await createJiti(moduleUrl, { jsx: true, interopDefault: true }).import('./sanity.config.ts');
    const raw = mod && mod.default !== undefined ? mod.default : mod;
    const cfg = Array.isArray(raw) ? raw[0] : raw;
    // Studio's own resolution: schema.types from the config and from every plugin it uses.
    types = sanity.resolveSchemaTypes({ config: cfg, context: { projectId: cfg?.projectId, dataset: cfg?.dataset } });
    if (!Array.isArray(types)) done({ status: 'fail', reason: 'sanity.config.ts gives no schema types' });
  } catch (caughtError: DynamicValue) {
    done({ status: 'fail', reason: 'sanity.config.ts could not be loaded: ' + (caughtError && caughtError.message) });
  }
  let schema: DynamicValue;
  try {
    schema = sanity.createSchema({ name: 'default', types });
  } catch (caughtError: DynamicValue) {
    done({ status: 'fail', reason: 'the schema does not compile: ' + caughtError.message });
  }
  const schemaErrors = (schema._validation ?? []).flatMap((validationGroup: DynamicValue) =>
    validationGroup.problems
      .filter((pathEntry: DynamicValue) => pathEntry.severity === 'error')
      .map(
        (pathEntry: DynamicValue) =>
          validationGroup.path
            .map((schemaEntry: DynamicValue) => schemaEntry.name ?? schemaEntry.type)
            .filter(Boolean)
            .join('.') +
          ': ' +
          pathEntry.message,
      ),
  );
  const missing: DynamicValue = [];
  const pageType = schema.get('page');
  const isKind = (typeEntry: DynamicValue, keyName: DynamicValue) => {
    for (let currentType = typeEntry; currentType; currentType = currentType.type)
      if (currentType.name === keyName) return true;
    return ['string', 'boolean', 'array'].includes(keyName) && typeEntry?.jsonType === keyName;
  };
  const fieldType = (typeEntry: DynamicValue, name: DynamicValue) =>
    typeEntry?.fields?.find((fieldEntry: DynamicValue) => fieldEntry.name === name)?.type;
  const need = (owner: DynamicValue, typeEntry: DynamicValue, kinds: DynamicValue) => {
    for (const [fieldEntry, keyName] of Object.entries(kinds)) {
      const ft = fieldType(typeEntry, fieldEntry);
      if (!ft) missing.push(owner + '.' + fieldEntry);
      else if (!isKind(ft, keyName)) missing.push(owner + '.' + fieldEntry + ' as ' + keyName);
    }
  };
  if (!pageType) missing.push('document type page');
  else {
    if (!isKind(pageType, 'document')) missing.push('page as a document type');
    need('page', pageType, shape.page);
  }
  const sectionsType = fieldType(pageType, 'sections');
  const member = (name: DynamicValue) =>
    (sectionsType?.of ?? []).find((typeEntry: DynamicValue) => typeEntry.name === name);
  for (const name of ['hero', 'richText', 'postList']) {
    const typeEntry = member(name);
    if (!typeEntry) {
      if (pageType) missing.push('sections block ' + name);
      continue;
    }
    if (!isKind(typeEntry, 'object')) missing.push(name + ' as an object');
    need(name, typeEntry, shape[name]);
  }
  const image = fieldType(member('hero'), 'image');
  if (image && isKind(image, 'image')) {
    const alt = fieldType(image, 'alt');
    if (!alt) missing.push('hero.image.alt');
    else if (!isKind(alt, 'string')) missing.push('hero.image.alt as string');
  }
  const body = fieldType(member('richText'), 'body');
  if (
    body &&
    isKind(body, 'array') &&
    !(body.of ?? []).some((memberEntry: DynamicValue) => isKind(memberEntry, 'block'))
  )
    missing.push('richText.body as rich text blocks');
  const posts = member('postList')?.fields?.find((fieldEntry: DynamicValue) => fieldEntry.name === 'posts')?.type;
  if (
    posts &&
    isKind(posts, 'array') &&
    !(posts.of ?? []).every((memberEntry: DynamicValue) => isKind(memberEntry, 'reference'))
  )
    missing.push('postList.posts as references');
  const postTargets = (posts?.of ?? []).map((memberEntry: DynamicValue) =>
    memberEntry.to ? memberEntry.to.map((typeEntry: DynamicValue) => typeEntry.name) : [memberEntry.name],
  );
  if (schemaErrors.length || missing.length) done({ status: 'ok', schemaErrors, missing, postTargets });
  const unsupported: DynamicValue = [];
  // Like the pinned Studio's client: perspective starts as raw, withConfig keeps earlier settings, a fetch option overrides.
  const client = (dataset: DynamicValue, cfg: DynamicValue = { apiVersion: '2025-02-19', perspective: 'raw' }) => {
    const stop = (memberEntry: DynamicValue) => () => {
      unsupported.push(memberEntry);
      throw new Error('the offline grader does not support client.' + memberEntry);
    };
    const view = (pathEntry: DynamicValue) => {
      if (pathEntry === undefined)
        pathEntry = String(cfg.apiVersion).replace(/^v/, '') >= '2025-02-19' ? 'published' : 'raw';
      if (pathEntry === 'raw') return dataset;
      if (pathEntry === 'published')
        return dataset.filter(
          (document: DynamicValue) => !document._id.startsWith('drafts.') && !document._id.startsWith('versions.'),
        );
      return stop('fetch with perspective ' + JSON.stringify(pathEntry))();
    };
    return {
      withConfig: (optionsValue: DynamicValue = {}) => client(dataset, { ...cfg, ...optionsValue }),
      fetch: async (queryText: DynamicValue, params: DynamicValue = {}, opts: DynamicValue = {}) =>
        (await evaluate(parse(queryText), { dataset: view(opts.perspective || cfg.perspective), params })).get(),
      getDataUrl: stop('getDataUrl'),
      request: stop('request'),
      observable: { fetch: stop('observable.fetch') },
      config: () => ({ projectId: 'offline', dataset: 'offline', ...cfg }),
    };
  };
  const check = async (doc: DynamicValue) => {
    const dataset = [...corpus, doc];
    const runResult = await evaluateDocumentInternal({
      document: doc,
      schema,
      environment: 'studio',
      getClient: ({ apiVersion }: DynamicValue) => client(dataset).withConfig({ apiVersion }),
      getDocumentExists: async ({ id }: DynamicValue) => dataset.some((document: DynamicValue) => document._id === id),
    });
    return {
      complete: runResult.complete,
      markers: runResult.markers.map((memberEntry: DynamicValue) => ({
        level: memberEntry.level,
        code: memberEntry.code,
        path: memberEntry.path
          .map((pathEntry: DynamicValue) => (typeof pathEntry === 'object' ? pathEntry._key : pathEntry))
          .join('.'),
        message: String(memberEntry.message ?? memberEntry.item?.message).slice(0, 120),
      })),
    };
  };
  const out: DynamicValue = {
    status: 'ok',
    schemaErrors,
    missing,
    postTargets,
    base: await check(base),
    rules: {},
    controls: {},
    unsupported,
  };
  for (const [name, docs] of Object.entries(rules)) {
    out.rules[name] = [];
    for (const document of docs as DynamicValue[]) out.rules[name].push(await check(document));
  }
  for (const [name, docs] of Object.entries(controls)) {
    out.controls[name] = [];
    for (const document of docs as DynamicValue[]) out.controls[name].push(await check(document));
  }
  done(out);
}
let setup = '';
let tscError = '';
let extractError = '';
let result: Obj = {};

/**
 * Grading-integrity tripwire. Project config, schema code, and scripts run while grading and must not rewrite files
 * that later checks trust. A ctime at or after the marker catches writes even if their contents are restored; grader
 * outputs and tool caches are exempted. Any hit makes the attempt UNKNOWN so rewritten files can never produce a pass.
 */
const GRADER_WRITES = /^(node_modules|\.sanity|node_modules\/\.(vite|cache)(\/.*)?|\.sanity\/eval-schema\.json)$/;
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

function run(cmd: string, args: string[], input = '') {
  sweep();
  const runResult = spawnSync(cmd, args, {
    encoding: 'utf8',
    input,
    timeout: 300000,
    env: { ...TOOL_ENV, SANITY_TELEMETRY_DISABLED: '1', CI: '1', JITI_FS_CACHE: 'false' },
  });
  const raw = `${runResult.stdout ?? ''}${runResult.stderr ?? ''}${runResult.error ? String(runResult.error) : ''}`;
  return {
    status: runResult.status,
    out: raw
      .replace(new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'), '')
      .replace(/[ \t]+/g, ' ')
      .trim(),
  };
}
beforeAll(() => {
  if (!existsSync(bin('sanity', 'sanity'))) setup = 'the Sanity CLI is not installed: the dependencies did not install';
  if (!existsSync(bin('typescript', 'tsc'))) setup ||= 'TypeScript is not installed: the dependencies did not install';
  if (setup) return;
  const since = tripwireStart();
  const typeEntry = run(process.execPath, [bin('typescript', 'tsc'), '--noEmit', '-p', 'tsconfig.json']);
  if (typeEntry.status !== 0)
    tscError = `tsc --noEmit failed (exit ${typeEntry.status}): ${typeEntry.out.slice(0, 800)}`;
  const currentType = run(process.execPath, [
    bin('sanity', 'sanity'),
    'schema',
    'extract',
    '--force',
    '--path',
    '.sanity/eval-schema.json',
  ]);
  if (currentType.status !== 0)
    extractError = `sanity schema extract failed (exit ${currentType.status}): ${currentType.out.slice(-600)}`;
  writeFileSync(
    '.eval-schema-input.json',
    JSON.stringify({ corpus: CORPUS, base: BASE, rules: RULES, controls: CONTROLS, shape: SHAPE }),
  );
  const checkSource = `(${checkSchema.toString()})((specifier) => import(specifier), import.meta.url, ...process.argv.slice(2));`;
  if (/__vite_ssr|__vi_/.test(checkSource)) throw new Error('Vitest rewrote the child-process source');
  writeFileSync('.eval-schema-check.mjs', checkSource);
  try {
    const nonce = randomBytes(16).toString('hex');
    const runResult = run(
      process.execPath,
      ['.eval-schema-check.mjs', '.eval-schema-input.json', '.eval-schema-result.json'],
      nonce,
    );
    const written = existsSync('.eval-schema-result.json')
      ? (JSON.parse(readFileSync('.eval-schema-result.json', 'utf8')) as Obj)
      : null;
    result =
      written && written.nonce === nonce
        ? written
        : written
          ? {
              status: 'fail',
              reason: 'the result file does not carry the nonce for this run, so the grader did not write it as read',
            }
          : {
              status: 'unknown',
              reason: `the schema check wrote no result (exit ${runResult.status}): ${runResult.out.slice(-400)}`,
            };
  } finally {
    for (const fieldEntry of ['.eval-schema-input.json', '.eval-schema-check.mjs', '.eval-schema-result.json'])
      rmSync(fieldEntry, { force: true });
  }
  const hit = tripwireCheck(since);
  if (hit) setup = `UNKNOWN (${hit})`;
}, 900000);
const errors = (candidate: Obj) =>
  (candidate?.markers ?? []).filter((memberEntry: Obj) => memberEntry.level === 'error');
const markerKey = (memberEntry: Obj) =>
  [memberEntry.level, memberEntry.code, memberEntry.path, memberEntry.message].join('|');
/** The prompt allows a warning for a duplicate slug: any warning the valid page does not also get counts. */
const newWarnings = (candidate: Obj) => {
  const onValid = new Set((result.base?.markers ?? []).map(markerKey));
  return (candidate?.markers ?? [])
    .filter((memberEntry: Obj) => memberEntry.level === 'warning' && !onValid.has(markerKey(memberEntry)))
    .map(markerKey);
};
const flagged = (candidate: Obj, slug: boolean) =>
  errors(candidate).length > 0 || (slug && newWarnings(candidate).length > 0);
/** A draft gets the duplicate twin's own uniqueness warning: the rule mistook the published copy for a duplicate. */
const DUPLICATE = 'a slug already used by another page in the same language is flagged';
const dupWarning = (candidate: Obj) => {
  const dup = new Set((result.rules?.[DUPLICATE] ?? []).flatMap(newWarnings));
  return newWarnings(candidate).some((keyName: string) => dup.has(keyName));
};
const clean = (candidate: Obj) =>
  !!candidate &&
  candidate.complete &&
  errors(candidate).length === 0 &&
  !candidate.markers.some((memberEntry: Obj) => memberEntry.code === 'slug.not-unique');
const show = (candidate: Obj) => JSON.stringify(candidate?.markers ?? candidate).slice(0, 400);
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
test.each(Object.keys(RULES))('%s', (name: DynamicValue) => {
  schemaReady();
  result.rules[name].forEach((candidate: Obj, itemIndex: number) => {
    expect(
      candidate.complete,
      `validation did not complete for invalid twin ${itemIndex + 1}: ${show(candidate)}`,
    ).toBe(true);
    expect(
      flagged(candidate, name.startsWith('a slug')),
      `invalid twin ${itemIndex + 1} is not flagged: ${show(candidate)}`,
    ).toBe(true);
  });
});
const SLUG_CONTROLS = ['a draft of a published page keeps its own slug', 'the same slug in another language is fine'];
test.each(Object.keys(CONTROLS))('%s', (name: DynamicValue) => {
  schemaReady();
  result.controls[name].forEach((candidate: Obj, itemIndex: number) =>
    expect(
      clean(candidate) && !(SLUG_CONTROLS.includes(name) && dupWarning(candidate)),
      `valid control ${itemIndex + 1} is rejected: ${show(candidate)}`,
    ).toBe(true),
  );
});
