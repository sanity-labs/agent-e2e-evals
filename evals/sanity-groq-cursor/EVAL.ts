/**
 * Hidden grader for sanity-groq-cursor.
 * The agent's src/pagination.ts is transpiled and run in its own Node process with the permission model on, so it
 * never sees the hidden datasets: it only receives cursors and returns {query, params}. The grader runs each query
 * with groq-js (the pinned reference) over hidden datasets that change between pages, and compares every page with
 * a plain JavaScript walk of the same contract. Each case starts a fresh process, so no state carries between cases.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { evaluate, parse } from 'groq-js';
import ts from 'typescript';
import { expect, test } from 'vitest';

type Doc = { _id: string; _type: string; title: string; publishedAt?: string };
type Cursor = { _id: string; publishedAt: string | null };
type Change = { beforePage: number; add?: Doc[]; remove?: string[] };
type Case = { name: string; docs: Doc[]; changes?: Change[] };

const post = (_id: string, publishedAt: string | null, title = `Title of ${_id}`): Doc =>
  publishedAt === null ? { _id, _type: 'post', title } : { _id, _type: 'post', title, publishedAt };
const other = (_id: string, _type: string, publishedAt: string): Doc => ({ _id, _type, title: _id, publishedAt });
const at = (day: number, hour = 9) => `2026-04-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;

// Ids are not correlated with dates, so a walk ordered by _id alone looks wrong at once.
const CASES: Case[] = [
  {
    name: 'plain walk, other document types mixed in',
    docs: [
      post('q7pd', at(28)),
      post('a3kx', at(27)),
      post('m0zt', at(25)),
      post('c9wb', at(24)),
      post('x2fe', at(22)),
      post('h5ls', at(21)),
      post('b8nq', at(19)),
      post('t1vy', at(18)),
      post('e4gr', at(16)),
      post('w6jc', at(14)),
      post('k2ud', at(12)),
      post('d7oh', at(11)),
      other('author-1', 'author', at(30)),
      other('page-1', 'page', at(20)),
      other('cat-1', 'category', at(13)),
    ],
  },
  {
    name: 'six posts share one publishedAt across a page boundary; ends on a full page',
    docs: [
      post('n4ab', at(29)),
      post('r8tie', at(26)),
      post('f2tie', at(26)),
      post('z9tie', at(26)),
      post('a1tie', at(26)),
      post('p5tie', at(26)),
      post('k3tie', at(26)),
      post('g6cd', at(23)),
      post('u0ef', at(20)),
      post('c7gh', at(17)),
    ],
  },
  {
    name: 'a post is created ahead of the cursor between pages (not expected in this walk)',
    docs: [
      post('j3aa', at(28)),
      post('v8bb', at(26)),
      post('c1cc', at(25)),
      post('s6dd', at(23)),
      post('h2ee', at(21)),
      post('y9ff', at(20)),
      post('b4gg', at(18)),
      post('m7hh', at(15)),
      post('e0ii', at(12)),
    ],
    changes: [{ beforePage: 2, add: [post('new-ahead', at(30)), post('new-ahead-tie', at(23))] }],
  },
  {
    name: 'posts are created behind the cursor between pages (each expected once)',
    docs: [
      post('j3aa', at(28)),
      post('v8bb', at(26)),
      post('c1cc', at(25)),
      post('s6dd', at(23)),
      post('h2ee', at(21)),
      post('y9ff', at(20)),
      post('b4gg', at(18)),
      post('m7hh', at(15)),
      post('e0ii', at(12)),
      post('o5jj', null),
    ],
    changes: [
      { beforePage: 2, add: [post('new-behind', at(19)), post('a0-same-time', at(21)), post('new-undated', null)] },
    ],
  },
  {
    name: 'an already-returned post is deleted between pages',
    docs: [
      post('j3aa', at(28)),
      post('v8bb', at(26)),
      post('c1cc', at(25)),
      post('s6dd', at(23)),
      post('h2ee', at(21)),
      post('y9ff', at(20)),
      post('b4gg', at(18)),
      post('m7hh', at(15)),
      post('e0ii', at(12)),
      post('l2kk', at(10)),
      post('r3ll', at(8)),
    ],
    changes: [{ beforePage: 2, remove: ['v8bb', 'j3aa'] }],
  },
  {
    name: 'the cursor post itself is deleted between pages',
    docs: [
      post('j3aa', at(28)),
      post('v8bb', at(26)),
      post('c1cc', at(25)),
      post('s6dd', at(23)),
      post('h2ee', at(21)),
      post('h1tie', at(21)),
      post('b4gg', at(18)),
      post('m7hh', at(15)),
      post('e0ii', at(12)),
      post('l2kk', at(10)),
      post('r3ll', at(8)),
      post('q9mm', null),
      post('d4nn', null),
    ],
    changes: [
      { beforePage: 2, remove: ['h2ee'] },
      { beforePage: 3, remove: ['l2kk'] },
    ],
  },
  {
    name: 'posts without publishedAt come after all dated posts, across two pages',
    docs: [
      post('x1aa', at(27)),
      post('d2bb', at(24)),
      post('p3cc', at(21)),
      post('a4dd', at(18)),
      post('m5ee', at(15)),
      post('z7un', null),
      post('b2un', null),
      post('q8un', null),
      post('k5un', null),
      post('e1un', null),
      post('t6un', null),
      post('g3un', null),
    ],
  },
  {
    name: 'posts are created and deleted before every later page, including in the undated tail',
    docs: [
      post('d01', at(28)),
      post('d02', at(27)),
      post('d03', at(26)),
      post('d04', at(25)),
      post('d05', at(24)),
      post('d06', at(23)),
      post('d07', at(22)),
      post('d08', at(21)),
      post('d09', at(20)),
      post('d10', at(19)),
      post('d11', at(18)),
      post('d12', at(16)),
      post('u90', null),
      post('u80', null),
      post('u70', null),
      post('u60', null),
      post('u50', null),
      post('u40', null),
      post('u30', null),
      post('u20', null),
    ],
    changes: [
      { beforePage: 3, remove: ['d07'], add: [post('d115', at(17))] },
      { beforePage: 4, remove: ['u90'], add: [post('u35', null)] },
      { beforePage: 5, remove: ['u50'], add: [post('u10', null)] },
      { beforePage: 6, remove: ['u30'], add: [post('u05', null)] },
    ],
  },
  { name: 'no posts at all', docs: [other('author-1', 'author', at(30)), other('page-1', 'page', at(20))] },
];

// The contract, in plain JavaScript: dated posts first (newest first), then undated; ties by _id, all descending.
const key = (document: { _id: string; publishedAt?: string | null }) =>
  [document.publishedAt ? 1 : 0, document.publishedAt ?? '', document._id] as const;
const before = (left: Doc | Cursor, right: Doc | Cursor) => {
  const [leftKey, rightKey] = [key(left), key(right)];
  for (const [i, part] of leftKey.entries()) {
    const otherPart = rightKey[i] as typeof part;
    if (part !== otherPart) return part > otherPart;
  }
  return false;
};

async function hostPagination(load: (specifier: string) => Promise<any>, moduleSpecifier: string) {
  const { createInterface } = process.getBuiltinModule('node:readline');
  const output = (outcome: Record<string, unknown>) => process.stdout.write('\u0001R' + JSON.stringify(outcome) + '\n');
  let module: any;
  let loadError: string | undefined;
  try {
    module = await load(moduleSpecifier);
  } catch (error) {
    loadError = 'the module failed to load: ' + (error as Error).message;
  }
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    if (loadError) {
      output({ error: loadError });
      continue;
    }
    try {
      const functionName = message.cursor === undefined ? 'firstPage' : 'nextPage';
      if (typeof module[functionName] !== 'function') {
        output({ error: 'no exported function ' + functionName });
        continue;
      }
      const result = message.cursor === undefined ? module.firstPage() : module.nextPage(message.cursor);
      output({ ok: JSON.parse(JSON.stringify(result === undefined ? null : result)) });
    } catch (error) {
      output({ error: 'threw: ' + (error as Error).message });
    }
  }
}

function loadAgent(): { js?: string; problem?: string } {
  const file = resolve('src/pagination.ts');
  if (!existsSync(file)) return { problem: 'src/pagination.ts is missing' };
  const js = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const imports = ts.preProcessFile(js, true, true).importedFiles.map((file) => file.fileName);
  if (imports.length)
    return { problem: `src/pagination.ts imports ${imports.join(', ')}, which the task does not allow` };
  return { js };
}

async function walk(testCase: Case, js: string): Promise<{ ok: boolean; log: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-'));
  writeFileSync(join(dir, 'pagination.mjs'), js);
  const hostSource = `(${hostPagination.toString()})((specifier) => import(specifier), './pagination.mjs');`;
  if (/__vite_ssr|__vi_/.test(hostSource)) throw new Error('pagination host source contains a Vitest transform marker');
  writeFileSync(join(dir, 'host.mjs'), hostSource);
  const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${dir}`, join(dir, 'host.mjs')], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '' },
  });
  let stderr = '';
  child.stderr.on('data', (buffer) => (stderr += buffer));
  const replies = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const call = async (cursor?: Cursor) => {
    child.stdin.write(JSON.stringify(cursor === undefined ? {} : { cursor }) + '\n');
    const deadline = new Promise<never>((_, no) =>
      setTimeout(() => no(new Error('no reply within 5 s')), 5000).unref(),
    );
    for (;;) {
      const reply = await Promise.race([replies.next(), deadline]);
      if (reply.done) throw new Error('the module process exited: ' + stderr.slice(0, 300));
      if (reply.value.startsWith('\u0001R'))
        return JSON.parse(reply.value.slice(2)) as { ok?: unknown; error?: string };
    }
  };
  const log: string[] = [];
  const fail = (why: string) => (log.push('FAIL: ' + why), { ok: false, log });
  try {
    const live = new Map(testCase.docs.map((document) => [document._id, document]));
    let cursor: Cursor | undefined;
    const seen = new Set<string>();
    for (let page = 1; page <= 12; page++) {
      for (const change of testCase.changes ?? []) {
        if (change.beforePage !== page) continue;
        for (const id of change.remove ?? []) live.delete(id);
        for (const document of change.add ?? []) live.set(document._id, document);
      }
      const dataset = [...live.values()];
      const expected = dataset
        .filter((document) => document._type === 'post' && (!cursor || before(cursor, document)))
        .sort((left, right) => (before(left, right) ? -1 : 1))
        .slice(0, 5);
      let reply;
      try {
        reply = await call(cursor);
      } catch (error) {
        return fail(`page ${page}: ${(error as Error).message}`);
      }
      if (reply.error) return fail(`page ${page}: ${reply.error}`);
      const pq = reply.ok as { query?: unknown; params?: unknown } | null;
      if (!pq || typeof pq.query !== 'string')
        return fail(`page ${page}: did not return {query, params} with a string query`);
      const params = (pq.params ?? {}) as Record<string, unknown>;
      if (typeof params !== 'object' || Array.isArray(params)) return fail(`page ${page}: params is not an object`);
      log.push(`page ${page} query: ${pq.query} params: ${JSON.stringify(params)}`);
      let rows: unknown;
      try {
        rows = await (await evaluate(parse(pq.query, { params }), { dataset, params })).get();
      } catch (error) {
        return fail(`page ${page}: groq-js could not run the query: ${(error as Error).message}`);
      }
      if (!Array.isArray(rows)) return fail(`page ${page}: the query did not return an array`);
      const ids = rows.map((row) => (row && typeof row === 'object' ? (row as { _id?: unknown })._id : row));
      const want = expected.map((document) => document._id);
      log.push(`page ${page} got [${ids.join(', ')}] expected [${want.join(', ')}]`);
      const repeated = ids.filter((id) => seen.has(id as string));
      if (repeated.length) return fail(`page ${page} repeats ${repeated.join(', ')}`);
      if (JSON.stringify(ids) !== JSON.stringify(want)) return fail(`page ${page} differs from the expected page`);
      for (const row of rows as Array<Record<string, unknown>>) {
        const document = live.get(row._id as string)!;
        const extra = Object.keys(row).filter((field) => !['_id', 'title', 'publishedAt'].includes(field));
        if (extra.length)
          return fail(`page ${page}: rows have fields beyond _id, title, publishedAt: ${extra.join(', ')}`);
        if (row.title !== document.title || (row.publishedAt ?? null) !== (document.publishedAt ?? null))
          return fail(`page ${page}: row ${document._id} has the wrong title or publishedAt`);
        seen.add(document._id);
      }
      if (!rows.length) return { ok: true, log };
      const last = rows.at(-1) as Record<string, unknown>;
      cursor = { _id: last._id as string, publishedAt: (last.publishedAt as string | undefined) ?? null };
    }
    return fail('no empty page after 12 pages');
  } finally {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
}

const agent = loadAgent();
for (const testCase of CASES) {
  test(
    testCase.name,
    async () => {
      if (agent.problem) {
        console.log(`OUTCOME case="${testCase.name}" got=FAIL ${agent.problem}`);
        expect.fail(agent.problem);
      }
      const { ok, log } = await walk(testCase, agent.js!);
      console.log(`OUTCOME case="${testCase.name}" got=${ok ? 'PASS' : 'FAIL'}\n${log.join('\n')}`);
      expect(ok, log.at(-1)).toBe(true);
    },
    30000,
  );
}
