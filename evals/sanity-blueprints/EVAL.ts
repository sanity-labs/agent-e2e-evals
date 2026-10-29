/**
 * Runtime diagnostics for sanity-blueprints (design: research/function-handler-grader-v2.md). The Sanity CLI's own
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
// Pinned internal path in @sanity/runtime-cli 17.0.0 (lockfile); a broken import is UNKNOWN.
const LOADER = 'node_modules/@sanity/runtime-cli/dist/actions/blueprints/blueprint.js';
const PORT = 4790;
const STUB = join(tmpdir(), 'eval-dns-stub.mjs');
const LOOKUPS = join(tmpdir(), 'eval-lookups.log');
// Routing only, not isolation: every hostname resolves to loopback and non-loopback names are logged.
const STUB_SRC = `import dns from 'node:dns'; import {appendFileSync} from 'node:fs';
const note = (h) => { if (!/(^|\\.)localhost$|^127\\.0\\.0\\.1$/.test(h)) appendFileSync(process.env.LOOKUP_LOG, h + '\\n') };
dns.lookup = (h, o, cb) => { if (typeof o === 'function') cb = o, o = {}; note(h); o && o.all ? cb(null, [{address: '127.0.0.1', family: 4}]) : cb(null, '127.0.0.1', 4) };
dns.promises.lookup = async (h, o) => { note(h); return o && o.all ? [{address: '127.0.0.1', family: 4}] : {address: '127.0.0.1', family: 4} };`;
type Doc = Record<string, unknown> & { _id: string };
type Obs = { unknown: string[]; failed: boolean; final: Doc | undefined; tail: string };

const harness: string[] = [];
const obs: Record<string, Obs> = {};
let fn: { name: string; event?: { on?: string[] } } | undefined;
let target: { projectId?: string; dataset?: string } = {};
let loadErrors = '';
const post = (id: string, title: string, extra = {}): Doc => ({ _id: id, _type: 'post', _rev: 'r1', title, ...extra });
const strip = ({ _rev, _updatedAt, _createdAt, ...d }: Doc) => d;

function fakeDataset(store: Map<string, Doc>, o: Obs) {
  return createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      const send = (status: number, json: unknown) =>
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
      const url = new URL(req.url!.replace(/^\/+/, '/'), 'http://x');
      if (req.headers.host === `localhost:${PORT}` && url.pathname.includes('/blueprints/stacks')) return send(200, []); // runner's own lookup
      const m = url.pathname.match(/^\/v[\w-]+\/data\/(mutate|doc|query)\/([^/]+)(?:\/(.+))?$/);
      try {
        if (req.headers.host !== `${target.projectId}.localhost:${PORT}` || !m || m[2] !== target.dataset)
          throw new Error('not modelled');
        if (m[1] === 'doc') return send(200, { documents: m[3]!.split(',').flatMap((id) => store.get(id) ?? []) });
        if (m[1] === 'query') {
          const params = Object.fromEntries(
            [...url.searchParams].filter(([k]) => k.startsWith('$')).map(([k, v]) => [k.slice(1), JSON.parse(v)]),
          );
          const q = body ? JSON.parse(body) : { query: url.searchParams.get('query'), params };
          return send(200, {
            result: await (
              await evaluate(parse(q.query), {
                dataset: [...store.values()],
                params: q.params,
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
        o.unknown.push(`${req.method} ${req.headers.host}${url.pathname}: ${(err as Error).message}`);
        return send(501, { error: 'not modelled by the grader' });
      }
    });
  });
}

async function runCase(kind: 'create' | 'update', before: Doc | null, after: Doc): Promise<Obs> {
  const store = new Map([[after._id, structuredClone(after)]]);
  const o: Obs = { unknown: [], failed: false, final: undefined, tail: '' };
  const on = fn!.event?.on ?? ['publish'];
  if (on.includes(kind) || on.includes('publish')) {
    const server = fakeDataset(store, o);
    await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r));
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
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      const timer = setTimeout(() => (o.unknown.push('runner timed out after 180s'), child.kill()), 180_000);
      child.on('close', (c) => (clearTimeout(timer), done(c)));
    });
    await new Promise((r) => server.close(r));
    o.failed = code !== 0 || out.includes('Function execution failed');
    o.tail = out.slice(-600);
    const looked = readFileSync(LOOKUPS, 'utf8').trim();
    if (looked) o.unknown.push(`outside hostnames looked up: ${[...new Set(looked.split('\n'))].join(', ')}`);
    writeFileSync(LOOKUPS, '');
  }
  o.final = store.get(after._id);
  return o;
}

beforeAll(async () => {
  writeFileSync(STUB, STUB_SRC);
  writeFileSync(LOOKUPS, '');
  try {
    const { loadAndParseBlueprint } = await import(pathToFileURL(resolve(LOADER)).href);
    const { errors = [], parsedBlueprint: bp } = await loadAndParseBlueprint();
    const fns = (bp?.resources ?? []).filter((r: { type: string }) => r.type === 'sanity.function.document');
    target = bp?.values ?? {};
    loadErrors = errors.length ? `(loader errors: ${JSON.stringify(errors)})` : '';
    if (fns.length > 1) harness.push(`${fns.length} document functions; the grader does not pick one`);
    else if (fns.length && (target.projectId !== FIXTURE.projectId || target.dataset !== FIXTURE.dataset))
      harness.push(
        `blueprint targets ${target.projectId}/${target.dataset}, not the fixture's ${FIXTURE.projectId}/${FIXTURE.dataset}`,
      );
    else fn = fns[0];
  } catch (err) {
    harness.push(`Sanity CLI blueprint loader unavailable or failed: ${(err as Error).message}`);
  }
  if (!fn || harness.length) return;
  obs.A = await runCase('create', null, post('p1', 'Hello World'));
  obs.B = await runCase('create', null, post('p2', 'Hi', { slug: { _type: 'slug', current: 'keep-me' } }));
  obs.C = await runCase('create', null, { _id: 'a1', _type: 'author', _rev: 'r1', title: 'Ann' });
  const a = obs.A.final ?? post('p1', 'Hello World');
  obs.D = await runCase('update', a, { ...a, _rev: 'r2' });
  obs.E = await runCase('update', post('p3', 'Second Post'), post('p3', 'Second Post', { _rev: 'r2' }));
}, 1_200_000);

function observe(name: string): Doc {
  expect(harness, `UNKNOWN (harness): ${harness.join('; ')}`).toEqual([]);
  expect(fn, `the Sanity CLI loaded exactly one document function from the blueprint ${loadErrors}`).toBeDefined();
  const o = obs[name]!;
  console.log(`case ${name}:`, JSON.stringify(o));
  expect(o.unknown, `UNKNOWN (case ${name}): ${o.unknown.join('; ')}`).toEqual([]);
  expect(o.failed, `case ${name}: the runner reported a failure: ${o.tail}`).toBe(false);
  return strip(o.final!);
}
const slugOf = (d: Doc) => (d.slug as { current?: unknown } | undefined)?.current;
const withoutSlug = ({ slug: _slug, ...rest }: Doc) => rest;

test('A: a new post published without a slug ends with slug "hello-world" and nothing else changed', () => {
  const d = observe('A');
  expect(slugOf(d)).toBe('hello-world');
  expect(withoutSlug(d)).toEqual(strip(post('p1', 'Hello World')));
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
  const d = observe('E');
  expect(slugOf(d)).toBe('second-post');
  expect(withoutSlug(d)).toEqual(strip(post('p3', 'Second Post')));
});
