// Diagnostic build for the scaffolded app, run by the grader as `npm run build`.
// It installs the app's dependencies, runs Next.js in compile-only mode, then the
// project's TypeScript check. It does not prerender pages, so it needs no Sanity
// project, env vars or token, and it says nothing about whether the app reaches
// its Sanity project. Supported layouts: a Next.js app in ./app, or a workspace
// root in ./app whose workspace has Next.js (the clean template).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const pkg = (dir) => JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const hasNext = (dir) => existsSync(join(dir, 'package.json')) && 'next' in { ...pkg(dir).dependencies, ...pkg(dir).devDependencies };
const root = 'app';
const workspaces = existsSync(join(root, 'package.json')) ? (pkg(root).workspaces ?? []) : [];
const nextDir = hasNext(root) ? root : workspaces.map((w) => join(root, w)).find(hasNext);
if (!nextDir) {
  console.error('No supported layout: expected ./app or one of its workspaces to depend on next');
  process.exit(1);
}
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
const bin = (name) => [nextDir, root].map((d) => resolve(d, 'node_modules/.bin', name)).find(existsSync) ?? fail(`${name} is not installed in ${nextDir}`);
const run = (cwd, cmd, args) => {
  console.log(`$ (cd ${cwd} && ${cmd} ${args.join(' ')})`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', timeout: 900_000 });
  if (r.status !== 0) {
    console.error(`failed: ${r.error?.message ?? r.signal ?? `exit ${r.status}`}`);
    process.exit(1);
  }
};
run(root, 'npm', ['install', '--no-audit', '--no-fund']);
run(nextDir, bin('next'), ['build', '--experimental-build-mode', 'compile']);
run(nextDir, bin('tsc'), ['--noEmit']);
