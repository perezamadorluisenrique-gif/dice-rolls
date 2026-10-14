import assert from 'node:assert/strict';
import test from 'node:test';

import {
  findInlineCode,
  modReplacement,
  noteFields,
  occurrence,
  parseInline,
  resultText,
  rollKey,
  tooltipText,
  validAlias,
} from '../src/inline.ts';
import { rollFormula } from '../src/roll.ts';
import { faces, script } from './helpers.ts';

const defaults = { rounding: 'none' as const, signed: false, showFormula: false };

test('recognises dice, dice+, dice- and dice-mod codes', () => {
  assert.equal(parseInline('dice: 2d6+3')?.formula, '2d6+3');
  assert.equal(parseInline('dice:1d20')?.formula, '1d20');
  assert.equal(parseInline('dice+: 1d4')?.formula, '1d4');
  assert.equal(parseInline('dice-: 1d4')?.formula, '1d4');
  assert.equal(parseInline('dice-mod: 3d100 + 12')?.mod, true);
  assert.equal(parseInline('dice: 1d4')?.mod, false);
});

test('ignores other code', () => {
  assert.equal(parseInline('const dice = 3'), null);
  assert.equal(parseInline('dice 1d6'), null);
  assert.equal(parseInline('Dice: 1d6'), null);
  assert.equal(parseInline('dice:'), null);
  assert.equal(parseInline('dice:   '), null);
  assert.equal(parseInline(' dice: 1d6'), null);
});

test('leaves Dice Roller link, table, tag, Dataview and narrative rollers alone', () => {
  assert.equal(parseInline('dice: [[Note]]'), null);
  assert.equal(parseInline('dice: 3d[[Note]]'), null);
  assert.equal(parseInline('dice: [[Note^table]]|Header 2'), null);
  assert.equal(parseInline('dice: [[Note]]|line'), null);
  assert.equal(parseInline('dice: [link](Note.md)'), null);
  assert.equal(parseInline('dice: #tag'), null);
  assert.equal(parseInline('dice: #tag|-'), null);
  assert.equal(parseInline('dice: dv(#tag)'), null);
  assert.equal(parseInline('dice: 1d20|xy'), null);
  assert.equal(parseInline('dice: 2g1y'), null);
  assert.equal(parseInline('dice: GgPpYy'), null);
  assert.equal(parseInline('dice: 3pro boo'), null);
});

test('narrative look-alikes that are real dice still roll', () => {
  assert.equal(parseInline('dice: 1dS')?.formula, '1dS');
  assert.equal(parseInline('dice: 4dF')?.formula, '4dF');
  assert.equal(parseInline('dice: d')?.formula, 'd');
});

test('reads every display flag', () => {
  const r = parseInline('dice: 1d20 + 2|nodice|noform|avg|signed|round|paren|render')!;
  assert.equal(r.formula, '1d20 + 2');
  assert.equal(r.showButton, false);
  assert.equal(r.showFormula, false);
  assert.equal(r.average, true);
  assert.equal(r.signed, true);
  assert.equal(r.rounding, 'round');
  assert.equal(r.paren, true);
  const d = parseInline('dice: 1d4|dice|form|none|ceil|nosigned')!;
  assert.equal(d.showButton, true);
  assert.equal(d.showFormula, true);
  assert.equal(d.none, true);
  assert.equal(d.rounding, 'up');
  assert.equal(d.signed, false);
  assert.equal(parseInline('dice: 1d4|floor')!.rounding, 'down');
  assert.equal(parseInline('dice: 1d4|noround')!.rounding, 'none');
  assert.equal(parseInline('dice: 1d4|NoDice')!.showButton, false);
  const plain = parseInline('dice: 1d4')!;
  assert.deepEqual(
    [plain.showButton, plain.showFormula, plain.average, plain.none, plain.text, plain.rounding, plain.signed, plain.paren],
    [null, null, false, false, null, null, null, false],
  );
});

test('text(...) can hold spaces, signs and pipes-free text', () => {
  const r = parseInline('dice: 1d20 + 2|nodice|text(Dexterity +2)')!;
  assert.equal(r.text, 'Dexterity +2');
  assert.equal(r.formula, '1d20 + 2');
  assert.equal(r.showButton, false);
  assert.equal(parseInline('dice: 1d6|text()')!.text, '');
});

test('the result text follows flags first, then settings', () => {
  const outcome = rollFormula('2d6+3', { random: script(faces(6, 3, 4)) });
  const r = parseInline('dice: 2d6+3')!;
  assert.equal(resultText(r, outcome, defaults), '10');
  assert.equal(resultText(r, outcome, { ...defaults, showFormula: true }), '2d6+3 → [3, 4]+3 → 10');
  assert.equal(resultText(parseInline('dice: 2d6+3|noform')!, outcome, { ...defaults, showFormula: true }), '10');
  assert.equal(resultText(parseInline('dice: 2d6+3|signed')!, outcome, defaults), '+10');
  assert.equal(resultText(r, outcome, { ...defaults, signed: true }), '+10');
});

test('rounding of divided results', () => {
  const outcome = rollFormula('1d6/4', { random: script(faces(6, 5)) });
  const r = parseInline('dice: 1d6/4')!;
  assert.equal(resultText(r, outcome, defaults), '1.25');
  assert.equal(resultText(r, outcome, { ...defaults, rounding: 'round' }), '1');
  assert.equal(resultText(parseInline('dice: 1d6/4|ceil')!, outcome, defaults), '2');
});

test('average results are floored, as in Dice Roller', () => {
  const outcome = rollFormula('2d6+3', { average: true });
  assert.equal(resultText(parseInline('dice: 2d6+3|avg')!, outcome, defaults), '10');
  const odd = rollFormula('1d20', { average: true });
  assert.equal(resultText(parseInline('dice: 1d20|avg')!, odd, defaults), '10');
  assert.equal(tooltipText(parseInline('dice: 1d20|avg')!, odd, defaults), '1d20\naverage: [10.5]');
});

test('stunt points follow the total', () => {
  const outcome = rollFormula('1dS', { random: script(faces(6, 4, 2, 4)) });
  assert.equal(resultText(parseInline('dice: 1dS')!, outcome, defaults), '10 - 4 Stunt Points');
});

test('tooltips show the formula and how it rolled', () => {
  const outcome = rollFormula('2d6+3', { random: script(faces(6, 3, 4)) });
  assert.equal(tooltipText(parseInline('dice: 2d6+3')!, outcome, defaults), '2d6+3\n[3, 4]+3');
  assert.equal(tooltipText(parseInline('dice: 2d6+3|text(Hit)')!, outcome, defaults), '2d6+3\n10 = [3, 4]+3');
  assert.equal(tooltipText(parseInline('dice: 2d6+3|none')!, null, defaults), '2d6+3\nClick to roll');
});

test('dice-mod text matches Dice Roller, escaped by default', () => {
  const outcome = rollFormula('3d100 + 12', { random: script(faces(100, 75, 20, 75)) });
  const r = parseInline('dice-mod: 3d100 + 12')!;
  const opts = { ...defaults, showFormula: true, escape: false };
  assert.equal(modReplacement(r, outcome, opts), '3d100 + 12 -> [75, 20, 75] + 12 -> 182');
  assert.equal(modReplacement(r, outcome, { ...opts, escape: true }), '3d100 + 12 -> \\[75, 20, 75\\] + 12 -> 182');
  assert.equal(modReplacement(parseInline('dice-mod: 3d100 + 12|noform')!, outcome, opts), '182');
  assert.equal(modReplacement(r, outcome, { ...opts, showFormula: false }), '182');
  const star = rollFormula('2*3', {});
  assert.equal(modReplacement(parseInline('dice-mod: 2*3')!, star, { ...opts, escape: true }), '2\\*3 -> 2\\*3 -> 6');
});

test('findInlineCode: spans, double backticks and escapes', () => {
  const text = 'Roll `dice: 1d6` and ``dice: 2d6`` but not \\`dice: 3d6\\`.';
  const spans = findInlineCode(text);
  assert.deepEqual(
    spans.map((s) => s.content),
    ['dice: 1d6', 'dice: 2d6'],
  );
  assert.equal(text.slice(spans[0].from, spans[0].to), '`dice: 1d6`');
  assert.equal(text.slice(spans[1].from, spans[1].to), '``dice: 2d6``');
});

test('findInlineCode: one space of padding is stripped, as in Markdown', () => {
  assert.equal(findInlineCode('`` `dice: 1d2` ``')[0].content, '`dice: 1d2`');
  assert.equal(findInlineCode('` dice: 1d2 `')[0].content, 'dice: 1d2');
  assert.equal(findInlineCode('` `')[0].content, ' ');
});

test('findInlineCode: skips fenced blocks and front matter, keeps line offsets right', () => {
  const text = [
    '---',
    'note: `dice: 1d1`',
    '---',
    'a `dice: 1d4`',
    '```',
    '`dice: 1d6`',
    '```',
    '~~~md',
    '`dice: 1d8`',
    '~~~',
    'b `dice: 1d10`',
  ].join('\n');
  const spans = findInlineCode(text);
  assert.deepEqual(
    spans.map((s) => s.content),
    ['dice: 1d4', 'dice: 1d10'],
  );
  for (const s of spans) assert.equal(text.slice(s.from, s.to), `\`${s.content}\``);
});

test('findInlineCode: an unclosed backtick is literal, and code does not cross paragraphs', () => {
  // The first two backticks pair up, as in Markdown; the last one is literal.
  assert.deepEqual(findInlineCode('a ` b `dice: 1d4`'), [{ from: 2, to: 7, content: 'b' }]);
  assert.deepEqual(findInlineCode('a `one\n\ntwo` b'), []);
  const wrapped = findInlineCode('a `dice:\n1d4` b');
  assert.equal(wrapped[0].content, 'dice: 1d4');
  assert.deepEqual(findInlineCode('a ``b` c'), []);
});

test('an inline fence-looking line stays a paragraph', () => {
  const spans = findInlineCode('```dice: 1d4``` after');
  assert.deepEqual(
    spans.map((s) => s.content),
    ['dice: 1d4'],
  );
});

test('occurrence numbers twins in order, and keys keep them apart', () => {
  const spans = findInlineCode('`dice: 1d6` `dice: 1d4` `dice: 1d6`');
  assert.deepEqual(
    spans.map((_, i) => occurrence(spans, i)),
    [0, 0, 1],
  );
  assert.notEqual(rollKey('a.md', 'dice: 1d6', 0), rollKey('a.md', 'dice: 1d6', 1));
  assert.notEqual(rollKey('a.md', 'dice: 1d6', 0), rollKey('b.md', 'dice: 1d6', 0));
});

test('noteFields: front matter numbers and inline fields', () => {
  const text = ['---', 'str: 3', 'name: Ana', 'dex: -1', 'speed: 7.5', '---', 'field:: 4', 'Text [field2:: 5] and (hidden:: 6).', 'notnum:: x', 'str:: 5'].join('\n');
  const fields = noteFields(text);
  assert.equal(fields.get('str'), 5);
  assert.equal(fields.get('dex'), -1);
  assert.equal(fields.get('speed'), 7.5);
  assert.equal(fields.get('field'), 4);
  assert.equal(fields.get('field2'), 5);
  assert.equal(fields.get('hidden'), 6);
  assert.equal(fields.has('name'), false);
  assert.equal(fields.has('notnum'), false);
  assert.equal(noteFields('no fields here').size, 0);
});

test('validAlias refuses names that read as dice', () => {
  assert.equal(validAlias('attack'), true);
  assert.equal(validAlias('fireball_3'), true);
  assert.equal(validAlias('d20'), false);
  assert.equal(validAlias('d'), false);
  assert.equal(validAlias('dF'), false);
  assert.equal(validAlias('dex'), true);
  assert.equal(validAlias('2d6'), false);
  assert.equal(validAlias('my roll'), false);
  assert.equal(validAlias(''), false);
});
