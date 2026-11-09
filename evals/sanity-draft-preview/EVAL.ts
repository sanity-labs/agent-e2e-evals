/** Runtime grader for the draft-preview task. Hidden content, secrets and the read token are generated per run and served by the protected stand-in. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';

const nonce = randomBytes(3).toString('hex');
const TOKEN = `sk-grader-read-${randomBytes(12).toString('hex')}`;
const FRESH = `fresh-${randomBytes(8).toString('hex')}`;
const EXPIRED = `expired-${randomBytes(8).toString('hex')}`;
const post = (id: string, slug: string, title: string) => ({
  _id: id,
  _type: 'post',
  title,
  slug: { _type: 'slug', current: slug },
});
const T = {
  harbour: `Harbour lights ${nonce}`,
  orchard: `Orchard in autumn ${nonce}`,
  harbourDraft: `Harbour lights draft ${nonce}`,
  newOnly: `Never published ${nonce}`,
  harbour2: `Harbour at night ${nonce}`,
  harbourDraft2: `Harbour second draft ${nonce}`,
};
const secretDoc = (id: string, secret: string, updatedAt: Date) => ({
  _id: `sanity-preview-url-secret.${id}`,
  _type: 'sanity.previewUrlSecret',
  _updatedAt: updatedAt.toISOString(),
  secret,
  studioUrl: 'http://127.0.0.1:3333',
});
const content = (published: string, draft: string) => [
  post('post-harbour', 'harbour', published),
  post('post-orchard', 'orchard', T.orchard),
  post('drafts.post-harbour', 'harbour', draft),
  post('drafts.post-new', 'unpublished-walk', T.newOnly),
  secretDoc('fresh', FRESH, new Date()),
  secretDoc('expired', EXPIRED, new Date(Date.now() - 2 * 3600_000)),
];
const ndjson = (docs: object[]) => `${docs.map((doc) => JSON.stringify(doc)).join('\n')}\n`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
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
// Text content only: drop scripts (Next's RSC payload repeats the data), styles, comments and tags.
const visibleText = (html: string) =>
  html
    .replace(/<(script|style|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
const count = (text: string, needle: string) => text.split(needle).length - 1;

type Jar = Map<string, string>;
const seen: string[] = []; // every response body and header the grader received, for the token scan
let base = '';
async function get(path: string, jar?: Jar) {
  const headers: Record<string, string> = {};
  if (jar?.size) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  const response = await fetch(`${base}${path}`, { headers, redirect: 'manual' });
  const body = await response.text();
  const setCookies = response.headers.getSetCookie();
  seen.push(body, JSON.stringify([...response.headers]));
  if (jar)
    for (const line of setCookies) {
      const [pair = '', ...attrs] = line.split(';');
      const at = pair.indexOf('=');
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      const expired = attrs.some((attr) => {
        const [key = '', val = ''] = attr.trim().split('=');
        return (
          (key.toLowerCase() === 'max-age' && Number(val) <= 0) ||
          (key.toLowerCase() === 'expires' && Date.parse(val) < Date.now())
        );
      });
      if (expired || value === '') jar.delete(name);
      else jar.set(name, value);
    }
  return { status: response.status, location: response.headers.get('location'), setCookies, text: visibleText(body) };
}
const pages = async (jar?: Jar) => ({
  list: await get('/posts', jar),
  harbour: await get('/posts/harbour', jar),
  newOnly: await get('/posts/unpublished-walk', jar),
});
const DRAFTS = [T.harbourDraft, T.newOnly, T.harbourDraft2];
// Published only: the published harbour title expected, orchard listed, no draft title anywhere, draft-only page missing.
const publishedOnly = (p: Awaited<ReturnType<typeof pages>>, harbour: string) =>
  count(p.list.text, harbour) === 1 &&
  count(p.list.text, T.orchard) === 1 &&
  p.harbour.text.includes(harbour) &&
  p.newOnly.status === 404 &&
  [p.list, p.harbour, p.newOnly].every((page) => DRAFTS.every((title) => !page.text.includes(title)));
// Drafts: the draft harbour title replaces the published one, the draft-only post is listed and has a page, nothing twice.
const showsDrafts = (p: Awaited<ReturnType<typeof pages>>, draft: string, published: string[]) =>
  count(p.list.text, draft) === 1 &&
  count(p.list.text, T.newOnly) === 1 &&
  count(p.list.text, T.orchard) === 1 &&
  p.harbour.text.includes(draft) &&
  p.newOnly.status === 200 &&
  p.newOnly.text.includes(T.newOnly) &&
  [p.list, p.harbour].every((page) => published.every((title) => !page.text.includes(title)));
type Pages = Awaited<ReturnType<typeof pages>>;
// Same view as a visitor with no cookies: isolates one check from defects that other checks already measure.
const sameView = (a: Pages, b: Pages) =>
  a.list.text === b.list.text &&
  a.harbour.text === b.harbour.text &&
  a.newOnly.status === b.newOnly.status &&
  a.newOnly.text === b.newOnly.text;
const enablePath = (secret: string | null) =>
  `/api/draft-mode/enable?${new URLSearchParams({
    ...(secret === null ? {} : { 'sanity-preview-secret': secret }),
    'sanity-preview-pathname': '/posts/unpublished-walk',
  })}`;
const bypassSet = (setCookies: string[]) =>
  setCookies.some((line) => line.startsWith('__prerender_bypass=') && !line.startsWith('__prerender_bypass=;'));

let build = { status: null as number | null, output: '', queries: 0, typeError: '' };
const results: Record<string, unknown> = {};
let child: ChildProcess | undefined;
let temp = '';
const stop = async () => {
  if (!child?.pid) return;
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    try {
      process.kill(-child.pid, signal);
    } catch {
      /* group already gone */
    }
    for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await sleep(20);
  }
};
const listFiles = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? listFiles(path) : [path];
      })
    : [];

beforeAll(async () => {
  temp = mkdtempSync(join(tmpdir(), 'sanity-draft-preview-grade-'));
  const data = join(temp, 'hidden.ndjson');
  const log = join(temp, 'requests.jsonl');
  writeFileSync(data, ndjson(content(T.harbour, T.harbourDraft)));
  writeFileSync(log, '');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NEXT_TELEMETRY_DISABLED: '1',
    NODE_OPTIONS: '--import=./scripts/sample-api.mjs',
    SAMPLE_API_DATA: data,
    SAMPLE_API_LOG: log,
    SANITY_API_READ_TOKEN: TOKEN,
  };
  // Fail closed on a stale build: an old .next would be served instead of the agent's code.
  rmSync('.next', { recursive: true, force: true });
  if (existsSync('.next')) throw new Error('could not remove .next before building');
  const built = spawnSync('npm', ['run', 'build'], { env, encoding: 'utf8', timeout: 150_000 });
  build = { status: built.status, output: `${built.stdout}\n${built.stderr}`.slice(-5000), queries: 0, typeError: '' };
  if (build.status !== 0) return;
  // Typecheck directly with the installed compiler and the protected tsconfig: next.config can switch off Next's own check.
  const tsc = spawnSync('node_modules/.bin/tsc', ['--noEmit', '-p', 'tsconfig.json'], {
    encoding: 'utf8',
    timeout: 150_000,
  });
  if (tsc.status !== 0)
    build.typeError = `tsc --noEmit failed (exit ${tsc.status}): ${`${tsc.stdout}${tsc.stderr}${tsc.error ?? ''}`.slice(0, 1500)}`;
  if (build.typeError) return;

  const port = await freePort();
  child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(port)], {
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk) => (output += chunk));
  child.stderr?.on('data', (chunk) => (output += chunk));
  base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 150 && !ready; i++) {
    try {
      ready = (await fetch(`${base}/posts`)).status < 500;
    } catch {
      /* starting */
    }
    if (child.exitCode !== null) throw new Error(`next start exited ${child.exitCode}: ${output.slice(-2000)}`);
    if (!ready) await sleep(100);
  }
  if (!ready) throw new Error(`next start was not ready: ${output.slice(-2000)}`);

  const before = await pages();
  build.queries = readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .filter((line) => JSON.parse(line).ok).length;
  if (build.queries === 0) return;
  results.public = publishedOnly(before, T.harbour);

  // Rejected enable requests: none of them may start a preview session. Statuses are recorded, not graded.
  const rejected = [];
  for (const secret of [null, 'wrong-secret', EXPIRED]) {
    const jar: Jar = new Map();
    const response = await get(enablePath(secret), jar);
    rejected.push({
      secret: secret === null ? 'none' : secret === EXPIRED ? 'expired' : 'wrong',
      status: response.status,
      bypass: bypassSet(response.setCookies),
    });
    if (bypassSet(response.setCookies) || !sameView(await pages(jar), await pages())) results.rejectedLeak = true;
  }
  const forged: Jar = new Map([['__prerender_bypass', randomBytes(16).toString('hex')]]);
  if (!sameView(await pages(forged), await pages())) results.rejectedLeak = true;
  results.rejectedStatuses = rejected;
  results.rejects = !results.rejectedLeak;

  const preview: Jar = new Map();
  const enabled = await get(enablePath(FRESH), preview);
  results.enableResponse = { status: enabled.status, location: enabled.location };
  const target = enabled.location ? new URL(enabled.location, base) : null;
  results.enable =
    enabled.status >= 300 &&
    enabled.status < 400 &&
    target?.origin === new URL(base).origin &&
    target.pathname === '/posts/unpublished-walk' &&
    bypassSet(enabled.setCookies);
  // A valid secret with an off-site pathname must not redirect off-site (no open redirect).
  const offsite = await get(
    enablePath(FRESH).replace(
      encodeURIComponent('/posts/unpublished-walk'),
      encodeURIComponent('https://evil.example/x'),
    ),
  );
  results.offsiteLocation = offsite.location;
  if (offsite.location && new URL(offsite.location, base).origin !== new URL(base).origin) results.enable = false;
  // Count only queries made while preview pages render: the enable helper's own secret lookup is an authed raw query.
  const logBefore = readFileSync(log, 'utf8').length;
  results.drafts = showsDrafts(await pages(preview), T.harbourDraft, [T.harbour]);
  results.draftQueries = readFileSync(log, 'utf8')
    .slice(logBefore)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((r) => r.ok && r.authed && r.perspective !== 'published').length;
  if (!results.draftQueries) results.drafts = false;

  // Change both the published and the draft harbour post: normal visitors keep the cached published page, preview reads fresh.
  writeFileSync(data, ndjson(content(T.harbour2, T.harbourDraft2)));
  const previewAfter = showsDrafts(await pages(preview), T.harbourDraft2, [T.harbour, T.harbour2, T.harbourDraft]);
  const ordinaryAfter = await pages();
  results.cache = previewAfter && sameView(ordinaryAfter, before);

  const manifest = JSON.parse(readFileSync('.next/app-path-routes-manifest.json', 'utf8')) as Record<string, string>;
  for (const route of new Set(Object.values(manifest)))
    if (!route.includes('[') && !route.startsWith('/api/draft-mode/') && !route.startsWith('/_'))
      await get(route, preview);
  const disabled = await get('/api/draft-mode/disable', preview);
  results.disableStatus = disabled.status;
  const afterDisable = await pages(preview);
  const ordinaryNow = await pages();
  // Only meaningful if preview was on: a missing preview session can't count as turned off.
  results.disable =
    Boolean(results.drafts) && !preview.has('__prerender_bypass') && sameView(afterDisable, ordinaryNow);
  await stop();

  // Browser assets plus every response the grader received.
  const leaks = listFiles('.next/static').filter((file) => readFileSync(file, 'utf8').includes(TOKEN));
  results.tokenLeaks = [...leaks, ...(seen.some((body) => body.includes(TOKEN)) ? ['a fetched response'] : [])];
}, 240_000);

afterAll(async () => {
  await stop();
  if (temp) rmSync(temp, { recursive: true, force: true });
});

const buildGate = () => {
  expect(build.status, build.output).toBe(0);
  expect(build.typeError).toBe('');
  expect(
    build.queries,
    'no successful query reached the local Sanity query API during the build or the first page reads',
  ).toBeGreaterThan(0);
};
test('0: builds and typechecks, and hidden content is fetched through the query API', buildGate);
test('1: normal visitors see only published content', () => {
  buildGate();
  expect(results.public).toBe(true);
});
test('2: the enable route rejects a missing, wrong or expired preview secret', () => {
  buildGate();
  expect(results.rejects, JSON.stringify(results.rejectedStatuses)).toBe(true);
});
test('3: a valid preview secret turns preview on and redirects to the requested page', () => {
  buildGate();
  expect(results.enable, JSON.stringify({ enable: results.enableResponse, offsite: results.offsiteLocation })).toBe(
    true,
  );
});
test('4: preview shows drafts, including a never-published post, without duplicates', () => {
  buildGate();
  expect(results.drafts, `authenticated draft queries during preview: ${String(results.draftQueries)}`).toBe(true);
});
test('5: after content changes, normal visitors still get the cached published pages and preview gets fresh drafts', () => {
  buildGate();
  expect(results.cache).toBe(true);
});
test('6: the disable route turns preview off', () => {
  buildGate();
  expect(results.disable, `disable status ${String(results.disableStatus)}`).toBe(true);
});
test('7: the read token is absent from browser assets and every response fetched', () => {
  buildGate();
  expect(results.tokenLeaks).toEqual([]);
});
