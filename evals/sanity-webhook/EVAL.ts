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
const titleA = 'Alpine observatory';
const titleB = 'Bright observatory';
const A = [makePost('post-x', X, titleA), makePost('post-y', 'quiet-forest', 'Quiet forest')];
const B = [makePost('post-x', X, titleB), makePost('post-y', 'quiet-forest', 'Quiet forest')];
const SECRET = 'grader-webhook-secret-8e4c';
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
const okQueries = (log: string) =>
  existsSync(log)
    ? readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .filter((line) => JSON.parse(line).ok).length
    : 0;
// Text content only (not a browser visibility check): drop scripts (Next's RSC payload repeats the data), styles, comments and tags, so attributes don't count.
const visibleText = (html: string) =>
  html
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');

let build = { status: null as number | null, output: '', queries: 0 };
const results: Record<string, unknown> = {};
const children: ChildProcess[] = [];
let temp = '';

async function start(data: string, log: string, withSecret: boolean) {
  const port = await freePort();
  // Same env as the fixture's start script; Next runs in its own process group so stop() also ends its server child.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_OPTIONS: '--import=./scripts/sample-api.mjs',
    SAMPLE_API_DATA: data,
    SAMPLE_API_LOG: log,
  };
  if (withSecret) env.SANITY_REVALIDATE_SECRET = SECRET;
  else delete env.SANITY_REVALIDATE_SECRET;
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], {
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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
const signalGroup = (child: ChildProcess, signal: NodeJS.Signals) => {
  try {
    if (child.pid) process.kill(-child.pid, signal);
  } catch {
    /* group already gone */
  }
};
async function stop(child: ChildProcess) {
  signalGroup(child, 'SIGTERM');
  for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await sleep(20);
  signalGroup(child, 'SIGKILL');
}
const readPages = async (base: string) => ({
  list: visibleText(await (await fetch(`${base}/posts`)).text()),
  post: visibleText(await (await fetch(`${base}/posts/${X}`)).text()),
});
// Both pages show this version's title and neither shows the other version's.
const isTitle = (pages: Awaited<ReturnType<typeof readPages>>, title: string) => {
  const other = title === titleA ? titleB : titleA;
  return [pages.list, pages.post].every((text) => text.includes(title) && !text.includes(other));
};
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
  build = { status: built.status, output: `${built.stdout}\n${built.stderr}`.slice(-5000), queries: 0 };
  if (build.status !== 0) return;
  const clean = join(temp, 'clean-next');
  cpSync('.next', clean, { recursive: true });

  const first = await start(data, log, true);
  const firstReadAt = Date.now();
  const initial = await readPages(first.base);
  // Content must come through the query API, at build time or on these first reads (before the witness route queries it).
  build.queries = okQueries(log);
  if (build.queries === 0) return;
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
  results.badStatuses = badResponses.map((response) => response.status);
  results.bad = await repeated(first.base, titleA);

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
  const refreshAfter = Date.now() - firstReadAt;
  await stop(first.child);

  rmSync('.next', { recursive: true, force: true });
  cpSync(clean, '.next', { recursive: true });
  writeFileSync(data, ndjson(A));
  writeFileSync(log, '');
  const second = await start(data, log, false);
  const secondReadAt = Date.now();
  const warmed = isTitle(await readPages(second.base), titleA);
  writeFileSync(data, ndjson(B));
  const secondWitness = (await (await fetch(`${second.base}/api/sample-witness?slug=${X}`)).json()) as {
    title?: string;
  };
  const usual = await webhook(second.base, raw, raw);
  const empty = await webhook(second.base, raw, raw, '');
  results.unsetStatuses = [usual.status, empty.status];
  let held = warmed && secondWitness.title === titleB;
  while (held && Date.now() < secondReadAt + refreshAfter + 10_000) {
    held = isTitle(await readPages(second.base), titleA);
    await sleep(500);
  }
  results.unset = held;
  await stop(second.child);
}, 150_000);

afterAll(async () => {
  for (const child of children) await stop(child);
  if (temp) rmSync(temp, { recursive: true, force: true });
});

const buildGate = () => {
  expect(build.status, build.output).toBe(0);
  expect(
    build.queries,
    'no successful query reached the local Sanity query API during the build or the first page reads',
  ).toBeGreaterThan(0);
};
test('0: builds, and hidden content is fetched through the query API', buildGate);
test('1: starts with hidden A content on the list and post pages', () => {
  buildGate();
  expect(results.initial).toBe(true);
});
test('2: changed source is live but both cached pages remain at A', () => {
  buildGate();
  expect(results.stale).toBe(true);
});
test('3: invalid webhook requests do not refresh either page', () => {
  buildGate();
  expect(results.bad).toBe(true);
});
test('4: a valid signed webhook refreshes the list and post pages', () => {
  buildGate();
  expect(results.valid).toBe(true);
});
test('5: with no secret set, signed requests refresh nothing for longer than the valid refresh took', () => {
  buildGate();
  expect(results.unset).toBe(true);
});
