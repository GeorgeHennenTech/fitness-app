// Unit tests for the Volume Ramp planner. The planner lives in src/App.jsx
// (the app is one file by design), so this lifts the pure blocks out of it
// and runs them under node. Run with: npm test
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const src = readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
const cut = (from, to) => {
  const a = src.indexOf(from); const b = src.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `could not find block: ${from}`);
  return src.slice(a, b);
};
const code = [
  cut('const MUSCLE_MAP = {', '// >>> VOLUME RAMP PLANNER'),
  cut('const PHASE_PROFILES = {', '// Decide what to recommend'),
  cut('function computeProgression(', 'function ExerciseCard('),
  cut('// >>> VOLUME RAMP PLANNER', '// <<< VOLUME RAMP PLANNER'),
].join('\n');
const api = new Function(`${code}\nreturn { MUSCLE_MAP, MUSCLE_DIRECT, muscleSetWeight, MUSCLE_TARGETS, MUSCLE_ORDER, RAMP, plannedVolume, rampCandidates, defaultRampMuscles, proposeRamp, rampWeekNumber, rampLiftFlags, gateRampMuscle, placeRampSets, rampApplyChanges, buildRampWeek, computeProgression, rampCeiling, rampStep };`)();
const { MUSCLE_TARGETS, RAMP } = api;

const ex = (name, sets, track = true) => ({ name, sets, reps: '10-12', repMin: 10, repMax: 12, track, progression: 5 });
const lift = (name, exercises, warm = []) => ({ name, type: 'lift', blocks: [{ name: 'Warm-Up', exercises: warm }, { name: 'Main Lifts', exercises }] });
const program = () => ({
  1: lift('Push A', [ex('Flat Barbell Bench Press', 4), ex('Incline DB Press', 3), ex('DB Lateral Raises', 3), ex('Overhead Tricep Extension', 3)], [ex('Band Pull-Aparts', 3, false)]),
  2: lift('Pull A', [ex('Barbell Row', 4), ex('Lat Pulldown (med grip)', 3), ex('Incline DB Curl', 3), ex('Face Pulls', 3)]),
  3: lift('Legs', [ex('Back Squat', 4), ex('Romanian Deadlift', 3), ex('Calf Raises', 4)]),
  4: { name: 'Rest', type: 'rest', blocks: [] },
  5: lift('Push B', [ex('Incline DB Press', 3), ex('DB Lateral Raises', 2), ex('Overhead Press', 3)]),
  6: lift('Pull B', [ex('Assisted Pull-Ups', 3), ex('Hammer Curls', 3), ex('Reverse Pec Deck', 3)]),
  7: { name: 'Rest', type: 'rest', blocks: [] },
});
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`ok - ${name}`); };

test('planned volume sums working sets per muscle and skips warm-ups', () => {
  const v = api.plannedVolume(program());
  assert.equal(v.total.chest, 10);          // 4 bench + 3 + 3 incline
  assert.equal(v.total['upper chest'], 6);  // incline only
  assert.equal(v.total['side delts'], 5);
  assert.equal(v.total['rear delts'], 6);   // face pulls + reverse pec deck; the warm-up band work is not counted
  assert.equal(v.byDay[1]['side delts'], 3);
  assert.equal(v.byDay[4].chest, undefined);
});

test('fractional counting: direct sets count 1, indirect sets 0.5', () => {
  assert.equal(api.muscleSetWeight('Flat Barbell Bench Press', 'chest'), 1);
  assert.equal(api.muscleSetWeight('Flat Barbell Bench Press', 'triceps'), 0.5);
  assert.equal(api.muscleSetWeight('Some Unlisted Lift', 'chest'), 1);
  for (const name of Object.keys(api.MUSCLE_DIRECT)) {
    assert.ok(api.MUSCLE_MAP[name], `${name} is in MUSCLE_DIRECT but not MUSCLE_MAP`);
    assert.ok(api.MUSCLE_DIRECT[name].length > 0);
    for (const m of api.MUSCLE_DIRECT[name]) assert.ok(api.MUSCLE_MAP[name].includes(m), `${name}: ${m}`);
  }
  for (const name of Object.keys(api.MUSCLE_MAP)) assert.ok(api.MUSCLE_DIRECT[name], `${name} has no direct muscles listed`);
  const v = api.plannedVolume(program());
  assert.equal(v.total.triceps, 3 + (4 + 3 + 3 + 3) * 0.5);   // extension direct; bench, 2x incline, overhead press indirect
  assert.equal(v.total.biceps, 3 + 3 + (4 + 3 + 3) * 0.5);    // curls direct; row, pulldown, pull-ups indirect
  assert.equal(v.total.back, 4);
  assert.equal(v.total.traps, (4 + 3) * 0.5);
});

test('propose: cut uses +1 and the middle of the range, bulk the full step and the max', () => {
  const planned = { ...api.plannedVolume(program()).total, biceps: 12 };
  const cutC = api.rampCandidates(planned, 'cut').find((c) => c.muscle === 'biceps');
  const bulkC = api.rampCandidates(planned, 'bulk').find((c) => c.muscle === 'biceps');
  const recompC = api.rampCandidates(planned, 'recomp').find((c) => c.muscle === 'biceps');
  const t = MUSCLE_TARGETS.biceps; // 8 to 24
  assert.equal(cutC.step, 1);
  assert.equal(cutC.ceiling, Math.round((t.min + t.max) / 2));
  assert.equal(cutC.target, 16);
  assert.equal(bulkC.step, 2);
  assert.equal(bulkC.ceiling, t.max);
  assert.equal(bulkC.target, 24);            // 12 + 2 x 6 weeks, capped at max
  assert.ok(recompC.ceiling > cutC.ceiling && recompC.ceiling < bulkC.ceiling);
});

test('propose: step never tops ~20% of current sets, block is 4 to 6 weeks', () => {
  for (const phase of ['cut', 'recomp', 'maintain', 'bulk']) {
    for (let cur = 0; cur <= 24; cur++) {
      const step = api.rampStep(cur, phase);
      assert.ok(step === 1 || step === 2);
      if (step === 2) assert.ok(2 / cur <= 0.2 + 1e-9, `${phase} ${cur}`);
    }
  }
  const planned = api.plannedVolume(program()).total;
  const cands = api.rampCandidates(planned, 'bulk');
  const picks = api.defaultRampMuscles(cands);
  assert.ok(picks.includes('side delts'));   // 5 planned, minimum 8
  assert.ok(!picks.includes('chest'));       // 10 planned, minimum 10
  const ramp = api.proposeRamp(planned, 'bulk', picks, '2026-11-25', '2026-11-23');
  assert.ok(ramp.blockWeeks >= RAMP.minWeeks && ramp.blockWeeks <= RAMP.maxWeeks);
  assert.deepEqual(ramp.muscles['side delts'], { startSets: 5, targetSets: 11, step: 1 });
  assert.equal(api.rampWeekNumber(ramp, '2026-11-23'), 1);
  assert.equal(api.rampWeekNumber(ramp, '2026-12-07'), 3);
});

test('gate: low adherence holds', () => {
  const g = api.gateRampMuscle({ muscle: 'side delts', cfg: { targetSets: 11, step: 1 }, cur: 5, plannedLast: 5, doneLast: 3, flags: [] });
  assert.equal(g.ok, false); assert.equal(g.code, 'adherence');
  assert.match(g.msg, /^Hold\. Finish the sets you have first/);
  assert.equal(api.gateRampMuscle({ muscle: 'side delts', cfg: { targetSets: 11, step: 1 }, cur: 5, plannedLast: 10, doneLast: 9, flags: [] }).ok, true);
});

test('gate: a stalled lift holds the muscles it hits, and only those', () => {
  const lifts = [{ name: 'Flat Barbell Bench Press', pct: 0, stalled: true, dropped: false }, { name: 'Back Squat', pct: 3, stalled: false, dropped: false }];
  const flags = api.rampLiftFlags(lifts, 'bulk');
  assert.deepEqual(flags.map((f) => f.kind), ['stalled']);
  const chest = api.gateRampMuscle({ muscle: 'chest', cfg: { targetSets: 16, step: 2 }, cur: 10, plannedLast: 10, doneLast: 10, flags });
  assert.equal(chest.code, 'performance');
  assert.match(chest.msg, /Flat Barbell Bench Press is stalled/);
  const quads = api.gateRampMuscle({ muscle: 'quads', cfg: { targetSets: 12, step: 1 }, cur: 8, plannedLast: 8, doneLast: 8, flags });
  assert.equal(quads.ok, true);
});

test('gate: on a cut a flat lift is fine but a dropping one holds; an earned increase is not a stall', () => {
  const flat = [{ name: 'Flat Barbell Bench Press', pct: 0, stalled: true, dropped: false }];
  assert.equal(api.rampLiftFlags(flat, 'cut').length, 0);
  assert.equal(api.rampLiftFlags([{ ...flat[0], pct: -4, dropped: true }], 'cut')[0].kind, 'regressing');
  // computeProgression says the lift is due more weight, so it is not treated as stalled.
  const exercise = { name: 'Flat Barbell Bench Press', sets: 3, repMin: 8, repMax: 10, track: true, progression: 5 };
  const maxed = [{ weight: 185, reps: 10 }, { weight: 185, reps: 10 }, { weight: 185, reps: 10 }];
  const prog = api.computeProgression(exercise, [{ date: '2026-11-20', sets: maxed }], 'bulk');
  assert.equal(prog.type, 'increase');
  assert.equal(api.rampLiftFlags(flat, 'bulk', new Set(['Flat Barbell Bench Press'])).length, 0);
});

test('gate: the ceiling stops the ramp', () => {
  const g = api.gateRampMuscle({ muscle: 'biceps', cfg: { targetSets: 16, step: 1 }, cur: 16, plannedLast: 16, doneLast: 16, flags: [] });
  assert.equal(g.code, 'reached');
});

test('placement: adds one set to a direct exercise on the day with the fewest sets', () => {
  const { changes, schedule } = api.placeRampSets(program(), 'side delts', 1);
  assert.deepEqual(changes.map((c) => [c.type, c.day, c.exercise, c.from, c.to]), [['add', 5, 'DB Lateral Raises', 2, 3]]);
  assert.equal(api.plannedVolume(schedule).total['side delts'], 6);
  // Two sets spread across both days rather than piling onto one.
  const two = api.placeRampSets(program(), 'side delts', 2).changes;
  assert.deepEqual(two.map((c) => [c.day, c.from, c.to]), [[5, 2, 3], [1, 3, 4]]);
  // Chest prefers the bench/incline it is listed first on, and reports the knock-on muscles.
  const chest = api.placeRampSets(program(), 'chest', 1).changes[0];
  assert.equal(chest.day, 5);
  assert.ok(chest.also.includes('upper chest'));
});

test('placement: respects the per-session cap and suggests a mapped exercise when nothing fits', () => {
  const p = program();
  p[1].blocks[1].exercises.find((e) => e.name === 'DB Lateral Raises').sets = 10;
  p[5].blocks[1].exercises.find((e) => e.name === 'DB Lateral Raises').sets = 10;
  const { changes } = api.placeRampSets(p, 'side delts', 1);
  assert.equal(changes[0].type, 'new');
  assert.equal(changes[0].exercise, 'Cable Lateral Raises');
  assert.ok(api.MUSCLE_MAP[changes[0].exercise].includes('side delts'));
  assert.ok(![1, 5].includes(changes[0].day));
  // Mid-back goes on the row, never on an exercise that only hits it indirectly.
  const withDead = program();
  withDead[3].blocks[1].exercises.push(ex('Deadlift', 3));
  assert.equal(api.placeRampSets(withDead, 'back', 1).changes[0].exercise, 'Barbell Row');
  // Traps have no direct exercise here, so a direct one is suggested before leaning on indirect work.
  const traps = api.placeRampSets(program(), 'traps', 1).changes[0];
  assert.equal(traps.type, 'new'); assert.equal(traps.exercise, 'Shrugs');
  // A muscle with no exercise at all gets a suggestion from the map, never an invented name.
  const core = api.placeRampSets(program(), 'core', 1).changes[0];
  assert.equal(core.type, 'new');
  assert.ok(core.exercise in api.MUSCLE_MAP);
});

test('apply: writes only the listed changes and leaves the original untouched', () => {
  const p = program();
  const next = api.rampApplyChanges(p, [{ type: 'add', day: 5, exercise: 'DB Lateral Raises', to: 3 }, { type: 'new', day: 3, exercise: 'Hanging Leg Raises', to: 2 }]);
  assert.equal(next[5].blocks[1].exercises[1].sets, 3);
  assert.equal(p[5].blocks[1].exercises[1].sets, 2);
  assert.equal(next[3].blocks[1].exercises.at(-1).name, 'Hanging Leg Raises');
  assert.equal(next[1].blocks[1].exercises.length, 4);
});

test('week: holds and additions are worked out together', () => {
  const p = program();
  const planned = api.plannedVolume(p).total;
  const ramp = api.proposeRamp(planned, 'bulk', ['side delts', 'biceps', 'upper chest'], '2026-11-23', '2026-11-23');
  const flags = api.rampLiftFlags([{ name: 'Incline DB Curl', pct: -5, stalled: true, dropped: true }], 'bulk');
  const gates = {};
  for (const m of Object.keys(ramp.muscles)) gates[m] = api.gateRampMuscle({ muscle: m, cfg: ramp.muscles[m], cur: planned[m], plannedLast: planned[m], doneLast: planned[m], flags });
  const week = api.buildRampWeek(p, ramp, gates);
  assert.equal(week.holds.biceps.code, 'performance');
  assert.ok(week.changes.some((c) => c.muscle === 'side delts'));
  assert.ok(week.changes.some((c) => c.muscle === 'upper chest' && c.exercise === 'Incline DB Press'));
  assert.ok(!week.changes.some((c) => c.muscle === 'biceps'));
  for (const d of [1, 2, 3, 5, 6]) for (const n of Object.values(api.plannedVolume(week.schedule).byDay[d])) assert.ok(n <= RAMP.sessionCap);
});

console.log(`\n${passed} tests passed`);
