/**
 * Hidden grader for the App SDK read-path task. The agent sees every file in an eval folder except EVAL.ts and
 * PROMPT.md, so the grader's helper programs are defined here and written out only at grading time.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect } from 'vitest';
type Groq = typeof import('groq-js');
type TestTools = {
  test: (name: string, body: () => Promise<void>) => void;
  expect: any;
  render: (element: unknown) => void;
  screen: {
    queryAllByRole: (role: string) => Array<{ textContent: string | null }>;
    findByRole: (role: string, options: { name: RegExp }) => Promise<unknown>;
  };
  fireEvent: { click: (element: unknown) => void };
  SanityApp: unknown;
  React: { createElement: (type: any, props?: any, ...children: any[]) => unknown };
  start: StartServer;
  loadList: () => Promise<any>;
};
type StandInDocument = {
  _id: string;
  _type: string;
  category?: string;
  title: string;
  publishedAt: string;
};
type RequestRecord = {
  method: string;
  url: string;
  auth?: string | undefined;
  body?: string | undefined;
  status: number;
  result?: string;
};
type StartServer = (documents: StandInDocument[]) => Promise<{
  apiHost: string;
  log: RequestRecord[];
  close: () => void;
}>;

function installNetworkGuard() {
  // Guard against ACCIDENTAL outbound requests during grading (not network isolation).
  // Every TCP/TLS socket connect must target a loopback IP literal. Names, even "localhost", are refused: they
  // resolve through dns.lookup, which an app can replace. A truthy path means a local Unix socket, as in Node's own
  // net code (http passes path: null for TCP). Anything else is refused before any connection, and logged to
  // NETGUARD_LOG (if set).
  const net = process.getBuiltinModule('node:net');
  const fileSystem = process.getBuiltinModule('node:fs');
  const isLoopback = (host: string) =>
    net.isIP(host) !== 0 && (host.startsWith('127.') || host === '::1' || host === '::ffff:127.0.0.1');
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...arguments_: any[]) {
    // net.connect()/tls.connect() hand over a pre-normalised [options, callback] array; direct callers pass
    // (options) or (port, host).
    const first = Array.isArray(arguments_[0]) ? arguments_[0][0] : arguments_[0];
    const options =
      typeof first === 'object' && first !== null
        ? first
        : { port: first, host: typeof arguments_[1] === 'string' ? arguments_[1] : 'localhost' };
    if (!options.path && !isLoopback(options.host ?? 'localhost')) {
      if (process.env.NETGUARD_LOG)
        try {
          fileSystem.appendFileSync(process.env.NETGUARD_LOG, `${options.host}:${options.port}\n`);
        } catch {}
      const error = Object.assign(new Error(`netguard: refused connection to ${options.host}:${options.port}`), {
        code: 'ECONNREFUSED',
      });
      process.nextTick(() => this.destroy(error));
      return this;
    }
    return originalConnect.apply(this, arguments_ as any);
  };
}

function createStandIn({ parse, evaluate }: Pick<Groq, 'evaluate' | 'parse'>): StartServer {
  // Plain local stand-in: answers /users/me with a fixed fake user and runs GROQ queries with groq-js.
  // Everything else gets 404 and is logged. No auth logic.
  const http = process.getBuiltinModule('node:http');
  return async function start(documents) {
    const log: RequestRecord[] = [];
    const server = http.createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      const url = new URL(request.url!, 'http://x');
      const record: RequestRecord = {
        method: request.method!,
        url: request.url!,
        auth: request.headers.authorization ? 'present' : undefined,
        body: body || undefined,
        status: 0,
      };
      log.push(record);
      const send = (status: number, json: any) => {
        record.status = status;
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(json));
      };
      if (request.method === 'GET' && url.pathname.endsWith('/users/me'))
        return send(200, {
          id: 'pFake',
          name: 'Fake User',
          email: 'fake@example.com',
          provider: 'sanity',
          role: 'administrator',
          roles: [{ name: 'administrator', title: 'Administrator' }],
        });
      if (request.method === 'GET' && url.pathname.endsWith('/projects/p1'))
        return send(200, {
          id: 'p1',
          displayName: 'Test project',
          organizationId: 'oTest',
          members: [],
          features: [],
          metadata: {},
        });
      const match = url.pathname.match(/\/data\/query\/([^/]+)$/);
      if (match) {
        let query: string;
        let params: Record<string, unknown> = {};
        if (request.method === 'POST') {
          const json = JSON.parse(body);
          query = json.query;
          params = json.params ?? {};
        } else {
          query = url.searchParams.get('query')!;
          for (const [key, value] of url.searchParams)
            if (key.startsWith('$')) params[key.slice(1)] = JSON.parse(value);
        }
        try {
          const result = await (await evaluate(parse(query, { params }), { dataset: documents, params })).get();
          record.result = JSON.stringify(result);
          return send(200, { query, result, ms: 1 });
        } catch (error) {
          return send(400, { error: String((error as Error).message) });
        }
      }
      if (/\/data\/live\/events/.test(url.pathname) || /\/data\/listen\//.test(url.pathname)) {
        record.status = 200;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(': open\n\n');
        return;
      }
      send(404, { error: 'not handled by stand-in' });
    });
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('stand-in did not open a TCP port');
    return {
      apiHost: `http://127.0.0.1:${address.port}`,
      log,
      close: () => {
        server.closeAllConnections();
        server.close();
      },
    };
  };
}

function registerReadTest({ test, expect, render, screen, fireEvent, SanityApp, React, start, loadList }: TestTools) {
  const { randomBytes } = process.getBuiltinModule('node:crypto');
  const { writeFileSync } = process.getBuiltinModule('node:fs');
  // Read and then remove the test settings so the app under test cannot see them.
  const prefix = process.env.CORPUS!;
  const app = process.env.APP!;
  const requestLog = process.env.REQLOG_FILE;
  delete process.env.REQLOG_FILE;
  delete process.env.CORPUS;
  delete process.env.APP;
  // Unpredictable corpus: a fresh nonce in every title, dates shuffled against ids and titles.
  const nonce = randomBytes(4).toString('hex');
  const permutation = [5, 0, 11, 7, 2, 12, 8, 3, 10, 1, 6, 9, 4];
  const newsCount = prefix === 'hidden' ? 13 : 12;
  const pad = (index: number) => String(index).padStart(2, '0');
  const makeDocuments = (): StandInDocument[] => [
    ...Array.from({ length: newsCount }, (_, index) => ({
      _id: `post-${prefix}-${index}`,
      _type: 'post',
      category: 'news',
      title: `${prefix} ${nonce} title ${pad(index)}`,
      publishedAt: `2026-01-${pad(2 * permutation[index]! + 1)}`,
    })),
    ...Array.from({ length: 3 }, (_, index) => ({
      _id: `sport-${prefix}-${index}`,
      _type: 'post',
      category: 'sports',
      title: `${prefix} ${nonce} sports ${pad(index)}`,
      publishedAt: `2026-01-${pad(24 - 6 * index)}`,
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
      _id: `author-${prefix}-${index}`,
      _type: 'author',
      title: `${prefix} ${nonce} author ${pad(index)}`,
      publishedAt: `2026-02-0${index + 1}`,
    })),
  ];
  const news = () =>
    makeDocuments()
      .filter((document) => document._type === 'post' && document.category === 'news')
      .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
      .map((document) => document.title);
  const isListQuery = (url: string) => /\/data\/query\//.test(url) && !/tag=sanity\.sdk\.projection/.test(url);
  test(`${app} on ${prefix} corpus`, async () => {
    const List = await loadList();
    const standIn = await start(makeDocuments());
    const startTime = performance.now();
    try {
      render(
        React.createElement(
          SanityApp,
          {
            config: [
              {
                projectId: 'p1',
                dataset: 'production',
                useProjectHostname: false,
                auth: { token: 'fake-token', apiHost: standIn.apiHost },
              } as any,
            ],
            fallback: React.createElement('p', null, 'loading'),
          },
          React.createElement(List),
        ),
      );
      const items = () => screen.queryAllByRole('listitem').map((element) => element.textContent);
      await expect.poll(items, { timeout: 8000, message: 'CHECK_FIRST_PAGE' }).toEqual(news().slice(0, 5));
      const firstPageTime = performance.now();
      const button = await screen.findByRole('button', { name: /more/i }).catch(() => null);
      expect(button, 'CHECK_MORE_BUTTON').not.toBeNull();
      const requestCount = standIn.log.length;
      const later = news().slice(5);
      const laterIds = makeDocuments()
        .filter((document) => document._type === 'post' && document.category === 'news')
        .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
        .slice(5)
        .map((document) => JSON.stringify(document._id));
      expect(
        standIn.log.filter(
          ({ result = '' }) =>
            later.some((title) => result.includes(title)) || laterIds.some((id) => result.includes(id)),
        ).length,
        'CHECK_SERVER_PAGE: later items were already served before "more"',
      ).toBe(0);
      fireEvent.click(button!);
      await expect.poll(items, { timeout: 8000, message: 'CHECK_ALL_PAGES' }).toEqual(news().slice(0, 10));
      expect(
        standIn.log.slice(requestCount).some((record) => isListQuery(record.url)),
        'CHECK_SERVER_PAGE: "more" must ask the server for the next page',
      ).toBe(true);
      console.log(
        'TIMING firstPageMs',
        Math.round(firstPageTime - startTime),
        'allMs',
        Math.round(performance.now() - startTime),
      );
    } finally {
      if (requestLog) writeFileSync(requestLog, JSON.stringify(standIn.log.map((record) => record.url)));
      console.log(
        'ITEMS_AT_END',
        JSON.stringify(screen.queryAllByRole('listitem').map((element) => element.textContent)),
      );
      console.log(
        'REQUESTS',
        JSON.stringify(
          standIn.log.map(
            (record) =>
              `${record.status} ${record.method} ${decodeURIComponent(record.url)
                .replace(/\?.*tag=/, ' tag=')
                .slice(0, 90)}`,
          ),
        ),
      );
      standIn.close();
    }
  });
}

function serialized(name: string, helper: (...arguments_: any[]) => unknown): string {
  const source = helper.toString();
  if (/__vite_ssr|__vi_/.test(source)) throw new Error(`${name} source contains a Vitest transform marker`);
  return source;
}

const FILES: Record<string, string> = {
  'netguard.cjs': `(${serialized('network guard', installNetworkGuard)})();\n`,
  'server.ts': `import {parse, evaluate} from 'groq-js';\nexport const start = (${serialized('stand-in server', createStandIn)})({parse, evaluate});\n`,
  'read.test.tsx': `import {test, expect} from 'vitest'; import {render, screen, fireEvent} from '@testing-library/react'; import {SanityApp} from '@sanity/sdk-react'; import React from 'react'; import {start} from './server';\n(${serialized('read test', registerReadTest)})({test, expect, render, screen, fireEvent, SanityApp, React, start, loadList: () => import('../../src/PostList.tsx').then(module => module.default)});\n`,
  'vitest.config.ts':
    "import react from '@vitejs/plugin-react'; import {defineConfig} from 'vitest/config'; export default defineConfig({plugins:[react()],test:{include:['read.test.tsx'],environment:'jsdom',testTimeout:20000,pool:'forks',maxWorkers:1}});\n",
};
const dir = resolve('__agent_eval__/grader');
type Outcome = { got: string; out: string; refused: string[] };
function witnessNetworkGuard() {
  const https = process.getBuiltinModule('node:https');
  https
    .get('https://api.sanity.io', () => process.exit(1))
    .on('error', (error: Error) => {
      console.log(error.message);
      process.exit(error.message.startsWith('netguard: refused') ? 0 : 1);
    });
}
function grade(corpus: 'visible' | 'hidden'): Outcome {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(FILES)) writeFileSync(join(dir, name), body);
  const tmp = mkdtempSync(join(tmpdir(), 'grade-')),
    ng = join(tmp, 'ng.log'),
    rl = join(tmp, 'req.json');
  writeFileSync(ng, '');
  const guard = `--require ${join(dir, 'netguard.cjs')}`;
  const env = { ...process.env, NETGUARD_LOG: ng, NODE_OPTIONS: guard, NO_COLOR: '1' };
  // Guard witness: the guard itself must refuse and log a real outbound request.
  const witnessSource = `(${witnessNetworkGuard.toString()})();`;
  if (/__vite_ssr|__vi_/.test(witnessSource))
    throw new Error('guard witness source contains a Vitest transform marker');
  const witness = spawnSync(process.execPath, ['-e', witnessSource], { env, encoding: 'utf8' });
  if (witness.status !== 0 || !readFileSync(ng, 'utf8').includes('api.sanity.io:443'))
    return { got: 'GUARD-FAILED', out: witness.stdout + witness.stderr, refused: [] };
  writeFileSync(ng, '');
  const result = spawnSync(resolve('node_modules/.bin/vitest'), ['run', '--root', dir], {
    env: { ...env, CORPUS: corpus, APP: 'PostList', REQLOG_FILE: rl },
    encoding: 'utf8',
    timeout: 120000,
  });
  const out = (result.stdout ?? '') + (result.stderr ?? '');
  let reqs = '';
  try {
    reqs = readFileSync(rl, 'utf8');
  } catch {}
  const refused = readFileSync(ng, 'utf8').split('\n').filter(Boolean);
  const at = out.match(/AssertionError: (CHECK_[A-Z_]*)/);
  const got =
    result.status === 0 && /Tests {2}1 passed/.test(out)
      ? 'PASS'
      : /\/data\/listen\/|\/acl/.test(reqs)
        ? 'UNSUPPORTED'
        : at
          ? `FAIL@${at[1]}`
          : 'FAIL-OTHER';
  rmSync(tmp, { recursive: true, force: true });
  return { got, out, refused };
}
for (const corpus of ['visible', 'hidden'] as const) {
  test(`renders the news list and loads the next page (${corpus} content)`, () => {
    const { got, out, refused } = grade(corpus);
    console.log(`OUTCOME corpus=${corpus} got=${got} refused=${refused.length} ${refused.join(' ')}`);
    if (got !== 'PASS')
      console.log(
        out
          .split('\n')
          .filter((line) => /CHECK_|Error|ITEMS_AT_END|REQUESTS/.test(line))
          .slice(0, 12)
          .join('\n'),
      );
    expect(got).toBe('PASS');
  }, 150000);
}
