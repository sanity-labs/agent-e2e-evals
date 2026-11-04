/**
 * Pre-deadline snapshot: skip rules, caps, the capture deadline and late-write cancellation, with a
 * fake sandbox (no Docker, no model, no network). FILES_SCRIPT runs for real on a temp git repo.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sandbox } from '@vercel/agent-eval';
import { afterAll, expect, test } from 'vitest';
import { createPreDeadlineSnapshot, FILES_SCRIPT } from './pre-deadline-snapshot.ts';

const CWD = '/home/sandbox/workspace';
type Reply = { stdout: string; exitCode?: number } | 'hang';
const session = (extra = {}) => ({ id: 'ses_abc123', directory: CWD, ...extra });

/** Answers by the command behind `timeout -s KILL N`; records every call. */
function fakeSandbox(replies: { live?: Reply; list?: Reply; export?: Reply; files?: Reply }) {
  const calls: string[][] = [];
  const sandbox = {
    getWorkingDirectory: () => CWD,
    runCommand: async (cmd: string, args: string[] = []) => {
      calls.push([cmd, ...args]);
      const inner = args.slice(3);
      const kind =
        inner[0] === 'opencode' ? 'list' : inner[0] === 'sh' ? 'export' : inner[2] === FILES_SCRIPT ? 'files' : 'live';
      const r = replies[kind] ?? { stdout: '' };
      if (r === 'hang') return new Promise<never>(() => {});
      return { stdout: r.stdout, stderr: '', exitCode: r.exitCode ?? 0 };
    },
  } as unknown as Sandbox;
  return { sandbox, calls };
}

/** Starts a snapshot that fires almost at once, hands it the sandbox through setup, and waits. */
async function snap(
  sb: Sandbox,
  { waitMs = 200, budgetMs = 5000, end = (_s: ReturnType<typeof createPreDeadlineSnapshot>) => {} } = {},
) {
  const s = createPreDeadlineSnapshot({ deadlineAt: Date.now() + 60_020, budgetMs });
  await s.wrapSetup(async () => {})(sb);
  end(s);
  await new Promise((r) => setTimeout(r, waitMs));
  return s.finish();
}

const ok = {
  live: { stdout: '1' },
  list: { stdout: JSON.stringify([session()]) },
  export: { stdout: 'Exporting session\n{"messages":[]}' },
  files: { stdout: '{"files":{"a.ts":{"text":"x"}}}' },
};

test('captures the session export and files, labelled as a pre-deadline diagnostic', async () => {
  const { sandbox, calls } = fakeSandbox(ok);
  const rec = await snap(sandbox);
  expect(rec?.status).toBe('captured');
  expect(rec?.session).toEqual({ id: 'ses_abc123', export: 'Exporting session\n{"messages":[]}', truncated: false });
  expect(rec?.files).toEqual({ files: { 'a.ts': { text: 'x' } } });
  expect(rec?.note).toMatch(/never graded/);
  expect(Date.parse(rec!.snapshotAt!)).toBeLessThan(Date.parse(rec!.deadlineAt));
  expect(rec?.collectionEndedAt).toBeDefined();
  // Every command is bounded inside the sandbox; the session id is an argument, not part of the script.
  for (const c of calls) expect(c.slice(0, 3)).toEqual(['timeout', '-s', 'KILL']);
  expect(calls.find((c) => c[4] === 'sh')?.slice(-2)).toEqual(['sh', 'ses_abc123']);
});

test.each([
  ['no live opencode run', { ...ok, live: { stdout: '0' } }, /no live opencode run/],
  [
    'two sessions',
    { ...ok, list: { stdout: JSON.stringify([session(), session({ id: 'ses_two' })]) } },
    /exactly one root session.*found 2/,
  ],
  [
    'a subagent session',
    { ...ok, list: { stdout: JSON.stringify([session({ parentID: 'ses_x' })]) } },
    /exactly one root session/,
  ],
  [
    'another directory',
    { ...ok, list: { stdout: JSON.stringify([session({ directory: '/tmp' })]) } },
    /exactly one root session/,
  ],
  [
    'an unsafe session id',
    { ...ok, list: { stdout: JSON.stringify([session({ id: 'ses_1; rm -rf /' })]) } },
    /exactly one root session/,
  ],
  ['an unreadable list', { ...ok, list: { stdout: 'nope' } }, /unreadable list/],
])('skips, without exporting, on %s', async (_name, replies, reason) => {
  const { sandbox, calls } = fakeSandbox(replies);
  const rec = await snap(sandbox);
  expect(rec?.status).toBe('skipped');
  expect(rec?.reason).toMatch(reason);
  expect(calls.some((c) => c[4] === 'sh')).toBe(false);
});

test('caps the export size', async () => {
  const { sandbox } = fakeSandbox({ ...ok, export: { stdout: 'x'.repeat(4 * 1024 * 1024 + 1) } });
  const rec = await snap(sandbox, { waitMs: 400 });
  expect(rec?.session?.export.length).toBe(4 * 1024 * 1024);
  expect(rec?.session?.truncated).toBe(true);
});

test('a hung command ends at the capture deadline, keeping what was read', async () => {
  const { sandbox } = fakeSandbox({ ...ok, files: 'hang' });
  const rec = await snap(sandbox, { budgetMs: 1500, waitMs: 1800 });
  expect(rec?.status).toBe('partial');
  expect(rec?.session?.id).toBe('ses_abc123');
  expect(rec?.errors.join()).toMatch(/command timed out|capture deadline reached/);
  expect(rec?.files).toBeUndefined();
});

test('a capture still running when the attempt ends is discarded, never written late', async () => {
  const { sandbox } = fakeSandbox({ ...ok, list: 'hang' });
  const s = createPreDeadlineSnapshot({ deadlineAt: Date.now() + 60_020, budgetMs: 1500 });
  await s.wrapSetup(async () => {})(sandbox);
  await new Promise((r) => setTimeout(r, 100));
  expect(s.finish()).toBeUndefined();
  await new Promise((r) => setTimeout(r, 1700)); // the hung command's bound fires after finish
  expect(s.finish()).toBeUndefined();
});

test('nothing is captured after the invocation ends, or when the attempt ends first', async () => {
  const { sandbox, calls } = fakeSandbox(ok);
  const rec = await snap(sandbox, { end: (s) => s.invocationEnded() });
  expect(rec).toMatchObject({ status: 'skipped', reason: 'no live sandbox' });
  expect(calls).toEqual([]);

  const early = createPreDeadlineSnapshot({ deadlineAt: Date.now() + 60_300 });
  await early.wrapSetup(async () => {})(fakeSandbox(ok).sandbox);
  expect(early.finish()).toBeUndefined();
});

test('setup still runs inside the wrapper, and its errors still fail the attempt', async () => {
  const s = createPreDeadlineSnapshot({ deadlineAt: Date.now() + 600_000 });
  let ran = false;
  await s.wrapSetup(async () => void (ran = true))(fakeSandbox(ok).sandbox);
  expect(ran).toBe(true);
  await expect(
    s.wrapSetup(async () => Promise.reject(new Error('install failed')))(fakeSandbox(ok).sandbox),
  ).rejects.toThrow('install failed');
  s.finish();
});

const dir = mkdtempSync(join(tmpdir(), 'snap-files-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test('the file reader skips env files, symlinks and symlinked parents, and caps bytes while reading', () => {
  const repo = join(dir, 'repo');
  const outside = join(dir, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'SECRET-OUTSIDE');
  mkdirSync(repo);
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo });
  git('init', '-q');
  writeFileSync(join(repo, 'gone.ts'), 'old');
  git('add', '.');
  git('commit', '-qm', 'init');
  rmSync(join(repo, 'gone.ts'));
  writeFileSync(join(repo, 'small.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'big.ts'), 'b'.repeat(50));
  writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 1, 2]));
  writeFileSync(join(repo, '.env'), 'TOKEN=real');
  writeFileSync(join(repo, '.env.local'), 'TOKEN=real');
  symlinkSync(join(outside, 'secret.txt'), join(repo, 'link.txt'));
  symlinkSync(outside, join(repo, 'linkdir'));
  mkdirSync(join(repo, 'sub'));
  writeFileSync(join(repo, 'sub', 'z.ts'), 'z'.repeat(30));
  writeFileSync(join(repo, 'sub', 'name with space.ts'), 'ok');

  const run = (per: number, total: number, max = 300) =>
    JSON.parse(
      execFileSync(process.execPath, ['-e', FILES_SCRIPT, repo, String(per), String(total), String(max)], {
        encoding: 'utf8',
      }),
    );
  const out = run(20, 1000);
  expect(out.files['small.ts']).toEqual({ text: 'export const a = 1;\n' });
  expect(out.files['big.ts']).toEqual({ text: 'b'.repeat(20) });
  expect(out.truncated).toEqual(expect.arrayContaining(['big.ts', 'sub/z.ts']));
  expect(out.files['bin.dat']).toEqual({ base64: Buffer.from([0, 1, 2]).toString('base64') });
  expect(out.files['sub/name with space.ts']).toEqual({ text: 'ok' });
  expect(out.deleted).toEqual(['gone.ts']);
  const skipped = Object.fromEntries(out.skipped.map((s: { path: string; reason: string }) => [s.path, s.reason]));
  expect(skipped['.env']).toBe('env file');
  expect(skipped['.env.local']).toBe('env file');
  expect(skipped['link.txt']).toMatch(/symlink|not a regular file/);
  expect(JSON.stringify(out)).not.toContain('SECRET-OUTSIDE');
  expect(JSON.stringify(out)).not.toContain('TOKEN=real');

  const tight = run(20, 25);
  expect(tight.bytes).toBeLessThanOrEqual(25);
  expect(tight.skipped.some((s: { reason: string }) => s.reason === 'budget')).toBe(true);
  expect(run(1000, 1000, 1).bytes).toBeLessThanOrEqual(1000);
  expect(Object.keys(run(1000, 1000, 1).files)).toHaveLength(1);
});
