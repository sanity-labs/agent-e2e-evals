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
const NODE = '/usr/local/bin/node'; // absolute: the agent can write to the npm global bin dir on PATH

/** Counts live `opencode run` processes by reading /proc (the image has no ps). */
const LIVE_SCRIPT = `const fs=require('fs');let n=0;for(const p of fs.readdirSync('/proc')){if(!/^\\d+$/.test(p))continue;let a;try{a=fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0')}catch{continue}if(a.some((x,i)=>i<2&&/(^|\\/)opencode(\\.exe)?$/.test(x)&&a[i+1]==='run'))n++}process.stdout.write(String(n))`;

/**
 * Changed files from git status, read with no symlinks anywhere in the path (realpath must equal
 * the plain path, final open with O_NOFOLLOW, same inode after open), each and all bytes capped
 * while reading. Env files and anything under .git are never read. Args: root perFile total maxFiles.
 */
export const FILES_SCRIPT = `const fs=require('fs'),path=require('path'),cp=require('child_process');
const [root,per,total,maxFiles]=[process.argv[1],+process.argv[2],+process.argv[3],+process.argv[4]];
const out={files:{},deleted:[],skipped:[],truncated:[],bytes:0};const realRoot=fs.realpathSync(root);
const st=cp.spawnSync('/usr/bin/git',['status','--porcelain','-z','-uall'],{cwd:root,maxBuffer:1<<20});
if(st.status!==0){out.error='git status failed';process.stdout.write(JSON.stringify(out));process.exit(0)}
const t=st.stdout.toString('utf8').split('\\0');let left=total,n=0;
for(let i=0;i<t.length;i++){const e=t[i];if(e.length<4)continue;const xy=e.slice(0,2),rel=e.slice(3);if(/[RC]/.test(xy))i++;
 const segs=rel.split('/');
 if(rel.startsWith('/')||segs.some(s=>s===''||s==='.'||s==='..'||s==='.git')){out.skipped.push({path:rel,reason:'unsafe path'});continue}
 if(path.basename(rel).startsWith('.env')){out.skipped.push({path:rel,reason:'env file'});continue}
 if(xy.includes('D')){out.deleted.push(rel);continue}
 if(n>=maxFiles||left<=0){out.skipped.push({path:rel,reason:'budget'});continue}
 const p=path.join(realRoot,rel);let fd;
 try{if(fs.realpathSync(p)!==p)throw new Error('symlink in path');const ls=fs.lstatSync(p);if(!ls.isFile())throw new Error('not a regular file');
  fd=fs.openSync(p,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);const fst=fs.fstatSync(fd);if(fst.ino!==ls.ino||fst.dev!==ls.dev)throw new Error('changed while opening');
  const cap=Math.min(per,left),buf=Buffer.alloc(cap+1);let got=0,r;while(got<cap+1&&(r=fs.readSync(fd,buf,got,cap+1-got,null))>0)got+=r;
  const keep=buf.subarray(0,Math.min(got,cap));if(got>cap)out.truncated.push(rel);left-=keep.length;out.bytes+=keep.length;n++;
  const text=keep.includes(0)?null:keep.toString('utf8');out.files[rel]=text===null?{base64:keep.toString('base64')}:{text};
 }catch(err){out.skipped.push({path:rel,reason:String(err.message).slice(0,80)})}finally{if(fd!==undefined)fs.closeSync(fd)}}
process.stdout.write(JSON.stringify(out));`;

export interface SnapshotRecord {
  note: string;
  status: 'captured' | 'partial' | 'skipped';
  reason?: string;
  deadlineAt: string;
  snapshotAt?: string;
  collectionEndedAt?: string;
  session?: { id: string; export: string; truncated: boolean };
  files?: unknown;
  errors: string[];
}

interface Options {
  /** Wall-clock ms by which the native limit will certainly have fired (or later). */
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

  async function capture(sb: Sandbox, endBy: number) {
    const rec: SnapshotRecord = {
      note: 'Best-effort diagnostic, never graded. Taken while the attempt was still running, before the native time limit; not atomic or replayable, misses all later work, and the attempt may still have succeeded.',
      status: 'skipped',
      deadlineAt: at(deadlineAt),
      snapshotAt: at(Date.now()),
      errors: [],
    };
    // Each command is bounded inside the sandbox (coreutils timeout kills only our helper) and here.
    const run = async (args: string[]) => {
      const leftMs = endBy - Date.now();
      if (closed || leftMs < 1000) throw new Error('capture deadline reached');
      let timer: NodeJS.Timeout | undefined;
      const secs = String(Math.max(1, Math.floor(leftMs / 1000) - 1)); // the sandbox kills our helper first
      const call = sb.runCommand('timeout', ['-s', 'KILL', secs, ...args], { cwd: sb.getWorkingDirectory() });
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
      const live = await run([NODE, '-e', LIVE_SCRIPT]);
      if (live.stdout.trim() === '0' || live.exitCode !== 0) {
        rec.reason = 'no live opencode run (the agent may have finished, or setup or grading is running)';
        return rec;
      }
      const list = await run(['opencode', 'session', 'list', '--format', 'json']);
      const sessions = parseJson(list.stdout, '[');
      const cwd = sb.getWorkingDirectory();
      const ok = Array.isArray(sessions) ? sessions.filter((s) => s?.directory === cwd && !('parentID' in s)) : [];
      if (
        !Array.isArray(sessions) ||
        sessions.length !== 1 ||
        ok.length !== 1 ||
        !/^ses_[A-Za-z0-9]+$/.test(ok[0].id)
      ) {
        rec.reason = `capture skipped: expected exactly one root session in ${cwd}, found ${Array.isArray(sessions) ? sessions.length : 'unreadable list'}`;
        return rec;
      }
      const id: string = ok[0].id;
      rec.status = 'partial';
      try {
        // The id is a validated argument, never interpolated into the script.
        const exp = await run(['sh', '-c', `opencode export "$1" 2>/dev/null | head -c ${EXPORT_CAP + 1}`, 'sh', id]);
        rec.session = { id, export: exp.stdout.slice(0, EXPORT_CAP), truncated: exp.stdout.length > EXPORT_CAP };
      } catch (err) {
        rec.errors.push(`export: ${(err as Error).message}`);
      }
      const files = await run([NODE, '-e', FILES_SCRIPT, cwd, '262144', '2097152', '300']);
      rec.files = parseJson(files.stdout, '{') ?? { error: 'unreadable file list' };
    } catch (err) {
      rec.errors.push((err as Error).message);
    }
    // 'captured' only with both the session export and the file list; anything less is 'partial'.
    if (rec.status === 'partial' && rec.session && rec.files) rec.status = 'captured';
    return rec;
  }

  const fire = () => {
    const sb = sandbox;
    if (closed) return;
    if (!sb) {
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
    capture(sb, Date.now() + budgetMs)
      .then((rec) => {
        rec.collectionEndedAt = at(Date.now());
        if (!closed) record = rec; // a capture that outlives the attempt is dropped, never written late
      })
      .catch(() => {});
  };
  const timer = setTimeout(fire, Math.max(0, deadlineAt - leadMs - Date.now()));
  timer.unref();

  return {
    wrapSetup:
      (setup?: SetupFunction): SetupFunction =>
      async (sb) => {
        sandbox = sb;
        await setup?.(sb);
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
