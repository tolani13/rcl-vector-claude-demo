// connections-v1 adversarial demo (TEST FIXTURE / MOCK; no network). Prints, for each of the five adversarial checks,
// the actual requests and VECTOR's answers, so the refusals can be read rather than inferred from a pass count.
// Same checks as test/api/real-accounts.test.js, test/api/privacy-gate.test.js and test/intel/presets.test.js.
//   node --disable-warning=ExperimentalWarning scripts/connections-adversarial.mjs > receipts/connections-v1/adversarial.txt
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDb, seedFixture, startTestServer, SYM } from '../test/api/helpers.js';
import { makeModelFetch } from '../test/intel/preset-helpers.js';
import { resetPresetCaches } from '../server/intel/providers/presets.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SENT = {
  VECTOR_SNAPTRADE_CLIENT_ID: 'SENTINEL-DEMO-CLIENT-1a2b3c', VECTOR_SNAPTRADE_CONSUMER_KEY: 'SENTINEL-DEMO-CONSUMER-4d5e6f',
  VECTOR_SNAPTRADE_USER_ID: 'demo-user', VECTOR_SNAPTRADE_USER_SECRET: 'SENTINEL-DEMO-USERSECRET-7a8b9c',
  VECTOR_GROQ_API_KEY: 'SENTINEL-DEMO-GROQ-0d1e2f', VECTOR_GEMINI_API_KEY: 'SENTINEL-DEMO-GEMINI-3a4b5c',
};
const line = (s = '') => process.stdout.write(`${s}\n`);
const servers = [];
async function server(env, opts = {}) {
  resetPresetCaches();
  const t = tempDb('adv');
  seedFixture(t.db);
  const s = await startTestServer(t.db, env, opts);
  servers.push(async () => { await s.close(); t.cleanup(); });
  return { t, s, api: s.client };
}
const show = (m, p, r) => line(`  ${m} ${p} -> ${r.status} ${r.json?.error?.code ?? r.json?.status ?? ''}`.trimEnd());

/** MOCK SnapTrade: ok, or a 401 that echoes the caller's credentials. */
function snapMock(mode) {
  const json = (s, o) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
  return async (url, init = {}) => {
    const u = new URL(String(url));
    if (mode === '401') return json(401, { detail: `Invalid clientId ${u.searchParams.get('clientId')} consumerKey ${SENT.VECTOR_SNAPTRADE_CONSUMER_KEY} userSecret ${u.searchParams.get('userSecret')}` });
    if (mode === 'network') throw new TypeError(`fetch failed: ${url}`);
    const p = u.pathname.replace(/^\/api\/v1/, '');
    if (init.method === 'POST') return json(200, { redirectURI: 'https://portal.example/TEST-FIXTURE', sessionId: 's' });
    if (p === '/accounts') return json(200, [{ id: 'acc-demo-1', name: 'TEST FIXTURE', number: 'TF0001', institution_name: 'TEST FIXTURE', balance: { total: { amount: 1, currency: 'USD' } } }]);
    if (p.endsWith('/balances')) return json(200, [{ currency: { code: 'USD' }, cash: 1, buying_power: 1 }]);
    if (p.endsWith('/positions/all')) return json(200, { results: [] });
    if (p.endsWith('/activities')) return json(200, { data: [], pagination: { offset: 0, limit: 1000, total: 0 } });
    return json(404, {});
  };
}

try {
  line('connections-v1 adversarial checks (TEST FIXTURE / MOCK; no network)');
  line(`generated_at ${new Date().toISOString()}  node ${process.version}`);

  line('\n(a) NO TRADING');
  const pat = 'snapTrade/trade|/trade/(place|impact|replace|cancel)|/accounts/[^\'"` ]*/orders|place(Force|Mleg|Crypto|Bracket|Checked)Order|cancelUserAccountOrder|getOrderImpact|Trading_|trade-if-available|connectionType *: *[\'"`]trade';
  let grep = '';
  try { grep = execFileSync('git', ['grep', '--untracked', '-nIE', pat, '--', 'server', 'web'], { cwd: ROOT, encoding: 'utf8' }); } catch (e) { grep = e.status === 1 ? '' : `git grep failed: ${e.message}`; }
  line(`  $ git grep --untracked -nIE '<SnapTrade trading surface>' -- server web`);
  line(`  ${grep.trim() || '(no matches)'}`);
  let grep2 = '';
  try { grep2 = execFileSync('git', ['grep', '--untracked', '-nIiE', '(place|cancel|replace|submit|preview)[a-z]*order|[\'"`/]orders?[\'"`/?]|/trade\\b', '--', 'server/data/providers/snaptrade.js', 'server/data/real-accounts.js', 'server/api/real.js', 'web/js/views/real.js'], { cwd: ROOT, encoding: 'utf8' }); } catch (e) { grep2 = e.status === 1 ? '' : `git grep failed: ${e.message}`; }
  line('  $ git grep --untracked -nIiE \'<any order/trade code>\' -- <the four real-account files>');
  line(`  ${grep2.trim() || '(no matches)'}`);
  {
    const { api } = await server(SENT, { snaptradeFetch: snapMock('ok') });
    for (const p of ['/api/real/orders', '/api/real/trade', '/api/real/trades', '/api/real/order/impact', '/api/real/accounts/acc-demo-1/orders', '/api/real/orders/x/cancel']) {
      for (const m of ['GET', 'POST', 'PUT', 'DELETE']) show(m, p, await api.raw(m, p, m === 'GET' || m === 'DELETE' ? undefined : {}));
    }
  }

  line('\n(b) NO SECRET LEAKS (sentinel values set for every SnapTrade and model key)');
  for (const mode of ['ok', '401', 'network']) {
    const { t, s, api } = await server(SENT, { snaptradeFetch: snapMock(mode) });
    const texts = [];
    for (const [m, p, b] of [['POST', '/api/real/connect', {}], ['POST', '/api/real/sync', { confirm: true }], ['GET', '/api/real/status'], ['GET', '/api/real/accounts'], ['GET', '/api/real/transactions'], ['GET', '/api/model/presets'], ['GET', '/api/model'], ['GET', '/api/status'], ['GET', '/api/journal?limit=200']]) {
      const r = await api.raw(m, p, b);
      texts.push(r.text);
      if (p.startsWith('/api/real/s') || p === '/api/real/connect') show(m, p, r);
    }
    const tables = t.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name <> 'm1'").all().map((x) => x.name);
    const dump = JSON.stringify(tables.map((n) => t.db.prepare(`SELECT * FROM "${n}"`).all()));
    const blob = [...texts, ...s.logs, dump].join('\n');
    const hits = Object.entries(SENT).filter(([k, v]) => k !== 'VECTOR_SNAPTRADE_USER_ID' && blob.includes(v)).map(([k]) => k);
    line(`  mode=${mode}: scanned ${texts.length} responses, ${s.logs.length} log lines, ${tables.length} DB tables (journal included) -> sentinel hits: ${hits.length}${hits.length ? ` ${hits.join(',')}` : ''}`);
  }

  line('\n(c) PRIVACY GATE (assessment with real-account data)');
  for (const [label, env] of [['groq (unknown)', { VECTOR_MODEL_PRESET: 'groq' }], ['gemini-flash-free (true)', { VECTOR_MODEL_PRESET: 'gemini-flash-free' }], ['ollama-local + tightwad=groq', { VECTOR_MODEL_PRESET: 'ollama-local', VECTOR_MODEL_LENS_TIGHTWAD: 'groq' }], ['ollama-local (false)', { VECTOR_MODEL_PRESET: 'ollama-local' }]]) {
    const mf = makeModelFetch();
    const { api } = await server({ ...SENT, ...env }, { modelFetch: mf.fetchImpl });
    const r = await api.post('/api/assessments/run', { sym: SYM, confirm: true, includeRealAccount: true });
    const sent = mf.calls.filter((c) => /(chat\/completions|api\/chat)$/.test(c.path)).length;
    line(`  preset ${label}: POST /api/assessments/run {includeRealAccount:true} -> ${r.status} ${r.json?.error?.code}${r.json?.blocked ? ` blocked=${JSON.stringify(r.json.blocked.map((b) => `${b.lens}:${b.trains_on_prompts}`))}` : ''}; model requests sent: ${sent}`);
  }

  line('\n(d) $0 GUARD');
  {
    const { api } = await server({ ANTHROPIC_API_KEY: 'test-fixture-anthropic-key-0' });
    const r = await api.post('/api/model/test', { preset: 'anthropic', confirm: true });
    line(`  POST /api/model/test {preset:'anthropic'} -> ${r.status} ${r.json.error.code}: ${r.json.error.message}`);
  }
  {
    const { api } = await server({ VECTOR_MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'test-fixture-anthropic-key-0' });
    const m = await api.get('/api/model');
    line(`  legacy VECTOR_MODEL_PROVIDER=anthropic: GET /api/model -> status ${m.json.status}, blocked ${m.json.blocked}`);
  }
  {
    const { api } = await server({ VECTOR_ALLOW_PAID: '1', ANTHROPIC_API_KEY: 'test-fixture-anthropic-key-0' });
    const p = await api.get('/api/model/presets');
    const a = p.json.presets.find((x) => x.id === 'anthropic');
    line(`  with VECTOR_ALLOW_PAID=1: preset anthropic allowed_by_cost_guard=${a.allowed_by_cost_guard} (the paid preset may start; nothing was called here)`);
  }

  line('\n(e) PUBLIC / STATIC BUILD');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const files = walk(path.join(ROOT, 'web'));
  line(`  web/ files: ${files.length}; data files (.json/.csv/.db/.env): ${files.filter((f) => /\.(json|csv|db|sqlite|env)$/i.test(f)).length}`);
  line(`  web/ files mentioning api.snaptrade.com or a sentinel: ${files.filter((f) => { const x = fs.readFileSync(f, 'latin1'); return /api\.snaptrade\.com/.test(x) || Object.values(SENT).some((v) => x.includes(v)); }).length}`);
  {
    const { api } = await server(SENT, { snaptradeFetch: snapMock('ok') });
    for (const p of ['/config/model-presets.json', '/server/api/real.js', '/data/vector.db', '/.env']) show('GET', p, await api.get(p));
  }
  const view = fs.readFileSync(path.join(ROOT, 'web/js/views/real.js'), 'utf8');
  line(`  web/js/views/real.js: loopback host guard before any /api/real request: ${view.indexOf('if (!LOOPBACK.has(location.hostname))') < view.indexOf("api.get('/api/real/")}`);
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n');
  line(`  git ls-files: *.db tracked = ${tracked.filter((f) => /\.db$/.test(f)).length}, .env tracked = ${tracked.filter((f) => /(^|\/)\.env$/.test(f)).length}`);
} finally {
  for (const c of servers.reverse()) await c();
}
