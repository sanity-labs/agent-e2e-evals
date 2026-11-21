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
type DynamicValue = any;
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
async function checkSingletons(
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
  const done = (optionsValue: DynamicValue) => {
    write(outputPath, stringify({ ...optionsValue, nonce }));
    kill(pid, 'SIGKILL');
  };
  const { dataset } = JSON.parse(readFileSync(inputPath, 'utf8'));
  let createJiti: DynamicValue,
    sanity: DynamicValue,
    structure: DynamicValue,
    createClient: DynamicValue,
    groq: DynamicValue;
  try {
    ({ createJiti } = await load('jiti'));
    sanity = await load('sanity');
    structure = await load('sanity/structure');
    ({ createClient } = await load('@sanity/client'));
    groq = await load('groq-js');
    // Initial value resolution needs a window; set it after loading sanity, which expects a full DOM if one exists at import.
    const { JSDOM } = await load('jsdom');
    (globalThis as DynamicValue).window = new JSDOM('').window;
  } catch (caughtError: DynamicValue) {
    done({
      status: 'unknown',
      reason: 'the grader could not load jsdom, jiti, sanity or groq-js: ' + caughtError.message,
    });
  }
  const why = (caughtError: DynamicValue) =>
    [
      caughtError && caughtError.message,
      ...((caughtError && caughtError.causes) || []).map((candidate: DynamicValue) => candidate && candidate.message),
    ]
      .filter(Boolean)
      .join('; ')
      .slice(0, 600);
  let cfgs: DynamicValue;
  try {
    const mod = await createJiti(moduleUrl, { jsx: true, interopDefault: true }).import('./sanity.config.ts');
    const raw = mod && mod.default !== undefined ? mod.default : mod;
    cfgs = Array.isArray(raw) ? raw : [raw];
  } catch (caughtError: DynamicValue) {
    done({ status: 'fail', reason: 'sanity.config.ts could not be loaded: ' + why(caughtError) });
  }
  const currentUser = {
    id: 'u1',
    name: 'Eval',
    email: 'eval@example.invalid',
    role: 'administrator',
    roles: [{ name: 'administrator', title: 'Administrator' }],
  };
  const client = createClient({
    projectId: 'offline',
    dataset: 'production',
    apiVersion: '2025-01-01',
    useCdn: false,
    apiHost: 'http://127.0.0.1:65535',
  });
  // Any dataset request means the sidebar or config depends on data, which this empty offline dataset cannot represent.
  let queried = '';
  const watch = (candidate: DynamicValue) =>
    new Proxy(candidate, {
      get(typeEntry: DynamicValue, keyName: DynamicValue) {
        const resolvedValue = Reflect.get(typeEntry, keyName);
        if (keyName === 'withConfig' || keyName === 'clone')
          return (...actionEntry: DynamicValue) => watch(resolvedValue.apply(typeEntry, actionEntry));
        if (keyName === 'observable') return watch(resolvedValue);
        if (keyName === 'config')
          return (...actionEntry: DynamicValue) => {
            const runResult = resolvedValue.apply(typeEntry, actionEntry);
            return runResult === typeEntry ? watch(typeEntry) : runResult;
          };
        if (typeof resolvedValue === 'function' && /^(fetch|listen|getDocuments?)$/.test(String(keyName)))
          return (...actionEntry: DynamicValue) => {
            queried ||= String(keyName);
            return resolvedValue.apply(typeEntry, actionEntry);
          };
        return typeof resolvedValue === 'function' ? resolvedValue.bind(typeEntry) : resolvedValue;
      },
    });
  const getClient = ({ apiVersion }: DynamicValue) => watch(client.withConfig({ apiVersion }));
  const offline = (caughtError: DynamicValue) =>
    /ECONNREFUSED|fetch failed|127\\.0\\.0\\.1:65535/.test(why(caughtError));
  let source: DynamicValue, structureBuilder: DynamicValue;
  const nodes: DynamicValue = [],
    allGlobal: DynamicValue = [],
    allActions: DynamicValue = [];
  let truncated = false,
    builtIn = false,
    toolCount = 0;
  for (const [wi, cfg] of cfgs.entries()) {
    try {
      source = await sanity.createSourceFromConfig({ basePath: '/', ...cfg, currentUser, getClient });
    } catch (caughtError: DynamicValue) {
      done({
        status: offline(caughtError) ? 'unknown' : 'fail',
        reason:
          (offline(caughtError)
            ? 'the config reads the dataset while loading, which the offline grader cannot serve: '
            : 'the Studio config does not resolve: ') + why(caughtError),
      });
    }
    // Every structure tool, renamed or not, shares the native component (one object at the pinned version).
    const structureComponent = structure.structureTool().tools[0].component;
    const tools = source.tools.filter((typeEntry: DynamicValue) => typeEntry.component === structureComponent);
    const hasSettings = !!source.schema.get('siteSettings');
    if (!tools.length && hasSettings)
      done({
        status: 'fail',
        reason: 'a workspace with site settings has no structure tool, so editors have no sidebar',
      });
    toolCount += tools.length;
    // Template ids are local to a workspace, so each id is resolved to its type in the workspace that offers it.
    const typed = (ids: DynamicValue) =>
      ids.map((id: DynamicValue) => ({
        id,
        type:
          id === '?' ? '?' : source.templates.find((typeEntry: DynamicValue) => typeEntry.id === id)?.schemaType || id,
      }));
    const firstNode = nodes.length;
    builtIn ||= (source.document.singletons || []).length > 0;
    const settle = async (resolvedValue: DynamicValue) => {
      resolvedValue = await resolvedValue;
      if (resolvedValue && typeof resolvedValue.subscribe === 'function')
        resolvedValue = await new Promise((res: DynamicValue, rej: DynamicValue) =>
          resolvedValue.subscribe({ next: res, error: rej }),
        );
      return resolvedValue;
    };
    async function walk(
      value: DynamicValue,
      id: DynamicValue,
      parent: DynamicValue,
      index: DynamicValue,
      path: DynamicValue,
      depth: DynamicValue,
    ) {
      if (depth > 8 || nodes.length > 400) {
        truncated = true;
        return;
      }
      if (typeof value === 'function')
        value = await value(id, {
          parent,
          index,
          splitIndex: 0,
          path,
          params: {},
          structureContext: structureBuilder.context,
        });
      value = await settle(value);
      value = value && value.serialize ? value.serialize({ path }) : value;
      if (!value || typeof value !== 'object') return;
      const node: DynamicValue = {
        path: path.join('/'),
        type: value.type,
        schemaTypeName: value.schemaTypeName,
        options: value.options,
        create: [
          ...(value.initialValueTemplates || []).map((typeEntry: DynamicValue) => typeEntry.templateId),
          ...(value.menuItems || [])
            .filter((memberEntry: DynamicValue) => memberEntry.intent && memberEntry.intent.type === 'create')
            .map((memberEntry: DynamicValue) => {
              const pathEntry = Array.isArray(memberEntry.intent.params)
                ? memberEntry.intent.params[0]
                : memberEntry.intent.params;
              return (pathEntry && (pathEntry.template || pathEntry.type)) || '?';
            }),
        ],
      };
      nodes.push(node);
      if (value.type === 'document') {
        const optionsValue = value.options || {};
        node.create = source.document
          .resolveNewDocumentOptions({ type: 'document', schemaType: optionsValue.type, documentId: optionsValue.id })
          .map((typeEntry: DynamicValue) => typeEntry.templateId);
        const typeTemplates = source.templates.filter(
          (typeEntry: DynamicValue) => typeEntry.schemaType === optionsValue.type,
        );
        const templateId = optionsValue.template || (typeTemplates.length === 1 ? typeTemplates[0].id : undefined);
        const template = source.templates.find((typeEntry: DynamicValue) => typeEntry.id === templateId);
        node.template = templateId ?? null;
        try {
          node.initial = template
            ? await sanity.resolveInitialValue(
                source.schema,
                template,
                optionsValue.templateParameters || {},
                structureBuilder.context,
              )
            : null;
        } catch (caughtError: DynamicValue) {
          node.initialError = why(caughtError);
        }
      }
      if (value.type === 'documentList') {
        const result = await groq.evaluate(groq.parse('*[' + (value.options?.filter || 'false') + ']'), {
          dataset,
          params: value.options?.params || {},
        });
        node.listed = (await result.get()).map((document: DynamicValue) => document._id);
        if (value.child) {
          node.rowOpens = [];
          for (const id of node.listed) {
            try {
              // A list's child is a resolver called with the row id, or one fixed builder for every row.
              let candidate = await settle(
                typeof value.child === 'function'
                  ? await value.child(id, {
                      parent: value,
                      index: 0,
                      splitIndex: 0,
                      path: [...path, id],
                      params: {},
                      structureContext: structureBuilder.context,
                    })
                  : value.child,
              );
              candidate = candidate && candidate.serialize ? candidate.serialize({ path: [...path, id] }) : candidate;
              node.rowOpens.push([id, candidate && candidate.options ? candidate.options.id : null]);
            } catch (caughtError: DynamicValue) {
              node.rowOpens.push([id, 'error: ' + why(caughtError)]);
            }
          }
        }
      }
      for (const [itemIndex, item] of (value.items || []).entries())
        if (item && item.child) await walk(item.child, item.id, value, itemIndex, [...path, item.id], depth + 1);
    }
    try {
      for (const tool of tools) {
        structureBuilder = structure.createStructureBuilder({
          source,
          defaultDocumentNode: tool.options?.defaultDocumentNode,
        });
        const root = tool.options?.structure
          ? await settle(tool.options.structure(structureBuilder, structureBuilder.context))
          : structureBuilder.defaults();
        await walk(root, 'root', null, 0, [cfg.name || String(wi), tool.name], 0);
      }
    } catch (caughtError: DynamicValue) {
      done({
        status: offline(caughtError) ? 'unknown' : 'fail',
        reason:
          (offline(caughtError)
            ? 'the sidebar reads the dataset, which the offline grader cannot serve: '
            : 'the sidebar could not be resolved: ') + why(caughtError),
      });
    }
    // A partial walk has not seen every create surface, so it cannot pass.
    for (const nodeEntry of nodes.slice(firstNode)) {
      nodeEntry.create = typed(nodeEntry.create);
      nodeEntry.settingsRules = hasSettings;
    }
    allGlobal.push(
      ...typed(
        source.document
          .resolveNewDocumentOptions({ type: 'global' })
          .map((typeEntry: DynamicValue) => typeEntry.templateId),
      ).map((typeEntry: DynamicValue) => ({ ...typeEntry, settingsRules: hasSettings })),
    );
    // 4. actions: built-ins are named; anything else this config adds or wraps is unidentified
    if (hasSettings) {
      const plain = await sanity.createSourceFromConfig({
        basePath: '/',
        ...cfg,
        document: { ...cfg.document, actions: undefined },
        currentUser,
        getClient,
      });
      const builtin = plain.document.actions({ schemaType: 'siteSettings', documentId: 'siteSettings' });
      allActions.push(
        ...source.document
          .actions({ schemaType: 'siteSettings', documentId: 'siteSettings' })
          .map(
            (actionEntry: DynamicValue) =>
              actionEntry.action ||
              (builtin.includes(actionEntry) ? actionEntry.name : 'unidentified:' + (actionEntry.name || 'anonymous')),
          ),
      );
    }
  }
  if (!toolCount) done({ status: 'fail', reason: 'the Studio has no structure tool, so editors have no sidebar' });
  if (truncated)
    done({
      status: 'unknown',
      reason: 'the sidebar is deeper than 8 levels or has more than 400 panes, which the grader does not walk',
    });
  if (queried)
    done({
      status: 'unknown',
      reason:
        'the config or sidebar queries the dataset (client.' +
        queried +
        '), so it can change once documents exist, which the offline grader cannot serve',
    });
  const global = allGlobal;
  const settingsCreate = [
    { where: 'the global create menu', ids: global.filter((typeEntry: DynamicValue) => typeEntry.settingsRules) },
    ...nodes
      .filter((nodeEntry: DynamicValue) => nodeEntry.settingsRules)
      .map((nodeEntry: DynamicValue) => ({ where: nodeEntry.type + ' ' + nodeEntry.path, ids: nodeEntry.create })),
  ]
    .filter((candidate: DynamicValue) =>
      candidate.ids.some((typeEntry: DynamicValue) => typeEntry.type === 'siteSettings' || typeEntry.type === '?'),
    )
    .map((candidate: DynamicValue) => candidate.where);
  const actions = allActions;
  done({ status: 'ok', builtIn, global, settingsCreate, actions, nodes });
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
  writeFileSync('.eval-sg-input.json', JSON.stringify({ dataset: DATASET }));
  const checkSource = `(${checkSingletons.toString()})((specifier) => import(specifier), import.meta.url, ...process.argv.slice(2));`;
  if (/__vite_ssr|__vi_/.test(checkSource)) throw new Error('Vitest rewrote the child-process source');
  writeFileSync('.eval-sg-check.mjs', checkSource);
  try {
    const nonce = randomBytes(16).toString('hex');
    const runResult = run(
      process.execPath,
      ['.eval-sg-check.mjs', '.eval-sg-input.json', '.eval-sg-result.json'],
      nonce,
    );
    const written = existsSync('.eval-sg-result.json')
      ? (JSON.parse(readFileSync('.eval-sg-result.json', 'utf8')) as Obj)
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
              reason: `the Studio check wrote no result (exit ${runResult.status}): ${runResult.out.slice(-400)}`,
            };
  } finally {
    for (const fieldEntry of ['.eval-sg-input.json', '.eval-sg-check.mjs', '.eval-sg-result.json'])
      rmSync(fieldEntry, { force: true });
  }
  const hit = tripwireCheck(since);
  if (hit) setup = `UNKNOWN (${hit})`;
}, 900000);
/** The Studio resolved and its sidebar was walked; otherwise every later test fails with this reason. */
function resolved() {
  expect(setup, setup).toBe('');
  if (result.status === 'unknown') expect.fail(`UNKNOWN (${result.reason})`);
  expect(result.status, result.reason).toBe('ok');
}
const nodes = (): Obj[] => result.nodes ?? [];
const pane = (id: string) =>
  nodes().find((nodeEntry: DynamicValue) => nodeEntry.type === 'document' && nodeEntry.options?.id === id);
const lists = () =>
  nodes()
    .filter((nodeEntry: DynamicValue) => nodeEntry.type === 'documentList')
    .map((nodeEntry: DynamicValue) => `${nodeEntry.path}: ${JSON.stringify(nodeEntry.listed)}`);
test('the project typechecks with the shipped tsconfig, and sanity schema extract works', () => {
  expect(setup, setup).toBe('');
  expect(tscError, tscError).toBe('');
  expect(extractError, extractError).toBe('');
});
test.each(FIXED)('the sidebar opens the $id document as a $type', ({ id, type }: DynamicValue) => {
  resolved();
  const pathEntry = pane(id);
  expect(pathEntry, `no sidebar item opens a document pane for ${id}`).toBeTruthy();
  expect(pathEntry!.options?.type, `the ${id} pane has type ${pathEntry!.options?.type}`).toBe(type);
});
test('editors are not offered a new site settings document anywhere', () => {
  resolved();
  expect(result.settingsCreate, `site settings can be created from: ${result.settingsCreate?.join(', ')}`).toEqual([]);
});
test('the site settings document cannot be duplicated', () => {
  resolved();
  expect(result.actions, `actions on siteSettings: ${result.actions?.join(', ')}`).not.toContain('duplicate');
  const odd = (result.actions ?? []).filter((actionEntry: string) => actionEntry.startsWith('unidentified:'));
  if (odd.length) expect.fail(`UNKNOWN (custom actions on siteSettings the grader cannot identify: ${odd.join(', ')})`);
});
test.each(FIXED.filter((fieldEntry: DynamicValue) => fieldEntry.season))(
  'the $id document starts with season $season',
  ({ id, season }: DynamicValue) => {
    resolved();
    const pathEntry = pane(id);
    expect(pathEntry, `no sidebar item opens a document pane for ${id}`).toBeTruthy();
    const got = `template ${pathEntry!.template}, initial value ${JSON.stringify(pathEntry!.initial)}${pathEntry!.initialError ? `, error ${pathEntry!.initialError}` : ''}`;
    expect(pathEntry!.initial?.season, `the ${id} pane starts with ${got}`).toBe(season);
  },
);
test.each(ORDINARY)('editors can still create %s documents and browse every existing one', (type: DynamicValue) => {
  resolved();
  const creatable = (result.global ?? []).filter((typeEntry: Obj) => typeEntry.type === type);
  expect(
    creatable.length,
    `the global create menu offers no ${type}: ${JSON.stringify(result.global)}`,
  ).toBeGreaterThan(0);
  const want = DATASET.filter((document: DynamicValue) => document._type === type).map(
    (document: DynamicValue) => document._id,
  );
  // Editors may split a type over several lists, so the reached lists together must show every document.
  // A listed row counts only if clicking it opens that same document.
  const opens = (nodeEntry: Obj, id: string) =>
    !nodeEntry.rowOpens ||
    nodeEntry.rowOpens.some(([runResult, got]: [string, string]) => runResult === id && got === id);
  const shown = new Set(
    nodes().flatMap((nodeEntry: DynamicValue) =>
      nodeEntry.type === 'documentList' ? (nodeEntry.listed ?? []).filter((id: string) => opens(nodeEntry, id)) : [],
    ),
  );
  const missing = want.filter((id: DynamicValue) => !shown.has(id));
  expect(missing, `no sidebar list shows ${missing.join(', ')}; lists reached: ${lists().join(' | ')}`).toEqual([]);
});
