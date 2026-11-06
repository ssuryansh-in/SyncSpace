import { describe, expect, it } from "vitest";
import {
  generateRankKey,
  generateNRankKeys,
  generateKeyBetween,
  generateNKeysBetween,
  REBALANCE_THRESHOLD_LENGTH,
} from "../../src/utils/fractional-indexing.js";

describe("Fractional Indexing Utility (Unit - Milestone 6.5A)", () => {
  // A. Initial key generation
  describe("Initial Key Generation", () => {
    it("generates a valid non-empty string when boundaries are null or undefined", () => {
      const keyNull = generateRankKey(null, null);
      const keyUndef = generateRankKey(undefined, undefined);
      const keyNoArgs = generateRankKey();

      expect(typeof keyNull).toBe("string");
      expect(keyNull.length).toBeGreaterThan(0);

      expect(typeof keyUndef).toBe("string");
      expect(keyUndef.length).toBeGreaterThan(0);

      expect(typeof keyNoArgs).toBe("string");
      expect(keyNoArgs.length).toBeGreaterThan(0);

      // Re-running produces a valid deterministic initial key
      expect(keyNull).toBe(keyUndef);
      expect(keyNull).toBe(keyNoArgs);
    });

    it("generates keys that are usable in standard lexicographical comparisons and Array.sort", () => {
      const k1 = generateRankKey(null, null);
      const k2 = generateRankKey(k1, null);
      const k0 = generateRankKey(null, k1);

      const unsorted = [k2, k0, k1];
      const sorted = [...unsorted].sort();

      expect(sorted).toEqual([k0, k1, k2]);
    });
  });

  // B. Beginning insertion
  describe("Beginning Insertion (Prepend)", () => {
    it("generates a key strictly before an existing key", () => {
      const existing = generateRankKey(null, null);
      const before = generateRankKey(null, existing);

      expect(before < existing).toBe(true);
      expect(before).not.toBe(existing);
    });

    it("supports cascading beginning insertions", () => {
      let current = generateRankKey(null, null);
      for (let i = 0; i < 10; i++) {
        const earlier = generateRankKey(null, current);
        expect(earlier < current).toBe(true);
        current = earlier;
      }
    });
  });

  // C. End insertion
  describe("End Insertion (Append)", () => {
    it("generates a key strictly after an existing key", () => {
      const existing = generateRankKey(null, null);
      const after = generateRankKey(existing, null);

      expect(existing < after).toBe(true);
      expect(after).not.toBe(existing);
    });

    it("supports cascading end insertions", () => {
      let current = generateRankKey(null, null);
      for (let i = 0; i < 10; i++) {
        const later = generateRankKey(current, null);
        expect(current < later).toBe(true);
        current = later;
      }
    });
  });

  // D. Middle insertion
  describe("Middle Insertion (Between Neighbors)", () => {
    it("generates a key strictly between two existing keys", () => {
      const first = generateRankKey(null, null);
      const third = generateRankKey(first, null);
      const second = generateRankKey(first, third);

      expect(first < second).toBe(true);
      expect(second < third).toBe(true);
    });

    it("handles insertion between adjacent keys of different lengths", () => {
      const left = generateRankKey(null, null);
      const right = generateRankKey(left, null);
      const mid1 = generateRankKey(left, right);
      const mid2 = generateRankKey(left, mid1);

      expect(left < mid2).toBe(true);
      expect(mid2 < mid1).toBe(true);
      expect(mid1 < right).toBe(true);
    });
  });

  // E. Repeated insertion
  describe("Repeated Insertion Invariants", () => {
    it("generates strictly increasing, non-duplicate keys between narrowing boundaries", () => {
      const lower = generateRankKey(null, null);
      let upper = generateRankKey(lower, null);

      const generated: string[] = [lower];

      // Repeatedly insert between lower and the current upper bound
      for (let i = 0; i < 20; i++) {
        const mid = generateRankKey(lower, upper);

        expect(lower < mid).toBe(true);
        expect(mid < upper).toBe(true);

        generated.push(mid);
        upper = mid;
      }

      // Verify all keys are strictly unique
      const uniqueKeys = new Set(generated);
      expect(uniqueKeys.size).toBe(generated.length);
    });

    it("maintains sorting stability across arbitrary sequence of random insertions", () => {
      const keys: string[] = [generateRankKey(null, null)];

      for (let i = 0; i < 30; i++) {
        // Pick an insertion slot
        const slot = Math.floor(Math.random() * (keys.length + 1));
        const prev = slot === 0 ? null : keys[slot - 1]!;
        const next = slot === keys.length ? null : keys[slot]!;

        const newKey = generateRankKey(prev, next);
        keys.splice(slot, 0, newKey);
      }

      // Verify the list is strictly ordered
      for (let i = 0; i < keys.length - 1; i++) {
        expect(keys[i]! < keys[i + 1]!).toBe(true);
      }
    });
  });

  // F. Batch generation
  describe("Batch Key Generation (generateNRankKeys)", () => {
    it("generates n evenly spaced keys strictly in increasing order", () => {
      const n = 5;
      const batch = generateNRankKeys(null, null, n);

      expect(batch).toHaveLength(n);

      for (let i = 0; i < batch.length - 1; i++) {
        expect(batch[i]! < batch[i + 1]!).toBe(true);
      }
    });

    it("generates n keys placed strictly between provided boundaries", () => {
      const lower = generateRankKey(null, null);
      const upper = generateRankKey(lower, null);

      const batch = generateNRankKeys(lower, upper, 4);
      expect(batch).toHaveLength(4);

      expect(lower < batch[0]!).toBe(true);
      expect(batch[batch.length - 1]! < upper).toBe(true);

      for (let i = 0; i < batch.length - 1; i++) {
        expect(batch[i]! < batch[i + 1]!).toBe(true);
      }
    });

    it("returns an empty array when n is 0", () => {
      const batch = generateNRankKeys(null, null, 0);
      expect(batch).toEqual([]);
    });

    it("generates a single key when n is 1", () => {
      const batch = generateNRankKeys(null, null, 1);
      expect(batch).toHaveLength(1);
      expect(typeof batch[0]).toBe("string");
    });
  });

  // G. Boundary and invalid-input behavior
  describe("Boundary and Error Handling", () => {
    it("throws a clear error when a >= b in generateRankKey", () => {
      const keyA = "a0";
      const keyB = "a1";

      expect(() => generateRankKey(keyB, keyA)).toThrow(/must be strictly less than/);
      expect(() => generateRankKey(keyA, keyA)).toThrow(/must be strictly less than/);
    });

    it("throws a clear error when a >= b in generateNRankKeys", () => {
      expect(() => generateNRankKeys("a1", "a0", 3)).toThrow(/must be strictly less than/);
      expect(() => generateNRankKeys("a0", "a0", 3)).toThrow(/must be strictly less than/);
    });

    it("throws a clear error when n is negative or non-integer in generateNRankKeys", () => {
      expect(() => generateNRankKeys(null, null, -1)).toThrow(/count 'n' must be a non-negative integer/);
      expect(() => generateNRankKeys(null, null, 2.5)).toThrow(/count 'n' must be a non-negative integer/);
      expect(() => generateNRankKeys(null, null, NaN)).toThrow(/count 'n' must be a non-negative integer/);
    });
  });

  // H. Threshold constant and aliases
  describe("Configuration and Aliases", () => {
    it("exports the approved rebalance threshold constant of 32 characters", () => {
      expect(REBALANCE_THRESHOLD_LENGTH).toBe(32);
    });

    it("provides generateKeyBetween and generateNKeysBetween aliases matching the primary exports", () => {
      expect(generateKeyBetween).toBe(generateRankKey);
      expect(generateNKeysBetween).toBe(generateNRankKeys);
    });
  });
});

