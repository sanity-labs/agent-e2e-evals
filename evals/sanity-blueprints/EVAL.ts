/**
 * Runtime diagnostics for sanity-blueprints. The Sanity CLI's own
 * loader reads the blueprint and its local runner (`sanity-run functions test`) runs the function on five publish
 * events against a loopback stand-in for the fixture dataset (writes via @sanity/mutator, reads via groq-js).
 * The outcome is a manual label; the exporter keeps it unknown. A message starting "UNKNOWN" means the grader could
 * not observe the case, not that the model failed. Not proven: delivery, deploys, permissions. Calibrate in `unshare -rn`.
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Mutation } from '@sanity/mutator';
import { evaluate, parse } from 'groq-js';
import { beforeAll, expect, test } from 'vitest';

const FIXTURE = { projectId: 'xg4e0byh', dataset: 'production' };
// Internal path in @sanity/runtime-cli, resolved from package.json's caret range by the verifier's npm install (no lockfile); a broken import is UNKNOWN.
const LOADER = 'node_modules/@sanity/runtime-cli/dist/actions/blueprints/blueprint.js';
const PORT = 4790;
const STUB = join(tmpdir(), 'eval-dns-stub.mjs');
const LOOKUPS = join(tmpdir(), 'eval-lookups.log');
// Loaded into the CLI runner with --import. Routing only, not isolation: every hostname resolves to loopback and
// names other than localhost are logged to LOOKUP_LOG.
function installDnsStub() {
  const dns = process.getBuiltinModule('node:dns');
  const { appendFileSync } = process.getBuiltinModule('node:fs');
  const loopback = { address: '127.0.0.1', family: 4 };
  const note = (hostname: string) => {
    if (!/(^|\.)localhost$|^127\.0\.0\.1$/.test(hostname)) appendFileSync(process.env.LOOKUP_LOG!, `${hostname}\n`);
  };
  const lookup = (hostname: string, options: unknown, callback?: (...results: unknown[]) => void) => {
    const done = typeof options === 'function' ? (options as typeof callback)! : callback!;
    note(hostname);
    if (typeof options === 'object' && options && 'all' in options && options.all) done(null, [loopback]);
    else done(null, loopback.address, loopback.family);
  };
  const lookupPromise = async (hostname: string, options?: { all?: boolean }) => {
    note(hostname);
    return options?.all ? [loopback] : loopback;
  };
  Object.assign(dns, { lookup });
  Object.assign(dns.promises, { lookup: lookupPromise });
}

function stubModuleSource() {
  const source = `(${installDnsStub.toString()})();\n`;
  if (source.includes('__vite_ssr') || source.includes('__vi_'))
    throw new Error('DNS stub source was rewritten by the test runner');
  return source;
}
type Doc = Record<string, unknown> & { _id: string };
type Obs = { unknown: string[]; failed: boolean; final: Doc | undefined; tail: string };

const harness: string[] = [];
const obs: Record<string, Obs> = {};
let fn: { name: string; event?: { on?: string[] } } | undefined;
let target: { projectId?: string; dataset?: string } = {};
let loadErrors = '';
const post = (id: string, title: string, extra = {}): Doc => ({ _id: id, _type: 'post', _rev: 'r1', title, ...extra });
const strip = ({ _rev, _updatedAt, _createdAt, ...document }: Doc) => document;

function fakeDataset(store: Map<string, Doc>, observation: Obs) {
  return createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', async () => {
      const send = (status: number, json: unknown) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
      const url = new URL(req.url!.replace(/^\/+/, '/'), 'http://x');
      if (req.headers.host === `localhost:${PORT}` && url.pathname.includes('/blueprints/stacks')) return send(200, []); // runner's own lookup
      const match = url.pathname.match(/^\/v[\w-]+\/data\/(mutate|doc|query)\/([^/]+)(?:\/(.+))?$/);
      try {
        if (req.headers.host !== `${target.projectId}.localhost:${PORT}` || !match || match[2] !== target.dataset)
          throw new Error('not modelled');
        if (match[1] === 'doc')
          return send(200, { documents: match[3]!.split(',').flatMap((id) => store.get(id) ?? []) });
        if (match[1] === 'query') {
          const params = Object.fromEntries(
            [...url.searchParams]
              .filter(([key]) => key.startsWith('$'))
              .map(([key, value]) => [key.slice(1), JSON.parse(value)]),
          );
          const queryRequest = body ? JSON.parse(body) : { query: url.searchParams.get('query'), params };
          return send(200, {
            result: await (
              await evaluate(parse(queryRequest.query), {
                dataset: [...store.values()],
                params: queryRequest.params,
                sanity: { projectId: target.projectId!, dataset: target.dataset! },
              })
            ).get(),
            ms: 0,
          });
        }
        const results = [];
        for (const mu of JSON.parse(body).mutations) {
          const arg = Object.values(mu)[0] as { id?: string; _id?: string; query?: string };
          const id = arg.id ?? arg._id;
          if (!id || arg.query) throw new Error('mutation by query not modelled');
          if (mu.patch && !store.has(id))
            return send(409, { error: { type: 'mutationError', description: `Document "${id}" not found` } });
          const existed = store.has(id);
          const next = new Mutation({ mutations: [mu] }).apply((store.get(id) ?? null) as never) as Doc | null;
          if (next) store.set(id, next);
          else store.delete(id);
          results.push({
            id,
            operation: mu.delete ? 'delete' : existed ? 'update' : 'create',
            document: store.get(id),
          });
        }
        return send(200, { transactionId: 'tx', results });
      } catch (err) {
        observation.unknown.push(`${req.method} ${req.headers.host}${url.pathname}: ${(err as Error).message}`);
        return send(501, { error: 'not modelled by the grader' });
      }
    });
  });
}

async function runCase(kind: 'create' | 'update', before: Doc | null, after: Doc): Promise<Obs> {
  const store = new Map([[after._id, structuredClone(after)]]);
  const observation: Obs = { unknown: [], failed: false, final: undefined, tail: '' };
  const on = fn!.event?.on ?? ['publish'];
  if (on.includes(kind) || on.includes('publish')) {
    const server = fakeDataset(store, observation);
    await new Promise<void>((resolveListening) => server.listen(PORT, '127.0.0.1', resolveListening));
    const args = [
      'functions',
      'test',
      fn!.name,
      '--event',
      kind,
      '--data-before',
      JSON.stringify(before ?? {}),
      '--data-after',
      JSON.stringify(after),
      '--project-id',
      target.projectId!,
      '--dataset',
      target.dataset!,
    ];
    const env = {
      ...process.env,
      NODE_OPTIONS: `--import ${pathToFileURL(STUB).href}`,
      LOOKUP_LOG: LOOKUPS,
      SANITY_INTERNAL_ENV: `http://localhost:${PORT}/`,
      SANITY_AUTH_TOKEN: 'fake-token-not-a-secret',
    };
    let out = '';
    const code = await new Promise<number | null>((done) => {
      const child = spawn('./node_modules/.bin/sanity-run', args, { env });
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (out += chunk));
      const timer = setTimeout(() => (observation.unknown.push('runner timed out after 180s'), child.kill()), 180_000);
      child.on('close', (exitCode) => (clearTimeout(timer), done(exitCode)));
    });
    await new Promise((resolveClosed) => server.close(resolveClosed));
    observation.failed = code !== 0 || out.includes('Function execution failed');
    observation.tail = out.slice(-600);
    const looked = readFileSync(LOOKUPS, 'utf8').trim();
    if (looked) observation.unknown.push(`outside hostnames looked up: ${[...new Set(looked.split('\n'))].join(', ')}`);
    writeFileSync(LOOKUPS, '');
  }
  observation.final = store.get(after._id);
  return observation;
}

beforeAll(async () => {
  writeFileSync(STUB, stubModuleSource());
  writeFileSync(LOOKUPS, '');
  try {
    const { loadAndParseBlueprint } = await import(pathToFileURL(resolve(LOADER)).href);
    const { errors = [], parsedBlueprint: blueprint } = await loadAndParseBlueprint();
    const functions = (blueprint?.resources ?? []).filter(
      (resource: { type: string }) => resource.type === 'sanity.function.document',
    );
    target = blueprint?.values ?? {};
    loadErrors = errors.length ? `(loader errors: ${JSON.stringify(errors)})` : '';
    if (functions.length > 1) harness.push(`${functions.length} document functions; the grader does not pick one`);
    else if (functions.length && (target.projectId !== FIXTURE.projectId || target.dataset !== FIXTURE.dataset))
      harness.push(
        `blueprint targets ${target.projectId}/${target.dataset}, not the fixture's ${FIXTURE.projectId}/${FIXTURE.dataset}`,
      );
    else fn = functions[0];
  } catch (err) {
    harness.push(`Sanity CLI blueprint loader unavailable or failed: ${(err as Error).message}`);
  }
  if (!fn || harness.length) return;
  obs.A = await runCase('create', null, post('p1', 'Hello World'));
  obs.B = await runCase('create', null, post('p2', 'Hi', { slug: { _type: 'slug', current: 'keep-me' } }));
  obs.C = await runCase('create', null, { _id: 'a1', _type: 'author', _rev: 'r1', title: 'Ann' });
  const firstPost = obs.A.final ?? post('p1', 'Hello World');
  obs.D = await runCase('update', firstPost, { ...firstPost, _rev: 'r2' });
  obs.E = await runCase('update', post('p3', 'Second Post'), post('p3', 'Second Post', { _rev: 'r2' }));
}, 1_200_000);

function observe(name: string): Doc {
  expect(harness, `UNKNOWN (harness): ${harness.join('; ')}`).toEqual([]);
  expect(fn, `the Sanity CLI loaded exactly one document function from the blueprint ${loadErrors}`).toBeDefined();
  const observation = obs[name]!;
  console.log(`case ${name}:`, JSON.stringify(observation));
  expect(observation.unknown, `UNKNOWN (case ${name}): ${observation.unknown.join('; ')}`).toEqual([]);
  expect(observation.failed, `case ${name}: the runner reported a failure: ${observation.tail}`).toBe(false);
  return strip(observation.final!);
}
const slugOf = (document: Doc) => (document.slug as { current?: unknown } | undefined)?.current;
const withoutSlug = ({ slug: _slug, ...rest }: Doc) => rest;

test('A: a new post published without a slug ends with slug "hello-world" and nothing else changed', () => {
  const document = observe('A');
  expect(slugOf(document)).toBe('hello-world');
  expect(withoutSlug(document)).toEqual(strip(post('p1', 'Hello World')));
});
test('B: a published post that already has a slug is left unchanged', () => {
  expect(observe('B')).toEqual(strip(post('p2', 'Hi', { slug: { _type: 'slug', current: 'keep-me' } })));
});
test('C: a published non-post document is left unchanged', () => {
  expect(observe('C')).toEqual({ _id: 'a1', _type: 'author', title: 'Ann' });
});
test("D: publishing case A's result again leaves the document stable (not a loop-prevention check)", () => {
  expect(observe('D')).toEqual(strip(obs.A?.final ?? post('p1', 'Hello World')));
});
test('E: an existing post republished without a slug ends with slug "second-post"', () => {
  const document = observe('E');
  expect(slugOf(document)).toBe('second-post');
  expect(withoutSlug(document)).toEqual(strip(post('p3', 'Second Post')));
});
