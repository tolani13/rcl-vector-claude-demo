// Model presets and the per-lens / pinned selection (docs/CONTRACTS.md sections 8a and 9). Secret-free: presets carry
// key presence only; a selection holds preset ids, model names and optional owner-set training cutoffs.
import { loadPresets, presetPublic, presetBudget, normalizeSelection, saveSelection, selectionSummary, SelectionError, DEFAULT_PRESET_ID } from '../intel/providers/presets.js';
import { append } from '../journal.js';
import { ApiError, badRequest, onlyKeys } from './http.js';

/** GET /api/model/presets — the catalog (validated), each preset's local budget, and the effective selection. */
export function getModelPresets(ctx) {
  const cat = loadPresets({ env: ctx.env });
  return {
    catalog: { loaded: cat.loaded, errors: cat.errors },
    defaultPreset: DEFAULT_PRESET_ID,
    allowPaid: String(ctx.env.VECTOR_ALLOW_PAID ?? '').trim() === '1',
    presets: [...cat.presets.values()].map((p) => ({ ...presetPublic(p, ctx.env), localBudget: presetBudget(ctx.db, p) })),
    selection: selectionSummary(ctx.db, ctx.env),
    note: 'cost, trains_on_prompts and limits come from config/model-presets.json with each provider\'s source URL. Paid presets are refused unless VECTOR_ALLOW_PAID=1. Real-account data is only sent to presets with trains_on_prompts false.',
  };
}

/**
 * PUT /api/model/selection {default:{preset, model?, trainingCutoff?}, lenses?:{cowboy?, pragmatist?, tightwad?},
 * pinAllLenses?:boolean} or {clear:true} (back to the environment / legacy provider). Journaled as MODEL_SELECTION_CHANGED.
 */
export function putModelSelection(ctx, _req, { body }) {
  onlyKeys(body, ['default', 'lenses', 'pinAllLenses', 'clear']);
  let sel = null;
  if (body.clear === true) {
    if (Object.keys(body).length !== 1) throw badRequest('SELECTION_INVALID', 'clear:true takes no other fields');
  } else {
    if (body.clear !== undefined) throw badRequest('SELECTION_INVALID', 'clear must be true when given');
    try {
      sel = normalizeSelection({ default: body.default, lenses: body.lenses, pinAllLenses: body.pinAllLenses }, loadPresets({ env: ctx.env }).presets);
    } catch (e) {
      if (e instanceof SelectionError) throw badRequest(e.code, e.message);
      throw e;
    }
  }
  saveSelection(ctx.db, sel);
  const summary = selectionSummary(ctx.db, ctx.env);
  const st = ctx.replay();
  append(ctx.db, {
    session_id: st.session_id, ts_sim: st.clock, actor: 'human', type: 'MODEL_SELECTION_CHANGED', ref_id: null,
    payload: { selection: sel, cleared: sel === null, sameModelAllLenses: summary.sameModelAllLenses, lenses: Object.fromEntries(Object.entries(summary.lenses).map(([l, r]) => [l, { preset: r.preset, model: r.model, blocked: r.blocked }])) },
  });
  if (!summary) throw new ApiError(500, 'INTERNAL_ERROR', 'selection could not be read back');
  return { status: 'SAVED', selection: summary };
}
