/**
 * Boundary tests for our run wrapper: spend stops, input validation and key
 * redaction. OpenRouter is replaced by a stubbed fetch and every case stops
 * before an agent starts, so nothing here touches the network or a model.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, expect, test, vi } from 'vitest';

// Each test starts a real run.ts child process, which loads the agent-eval runner (5–18s on slow machines).
vi.setConfig({ testTimeout: 60_000 });

const root = resolve(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'run-test-'));
const keyFile = join(dir, 'key');
const FAKE_KEY = 'sk-or-FAKE-MARKER-123';
writeFileSync(keyFile, FAKE_KEY);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// First key check succeeds (batch start); later ones follow MODE. Errors echo the key, to test redaction.
const stub = `data:text/javascript,${encodeURIComponent(`
let n = 0;
let sanityCalls = 0;
globalThis.fetch = async (url, init) => {
  const ok = (data) => new Response(JSON.stringify({ data }));
  // Sanity staging project list: one project before the batch, a new one and the canary after.
  if (String(url).startsWith('https://api.sanity.work/')) {
    sanityCalls++;
    if (process.env.SANITY_MODE === 'throws') throw new Error('boom ' + init.headers.Authorization);
    if (process.env.SANITY_MODE === 'no-ids') return new Response('[{}]');
    // A project name that echoes the token, to test that snapshots are scrubbed.
    const before = [{ id: 'old1', displayName: 'Old ' + init.headers.Authorization }];
    return new Response(JSON.stringify(sanityCalls === 1 ? before : [...before, { id: 'new1' }, { id: 'bos8r3z6' }]));
  }
  n++;
  if (process.env.MODE === 'throws-at-start') throw new Error('boom ' + init.headers.Authorization);
  if (n === 1) return ok({ usage: 10, usage_monthly: 10 });
  switch (process.env.MODE) {
    case 'down': return new Response('down', { status: 503 });
    case 'malformed': return ok({ usage: 'lots' });
    case 'cap': return ok({ usage: 11, usage_monthly: 11 });
    case 'month': return ok({ usage: 760, usage_monthly: 760 });
    case 'throws': throw new Error('boom ' + init.headers.Authorization);
  }
};
`)}`;

async function run(mode: string, extraArgs: string[] = [], extraEnv: Record<string, string> = {}) {
  const args = ['--import', stub, 'scripts/run.ts', '--key-file', keyFile, '--evals', 'sanity-typegen', '--runs', '2'];
  try {
    const { stdout } = await promisify(execFile)(
      'node',
      [...args, '--cap', '1', ...extraArgs, 'experiments/claude-haiku-5.5.ts'],
      { cwd: root, env: { ...process.env, SANITY_AUTH_TOKEN: '', MODE: mode, ...extraEnv } },
    );
    const resultsDir = stdout.match(/Results in (.+)/)?.[1]?.trim();
    if (!resultsDir) throw new Error(`no results dir in output:\n${stdout}`);
    const raw = readFileSync(join(resultsDir, 'manifest.json'), 'utf8');
    const projectFiles = ['before', 'after'].map((when) => {
      try {
        return readFileSync(join(resultsDir, `staging-projects-${when}.json`), 'utf8');
      } catch {
        return null;
      }
    });
    rmSync(resultsDir, { recursive: true, force: true });
    return {
      raw,
      projectFiles,
      manifest: JSON.parse(raw) as {
        stopped: string | null;
        attempts: Array<{ skipped?: string }>;
        stagingProjectsNewlyObserved: Array<{ id: string }> | null;
      },
    };
  } catch (err) {
    return { error: String((err as { stderr?: string }).stderr ?? err) };
  }
}

const expectStoppedBeforeAnyAttempt = (result: Awaited<ReturnType<typeof run>>, reason: RegExp) => {
  if (!('manifest' in result) || !result.manifest)
    throw new Error(`run failed: ${'error' in result ? result.error : ''}`);
  expect(result.manifest.stopped).toMatch(reason);
  expect(result.manifest.attempts).toHaveLength(2);
  expect(result.manifest.attempts.every((a) => a.skipped)).toBe(true);
  expect(result.raw).not.toContain(FAKE_KEY);
};

test('a failed spend check stops the batch', async () => {
  expectStoppedBeforeAnyAttempt(await run('down'), /spend check failed.*HTTP 503/);
});

test('missing or non-numeric usage stops the batch', async () => {
  expectStoppedBeforeAnyAttempt(await run('malformed'), /no usable usage figures/);
});

test('the batch cap stops new attempts', async () => {
  expectStoppedBeforeAnyAttempt(await run('cap'), /batch spend \$1\.00 reached the \$1 cap/);
});

test("David's $750 monthly stop stops new attempts", async () => {
  expectStoppedBeforeAnyAttempt(await run('month'), /monthly spend \$760\.00 reached David's \$750 stop/);
});

test('the key never reaches the manifest, even inside an error', async () => {
  expectStoppedBeforeAnyAttempt(await run('throws'), /spend check failed.*boom Bearer \[REDACTED\]/);
});

test('the key never reaches stderr when the first spend check fails', async () => {
  const result = await run('throws-at-start');
  const error = 'error' in result ? (result.error ?? '') : 'ran';
  expect(error).toContain('boom Bearer [REDACTED]');
  expect(error).not.toContain(FAKE_KEY);
});

test.each([
  [['--runs', '0'], /--runs must be a positive integer/],
  [['--concurrency', '1.5'], /--concurrency must be a positive integer/],
  [['--cap', 'abc'], /--cap must be a non-negative number/],
])('rejects invalid input %j', async (args, message) => {
  const result = await run('cap', args);
  expect('error' in result ? result.error : 'ran').toMatch(message);
});

test('with a Sanity token, lists staging projects before and after and names new ones, never the canary', async () => {
  const SANITY_TOKEN = 'sk-SANITY-FAKE-MARKER-456';
  const result = await run('cap', [], { SANITY_AUTH_TOKEN: SANITY_TOKEN });
  if (!('manifest' in result) || !result.manifest)
    throw new Error(`run failed: ${'error' in result ? result.error : ''}`);
  expect(result.manifest.stagingProjectsNewlyObserved).toEqual([{ id: 'new1' }]);
  expect(result.projectFiles[0]).toContain('old1');
  expect(result.projectFiles[1]).toContain('bos8r3z6');
  for (const text of [result.raw, ...result.projectFiles]) expect(text).not.toContain(SANITY_TOKEN);
});

test.each([
  ['throws', /boom Bearer \[REDACTED\]/],
  ['no-ids', /not an array of projects with string IDs/],
])('a failed first project list (%s) stops before any attempt, without printing the token', async (mode, message) => {
  const SANITY_TOKEN = 'sk-SANITY-FAKE-MARKER-456';
  const result = await run('cap', [], { SANITY_AUTH_TOKEN: SANITY_TOKEN, SANITY_MODE: mode });
  const error = 'error' in result ? (result.error ?? '') : 'ran';
  expect(error).toMatch(message);
  expect(error).not.toContain(SANITY_TOKEN);
});

test('without a Sanity token, no projects are listed', async () => {
  const result = await run('cap');
  if (!('manifest' in result) || !result.manifest)
    throw new Error(`run failed: ${'error' in result ? result.error : ''}`);
  expect(result.manifest.stagingProjectsNewlyObserved).toBeNull();
  expect(result.projectFiles).toEqual([null, null]);
});
