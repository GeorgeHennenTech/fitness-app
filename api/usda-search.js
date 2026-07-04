// Drop this at /api/usda-search.js in your Vercel project.
// Requires a FREE USDA FoodData Central API key in env as USDA_API_KEY.
//   Get one at https://fdc.nal.usda.gov/api-key-signup/  (instant, free)
//
// GET /api/usda-search?query=chicken breast
//   → { results: [{ fdcId, name, dataType, serving, cal, protein, carbs, fat, micros }] }
//
// USDA FoodData Central is public domain (CC0). Foundation Foods and SR Legacy
// entries carry deep nutrient panels (vitamins, minerals, amino acids, fatty
// acids); Branded entries carry mostly label nutrients. We prefer the deep
// data types in the result ordering.
//
// This endpoint maps USDA nutrient *numbers* to our app's micro keys so the
// client gets a ready-to-store micros object.

// USDA nutrient number → our micro key. Mirrors MICRONUTRIENTS[].usda in the app.
const USDA_MAP = {
  '291': 'fiber', '269': 'sugar', '539': 'addedSugar', '601': 'cholesterol',
  '262': 'caffeine', '421': 'choline',
  '320': 'vitaminA', '401': 'vitaminC', '328': 'vitaminD', '323': 'vitaminE',
  '430': 'vitaminK', '404': 'thiamin', '405': 'riboflavin', '406': 'niacin',
  '410': 'pantothenic', '415': 'vitaminB6', '435': 'folate', '418': 'vitaminB12',
  '301': 'calcium', '303': 'iron', '304': 'magnesium', '305': 'phosphorus',
  '306': 'potassium', '307': 'sodium', '309': 'zinc', '312': 'copper',
  '315': 'manganese', '317': 'selenium',
  '606': 'satFat', '645': 'monoFat', '646': 'polyFat', '605': 'transFat',
  '851': 'omega3ALA', '629': 'omega3EPA', '621': 'omega3DHA',
  '512': 'histidine', '503': 'isoleucine', '504': 'leucine', '505': 'lysine',
  '506': 'methionine', '508': 'phenylalanine', '502': 'threonine', '501': 'tryptophan',
  '510': 'valine', '511': 'arginine', '513': 'alanine', '514': 'asparticAcid',
  '515': 'glutamicAcid', '516': 'glycine', '517': 'proline', '518': 'serine',
  '509': 'tyrosine', '507': 'cystine',
  '321': 'betaCarotene', '322': 'alphaCarotene', '337': 'lycopene',
  '338': 'luteinZea', '334': 'betaCrypto',
};
// Which of our keys are stored in mg vs g vs mcg — USDA reports in unitName;
// we normalize to the unit our app expects for that key.
const KEY_UNIT = {
  fiber: 'g', sugar: 'g', addedSugar: 'g', cholesterol: 'mg', caffeine: 'mg', choline: 'mg',
  vitaminA: 'mcg', vitaminC: 'mg', vitaminD: 'mcg', vitaminE: 'mg', vitaminK: 'mcg',
  thiamin: 'mg', riboflavin: 'mg', niacin: 'mg', pantothenic: 'mg', vitaminB6: 'mg',
  folate: 'mcg', vitaminB12: 'mcg',
  calcium: 'mg', iron: 'mg', magnesium: 'mg', phosphorus: 'mg', potassium: 'mg',
  sodium: 'mg', zinc: 'mg', copper: 'mg', manganese: 'mg', selenium: 'mcg',
  satFat: 'g', monoFat: 'g', polyFat: 'g', transFat: 'g', omega3ALA: 'g', omega3EPA: 'g', omega3DHA: 'g',
  histidine: 'g', isoleucine: 'g', leucine: 'g', lysine: 'g', methionine: 'g',
  phenylalanine: 'g', threonine: 'g', tryptophan: 'g', valine: 'g', arginine: 'g',
  alanine: 'g', asparticAcid: 'g', glutamicAcid: 'g', glycine: 'g', proline: 'g',
  serine: 'g', tyrosine: 'g', cystine: 'g',
  betaCarotene: 'mcg', alphaCarotene: 'mcg', lycopene: 'mcg', luteinZea: 'mcg', betaCrypto: 'mcg',
};

// Convert a USDA value (in usdaUnit) to the target unit for a key.
function convert(value, usdaUnit, targetUnit) {
  const u = String(usdaUnit || '').toLowerCase();
  let grams; // normalize everything to grams first where possible
  if (u === 'g') grams = value;
  else if (u === 'mg') grams = value / 1e3;
  else if (u === 'µg' || u === 'ug' || u === 'mcg') grams = value / 1e6;
  else if (u === 'iu') return null; // skip IU — ambiguous without nutrient-specific factor
  else grams = null;
  if (grams == null) return null;
  if (targetUnit === 'g') return grams;
  if (targetUnit === 'mg') return grams * 1e3;
  if (targetUnit === 'mcg') return grams * 1e6;
  return null;
}

// Build a micros object (per serving) from a USDA foodNutrients array.
function microsFromNutrients(foodNutrients, servingGrams) {
  if (!Array.isArray(foodNutrients)) return undefined;
  const per100 = {}; // key → amount per 100g in target unit
  for (const fn of foodNutrients) {
    // Search results and detail responses shape this slightly differently.
    const number = String(fn.nutrientNumber ?? fn.nutrient?.number ?? '');
    const key = USDA_MAP[number];
    if (!key) continue;
    const amount = fn.value ?? fn.amount;
    if (amount == null) continue;
    const unit = fn.unitName ?? fn.nutrient?.unitName;
    const conv = convert(parseFloat(amount), unit, KEY_UNIT[key]);
    if (conv == null || !isFinite(conv) || conv <= 0) continue;
    per100[key] = conv; // USDA amounts are per 100 g
  }
  const scale = (servingGrams || 100) / 100;
  const out = {};
  for (const [k, v] of Object.entries(per100)) {
    const scaled = v * scale;
    if (scaled > 0) out[k] = +scaled.toFixed(3);
  }
  return Object.keys(out).length ? out : undefined;
}

// Pull a macro (per 100g) by USDA number, converting to grams/kcal.
function macroFromNutrients(foodNutrients, number) {
  for (const fn of foodNutrients || []) {
    const n = String(fn.nutrientNumber ?? fn.nutrient?.number ?? '');
    if (n === number) {
      const v = fn.value ?? fn.amount;
      return v == null ? null : parseFloat(v);
    }
  }
  return null;
}

export default async function handler(req, res) {
  const query = (req.query?.query || '').toString().trim();
  if (!query) return res.status(400).json({ error: 'query required' });
  const apiKey = process.env.USDA_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'USDA_API_KEY not configured' });

  try {
    const url =
      'https://api.nal.usda.gov/fdc/v1/foods/search?api_key=' + encodeURIComponent(apiKey) +
      '&query=' + encodeURIComponent(query) +
      '&dataType=' + encodeURIComponent('Foundation,SR Legacy,Branded') +
      '&pageSize=20';
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) {
      const t = await r.text();
      return res.status(r.status).json({ error: `USDA API ${r.status}: ${t.slice(0, 200)}` });
    }
    const data = await r.json();
    const foods = data.foods || [];

    const results = [];
    for (const f of foods) {
      const fn = f.foodNutrients || [];
      // serving size in grams: prefer servingSize when unit is g/ml, else 100g
      let servingGrams = 100;
      let servingLabel = '100 g';
      if (f.servingSize && /(^|\b)(g|ml|gram)/i.test(f.servingSizeUnit || 'g')) {
        servingGrams = parseFloat(f.servingSize) || 100;
        servingLabel = `${f.servingSize} ${f.servingSizeUnit || 'g'}`;
      }
      const cal = macroFromNutrients(fn, '208');   // energy kcal
      const protein = macroFromNutrients(fn, '203');
      const carbs = macroFromNutrients(fn, '205');
      const fat = macroFromNutrients(fn, '204');
      const scale = servingGrams / 100;
      results.push({
        fdcId: f.fdcId,
        name: (f.description || '').trim() + (f.brandOwner ? ` (${f.brandOwner})` : ''),
        dataType: f.dataType,
        serving: servingLabel,
        cal: cal != null ? Math.round(cal * scale) : 0,
        protein: protein != null ? Math.round(protein * scale * 10) / 10 : 0,
        carbs: carbs != null ? Math.round(carbs * scale * 10) / 10 : 0,
        fat: fat != null ? Math.round(fat * scale * 10) / 10 : 0,
        micros: microsFromNutrients(fn, servingGrams),
      });
      if (results.length >= 15) break;
    }
    // Prefer deep data types first (Foundation/SR Legacy), then branded.
    const rank = { 'Foundation': 0, 'SR Legacy': 1, 'Survey (FNDDS)': 2, 'Branded': 3 };
    results.sort((a, b) => (rank[a.dataType] ?? 9) - (rank[b.dataType] ?? 9));

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).json({ results });
  } catch (e) {
    return res.status(502).json({ error: e?.message || 'USDA fetch failed' });
  }
}
