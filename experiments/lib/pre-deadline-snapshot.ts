import type { Sandbox, SetupFunction } from '@vercel/agent-eval';

/**
 * Best-effort evidence for attempts that hit the native time limit. agent-eval deletes the
 * sandbox on timeout and OpenCode's transcript is only parsed after it exits, so a timed-out
 * attempt otherwise leaves nothing to read. Shortly before the deadline this reads, without
 * stopping anything, OpenCode's own session export and the changed files.
 *
 * Not recovery: the native limit is unchanged, nothing here is graded, the snapshot is not
 * atomic or replayable, work after `snapshotAt` is missing, and the attempt may still succeed.
 * Everything read from the sandbox is untrusted (the agent controls its files, and could even
 * replace `opencode`); output is bounded here and scrubbed by the caller before it is written.
 */

const LEAD_MS = 60_000; // snapshot this long before the deadline
const BUDGET_MS = 45_000; // whole capture, every command included
const EXPORT_CAP = 4 * 1024 * 1024;
const LIST_CAP = 1024 * 1024;
// The agent runs as the image's non-root user and can write to the npm bin dir at the front of PATH,
// so our helpers are called by root-owned absolute paths. OpenCode itself lives in that writable dir
// (we call the same one the agent runs), so everything it prints is untrusted.
const NODE = '/usr/local/bin/node';
const TIMEOUT = '/usr/bin/timeout';

/** Counts live `opencode run` processes by reading /proc (the image has no ps). */
function countLiveOpenCodeRuns(): void {
  const fileSystem = process.getBuiltinModule('node:fs');
  let count = 0;
  for (const processName of fileSystem.readdirSync('/proc')) {
    if (!/^\d+$/.test(processName)) continue;
    let arguments_: string[];
    try {
      arguments_ = fileSystem.readFileSync(`/proc/${processName}/cmdline`, 'utf8').split('\0');
    } catch {
      continue;
    }
    if (
      arguments_.some(
        (argument, index) => index < 2 && /(^|\/)opencode(\.exe)?$/.test(argument) && arguments_[index + 1] === 'run',
      )
    )
      count++;
  }
  process.stdout.write(String(count));
}

/**
 * Runs a command in the sandbox with stdout capped there (stderr discarded), so the host never buffers
 * more than the cap. Prints { ok:true, text } or { ok:false, reason }; over the cap counts as a failure.
 * stdout goes to a fresh private temp file, not a pipe: OpenCode 1.19.5 exits 0 with its export cut
 * off at 128-384 KiB when stdout is a pipe, and whole when it is a file.
 * The file is bounded by the child's file-size limit (ulimit -f, 512-byte blocks), so going over the
 * cap ends the command (SIGXFSZ) instead of filling the disk; the limit also covers any other file the
 * command writes, which then fails safe as over the cap. The limit rounds up to whole blocks, so up to
 * cap+512 bytes can reach the disk. The temp dir is removed when this script returns or throws; if the
 * script itself is killed (for example SIGKILL), the dir stays in the sandbox's temp directory.
 * Args: cap cwd command...
 */
export function runCappedCommand(): void {
  const [cap, cwd, command, ...arguments_] = process.argv.slice(1);
  const fileSystem = process.getBuiltinModule('node:fs');
  const operatingSystem = process.getBuiltinModule('node:os');
  const path = process.getBuiltinModule('node:path');
  const childProcess = process.getBuiltinModule('node:child_process');
  const output = (value: unknown) => process.stdout.write(JSON.stringify(value));
  const directory = fileSystem.mkdtempSync(path.join(operatingSystem.tmpdir(), 'snap-'));
  const file = path.join(directory, 'out');
  let fileDescriptor: number | undefined;
  try {
    fileDescriptor = fileSystem.openSync(file, 'wx', 0o600);
    const blocks = String(Math.ceil((Number(cap) + 1) / 512));
    const result = childProcess.spawnSync(
      '/bin/sh',
      ['-c', 'ulimit -f "$0" && exec "$@"', blocks, command!, ...arguments_],
      { cwd, stdio: ['ignore', fileDescriptor, 'ignore'] },
    );
    fileSystem.closeSync(fileDescriptor);
    fileDescriptor = undefined;
    const size = fileSystem.statSync(file).size;
    if (result.error) output({ ok: false, reason: 'did not run' });
    else if (result.signal === 'SIGXFSZ' || size > Number(cap)) output({ ok: false, reason: 'output over cap' });
    else if (result.status !== 0) output({ ok: false, reason: `exited ${result.status}` });
    else output({ ok: true, text: fileSystem.readFileSync(file, 'utf8') });
  } finally {
    if (fileDescriptor !== undefined) fileSystem.closeSync(fileDescriptor);
    fileSystem.rmSync(directory, { recursive: true, force: true });
  }
}

/** The export is kept only if it parses and names the selected session, the workspace and no parent. */
function checkExport(text: string, id: string, cwd: string): string | undefined {
  const parsed = parseJson(text, '{');
  if (parsed === undefined) return `export not valid JSON (${Buffer.byteLength(text)} bytes)`;
  const info = parsed?.info;
  if (!info || info.id !== id || info.directory !== cwd || 'parentID' in info)
    return 'export does not match the selected root session';
  return undefined;
}

/**
 * Changed files from git status, read with no symlinks anywhere in the path (realpath must equal
 * the plain path, final open with O_NOFOLLOW, same inode after open), each and all bytes capped
 * while reading. Nothing under .git, node_modules, __agent_eval__ or any .env* name is read, whatever
 * .gitignore says, and binary files (any NUL byte) are skipped rather than encoded, so the caller's
 * text scrubber sees everything kept; a truncated file is cut back to its last whitespace so no token is
 * left half-kept. git runs without optional locks (it must not block the agent's own git), with the
 * agent's fsmonitor hook disabled and the work tree pinned. Args: root perFile total maxFiles.
 */
export function readChangedFiles(): void {
  const fileSystem = process.getBuiltinModule('node:fs');
  const path = process.getBuiltinModule('node:path');
  const childProcess = process.getBuiltinModule('node:child_process');
  const root = process.argv[1]!;
  const perFile = Number(process.argv[2]);
  const total = Number(process.argv[3]);
  const maxFiles = Number(process.argv[4]);
  const output: {
    files: Record<string, { text: string }>;
    deleted: string[];
    skipped: Array<{ path: string; reason: string }>;
    skippedMore: number;
    truncated: string[];
    bytes: number;
    error?: string;
  } = { files: {}, deleted: [], skipped: [], skippedMore: 0, truncated: [], bytes: 0 };
  const realRoot = fileSystem.realpathSync(root);
  const environment = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_DIR: path.join(root, '.git'),
    GIT_WORK_TREE: root,
  };
  const status = childProcess.spawnSync(
    '/usr/bin/git',
    ['-c', 'core.fsmonitor=', 'status', '--porcelain', '-z', '-uall'],
    { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 },
  );
  if (status.status !== 0) {
    output.error = 'git status failed';
    process.stdout.write(JSON.stringify(output));
    process.exit(0);
  }
  const statusEntries = status.stdout.toString('utf8').split('\0');
  const entries: string[] = [];
  let bytesLeft = total;
  let filesRead = 0;
  for (let i = 0; i < statusEntries.length; i++) {
    const entry = statusEntries[i]!;
    if (entry.length < 4) continue;
    entries.push(entry);
    if (/[RC]/.test(entry.slice(0, 2))) i++;
  }
  // Tracked changes first, so a large untracked build tree cannot use up the budget before them.
  entries.sort((left, right) => (left.startsWith('??') ? 1 : 0) - (right.startsWith('??') ? 1 : 0));
  const skip = (filePath: string, reason: string) => {
    if (output.skipped.length < 200) output.skipped.push({ path: filePath, reason });
    else output.skippedMore++;
  };
  for (const entry of entries) {
    const statusCode = entry.slice(0, 2);
    const relativePath = entry.slice(3);
    const segments = relativePath.split('/');
    if (relativePath.startsWith('/') || segments.some((segment) => ['', '.', '..'].includes(segment))) {
      skip(relativePath, 'unsafe path');
      continue;
    }
    if (segments.some((segment) => ['.git', 'node_modules', '__agent_eval__'].includes(segment))) {
      skip(relativePath, 'excluded folder');
      continue;
    }
    if (segments.some((segment) => segment.startsWith('.env'))) {
      skip(relativePath, 'env file');
      continue;
    }
    if (statusCode.includes('D')) {
      output.deleted.push(relativePath);
      continue;
    }
    if (filesRead >= maxFiles || bytesLeft <= 0) {
      skip(relativePath, 'budget');
      continue;
    }
    const filePath = path.join(realRoot, relativePath);
    let fileDescriptor: number | undefined;
    try {
      if (fileSystem.realpathSync(filePath) !== filePath) throw new Error('symlink in path');
      const linkStat = fileSystem.lstatSync(filePath);
      if (!linkStat.isFile()) throw new Error('not a regular file');
      fileDescriptor = fileSystem.openSync(filePath, fileSystem.constants.O_RDONLY | fileSystem.constants.O_NOFOLLOW);
      const fileStat = fileSystem.fstatSync(fileDescriptor);
      if (fileStat.ino !== linkStat.ino || fileStat.dev !== linkStat.dev) throw new Error('changed while opening');
      const cap = Math.min(perFile, bytesLeft);
      const buffer = Buffer.alloc(cap + 1);
      let bytesRead = 0;
      let readSize: number;
      while (
        bytesRead < cap + 1 &&
        (readSize = fileSystem.readSync(fileDescriptor, buffer, bytesRead, cap + 1 - bytesRead, null)) > 0
      )
        bytesRead += readSize;
      const kept = buffer.subarray(0, Math.min(bytesRead, cap));
      bytesLeft -= kept.length;
      output.bytes += kept.length;
      filesRead++;
      if (kept.includes(0)) {
        skip(relativePath, 'binary');
        continue;
      }
      let text = kept.toString('utf8');
      if (bytesRead > cap) {
        output.truncated.push(relativePath);
        text = text.slice(0, Math.max(0, text.search(/\s\S*$/)));
      }
      output.files[relativePath] = { text };
    } catch (error) {
      skip(relativePath, String((error as Error).message).slice(0, 80));
    } finally {
      if (fileDescriptor !== undefined) fileSystem.closeSync(fileDescriptor);
    }
  }
  process.stdout.write(JSON.stringify(output));
}

export function serializeSnapshotHelper(function_: () => void): string {
  const source = `(${function_.toString()})()`;
  if (source.includes('__vite_ssr') || source.includes('__vi_')) throw new Error('unsafe transformed helper source');
  return source;
}

export interface SnapshotRecord {
  note: string;
  status: 'captured' | 'partial' | 'skipped';
  reason?: string;
  deadlineAt: string;
  snapshotAt?: string;
  collectionEndedAt?: string;
  session?: { id: string; export: string };
  files?: unknown;
  errors: string[];
}

interface Options {
  /** Wall-clock ms taken just before runExperiment: earlier than the native expiry (which also counts from later). */
  deadlineAt: number;
  leadMs?: number;
  budgetMs?: number;
}

/** One per attempt: wrap its setup, call `invocationEnded` from onRunComplete, `finish` after runExperiment. */
export function createPreDeadlineSnapshot({ deadlineAt, leadMs = LEAD_MS, budgetMs = BUDGET_MS }: Options) {
  let sandbox: Sandbox | undefined; // the newest sandbox setup saw (a native retry or the verifier replaces it)
  let closed = false;
  let record: SnapshotRecord | undefined;
  const at = (ms: number) => new Date(ms).toISOString();

  async function capture(activeSandbox: Sandbox, endBy: number) {
    const snapshotRecord: SnapshotRecord = {
      note: 'Best-effort diagnostic, never graded. Taken while the attempt was still running, before the native time limit; not atomic or replayable, misses all later work, and the attempt may still have succeeded.',
      status: 'skipped',
      deadlineAt: at(deadlineAt),
      snapshotAt: at(Date.now()),
      errors: [],
    };
    // Each command is bounded inside the sandbox (coreutils timeout kills only our helper) and here.
    const run = async (arguments_: string[]) => {
      const leftMs = endBy - Date.now();
      if (closed || leftMs < 1000) throw new Error('capture deadline reached');
      let timer: NodeJS.Timeout | undefined;
      const secs = String(Math.max(1, Math.floor(leftMs / 1000) - 1)); // the sandbox kills our helper first
      const call = activeSandbox.runCommand(TIMEOUT, ['-s', 'KILL', secs, ...arguments_], {
        cwd: activeSandbox.getWorkingDirectory(),
      });
      call.catch(() => {}); // a late rejection after we stop waiting must not go unhandled
      try {
        return await Promise.race([
          call,
          new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('command timed out')), leftMs))),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      const live = await run([NODE, '-e', serializeSnapshotHelper(countLiveOpenCodeRuns)]);
      if (live.stdout.trim() === '0' || live.exitCode !== 0) {
        snapshotRecord.reason = 'no live opencode run (the agent may have finished, or setup or grading is running)';
        return snapshotRecord;
      }
      const cwd = activeSandbox.getWorkingDirectory();
      const capped = async (cap: number, cmd: string[]) =>
        parseJson(
          (await run([NODE, '-e', serializeSnapshotHelper(runCappedCommand), String(cap), cwd, ...cmd])).stdout,
          '{',
        );
      const list = await capped(LIST_CAP, ['opencode', 'session', 'list', '--format', 'json']);
      const sessions = list?.ok === true && typeof list.text === 'string' ? parseJson(list.text, '[') : undefined;
      const ok = Array.isArray(sessions)
        ? sessions.filter((session) => session?.directory === cwd && !('parentID' in session))
        : [];
      if (
        !Array.isArray(sessions) ||
        sessions.length !== 1 ||
        ok.length !== 1 ||
        !/^ses_[A-Za-z0-9]+$/.test(ok[0].id)
      ) {
        snapshotRecord.reason = `capture skipped: expected exactly one root session in ${cwd}, found ${Array.isArray(sessions) ? sessions.length : 'unreadable list'}`;
        return snapshotRecord;
      }
      const id: string = ok[0].id;
      snapshotRecord.status = 'partial';
      try {
        // The id is a validated argument, never interpolated into the script.
        // Over the cap is a failure, not a truncated keep: no partial-JSON recovery.
        const exp = await capped(EXPORT_CAP, ['opencode', 'export', id]);
        const why =
          exp?.ok !== true || typeof exp.text !== 'string'
            ? `export failed: ${typeof exp?.reason === 'string' ? exp.reason.slice(0, 80) : 'unreadable'}`
            : checkExport(exp.text, id, cwd);
        if (why) snapshotRecord.errors.push(why);
        else snapshotRecord.session = { id, export: exp.text.slice(exp.text.indexOf('{')) };
      } catch (err) {
        snapshotRecord.errors.push(`export: ${(err as Error).message}`);
      }
      const files = await run([NODE, '-e', serializeSnapshotHelper(readChangedFiles), cwd, '262144', '2097152', '300']);
      const list2 = parseJson(files.stdout, '{');
      if (files.exitCode === 0 && list2 && typeof list2.files === 'object' && !list2.error)
        snapshotRecord.files = list2;
      else
        snapshotRecord.errors.push(
          `file list failed: ${typeof list2?.error === 'string' ? list2.error : 'unreadable'}`,
        );
    } catch (err) {
      snapshotRecord.errors.push((err as Error).message);
    }
    // 'captured' only with both the session export and the file list; anything less is 'partial'.
    if (snapshotRecord.status === 'partial' && snapshotRecord.session && snapshotRecord.files)
      snapshotRecord.status = 'captured';
    return snapshotRecord;
  }

  const fire = () => {
    const activeSandbox = sandbox;
    if (closed) return;
    if (!activeSandbox) {
      record = {
        note: 'No sandbox was live at the snapshot time.',
        status: 'skipped',
        reason: 'no live sandbox',
        deadlineAt: at(deadlineAt),
        snapshotAt: at(Date.now()),
        errors: [],
      };
      return;
    }
    capture(activeSandbox, Date.now() + budgetMs)
      .then((snapshotRecord) => {
        snapshotRecord.collectionEndedAt = at(Date.now());
        if (!closed) record = snapshotRecord; // a capture that outlives the attempt is dropped, never written late
      })
      .catch(() => {});
  };
  const timer = setTimeout(fire, Math.max(0, deadlineAt - leadMs - Date.now()));
  timer.unref();

  return {
    wrapSetup:
      (setup?: SetupFunction): SetupFunction =>
      async (activeSandbox) => {
        sandbox = activeSandbox;
        await setup?.(activeSandbox);
      },
    /** The invocation's sandboxes are gone once onRunComplete fires. */
    invocationEnded: () => {
      sandbox = undefined;
    },
    /** Stops the timer and returns what was captured; anything still running is discarded. */
    finish: (): SnapshotRecord | undefined => {
      closed = true;
      clearTimeout(timer);
      return record;
    },
  };
}

function parseJson(text: string, open: '[' | '{'): any {
  try {
    return JSON.parse(text.slice(text.indexOf(open)));
  } catch {
    return undefined;
  }
}
