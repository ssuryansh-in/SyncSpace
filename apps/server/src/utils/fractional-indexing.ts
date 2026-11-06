import {
  generateKeyBetween as fiGenerateKeyBetween,
  generateNKeysBetween as fiGenerateNKeysBetween,
} from "fractional-indexing";

/**
 * Maximum length of a rank key before column rebalancing is triggered.
 * Reference: docs/SPECIFICATION.md Section 7.3, ADR-06.
 */
export const REBALANCE_THRESHOLD_LENGTH = 32;

/**
 * Generates a lexicographically sortable fractional rank key strictly between
 * two optional boundary keys `a` and `b`.
 *
 * - If `a` is null/undefined and `b` is null/undefined: generates initial key (e.g. "a0").
 * - If `a` is null/undefined and `b` is provided: generates a key strictly before `b` (newKey < b).
 * - If `a` is provided and `b` is null/undefined: generates a key strictly after `a` (a < newKey).
 * - If both `a` and `b` are provided: generates a key strictly between `a` and `b` (a < newKey < b).
 *
 * @throws Error if `a` is greater than or equal to `b`.
 */
export function generateRankKey(
  a?: string | null,
  b?: string | null
): string {
  if (a !== undefined && a !== null && b !== undefined && b !== null && a >= b) {
    throw new Error(
      `Cannot generate fractional key: boundary 'a' ("${a}") must be strictly less than 'b' ("${b}")`
    );
  }
  return fiGenerateKeyBetween(a, b);
}

/**
 * Generates `n` evenly spaced, compact lexicographically sortable fractional rank keys
 * strictly between two optional boundary keys `a` and `b`.
 *
 * Typically used for column rebalancing with `a = null` and `b = null` to reset
 * all active tasks in a column to compact initial keys.
 *
 * @param a - Optional lower bound.
 * @param b - Optional upper bound.
 * @param n - Number of keys to generate (must be a non-negative integer).
 * @returns Array of `n` strictly increasing rank keys.
 * @throws Error if `n` is negative, not an integer, or if `a >= b`.
 */
export function generateNRankKeys(
  a: string | null | undefined,
  b: string | null | undefined,
  n: number
): string[] {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `Cannot generate fractional keys: count 'n' must be a non-negative integer (received ${n})`
    );
  }
  if (n === 0) {
    return [];
  }
  if (a !== undefined && a !== null && b !== undefined && b !== null && a >= b) {
    throw new Error(
      `Cannot generate fractional keys: boundary 'a' ("${a}") must be strictly less than 'b' ("${b}")`
    );
  }
  return fiGenerateNKeysBetween(a, b, n);
}

// Aliases matching upstream library names for convenience
export { generateRankKey as generateKeyBetween, generateNRankKeys as generateNKeysBetween };

