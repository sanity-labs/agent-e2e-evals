// Local stand-in for the Sanity query API, used by `npm run build` and `npm start`. Test set-up: leave it alone.
// The valid token is whatever SANITY_API_READ_TOKEN holds when a request arrives (Next loads .env after this file).
import fs from 'node:fs';
import nock from 'nock';
import { evaluate, parse } from 'groq-js';

const DATA = process.env.SAMPLE_API_DATA ?? 'data/sample.ndjson';
const LOG = process.env.SAMPLE_API_LOG;
const PRIVATE_TYPES = new Set(['sanity.previewUrlSecret', 'sanity.previewUrlShareAccess']);
const isDraft = (doc) => doc._id.startsWith('drafts.');
const isVersion = (doc) => doc._id.startsWith('versions.');
const all = () => fs.readFileSync(DATA, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
const log = (record) => LOG && fs.appendFileSync(LOG, `${JSON.stringify(record)}\n`);
const QUERY_PATH = /^\/v([^/]+)\/data\/query\/production(\?|$)/;

function datasetFor({ authed, perspective, version }) {
  const docs = all();
  if (!authed) return docs.filter((doc) => !isDraft(doc) && !isVersion(doc) && !PRIVATE_TYPES.has(doc._type));
  const effective = perspective ?? (version === '1' || version < '2025-02-19' ? 'raw' : 'published');
  if (effective === 'raw') return docs;
  if (effective === 'published') return docs.filter((doc) => !isDraft(doc) && !isVersion(doc));
  if (effective === 'drafts' || effective === 'previewDrafts') {
    const byId = new Map();
    for (const doc of docs) if (!isDraft(doc) && !isVersion(doc)) byId.set(doc._id, doc);
    for (const doc of docs) if (isDraft(doc)) {
      const id = doc._id.slice('drafts.'.length);
      byId.set(id, { ...doc, _id: id, _originalId: doc._id });
    }
    return [...byId.values()];
  }
  throw new Error(`unsupported perspective ${effective}`);
}

async function answer(method, path, body, auth) {
  const url = new URL(path, 'http://x');
  const version = QUERY_PATH.exec(url.pathname)?.[1] ?? '';
  const perspective = url.searchParams.get('perspective') ?? undefined;
  const token = process.env.SANITY_API_READ_TOKEN;
  const authed = Boolean(token) && auth === `Bearer ${token}`;
  let query, params;
  if (method === 'GET') {
    query = url.searchParams.get('query');
    params = Object.fromEntries([...url.searchParams].filter(([key]) => key.startsWith('$'))
      .map(([key, value]) => [key.slice(1), JSON.parse(value)]));
  } else {
    const json = typeof body === 'string' ? JSON.parse(body) : body;
    query = json?.query;
    params = json?.params ?? {};
  }
  const meta = { method, path: url.pathname, version, perspective: perspective ?? null, authed, sentToken: Boolean(auth) };
  if (auth && !authed) {
    log({ ok: false, ...meta, query, error: 'bad token' });
    return [401, { error: { description: 'Unauthorized - Session not found', statusCode: 401 } }];
  }
  try {
    const dataset = datasetFor({ authed, perspective, version });
    const result = await (await evaluate(parse(query), { dataset, params, timestamp: new Date() })).get();
    log({ ok: true, ...meta, query, params });
    return [200, { ms: 1, query, result }];
  } catch (error) {
    log({ ok: false, ...meta, query, error: String(error?.message ?? error) });
    return [400, { error: { description: `local sample API could not run the query: ${error?.message ?? error}` } }];
  }
}

nock.disableNetConnect();
nock.emitter.on('no match', (request) => {
  const where = typeof request === 'string' ? request : `${request.method ?? ''} ${request.url ?? request.href ?? request.path ?? ''}`;
  log({ ok: false, unmatched: where });
});
for (const host of ['https://abc123.api.sanity.io', 'https://abc123.apicdn.sanity.io']) {
  const scope = nock(host).persist();
  const pathOf = (request) => new URL(request.url).pathname + new URL(request.url).search;
  const authOf = (request) => request.headers?.get?.('authorization') ?? undefined;
  scope.get(QUERY_PATH).query(true).reply(async (request) => answer('GET', pathOf(request), undefined, authOf(request)));
  scope.post(QUERY_PATH).query(true).reply(async (request) => answer('POST', pathOf(request), await request.text(), authOf(request)));
}
