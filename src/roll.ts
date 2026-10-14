/**
 * Rolls a parsed formula. The random source is injected, so tests can script
 * every die; `Math.random` is the default.
 */
import { DiceSyntaxError, parseFormula } from './notation.ts';
import type { Condition, Die, Modifier, Node, ParseOptions } from './notation.ts';

/** One die as rolled: its face, whether it counts, and what happened to it. */
export interface DieRoll {
  value: number;
  /** False once dropped by a keep/drop modifier or failed by a condition. */
  kept: boolean;
  /** What it adds to the total: its face, or 1/0/-1 when conditions count successes. */
  counts: number;
  /** Marks shown after the face, as in Dice Roller: `d` dropped, `!` exploded, `r` rerolled, `u` made unique, `*` success, `-` negative success. */
  marks: string;
}

export interface DiceResult {
  node: Extract<Node, { type: 'dice' }>;
  rolls: DieRoll[];
  total: number;
  /** How the term reads in the breakdown, such as `[3, 5d]`. */
  display: string;
}

export interface Outcome {
  total: number;
  /** The formula as written, with each dice term replaced by its rolls. */
  breakdown: string;
  dice: DiceResult[];
  /** Every kept die of a plain dice term showed its highest face (a natural 20). */
  allMax: boolean;
  /** Every kept die of a plain dice term showed its lowest face (a natural 1). */
  allMin: boolean;
  /** Extra lines, such as Fantasy AGE stunt points. */
  notes: string[];
  average: boolean;
}

export interface RollOptions extends ParseOptions {
  /** Returns a number in [0, 1), like `Math.random`. */
  random?: () => number;
  /** Every die shows its average instead of being rolled (Dice Roller's `|avg`). */
  average?: boolean;
  /**
   * A name in the formula: a number (a note field) or a formula (a saved
   * alias), or undefined when unknown.
   */
  resolve?: (name: string) => number | string | undefined;
}

export class RollError extends Error {}

/** Most dice one formula may roll, explosions included. */
export const MAX_DICE = 10_000;
const MAX_ALIAS_DEPTH = 10;

/** Parses and rolls `formula`. Throws `DiceSyntaxError` or `RollError` with a readable reason. */
export function rollFormula(formula: string, options: RollOptions = {}): Outcome {
  const node = parseFormula(formula, options);
  return rollNode(node, formula, options);
}

/** Like `rollFormula`, but returns the reason instead of throwing. */
export function tryRoll(formula: string, options: RollOptions = {}): { outcome: Outcome } | { error: string } {
  try {
    return { outcome: rollFormula(formula, options) };
  } catch (e) {
    if (e instanceof DiceSyntaxError || e instanceof RollError) return { error: e.message };
    throw e;
  }
}

export function rollNode(node: Node, formula: string, options: RollOptions = {}): Outcome {
  const roller = new Roller(options);
  const total = roller.evaluate(node, 0);
  const replaced: { start: number; end: number; text: string }[] = [];
  for (const d of roller.dice) replaced.push({ start: d.node.start, end: d.node.end, text: d.display });
  for (const n of roller.names) replaced.push(n);
  replaced.sort((a, b) => a.start - b.start);
  let breakdown = '';
  let at = 0;
  for (const r of replaced) {
    if (r.start < at) continue;
    breakdown += formula.slice(at, r.start) + r.text;
    at = r.end;
  }
  breakdown += formula.slice(at);

  const plain = roller.dice.filter(
    (d) => d.node.conditions.length === 0 && (d.node.die.kind === 'range' || d.node.die.kind === 'list') && d.rolls.some((r) => r.kept),
  );
  const extreme = (pick: 'max' | 'min') =>
    !options.average &&
    plain.length > 0 &&
    plain.every((d) => {
      const faces = faceBounds(d.node.die);
      return d.rolls.every((r) => !r.kept || r.value === faces[pick]);
    });
  // Dice with one face (1d1, 1d[3,3]) are at their maximum and minimum at once: neither.
  const allMax = extreme('max');
  const allMin = extreme('min');
  return {
    total,
    breakdown: breakdown.trim(),
    dice: roller.dice,
    allMax: allMax && !allMin,
    allMin: allMin && !allMax,
    notes: roller.notes,
    average: options.average === true,
  };
}

function faceBounds(die: Die): { min: number; max: number } {
  switch (die.kind) {
    case 'range':
      return { min: die.min, max: die.max };
    case 'list':
      return { min: Math.min(...die.values), max: Math.max(...die.values) };
    case 'fudge':
      return { min: -1, max: 1 };
    case 'stunt':
      return { min: 1, max: 6 };
    case 'percent':
      return { min: 1, max: Number(die.digits.join('')) };
  }
}

class Roller {
  dice: DiceResult[] = [];
  names: { start: number; end: number; text: string }[] = [];
  notes: string[] = [];
  private rolled = 0;
  private random: () => number;
  private options: RollOptions;

  constructor(options: RollOptions) {
    this.options = options;
    this.random = options.random ?? Math.random;
  }

  evaluate(node: Node, depth: number): number {
    switch (node.type) {
      case 'number':
        return node.value;
      case 'group':
        return this.evaluate(node.expr, depth);
      case 'negate':
        return -this.evaluate(node.expr, depth);
      case 'binary': {
        const a = this.evaluate(node.left, depth);
        const b = this.evaluate(node.right, depth);
        switch (node.op) {
          case '+':
            return a + b;
          case '-':
            return a - b;
          case '*':
            return a * b;
          case '/':
            if (b === 0) throw new RollError('Division by zero.');
            return a / b;
          case '^':
            return Math.pow(a, b);
        }
        break;
      }
      case 'name':
        return this.name(node, depth);
      case 'dice':
        return this.diceTerm(node, depth, true);
    }
    throw new RollError('Unknown formula part.');
  }

  private name(node: Extract<Node, { type: 'name' }>, depth: number): number {
    const found = this.options.resolve?.(node.name);
    if (found === undefined) throw new RollError(`"${node.name}" is not a saved formula or a number field of this note.`);
    let value: number;
    if (typeof found === 'number') {
      value = found;
    } else {
      if (depth >= MAX_ALIAS_DEPTH) throw new RollError(`"${node.name}" refers to itself.`);
      let inner: Node;
      try {
        inner = parseFormula(found, this.options);
      } catch (e) {
        if (e instanceof DiceSyntaxError) throw new RollError(`Saved formula "${node.name}": ${e.message}`);
        throw e;
      }
      // Its dice are rolled but not listed: the breakdown shows the name's total.
      const sub = new Roller({ ...this.options, random: this.random });
      sub.rolled = this.rolled;
      value = sub.evaluate(inner, depth + 1);
      this.rolled = sub.rolled;
      this.notes.push(...sub.notes);
    }
    this.names.push({ start: node.start, end: node.end, text: formatNumber(value) });
    return value;
  }

  private face(die: Die): number {
    if (++this.rolled > MAX_DICE) throw new RollError(`That is more than ${MAX_DICE} dice.`);
    const r = this.random();
    switch (die.kind) {
      case 'range':
        return die.min + Math.floor(r * (die.max - die.min + 1));
      case 'list':
        return die.values[Math.floor(r * die.values.length)];
      case 'fudge':
        return Math.floor(r * 3) - 1;
      case 'stunt':
        return 1 + Math.floor(r * 6);
      case 'percent':
        // Percent dice roll one die per digit in diceTerm; never reached.
        return 1 + Math.floor(r * 10);
    }
  }

  private average(die: Die): number {
    switch (die.kind) {
      case 'range':
        return (die.min + die.max) / 2;
      case 'list':
        return die.values.reduce((a, b) => a + b, 0) / die.values.length;
      case 'fudge':
        return 0;
      case 'stunt':
        return 3.5;
      case 'percent':
        return die.digits.map((d) => (d + 1) / 2).reduce((a, b) => a * 10 + b, 0);
    }
  }

  /** Rolls a dice term; `record` is false for the dice of a condition's comparison value. */
  private diceTerm(node: Extract<Node, { type: 'dice' }>, depth: number, record: boolean): number {
    let count = 1;
    if (node.count) count = Math.trunc(this.evaluate(node.count, depth));
    const sign = count < 0 ? -1 : 1;
    count = Math.abs(count);
    if (count > MAX_DICE) throw new RollError(`That is more than ${MAX_DICE} dice.`);
    const die = node.die;
    let rolls: DieRoll[];
    let display: string;

    if (die.kind === 'percent') {
      rolls = [];
      const shown: string[] = [];
      for (let k = 0; k < count; k++) {
        if (this.options.average) {
          const v = this.average(die);
          rolls.push(roll(v));
          shown.push(formatNumber(v));
          continue;
        }
        const digits = die.digits.map((d) => {
          if (++this.rolled > MAX_DICE) throw new RollError(`That is more than ${MAX_DICE} dice.`);
          return 1 + Math.floor(this.random() * d);
        });
        rolls.push(roll(Number(digits.join(''))));
        shown.push(digits.join(','));
      }
      display = `[${shown.join(' | ')}]`;
    } else if (die.kind === 'stunt') {
      if (this.options.average) {
        rolls = [roll(3.5), roll(3.5), roll(3.5)];
        display = '[3.5, 3.5], 3.5';
      } else {
        rolls = [roll(this.face(die)), roll(this.face(die)), roll(this.face(die))];
        const [a, b, s] = rolls.map((r) => r.value);
        const doubles = new Set([a, b, s]).size < 3;
        if (doubles) {
          rolls[2].marks = 'S';
          if (record) this.notes.push(`${s} Stunt Points`);
        }
        display = `[${a}, ${b}], ${s}${doubles ? 'S' : ''}`;
      }
      if (count === 0) {
        rolls = [];
        display = '[]';
      }
    } else {
      rolls = [];
      for (let k = 0; k < count; k++) rolls.push(roll(this.options.average ? this.average(die) : this.face(die)));
      const keeps: Extract<Modifier, { type: 'keep' | 'drop' }>[] = [];
      for (const m of node.modifiers) {
        if (m.type === 'keep' || m.type === 'drop') keeps.push(m);
        else if (!this.options.average) rolls = this.modify(rolls, m, die, depth);
      }
      for (const m of keeps) applyKeep(rolls, m);
      if (node.conditions.length > 0 && !this.options.average) {
        const conditions = this.comparisons(node.conditions, depth);
        const negative = conditions.filter((c) => c.op === 'neg');
        const positive = conditions.filter((c) => c.op !== 'neg');
        for (const r of rolls) {
          if (!r.kept) continue;
          if (negative.some((c) => r.value === c.target)) {
            r.counts = -1;
            r.marks += '-';
          } else if (passes(r.value, positive)) {
            r.counts = 1;
            r.marks += '*';
          } else {
            r.counts = 0;
            r.kept = false;
          }
        }
      }
      display = `[${rolls.map((r) => formatNumber(r.value) + r.marks).join(', ')}]`;
    }

    const total = sign * rolls.reduce((sum, r) => sum + (r.kept ? r.counts : 0), 0);
    if (record) this.dice.push({ node, rolls, total, display: sign < 0 ? `-${display}` : display });
    return total;
  }

  private comparisons(conditions: Condition[], depth: number): { op: Condition['op']; target: number }[] {
    return conditions.map((c) => ({
      op: c.op,
      target: c.value.type === 'dice' ? this.diceTerm(c.value, depth, false) : this.evaluate(c.value, depth),
    }));
  }

  private modify(rolls: DieRoll[], m: Modifier, die: Die, depth: number): DieRoll[] {
    const faces = faceBounds(die);
    switch (m.type) {
      case 'explode': {
        const conditions = m.conditions.length > 0 ? this.comparisons(m.conditions, depth) : [{ op: '=' as const, target: faces.max }];
        const out: DieRoll[] = [];
        for (const r of rolls) {
          out.push(r);
          if (!r.kept) continue;
          let last = r.value;
          let current = r;
          for (let k = 0; k < m.times && passes(last, conditions); k++) {
            const next = this.face(die);
            if (m.combine) {
              r.value += next;
              r.counts = r.value;
              if (!r.marks.includes('!')) r.marks += '!';
            } else {
              if (!current.marks.includes('!')) current.marks += '!';
              current = roll(next);
              out.push(current);
            }
            last = next;
          }
        }
        return out;
      }
      case 'reroll': {
        const conditions = m.conditions.length > 0 ? this.comparisons(m.conditions, depth) : [{ op: '=' as const, target: faces.min }];
        for (const r of rolls) {
          for (let k = 0; k < m.times && r.kept && passes(r.value, conditions); k++) {
            r.value = this.face(die);
            r.counts = r.value;
            if (!r.marks.includes('r')) r.marks += 'r';
          }
        }
        return rolls;
      }
      case 'unique': {
        const distinct = die.kind === 'range' ? die.max - die.min + 1 : die.kind === 'list' ? new Set(die.values).size : 3;
        if (distinct < rolls.length) return rolls;
        for (let attempt = 0; attempt < 100; attempt++) {
          const seen = new Set<number>();
          let clash = false;
          for (const r of rolls) {
            if (seen.has(r.value)) {
              clash = true;
              r.value = this.face(die);
              r.counts = r.value;
              if (!r.marks.includes('u')) r.marks += 'u';
            }
            seen.add(r.value);
          }
          if (!clash) break;
        }
        return rolls;
      }
      case 'sort':
        return [...rolls].sort((a, b) => (m.order === 'asc' ? a.value - b.value : b.value - a.value));
      default:
        return rolls;
    }
  }
}

function roll(value: number): DieRoll {
  return { value, kept: true, counts: value, marks: '' };
}

function passes(value: number, conditions: { op: Condition['op']; target: number }[]): boolean {
  return conditions.some(({ op, target }) => {
    switch (op) {
      case '=':
        return value === target;
      case '!=':
        return value !== target;
      case '<':
        return value < target;
      case '>':
        return value > target;
      case '<=':
        return value <= target;
      case '>=':
        return value >= target;
      default:
        return false;
    }
  });
}

/** Keeps or drops dice among those still kept: `kh2` keeps the two highest, `dl1` drops the lowest. */
function applyKeep(rolls: DieRoll[], m: Extract<Modifier, { type: 'keep' | 'drop' }>): void {
  const live = rolls.filter((r) => r.kept);
  const ascending = [...live].sort((a, b) => a.value - b.value);
  let dropped: DieRoll[];
  if (m.type === 'keep') {
    const n = Math.min(m.n, live.length);
    dropped = m.which === 'high' ? ascending.slice(0, live.length - n) : ascending.slice(n);
  } else {
    const n = Math.min(m.n, live.length);
    dropped = m.which === 'low' ? ascending.slice(0, n) : ascending.slice(live.length - n);
  }
  for (const r of dropped) {
    r.kept = false;
    r.marks += 'd';
  }
}

/** A number as shown in a breakdown: whole numbers as is, others with at most two decimals. */
export function formatNumber(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}

export type Rounding = 'none' | 'round' | 'up' | 'down';

/** The total as shown: Dice Roller truncates to two decimals unless told to round. */
export function formatTotal(total: number, rounding: Rounding, signed = false): string {
  let n: number;
  switch (rounding) {
    case 'round':
      n = Math.round(total);
      break;
    case 'up':
      n = Math.ceil(total);
      break;
    case 'down':
      n = Math.floor(total);
      break;
    default:
      n = Math.trunc(total * 100) / 100;
  }
  if (Object.is(n, -0)) n = 0;
  return `${signed && n > 0 ? '+' : ''}${n}`;
}
