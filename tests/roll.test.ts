import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_DICE, formatNumber, formatTotal, rollFormula, tryRoll } from '../src/roll.ts';
import type { RollOptions } from '../src/roll.ts';
import { faces, ranged, script } from './helpers.ts';

const roll = (formula: string, random: () => number, options: RollOptions = {}) => rollFormula(formula, { random, ...options });
const none = () => {
  throw new Error('no dice expected');
};

test('arithmetic without dice', () => {
  assert.equal(roll('1+2*3', none).total, 7);
  assert.equal(roll('(1+2)*3', none).total, 9);
  assert.equal(roll('2^3^2', none).total, 512);
  assert.equal(roll('10-3-2', none).total, 5);
  assert.equal(roll('7/2', none).total, 3.5);
  assert.equal(roll('-2^2', none).total, -4);
  assert.equal(roll('1--2', none).total, 3);
  assert.equal(roll('1+-2', none).total, -1);
  assert.equal(roll('1', none).breakdown, '1');
});

test('division by zero is an error, not Infinity', () => {
  const r = tryRoll('1/0', { random: none });
  assert.deepEqual(r, { error: 'Division by zero.' });
});

test('standard dice: sum and breakdown', () => {
  const r = roll('2d6+3', script(faces(6, 3, 5)));
  assert.equal(r.total, 11);
  assert.equal(r.breakdown, '[3, 5]+3');
  assert.equal(r.dice.length, 1);
  assert.deepEqual(r.dice[0].rolls.map((d) => d.value), [3, 5]);
});

test('the breakdown keeps the spacing and text around dice', () => {
  const r = roll('3d100 + 12', script(faces(100, 75, 20, 75)));
  assert.equal(r.breakdown, '[75, 20, 75] + 12');
  assert.equal(r.total, 182);
  const m = roll('1d12 + 1d10 + 5', script(faces(12, 4), faces(10, 9)));
  assert.equal(m.breakdown, '[4] + [9] + 5');
  assert.equal(m.total, 18);
});

test('every face of a die can come up, and nothing outside it', () => {
  for (const sides of [1, 2, 4, 6, 20, 100]) {
    const seen = new Set<number>();
    for (let k = 0; k < sides; k++) seen.add(roll(`1d${sides}`, script([(k + 0.5) / sides])).total);
    assert.equal(seen.size, sides);
    assert.equal(Math.min(...seen), 1);
    assert.equal(Math.max(...seen), sides);
    // The extremes of the random source stay in range.
    assert.equal(roll(`1d${sides}`, script([0])).total, 1);
    assert.equal(roll(`1d${sides}`, script([0.9999999])).total, sides);
  }
});

test('Math.random keeps every roll in range', () => {
  for (let k = 0; k < 2000; k++) {
    const r = rollFormula('1d20');
    assert.ok(r.total >= 1 && r.total <= 20 && Number.isInteger(r.total));
    const f = rollFormula('4dF');
    assert.ok(f.total >= -4 && f.total <= 4);
    const c = rollFormula('1d[3,5]');
    assert.ok(c.total >= 3 && c.total <= 5);
  }
});

test('omitted count and faces, and the default faces option', () => {
  assert.equal(roll('d20', script(faces(20, 17))).total, 17);
  assert.equal(roll('3d', script(faces(100, 1, 50, 100))).total, 151);
  assert.equal(roll('d', script(faces(8, 8)), { defaultFaces: 8 }).total, 8);
});

test('percentile dice', () => {
  const r = roll('2d%', script(faces(100, 1, 100)));
  assert.equal(r.total, 101);
  assert.equal(r.breakdown, '[1, 100]');
});

test('custom faces: inclusive ranges and exact lists', () => {
  assert.equal(roll('1d[3,5]', script(ranged(3, 5, 5))).total, 5);
  assert.equal(roll('1d[3-5]', script(ranged(3, 5, 3))).total, 3);
  assert.equal(roll('4d[7,8]', script(ranged(7, 8, 7, 7, 8, 7))).breakdown, '[7, 7, 8, 7]');
  assert.equal(roll('1d[20,20]', script([0.3])).total, 20);
  assert.equal(roll('1d[-2,2]', script(ranged(-2, 2, -2))).total, -2);
  // A list: index into the faces.
  assert.equal(roll('1d[1,3,5]', script([0.5])).total, 3);
  assert.equal(roll('1d[1,3,5]', script([0.9])).total, 5);
});

test('Fudge dice', () => {
  const r = roll('4dF', script(ranged(-1, 1, -1, 0, 1, 1)));
  assert.equal(r.total, 1);
  assert.equal(r.breakdown, '[-1, 0, 1, 1]');
});

test('custom percent dice roll one die per digit', () => {
  // d66: two d6 read as tens and ones.
  const r = roll('1d66%', script(faces(6, 6, 3)));
  assert.equal(r.total, 63);
  assert.equal(r.breakdown, '[6,3]');
  const two = roll('2d66%', script(faces(6, 1, 2, 3, 4)));
  assert.equal(two.total, 12 + 34);
  assert.equal(two.breakdown, '[1,2 | 3,4]');
});

test('Fantasy AGE stunt dice: stunt points on doubles', () => {
  const plain = roll('1dS', script(faces(6, 1, 2, 3)));
  assert.equal(plain.total, 6);
  assert.equal(plain.breakdown, '[1, 2], 3');
  assert.deepEqual(plain.notes, []);
  const doubles = roll('1dS', script(faces(6, 4, 2, 4)));
  assert.equal(doubles.total, 10);
  assert.equal(doubles.breakdown, '[4, 2], 4S');
  assert.deepEqual(doubles.notes, ['4 Stunt Points']);
});

test('keep highest and keep lowest', () => {
  const kh = roll('2d20k', script(faces(20, 7, 18)));
  assert.equal(kh.total, 18);
  assert.equal(kh.breakdown, '[7d, 18]');
  const kh2 = roll('4d20kh2', script(faces(20, 4, 12, 15, 3)));
  assert.equal(kh2.total, 27);
  assert.equal(kh2.breakdown, '[4d, 12, 15, 3d]');
  const kl = roll('2d20kl', script(faces(20, 7, 18)));
  assert.equal(kl.total, 7);
  assert.equal(kl.breakdown, '[7, 18d]');
  const kl2 = roll('4d20kl2', script(faces(20, 4, 12, 15, 3)));
  assert.equal(kl2.total, 7);
  assert.equal(kl2.breakdown, '[4, 12d, 15d, 3]');
});

test('drop lowest and drop highest', () => {
  assert.equal(roll('2d20dl', script(faces(20, 7, 18))).breakdown, '[7d, 18]');
  assert.equal(roll('4d20dl2', script(faces(20, 4, 12, 15, 3))).total, 27);
  assert.equal(roll('2d20dh', script(faces(20, 7, 18))).total, 7);
  assert.equal(roll('4d20dh2', script(faces(20, 4, 12, 15, 3))).total, 7);
  // The classic ability score: 4d6, drop the lowest.
  const stat = roll('4d6dl1', script(faces(6, 6, 1, 4, 5)));
  assert.equal(stat.total, 15);
  assert.equal(stat.breakdown, '[6, 1d, 4, 5]');
});

test('keeping more dice than rolled keeps them all; ties drop one die only', () => {
  assert.equal(roll('2d6kh5', script(faces(6, 2, 3))).total, 5);
  assert.equal(roll('2d6dl5', script(faces(6, 2, 3))).total, 0);
  assert.equal(roll('1d20k', script(faces(20, 9))).total, 9);
  const tie = roll('3d6dl1', script(faces(6, 2, 2, 5)));
  assert.equal(tie.total, 7);
  assert.equal(tie.dice[0].rolls.filter((r) => !r.kept).length, 1);
  assert.equal(roll('3d6kh0', script(faces(6, 2, 2, 5))).total, 0);
});

test('advantage and disadvantage', () => {
  assert.equal(roll('2d20kh1+5', script(faces(20, 3, 16))).total, 21);
  assert.equal(roll('2d20kl1+5', script(faces(20, 3, 16))).total, 8);
});

test('explode once by default, n times, or "infinitely" up to 100', () => {
  const once = roll('2d20!', script(faces(20, 7, 20, 8)));
  assert.equal(once.total, 35);
  assert.equal(once.breakdown, '[7, 20!, 8]');
  // Only one explosion even if the new die is a max again.
  const notTwice = roll('1d6!', script(faces(6, 6, 6)));
  assert.equal(notTwice.total, 12);
  assert.equal(notTwice.breakdown, '[6!, 6]');
  const thrice = roll('2d4!3', script(faces(4, 3, 4, 4, 2)));
  assert.equal(thrice.total, 13);
  assert.equal(thrice.breakdown, '[3, 4!, 4!, 2]');
  const forever = roll('1d1!i', script(faces(1, ...Array(101).fill(1))));
  assert.equal(forever.total, 101);
  assert.equal(forever.dice[0].rolls.length, 101);
});

test('explosions stop at the first die below the condition', () => {
  const r = roll('1d6!i', script(faces(6, 6, 6, 2)));
  assert.equal(r.total, 14);
  assert.equal(r.breakdown, '[6!, 6!, 2]');
});

test('explode and combine adds the new dice into the exploding one', () => {
  const r = roll('2d20!!', script(faces(20, 7, 20, 8)));
  assert.equal(r.total, 35);
  assert.equal(r.breakdown, '[7, 28!]');
  const chain = roll('2d4!!3', script(faces(4, 3, 4, 4, 2)));
  assert.equal(chain.total, 13);
  assert.equal(chain.breakdown, '[3, 10!]');
  const forever = roll('1d1!!i', script(faces(1, ...Array(101).fill(1))));
  assert.equal(forever.breakdown, '[101!]');
});

test('explode with conditions', () => {
  // Explode on 3 only.
  const r = roll('1d4!=3', script(faces(4, 3, 2)));
  assert.equal(r.breakdown, '[3!, 2]');
  assert.equal(r.total, 5);
  const max = roll('1d4!=3', script(faces(4, 4)));
  assert.equal(max.breakdown, '[4]');
  // Explode anything but 3, infinitely.
  const not3 = roll('1d4!i=!3', script(faces(4, 4, 2, 3)));
  assert.equal(not3.breakdown, '[4!, 2!, 3]');
  // Explode on 5 or more (Shadowrun-like).
  const high = roll('1d6!>=5', script(faces(6, 5, 1)));
  assert.equal(high.total, 6);
});

test('reroll the lowest face once, n times, or until it is not', () => {
  const once = roll('2d20r', script(faces(20, 1, 18, 1)));
  assert.equal(once.total, 19);
  assert.equal(once.breakdown, '[1r, 18]');
  const n = roll('2d4r3', script(faces(4, 3, 1, 1, 1, 3)));
  assert.equal(n.total, 6);
  assert.equal(n.breakdown, '[3, 3r]');
  const until = roll('1d2ri', script(faces(2, 1, 1, 1, 2)));
  assert.equal(until.total, 2);
  assert.equal(until.breakdown, '[2r]');
});

test('reroll with conditions', () => {
  const r = roll('4d4r<3', script(faces(4, 4, 1, 2, 4, 4, 3)));
  assert.equal(r.breakdown, '[4, 4r, 3r, 4]');
  assert.equal(r.total, 15);
  const either = roll('4d4r<2>3', script(faces(4, 4, 1, 2, 4, 3, 2, 2)));
  assert.equal(either.breakdown, '[3r, 2r, 2, 2r]');
  assert.equal(either.total, 9);
});

test('great weapon fighting: reroll 1s and 2s once', () => {
  const r = roll('2d6r<=2', script(faces(6, 1, 5, 2)));
  assert.equal(r.total, 7);
});

test('sort ascending and descending only reorder', () => {
  const asc = roll('4d6s', script(faces(6, 5, 2, 6, 1)));
  assert.equal(asc.breakdown, '[1, 2, 5, 6]');
  assert.equal(asc.total, 14);
  const desc = roll('4d6sd', script(faces(6, 5, 2, 6, 1)));
  assert.equal(desc.breakdown, '[6, 5, 2, 1]');
});

test('unique rerolls duplicates, and gives up when it cannot', () => {
  const r = roll('3d6u', script(faces(6, 2, 2, 5, 2, 4)));
  assert.deepEqual(r.dice[0].rolls.map((d) => d.value), [2, 4, 5]);
  assert.equal(r.breakdown, '[2, 4u, 5]');
  // Seven d6 can never all differ: left alone.
  const impossible = roll('7d6u', script(faces(6, 1, 1, 2, 3, 4, 5, 6)));
  assert.equal(impossible.total, 22);
});

test('modifiers run in order, then keep and drop', () => {
  // Reroll the 1, explode the 6, then keep the three highest of all.
  const r = roll('4d6r!kh3', script(faces(6, 1, 6, 3, 2, 4, 5)));
  assert.equal(r.breakdown, '[4r, 6!, 5, 3d, 2d]');
  assert.equal(r.total, 15);
});

test('success counting with conditions', () => {
  const r = roll('5d10>7', script(faces(10, 8, 3, 10, 7, 9)));
  assert.equal(r.total, 3);
  assert.equal(r.breakdown, '[8*, 3, 10*, 7, 9*]');
  assert.equal(roll('5d10>=7', script(faces(10, 8, 3, 10, 7, 9))).total, 4);
  assert.equal(roll('3d6=6', script(faces(6, 6, 6, 1))).total, 2);
  assert.equal(roll('3d6=!6', script(faces(6, 6, 6, 1))).total, 1);
  assert.equal(roll('3d6<3', script(faces(6, 1, 2, 3))).total, 2);
  assert.equal(roll('3d6<=3', script(faces(6, 1, 2, 3))).total, 3);
  // More than one condition: any of them counts.
  assert.equal(roll('4d6=1=6', script(faces(6, 1, 6, 3, 4))).total, 2);
});

test('negative successes: 1s subtract (World of Darkness)', () => {
  const r = roll('5d10>=8-=1', script(faces(10, 9, 1, 3, 10, 1)));
  assert.equal(r.total, 0);
  assert.equal(r.breakdown, '[9*, 1-, 3, 10*, 1-]');
  assert.equal(roll('3d10>=8=-1', script(faces(10, 9, 1, 8))).total, 1);
});

test('dropped dice do not count as successes', () => {
  const r = roll('3d6kh2>3', script(faces(6, 5, 6, 4)));
  assert.equal(r.total, 2);
});

test('a rolled comparison value', () => {
  // Compare against 1d6 = 4.
  const r = roll('3d6>1d6', script(faces(6, 2, 5, 6), faces(6, 4)));
  assert.equal(r.total, 2);
  assert.equal(r.dice.length, 1);
});

test('a negative number of dice subtracts', () => {
  const r = roll('(0-2)d6', script(faces(6, 3, 4)));
  assert.equal(r.total, -7);
  assert.equal(r.breakdown, '-[3, 4]');
  assert.equal(roll('-2d6', script(faces(6, 3, 4))).total, -7);
});

test('a group as the number of dice', () => {
  const r = roll('(1d4)d6', script(faces(4, 3), faces(6, 1, 2, 3)));
  assert.equal(r.total, 6);
  assert.equal(roll('(0)d6', none).total, 0);
});

test('a full Dice Roller example', () => {
  const r = roll('3d4+3d4-(3d4 * 1d4) - 2^1d7', script(faces(4, 1, 2, 3, 4, 4, 4, 1, 1, 1, 2), faces(7, 3)));
  // 6 + 12 - (3 * 2) - 2^3
  assert.equal(r.total, 4);
  assert.equal(r.breakdown, '[1, 2, 3]+[4, 4, 4]-([1, 1, 1] * [2]) - 2^[3]');
});

test('names: note fields and saved formulas', () => {
  const fields: Record<string, number | string> = { str: 3, field: 2, attack: '1d20+str', loop: 'loop+1', bad: '1d', broken: '2+' };
  const resolve = (name: string) => fields[name];
  const r = roll('1d20+str', script(faces(20, 10)), { resolve });
  assert.equal(r.total, 13);
  assert.equal(r.breakdown, '[10]+3');
  const alias = roll('attack', script(faces(20, 15)), { resolve });
  assert.equal(alias.total, 18);
  assert.equal(alias.breakdown, '18');
  assert.equal(roll('1d6*field + field', script(faces(6, 4)), { resolve }).total, 10);
  assert.deepEqual(tryRoll('loop', { resolve }), { error: '"loop" refers to itself.' });
  assert.match((tryRoll('broken', { resolve }) as { error: string }).error, /Saved formula "broken"/);
  assert.deepEqual(tryRoll('dex', { resolve }), { error: '"dex" is not a saved formula or a number field of this note.' });
  assert.deepEqual(tryRoll('dex', {}), { error: '"dex" is not a saved formula or a number field of this note.' });
});

test('average mode: every die shows its average', () => {
  const r = rollFormula('2d6+3', { average: true, random: none });
  assert.equal(r.total, 10);
  assert.equal(r.breakdown, '[3.5, 3.5]+3');
  assert.equal(r.average, true);
  assert.equal(rollFormula('1d20', { average: true, random: none }).total, 10.5);
  assert.equal(rollFormula('4dF', { average: true, random: none }).total, 0);
  assert.equal(rollFormula('1d[1,3,8]', { average: true, random: none }).total, 4);
  // Explosions and rerolls need real dice: skipped.
  assert.equal(rollFormula('2d6!r', { average: true, random: none }).total, 7);
  assert.equal(rollFormula('1d66%', { average: true, random: none }).total, 38.5);
});

test('natural maximum and minimum are flagged', () => {
  assert.equal(roll('1d20+5', script(faces(20, 20))).allMax, true);
  assert.equal(roll('1d20+5', script(faces(20, 19))).allMax, false);
  assert.equal(roll('1d20+5', script(faces(20, 1))).allMin, true);
  assert.equal(roll('2d6', script(faces(6, 6, 6))).allMax, true);
  assert.equal(roll('2d6', script(faces(6, 6, 5))).allMax, false);
  // Dropped dice do not matter.
  assert.equal(roll('2d20kh', script(faces(20, 3, 20))).allMax, true);
  // No dice, no flag; success counts are not natural maxima.
  assert.equal(roll('5', none).allMax, false);
  assert.equal(roll('2d6>3', script(faces(6, 6, 6))).allMax, false);
  assert.equal(rollFormula('1d20', { average: true, random: none }).allMax, false);
  // A one-faced die is neither.
  assert.deepEqual([roll('1d1', script([0.5])).allMax, roll('1d1', script([0.5])).allMin], [false, false]);
});

test('too many dice is refused before rolling them', () => {
  assert.match((tryRoll(`${MAX_DICE + 1}d6`) as { error: string }).error, /more than/);
  // Explosions count too: 5000 d1 exploding up to 100 times each.
  assert.match((tryRoll('5000d1!i') as { error: string }).error, /more than/);
  assert.ok('outcome' in tryRoll(`${MAX_DICE}d6`));
});

test('syntax errors come back as errors from tryRoll', () => {
  assert.deepEqual(tryRoll('1d'.repeat(0) + '(1'), { error: 'Missing ")".' });
});

test('formatTotal: truncation by default, rounding modes, and signs', () => {
  assert.equal(formatTotal(3.14159, 'none'), '3.14');
  assert.equal(formatTotal(3.5, 'round'), '4');
  assert.equal(formatTotal(3.2, 'up'), '4');
  assert.equal(formatTotal(3.8, 'down'), '3');
  assert.equal(formatTotal(-3.5, 'down'), '-4');
  assert.equal(formatTotal(-0.001, 'none'), '0');
  assert.equal(formatTotal(5, 'none', true), '+5');
  assert.equal(formatTotal(0, 'none', true), '0');
  assert.equal(formatTotal(-2, 'none', true), '-2');
});

test('formatNumber: whole numbers as is, others with two decimals', () => {
  assert.equal(formatNumber(3), '3');
  assert.equal(formatNumber(3.5), '3.5');
  assert.equal(formatNumber(1 / 3), '0.33');
});
