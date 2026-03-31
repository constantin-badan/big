/**
 * Adaptive parameter bounds.
 *
 * After each grind round, analyzes winners vs losers to narrow
 * both PM and per-template scanner parameter ranges.
 * Persists to grind-bounds.json.
 *
 * Approach: IQR of top 25% performers, floor at 50% of original range.
 */
import type { ParamBounds, ParamSpec, ScannerTemplate, TournamentCandidate, TournamentState } from '@trading-bot/types';

const BOUNDS_PATH = './grind-bounds.json';

function unsafeCast<T>(value: unknown): T;
function unsafeCast(value: unknown) {
  return value;
}

export interface AdaptiveBounds {
  pmParams: ParamBounds;
  scannerParams: Record<string, ParamBounds>; // keyed by template name
  roundsAnalyzed: number;
}

const DEFAULT_PM_BOUNDS: ParamBounds = {
  stopLossPct: { min: 1, max: 10, step: 0.5 },
  takeProfitPct: { min: 0.5, max: 8, step: 0.5 },
  maxHoldTimeHours: { min: 999, max: 999, step: 1 },
  trailingActivationPct: { min: 0, max: 5, step: 0.5 },
  trailingDistancePct: { min: 0.2, max: 3, step: 0.1 },
  breakevenPct: { min: 0, max: 3, step: 0.5 },
};

export function getDefaultScannerBounds(templates: readonly ScannerTemplate[]): Record<string, ParamBounds> {
  const result: Record<string, ParamBounds> = {};
  for (const t of templates) {
    result[t.name] = { ...t.params };
  }
  return result;
}

export async function loadBounds(templates: readonly ScannerTemplate[]): Promise<AdaptiveBounds> {
  try {
    const raw = await Bun.file(BOUNDS_PATH).text();
    const loaded = unsafeCast<AdaptiveBounds>(JSON.parse(raw));
    // Ensure all templates have bounds (new templates get defaults)
    if (!loaded.scannerParams) loaded.scannerParams = {};
    for (const t of templates) {
      if (!loaded.scannerParams[t.name]) {
        loaded.scannerParams[t.name] = { ...t.params };
      }
    }
    return loaded;
  } catch {
    return {
      pmParams: DEFAULT_PM_BOUNDS,
      scannerParams: getDefaultScannerBounds(templates),
      roundsAnalyzed: 0,
    };
  }
}

export async function saveBounds(bounds: AdaptiveBounds): Promise<void> {
  await Bun.write(BOUNDS_PATH, JSON.stringify(bounds, null, 2) + '\n');
}

function percentile(sorted: number[], p: number): number {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

function narrowParamBounds(
  currentBounds: ParamBounds,
  candidates: TournamentCandidate[],
  getParam: (c: TournamentCandidate, param: string) => number | undefined,
): ParamBounds {
  if (candidates.length < 10) return currentBounds;

  const newBounds: ParamBounds = {};

  for (const [param, spec] of Object.entries(currentBounds)) {
    const step = spec.step ?? 1;
    const values = candidates
      .map((c) => getParam(c, param))
      .filter((v): v is number => v !== undefined)
      .sort((a, b) => a - b);

    if (values.length < 5) {
      newBounds[param] = spec;
      continue;
    }

    const q1 = percentile(values, 0.25);
    const q3 = percentile(values, 0.75);
    const originalRange = spec.max - spec.min;
    const minAllowedRange = originalRange * 0.5;

    let newMin = Math.max(spec.min, q1 - step);
    let newMax = Math.min(spec.max, q3 + step);

    newMin = spec.min + Math.floor((newMin - spec.min) / step) * step;
    newMax = spec.min + Math.ceil((newMax - spec.min) / step) * step;

    if (newMax - newMin < minAllowedRange) {
      const center = (newMin + newMax) / 2;
      newMin = center - minAllowedRange / 2;
      newMax = center + minAllowedRange / 2;
      newMin = spec.min + Math.floor((newMin - spec.min) / step) * step;
      newMax = spec.min + Math.ceil((newMax - spec.min) / step) * step;
    }

    newMin = Math.max(spec.min, newMin);
    newMax = Math.min(spec.max, newMax);

    newBounds[param] = { min: newMin, max: newMax, step };
  }

  return newBounds;
}

/**
 * Narrow both PM bounds and per-template scanner bounds
 * based on top 25% performers.
 */
export function narrowAllBounds(
  state: TournamentState,
  currentBounds: AdaptiveBounds,
): AdaptiveBounds {
  // Rank all candidates by cumulative PnL
  const pnlById = new Map<string, number>();
  for (const r of state.stageResults) {
    const prev = pnlById.get(r.candidateId) ?? 0;
    pnlById.set(r.candidateId, prev + r.totalPnl);
  }

  const candidateMap = new Map<string, TournamentCandidate>();
  for (const c of state.candidates) {
    candidateMap.set(c.id, c);
  }

  const sorted = [...pnlById.entries()].sort((a, b) => b[1] - a[1]);
  const topCount = Math.max(1, Math.ceil(sorted.length * 0.25));
  const topCandidates: TournamentCandidate[] = [];
  for (const [id] of sorted.slice(0, topCount)) {
    const c = candidateMap.get(id);
    if (c) topCandidates.push(c);
  }

  // Narrow PM bounds using all top candidates
  const newPmBounds = narrowParamBounds(
    currentBounds.pmParams,
    topCandidates,
    (c, param) => c.pmParams[param],
  );

  // Narrow scanner bounds per template
  const newScannerBounds: Record<string, ParamBounds> = {};
  const topByTemplate = new Map<string, TournamentCandidate[]>();
  for (const c of topCandidates) {
    const list = topByTemplate.get(c.templateName) ?? [];
    list.push(c);
    topByTemplate.set(c.templateName, list);
  }

  for (const [name, bounds] of Object.entries(currentBounds.scannerParams)) {
    const templateTop = topByTemplate.get(name);
    if (templateTop && templateTop.length >= 5) {
      newScannerBounds[name] = narrowParamBounds(
        bounds,
        templateTop,
        (c, param) => c.scannerParams[param],
      );
    } else {
      newScannerBounds[name] = bounds;
    }
  }

  return {
    pmParams: newPmBounds,
    scannerParams: newScannerBounds,
    roundsAnalyzed: currentBounds.roundsAnalyzed + 1,
  };
}
