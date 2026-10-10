// TEST FIXTURE / MOCK. An in-process fetch that answers like the model endpoints the presets point at (OpenAI-compatible
// /models + /chat/completions, native Ollama /api/tags + /api/ps + /api/chat). No network is used; every reply is a
// TEST MOCK value, not model output and not market data. Each request is recorded (URL, method, auth header presence
// and value) so tests can check that a preset's key goes only to that preset's endpoint.

/** @param {{models?:string[], reply?:(req:{url:string, body:any})=>object|null}} o */
export function makeModelFetch({ models = [], reply = null } = {}) {
  const calls = [];
  const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ origin: u.origin, path: u.pathname, method: init.method ?? 'GET', authorization: headers.authorization ?? null, body });
    const all = [...new Set([...models, ...(body?.model ? [body.model] : [])])];
    if (u.pathname.endsWith('/api/tags')) return json(200, { models: all.map((m) => ({ name: m, model: m })) });
    if (u.pathname.endsWith('/api/ps')) return json(200, { models: [] });
    if (u.pathname.endsWith('/models')) return json(200, { object: 'list', data: all.flatMap((m) => [{ id: m }, { id: `models/${m}` }]) });
    const content = JSON.stringify(reply?.({ url: u, body }) ?? { ok: true, note: 'TEST MOCK connectivity' });
    if (u.pathname.endsWith('/api/chat')) {
      return json(200, { model: body?.model, message: { role: 'assistant', content }, done: true, done_reason: 'stop', prompt_eval_count: 900, eval_count: 40 });
    }
    if (u.pathname.endsWith('/chat/completions')) {
      return json(200, { id: 'test-mock', model: body?.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 900, completion_tokens: 40 } });
    }
    return json(404, { error: 'not found (TEST MOCK)' });
  };
  return { fetchImpl, calls };
}
