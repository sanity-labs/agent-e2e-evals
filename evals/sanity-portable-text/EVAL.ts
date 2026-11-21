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
type DynamicValue = any;
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
  post(
    BODY.map((blockEntry) =>
      blockEntry._key === 'b6' ? { ...blockEntry, markDefs: [{ ...blockEntry.markDefs[0], href }] } : blockEntry,
    ),
  );
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
async function checkPortableText(
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
  const { corpus, rules, controls } = JSON.parse(readFileSync(inputPath, 'utf8'));
  let createJiti: DynamicValue, sanity: DynamicValue, evaluateDocumentInternal: DynamicValue, memberTypes: DynamicValue;
  // Studio-mode validation: the public validateDocument runs in CLI mode, which turns custom object- and document-level
  // rules into warnings even when they say .error(); evaluateDocumentInternal is what it calls, with the mode fixed.
  try {
    ({ createJiti } = await load('jiti'));
    sanity = await load('sanity');
    ({ evaluateDocumentInternal } = await load('@sanity/validation/_internal'));
    ({ createPortableTextMemberSchemaTypes: memberTypes } = await load('@portabletext/sanity-bridge'));
  } catch (caughtError: DynamicValue) {
    done({
      status: 'unknown',
      reason:
        'the grader could not load jiti, sanity, @sanity/validation or @portabletext/sanity-bridge: ' +
        caughtError.message,
    });
  }
  let types: DynamicValue;
  try {
    const mod = await createJiti(moduleUrl, { jsx: true, interopDefault: true }).import('./sanity.config.ts');
    const raw = mod && mod.default !== undefined ? mod.default : mod;
    const cfg = Array.isArray(raw) ? raw[0] : raw;
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
  const offered: Record<string, DynamicValue> = {};
  const blockNames: Record<string, DynamicValue> = {};
  const postType = schema.get('post');
  const isKind = (typeEntry: DynamicValue, keyName: DynamicValue) => {
    for (let currentType = typeEntry; currentType; currentType = currentType.type)
      if (currentType.name === keyName) return true;
    return false;
  };
  const fieldType = (typeEntry: DynamicValue, name: DynamicValue) =>
    typeEntry?.fields?.find((fieldEntry: DynamicValue) => fieldEntry.name === name)?.type;
  if (!postType) missing.push('document type post');
  else if (!isKind(postType, 'document')) missing.push('post as a document type');
  for (const field of ['excerpt', 'body']) {
    const typeEntry = fieldType(postType, field);
    if (!typeEntry) {
      if (postType) missing.push('post.' + field);
      continue;
    }
    if (
      typeEntry.jsonType !== 'array' ||
      !(typeEntry.of ?? []).some((memberEntry: DynamicValue) => isKind(memberEntry, 'block'))
    ) {
      missing.push('post.' + field + ' as rich text');
      continue;
    }
    try {
      const resolvedValue = memberTypes(typeEntry);
      blockNames[field] = resolvedValue.block.name;
      offered[field] = {
        styles: resolvedValue.styles.map((currentType: DynamicValue) => currentType.value),
        lists: resolvedValue.lists.map((currentType: DynamicValue) => currentType.value),
        decorators: resolvedValue.decorators.map((currentType: DynamicValue) => currentType.value),
        annotations: resolvedValue.annotations.map((currentType: DynamicValue) => currentType.name),
        inlineObjects: resolvedValue.inlineObjects.map((currentType: DynamicValue) => currentType.name),
        blockObjects: resolvedValue.blockObjects.map((currentType: DynamicValue) => currentType.name),
      };
      const linkType = resolvedValue.annotations.find((actionEntry: DynamicValue) => actionEntry.name === 'link');
      if (linkType && !fieldType(linkType, 'href')) missing.push('post.' + field + ' link.href');
      const imageType = resolvedValue.blockObjects.find((optionsValue: DynamicValue) => optionsValue.name === 'image');
      if (imageType && !fieldType(imageType, 'alt')) missing.push('post.' + field + ' image.alt');
    } catch (caughtError: DynamicValue) {
      missing.push('post.' + field + ' as rich text the editor can read (' + caughtError.message + ')');
    }
  }
  if (schemaErrors.length || missing.length) done({ status: 'ok', schemaErrors, missing, offered });
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
  // Text blocks take the field's own block type name, so a named block type is graded the same as 'block'.
  const named = (doc: DynamicValue) => {
    const document = structuredClone(doc);
    for (const fieldEntry of ['excerpt', 'body'])
      for (const blockEntry of document[fieldEntry] ?? [])
        if (blockEntry._type === 'block') blockEntry._type = blockNames[fieldEntry];
    return document;
  };
  const check = async (raw: DynamicValue) => {
    const doc = named(raw);
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
        path: memberEntry.path
          .map((pathEntry: DynamicValue) => (typeof pathEntry === 'object' ? pathEntry._key : pathEntry))
          .join('.'),
        message: String(memberEntry.message ?? memberEntry.item?.message).slice(0, 120),
      })),
    };
  };
  const out: DynamicValue = { status: 'ok', schemaErrors, missing, offered, rules: {}, controls: {}, unsupported };
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
  writeFileSync('.eval-pt-input.json', JSON.stringify({ corpus: CORPUS, rules: RULES, controls: CONTROLS }));
  const checkSource = `(${checkPortableText.toString()})((specifier) => import(specifier), import.meta.url, ...process.argv.slice(2));`;
  if (/__vite_ssr|__vi_/.test(checkSource)) throw new Error('Vitest rewrote the child-process source');
  writeFileSync('.eval-pt-check.mjs', checkSource);
  try {
    const nonce = randomBytes(16).toString('hex');
    const runResult = run(
      process.execPath,
      ['.eval-pt-check.mjs', '.eval-pt-input.json', '.eval-pt-result.json'],
      nonce,
    );
    const written = existsSync('.eval-pt-result.json')
      ? (JSON.parse(readFileSync('.eval-pt-result.json', 'utf8')) as Obj)
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
              reason: `the rich text check wrote no result (exit ${runResult.status}): ${runResult.out.slice(-400)}`,
            };
  } finally {
    for (const fieldEntry of ['.eval-pt-input.json', '.eval-pt-check.mjs', '.eval-pt-result.json'])
      rmSync(fieldEntry, { force: true });
  }
  const hit = tripwireCheck(since);
  if (hit) setup = `UNKNOWN (${hit})`;
}, 900000);
const errors = (candidate: Obj) =>
  (candidate?.markers ?? []).filter((memberEntry: Obj) => memberEntry.level === 'error');
const show = (candidate: Obj) => JSON.stringify(candidate?.markers ?? candidate).slice(0, 400);
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
const OFFERED = Object.entries(EXPECTED).flatMap(([field, sets]: DynamicValue) =>
  Object.keys(sets).map((group: DynamicValue) => [field, group] as const),
);
test.each(OFFERED)('the %s editor offers exactly the requested %s', (field: DynamicValue, group: DynamicValue) => {
  schemaReady();
  const got = [...(result.offered?.[field]?.[group] ?? [])].sort();
  expect(got, `${field} offers ${group}: ${JSON.stringify(got)}`).toEqual(EXPECTED[field]![group]);
});
test.each(Object.keys(RULES))('%s', (name: DynamicValue) => {
  validated();
  result.rules[name].forEach((candidate: Obj, itemIndex: number) => {
    expect(candidate.complete, `validation did not complete for document ${itemIndex + 1}: ${show(candidate)}`).toBe(
      true,
    );
    expect(errors(candidate).length, `document ${itemIndex + 1} gets no error: ${show(candidate)}`).toBeGreaterThan(0);
  });
});
test.each(Object.keys(CONTROLS))('%s', (name: DynamicValue) => {
  validated();
  result.controls[name].forEach((candidate: Obj, itemIndex: number) =>
    expect(
      candidate.complete && errors(candidate).length === 0,
      `valid document ${itemIndex + 1} is rejected: ${show(candidate)}`,
    ).toBe(true),
  );
});
