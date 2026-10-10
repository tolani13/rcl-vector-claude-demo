// #/agents — one card per lens × segment agent: state, decision mode, last ok / last failed action (with symbol,
// code and reason), a "why no entries" summary of this session's scans, strategy summary (EXPLORATORY DEFAULTS — NOT
// VALIDATED) with its documented ambiguities, start/pause/resume, a preset picker and a schema-driven strategy editor;
// plus the global KILL SWITCH with an explicit protective-order policy and a confirmation step. Authority is enforced
// server-side by the deterministic policy gate; these controls only request state changes.
//
// Cards are keyed by agent id and updated in place on status polls: the strategy section (editor, preset picker) is
// never rebuilt while it is open or has unsaved edits, and focused controls keep focus.
import { h, replace, announce, nextId } from '../dom.js';
import * as api from '../api.js';
import {
  card, pageHeader, statusBlock, loading, badge, kv, confirmBox, decisionResult, select, errorBlock,
} from '../components.js';
import { pokeStatus } from '../store.js';
import { rowsOf, makeLoader } from './common.js';
import { actionParts, scanWhy, scanWhyText } from '../summaries.js';
import {
  STRATEGY_FIELDS, fieldFor, fieldLabel, formatFieldValue, getPath, toUiValue, applyStrategyEdits, flattenStrategy, skipThresholdText,
} from '../strategy-schema.js';
import {
  arr, obj, num, isNum, parseMaybeJson, fmtEt, fmtInt, humanizeKey, skipLabel, stateReasonText, LENSES, SEGMENT_LABELS, DASH,
} from '../format.js';

export const STRATEGY_LABEL = 'EXPLORATORY DEFAULTS — NOT VALIDATED';
const SUMMARY_SKIP = new Set(['label', 'name', 'description', 'notes', 'ambiguities']);
const SECTION_TITLES = { '': 'Decision', signal: 'Signal', entry: 'Entry filters', exits: 'Exits', management: 'Management' };

export function normAgent(a) {
  const o = obj(a) || {};
  const strategy = obj(o.strategy) || obj(parseMaybeJson(o.strategy_json)) || null;
  return {
    id: o.id ?? null, portfolio_id: o.portfolio_id ?? null, lens: o.lens ?? null, segment: o.segment ?? null,
    state: o.state ?? null, state_reason: o.state_reason ?? null, strategy,
    grants: obj(o.grants) ?? parseMaybeJson(o.grants_json),
    last_ok: o.last_ok ?? parseMaybeJson(o.last_ok_json) ?? null,
    last_fail: o.last_fail ?? parseMaybeJson(o.last_fail_json) ?? null,
    scan_summary: obj(o.scan_summary),
    decisionMode: strategy?.decisionMode ?? o.decisionMode ?? o.decision_mode ?? null,
  };
}

/** Presets arrive as an object map {id: preset} (or an array); every one is EXPLORATORY DEFAULTS — NOT VALIDATED. */
export function presetList(x) {
  const list = Array.isArray(x) ? x : Object.values(obj(x) || {});
  return list.filter((p) => obj(p) && typeof p.id === 'string');
}

/** Presets an agent may load: same segment as the agent (the server refuses a segment mismatch). */
export function presetsFor(presets, segment) {
  return presetList(presets).filter((p) => p.segment === segment);
}

const pathLabel = (p) => fieldLabel(p) ?? p.split('.').map(humanizeKey).join(' › ');

/** Display text of any strategy value (objects flattened to "Label value" pairs). */
export function strategyValueText(p, v) {
  // Inline "Label value" pairs use the bare label: the value text already carries the unit.
  if (obj(v)) return flattenStrategy(v).map(([k, x]) => `${fieldFor(`${p}.${k}`)?.label ?? pathLabel(`${p}.${k}`)} ${strategyValueText(`${p}.${k}`, x)}`).join(', ') || 'set';
  if (Array.isArray(v)) return v.every((x) => x === null || typeof x !== 'object') ? (v.join(', ') || 'none') : `${v.length} item${v.length === 1 ? '' : 's'}`;
  return formatFieldValue(p, v);
}

/** [path, from, to] differences between two strategies (flattened), documentation fields excluded. */
export function strategyDiff(a, b) {
  const fa = new Map(flattenStrategy(a));
  const fb = new Map(flattenStrategy(b));
  const out = [];
  for (const p of new Set([...fa.keys(), ...fb.keys()])) {
    if (SUMMARY_SKIP.has(p) || p === 'id' || p === 'version') continue;
    const x = fa.has(p) ? fa.get(p) : null;
    const y = fb.has(p) ? fb.get(p) : null;
    if (JSON.stringify(x) !== JSON.stringify(y)) out.push([p, x, y]);
  }
  return out;
}

function actionNode(x, { failed = false } = {}) {
  const p = actionParts(x);
  if (!p) return h('span', { class: 'muted' }, 'none recorded');
  return h('span', null,
    isNum(p.time) ? `${fmtEt(p.time, { date: true })} · ` : '',
    p.label ? h('strong', null, p.label) : null,
    p.code ? [' ', badge(p.code, { tone: failed ? 'bad' : 'neutral', title: p.stage ? `stage: ${p.stage}` : undefined })] : null,
    p.code && p.stage ? h('span', { class: 'muted' }, ` ${p.stage}`) : null,
    p.detail && p.detail !== p.code ? ` — ${p.detail}` : '',
    p.more ? h('span', { class: 'muted' }, ` (+${p.more} more)`) : null,
    p.orders ? h('span', { class: 'muted' }, ` · ${p.orders} order${p.orders > 1 ? 's' : ''}`) : null);
}

function scanBlock(a) {
  const w = scanWhy(a.scan_summary);
  const link = h('a', { class: 'tap', href: `#/journal?agent_id=${encodeURIComponent(a.id)}&type=AGENT_SCAN` }, 'This agent’s scans in the journal ›');
  if (!w) return h('div', { class: 'scan-why' }, h('p', { class: 'small note' }, scanWhyText(null)));
  return h('div', { class: 'scan-why' },
    h('h3', { class: 'section-title' }, w.entriesPlanned ? 'Activity this session' : 'Why no entries'),
    h('p', { class: 'small' }, scanWhyText(a.scan_summary)),
    w.top.length ? h('ul', { class: 'small' }, w.top.map(([c, n]) => {
      const t = skipThresholdText(c, a.strategy);
      return h('li', null, h('strong', null, skipLabel(c)), ` — ${fmtInt(n)} symbol-minutes`, t ? h('span', { class: 'muted' }, ` (${t})`) : null);
    })) : null,
    w.nearMisses.length ? h('p', { class: 'small muted' }, `Near misses (failed only this check): ${w.nearMisses.map(([c, n]) => `${skipLabel(c)} ${fmtInt(n)}`).join('; ')}.`) : null,
    w.denied.length ? h('p', { class: 'small muted' }, `Policy-gate denials: ${w.denied.map(([c, n]) => `${c} ${fmtInt(n)}`).join('; ')}.`) : null,
    w.outsideWindow ? h('p', { class: 'small muted' }, `${fmtInt(w.outsideWindow)} symbol-minutes were outside the entry window (before enough session history, or in the last minutes before the close).`) : null,
    w.modelNotConfirmed ? h('p', { class: 'small muted' }, `${fmtInt(w.modelNotConfirmed)} proposals were not confirmed by the model.`) : null,
    h('p', { class: 'small muted' }, 'Counts are symbol-minutes in this replay session; one symbol can fail several checks in the same minute. Diagnostic only — not recommendations.'),
    link);
}

function ambiguityBlock(st) {
  const list = arr(st?.ambiguities).filter((x) => obj(x));
  const tp = obj(st?.exits?.takeProfit);
  const alt = obj(tp?.alternative);
  if (!list.length && !alt) return null;
  return h('div', { class: 'state t-warn' },
    h('div', { class: 'badges' }, badge('OPEN AMBIGUITIES', { tone: 'warn' })),
    alt ? h('p', { class: 'detail' }, `Take-profit readings: ${strategyValueText('exits.takeProfit.multiple', tp.multiple)} the entry reference (default) vs ${strategyValueText('exits.takeProfit.multiple', alt.multiple)} (${String(alt.reading ?? 'alternative reading')}).`) : null,
    list.length ? h('ul', { class: 'ambiguities small' }, list.map((x) => h('li', null,
      h('strong', null, String(x.note ?? x.id ?? 'Ambiguity')),
      obj(x.readings) ? h('div', null, `Readings: ${Object.values(x.readings).map(String).join(' | ')}`) : null,
      x.default ? h('div', null, `Default used: ${String(x.default)}`) : null,
      x.open ? h('div', { class: 'muted' }, `Open question: ${String(x.open)}`) : null,
      x.workedExampleInconsistency ? h('div', { class: 'muted' }, String(x.workedExampleInconsistency)) : null))) : null);
}

const KEY_FIELDS = ['decisionMode', 'signal.windowMin', 'entry.minRetPct', 'entry.minRelVol', 'entry.maxSpreadBps', 'entry.minPriceU', 'entry.maxPriceU',
  'entry.budgetUsd', 'exits.stopLoss.basis', 'exits.stopLoss.pct', 'exits.takeProfit.basis', 'exits.takeProfit.pct', 'exits.takeProfit.multiple'];

function strategySummary(st) {
  const flat = flattenStrategy(st).filter(([p]) => !SUMMARY_SKIP.has(p) && !p.startsWith('exits.takeProfit.alternative'));
  const byPath = new Map(flat);
  const keyRows = KEY_FIELDS.filter((p) => byPath.has(p) || (p === 'exits.takeProfit.basis' && getPath(st, 'exits.takeProfit') === null));
  const kvOf = (paths) => kv(Object.fromEntries(paths.map((p) => [p, p === 'exits.takeProfit.basis' && getPath(st, 'exits.takeProfit') === null ? 'No take-profit' : strategyValueText(p, byPath.get(p))])),
    { labels: Object.fromEntries(paths.map((p) => [p, pathLabel(p)])) });
  return h('div', { class: 'stack' },
    typeof st.name === 'string' ? h('p', { class: 'small' }, h('strong', null, st.name), st.id ? h('span', { class: 'muted' }, ` · ${st.id}`) : null) : null,
    typeof st.description === 'string' ? h('p', { class: 'small note' }, st.description) : null,
    // Key settings sit behind a disclosure so six agent cards stay scannable on a phone; the EXPLORATORY DEFAULTS
    // banner, the strategy name and description stay visible above it.
    keyRows.length ? h('details', null, h('summary', null, `Key settings (${keyRows.length})`), kvOf(keyRows)) : null,
    ambiguityBlock(st),
    h('details', null, h('summary', null, `All strategy fields (${flat.length})`), kvOf(flat.map(([p]) => p))),
    arr(st.notes).length ? h('details', null, h('summary', null, `Strategy notes (${arr(st.notes).length})`), h('ul', { class: 'small note' }, arr(st.notes).map((t) => h('li', null, String(t))))) : null);
}

export function render(root, { store }) {
  let alive = true;
  const load = makeLoader(() => alive);
  const killBody = h('div');
  const killResult = h('div', { role: 'status', 'aria-live': 'polite' });
  const agentsBody = h('div', null, loading('agents'));
  const cards = new Map();
  let cardIds = '';
  let presets = [];
  let lastSig = '';
  let lastKill = '';
  let lastLoadWall = 0;

  root.append(
    pageHeader('Agents', { sub: 'Agents propose typed paper-order intents under explicit strategies; a deterministic policy gate decides. Nothing here touches real money.' }),
    h('div', { class: 'stack' },
      card({ title: 'Global kill switch' }, killBody, killResult),
      agentsBody));

  // ---------------------------------------------------------------- kill switch
  function drawKill() {
    const st = store.status;
    if (!st) {
      replace(killBody, statusBlock('UNKNOWN', 'Kill-switch state is unknown while the API is unreachable.', 'Controls are disabled until the server responds.'));
      return;
    }
    const k = obj(st.kill) || {};
    if (k.engaged) {
      const btn = h('button', { type: 'button', class: 'btn' }, 'Release kill switch…');
      const area = h('div');
      btn.addEventListener('click', () => replace(area, confirmBox({
        title: 'Release the kill switch?',
        body: h('p', { class: 'small' }, 'New orders are allowed again, but every agent stays STOPPED until you resume it individually.'),
        confirmLabel: 'Release',
        onConfirm: async () => {
          const res = await api.post('/api/kill/release', {});
          if (!alive) return;
          replace(area); replace(killResult, decisionResult(res));
          announce(res.ok ? 'Kill switch released. Agents remain stopped.' : `Release failed: ${res.error?.message ?? ''}`);
          pokeStatus(); loadAgents();
        },
        onCancel: () => replace(area),
      })));
      replace(killBody,
        statusBlock('KILL SWITCH ENGAGED', 'All agent authority is suspended; new orders are denied except human cancels.',
          [isNum(num(k.at)) ? `Engaged ${fmtEt(num(k.at), { date: true })}` : null, k.by ? `by ${k.by}` : null, k.protective_policy ? `protective policy ${k.protective_policy}` : null].filter(Boolean).join(' · '), { tone: 'bad' }),
        h('div', { class: 'btn-row' }, btn), area);
      return;
    }
    const name = nextId('kp');
    const radio = (val, title, desc, checked) => h('label', { class: 'radio-card' },
      h('input', { type: 'radio', name, value: val, checked }),
      h('span', null, h('span', { class: 't' }, title), h('span', { class: 'd' }, desc)));
    const group = h('div', { class: 'radio-cards', role: 'radiogroup', 'aria-label': 'Protective order policy' },
      radio('KEEP_PROTECTIVE', 'Keep protective exits', 'Stop all agents and cancel pending entries; existing stop-loss / take-profit orders keep working.', true),
      radio('CANCEL_ALL', 'Cancel everything', 'Stop all agents and cancel every working order, including protective exits (positions become unprotected).', false));
    const btn = h('button', { type: 'button', class: 'btn btn-danger' }, 'Engage kill switch…');
    const area = h('div');
    btn.addEventListener('click', () => {
      const policy = group.querySelector('input:checked')?.value || 'KEEP_PROTECTIVE';
      replace(area, confirmBox({
        title: 'Engage the global kill switch?',
        body: h('p', { class: 'small' }, `Every agent stops immediately and the policy gate denies all new orders except human cancels. Protective policy: ${policy}.`),
        confirmLabel: 'Engage kill switch', danger: true,
        onConfirm: async () => {
          const res = await api.post('/api/kill', { protective_policy: policy });
          if (!alive) return;
          replace(area); replace(killResult, decisionResult(res));
          announce(res.ok ? 'Kill switch engaged.' : `Kill switch request failed: ${res.error?.message ?? ''}`);
          pokeStatus(); loadAgents();
        },
        onCancel: () => replace(area),
      }));
    });
    replace(killBody,
      h('div', { class: 'badges' }, badge('NOT ENGAGED', { tone: 'neutral' })),
      h('p', { class: 'note' }, 'Stops all agents at once. Choose what happens to protective exit orders:'),
      group, h('div', { class: 'btn-row' }, btn), area);
  }

  // ---------------------------------------------------------------- agents (keyed cards, updated in place)
  function loadAgents() {
    lastLoadWall = Date.now();
    return load('agents', '/api/agents', null, 'Agents', (d) => {
      presets = presetList(obj(d)?.presets);
      const agents = rowsOf(d, 'agents').map(normAgent).filter((a) => a.id);
      if (!agents.length) {
        cards.clear(); cardIds = '';
        replace(agentsBody, statusBlock('NONE RETURNED', 'No agents exist yet.', 'Agents are created with the replay session portfolios (Replay › Reset).'));
        return;
      }
      const order = (a) => (a.segment === 'large' ? 10 : 0) + LENSES.findIndex((l) => l.id === a.lens);
      agents.sort((a, b) => order(a) - order(b));
      const ids = agents.map((a) => a.id).join('|');
      if (ids !== cardIds) {
        cards.clear();
        cardIds = ids;
        replace(agentsBody, h('div', { class: 'agent-grid' }, agents.map((a) => { const c = agentCard(a); cards.set(a.id, c); return c.el; })));
      } else {
        for (const a of agents) cards.get(a.id)?.update(a);
      }
    }).then((res) => { if (res && !res.ok && !cards.size) replace(agentsBody, errorBlock(res, 'Agents')); });
  }

  function agentCard(first) {
    const lens = LENSES.find((l) => l.id === first.lens);
    const title = `${lens?.label ?? first.lens ?? 'Agent'} · ${SEGMENT_LABELS[first.segment] ?? first.segment ?? ''}`;
    const badgeSlot = h('span');
    const liveBody = h('div', { class: 'stack' });
    const result = h('div', { role: 'status', 'aria-live': 'polite', tabindex: '-1' });
    const area = h('div');
    const stratSlot = h('div', { class: 'stack' });
    const open = new Set(); // strategy-section widgets that are open or dirty
    let cur = first;
    let stratSig = null;

    // force: rebuild even when the strategy is unchanged (e.g. "Discard changes" resets the form).
    const setEditing = (key, on, force = false) => {
      if (on) open.add(key); else open.delete(key);
      if (!open.size && (force || JSON.stringify(cur.strategy ?? null) !== stratSig)) drawStrategy();
    };

    const act = (verb, label, needsConfirm) => {
      const b = h('button', { type: 'button', class: ['btn', verb === 'pause' ? 'btn-ghost' : null], 'data-focus-key': `${first.id}-${verb}` }, label);
      const go = async () => {
        const res = await api.post(`/api/agents/${encodeURIComponent(cur.id)}/${verb}`, {});
        if (!alive) return;
        replace(area); replace(result, decisionResult(res));
        announce(res.ok ? `${title}: ${verb} requested.` : `${title}: ${verb} failed — ${res.error?.message ?? ''}`);
        pokeStatus(); loadAgents();
      };
      b.addEventListener('click', () => {
        if (!needsConfirm) { go(); return; }
        const killed = !!store.status?.kill?.engaged;
        replace(area, confirmBox({
          title: `${label} ${title}?`,
          body: h('p', { class: 'small' }, `Grants this agent authority to propose and submit PAPER orders for portfolio ${cur.portfolio_id ?? cur.id} under its strategy. Every intent still passes the policy gate.${killed ? ' The kill switch is engaged — the server will refuse until it is released.' : ''}`),
          confirmLabel: label,
          onConfirm: go,
          onCancel: () => replace(area),
        }));
      });
      return b;
    };
    const buttons = { start: act('start', 'Start', true), pause: act('pause', 'Pause', false), resume: act('resume', 'Resume', true) };

    function syncButtons() {
      const had = document.activeElement;
      const s = cur.state;
      const noStatus = !store.status;
      buttons.start.disabled = noStatus || s === 'RUNNING';
      buttons.pause.disabled = noStatus || s !== 'RUNNING';
      buttons.resume.disabled = noStatus || s !== 'PAUSED';
      if (had && had.disabled && Object.values(buttons).includes(had)) result.focus({ preventScroll: true });
    }

    function drawLive() {
      const modelStatus = store.status?.model?.status ?? 'UNKNOWN';
      const needsModel = cur.decisionMode === 'model' || cur.decisionMode === 'model_confirm';
      const reason = stateReasonText(cur.state_reason);
      replace(badgeSlot, badge(cur.state ?? 'UNKNOWN'));
      replace(liveBody,
        reason ? h('p', { class: 'note', title: String(cur.state_reason) }, reason) : null,
        needsModel && modelStatus !== 'CONNECTED'
          ? statusBlock(['MODEL_DISCONNECTED'], `Decision mode “${cur.decisionMode}” needs a connected model; the agent is BLOCKED while the model is disconnected.`, 'Switch to “rules” or configure a model provider (Data sources).')
          : null,
        kv({
          'Decision mode': cur.decisionMode ?? 'not reported',
          Portfolio: cur.portfolio_id ?? DASH,
          'Last OK action': actionNode(cur.last_ok),
          'Last failed action': actionNode(cur.last_fail, { failed: true }),
        }),
        scanBlock(cur));
    }

    function drawStrategy() {
      stratSig = JSON.stringify(cur.strategy ?? null);
      open.clear();
      const st = cur.strategy;
      replace(stratSlot,
        h('div', { class: 'label-banner' }, typeof st?.label === 'string' ? st.label : STRATEGY_LABEL),
        st ? strategySummary(st) : statusBlock('NONE RETURNED', 'No strategy returned for this agent.'),
        st ? presetPicker(cur, title, setEditing, result) : null,
        st ? strategyEditor(cur, title, setEditing, result) : null);
    }

    function update(next) {
      cur = next;
      drawLive();
      syncButtons();
      if (!open.size && JSON.stringify(next.strategy ?? null) !== stratSig) drawStrategy();
    }

    const el = card({ title, big: true, actions: badgeSlot },
      liveBody,
      h('div', { class: 'btn-row stretch' }, buttons.start, buttons.pause, buttons.resume),
      area, result, stratSlot);
    update(first);
    return { el, update };
  }

  // ---------------------------------------------------------------- preset picker
  function presetPicker(a, title, setEditing, cardResult) {
    const list = presetsFor(presets, a.segment);
    if (!list.length) return null;
    const sel = select([['', 'Choose a preset…'], ...list.map((p) => [p.id, p.name ?? p.id])], '', { 'data-focus-key': `${a.id}-preset` });
    const id = nextId('pp');
    sel.id = id;
    const btn = h('button', { type: 'button', class: 'btn', disabled: true }, 'Review preset…');
    const area = h('div');
    const result = h('div', { role: 'status', 'aria-live': 'polite' });
    const details = h('details', { class: 'preset-picker' });
    details.addEventListener('toggle', () => setEditing('preset', details.open));
    sel.addEventListener('change', () => { btn.disabled = !sel.value; replace(area); });
    btn.addEventListener('click', () => {
      const p = list.find((x) => x.id === sel.value);
      if (!p) return;
      const diff = strategyDiff(a.strategy, p);
      replace(area, confirmBox({
        title: `Load “${p.name ?? p.id}” into ${title}?`,
        body: h('div', { class: 'stack' },
          h('div', { class: 'label-banner' }, typeof p.label === 'string' ? p.label : STRATEGY_LABEL),
          typeof p.description === 'string' ? h('p', { class: 'small' }, p.description) : null,
          arr(p.ambiguities).length ? h('p', { class: 'small note' }, `${arr(p.ambiguities).length} documented ambiguities come with this preset and stay visible on the card.`) : null,
          diff.length
            ? h('ul', { class: 'small' }, diff.slice(0, 14).map(([k, o, n]) => h('li', null, h('strong', null, pathLabel(k)), `: ${strategyValueText(k, o)} → ${strategyValueText(k, n)}`)),
              diff.length > 14 ? h('li', { class: 'muted' }, `${diff.length - 14} more changes`) : null)
            : h('p', { class: 'small' }, 'No parameter differences from the current strategy.'),
          h('p', { class: 'small muted' }, 'Takes effect from the next replay minute and is journaled (STRATEGY_CHANGED, by human). Policy-gate limits still apply.')),
        confirmLabel: 'Load preset',
        onConfirm: async () => {
          const res = await api.put(`/api/agents/${encodeURIComponent(a.id)}/strategy`, { strategy: structuredClone(p), confirm: true });
          if (!alive) return;
          // A success rebuilds this section, so its decision is shown in the card's own result area.
          replace(area); replace(res.ok ? cardResult : result, decisionResult(res));
          announce(res.ok ? `Preset loaded for ${title}.` : `Preset not loaded: ${res.error?.message ?? ''}`);
          if (res.ok) { details.open = false; setEditing('preset', false); loadAgents(); }
        },
        onCancel: () => replace(area),
      }));
    });
    details.append(h('summary', null, 'Load a preset…'),
      h('div', { class: 'stack' },
        h('div', { class: 'field' }, h('label', { for: id }, `Presets for the ${SEGMENT_LABELS[a.segment] ?? a.segment} segment`), sel),
        h('div', { class: 'btn-row' }, btn), area, result));
    return details;
  }

  // ---------------------------------------------------------------- strategy editor (schema-driven, owner units)
  function strategyEditor(a, title, setEditing, cardResult) {
    const st = a.strategy;
    const rows = [];
    const sections = {};
    let dirty = false;
    const details = h('details');
    const err = h('div', { class: 'err', role: 'alert' });
    const area = h('div');
    const result = h('div', { role: 'status', 'aria-live': 'polite' });

    const collect = () => Object.fromEntries(rows.map(({ f, input, none }) => [f.path, {
      value: f.kind === 'bool' ? !!input?.checked : input?.value,
      none: none ? none.checked : false,
    }]));
    function refresh() {
      const { next } = applyStrategyEdits(st, collect());
      for (const r of rows) {
        if (r.none && r.input) r.input.disabled = r.none.checked;
        r.row.hidden = !!((r.f.group && !obj(getPath(next, r.f.group))) || (r.f.showIf && !r.f.showIf(next)));
      }
    }
    const onEdit = () => { if (!dirty) { dirty = true; setEditing('editor', true); } refresh(); };

    for (const f of STRATEGY_FIELDS) {
      const parent = f.path.split('.').slice(0, -1).join('.');
      const curV = getPath(st, f.path);
      if (f.kind === 'group') { if (curV === undefined) continue; }
      else if (f.group) { if (getPath(st, f.group) === undefined) continue; }
      else if ((parent && !obj(getPath(st, parent))) || (curV === undefined && !f.showIf)) continue;
      const id = nextId('sf');
      let input = null;
      let none = null;
      let row;
      if (f.kind === 'group') {
        none = h('input', { type: 'checkbox', checked: curV === null, id });
        row = h('div', { class: 'field wide' }, h('label', { class: 'check', for: id }, none, ` ${f.noneLabel ?? 'None'}`));
      } else if (f.kind === 'bool') {
        input = h('input', { type: 'checkbox', checked: !!curV, id });
        row = h('div', { class: 'field' }, h('label', { class: 'check', for: id }, input, ` ${f.label}`));
      } else if (f.kind === 'enum') {
        input = select(f.options, curV ?? f.options[0][0], { id });
        row = h('div', { class: 'field' }, h('label', { for: id }, f.label), input);
      } else {
        const ui = curV === null || curV === undefined ? (f.dflt !== undefined && !obj(f.dflt) ? f.dflt : '') : toUiValue(f, curV);
        input = h('input', { type: 'number', id, step: f.step ?? (f.kind === 'int' ? '1' : 'any'), inputmode: f.kind === 'int' ? 'numeric' : 'decimal', value: String(ui ?? '') });
        if (f.nullable) none = h('input', { type: 'checkbox', checked: curV === null || (curV === undefined && f.dflt === undefined) });
        row = h('div', { class: 'field' }, h('label', { for: id }, fieldLabel(f.path)), input,
          none ? h('label', { class: 'check' }, none, ` ${f.noneLabel ?? 'No limit'}`) : null);
      }
      for (const el of [input, none]) if (el) { el.addEventListener('input', onEdit); el.addEventListener('change', onEdit); }
      rows.push({ f, input, none, row });
      const sec = f.path.includes('.') ? f.path.split('.')[0] : '';
      (sections[sec] ??= []).push(row);
    }
    refresh();

    const discard = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Discard changes');
    discard.addEventListener('click', () => { dirty = false; setEditing('editor', false, true); announce('Strategy edits discarded.'); });
    details.addEventListener('toggle', () => setEditing('editor', details.open || dirty));

    const form = h('form', { class: 'stack', novalidate: true },
      h('p', { class: 'small note' }, `Prices in USD, ages in seconds, buy share in percent; the server stores its own units and validates every value. Lens, segment and id are fixed for this agent. Parameters remain ${STRATEGY_LABEL}.`),
      Object.entries(sections).map(([sec, list]) => h('fieldset', null, h('legend', null, SECTION_TITLES[sec] ?? humanizeKey(sec)), h('div', { class: 'form-grid two' }, list))),
      err, h('div', { class: 'btn-row' }, h('button', { type: 'submit', class: 'btn' }, 'Review changes…'), discard), area, result);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const r = applyStrategyEdits(st, collect());
      err.textContent = r.errors.join(' ');
      if (r.errors.length) return;
      if (!r.changes.length) { replace(area, h('p', { class: 'note' }, 'No changes.')); return; }
      replace(area, confirmBox({
        title: `Save strategy for ${title}?`,
        body: h('div', { class: 'stack' },
          h('ul', { class: 'small' }, r.changes.map(([k, o, n]) => h('li', null, h('strong', null, pathLabel(k)), `: ${strategyValueText(k, o)} → ${strategyValueText(k, n)}`))),
          h('p', { class: 'small muted' }, `Takes effect from the next replay minute and is journaled. Parameters remain ${STRATEGY_LABEL}; policy-gate limits still apply.`)),
        confirmLabel: 'Save strategy',
        onConfirm: async () => {
          const res = await api.put(`/api/agents/${encodeURIComponent(a.id)}/strategy`, { strategy: r.next, confirm: true });
          if (!alive) return;
          replace(area); replace(res.ok ? cardResult : result, decisionResult(res));
          announce(res.ok ? 'Strategy saved.' : `Strategy not saved: ${res.error?.message ?? ''}`);
          if (res.ok) { dirty = false; details.open = false; setEditing('editor', false); loadAgents(); }
        },
        onCancel: () => replace(area),
      }));
    });
    details.append(h('summary', null, 'Edit strategy'), form);
    return details;
  }

  drawKill();
  loadAgents();

  return {
    onStatus(st, info) {
      const s = st.status;
      const killSig = JSON.stringify(s?.kill ?? null) + String(!!s);
      if (killSig !== lastKill) { lastKill = killSig; drawKill(); }
      const sig = JSON.stringify([arr(s?.agents).map((x) => [x?.id, x?.state, x?.state_reason, x?.last_ok, x?.last_fail, x?.strategy_id, x?.decisionMode]),
        s?.model?.status ?? null, !!s?.kill?.engaged]);
      if (sig !== lastSig) { const had = lastSig; lastSig = sig; if (had) { loadAgents(); return; } }
      // Scan summaries grow as the replay advances: refresh them at most every 15 s of wall time.
      if (info?.clockChanged && Date.now() - lastLoadWall > 15000) loadAgents();
    },
    destroy() { alive = false; },
  };
}
