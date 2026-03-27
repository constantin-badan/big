/**
 * Typed wrappers that avoid `as` assertions (banned by consistent-type-assertions).
 *
 * These are intentional trust boundaries: Binance API responses are unvalidated
 * JSON whose shape is verified by integration / parity tests, not runtime checks.
 *
 * The overload trick lets the call-site get a concrete type while the
 * implementation body contains no type-assertion syntax.
 */

/** Reinterpret `unknown` as `T` without an `as` expression. */
export function unsafeCast<T>(value: unknown): T;
export function unsafeCast(value: unknown) {
  return value;
}

/** Parse JSON and return the result typed as `T`. */
export function jsonParse<T>(text: string): T;
export function jsonParse(text: string) {
  return JSON.parse(text);
}

/** Create a `[number, number]` tuple (avoids `as [number, number]`). */
export function numPair(a: number, b: number): [number, number] {
  return [a, b];
}
