import assert from 'node:assert/strict';
import test from 'node:test';

import { addDie, addEntry, readHistory, readLegacyFormulas, recentFormulas, renameSource, when } from '../src/history.ts';
import type { HistoryEntry } from '../src/history.ts';

const entry = (formula: string, at = 1, source?: string): HistoryEntry => ({ formula, total: '1', breakdown: '[1]', at, ...(source ? { source } : {}) });

test('addEntry puts the newest first and caps the list', () => {
  let h: HistoryEntry[] = [];
  for (let i = 0; i < 5; i++) h = addEntry(h, entry(`1d${i + 1}`, i), 3);
  assert.deepEqual(
    h.map((e) => e.formula),
    ['1d5', '1d4', '1d3'],
  );
  assert.deepEqual(addEntry(h, entry('x'), 0), []);
});

test('readHistory drops malformed entries', () => {
  const raw = [entry('1d6'), null, 'x', { formula: 1, total: '1', at: 1 }, { formula: '1d4', total: '2', at: 5, source: 3 }];
  const h = readHistory(raw, 10);
  assert.equal(h.length, 2);
  assert.equal(h[1].breakdown, '');
  assert.equal('source' in h[1], false);
  assert.deepEqual(readHistory(undefined, 10), []);
  assert.deepEqual(readHistory({}, 10), []);
  assert.equal(readHistory([entry('a'), entry('b')], 1).length, 1);
});

test('recentFormulas lists distinct formulas, newest first', () => {
  const h = [entry('1d20'), entry('2d6'), entry('1d20'), entry('1d4'), entry('1d8')];
  assert.deepEqual(recentFormulas(h, 3), ['1d20', '2d6', '1d4']);
  assert.deepEqual(recentFormulas([], 3), []);
});

test('renameSource follows a renamed note', () => {
  const h = renameSource([entry('1d6', 1, 'a.md'), entry('1d6', 1, 'b.md'), entry('1d6')], 'a.md', 'c.md');
  assert.deepEqual(
    h.map((e) => e.source),
    ['c.md', 'b.md', undefined],
  );
});

test('when shows the time today and the date before', () => {
  const now = new Date(2026, 9, 14, 18, 0).getTime();
  assert.equal(when(new Date(2026, 9, 14, 9, 5).getTime(), now), '09:05');
  assert.equal(when(new Date(2026, 9, 13, 23, 59).getTime(), now), '2026-10-13 23:59');
});

test('readLegacyFormulas reads Dice Roller saved formulas', () => {
  assert.deepEqual(readLegacyFormulas({ formulas: { attack: '1d20+5', ' dmg ': ' 2d6 ', empty: '', n: 3 } }), { attack: '1d20+5', dmg: '2d6' });
  assert.deepEqual(readLegacyFormulas(null), {});
  assert.deepEqual(readLegacyFormulas({ formulas: 'x' }), {});
});

test('addDie builds a formula from die buttons', () => {
  assert.equal(addDie('', 20), '1d20');
  assert.equal(addDie('  ', 6), '1d6');
  assert.equal(addDie('1d20', 20), '2d20');
  assert.equal(addDie('d20', 20), '2d20');
  assert.equal(addDie('9d20', 20), '10d20');
  assert.equal(addDie('1d20', 6), '1d20+1d6');
  assert.equal(addDie('1d20+1d6', 6), '1d20+2d6');
  // 1d100 is not a d10.
  assert.equal(addDie('1d100', 10), '1d100+1d10');
  assert.equal(addDie('2d6+3', 6), '2d6+3+1d6');
  assert.equal(addDie('(1d6', 6), '(2d6');
});
