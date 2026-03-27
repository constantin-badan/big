/** Reinterpret `unknown` as `T` without an `as` expression (lint-safe). */
export function unsafeCast<T>(value: unknown): T;
export function unsafeCast(value: unknown) {
  return value;
}
