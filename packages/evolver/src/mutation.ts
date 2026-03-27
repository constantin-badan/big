import type { ParamBounds, ParamSpec } from './types';

/**
 * Generate a sample from a standard normal distribution using Box-Muller transform.
 * Returns a value drawn from N(0, 1).
 */
export function gaussianRandom(): number {
  // Box-Muller transform: generate two uniform random numbers and convert to normal
  let u1 = Math.random();
  let u2 = Math.random();

  // Avoid log(0) — extremely rare but guard against it
  while (u1 === 0) {
    u1 = Math.random();
  }
  while (u2 === 0) {
    u2 = Math.random();
  }

  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

/**
 * Clamp a value to the [min, max] range defined by a ParamSpec,
 * and snap to step grid if step is defined.
 */
export function clampAndSnap(value: number, spec: ParamSpec): number {
  let clamped = Math.max(spec.min, Math.min(spec.max, value));

  if (spec.step !== undefined) {
    // Snap to nearest step from min
    const steps = Math.round((clamped - spec.min) / spec.step);
    clamped = spec.min + steps * spec.step;
    // Re-clamp after snapping (rounding could push past max)
    clamped = Math.max(spec.min, Math.min(spec.max, clamped));
  }

  return clamped;
}

/**
 * Apply proportional mutation to a single parameter value.
 *
 * newValue = oldValue * (1 + gaussian(0, mutationRate))
 *
 * Special case: if oldValue is 0, use additive mutation from the param range
 * to avoid being stuck at zero forever.
 */
function mutateValue(value: number, mutationRate: number, spec: ParamSpec): number {
  if (value === 0) {
    // Additive mutation from center of range to escape zero
    const range = spec.max - spec.min;
    const perturbation = gaussianRandom() * mutationRate * range;
    return clampAndSnap((spec.min + spec.max) / 2 + perturbation, spec);
  }

  const perturbation = gaussianRandom() * mutationRate;
  const newValue = value * (1 + perturbation);
  return clampAndSnap(newValue, spec);
}

/**
 * Mutate a full parameter vector. Each parameter is independently mutated
 * with proportional gaussian noise, then clamped and snapped to bounds.
 */
export function mutateParams(
  params: Record<string, number>,
  bounds: ParamBounds,
  mutationRate: number,
): Record<string, number> {
  const result: Record<string, number> = {};

  for (const [key, value] of Object.entries(params)) {
    const spec = bounds[key];
    if (spec === undefined) {
      // No bounds for this param — pass through unchanged
      result[key] = value;
      continue;
    }
    result[key] = mutateValue(value, mutationRate, spec);
  }

  return result;
}
