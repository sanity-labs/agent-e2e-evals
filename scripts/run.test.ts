/**
 * Boundary tests for our run wrapper: spend stops, input validation and key
 * redaction. OpenRouter is replaced by a stubbed fetch and every case stops
 * before an agent starts, so nothing here touches the network or a model.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, expect, test, vi } from 'vitest';
import { SLUG_HINT } from '../experiments/gpt-5.6-terra-slug-hint.ts';
import { main, TASK_OPTIONS } from './run.ts';

vi.setConfig({ testTimeout: 60_000 });

const root = resolve(import.meta.dirname, '..');
const dir = mkdtempSync(join(tmpdir(), 'run-test-'));
const keyFile = join(dir, 'key');
const FAKE_KEY = 'sk-or-FAKE-MARKER-123';
writeFileSync(keyFile, FAKE_KEY);
afterAll(() => rmSync(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

test('the App SDK read fixture replays only the answer file to the verifier', () => {
  expect(TASK_OPTIONS['sanity-appsdk-read']?.protectedPaths).toEqual(['!src/PostList.tsx']);
});

test('the GROQ cursor fixture replays only the answer file to the verifier', () => {
  expect(TASK_OPTIONS['sanity-groq-cursor']?.protectedPaths).toEqual(['!src/pagination.ts']);
});

test('the Portable Text fixture replays only the Studio config and schema types to the verifier', () => {
  expect(TASK_OPTIONS['sanity-portable-text']?.protectedPaths).toEqual(['!{sanity.config.ts,schemaTypes/**}']);
});

async function run(mode: string, extraArgs: string[] = [], extraEnv: Record<string, string> = {}) {
  const resultsRoot = join(root, 'results');
  mkdirSync(resultsRoot, { recursive: true });
  const existingResults = new Set(readdirSync(resultsRoot));
  let usageCalls = 0;
  let sanityCalls = 0;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get('Authorization');
    const ok = (data: unknown) => new Response(JSON.stringify({ data }));
    if (url.startsWith('https://api.sanity.work/')) {
      sanityCalls++;
      if (extraEnv.SANITY_MODE === 'throws') throw new Error(`boom ${authorization}`);
      if (extraEnv.SANITY_MODE === 'no-ids') return new Response('[{}]');
      const before = [{ id: 'old1', displayName: `Old ${authorization}` }];
      return new Response(JSON.stringify(sanityCalls === 1 ? before : [...before, { id: 'new1' }, { id: 'bos8r3z6' }]));
    }
    usageCalls++;
    if (mode === 'throws-at-start') throw new Error(`boom ${authorization}`);
    if (usageCalls === 1) return ok({ usage: 10, usage_monthly: 10 });
    switch (mode) {
      case 'down':
        return new Response('down', { status: 503 });
      case 'malformed':
        return ok({ usage: 'lots' });
      case 'cap':
        return ok({ usage: 11, usage_monthly: 11 });
      case 'attempt':
        return ok({ usage: 10.5, usage_monthly: 10.5 });
      case 'month':
        return ok({ usage: 760, usage_monthly: 760 });
      case 'throws':
        throw new Error(`boom ${authorization}`);
      default:
        throw new Error(`unexpected mode ${mode}`);
    }
  });
  const priorEnvironment = { ...process.env };
  process.env.SANITY_AUTH_TOKEN = extraEnv.SANITY_AUTH_TOKEN ?? '';
  try {
    const resultsDir = await main([
      '--key-file',
      keyFile,
      '--evals',
      'sanity-typegen',
      '--runs',
      '2',
      '--cap',
      '1',
      ...extraArgs,
      'experiments/claude-haiku-5.5.ts',
    ]);
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
        attempts: Array<{ skipped?: string; experiment: string; run: number; promptSha256?: string }>;
        stagingProjectsNewlyObserved: Array<{ id: string }> | null;
      },
    };
  } catch (err) {
    return { error: String(err) };
  } finally {
    process.env = priorEnvironment;
    for (const entry of readdirSync(resultsRoot))
      if (!existingResults.has(entry)) rmSync(join(resultsRoot, entry), { recursive: true, force: true });
  }
}

const expectStoppedBeforeAnyAttempt = (result: Awaited<ReturnType<typeof run>>, reason: RegExp) => {
  if (!('manifest' in result) || !result.manifest)
    throw new Error(`run failed: ${'error' in result ? result.error : ''}`);
  expect(result.manifest.stopped).toMatch(reason);
  expect(result.manifest.attempts).toHaveLength(2);
  expect(result.manifest.attempts.every((attempt) => attempt.skipped)).toBe(true);
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

test('the per-attempt stop stops new attempts when spend between checks is too high', async () => {
  expectStoppedBeforeAnyAttempt(
    await run('attempt', ['--attempt-stop', '0.25']),
    /\$0\.50 was spent since the previous spend check, over the \$0\.25 per-attempt stop/,
  );
});

test('paired experiments alternate round by round instead of running as two blocks', async () => {
  const result = await run('cap', ['experiments/claude-haiku-5.5-skills.ts']);
  if (!('manifest' in result) || !result.manifest)
    throw new Error(`run failed: ${'error' in result ? result.error : ''}`);
  expect(result.manifest.attempts.map((attempt) => `${attempt.experiment}#${attempt.run}`)).toEqual([
    'claude-haiku-5.5-skills#1',
    'claude-haiku-5.5#1',
    'claude-haiku-5.5#2',
    'claude-haiku-5.5-skills#2',
  ]);
});

test('each attempt records the hash of the prompt it sends, including an experiment editPrompt', async () => {
  const result = await run('cap', ['experiments/gpt-5.6-terra-slug-hint.ts']);
  if (!('manifest' in result) || !result.manifest)
    throw new Error(`run failed: ${'error' in result ? result.error : ''}`);
  const prompt = readFileSync(join(root, 'evals/sanity-typegen/PROMPT.md'), 'utf8');
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  const bySha = Object.fromEntries(
    result.manifest.attempts.map((attempt) => [attempt.experiment, attempt.promptSha256]),
  );
  expect(bySha['claude-haiku-5.5']).toBe(sha(prompt));
  expect(bySha['gpt-5.6-terra-slug-hint']).toBe(sha(`${prompt.trimEnd()}\n\n${SLUG_HINT}\n`));
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
  [['--attempt-stop', '0'], /--attempt-stop must be a positive number/],
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
