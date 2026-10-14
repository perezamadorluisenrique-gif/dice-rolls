/** The roll history kept in the plugin's data: newest first, capped. */

export interface HistoryEntry {
  formula: string;
  /** The total as shown. */
  total: string;
  breakdown: string;
  /** Milliseconds since the epoch. */
  at: number;
  /** The note the roll was made in, if any. */
  source?: string;
}

/** Adds `entry` on top and keeps at most `limit` entries. */
export function addEntry(history: HistoryEntry[], entry: HistoryEntry, limit: number): HistoryEntry[] {
  return [entry, ...history].slice(0, Math.max(0, limit));
}

/** Reads history from stored data, dropping anything malformed. */
export function readHistory(raw: unknown, limit: number): HistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryEntry[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const e = item as Record<string, unknown>;
    if (typeof e.formula !== 'string' || typeof e.total !== 'string' || typeof e.at !== 'number') continue;
    out.push({
      formula: e.formula,
      total: e.total,
      breakdown: typeof e.breakdown === 'string' ? e.breakdown : '',
      at: e.at,
      ...(typeof e.source === 'string' ? { source: e.source } : {}),
    });
  }
  return out.slice(0, Math.max(0, limit));
}

/** Distinct formulas, most recent first, for quick re-rolls. */
export function recentFormulas(history: HistoryEntry[], max: number): string[] {
  const seen = new Set<string>();
  for (const e of history) {
    if (seen.size >= max) break;
    seen.add(e.formula);
  }
  return [...seen];
}

/** Moves a note's entries when it is renamed. */
export function renameSource(history: HistoryEntry[], from: string, to: string): HistoryEntry[] {
  return history.map((e) => (e.source === from ? { ...e, source: to } : e));
}

/** A short local time for the list: today shows the time, older entries the date too. */
export function when(at: number, now: number): string {
  const d = new Date(at);
  const n = new Date(now);
  const pad = (x: number) => String(x).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay = d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
  return sameDay ? time : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
}

/** Reads Dice Roller's saved formulas (`formulas` in its data.json): name → formula. */
export function readLegacyFormulas(raw: unknown): Record<string, string> {
  const formulas = (raw as { formulas?: unknown } | null)?.formulas;
  const out: Record<string, string> = {};
  if (typeof formulas !== 'object' || formulas === null) return out;
  for (const [name, formula] of Object.entries(formulas)) {
    if (typeof formula === 'string' && formula.trim() !== '') out[name.trim()] = formula.trim();
  }
  return out;
}

/**
 * The formula after clicking a die button: `1d20` then `2d20`, and a
 * different die is added on (`2d20+1d6`).
 */
export function addDie(formula: string, faces: number): string {
  const f = formula.trim();
  if (f === '') return `1d${faces}`;
  const last = f.match(new RegExp(`(^|[+\\-*/(\\s])(\\d*)d${faces}$`));
  if (last) {
    const n = last[2] === '' ? 1 : Number(last[2]);
    return `${f.slice(0, f.length - last[0].length)}${last[1]}${n + 1}d${faces}`;
  }
  return `${f}+1d${faces}`;
}
