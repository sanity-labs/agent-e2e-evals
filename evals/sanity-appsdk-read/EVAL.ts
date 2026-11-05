/** Hidden grader for the App SDK read-path task (calibrated harness v7, embedded verbatim except the app import). */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, expect } from 'vitest';
const FILES: Record<string, string> = {
  'netguard.cjs':
    "// Guard against ACCIDENTAL outbound requests during grading (not network isolation; see CHANGES.md).\n// Every TCP/TLS socket connect must target a loopback IP literal. Names, even \"localhost\", are refused: they resolve through dns.lookup, which an app can replace.\n// A truthy path means a local Unix socket, as in Node's own net code (http passes path: null for TCP).\n// Anything else is refused before any connection, and logged to NETGUARD_LOG (if set).\nconst net = require('node:net'), fs = require('node:fs')\nconst loopback = (h) => net.isIP(h) !== 0 && (/^127\\./.test(h) || h === '::1' || h === '::ffff:127.0.0.1')\nconst orig = net.Socket.prototype.connect\nnet.Socket.prototype.connect = function (...args) {\n  // net.connect()/tls.connect() hand over a pre-normalised [options, cb] array; direct callers pass (options) or (port, host).\n  const first = Array.isArray(args[0]) ? args[0][0] : args[0]\n  const o = typeof first === 'object' && first !== null ? first : { port: first, host: typeof args[1] === 'string' ? args[1] : 'localhost' }\n  if (!o.path && !loopback(o.host ?? 'localhost')) {\n    if (process.env.NETGUARD_LOG) try { fs.appendFileSync(process.env.NETGUARD_LOG, `${o.host}:${o.port}\\n`) } catch {}\n    const e = Object.assign(new Error(`netguard: refused connection to ${o.host}:${o.port}`), { code: 'ECONNREFUSED' })\n    process.nextTick(() => this.destroy(e)); return this\n  }\n  return orig.apply(this, args)\n}\n",
  'server.ts':
    "// Plain local stand-in: answers /users/me with a fixed fake user and runs GROQ queries with groq-js.\n// Everything else gets 404 and is logged. No auth logic.\nimport http from 'node:http'\nimport {parse, evaluate} from 'groq-js'\nexport type Log = {method:string,url:string,auth?:string,body?:string,status:number}[]\nexport async function start(docs:any[]) {\n  const log:Log = []\n  const server = http.createServer(async (req, res) => {\n    let body = ''; for await (const c of req) body += c\n    const u = new URL(req.url!, 'http://x')\n    const rec = {method:req.method!, url:req.url!, auth:req.headers.authorization ? 'present' : undefined, body: body || undefined, status:0}\n    log.push(rec)\n    const send = (s:number, j:any) => { rec.status=s; res.writeHead(s,{'content-type':'application/json'}); res.end(JSON.stringify(j)) }\n    if (req.method==='GET' && /\\/users\\/me$/.test(u.pathname)) return send(200,{id:'pFake',name:'Fake User',email:'fake@example.com',provider:'sanity',role:'administrator',roles:[{name:'administrator',title:'Administrator'}]})\n    if (req.method==='GET' && /\\/projects\\/p1$/.test(u.pathname)) return send(200,{id:'p1',displayName:'Test project',organizationId:'oTest',members:[],features:[],metadata:{}})\n    const m = u.pathname.match(/\\/data\\/query\\/([^/]+)$/)\n    if (m) {\n      let query:string, params:Record<string,unknown> = {}\n      if (req.method==='POST') { const j = JSON.parse(body); query=j.query; params=j.params??{} }\n      else { query=u.searchParams.get('query')!; for (const [k,v] of u.searchParams) if (k.startsWith('$')) params[k.slice(1)]=JSON.parse(v) }\n      try { const r = await (await evaluate(parse(query,{params}),{dataset:docs,params})).get(); (rec as any).result=JSON.stringify(r); return send(200,{query,result:r,ms:1}) }\n      catch(e:any){ return send(400,{error:String(e.message)}) }\n    }\n    if (/\\/data\\/live\\/events/.test(u.pathname) || /\\/data\\/listen\\//.test(u.pathname)) { rec.status=200; res.writeHead(200,{'content-type':'text/event-stream'}); res.write(': open\\n\\n'); return }\n    send(404,{error:'not handled by stand-in'})\n  })\n  await new Promise<void>(r=>server.listen(0,'127.0.0.1',()=>r()))\n  const port = (server.address() as any).port\n  return {apiHost:`http://127.0.0.1:${port}`, log, close:()=>{server.closeAllConnections(); server.close()}}\n}\n",
  'read.test.tsx':
    "import {test, expect} from 'vitest'\nimport {render, screen, fireEvent} from '@testing-library/react'\nimport {SanityApp} from '@sanity/sdk-react'\nimport {randomBytes} from 'node:crypto'\nimport {writeFileSync} from 'node:fs'\nimport {start} from './server'\n// Read and then remove the test settings so the app under test cannot see them.\nconst prefix = process.env.CORPUS!, app = process.env.APP!, reqlog = process.env.REQLOG_FILE\ndelete process.env.REQLOG_FILE\ndelete process.env.CORPUS; delete process.env.APP\n// Unpredictable corpus (from probe's cross-test): a fresh nonce in every title, dates shuffled against ids and titles.\nconst nonce = randomBytes(4).toString('hex')\nconst perm = [5,0,11,7,2,12,8,3,10,1,6,9,4]\nconst NEWS = prefix === 'hidden' ? 13 : 12\nconst pad = (i:number) => String(i).padStart(2,'0')\nconst mk = () => [\n  ...Array.from({length:NEWS},(_,i)=>({_id:`post-${prefix}-${i}`,_type:'post',category:'news',title:`${prefix} ${nonce} title ${pad(i)}`,publishedAt:`2026-01-${pad(2*perm[i]+1)}`})),\n  ...Array.from({length:3},(_,i)=>({_id:`sport-${prefix}-${i}`,_type:'post',category:'sports',title:`${prefix} ${nonce} sports ${pad(i)}`,publishedAt:`2026-01-${pad(24-6*i)}`})),\n  ...Array.from({length:2},(_,i)=>({_id:`author-${prefix}-${i}`,_type:'author',title:`${prefix} ${nonce} author ${pad(i)}`,publishedAt:`2026-02-0${i+1}`})),\n]\nconst news = () => mk().filter(d=>d._type==='post'&&d.category==='news').sort((a,b)=>b.publishedAt.localeCompare(a.publishedAt)).map(d=>d.title)\nconst isListQuery = (url:string) => /\\/data\\/query\\//.test(url) && !/tag=sanity\\.sdk\\.projection/.test(url)\ntest(`${app} on ${prefix} corpus`, async () => {\n  const mod: any = await import('../../src/PostList.tsx'); const List = mod.default ?? mod.PostList\n  const srv = await start(mk())\n  const t0 = performance.now()\n  try {\n    render(<SanityApp config={[{projectId:'p1',dataset:'production',useProjectHostname:false,auth:{token:'fake-token',apiHost:srv.apiHost}} as any]} fallback={<p>loading</p>}><List/></SanityApp>)\n    const items = () => screen.queryAllByRole('listitem').map(e=>e.textContent)\n    await expect.poll(items,{timeout:8000, message:'CHECK_FIRST_PAGE'}).toEqual(news().slice(0,5))\n    const t1 = performance.now()\n    const button = await screen.findByRole('button',{name:/more/i}).catch(()=>null)\n    expect(button, 'CHECK_MORE_BUTTON').not.toBeNull()\n    const before = srv.log.length\n    const later = news().slice(5)\n    expect(srv.log.filter(r=>later.some(x=>((r as any).result??'').includes(x))).length, 'CHECK_SERVER_PAGE: later items were already served before \"more\"').toBe(0)\n    fireEvent.click(button!)\n    await expect.poll(items,{timeout:8000, message:'CHECK_ALL_PAGES'}).toEqual(news().slice(0,10))\n    expect(srv.log.slice(before).some(r=>isListQuery(r.url)), 'CHECK_SERVER_PAGE: \"more\" must ask the server for the next page').toBe(true)\n    console.log('TIMING firstPageMs', Math.round(t1-t0), 'allMs', Math.round(performance.now()-t0))\n  } finally {\n    if (reqlog) writeFileSync(reqlog, JSON.stringify(srv.log.map(r=>r.url)))\n    console.log('ITEMS_AT_END', JSON.stringify(screen.queryAllByRole('listitem').map(e=>e.textContent)))\n    console.log('REQUESTS', JSON.stringify(srv.log.map(r=>`${r.status} ${r.method} ${decodeURIComponent(r.url).replace(/\\?.*tag=/,' tag=').slice(0,90)}`)))\n    srv.close()\n  }\n})\n",
  'vitest.config.ts':
    "import react from '@vitejs/plugin-react'\nimport {defineConfig} from 'vitest/config'\nexport default defineConfig({plugins:[react()],test:{include:['read.test.tsx'],environment:'jsdom',testTimeout:20000,pool:'forks',maxWorkers:1}})\n",
};
const dir = resolve('__agent_eval__/grader');
type Outcome = { got: string; out: string; refused: string[] };
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
  const w = spawnSync(
    process.execPath,
    [
      '-e',
      "require('node:https').get('https://api.sanity.io',()=>process.exit(1)).on('error',e=>{console.log(e.message);process.exit(/^netguard: refused/.test(e.message)?0:1)})",
    ],
    { env, encoding: 'utf8' },
  );
  if (w.status !== 0 || !readFileSync(ng, 'utf8').includes('api.sanity.io:443'))
    return { got: 'GUARD-FAILED', out: w.stdout + w.stderr, refused: [] };
  writeFileSync(ng, '');
  const r = spawnSync(resolve('node_modules/.bin/vitest'), ['run', '--root', dir], {
    env: { ...env, CORPUS: corpus, APP: 'PostList', REQLOG_FILE: rl },
    encoding: 'utf8',
    timeout: 120000,
  });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  let reqs = '';
  try {
    reqs = readFileSync(rl, 'utf8');
  } catch {}
  const refused = readFileSync(ng, 'utf8').split('\n').filter(Boolean);
  const at = out.match(/AssertionError: (CHECK_[A-Z_]*)/);
  const got =
    r.status === 0 && /Tests {2}1 passed/.test(out)
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
          .filter((l) => /CHECK_|Error|ITEMS_AT_END|REQUESTS/.test(l))
          .slice(0, 12)
          .join('\n'),
      );
    expect(got).toBe('PASS');
  }, 150000);
}
