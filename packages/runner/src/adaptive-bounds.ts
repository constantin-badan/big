/**
 * Adaptive parameter bounds.
 *
 * After each grind round, analyzes winners vs losers to narrow
 * parameter ranges. Persists to grind-bounds.json.
 *
 * Approach: for each PM param, compute the interquartile range (IQR)
 * of survivors. Shrink bounds toward where survivors cluster.
 * Never shrinks below 50% of original range to avoid over-narrowing.
 */
import type { ParamBounds, TournamentCandidate, TournamentState } from '@trading-bot/types';

const BOUNDS_PATH = './grind-bounds.json';

function unsafeCast<T>(value: unknown): T;
function unsafeCast(value: unknown) {
  return value;
}

export interface AdaptiveBounds {
  pmParams: ParamBounds;
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

export async function loadBounds(): Promise<AdaptiveBounds> {
  try {
    const raw = await Bun.file(BOUNDS_PATH).text();
    return unsafeCast<AdaptiveBounds>(JSON.parse(raw));
  } catch {
    return { pmParams: DEFAULT_PM_BOUNDS, roundsAnalyzed: 0 };
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

/**
 * Analyze tournament survivors and narrow PM bounds toward winning ranges.
 * Shrinks each param's range to the IQR of top 25% performers,
 * but never narrows below 50% of the original range.
 */
export function narrowBounds(
  state: TournamentState,
  currentBounds: ParamBounds,
): ParamBounds {
  // Get top 25% by cumulative PnL
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

  if (topCandidates.length < 10) {
    // Not enough data to narrow reliably
    return currentBounds;
  }

  const newBounds: ParamBounds = {};

  for (const [param, spec] of Object.entries(currentBounds)) {
    const step = spec.step ?? 1;
    const values = topCandidates
      .map((c) => c.pmParams[param])
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

    // Snap to step
    newMin = spec.min + Math.floor((newMin - spec.min) / step) * step;
    newMax = spec.min + Math.ceil((newMax - spec.min) / step) * step;

    // Ensure minimum range
    if (newMax - newMin < minAllowedRange) {
      const center = (newMin + newMax) / 2;
      newMin = center - minAllowedRange / 2;
      newMax = center + minAllowedRange / 2;
      newMin = spec.min + Math.floor((newMin - spec.min) / step) * step;
      newMax = spec.min + Math.ceil((newMax - spec.min) / step) * step;
    }

    // Clamp to original bounds
    newMin = Math.max(spec.min, newMin);
    newMax = Math.min(spec.max, newMax);

    newBounds[param] = { min: newMin, max: newMax, step };
  }

  return newBounds;
}
