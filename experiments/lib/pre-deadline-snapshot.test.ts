/**
 * Pre-deadline snapshot: skip rules, caps, the capture deadline and late-write cancellation, with a
 * fake sandbox (no Docker, no model, no network). CAPPED_SCRIPT and FILES_SCRIPT run for real.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sandbox } from '@vercel/agent-eval';
import { afterAll, expect, test } from 'vitest';
import { CAPPED_SCRIPT, createPreDeadlineSnapshot, FILES_SCRIPT } from './pre-deadline-snapshot.ts';

const CWD = '/home/sandbox/workspace';
/** For list and export, stdout is what opencode printed; the fake wraps it as CAPPED_SCRIPT would. */
type Reply = { stdout: string; exitCode?: number; overCap?: boolean } | 'hang';
const session = (extra = {}) => ({ id: 'ses_abc123', directory: CWD, ...extra });
const exported = (info: unknown) => `Exporting session\n${JSON.stringify({ info, messages: [] })}`;

/** Answers by the command behind `timeout -s KILL N`; records every call. */
function fakeSandbox(replies: { live?: Reply; list?: Reply; export?: Reply; files?: Reply }) {
  const calls: string[][] = [];
  const sandbox = {
    getWorkingDirectory: () => CWD,
    runCommand: async (cmd: string, args: string[] = []) => {
      calls.push([cmd, ...args]);
      const inner = args.slice(3);
      const capped = inner[2] === CAPPED_SCRIPT;
      const kind = capped ? (inner[6] === 'export' ? 'export' : 'list') : inner[2] === FILES_SCRIPT ? 'files' : 'live';
      const r = replies[kind] ?? { stdout: '' };
      if (r === 'hang') return new Promise<never>(() => {});
      if (!capped) return { stdout: r.stdout, stderr: '', exitCode: r.exitCode ?? 0 };
      const wrapped = r.overCap
        ? { ok: false, reason: 'output over cap' }
        : r.exitCode
          ? { ok: false, reason: `exited ${r.exitCode}` }
          : { ok: true, text: r.stdout };
      return { stdout: JSON.stringify(wrapped), stderr: '', exitCode: 0 };
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
  export: { stdout: exported(session()) },
  files: { stdout: '{"files":{"a.ts":{"text":"x"}}}' },
};
const isExport = (c: string[]) => c.includes('export');

test('captures the session export and files, labelled as a pre-deadline diagnostic', async () => {
  const { sandbox, calls } = fakeSandbox(ok);
  const rec = await snap(sandbox);
  expect(rec?.status).toBe('captured');
  expect(rec?.session).toEqual({ id: 'ses_abc123', export: JSON.stringify({ info: session(), messages: [] }) });
  expect(rec?.files).toEqual({ files: { 'a.ts': { text: 'x' } } });
  expect(rec?.note).toMatch(/never graded/);
  expect(Date.parse(rec!.snapshotAt!)).toBeLessThan(Date.parse(rec!.deadlineAt));
  expect(rec?.collectionEndedAt).toBeDefined();
  // Every command is bounded inside the sandbox by absolute path; the session id is an argument.
  for (const c of calls) expect(c.slice(0, 3)).toEqual(['/usr/bin/timeout', '-s', 'KILL']);
  expect(calls.find(isExport)?.slice(-3)).toEqual(['opencode', 'export', 'ses_abc123']);
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
  ['a list over the size cap', { ...ok, list: { stdout: '', overCap: true } }, /unreadable list/],
  ['a failed list', { ...ok, list: { stdout: JSON.stringify([session()]), exitCode: 1 } }, /unreadable list/],
])('skips, without exporting, on %s', async (_name, replies, reason) => {
  const { sandbox, calls } = fakeSandbox(replies);
  const rec = await snap(sandbox);
  expect(rec?.status).toBe('skipped');
  expect(rec?.reason).toMatch(reason);
  expect(calls.some(isExport)).toBe(false);
});

test.each([
  ['another directory', { stdout: exported(session({ directory: '/tmp' })) }],
  ['a child session', { stdout: exported(session({ parentID: 'ses_p' })) }],
  ['a different session id', { stdout: exported(session({ id: 'ses_other' })) }],
  ['malformed JSON', { stdout: 'Exporting session\n{"info":' }],
  ['an empty failed export', { stdout: '', exitCode: 1 }],
  ['an export over the size cap', { stdout: '', overCap: true }],
])('does not keep an export of %s; the files are still kept, as partial', async (_name, reply) => {
  const { sandbox } = fakeSandbox({ ...ok, export: reply });
  const rec = await snap(sandbox);
  expect(rec?.session).toBeUndefined();
  expect(rec?.status).toBe('partial');
  expect(rec?.errors.join()).toMatch(/export/);
  expect(rec?.files).toBeDefined();
});

test.each([
  ['a failed git status', { stdout: '{"files":{},"error":"git status failed"}' }, /git status failed/],
  ['unreadable output', { stdout: 'garbage' }, /unreadable/],
])('a file list from %s is not kept and the record is partial', async (_name, files, reason) => {
  const { sandbox } = fakeSandbox({ ...ok, files });
  const rec = await snap(sandbox);
  expect(rec?.status).toBe('partial');
  expect(rec?.files).toBeUndefined();
  expect(rec?.errors.join()).toMatch(reason);
  expect(rec?.session?.id).toBe('ses_abc123');
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

test('the capped runner keeps output only when the command succeeds within the cap, without stderr', () => {
  const run = (cap: number, script: string) =>
    JSON.parse(
      execFileSync(process.execPath, ['-e', CAPPED_SCRIPT, String(cap), dir, '/bin/sh', '-c', script], {
        encoding: 'utf8',
      }),
    );
  expect(run(100, 'echo hello; echo noise >&2')).toEqual({ ok: true, text: 'hello\n' });
  expect(run(100, 'head -c 101 /dev/zero')).toEqual({ ok: false, reason: 'output over cap' });
  expect(run(100, 'echo partial; exit 1')).toEqual({ ok: false, reason: 'exited 1' });
  expect(run(100, 'head -c 5000000 /dev/zero >&2; echo ok')).toEqual({ ok: true, text: 'ok\n' });
});

test('the file reader skips excluded folders, env names, binaries and symlinks, and caps bytes while reading', () => {
  const repo = join(dir, 'repo');
  const outside = join(dir, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'SECRET-OUTSIDE');
  mkdirSync(repo);
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: repo });
  git('init', '-q');
  writeFileSync(join(repo, 'gone.ts'), 'old');
  writeFileSync(join(repo, 'zz-app.ts'), 'old');
  git('add', '.');
  git('commit', '-qm', 'init');
  rmSync(join(repo, 'gone.ts'));
  writeFileSync(join(repo, 'zz-app.ts'), 'changed');
  writeFileSync(join(repo, 'small.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'big.ts'), 'b'.repeat(50));
  // A key cut by the cap must not survive in part: the cut goes back to the last whitespace.
  writeFileSync(join(repo, 'cut.ts'), 'const k = sk-or-v1-CUTKEYCUTKEYCUTKEY');
  // Binary content would bypass the text scrubber if encoded, so it is skipped.
  writeFileSync(join(repo, 'bin.dat'), Buffer.concat([Buffer.from([0]), Buffer.from('sk-or-v1-BINARYKEY')]));
  writeFileSync(join(repo, '.env'), 'TOKEN=real');
  writeFileSync(join(repo, '.env.local'), 'TOKEN=real');
  mkdirSync(join(repo, '.env.saved'));
  writeFileSync(join(repo, '.env.saved', 'config.txt'), 'TOKEN=real');
  symlinkSync(join(outside, 'secret.txt'), join(repo, 'link.txt'));
  symlinkSync(outside, join(repo, 'linkdir'));
  mkdirSync(join(repo, 'sub'));
  writeFileSync(join(repo, 'sub', 'z.ts'), 'z'.repeat(30));
  writeFileSync(join(repo, 'sub', 'name with space.ts'), 'ok');
  // No .gitignore here: node_modules and the harness folder must still be skipped.
  mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'DEPENDENCY');
  mkdirSync(join(repo, 'web', 'node_modules'), { recursive: true });
  writeFileSync(join(repo, 'web', 'node_modules', 'x.js'), 'DEPENDENCY');
  mkdirSync(join(repo, '__agent_eval__'));
  writeFileSync(join(repo, '__agent_eval__', 'run.mjs'), 'HARNESS');

  const run = (per: number, total: number, max = 300) =>
    JSON.parse(
      execFileSync(process.execPath, ['-e', FILES_SCRIPT, repo, String(per), String(total), String(max)], {
        encoding: 'utf8',
      }),
    );
  const out = run(20, 1000);
  expect(out.files['small.ts']).toEqual({ text: 'export const a = 1;\n' });
  expect(out.files['big.ts']).toEqual({ text: '' });
  expect(out.files['cut.ts']).toEqual({ text: 'const k =' });
  expect(out.truncated).toEqual(expect.arrayContaining(['big.ts', 'cut.ts', 'sub/z.ts']));
  expect(out.files['sub/name with space.ts']).toEqual({ text: 'ok' });
  expect(out.deleted).toEqual(['gone.ts']);
  const skipped = Object.fromEntries(out.skipped.map((s: { path: string; reason: string }) => [s.path, s.reason]));
  expect(skipped['bin.dat']).toBe('binary');
  expect(skipped['.env']).toBe('env file');
  expect(skipped['.env.local']).toBe('env file');
  expect(skipped['.env.saved/config.txt']).toBe('env file');
  expect(skipped['node_modules/pkg/index.js']).toBe('excluded folder');
  expect(skipped['web/node_modules/x.js']).toBe('excluded folder');
  expect(skipped['__agent_eval__/run.mjs']).toBe('excluded folder');
  expect(skipped['link.txt']).toMatch(/symlink|not a regular file/);
  const all = JSON.stringify(out);
  for (const s of ['SECRET-OUTSIDE', 'TOKEN=real', 'BINARYKEY', 'CUTKEY', 'DEPENDENCY', 'HARNESS', 'base64'])
    expect(all).not.toContain(s);

  // The agent's git config cannot run code or move the work tree during capture.
  const marker = join(dir, 'fsmonitor-ran');
  writeFileSync(join(dir, 'hook.sh'), `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  git('config', 'core.fsmonitor', join(dir, 'hook.sh'));
  git('config', 'core.worktree', '/usr');
  const hostile = run(20, 1000);
  expect(existsSync(marker)).toBe(false);
  expect(hostile.error).toBeUndefined();
  expect(hostile.files['small.ts']).toEqual({ text: 'export const a = 1;\n' });
  git('config', '--unset', 'core.fsmonitor');
  git('config', '--unset', 'core.worktree');

  // A large untracked tree (git status output over 1 MB) must not lose the list or crowd out a tracked change.
  mkdirSync(join(repo, 'build'));
  for (let i = 0; i < 12000; i++) writeFileSync(join(repo, 'build', `generated-file-with-a-long-name-${i}.js`), '');
  const many = run(20, 1000);
  expect(many.error).toBeUndefined();
  expect(many.files['zz-app.ts']).toEqual({ text: 'changed' });
  expect(many.skipped.length + many.skippedMore).toBeGreaterThan(11000);
  expect(many.skipped.length).toBeLessThanOrEqual(200);

  const tight = run(20, 25);
  expect(tight.bytes).toBeLessThanOrEqual(25);
  expect(tight.skipped.some((s: { reason: string }) => s.reason === 'budget')).toBe(true);
  expect(run(1000, 1000, 1).bytes).toBeLessThanOrEqual(1000);
  expect(Object.keys(run(1000, 1000, 1).files)).toHaveLength(1);
});
