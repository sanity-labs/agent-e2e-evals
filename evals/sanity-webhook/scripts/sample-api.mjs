// Local published-content stand-in for the Sanity query API. It deliberately re-reads the data file per request.
import fs from 'node:fs';
import nock from 'nock';
import { evaluate, parse } from 'groq-js';

const DATA = process.env.SAMPLE_API_DATA ?? 'data/sample.ndjson';
const LOG = process.env.SAMPLE_API_LOG;
const docs = () => fs.readFileSync(DATA, 'utf8').split('\n').filter((line) => line.trim())
  .map((line) => JSON.parse(line)).filter((doc) => !doc._id.startsWith('drafts.') && !doc._id.startsWith('versions.'));
const log = (record) => LOG && fs.appendFileSync(LOG, `${JSON.stringify(record)}\n`);
const QUERY_PATH = /^\/v[^/]+\/data\/query\/production(\?|$)/;

async function answer(method, path, body) {
  const url = new URL(path, 'http://x');
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
  try {
    const result = await (await evaluate(parse(query), { dataset: docs(), params })).get();
    log({ ok: true, method, path: url.pathname, query, params });
    return [200, { ms: 1, query, result }];
  } catch (error) {
    log({ ok: false, method, path: url.pathname, query, error: String(error?.message ?? error) });
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
  scope.get(QUERY_PATH).query(true).reply(async (request) => answer('GET', pathOf(request)));
  scope.post(QUERY_PATH).query(true).reply(async (request) => answer('POST', pathOf(request), await request.text()));
}
