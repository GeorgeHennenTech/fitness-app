// Unit tests for the Meals tab maths. Lifts the pure engine block out of
// src/App.jsx and runs it under node against the real data files.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const src = read('../src/App.jsx');
const a = src.indexOf('// >>> MEAL TREE ENGINE'), b = src.indexOf('// <<< MEAL TREE ENGINE');
assert.ok(a >= 0 && b > a);
const api = new Function(`${src.slice(a, b)}\nreturn { MEAL_SLOTS, MEAL_OPTIONS, parseFoodsCsv, mealFoodIndex, mealMacros, mealRoundGrams, mealTargetsFor, mealRemaining, mealBuildTree, mealInRange, mealSwaps, mealResolveParsed, mealAdd, mealZero, MEAL_EFFORTS, MEAL_EFFORT_SLOTS, mealApplyVariant, mealSwapIndex, mealTier1Chips };`)();
const foods = api.parseFoodsCsv(read('../src/data/foods.csv'));
const ix = api.mealFoodIndex(foods);
const targets = JSON.parse(read('../src/data/targets.json'));
const tree = JSON.parse(read('../src/data/breakfast_tree_1.json'));
const tierText = (f) => read(`../src/data/swaps/${f}.csv`);
const swapIx = api.mealSwapIndex([[1, tierText('tier1_same_dish')], [2, tierText('tier2_same_macros')], [3, tierText('tier3_looser')]]);
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok - ${name}`); };
const near = (x, y, tol, msg) => assert.ok(Math.abs(x - y) <= tol, `${msg || ''} got ${x}, want ${y} ±${tol}`);
const dayTotal = (dayType) => {
  let t = api.mealZero();
  for (const s of api.MEAL_SLOTS) t = api.mealAdd(t, api.mealMacros(tree.days[dayType].meals[s], ix));
  return t;
};

test('food table loads: 196 foods, quoted names, confidence flags', () => {
  assert.equal(foods.length, 196);
  assert.ok(ix['Bagel, plain'] && ix['Egg, whole boiled']);
  assert.ok(foods.some((f) => f.flagged) && foods.some((f) => !f.flagged));
  for (const s of api.MEAL_SLOTS) for (const o of api.MEAL_OPTIONS[s]) for (const [food] of o.parts) assert.ok(ix[food], `option food missing from foods.csv: ${food}`);
});

test('acceptance 1: the worked day matches expected_totals within 1 kcal and 1 g', () => {
  for (const d of ['lift', 'cardio', 'rest']) {
    const t = dayTotal(d), e = tree.days[d].expected_totals;
    near(t.kcal, e.kcal, 1, d); near(t.protein, e.protein, 1, d); near(t.carbs, e.carbs, 1, d); near(t.fat, e.fat, 1, d);
  }
});

test('acceptance 2: breakfast only on a lift day leaves about 2430 / 131 / 337 / 57', () => {
  const eaten = api.mealMacros(tree.days.lift.meals.breakfast, ix);
  const r = api.mealRemaining(api.mealTargetsFor(targets, 'lift', false), eaten);
  near(r.kcal, 2430, 5); near(r.protein, 131, 1); near(r.carbs, 337, 1); near(r.fat, 57, 1);
});

test('acceptance 3: chicken breast swaps to tilapia with new grams and protein in tolerance', () => {
  const swaps = api.mealSwaps('Chicken breast, cooked', 130, foods);
  const t = swaps.find((x) => x.food === 'Tilapia, cooked');
  assert.ok(t, 'tilapia offered');
  assert.ok(t.ratio >= 0.6 && t.ratio <= 1.67);
  assert.ok(!t.off.includes('protein'));
  assert.notEqual(Math.round(t.grams), 130);
  for (const x of swaps) assert.equal(ix[x.food].role, ix['Chicken breast, cooked'].role);
});

test('acceptance 5: day type changes the carb target and the suggestions', () => {
  const mk = (dayType) => api.mealBuildTree({ tree, targets, dayType, stall: false, eaten: api.mealZero(), doneSlots: [], ix });
  const lift = mk('lift'), rest = mk('rest');
  assert.equal(lift.target.carbs.aim, 430); assert.equal(rest.target.carbs.aim, 320);
  const rice = (t) => t.slots.lunch.options.find((o) => o.id === 'burrito-bowl').items.find((i) => i.food === 'White rice, cooked').grams;
  assert.ok(rice(lift) > rice(rest) + 20);
});

test('stall rule adds 150 kcal, all from carbs, to every day type', () => {
  for (const d of ['lift', 'cardio', 'rest']) {
    const a0 = api.mealTargetsFor(targets, d, false), a1 = api.mealTargetsFor(targets, d, true);
    assert.equal(a1.kcal.aim - a0.kcal.aim, 150); assert.equal(a1.kcal.min - a0.kcal.min, 150);
    assert.equal(a1.carbs.aim - a0.carbs.aim, 37.5);
    assert.equal(a1.protein.aim, a0.protein.aim); assert.equal(a1.fat.aim, a0.fat.aim);
  }
});

const OK = { kcal: 'ok', protein: 'ok', carbs: 'ok', fat: 'ok' };
test('every path through the tree lands inside all four ranges, on every day type', () => {
  let paths = 0;
  for (const d of ['lift', 'cardio', 'rest']) {
    const tgt = api.mealTargetsFor(targets, d, false);
    const go = (eaten, done, path) => {
      const s = api.MEAL_SLOTS[done.length];
      if (!s) { paths++; assert.deepEqual(api.mealInRange(tgt, eaten), OK, `${d}: ${path.join(' > ')}: ${JSON.stringify(eaten)}`); return; }
      const t = api.mealBuildTree({ tree, targets, dayType: d, stall: false, eaten, doneSlots: done, ix });
      for (const o of t.slots[s].options) go(api.mealAdd(eaten, o.macros), [...done, s], [...path, o.id]);
    };
    go(api.mealZero(), [], []);
  }
  assert.ok(paths > 50000, `walked ${paths} paths`);
});

test('meals 1 to 4 each offer at least three recipes at every effort level, with a method and a time', () => {
  assert.deepEqual(api.MEAL_EFFORT_SLOTS, ['breakfast', 'lunch', 'dinner', 'snack_1']);
  for (const s of api.MEAL_EFFORT_SLOTS) for (const [e] of api.MEAL_EFFORTS) {
    assert.ok(api.MEAL_OPTIONS[s].filter((o) => o.effort === e).length >= 3, `${s} ${e}`);
  }
  const ids = new Set();
  for (const s of api.MEAL_SLOTS) for (const o of api.MEAL_OPTIONS[s]) {
    assert.ok(!ids.has(`${s}:${o.id}`), `duplicate id ${o.id}`); ids.add(`${s}:${o.id}`);
    assert.ok(o.mins > 0 && o.how.length >= 1, `${o.id} needs a time and a method`);
  }
  // Effort is about time: minimal is quicker than average, which is quicker than all out.
  for (const s of api.MEAL_EFFORT_SLOTS) {
    const max = (e) => Math.max(...api.MEAL_OPTIONS[s].filter((o) => o.effort === e).map((o) => o.mins));
    const min = (e) => Math.min(...api.MEAL_OPTIONS[s].filter((o) => o.effort === e).map((o) => o.mins));
    assert.ok(max('min') <= min('mid') && max('mid') <= min('max'), `${s} effort times overlap`);
  }
});

test('swap database loads: 226 / 495 / 1149 pairs, every name is in the food table, indexed both ways', () => {
  const count = (tier) => Object.values(swapIx).reduce((n, row) => n + Object.values(row).filter((p) => p.tier === tier).length, 0) / 2;
  assert.equal(count(1), 226); assert.equal(count(2), 495); assert.equal(count(3), 1149);
  for (const [a, row] of Object.entries(swapIx)) { assert.ok(ix[a], a); for (const p of Object.values(row)) assert.ok(ix[p.food], p.food); }
  const ab = swapIx['Chicken breast, cooked']['Tilapia, cooked'], ba = swapIx['Tilapia, cooked']['Chicken breast, cooked'];
  assert.equal(ab.tier, 1); near(ab.ratio * ba.ratio, 1, 1e-9);
  assert.ok(ab.ratio >= 0.6 && ab.ratio <= 1.67);
});

test('tap-to-swap uses the database first, Tier 1 before 2 before 3, at its portions', () => {
  const swaps = api.mealSwaps('Chicken breast, cooked', 130, foods, swapIx);
  assert.deepEqual(swaps.filter((x) => x.tier === 1).map((x) => x.food).sort(), ['Pork tenderloin, cooked', 'Tilapia, cooked']);
  const tiers = swaps.map((x) => x.tier);
  assert.deepEqual(tiers, [...tiers].sort((x, y) => x - y));
  const t = swaps.find((x) => x.food === 'Tilapia, cooked');
  near(t.grams, 130 * swapIx['Chicken breast, cooked']['Tilapia, cooked'].ratio, 1e-9);
  assert.ok(t.exact, 'a Tier 1 pair is inside tolerance at the database portion');
  for (const x of swaps.filter((y) => y.tier === 1)) assert.ok(x.exact, x.food);
});

test('a food with no pairs falls back to the role rule and says so', () => {
  assert.equal(swapIx['Tyson grilled chicken bites cup'], undefined);
  const swaps = api.mealSwaps('Tyson grilled chicken bites cup', 150, foods, swapIx);
  assert.ok(swaps.length > 0);
  for (const x of swaps) { assert.equal(x.tier, 0); assert.equal(ix[x.food].role, ix['Tyson grilled chicken bites cup'].role); }
});

test('variation chips are Tier 1 pairs only, and every one keeps the day in range', () => {
  let n = 0, withChips = 0, total = 0;
  for (const slot of api.MEAL_SLOTS) for (const o of api.MEAL_OPTIONS[slot]) {
    const chips = api.mealTier1Chips(o, swapIx, ix);
    total++; if (chips.length) withChips++;
    for (const c of chips) {
      assert.equal(swapIx[c.from][c.to].tier, 1, `${o.id}: ${c.from} -> ${c.to}`);
      assert.ok(o.parts.some((p) => p[0] === c.from) && !o.parts.some((p) => p[0] === c.to));
      for (const d of ['lift', 'cardio', 'rest']) {
        // Eat the average-effort default everywhere else, this variation in its own slot.
        let eaten = api.mealZero(); const done = [];
        for (const s of api.MEAL_SLOTS) {
          const t = api.mealBuildTree({ tree, targets, dayType: d, stall: false, eaten, doneSlots: done, ix, swapIx, variantOf: { [`${slot}:${o.id}`]: { [c.from]: c.to } } });
          const list = t.slots[s].options;
          const opt = s === slot ? list.find((x) => x.id === o.id) : (list.find((x) => x.effort === 'mid') || list[0]);
          if (s === slot) {
            assert.ok(opt.items.every((i) => i.food !== c.from), `${o.id} still has ${c.from}`);
            assert.equal(opt.swaps[c.from], c.to);
          }
          eaten = api.mealAdd(eaten, opt.macros); done.push(s);
        }
        assert.deepEqual(api.mealInRange(api.mealTargetsFor(targets, d, false), eaten), OK, `${d} ${o.id}: ${c.from} -> ${c.to}: ${JSON.stringify(eaten)}`);
        n++;
      }
    }
  }
  console.log(`   (${withChips} of ${total} recipes have Tier 1 variations; ${n / 3} chips checked on 3 day types)`);
  assert.ok(n > 300);
});

test('chips combine, start from the database portion, and unknown swaps are ignored', () => {
  const base = api.MEAL_OPTIONS.lunch.find((o) => o.id === 'burrito-bowl');
  const v = api.mealApplyVariant(base, { 'Chicken breast, cooked': 'Tilapia, cooked', 'White rice, cooked': 'Brown rice, cooked' }, ix, swapIx);
  const g = (o, f) => o.parts.find((p) => p[0] === f)[1];
  near(g(v, 'Tilapia, cooked'), g(base, 'Chicken breast, cooked') * swapIx['Chicken breast, cooked']['Tilapia, cooked'].ratio, 1e-9);
  assert.ok(v.parts.some((p) => p[0] === 'Brown rice, cooked') && !v.parts.some((p) => p[0] === 'White rice, cooked'));
  assert.equal(v.variantLabel, 'Tilapia, Brown rice');
  assert.equal(api.mealApplyVariant(base, { 'Chicken breast, cooked': 'Unicorn' }, ix, swapIx), base);
  assert.equal(api.mealApplyVariant(base, null, ix, swapIx), base);
});

test('the tree corrects course after an off-plan meal', () => {
  // A heavy, fatty breakfast: later meals must shrink fat and still land in range.
  const eaten = { kcal: 1100, protein: 35, carbs: 90, fat: 60 };
  let total = eaten; const done = ['breakfast'];
  for (const s of api.MEAL_SLOTS.slice(1)) {
    const t = api.mealBuildTree({ tree, targets, dayType: 'lift', stall: false, eaten: total, doneSlots: done, ix });
    total = api.mealAdd(total, t.slots[s].options[0].macros); done.push(s);
  }
  const v = api.mealInRange(api.mealTargetsFor(targets, 'lift', false), total);
  assert.equal(v.protein, 'ok'); assert.equal(v.carbs, 'ok'); assert.equal(v.kcal, 'ok');
});

test('grams round to 5 for display only', () => {
  assert.equal(api.mealRoundGrams(132.4), 130); assert.equal(api.mealRoundGrams(133), 135); assert.equal(api.mealRoundGrams(2), 5); assert.equal(api.mealRoundGrams(0), 0);
});

test('acceptance 4 (the checking half): parsed text only resolves to foods in the table', () => {
  const r = api.mealResolveParsed([{ food: 'Egg, whole boiled', grams: 150 }, { food: 'brownberry 100% whole wheat bread (regular slice)', grams: 129 }, { food: 'Unicorn steak', grams: 100 }, { food: 'Banana', grams: -5 }], foods);
  assert.deepEqual(r.items.map((i) => i.food), ['Egg, whole boiled', 'Brownberry 100% Whole Wheat bread (regular slice)']);
  assert.deepEqual(r.unknown, ['Unicorn steak', 'Banana']);
});

console.log(`\n${passed} tests passed`);
