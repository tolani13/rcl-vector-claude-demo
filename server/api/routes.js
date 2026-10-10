// Route table for the JSON API (docs/CONTRACTS.md section 9). Paths use :param segments; params are matched against
// a conservative character class before any handler sees them.
import { getStatus, getSources, getModel, postModelTest, getOptionsStatus } from './status.js';
import { getUniverse, getOpportunities, getBars, getBenchmark, getMacro, getDossier, getStudy } from './market.js';
import { getPortfolios, getPortfolio, postOrder, postCancel, postReplace, getJournal } from './trading.js';
import { getAgents, getAgentActivity, postAgentAction, putStrategy, postKill, postKillRelease } from './agents.js';
import { postReset, postStep, postPlay, postPause } from './replay.js';
import { postAssessmentsRun, getAssessments, getEvidenceByIdsRoute } from './intel.js';
import { postImportCsv, postOptionsOrder } from './imports.js';
import { postFeedVerify, postOptionsVerify } from './feeds.js';
import { getModelPresets, putModelSelection } from './models.js';
import { getRealStatus, postRealConnect, postRealSync, getRealAccounts, getRealTransactions } from './real.js';

const TABLE = [
  ['GET', '/api/status', getStatus],
  ['GET', '/api/sources', getSources],
  ['POST', '/api/feeds/verify', postFeedVerify],
  ['GET', '/api/model', getModel],
  ['POST', '/api/model/test', postModelTest],
  ['GET', '/api/model/presets', getModelPresets],
  ['PUT', '/api/model/selection', putModelSelection],
  // Real accounts: READ-ONLY. No order, trade or cancel route exists under /api/real/ (test/api/real-accounts.test.js).
  ['GET', '/api/real/status', getRealStatus],
  ['POST', '/api/real/connect', postRealConnect],
  ['POST', '/api/real/sync', postRealSync],
  ['GET', '/api/real/accounts', getRealAccounts],
  ['GET', '/api/real/transactions', getRealTransactions],
  ['GET', '/api/market/universe', getUniverse],
  ['GET', '/api/market/bars', getBars],
  ['GET', '/api/market/benchmark', getBenchmark],
  ['GET', '/api/macro', getMacro],
  ['GET', '/api/research/opportunities', getOpportunities],
  ['GET', '/api/research/dossier', getDossier],
  ['GET', '/api/research/study', getStudy],
  ['GET', '/api/portfolios', getPortfolios],
  ['GET', '/api/portfolios/:id', getPortfolio],
  ['POST', '/api/orders', postOrder],
  ['POST', '/api/orders/:id/cancel', postCancel],
  ['POST', '/api/orders/:id/replace', postReplace],
  ['GET', '/api/journal', getJournal],
  ['GET', '/api/agents', getAgents],
  ['GET', '/api/agents/activity', getAgentActivity],
  ['POST', '/api/agents/:id/start', postAgentAction('start')],
  ['POST', '/api/agents/:id/pause', postAgentAction('pause')],
  ['POST', '/api/agents/:id/resume', postAgentAction('resume')],
  ['PUT', '/api/agents/:id/strategy', putStrategy],
  ['POST', '/api/kill', postKill],
  ['POST', '/api/kill/release', postKillRelease],
  ['POST', '/api/replay/reset', postReset],
  ['POST', '/api/replay/step', postStep],
  ['POST', '/api/replay/play', postPlay],
  ['POST', '/api/replay/pause', postPause],
  ['POST', '/api/assessments/run', postAssessmentsRun],
  ['GET', '/api/assessments', getAssessments],
  ['GET', '/api/evidence', getEvidenceByIdsRoute],
  ['GET', '/api/options/status', getOptionsStatus],
  ['POST', '/api/options/verify', postOptionsVerify],
  ['POST', '/api/options/orders', postOptionsOrder],
  ['POST', '/api/import/csv', postImportCsv],
];

const PARAM_CHARS = '([A-Za-z0-9_\\-:.]{1,80})';

export const ROUTES = TABLE.map(([method, path, handler]) => {
  const names = [];
  const re = new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:([a-z]+)/g, (_, n) => { names.push(n); return PARAM_CHARS; })}$`);
  return { method, path, re, names, handler };
});

/**
 * Resolve a request to a route.
 * @returns {{route:object, params:object} | {methodNotAllowed:true, allow:string[]} | null}
 */
export function match(method, pathname) {
  const hits = [];
  for (const r of ROUTES) {
    const m = r.re.exec(pathname);
    if (!m) continue;
    const params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
    if (r.method === method || (method === 'HEAD' && r.method === 'GET')) return { route: r, params };
    hits.push(r.method);
  }
  return hits.length ? { methodNotAllowed: true, allow: [...new Set(hits)] } : null;
}
