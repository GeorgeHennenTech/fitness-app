// Drop this at /api/estimate-meal.js in your Vercel project (replaces the
// existing file). Requires ANTHROPIC_API_KEY in environment variables.
//
// Accepts ONE of:
//   { text: "Cava bowl with white rice, double chicken, hummus, ..." }
//   { base64, mimeType }  — a screenshot (restaurant app order, menu, a
//                           nutrition panel) or a photo of the meal
// Returns: { name, cal, protein, carbs, fat, note, confidence, items[], micros }
//
// SECOND MODE — micronutrient backfill (no new function; we're at Vercel's
// 12-function cap):
//   { mode: 'micros', foods: [{ id, name, serving?, servings?, cal?, protein?,
//                               carbs?, fat?, ingredients?: [{qty,unit,name}] }] }
//   → { results: { [id]: { fiber: 4.2, vitaminC: 31, ... } } }
//   Values are for ONE serving of each food (for a recipe: the whole ingredient
//   list divided by `servings`).
//
// items[] is the per-ingredient breakdown: each component with its estimated
// weight and its own macros. Totals are RECOMPUTED server-side as the sum of
// items, so the numbers the user sees always add up — that's the whole point
// of showing the breakdown.

export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
  },
};

// Micronutrients the AI is asked to estimate. Keys/units MUST match the app's
// MICRONUTRIENTS table. AI_MICROS is the core set returned with every meal
// estimate; the 'micros' fill mode also covers amino acids and carotenoids
// (AI_MICROS_ALL) so no nutrient is left untracked. The app marks every
// AI-supplied value as an estimate.
const AI_MICROS = [
  ['fiber','g'],['sugar','g'],['addedSugar','g'],['cholesterol','mg'],['caffeine','mg'],['choline','mg'],
  ['vitaminA','mcg RAE'],['vitaminC','mg'],['vitaminD','mcg'],['vitaminE','mg'],['vitaminK','mcg'],
  ['thiamin','mg'],['riboflavin','mg'],['niacin','mg'],['pantothenic','mg'],['vitaminB6','mg'],['folate','mcg DFE'],['vitaminB12','mcg'],
  ['calcium','mg'],['iron','mg'],['magnesium','mg'],['phosphorus','mg'],['potassium','mg'],['sodium','mg'],
  ['zinc','mg'],['copper','mg'],['manganese','mg'],['selenium','mcg'],
  ['satFat','g'],['monoFat','g'],['polyFat','g'],['transFat','g'],['omega3ALA','g'],['omega3EPA','g'],['omega3DHA','g'],
];
const MICRO_KEY_LIST = AI_MICROS.map(([k, u]) => `${k} (${u})`).join(', ');
const AI_MICROS_ALL = [
  ...AI_MICROS,
  ['histidine','g'],['isoleucine','g'],['leucine','g'],['lysine','g'],['methionine','g'],['phenylalanine','g'],
  ['threonine','g'],['tryptophan','g'],['valine','g'],['arginine','g'],['alanine','g'],['asparticAcid','g'],
  ['glutamicAcid','g'],['glycine','g'],['proline','g'],['serine','g'],['tyrosine','g'],['cystine','g'],
  ['betaCarotene','mcg'],['alphaCarotene','mcg'],['lycopene','mcg'],['luteinZea','mcg'],['betaCrypto','mcg'],
];
const MICRO_KEY_LIST_ALL = AI_MICROS_ALL.map(([k, u]) => `${k} (${u})`).join(', ');

function cleanMicros(obj, keys = AI_MICROS) {
  if (!obj || typeof obj !== 'object') return null;
  const out = {};
  for (const [k] of keys) {
    const v = parseFloat(obj[k]);
    if (isFinite(v) && v > 0) out[k] = +v.toFixed(3);
  }
  return Object.keys(out).length ? out : null;
}

const MICROS_PROMPT = `You estimate micronutrients for foods, meals and recipes, using standard food-composition data (USDA FoodData Central-style values) for each ingredient and summing them.

For EACH food you're given, return the amount in ONE serving:
- If it has an ingredient list, sum the micronutrients of every ingredient at the stated quantities, then divide by "servings" (default 1).
- Otherwise use the name, serving size and macros to identify the food and estimate a typical serving.

Keys and units (use exactly these keys; amounts in these units):
${MICRO_KEY_LIST_ALL}

Some foods come with "known": values already measured for that serving (from a database or label). Treat those as fact, use them to pin down what the food is and how big the serving is, and do NOT return those keys. Return every OTHER key.

Rules:
- Cover every key that isn't known. Amino acids: use the typical amino-acid profile of each protein source, scaled to the food's protein; all 18 amino acids together must not exceed the food's protein in grams. Carotenoids: typical values for the plant (or egg/dairy) ingredients; zero for foods with none.
- Numbers only. Omit a key (or use 0) when the food genuinely has none of it — e.g. no vitamin B12 in plant foods, no cholesterol in oils, caffeine only in coffee/tea/energy drinks/chocolate.
- Be realistic: sodium includes salt added in the recipe; account for cooking oils and sauces.
- Keep satFat + monoFat + polyFat + transFat at or below the food's total fat if fat is given.

Return STRICT JSON only, no markdown:
{ "results": { "<id>": { "<key>": number, ... }, ... } }
Include every id you were given.`;

const SYSTEM_PROMPT = `You estimate the nutrition of ONE meal/serving so it can be logged in a fitness tracker. Input is either a text description, a screenshot of a restaurant order / menu / nutrition panel, or a photo of food.

Your job is to show your work. Break the meal into its visible/stated components, estimate each one's weight, and give each one its own macros. The user will check your arithmetic — so the components must sum to the total.

Return STRICT JSON only — no markdown, no commentary — in this exact shape:
{
  "name": "short meal name",
  "items": [
    {
      "name": "component name",
      "grams": number,
      "portion": "human-readable portion, e.g. '~6 oz' or '1 cup cooked'",
      "cal": number,
      "protein": number,
      "carbs": number,
      "fat": number,
      "basis": "how you identified/sized it, under 8 words"
    }
  ],
  "cal": number,
  "protein": number,
  "carbs": number,
  "fat": number,
  "confidence": "high" | "medium" | "low",
  "note": "one short sentence on assumptions, or empty string",
  "micros": { "<key>": number }
}

Rules for items:
- Break the meal into the components a person would actually name: proteins, starches, vegetables, sauces/dressings, oils, cheese, toppings. Aim for 2-8 items. Don't split into spices or trivia.
- ALWAYS include cooking fats, oils, sauces and dressings as their own line if they're plausibly present. These are where hidden calories live and where a black-box estimate loses credibility.
- "grams" is your estimated cooked/as-served weight of that component. Be realistic about portion sizes — use visual cues in a photo (plate size, utensil scale, thickness) and stated sizes in text.
- Each item's macros are for the weight you stated, NOT per 100g.
- The top-level cal/protein/carbs/fat MUST equal the sum of the items. Add them up and check before answering.
- Calories for each item should roughly reconcile with its own macros (4/4/9 per g of protein/carb/fat).

Other rules:
- Estimate for the SINGLE serving/meal described (e.g. one Cava bowl as ordered), not the whole menu. Account for words like "double" or "extra".
- If a published nutrition panel is visible in an image, read the ACTUAL numbers rather than estimating. In that case return ONE item representing the product, with the panel's serving size and numbers, and set confidence to "high".
- "name": concise, e.g. "Cava chicken bowl" — don't dump the whole description.
- Round all macros to whole numbers.
- "confidence": "high" only for nutrition panels or precisely stated portions. "medium" for a clear photo of a recognizable dish. "low" when portions are ambiguous, food is obscured, or a sauce/oil quantity is a guess.
- If the person supplied context with specific amounts, base those items on it and let confidence reflect it.
- "note": briefly flag the biggest assumption ("assumed 1 tbsp oil in the pan"). Keep under 12 words. Empty string if genuinely confident.
- "micros": your estimate for the WHOLE meal (all items summed), using standard food-composition values per component. Keys and units: ${MICRO_KEY_LIST}. Omit keys that are essentially zero. If a nutrition panel is visible, use its stated values (sodium, fiber, sugar, etc.) where given.
- If the input clearly isn't food, return {"name":"","items":[],"cal":0,"protein":0,"carbs":0,"fat":0,"confidence":"low","note":"not a meal"}.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (req.body?.mode === 'micros') return handleMicros(req, res);

  const { text, base64, mimeType, afterBase64 } = req.body || {};
  // Before/after mode: a second photo of the plate once the person has finished.
  const beforeAfter = !!(base64 && afterBase64);
  if (!text && !base64) {
    return res.status(400).json({ error: 'text or image required' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  // Build the user message content — text, image, or both
  const content = [];
  if (beforeAfter) content.push({ type: 'text', text: 'Photo 1: the meal BEFORE eating.' });
  if (base64) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: mimeType === 'image/png' ? 'image/png' : 'image/jpeg',
        data: base64,
      },
    });
  }
  if (beforeAfter) {
    content.push({ type: 'text', text: 'Photo 2: the same plate AFTER eating, showing what was left.' });
    content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: afterBase64 } });
  }
  const ctx = text ? String(text).slice(0, 4000) : '';
  content.push({
    type: 'text',
    text: beforeAfter
      ? `Estimate the macros for what the person ACTUALLY ATE: the food in photo 1 minus whatever remains in photo 2. For each component, estimate how much was served, subtract what is left, and report only the eaten amount as that item's grams and macros. Leave out components that were not touched. Totals and micros must cover only what was eaten. In "note", say roughly how much was eaten (for example "ate about 70% of the rice, all the chicken"). If the two photos do not look like the same meal, estimate the full meal from photo 1 and say so in "note".${ctx ? `\n\nThe person added this context — treat it as authoritative where it states portions, ingredients or cooking fats:\n\n${ctx}` : ''}`
      : base64 && ctx
      ? `Estimate the macros for the meal shown in this image, broken down by component. The person added this context about it — treat it as authoritative where it states portions, ingredients, cooking fats, or how much was eaten, and use the image for everything it doesn't cover:\n\n${ctx}`
      : ctx
        ? `Estimate the macros for this meal, broken down by component:\n\n${ctx}`
        : 'Estimate the macros for the meal shown in this image, broken down by component. Identify each food you can see, estimate its weight, and give its macros.',
  });

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 3500,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return res.status(aiRes.status).json({ error: `Anthropic API: ${errText.slice(0, 400)}` });
    }

    const aiData = await aiRes.json();
    const out = replyText(aiData);
    if (!out) return res.status(500).json({ error: 'Empty response from model' });

    const cleaned = out
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();

    let parsed;
    try {
      parsed = parseLoose(cleaned);
    } catch (e) {
      return res.status(500).json({ error: `Could not parse model response. First 200 chars: ${cleaned.slice(0, 200)}` });
    }

    const n = (v) => Math.max(0, Math.round(parseFloat(v) || 0));

    const items = Array.isArray(parsed.items)
      ? parsed.items
          .map((i) => ({
            name: String(i.name || '').trim(),
            grams: n(i.grams),
            portion: String(i.portion || '').trim(),
            cal: n(i.cal),
            protein: n(i.protein),
            carbs: n(i.carbs),
            fat: n(i.fat),
            basis: String(i.basis || '').trim(),
          }))
          .filter((i) => i.name)
          .slice(0, 12)
      : [];

    // Totals are the sum of the breakdown so the displayed math always
    // reconciles. Fall back to the model's stated totals only if no items.
    const totals = items.length
      ? items.reduce(
          (acc, i) => ({
            cal: acc.cal + i.cal,
            protein: acc.protein + i.protein,
            carbs: acc.carbs + i.carbs,
            fat: acc.fat + i.fat,
          }),
          { cal: 0, protein: 0, carbs: 0, fat: 0 }
        )
      : { cal: n(parsed.cal), protein: n(parsed.protein), carbs: n(parsed.carbs), fat: n(parsed.fat) };

    const conf = ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium';

    // Range reflects how much the point estimate could plausibly be off, keyed
    // to confidence. High = no range (the number is trustworthy, e.g. a read
    // nutrition panel). Medium/low widen it. The app logs the midpoint (these
    // totals) and shows the range only at review so a guess doesn't read as fact.
    const SPREAD = { high: 0, medium: 0.12, low: 0.25 };
    const spread = SPREAD[conf];
    const range = spread > 0
      ? {
          cal:     [Math.round(totals.cal * (1 - spread)),     Math.round(totals.cal * (1 + spread))],
          protein: [Math.round(totals.protein * (1 - spread)), Math.round(totals.protein * (1 + spread))],
          carbs:   [Math.round(totals.carbs * (1 - spread)),   Math.round(totals.carbs * (1 + spread))],
          fat:     [Math.round(totals.fat * (1 - spread)),     Math.round(totals.fat * (1 + spread))],
        }
      : null;

    return res.status(200).json({
      name: String(parsed.name || '').trim(),
      cal: totals.cal,
      protein: totals.protein,
      carbs: totals.carbs,
      fat: totals.fat,
      confidence: conf,
      range, // null when high-confidence; otherwise [low, high] per macro
      note: String(parsed.note || '').trim(),
      items,
      micros: cleanMicros(parsed.micros), // whole-meal estimate, or null
    });
  } catch (e) {
    return res.status(502).json({ error: e?.message || 'Estimate failed' });
  }
}

// ── Micronutrient backfill ──────────────────────────────────────────────────
async function handleMicros(req, res) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }
  const foods = Array.isArray(req.body.foods) ? req.body.foods.slice(0, 6) : [];
  if (!foods.length) return res.status(400).json({ error: 'foods[] required' });

  const payload = foods.map((f) => ({
    id: String(f.id),
    name: String(f.name || '').slice(0, 200),
    ...(f.serving ? { serving: String(f.serving).slice(0, 80) } : {}),
    ...(f.servings ? { servings: +f.servings || 1 } : {}),
    ...(f.cal != null ? { cal: +f.cal || 0, protein: +f.protein || 0, carbs: +f.carbs || 0, fat: +f.fat || 0 } : {}),
    ...(cleanMicros(f.known, AI_MICROS_ALL) ? { known: cleanMicros(f.known, AI_MICROS_ALL) } : {}),
    ...(Array.isArray(f.ingredients) && f.ingredients.length
      ? { ingredients: f.ingredients.slice(0, 60).map((i) => `${i.qty ?? ''} ${i.unit ?? ''} ${i.name ?? ''}`.replace(/\s+/g, ' ').trim()) }
      : {}),
  }));

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 1700 * payload.length + 500,
        system: MICROS_PROMPT,
        messages: [{ role: 'user', content: `Foods:\n${JSON.stringify(payload)}\n\nReturn the JSON.` }],
      }),
    });
    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return res.status(aiRes.status).json({ error: `Anthropic API: ${errText.slice(0, 300)}` });
    }
    const aiData = await aiRes.json();
    const out = replyText(aiData) || '';
    const cleaned = out.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    let parsed;
    try { parsed = parseLoose(cleaned); }
    catch { return res.status(500).json({ error: `Could not parse response. First 200 chars: ${cleaned.slice(0, 200)}` }); }
    const results = {};
    for (const f of payload) {
      const m = cleanMicros(parsed?.results?.[f.id], AI_MICROS_ALL);
      if (!m) continue;
      // Measured values always win: drop anything the model returned for a known key.
      for (const k of Object.keys(f.known || {})) delete m[k];
      // Amino acids can't add up to more than the food's protein.
      if (f.protein > 0) {
        const AA = AI_MICROS_ALL.slice(AI_MICROS.length, AI_MICROS.length + 18).map(([k]) => k);
        const sum = AA.reduce((t, k) => t + (m[k] || 0), 0);
        if (sum > f.protein) for (const k of AA) if (m[k]) m[k] = +(m[k] * (f.protein / sum)).toFixed(3);
      }
      results[f.id] = m;
    }
    return res.status(200).json({ results });
  } catch (e) {
    return res.status(502).json({ error: e?.message || 'Micronutrient estimate failed' });
  }
}

// The reply's text, skipping any non-text blocks (models that think first put
// a thinking block ahead of the answer, so content[0] is not always the text).
function replyText(aiData) {
  return (aiData?.content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
    .trim();
}

// JSON.parse that tolerates a sentence or code fence around the JSON.
function parseLoose(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const s = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (s === -1 || end <= s) throw e;
    return JSON.parse(text.slice(s, end + 1));
  }
}
