/** Reinterpret `unknown` as `T` without an `as` expression (lint-safe). */
export function unsafeCast<T>(value: unknown): T;
export function unsafeCast(value: unknown) {
  return value;
}

/** Parse JSON and return the result typed as `T`. */
export function jsonParse<T>(text: string): T;
export function jsonParse(text: string) {
  return JSON.parse(text);
}
