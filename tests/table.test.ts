import assert from 'node:assert/strict';
import test from 'node:test';

import { findTable, parseTableRoll, pickRow } from '../src/table.ts';

const note = [
  '# Loot',
  '',
  '| d4 | Item |',
  '|---|---|',
  '| 1 | ![[sword.png]] |',
  '| 2-3 | Rope \\| coil |',
  '| 4 | ![[gem.png]] |',
  '^loot',
  '',
  '## Names',
  '',
  '| Name | Pic |',
  '| --- | --- |',
  '| Ann | ![[ann.png]] |',
  '| Bo | ![[bo.png]] |',
  '',
  '# Other',
  '',
  '| X |',
  '|---|',
  '| 1 |',
].join('\n');

test('recognises table roller codes', () => {
  assert.deepEqual(parseTableRoll('dice: [[Loot]]'), { note: 'Loot', section: null, column: null });
  assert.deepEqual(parseTableRoll('dice: [[Loot#Names]]|2'), { note: 'Loot', section: { kind: 'heading', name: 'Names' }, column: 2 });
  assert.deepEqual(parseTableRoll('dice: [[#^loot]]'), { note: '', section: { kind: 'block', name: 'loot' }, column: null });
  assert.equal(parseTableRoll('dice: 2d6'), null);
  assert.equal(parseTableRoll('dice: [[Loot]]|0'), null);
});

test('finds a table by block id, heading or first in the note', () => {
  assert.equal(findTable(note, { kind: 'block', name: 'loot' })?.header[1], 'Item');
  assert.equal(findTable(note, { kind: 'heading', name: 'names' })?.rows.length, 2);
  assert.equal(findTable(note, null)?.header[0], 'd4');
  assert.equal(findTable(note, { kind: 'heading', name: 'Other' })?.header[0], 'X');
  assert.equal(findTable(note, { kind: 'heading', name: 'Missing' }), null);
  assert.equal(findTable(note, { kind: 'block', name: 'nope' }), null);
});

test('a heading does not reach tables below the next heading of its level', () => {
  assert.equal(findTable('# A\n\ntext\n\n# B\n\n| x |\n|---|\n| 1 |', { kind: 'heading', name: 'A' }), null);
});

test('a die column picks by range and keeps escaped pipes', () => {
  const table = findTable(note, null)!;
  assert.deepEqual(pickRow(table, null, () => 0), { roll: 1, cells: ['![[sword.png]]'] });
  assert.deepEqual(pickRow(table, null, () => 0.5), { roll: 3, cells: ['Rope | coil'] });
  assert.deepEqual(pickRow(table, null, () => 0.99), { roll: 4, cells: ['![[gem.png]]'] });
});

test('without a die every row is equally likely and a column can be chosen', () => {
  const table = findTable(note, { kind: 'heading', name: 'Names' })!;
  assert.deepEqual(pickRow(table, null, () => 0.6), { roll: null, cells: ['Bo', '![[bo.png]]'] });
  assert.deepEqual(pickRow(table, 2, () => 0), { roll: null, cells: ['![[ann.png]]'] });
  assert.equal(pickRow(table, 3, () => 0), 'The table has no column 3');
});

test('a die with a gap reports the uncovered roll', () => {
  const table = findTable('| d6 | x |\n|---|---|\n| 1-3 | a |\n| 5-6 | b |', null)!;
  assert.equal(pickRow(table, null, () => 0.6), 'No row covers a roll of 4');
});
