// #/about — RCL full lockup (owner-approved original artwork), motto, what VECTOR is, the data-truth contract summary,
// and the deployment statement (local MVP, not publicly deployed).
import { h } from '../dom.js';
import { card, pageHeader, kv } from '../components.js';
import { obj } from '../format.js';
import { deployNote } from '../deploy-note.js';

const TRUTH = [
  'Only the seed money is fictional. Symbols, prices, quotes, volumes, filings, publications and assessments shown as research or market inputs come from real, traceable, time-stamped sources — or are shown as unavailable.',
  'When data is missing the interface says so (NO_VERIFIED_DATA, BLOCKED, PROVIDER_FAULT, UNAVAILABLE_NOT_VERIFIED, MODEL DISCONNECTED / ASSESSMENT NOT RUN, NO_VERIFIED_OPTIONS_DATA). Nothing is filled in to keep a screen busy.',
  'Replay is strictly as-of: a minute bar becomes visible only after it completes on the replay clock; evidence only after it was publicly knowable. Retrospective studies are labelled and never reach agents.',
  'Paper fills are estimates from observed IEX quotes and trades with conservative, listed assumptions (worst price in the minute, slippage, fees). If a fill cannot be credibly modelled it is withheld.',
  'Agents propose typed intents; a deterministic, deny-by-default policy gate decides. A global kill switch and per-agent pause are always available, and every action is journaled in a hash chain.',
  'There is no live-broker code path. Paper only — no real money, no real orders.',
];

export function render(root, { store }) {
  const app = obj(store.status?.app) || {};
  root.append(
    pageHeader('About VECTOR', { sub: 'A Recursive Chaos Labs product' }),
    h('div', { class: 'grid grid-12' },
      card({ title: 'Recursive Chaos Labs', cls: 'span-5' },
        h('img', { class: 'about-lockup', src: 'assets/RCL_Copper_Steel_Full_814x502.png', alt: 'Recursive Chaos Labs — Refining Chaos Into Clarity.', width: '814', height: '502' }),
        h('p', { class: 'brand-motto' }, 'Refining Chaos Into Clarity.')),
      card({ title: 'What VECTOR is', cls: 'span-7' },
        h('p', null, h('strong', null, 'VECTOR'), ' is a paper-only research and agent-operated paper-trading laboratory. It replays real, sourced historical market sessions, ranks symbols by measured signal metrics (never recommendations), builds as-of evidence dossiers, asks three independent risk lenses — Cowboy, Pragmatist, Tightwad — for model assessments when a model is configured, and lets rule-bound agents run six comparison portfolios plus a human sandbox under a deterministic policy gate.'),
        h('p', { class: 'note' }, 'Initial emphasis: U.S.-tradable penny/microcap equities, compared against a configured large-cap reference segment.'),
        kv({
          Build: app.version ? `v${app.version}` : 'version not reported',
          Trading: 'PAPER ONLY — NO LIVE TRADING',
          'Live broker': app.liveBroker ?? 'NONE — out of MVP scope',
          Deployment: deployNote({ apiReachable: store?.status ? true : null, deployment: store?.status?.app?.deployment ?? null }).long,
        })),
      card({ title: 'Data truth contract', cls: 'span-12' }, h('ul', { class: 'stack' }, TRUTH.map((t) => h('li', null, t))))));
  return null;
}
