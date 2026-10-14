/**
 * Scripted dice. `faces(6, 3, 5)` is the random sequence that makes two d6
 * show 3 and 5; join several with `script(...)` for formulas with mixed dice.
 */
export function faces(sides: number, ...values: number[]): number[] {
  return values.map((v) => (v - 0.5) / sides);
}

/** For dice whose faces run from `min` to `max` (custom ranges, Fudge from -1 to 1). */
export function ranged(min: number, max: number, ...values: number[]): number[] {
  return values.map((v) => (v - min + 0.5) / (max - min + 1));
}

/** A random source that returns `values` in order and fails if it runs out. */
export function script(...parts: number[][]): () => number {
  const values = parts.flat();
  let i = 0;
  return () => {
    if (i >= values.length) throw new Error(`The scripted dice ran out after ${values.length} rolls.`);
    return values[i++];
  };
}
