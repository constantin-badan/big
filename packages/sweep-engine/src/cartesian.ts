import type { SweepParamGrid } from '@trading-bot/types';

export function cartesianProduct(grid: SweepParamGrid): Record<string, number>[] {
  const keys = Object.keys(grid);
  if (keys.length === 0) return [];

  let combos: Record<string, number>[] = [{}];

  for (const key of keys) {
    const values = grid[key];
    if (values === undefined || values.length === 0) return [];
    const next: Record<string, number>[] = [];
    for (const combo of combos) {
      for (const value of values) {
        next.push({ ...combo, [key]: value });
      }
    }
    combos = next;
  }

  return combos;
}
