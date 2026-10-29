/**
 * Table rollers such as `dice: [[Monsters#Swamp]]`: which note and table a code
 * points at, how a table is read out of the note's text, and which row a roll
 * picks. Pure, so it runs under plain Node; main.ts reads the note and draws.
 */

export interface TableRoll {
  /** Link target of the note, without heading or block id; empty for this note. */
  note: string;
  /** `#Heading` or `#^block-id`; null takes the first table of the note. */
  section: { kind: 'heading' | 'block'; name: string } | null;
  /** `|2`: show only this column of the row (1-based); null shows the whole row. */
  column: number | null;
}

const TABLE_CODE = /^dice:\s*\[\[([^\]|#^]*)(?:#(\^?)([^\]|]+))?(?:\|[^\]]*)?\]\]\s*(?:\|\s*(\d+)\s*)?$/;

/** Null when the code is not a table roller. */
export function parseTableRoll(code: string): TableRoll | null {
  const m = code.match(TABLE_CODE);
  if (!m) return null;
  const column = m[4] ? Number(m[4]) : null;
  if (column !== null && column < 1) return null;
  return {
    note: m[1].trim(),
    section: m[3] ? { kind: m[2] ? 'block' : 'heading', name: m[3].trim() } : null,
    column,
  };
}

export interface Table {
  header: string[];
  rows: string[][];
  /** Faces of the die named by the first header (`d6`, `d100`), with the rows' ranges; null when rows are equally likely. */
  die: { faces: number; ranges: Array<[number, number]> } | null;
}

const SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cell += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cell.trim());
      cell = '';
    } else cell += s[i];
  }
  cells.push(cell.trim());
  return cells;
}

interface Found {
  lines: string[];
  id: string | null;
  /** Index of the heading above the table, for heading lookups. */
  line: number;
}

function tablesIn(lines: string[], from: number, to: number): Found[] {
  const found: Found[] = [];
  let fence: string | null = null;
  for (let i = from; i < to; i++) {
    const fenceMatch = lines[i].match(/^\s*(```+|~~~+)/);
    if (fenceMatch) {
      fence = fence === null ? fenceMatch[1][0] : fenceMatch[1][0] === fence ? null : fence;
      continue;
    }
    if (fence !== null || !lines[i].includes('|') || i + 1 >= to || !SEPARATOR.test(lines[i + 1]) || !lines[i + 1].includes('-')) continue;
    let end = i + 2;
    while (end < to && lines[end].trim() !== '' && lines[end].includes('|')) end++;
    let id: string | null = null;
    const trailing = lines[end - 1].match(/\s\^([\w-]+)\s*$/);
    if (trailing) id = trailing[1];
    else {
      let next = end;
      while (next < to && lines[next].trim() === '') next++;
      const own = next < to ? lines[next].match(/^\s*\^([\w-]+)\s*$/) : null;
      if (own) id = own[1];
    }
    found.push({ lines: lines.slice(i, end), id, line: i });
    i = end - 1;
  }
  return found;
}

function build(lines: string[]): Table | null {
  const clean = lines.map((l) => l.replace(/\s\^[\w-]+\s*$/, ''));
  const header = splitRow(clean[0]);
  const rows = clean.slice(2).map(splitRow);
  if (header.length === 0 || rows.length === 0) return null;
  let die: Table['die'] = null;
  const faces = header[0].match(/^d(\d+)$/i);
  if (faces) {
    const ranges: Array<[number, number]> = [];
    for (const row of rows) {
      const r = row[0].match(/^(\d+)\s*(?:[-–—]\s*(\d+))?$/);
      if (!r) break;
      ranges.push([Number(r[1]), Number(r[2] ?? r[1])]);
    }
    if (ranges.length === rows.length) die = { faces: Number(faces[1]), ranges };
  }
  return { header, rows, die };
}

/** The table a code points at in the note's text, or null (heading, block or table missing). */
export function findTable(text: string, section: TableRoll['section']): Table | null {
  const lines = text.split('\n');
  let from = 0;
  let to = lines.length;
  if (section?.kind === 'heading') {
    const want = section.name.toLowerCase();
    let level = 0;
    let fence = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
      const h = fence ? null : lines[i].match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (!h) continue;
      if (level === 0) {
        if (h[2].trim().toLowerCase() === want) {
          level = h[1].length;
          from = i + 1;
        }
      } else if (h[1].length <= level) {
        to = i;
        break;
      }
    }
    if (level === 0) return null;
  }
  const tables = tablesIn(lines, from, to);
  const hit = section?.kind === 'block' ? tables.find((t) => t.id === section.name) : tables[0];
  return hit ? build(hit.lines) : null;
}

export interface Pick {
  /** The die rolled, when the table has a die column. */
  roll: number | null;
  /** The cells to show: the row without its die column, or the one column asked for. */
  cells: string[];
}

/** Picks a row; `random` returns [0, 1). An error string when no row covers the roll or the column is missing. */
export function pickRow(table: Table, column: number | null, random: () => number): Pick | string {
  let index: number;
  let roll: number | null = null;
  if (table.die) {
    roll = Math.floor(random() * table.die.faces) + 1;
    index = table.die.ranges.findIndex(([lo, hi]) => roll! >= lo && roll! <= hi);
    if (index < 0) return `No row covers a roll of ${roll}`;
  } else index = Math.min(table.rows.length - 1, Math.floor(random() * table.rows.length));
  const cells = table.die ? table.rows[index].slice(1) : table.rows[index];
  if (column === null) return { roll, cells };
  if (column > cells.length) return `The table has no column ${column}`;
  return { roll, cells: [cells[column - 1]] };
}
