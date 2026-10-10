// #/more — phone menu for the views that do not fit the five-tab bar (also reachable on desktop).
import { h, icon } from '../dom.js';
import { pageHeader, badge } from '../components.js';
import { arr } from '../format.js';
import { deployNote } from '../deploy-note.js';

const ITEMS = [
  ['agents', 'Agents', 'States, strategies, start / pause / resume, global kill switch'],
  ['replay', 'Replay', 'Historical session clock, step, reset funds, retrospective study'],
  ['sources', 'Data sources', 'Provenance, status, model presets, setup, CSV import'],
  ['real', 'Real accounts', 'Your brokerage accounts via SnapTrade — read only, never traded'],
  ['about', 'About', 'Recursive Chaos Labs, data truth contract'],
];

export function render(root, { store }) {
  const summary = h('span', { class: 'badges' });
  const draw = () => {
    const st = store.status;
    summary.replaceChildren();
    if (!st) { summary.append(badge('API UNREACHABLE')); return; }
    const agents = arr(st.agents);
    const running = agents.filter((a) => a?.state === 'RUNNING').length;
    summary.append(badge(`${running}/${agents.length} agents running`, { tone: running ? 'ok' : 'neutral' }));
    if (st.kill?.engaged) summary.append(badge('KILL SWITCH ENGAGED', { tone: 'bad', solid: true }));
  };
  draw();
  root.append(
    pageHeader('More'),
    h('ul', { class: 'nav-list' }, ITEMS.map(([id, t, s]) => h('li', null, h('a', { href: `#/${id}` }, icon(id),
      h('span', null, h('span', { class: 't' }, t), h('span', { class: 's' }, s), id === 'agents' ? summary : null))))),
    h('div', { class: 'divider' }),
    h('div', { class: 'stack' },
      h('div', { class: 'side-brand' },
        h('div', { class: 'lockup' }, h('img', { src: 'assets/RCL_Copper_Steel_Mark_40.png', srcset: 'assets/RCL_Copper_Steel_Mark_40.png 1x, assets/RCL_Copper_Steel_Mark_80.png 2x, assets/RCL_Copper_Steel_Mark_120.png 3x', alt: 'Recursive Chaos Labs copper and steel mark', width: '40', height: '40' }), h('span', { class: 'wordmark' }, 'VECTOR')),
        h('div', { class: 'brand-sub' }, 'Recursive Chaos Labs'),
        h('div', { class: 'brand-motto' }, 'Refining Chaos Into Clarity.')),
      h('p', { class: 'small muted' }, `${deployNote({ apiReachable: store.status ? true : null, deployment: store.status?.app?.deployment ?? null }).short} · paper only — no live trading.`)));
  return { onStatus: draw };
}
