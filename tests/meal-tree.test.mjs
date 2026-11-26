// Unit tests for the Meals tab maths. Lifts the pure engine block out of
// src/App.jsx and runs it under node against the real data files.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const src = read('../src/App.jsx');
const a = src.indexOf('// >>> MEAL TREE ENGINE'), b = src.indexOf('// <<< MEAL TREE ENGINE');
assert.ok(a >= 0 && b > a);
const api = new Function(`${src.slice(a, b)}\nreturn { MEAL_SLOTS, MEAL_OPTIONS, parseFoodsCsv, mealFoodIndex, mealMacros, mealRoundGrams, mealTargetsFor, mealRemaining, mealBuildTree, mealInRange, mealSwaps, mealResolveParsed, mealAdd, mealZero, MEAL_EFFORTS, MEAL_EFFORT_SLOTS, mealApplyVariant };`)();
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
    assert.ok(o.variants.length >= 3, `${o.id} needs variations`);
  }
  // Effort is about time: minimal is quicker than average, which is quicker than all out.
  for (const s of api.MEAL_EFFORT_SLOTS) {
    const max = (e) => Math.max(...api.MEAL_OPTIONS[s].filter((o) => o.effort === e).map((o) => o.mins));
    const min = (e) => Math.min(...api.MEAL_OPTIONS[s].filter((o) => o.effort === e).map((o) => o.mins));
    assert.ok(max('min') <= min('mid') && max('mid') <= min('max'), `${s} effort times overlap`);
  }
});

test('every variation uses foods from the table, changes the recipe, and keeps the day in range', () => {
  let n = 0;
  for (const d of ['lift', 'cardio', 'rest']) {
    const tgt = api.mealTargetsFor(targets, d, false);
    for (const slot of api.MEAL_SLOTS) for (const o of api.MEAL_OPTIONS[slot]) for (const v of o.variants) {
      for (const [from, to] of Object.entries(v.swap)) {
        assert.ok(o.parts.some((p) => p[0] === from), `${o.id}/${v.id}: ${from} is not in the recipe`);
        assert.ok(ix[to], `${o.id}/${v.id}: ${to} missing from foods.csv`);
        assert.ok(!o.parts.some((p) => p[0] === to), `${o.id}/${v.id}: ${to} is already in the recipe`);
      }
      // Eat the average-effort default everywhere else, this variation in its own slot.
      let eaten = api.mealZero(); const done = [];
      for (const s of api.MEAL_SLOTS) {
        const t = api.mealBuildTree({ tree, targets, dayType: d, stall: false, eaten, doneSlots: done, ix, variantOf: { [`${slot}:${o.id}`]: v.id } });
        const list = t.slots[s].options;
        const opt = s === slot ? list.find((x) => x.id === o.id) : (list.find((x) => x.effort === 'mid') || list[0]);
        if (s === slot) {
          assert.equal(opt.variant, v.id);
          assert.ok(Object.keys(v.swap).every((from) => !opt.items.some((i) => i.food === from)), `${o.id}/${v.id} still has the swapped-out food`);
        }
        eaten = api.mealAdd(eaten, opt.macros); done.push(s);
      }
      assert.deepEqual(api.mealInRange(tgt, eaten), OK, `${d} ${o.id}/${v.id}: ${JSON.stringify(eaten)}`);
      n++;
    }
  }
  assert.ok(n > 300);
});

test('a variation re-portions the swapped food instead of copying the grams', () => {
  const base = api.MEAL_OPTIONS.lunch.find((o) => o.id === 'burrito-bowl');
  const v = api.mealApplyVariant(base, 'shrimp', ix);
  const chicken = base.parts.find((p) => p[0] === 'Chicken breast, cooked')[1];
  const shrimp = v.parts.find((p) => p[0] === 'Shrimp, cooked')[1];
  assert.ok(shrimp > chicken, 'shrimp has less protein per gram, so more of it');
  assert.equal(api.mealApplyVariant(base, 'nope', ix), base);
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
