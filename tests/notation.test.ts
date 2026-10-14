import assert from 'node:assert/strict';
import test from 'node:test';

import { INFINITE, parseFormula, tryParse } from '../src/notation.ts';
import type { Node } from '../src/notation.ts';

/** A compact text form of the tree, to compare shapes without spans. */
function shape(node: Node): string {
  switch (node.type) {
    case 'number':
      return String(node.value);
    case 'name':
      return `$${node.name}`;
    case 'group':
      return `(${shape(node.expr)})`;
    case 'negate':
      return `neg(${shape(node.expr)})`;
    case 'binary':
      return `[${shape(node.left)} ${node.op} ${shape(node.right)}]`;
    case 'dice': {
      const d = node.die;
      const die =
        d.kind === 'range'
          ? d.min === 1
            ? `d${d.max}`
            : `d[${d.min}..${d.max}]`
          : d.kind === 'list'
            ? `d{${d.values.join(',')}}`
            : d.kind === 'percent'
              ? `d${d.digits.join('')}%`
              : d.kind === 'fudge'
                ? 'dF'
                : 'dS';
      const mods = node.modifiers
        .map((m) => {
          switch (m.type) {
            case 'keep':
              return `k${m.which[0]}${m.n}`;
            case 'drop':
              return `d${m.which[0]}${m.n}`;
            case 'explode':
              return `${m.combine ? '!!' : '!'}${m.times}${m.conditions.map((c) => c.op + shape(c.value)).join('')}`;
            case 'reroll':
              return `r${m.times}${m.conditions.map((c) => c.op + shape(c.value)).join('')}`;
            case 'sort':
              return `s${m.order}`;
            case 'unique':
              return 'u';
          }
        })
        .join(' ');
      const conds = node.conditions.map((c) => `${c.op}${shape(c.value)}`).join('');
      return `${node.count ? shape(node.count) : ''}${die}${mods ? ` ${mods}` : ''}${conds ? ` ?${conds}` : ''}`;
    }
  }
}

const p = (formula: string, defaultFaces?: number) => shape(parseFormula(formula, { defaultFaces }));
const err = (formula: string) => {
  const r = tryParse(formula);
  assert.ok('error' in r, `expected "${formula}" to fail`);
  return r.error;
};

test('numbers and arithmetic with precedence', () => {
  assert.equal(p('7'), '7');
  assert.equal(p('2.5'), '2.5');
  assert.equal(p('.5'), '0.5');
  assert.equal(p('1+2*3'), '[1 + [2 * 3]]');
  assert.equal(p('(1+2)*3'), '[([1 + 2]) * 3]');
  assert.equal(p('8/4/2'), '[[8 / 4] / 2]');
  assert.equal(p('10-3-2'), '[[10 - 3] - 2]');
  assert.equal(p('2^3^2'), '[2 ^ [3 ^ 2]]');
  assert.equal(p('2*3^2'), '[2 * [3 ^ 2]]');
});

test('unary signs, including runs Dice Roller collapses', () => {
  assert.equal(p('-3'), 'neg(3)');
  assert.equal(p('+3'), '3');
  assert.equal(p('1--2'), '[1 - neg(2)]');
  assert.equal(p('1+-2'), '[1 + neg(2)]');
  assert.equal(p('1-+2'), '[1 - 2]');
  assert.equal(p('-2^2'), 'neg([2 ^ 2])');
  assert.equal(p('2^-1'), '[2 ^ neg(1)]');
  assert.equal(p('-1d6'), 'neg(1d6)');
});

test('spaces and braces are ignored, as in Dice Roller', () => {
  assert.equal(p(' 3 d 4 + 3 '), '[3d4 + 3]');
  assert.equal(p('{1d20}+5'), '[1d20 + 5]');
  assert.equal(p('1d12 + 1d10 + 5'), '[[1d12 + 1d10] + 5]');
  assert.equal(p('3 4'), '34');
});

test('standard dice, with count and faces omitted', () => {
  assert.equal(p('1d2'), '1d2');
  assert.equal(p('3D4'), '3d4');
  assert.equal(p('d20'), 'd20');
  assert.equal(p('D8'), 'd8');
  assert.equal(p('3d'), '3d100');
  assert.equal(p('d'), 'd100');
  assert.equal(p('d', 20), 'd20');
  assert.equal(p('2d+1'), '[2d100 + 1]');
  assert.equal(p('d+d'), '[d100 + d100]');
});

test('percentile, Fudge, stunt and custom-percent dice', () => {
  assert.equal(p('d%'), 'd100');
  assert.equal(p('4d%'), '4d100');
  assert.equal(p('4dF'), '4dF');
  assert.equal(p('dF'), 'dF');
  assert.equal(p('1dS'), '1dS');
  assert.equal(p('dS'), 'dS');
  assert.equal(p('1d66%'), '1d66%');
  assert.equal(p('2d7367%'), '2d7367%');
});

test('custom faces: ranges and lists', () => {
  assert.equal(p('1d[3,5]'), '1d[3..5]');
  assert.equal(p('1d[3, 5]'), '1d[3..5]');
  assert.equal(p('4d[7,8]'), '4d[7..8]');
  assert.equal(p('1d[5,3]'), '1d[3..5]');
  assert.equal(p('1d[3-5]'), '1d[3..5]');
  assert.equal(p('1d[-2,2]'), '1d[-2..2]');
  assert.equal(p('1d[1,3,5]'), '1d{1,3,5}');
  assert.equal(p('2d[0,0,1]'), '2d{0,0,1}');
});

test('a group can be the number of dice', () => {
  assert.equal(p('(1d4)d6'), '(1d4)d6');
  assert.equal(p('(2+1)d6+1'), '[([2 + 1])d6 + 1]');
});

test('keep and drop modifiers default to 1', () => {
  assert.equal(p('2d20k'), '2d20 kh1');
  assert.equal(p('2d20kh'), '2d20 kh1');
  assert.equal(p('4d20k2'), '4d20 kh2');
  assert.equal(p('4d20kh2'), '4d20 kh2');
  assert.equal(p('2d20kl'), '2d20 kl1');
  assert.equal(p('4d20kl2'), '4d20 kl2');
  assert.equal(p('4d6dl'), '4d6 dl1');
  assert.equal(p('4d6dl1'), '4d6 dl1');
  assert.equal(p('4d6dh2'), '4d6 dh2');
  assert.equal(p('d20k'), 'd20 kh1');
  assert.equal(p('4dkh2'), '4d100 kh2');
});

test('explode, explode-and-combine and reroll, with counts and "infinite"', () => {
  assert.equal(p('2d20!'), '2d20 !1');
  assert.equal(p('2d4!3'), '2d4 !3');
  assert.equal(p('1d1!i'), `1d1 !${INFINITE}`);
  assert.equal(p('2d20!!'), '2d20 !!1');
  assert.equal(p('2d4!!3'), '2d4 !!3');
  assert.equal(p('1d1!!i'), `1d1 !!${INFINITE}`);
  assert.equal(p('2d20r'), '2d20 r1');
  assert.equal(p('2d4r3'), '2d4 r3');
  assert.equal(p('1d2ri'), `1d2 r${INFINITE}`);
  assert.equal(p('1d6!500'), `1d6 !${INFINITE}`);
  assert.equal(p('1d6!0'), '1d6 !1');
});

test('sort and unique', () => {
  assert.equal(p('4d6s'), '4d6 sasc');
  assert.equal(p('4d6sa'), '4d6 sasc');
  assert.equal(p('4d6sd'), '4d6 sdesc');
  assert.equal(p('4d6u'), '4d6 u');
  assert.equal(p('4d6sdl'), '4d6 sasc dl1');
});

test('modifiers chain in the order written', () => {
  assert.equal(p('4d6r!kh3'), '4d6 r1 !1 kh3');
  assert.equal(p('4d6dl1+2'), '[4d6 dl1 + 2]');
  assert.equal(p('2d20kh+2d20kl'), '[2d20 kh1 + 2d20 kl1]');
});

test('dice conditions count successes', () => {
  assert.equal(p('5d10>7'), '5d10 ?>7');
  assert.equal(p('5d10>=7'), '5d10 ?>=7');
  assert.equal(p('5d10=>7'), '5d10 ?>=7');
  assert.equal(p('5d10<3'), '5d10 ?<3');
  assert.equal(p('5d10<=3'), '5d10 ?<=3');
  assert.equal(p('5d10=<3'), '5d10 ?<=3');
  assert.equal(p('5d10=10'), '5d10 ?=10');
  assert.equal(p('5d10=!1'), '5d10 ?!=1');
  assert.equal(p('5d10>7-=1'), '5d10 ?>7neg1');
  assert.equal(p('5d10>7=-1'), '5d10 ?>7neg1');
  assert.equal(p('5d10>1d6'), '5d10 ?>1d6');
  assert.equal(p('5d10>=8+1'), '[5d10 ?>=8 + 1]');
});

test('conditions after explode or reroll belong to it, and chain', () => {
  assert.equal(p('1d4!=3'), '1d4 !1=3');
  assert.equal(p('1d4!i=!3'), `1d4 !${INFINITE}!=3`);
  assert.equal(p('1d4r<3'), '1d4 r1<3');
  assert.equal(p('1d4r<2>3'), '1d4 r1<2>3');
  // After a keep, conditions go back to the die.
  assert.equal(p('6d6!kh3>4'), '6d6 !1 kh3 ?>4');
});

test('names: aliases and note fields, not dice', () => {
  assert.equal(p('str'), '$str');
  assert.equal(p('1d20+dex'), '[1d20 + $dex]');
  assert.equal(p('dex'), '$dex');
  assert.equal(p('dFoo'), '$dFoo');
  assert.equal(p('d20+bonus_2'), '[d20 + $bonus_2]');
  assert.equal(p('1d6*field2 + field'), '[[1d6 * $field2] + $field]');
});

test('the README examples of Dice Roller all parse', () => {
  for (const f of [
    '1d2',
    '3d4 + 3',
    '1d12 + 1d10 + 5',
    '3d4+3d4-(3d4 * 1d4) - 2^1d7',
    '1d[3,5]',
    '4d[7, 8]',
    '1d[20, 20]',
    '2d%',
    '2d20k',
    '4d20kh2',
    '2d20dh',
    '2d20!',
    '1d1!!i',
    '2d4r3',
    '1d66%',
    '1d4!=3',
    '1d4r<2>3',
    '2d6+3',
  ]) {
    assert.ok('node' in tryParse(f), f);
  }
});

test('spans point into the formula as written', () => {
  const node = parseFormula('2d6 + 1d4kh1');
  assert.equal(node.type, 'binary');
  if (node.type !== 'binary') return;
  assert.deepEqual([node.left.start, node.left.end], [0, 3]);
  assert.deepEqual([node.right.start, node.right.end], [6, 12]);
  const spaced = parseFormula('3 d 4');
  assert.deepEqual([spaced.start, spaced.end], [0, 5]);
});

test('readable errors', () => {
  assert.match(err(''), /empty/);
  assert.match(err('   '), /empty/);
  assert.match(err('1+'), /ends too early/);
  assert.match(err('(1+2'), /Missing "\)"/);
  assert.match(err('1+2)'), /Unmatched/);
  assert.match(err(')'), /Unmatched/);
  assert.match(err('1d0'), /at least one face/);
  assert.match(err('1d[3]'), /should look like/);
  assert.match(err('1d[a,b]'), /should look like/);
  assert.match(err('1d[3,5'), /Missing "\]"/);
  assert.match(err('2.5d6'), /whole number/);
  assert.match(err('2dS'), /one at a time/);
  assert.match(err('1d60%'), /0 digit/);
  assert.match(err('1d66%kh'), /regular dice/);
  assert.match(err('1dS!'), /regular dice/);
  assert.match(err('1d66%>3'), /regular dice/);
  assert.match(err('1d6x'), /Unknown modifier "x"/);
  assert.match(err('1d6>'), /needs a number/);
  assert.match(err('2 $ 3'), /Unexpected "\$" at position 3/);
  assert.match(err('99999999999d6'), /too large/);
  assert.match(err('1d99999999999'), /too large/);
  assert.match(err('1d[1,99999999999]'), /too large/);
});
