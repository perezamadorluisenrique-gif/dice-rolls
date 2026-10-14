/**
 * Dice notation parser. Reads the formulas Dice Roller reads (its "dice
 * rollers": arithmetic, standard, percentile, custom-range, Fudge, stunt and
 * custom-percent dice, every modifier and condition) into a tree the roller
 * in `roll.ts` evaluates. Pure: no randomness and no Obsidian here.
 *
 * Grammar, after spaces and `{}` are removed (as Dice Roller does):
 *
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/') unary)*
 *   unary   := ('+' | '-') unary | power
 *   power   := primary ('^' unary)?            right-associative
 *   primary := number | dice | name | '(' expr ')' [dice-after-count]
 *   dice    := [count] 'd' [faces] modifier* condition*
 */

export type Op = '+' | '-' | '*' | '/' | '^';

/** A span in the formula as the user wrote it (spaces included). */
export interface Span {
  start: number;
  end: number;
}

export type Die =
  | { kind: 'range'; min: number; max: number }
  | { kind: 'list'; values: number[] }
  | { kind: 'fudge' }
  | { kind: 'stunt' }
  /** `XdNN%`: one die per digit of NN, read together as one number (Traveller's d66). */
  | { kind: 'percent'; digits: number[] };

export type CondOp = '=' | '!=' | '<' | '>' | '<=' | '>=' | 'neg';

export interface Condition {
  op: CondOp;
  /** A number, or a dice term such as `1d6`, rolled once per evaluation. */
  value: Node;
  text: string;
}

export type Modifier =
  | { type: 'keep'; which: 'high' | 'low'; n: number }
  | { type: 'drop'; which: 'high' | 'low'; n: number }
  | { type: 'explode'; combine: boolean; times: number; conditions: Condition[] }
  | { type: 'reroll'; times: number; conditions: Condition[] }
  | { type: 'sort'; order: 'asc' | 'desc' }
  | { type: 'unique' };

export type Node =
  | ({ type: 'number'; value: number } & Span)
  | ({ type: 'name'; name: string } & Span)
  | ({ type: 'dice'; count: Node | null; die: Die; modifiers: Modifier[]; conditions: Condition[] } & Span)
  | ({ type: 'binary'; op: Op; left: Node; right: Node } & Span)
  | ({ type: 'negate'; expr: Node } & Span)
  | ({ type: 'group'; expr: Node } & Span);

export interface ParseOptions {
  /** Faces of a die written without them (`3d`): Dice Roller's default is 100. */
  defaultFaces?: number;
}

export class DiceSyntaxError extends Error {}

/** "Infinite" explosions and rerolls (`!i`, `ri`) stop here, as in Dice Roller. */
export const INFINITE = 100;
/** Largest count, faces or modifier number accepted, to keep a typo from hanging the note. */
export const MAX_NUMBER = 1_000_000_000;

/** Parses `formula`, throwing `DiceSyntaxError` with a short readable reason. */
export function parseFormula(formula: string, options: ParseOptions = {}): Node {
  return new Parser(formula, options.defaultFaces ?? 100).parse();
}

/** Like `parseFormula`, but returns the reason instead of throwing. */
export function tryParse(formula: string, options: ParseOptions = {}): { node: Node } | { error: string } {
  try {
    return { node: parseFormula(formula, options) };
  } catch (e) {
    if (e instanceof DiceSyntaxError) return { error: e.message };
    throw e;
  }
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const isLetter = (c: string | undefined): boolean => c !== undefined && /[A-Za-z_]/.test(c);
const isWord = (c: string | undefined): boolean => c !== undefined && /[A-Za-z0-9_]/.test(c);

class Parser {
  /** The formula without spaces and braces. */
  private s: string;
  /** `map[i]` is where `s[i]` sits in the original formula; `map[s.length]` is its length. */
  private map: number[];
  private i = 0;
  private original: string;
  private defaultFaces: number;

  constructor(original: string, defaultFaces: number) {
    this.original = original;
    this.defaultFaces = defaultFaces;
    let s = '';
    const map: number[] = [];
    for (let k = 0; k < original.length; k++) {
      if (/[\s{}]/.test(original[k])) continue;
      s += original[k];
      map.push(k);
    }
    map.push(original.length);
    this.s = s;
    this.map = map;
  }

  parse(): Node {
    if (this.s.length === 0) throw new DiceSyntaxError('The formula is empty.');
    const node = this.expr();
    if (this.i < this.s.length) {
      const c = this.s[this.i];
      throw new DiceSyntaxError(c === ')' ? 'Unmatched ")".' : `Unexpected "${c}" at position ${this.map[this.i] + 1}.`);
    }
    return node;
  }

  /** A span from clean index `from` to the current position, in original coordinates. */
  private span(from: number): Span {
    const start = this.map[from];
    const end = this.i > from ? this.map[this.i - 1] + 1 : start;
    return { start, end };
  }

  private peek(offset = 0): string | undefined {
    return this.s[this.i + offset];
  }

  private expr(): Node {
    const from = this.i;
    let left = this.term();
    for (;;) {
      const c = this.peek();
      if (c !== '+' && c !== '-') return left;
      this.i++;
      const right = this.term();
      left = { type: 'binary', op: c, left, right, ...this.span(from) };
    }
  }

  private term(): Node {
    const from = this.i;
    let left = this.unary();
    for (;;) {
      const c = this.peek();
      if (c !== '*' && c !== '/') return left;
      this.i++;
      const right = this.unary();
      left = { type: 'binary', op: c, left, right, ...this.span(from) };
    }
  }

  private unary(): Node {
    const from = this.i;
    const c = this.peek();
    if (c === '+') {
      this.i++;
      return this.unary();
    }
    if (c === '-') {
      this.i++;
      const expr = this.unary();
      return { type: 'negate', expr, ...this.span(from) };
    }
    return this.power();
  }

  private power(): Node {
    const from = this.i;
    const base = this.primary();
    if (this.peek() !== '^') return base;
    this.i++;
    const exponent = this.unary();
    return { type: 'binary', op: '^', left: base, right: exponent, ...this.span(from) };
  }

  private primary(): Node {
    const from = this.i;
    const c = this.peek();
    if (c === undefined) throw new DiceSyntaxError('The formula ends too early.');
    if (c === '(') {
      this.i++;
      const expr = this.expr();
      if (this.peek() !== ')') throw new DiceSyntaxError('Missing ")".');
      this.i++;
      const group: Node = { type: 'group', expr, ...this.span(from) };
      // `(1d4)d6`: the group is the number of dice.
      if (this.isD(this.peek())) return this.dice(from, group);
      return group;
    }
    if (isDigit(c) || (c === '.' && isDigit(this.peek(1)))) {
      const value = this.number();
      if (this.isD(this.peek())) {
        if (!Number.isInteger(value)) throw new DiceSyntaxError('The number of dice must be a whole number.');
        return this.dice(from, { type: 'number', value, ...this.span(from) });
      }
      return { type: 'number', value, ...this.span(from) };
    }
    if (this.isD(c) && this.diceWithoutCount()) return this.dice(from, null);
    if (isLetter(c)) {
      let name = '';
      while (isWord(this.peek())) name += this.s[this.i++];
      return { type: 'name', name, ...this.span(from) };
    }
    if (c === ')') throw new DiceSyntaxError('Unmatched ")".');
    throw new DiceSyntaxError(`Unexpected "${c}" at position ${this.map[this.i] + 1}.`);
  }

  private isD(c: string | undefined): boolean {
    return c === 'd' || c === 'D';
  }

  /** Whether a `d` with no count starts a die (`d20`, `d%`, `dF`, `d`) rather than a name (`dex`). */
  private diceWithoutCount(): boolean {
    const next = this.peek(1);
    if (next === undefined || isDigit(next) || next === '%' || next === '[') return true;
    if (next === 'F' || next === 'S') return !isWord(this.peek(2));
    return !isWord(next);
  }

  private number(): number {
    const from = this.i;
    while (isDigit(this.peek())) this.i++;
    if (this.peek() === '.' && isDigit(this.peek(1))) {
      this.i++;
      while (isDigit(this.peek())) this.i++;
    }
    const value = Number(this.s.slice(from, this.i));
    if (value > MAX_NUMBER) throw new DiceSyntaxError(`${this.s.slice(from, this.i)} is too large.`);
    return value;
  }

  private integer(): number | null {
    if (!isDigit(this.peek())) return null;
    const from = this.i;
    while (isDigit(this.peek())) this.i++;
    const value = Number(this.s.slice(from, this.i));
    if (value > MAX_NUMBER) throw new DiceSyntaxError(`${this.s.slice(from, this.i)} is too large.`);
    return value;
  }

  private dice(from: number, count: Node | null): Node {
    this.i++; // the d
    const die = this.faces(count);
    const modifiers: Modifier[] = [];
    const conditions: Condition[] = [];
    /** Conditions written right after `!`, `!!` or `r` belong to it; any others to the die. */
    let owner: Condition[] = conditions;
    for (;;) {
      const c = this.peek();
      const c2 = this.peek(1);
      if (c === undefined) break;
      if (c === '=' || c === '<' || c === '>' || (c === '-' && c2 === '=')) {
        owner.push(this.condition());
        continue;
      }
      let modifier: Modifier | null = null;
      if (c === 'k') {
        this.i++;
        const which = this.peek() === 'l' ? 'low' : 'high';
        if (this.peek() === 'l' || this.peek() === 'h') this.i++;
        modifier = { type: 'keep', which, n: this.integer() ?? 1 };
      } else if (c === 'd' && (c2 === 'l' || c2 === 'h')) {
        this.i += 2;
        modifier = { type: 'drop', which: c2 === 'l' ? 'low' : 'high', n: this.integer() ?? 1 };
      } else if (c === '!') {
        const combine = c2 === '!';
        this.i += combine ? 2 : 1;
        modifier = { type: 'explode', combine, times: this.times(), conditions: [] };
      } else if (c === 'r') {
        this.i++;
        modifier = { type: 'reroll', times: this.times(), conditions: [] };
      } else if (c === 's') {
        this.i++;
        let order: 'asc' | 'desc' = 'asc';
        if (this.peek() === 'a') this.i++;
        else if (this.peek() === 'd' && this.peek(1) !== 'l' && this.peek(1) !== 'h') {
          this.i++;
          order = 'desc';
        }
        modifier = { type: 'sort', order };
      } else if (c === 'u') {
        this.i++;
        modifier = { type: 'unique' };
      } else {
        break;
      }
      if (die.kind === 'percent' || die.kind === 'stunt') {
        throw new DiceSyntaxError('Modifiers only work on regular dice, not on percent or stunt dice.');
      }
      modifiers.push(modifier);
      owner = modifier.type === 'explode' || modifier.type === 'reroll' ? modifier.conditions : conditions;
    }
    if (conditions.length > 0 && (die.kind === 'percent' || die.kind === 'stunt')) {
      throw new DiceSyntaxError('Conditions only work on regular dice, not on percent or stunt dice.');
    }
    if (isWord(this.peek())) {
      throw new DiceSyntaxError(`Unknown modifier "${this.s.slice(this.i).match(/^\w+/)?.[0] ?? ''}" at position ${this.map[this.i] + 1}.`);
    }
    return { type: 'dice', count, die, modifiers, conditions, ...this.span(from) };
  }

  /** The number after `!`, `!!` or `r`: absent means once, `i` means "infinitely" (capped). */
  private times(): number {
    if (this.peek() === 'i' && !isWord(this.peek(1))) {
      this.i++;
      return INFINITE;
    }
    const n = this.integer();
    return n === null || n === 0 ? 1 : Math.min(n, INFINITE);
  }

  private faces(count: Node | null): Die {
    const c = this.peek();
    if (isDigit(c)) {
      const start = this.i;
      const max = this.integer() ?? 0;
      if (this.peek() === '%') {
        this.i++;
        const digits = this.s.slice(start, this.i - 1).split('').map(Number);
        if (digits.includes(0)) throw new DiceSyntaxError('A custom percent die cannot have a 0 digit.');
        return { kind: 'percent', digits };
      }
      if (max < 1) throw new DiceSyntaxError('A die needs at least one face.');
      return { kind: 'range', min: 1, max };
    }
    if (c === '%') {
      this.i++;
      return { kind: 'range', min: 1, max: 100 };
    }
    if (c === 'F' && !isWord(this.peek(1))) {
      this.i++;
      return { kind: 'fudge' };
    }
    if (c === 'S' && !isWord(this.peek(1))) {
      this.i++;
      if (count && !(count.type === 'number' && count.value === 1)) {
        throw new DiceSyntaxError('Stunt dice are rolled one at a time: write 1dS.');
      }
      return { kind: 'stunt' };
    }
    if (c === '[') return this.customFaces();
    return { kind: 'range', min: 1, max: this.defaultFaces };
  }

  /** `[3,5]` or `[3-5]`: a die from 3 to 5; `[1,3,5]`: a die with exactly those faces. */
  private customFaces(): Die {
    const close = this.s.indexOf(']', this.i);
    if (close === -1) throw new DiceSyntaxError('Missing "]".');
    const inside = this.s.slice(this.i + 1, close);
    this.i = close + 1;
    const range = inside.match(/^(-?\d+)-(-?\d+)$/);
    if (range) return orderedRange(Number(range[1]), Number(range[2]));
    const parts = inside.split(',');
    if (parts.length < 2 || parts.some((p) => !/^-?\d+$/.test(p))) {
      throw new DiceSyntaxError(`Faces "[${inside}]" should look like [3,5], [3-5] or [1,3,5].`);
    }
    const values = parts.map(Number);
    if (values.some((v) => Math.abs(v) > MAX_NUMBER)) throw new DiceSyntaxError('A face is too large.');
    if (values.length === 2) return orderedRange(values[0], values[1]);
    return { kind: 'list', values };
  }

  private condition(): Condition {
    const from = this.i;
    const ops: [string, CondOp][] = [
      ['>=', '>='],
      ['=>', '>='],
      ['<=', '<='],
      ['=<', '<='],
      ['=!', '!='],
      ['=-', 'neg'],
      ['-=', 'neg'],
      ['>', '>'],
      ['<', '<'],
      ['=', '='],
    ];
    const found = ops.find(([text]) => this.s.startsWith(text, this.i));
    if (!found) throw new DiceSyntaxError(`Unknown condition at position ${this.map[this.i] + 1}.`);
    this.i += found[0].length;
    const valueFrom = this.i;
    const n = this.integer();
    let value: Node;
    if (this.isD(this.peek()) && (isDigit(this.peek(1)) || this.peek(1) === '%' || this.peek(1) === 'F')) {
      // A rolled comparison value, such as `>1d6`.
      const count: Node | null = n === null ? null : { type: 'number', value: n, ...this.span(valueFrom) };
      this.i++;
      const die = this.faces(count);
      value = { type: 'dice', count, die, modifiers: [], conditions: [], ...this.span(valueFrom) };
    } else {
      if (n === null) throw new DiceSyntaxError(`The condition "${found[0]}" needs a number.`);
      value = { type: 'number', value: n, ...this.span(valueFrom) };
    }
    return { op: found[1], value, text: this.original.slice(this.map[from], this.map[this.i - 1] + 1) };
  }
}

function orderedRange(a: number, b: number): Die {
  if (Math.abs(a) > MAX_NUMBER || Math.abs(b) > MAX_NUMBER) throw new DiceSyntaxError('A face is too large.');
  return { kind: 'range', min: Math.min(a, b), max: Math.max(a, b) };
}
