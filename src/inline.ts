/**
 * Inline code such as `dice: 2d6+3|noform`: which codes are rolls, their
 * flags, where they sit in a note, and the text a `dice-mod:` code becomes.
 */
import { formatTotal } from './roll.ts';
import type { Outcome, Rounding } from './roll.ts';

export interface InlineRoll {
  /** `dice-mod:` writes its result into the note instead of staying a roll. */
  mod: boolean;
  /** The formula, flags removed. */
  formula: string;
  /** `|form` / `|noform`; null follows the setting. */
  showFormula: boolean | null;
  /** `|dice` / `|nodice`; null follows the setting. */
  showButton: boolean | null;
  /** `|avg`: the first result is the average. */
  average: boolean;
  /** `|none`: nothing until clicked. */
  none: boolean;
  /** `|text(...)`: shown instead of the result, which stays in the tooltip. */
  text: string | null;
  /** `|paren`: the formula follows the result in parentheses. */
  paren: boolean;
  /** `|round`, `|ceil`, `|floor`, `|noround`; null follows the setting. */
  rounding: Rounding | null;
  /** `|signed`: a plus sign before positive results. */
  signed: boolean | null;
}

const PREFIX = /^dice(\+|-|-mod)?:\s*([\s\S]*?)\s*$/;
/** Dice Roller's link, tag and Dataview rollers: not dice, so left as code. */
const NOT_DICE = /\[\[|\]\(|(^|[^\w])#[\p{L}\w/-]|\bdv\(/u;
/** Dice Roller's Genesys narrative dice (`2g1y`, `3pro boo`): left as code. */
const NARRATIVE =
  /^(?:\d*(?:[GgYyBbRrPpSsWw]|[AaPpCcBbSsFf]|pro|boo|blk|k|sb|diff))(?: ?\d*(?:[GgYyBbRrPpSsWw]|[AaPpDdCcBbSsFf]|pro|boo|blk|k|sb|diff))+$/u;

/**
 * Reads the content of an inline code. Null when it is not a dice roll this
 * plugin handles; such codes stay plain code.
 */
export function parseInline(code: string): InlineRoll | null {
  const m = code.match(PREFIX);
  if (!m) return null;
  let body = m[2];
  const result: InlineRoll = {
    mod: m[1] === '-mod',
    formula: '',
    showFormula: null,
    showButton: null,
    average: false,
    none: false,
    text: null,
    paren: false,
    rounding: null,
    signed: null,
  };
  const text = body.match(/\|text\((.*?)\)/);
  if (text) {
    result.text = text[1];
    body = body.replace(text[0], '');
  }
  const [formula, ...flags] = body.split('|');
  for (const raw of flags) {
    const flag = raw.trim().toLowerCase();
    switch (flag) {
      case 'form':
      case 'noform':
        result.showFormula = flag === 'form';
        break;
      case 'dice':
      case 'nodice':
        result.showButton = flag === 'dice';
        break;
      case 'avg':
        result.average = true;
        break;
      case 'none':
        result.none = true;
        break;
      case 'paren':
        result.paren = true;
        break;
      case 'noparen':
        result.paren = false;
        break;
      case 'round':
        result.rounding = 'round';
        break;
      case 'ceil':
        result.rounding = 'up';
        break;
      case 'floor':
        result.rounding = 'down';
        break;
      case 'noround':
        result.rounding = 'none';
        break;
      case 'signed':
      case 'nosigned':
        result.signed = flag === 'signed';
        break;
      case 'render':
      case 'norender':
      case '':
        break;
      default:
        // A table column, block type or other roller option: not a dice roll.
        return null;
    }
  }
  result.formula = formula.trim();
  if (result.formula === '' || NOT_DICE.test(result.formula) || NARRATIVE.test(result.formula)) return null;
  return result;
}

export interface CodeSpan {
  /** Offset of the opening backtick. */
  from: number;
  /** Offset just past the closing backtick. */
  to: number;
  /** The code between the backticks, as Markdown reads it. */
  content: string;
}

/**
 * The inline code spans of a Markdown note, outside fenced code blocks and
 * front matter, in order. Good enough to number identical rolls the same way
 * in the editor and in Reading view; the editor also checks its syntax tree.
 */
export function findInlineCode(text: string): CodeSpan[] {
  const spans: CodeSpan[] = [];
  const lines = text.split('\n');
  let offset = 0;
  let fence: { char: string; length: number } | null = null;
  /** Lines of the current paragraph, with their offsets; code can span lines but not paragraphs. */
  let paragraph: { start: number; text: string } | null = null;

  const flush = () => {
    if (paragraph) scanParagraph(paragraph.text, paragraph.start, spans);
    paragraph = null;
  };

  let i = 0;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) {
      for (; i <= end; i++) offset += lines[i].length + 1;
    }
  }
  for (; i < lines.length; i++) {
    const line = lines[i];
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fence) {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
    } else if (open && !(open[1][0] === '`' && line.slice(open[0].length).includes('`'))) {
      flush();
      fence = { char: open[1][0], length: open[1].length };
    } else if (line.trim() === '') {
      flush();
    } else if (paragraph) {
      paragraph.text += '\n' + line;
    } else {
      paragraph = { start: offset, text: line };
    }
    offset += line.length + 1;
  }
  flush();
  return spans;
}

function scanParagraph(text: string, base: number, out: CodeSpan[]): void {
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] !== '`') {
      i++;
      continue;
    }
    let run = 0;
    while (text[i + run] === '`') run++;
    const start = i;
    let j = i + run;
    let closed = -1;
    while (j < text.length) {
      if (text[j] !== '`') {
        j++;
        continue;
      }
      let r = 0;
      while (text[j + r] === '`') r++;
      if (r === run) {
        closed = j;
        break;
      }
      j += r;
    }
    if (closed === -1) {
      i = start + run;
      continue;
    }
    let content = text.slice(start + run, closed).replace(/\n/g, ' ');
    if (content.length > 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') content = content.slice(1, -1);
    out.push({ from: base + start, to: base + closed + run, content });
    i = closed + run;
  }
}

/** How many codes with the same content come before `index` in `spans`. */
export function occurrence(spans: CodeSpan[], index: number): number {
  let n = 0;
  for (let k = 0; k < index; k++) if (spans[k].content === spans[index].content) n++;
  return n;
}

/** The key a roll's result is remembered under: same note, same code, same place among its twins. */
export function rollKey(path: string, content: string, nth: number): string {
  return `${path}\u0000${content}\u0000${nth}`;
}

export interface DisplayOptions {
  rounding: Rounding;
  signed: boolean;
  showFormula: boolean;
}

/** The text a roll shows in the note. */
export function resultText(roll: InlineRoll, outcome: Outcome, defaults: DisplayOptions): string {
  const total = totalText(roll, outcome, defaults);
  const stunt = outcome.notes.length > 0 ? ` - ${outcome.notes.join(', ')}` : '';
  const showFormula = roll.showFormula ?? defaults.showFormula;
  if (showFormula) return `${roll.formula} → ${outcome.breakdown} → ${total}${stunt}`;
  return total + stunt;
}

/** The total alone, rounded and signed by the roll's flags or the settings. */
export function totalText(roll: Pick<InlineRoll, 'rounding' | 'signed'>, outcome: Outcome, defaults: DisplayOptions): string {
  const total = outcome.average ? Math.floor(outcome.total) : outcome.total;
  return formatTotal(total, roll.rounding ?? defaults.rounding, roll.signed ?? defaults.signed);
}

/** The tooltip: the formula, then how it rolled. */
export function tooltipText(roll: InlineRoll, outcome: Outcome | null, defaults: DisplayOptions): string {
  if (!outcome) return `${roll.formula}\nClick to roll`;
  const detail = `${outcome.average ? 'average: ' : ''}${outcome.breakdown}`;
  const lines = [roll.formula, roll.text !== null ? `${totalText(roll, outcome, defaults)} = ${detail}` : detail];
  if (outcome.notes.length > 0) lines.push(outcome.notes.join(', '));
  return lines.join('\n');
}

/**
 * What a `dice-mod:` code becomes, as Dice Roller writes it:
 * `3d100 + 12 -> [75, 20, 75] + 12 -> 182`, or just the total with `|noform`
 * or the setting off. Markdown characters in the breakdown are escaped so
 * `[...]` does not read as a link.
 */
export function modReplacement(roll: InlineRoll, outcome: Outcome, defaults: DisplayOptions & { escape: boolean }): string {
  const total = totalText(roll, outcome, defaults);
  const showFormula = roll.showFormula ?? defaults.showFormula;
  const text = showFormula ? `${roll.formula} -> ${outcome.breakdown} -> ${total}` : total;
  return defaults.escape ? text.replace(/([*[\]])/g, '\\$1') : text;
}

/**
 * Number fields of a note, for names in formulas: front matter `str: 3` and
 * Dataview-style inline fields `str:: 3` or `[str:: 3]`. Later ones win.
 */
export function noteFields(text: string): Map<string, number> {
  const fields = new Map<string, number>();
  const lines = text.split('\n');
  let i = 0;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) {
      for (i = 1; i < end; i++) {
        const m = lines[i].match(/^([A-Za-z_][\w-]*)\s*:\s*(-?\d+(?:\.\d+)?)\s*$/);
        if (m) fields.set(m[1], Number(m[2]));
      }
      i = end + 1;
    }
  }
  const inline = /(?:^|\[|\()\s*([A-Za-z_][\w-]*)\s*::\s*(-?\d+(?:\.\d+)?)\s*(?=$|\]|\))/gm;
  const body = lines.slice(i).join('\n');
  for (let m = inline.exec(body); m; m = inline.exec(body)) fields.set(m[1], Number(m[2]));
  return fields;
}

/** A saved formula's name: a word that cannot be read as dice. */
export function validAlias(name: string): boolean {
  return /^[A-Za-z_]\w*$/.test(name) && !/^[dD](\d*|%|F|S)$/.test(name);
}
