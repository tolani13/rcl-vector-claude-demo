// Model presets and per-lens selection (settings, shown in Data sources). Secret-free: the server reports only whether
// each preset's key variable is set. Paid presets show BLOCKED unless the server sets VECTOR_ALLOW_PAID=1.
import { h, replace, announce } from '../dom.js';
import * as api from '../api.js';
import { statusBlock, loading, badge, rtable, field, select, confirmBox, decisionResult, errorBlock } from '../components.js';
import { arr, obj, fmtInt, DASH } from '../format.js';

const LENS_NAMES = [['cowboy', 'Cowboy'], ['pragmatist', 'Pragmatist'], ['tightwad', 'Tightwad']];

const trainsBadge = (v) => (v === false ? badge('TRAINS ON PROMPTS: NO', { tone: 'ok' })
  : v === true ? badge('TRAINS ON PROMPTS: YES', { tone: 'warn' }) : badge('TRAINS ON PROMPTS: UNKNOWN', { tone: 'warn' }));

/** The settings card body: presets table, selection form (default, per-lens, pin), and per-row Test. */
export function modelSettings() {
  const body = h('div', null, loading('model presets'));
  const out = h('div', { 'aria-live': 'polite' });
  let data = null;

  const load = async () => {
    const res = await api.get('/api/model/presets');
    if (!res.ok) { replace(body, errorBlock(res, 'Model presets')); return; }
    data = obj(res.data) || {};
    draw();
  };

  function presetTable(presets) {
    return rtable([
      { label: 'Preset', head: true, render: (p) => h('span', null, h('span', { class: 'sym' }, p.id), h('span', { class: 'sub' }, p.label)) },
      { label: 'Cost', render: (p) => (p.cost === 'free' ? badge('FREE', { tone: 'ok' }) : badge(p.allowed_by_cost_guard ? `${String(p.cost).toUpperCase()} · ALLOWED` : 'BLOCKED: PAID', { tone: 'bad' })) },
      { label: 'Privacy', render: (p) => h('span', null, trainsBadge(p.trains_on_prompts), ' ', h('a', { class: 'small', href: p.trains_on_prompts_source, target: '_blank', rel: 'noopener noreferrer' }, 'source')) },
      { label: 'Key', render: (p) => (p.key_env ? (p.key_present ? badge('KEY SET', { tone: 'ok' }) : h('span', null, badge('NO KEY', { tone: 'warn' }), h('span', { class: 'sub' }, p.key_env))) : badge('LOCAL · NO KEY', { tone: 'neutral' })) },
      { label: 'Local limit', num: true, render: (p) => `${fmtInt(p.limits?.requests_per_minute)}/min · ${fmtInt(p.limits?.requests_per_day)}/day` },
      { label: 'Docs', cls: 'sec', render: (p) => h('a', { href: p.docs_url, target: '_blank', rel: 'noopener noreferrer' }, 'docs') },
    ], presets, { caption: 'Model presets', empty: 'No valid presets in config/model-presets.json.' });
  }

  function draw() {
    const presets = arr(data.presets);
    const sel = obj(data.selection) || {};
    const cur = obj(sel.selection) || { default: { preset: data.defaultPreset ?? 'ollama-local', model: null }, lenses: {}, pinAllLenses: false };
    const options = presets.map((p) => [p.id, `${p.label}${p.cost === 'free' ? '' : ' (paid)'}`]);
    const modelHint = (pid) => {
      const p = presets.find((x) => x.id === pid);
      return p ? `${p.default_model ? `default ${p.default_model}` : 'name a model'}${p.model_suffix_required ? ` · must end in ${p.model_suffix_required}` : ''}` : '';
    };
    const row = (key, label, choice, { optional = false } = {}) => {
      const opts = optional ? [['', 'Same as default'], ...options] : options;
      const sel1 = select(opts, choice?.preset ?? '', { 'aria-label': `${label} preset` });
      const model = h('input', { type: 'text', value: choice?.model ?? '', placeholder: modelHint(choice?.preset ?? cur.default.preset), autocomplete: 'off', spellcheck: 'false', 'aria-label': `${label} model` });
      sel1.addEventListener('change', () => { model.placeholder = modelHint(sel1.value || cur.default.preset); });
      const test = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Test');
      test.addEventListener('click', () => {
        const preset = sel1.value || cur.default.preset;
        replace(out, confirmBox({
          title: `Send one test request to ${preset}${model.value ? ` · ${model.value}` : ''}?`,
          body: h('p', { class: 'small' }, 'One small structured request. Free presets cost nothing; it counts against the preset\'s local limit and the daily model-call budget.'),
          confirmLabel: 'Test',
          onConfirm: async () => {
            replace(out, loading('model test (up to 30 s)'));
            const res = await api.post('/api/model/test', { confirm: true, preset, ...(model.value.trim() ? { model: model.value.trim() } : {}) }, { timeoutMs: api.MODEL_TEST_TIMEOUT_MS });
            replace(out, decisionResult(res), res.ok && res.data?.model ? h('p', { class: 'small' }, `Model: ${res.data.model}`) : null);
            announce(res.ok ? `Model test: ${res.data?.decision ?? 'done'}` : `Model test: ${res.error?.code ?? 'failed'}`);
          },
          onCancel: () => replace(out),
        }));
      });
      return { key, sel: sel1, model, el: h('div', { class: 'preset-row' }, field(`${label} — preset`, sel1), field(`${label} — model`, model), h('div', { class: 'btn-row' }, test)) };
    };
    const def = row('default', 'Default (all lenses)', cur.default);
    const lensRows = LENS_NAMES.map(([k, n]) => row(k, n, cur.lenses?.[k] ?? null, { optional: true }));
    const pin = h('input', { type: 'checkbox', checked: cur.pinAllLenses === true });
    const syncPin = () => { for (const r of lensRows) { r.sel.disabled = pin.checked; r.model.disabled = pin.checked; } };
    pin.addEventListener('change', syncPin);
    syncPin();
    const save = h('button', { type: 'button', class: 'btn btn-primary' }, 'Save selection');
    const clear = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Use server environment');
    const choiceOf = (r) => (r.sel.value ? { preset: r.sel.value, model: r.model.value.trim() || null } : null);
    save.addEventListener('click', async () => {
      const lenses = {};
      for (const r of lensRows) { const c = choiceOf(r); if (c) lenses[r.key] = c; }
      const res = await api.put('/api/model/selection', { default: choiceOf(def), lenses, pinAllLenses: pin.checked });
      replace(out, decisionResult(res));
      announce(res.ok ? 'Model selection saved.' : `Not saved: ${res.error?.message ?? ''}`);
      if (res.ok) load();
    });
    clear.addEventListener('click', async () => {
      const res = await api.put('/api/model/selection', { clear: true });
      replace(out, decisionResult(res));
      if (res.ok) load();
    });
    const lensSummary = obj(sel.lenses) || {};
    replace(body,
      arr(data.catalog?.errors).length ? statusBlock(['CONFIG'], 'Some presets in config/model-presets.json are invalid and were skipped.', arr(data.catalog.errors).join(' · '), { tone: 'warn' }) : null,
      presetTable(presets),
      h('h3', { class: 'section-title' }, 'Which model each lens uses'),
      h('p', { class: 'small muted' }, `Now: ${sel.source === 'legacy' ? 'server environment (VECTOR_MODEL_PROVIDER)' : sel.source === 'env' ? 'server environment presets' : 'saved selection'}. `
        + LENS_NAMES.map(([k, n]) => `${n}: ${lensSummary[k]?.preset ?? lensSummary[k]?.provider ?? DASH}${lensSummary[k]?.model ? ` · ${lensSummary[k].model}` : ''}${lensSummary[k]?.blocked ? ` (BLOCKED: ${lensSummary[k].blocked})` : ''}`).join(' · ')),
      sel.sameModelAllLenses ? badge('SAME MODEL FOR ALL THREE LENSES', { tone: 'ok' }) : badge('LENSES USE DIFFERENT MODELS', { tone: 'warn' }),
      def.el,
      h('label', { class: 'check-row' }, pin, ' Experiment: pin the default model for all three lenses (keeps the eight-account comparison fair)'),
      ...lensRows.map((r) => r.el),
      h('div', { class: 'btn-row' }, save, clear),
      out);
  }

  load();
  return body;
}
