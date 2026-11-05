/** Runtime grader for the cached Sanity webhook task. Hidden content is generated here and served by the protected shim. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';

type Doc = { _id: string; _type: 'post'; title: string; slug: { _type: 'slug'; current: string } };
const makePost = (id: string, slug: string, title: string): Doc => ({
  _id: id,
  _type: 'post',
  title,
  slug: { _type: 'slug', current: slug },
});
const X = 'hidden-webhook-post';
const A = [makePost('post-x', X, 'Alpine observatory'), makePost('post-y', 'quiet-forest', 'Quiet forest')];
const B = [makePost('post-x', X, 'Bright observatory'), makePost('post-y', 'quiet-forest', 'Quiet forest')];
const SECRET = 'grader-webhook-secret-8e4c';
const titleA = A[0].title;
const titleB = B[0].title;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ndjson = (docs: Doc[]) => `${docs.map((doc) => JSON.stringify(doc)).join('\n')}\n`;
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no free port'));
      server.close(() => resolve(address.port));
    });
  });
const signature = (raw: string, secret: string) => {
  const timestamp = Date.now();
  const digest = createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('base64url');
  return `t=${timestamp},v1=${digest}`;
};
const extractTitles = (html: string) => [...html.matchAll(/data-title="([^"]+)"/g)].map((match) => match[1]);

let build = { status: null as number | null, output: '', queries: 0 };
const results: Record<string, unknown> = {};
const children: ChildProcess[] = [];
let temp = '';

async function start(data: string, log: string, withSecret: boolean) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), SAMPLE_API_DATA: data, SAMPLE_API_LOG: log };
  if (withSecret) env.SANITY_REVALIDATE_SECRET = SECRET;
  else delete env.SANITY_REVALIDATE_SECRET;
  const child = spawn('npm', ['run', 'start', '--', '-p', String(port)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr?.on('data', (chunk) => {
    output += chunk;
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/posts`)).ok) return { child, base };
    } catch {
      /* starting */
    }
    if (child.exitCode !== null) throw new Error(`next start exited ${child.exitCode}: ${output.slice(-2000)}`);
    await sleep(100);
  }
  throw new Error(`next start was not ready: ${output.slice(-2000)}`);
}
async function stop(child: ChildProcess) {
  if (child.exitCode === null) child.kill('SIGTERM');
  for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(20);
  if (child.exitCode === null) child.kill('SIGKILL');
}
const readPages = async (base: string) => ({
  list: extractTitles(await (await fetch(`${base}/posts`)).text()),
  post: extractTitles(await (await fetch(`${base}/posts/${X}`)).text()),
});
const isTitle = (pages: Awaited<ReturnType<typeof readPages>>, title: string) =>
  pages.list.includes(title) && pages.post.includes(title);
async function repeated(base: string, title: string) {
  const reads = [];
  for (let i = 0; i < 5; i++) {
    reads.push(isTitle(await readPages(base), title));
    await sleep(200);
  }
  return reads.every(Boolean);
}
async function webhook(base: string, sent: string, signed: string | null, secret = SECRET) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signed !== null) headers['sanity-webhook-signature'] = signature(signed, secret);
  return fetch(`${base}/api/revalidate`, { method: 'POST', headers, body: sent });
}

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), 'sanity-webhook-grade-'));
  const data = join(temp, 'hidden.ndjson');
  const log = join(temp, 'requests.jsonl');
  writeFileSync(data, ndjson(A));
  writeFileSync(log, '');
  rmSync('.next', { recursive: true, force: true });
  const built = spawnSync('npm', ['run', 'build'], {
    env: { ...process.env, SAMPLE_API_DATA: data, SAMPLE_API_LOG: log },
    encoding: 'utf8',
    timeout: 90_000,
  });
  const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  build = {
    status: built.status,
    output: `${built.stdout}\n${built.stderr}`.slice(-5000),
    queries: lines.filter((line) => JSON.parse(line).ok).length,
  };
  if (build.status !== 0 || build.queries === 0) return;
  const clean = join(temp, 'clean-next');
  cpSync('.next', clean, { recursive: true });

  const first = await start(data, log, true);
  const initial = await readPages(first.base);
  results.initial = isTitle(initial, titleA);
  writeFileSync(data, ndjson(B));
  const witness = (await (await fetch(`${first.base}/api/sample-witness?slug=${X}`)).json()) as { title?: string };
  results.stale = witness.title === titleB && (await repeated(first.base, titleA));

  const raw = JSON.stringify({ _type: 'post', slug: X });
  const changed = JSON.stringify({ _type: 'post', slug: 'different-post' });
  const badResponses = [
    await webhook(first.base, changed, raw),
    await webhook(first.base, raw, raw, 'wrong-secret'),
    await webhook(first.base, raw, null),
    await fetch(`${first.base}/api/revalidate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sanity-webhook-signature': `t=${Date.now()}` },
      body: raw,
    }),
  ];
  results.bad =
    badResponses.every((response) => response.status >= 400 && response.status < 500) &&
    (await repeated(first.base, titleA));

  const valid = await webhook(first.base, raw, raw);
  let refreshed = false;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (isTitle(await readPages(first.base), titleB)) {
      refreshed = true;
      break;
    }
    await sleep(200);
  }
  results.valid = valid.ok && refreshed;
  await stop(first.child);

  rmSync('.next', { recursive: true, force: true });
  cpSync(clean, '.next', { recursive: true });
  writeFileSync(data, ndjson(A));
  writeFileSync(log, '');
  const second = await start(data, log, false);
  const warmed = isTitle(await readPages(second.base), titleA);
  writeFileSync(data, ndjson(B));
  const secondWitness = (await (await fetch(`${second.base}/api/sample-witness?slug=${X}`)).json()) as {
    title?: string;
  };
  const usual = await webhook(second.base, raw, raw);
  const empty = await webhook(second.base, raw, raw, '');
  results.unset =
    warmed && secondWitness.title === titleB && !usual.ok && !empty.ok && (await repeated(second.base, titleA));
  await stop(second.child);
}, 115_000);

afterAll(async () => {
  for (const child of children) await stop(child);
  if (temp) rmSync(temp, { recursive: true, force: true });
});

const buildGate = () => {
  expect(build.status, build.output).toBe(0);
  expect(build.queries, 'no successful query reached the local Sanity query API').toBeGreaterThan(0);
};
test('0: builds with hidden content fetched through the query API', buildGate);
test('1: starts with hidden A content on the list and post pages', () => {
  buildGate();
  expect(results.initial).toBe(true);
});
test('2: changed source is live but both cached pages remain at A', () => {
  buildGate();
  expect(results.stale).toBe(true);
});
test('3: invalid webhook requests are rejected and do not refresh either page', () => {
  buildGate();
  expect(results.bad).toBe(true);
});
test('4: a valid signed webhook refreshes the list and post pages', () => {
  buildGate();
  expect(results.valid).toBe(true);
});
test('5: an unset secret rejects usual and empty-secret signatures without refreshing', () => {
  buildGate();
  expect(results.unset).toBe(true);
});
