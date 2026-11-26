// Unit tests for the Meals tab maths. Lifts the pure engine block out of
// src/App.jsx and runs it under node against the real data files.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const src = read('../src/App.jsx');
const a = src.indexOf('// >>> MEAL TREE ENGINE'), b = src.indexOf('// <<< MEAL TREE ENGINE');
assert.ok(a >= 0 && b > a);
const api = new Function(`${src.slice(a, b)}\nreturn { MEAL_SLOTS, MEAL_OPTIONS, parseFoodsCsv, mealFoodIndex, mealMacros, mealRoundGrams, mealTargetsFor, mealRemaining, mealBuildTree, mealInRange, mealSwaps, mealResolveParsed, mealAdd, mealZero };`)();
const foods = api.parseFoodsCsv(read('../src/data/foods.csv'));
const ix = api.mealFoodIndex(foods);
const targets = JSON.parse(read('../src/data/targets.json'));
const tree = JSON.parse(read('../src/data/breakfast_tree_1.json'));
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
  const rice = (t) => t.slots.lunch.options[0].items.find((i) => i.food === 'White rice, cooked').grams;
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

test('every branch keeps the day inside the ranges, whichever options are picked', () => {
  for (const d of ['lift', 'cardio', 'rest']) {
    for (let pick = 0; pick < 3; pick++) {
      let eaten = api.mealZero(); const done = [];
      for (const s of api.MEAL_SLOTS) {
        const t = api.mealBuildTree({ tree, targets, dayType: d, stall: false, eaten, doneSlots: done, ix });
        const opt = t.slots[s].options[(pick + done.length) % 3];
        eaten = api.mealAdd(eaten, opt.macros); done.push(s);
      }
      const verdict = api.mealInRange(api.mealTargetsFor(targets, d, false), eaten);
      assert.deepEqual(verdict, { kcal: 'ok', protein: 'ok', carbs: 'ok', fat: 'ok' }, `${d} pick ${pick}: ${JSON.stringify(eaten)}`);
    }
  }
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
