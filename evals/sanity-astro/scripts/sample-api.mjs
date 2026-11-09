// A local stand-in for the Sanity query API, preloaded with `node --import`. It answers GROQ queries for project
// abc123, dataset production, on the api and apicdn hosts, from published documents in an NDJSON file, as an
// anonymous visitor would see them. Every other request (another project, dataset, host, or API route) is rejected.
// Drafts and release previews are not supported: a `drafts` or release perspective is rejected, not answered. Each request is appended to a JSON-lines log when one is set.
import fs from 'node:fs';
import nock from 'nock';
import { evaluate, parse } from 'groq-js';

const DATA = process.env.SAMPLE_API_DATA ?? 'data/sample.ndjson';
const LOG = process.env.SAMPLE_API_LOG;
const docs = fs
  .readFileSync(DATA, 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line))
  .filter((doc) => !doc._id.startsWith('drafts.') && !doc._id.startsWith('versions.'));
const log = (record) => LOG && fs.appendFileSync(LOG, `${JSON.stringify(record)}\n`);

const QUERY_PATH = /^\/v[^/]+\/data\/query\/production(\?|$)/;
async function answer(method, path, body) {
  const url = new URL(path, 'http://x');
  let query, params;
  if (method === 'GET') {
    query = url.searchParams.get('query');
    params = Object.fromEntries(
      [...url.searchParams].filter(([k]) => k.startsWith('$')).map(([k, v]) => [k.slice(1), JSON.parse(v)]),
    );
  } else {
    const json = typeof body === 'string' ? JSON.parse(body) : body;
    query = json?.query;
    params = json?.params ?? {};
  }
  // Absent, `published` and `raw` all see the same anonymous-visible snapshot; preview perspectives are refused.
  const perspective = url.searchParams.get('perspective');
  if (perspective && !['published', 'raw'].includes(perspective)) {
    log({ ok: false, method, path: url.pathname, query, perspective, error: 'unsupported perspective' });
    return [400, { error: { description: `local sample API: perspective "${perspective}" (drafts or release previews) is not supported` } }];
  }
  try {
    const result = await (await evaluate(parse(query), { dataset: docs, params })).get();
    log({ ok: true, method, path: url.pathname, query, params });
    return [200, { ms: 1, query, result }];
  } catch (err) {
    log({ ok: false, method, path: url.pathname, query, error: String(err?.message ?? err) });
    return [400, { error: { description: `local sample API could not run the query: ${err?.message ?? err}` } }];
  }
}

nock.disableNetConnect();
nock.emitter.on('no match', (req) => {
  const where = typeof req === 'string' ? req : `${req.method ?? ''} ${req.url ?? req.href ?? req.path ?? ''}`;
  log({ ok: false, unmatched: where });
});
for (const host of ['https://abc123.api.sanity.io', 'https://abc123.apicdn.sanity.io']) {
  const scope = nock(host).persist();
  // nock 15 passes a fetch Request. Keep reply functions to one argument: with two, nock treats them as callback-style.
  const pathOf = (req) => new URL(req.url).pathname + new URL(req.url).search;
  scope.get(QUERY_PATH).query(true).reply(async (req) => answer('GET', pathOf(req)));
  scope.post(QUERY_PATH).query(true).reply(async (req) => answer('POST', pathOf(req), await req.text()));
}
