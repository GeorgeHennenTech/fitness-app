// Drop this at /api/transform-recipe.js in your Vercel project.
// This REPLACES api-leanify-recipe.js — delete that file if you added it.
// Requires ANTHROPIC_API_KEY in environment variables.
//
// Accepts: { recipe, mode }   mode = "cut" | "bulk"
// Returns: { name, note, headroom, macros, ingredients, swaps }
//   Shaped to slot straight into the app's recipe `variants` array.
//
// One endpoint, two directions. Adding a future mode ("higher protein",
// "cheaper") means adding a MODE_GUIDANCE block, not another file.

export const config = {
  api: {
    bodyParser: { sizeLimit: '1mb' },
  },
};

const SHARED_RULES = `You will receive a recipe as JSON: { name, servings, ingredients: [{name, qty, unit}], instructions: [], macros: {cal, protein, carbs, fat} }.

Universal rules:
- KEEP THE SAME DISH. Same servings count, same basic method, recognizably the same food. This is a variant, not a different recipe.
- KEEP IT EDIBLE. Preserve seasonings, acid, aromatics, and texture. Never produce something bland or unpleasant to hit a macro target.
- BE HONEST IN MACROS. Estimate the new per-serving macros from the actual substituted ingredients. Do not invent flattering numbers.
- ASSESS HEADROOM FIRST. Before transforming, judge how much room this recipe actually has to move in the requested direction. If it is already far along that axis, say so plainly in "headroom" and make a smaller, sensible change rather than forcing a large one. Never pretend a change is bigger than it is, and never wreck a dish to hit an arbitrary number.

Return ONLY valid JSON, no markdown fences, no commentary:

{
  "name": "short version name",
  "note": "1-2 sentences on what changed and what to expect (taste/texture), plain language",
  "headroom": "one honest sentence about how much room this recipe had to move, e.g. 'Already lean — trimmed ~90 cal, not much further to go without losing the sauce.'",
  "macros": { "cal": number, "protein": number, "carbs": number, "fat": number },
  "ingredients": [ { "name": "string", "qty": number, "unit": "string" } ],
  "swaps": [ { "from": "original ingredient", "to": "replacement", "saves": "approx per-serving effect, e.g. '-90 cal' or '+140 cal'" } ]
}

"ingredients" must be the COMPLETE ingredient list for the new version (not just the changed ones), in the same {name, qty, unit} shape as the input, scaled to the same number of servings. "macros" are PER SERVING.`;

const MODE_GUIDANCE = {
  cut: `You are converting this recipe into a CUTTING version: same dish, same satisfaction, meaningfully fewer calories, with protein preserved or increased.

Direction-specific rules:
1. PROTECT PROTEIN. Never reduce total protein per serving; ideally raise it. Protein drives fullness and preserves muscle in a deficit — this is the whole point.
2. CUT CALORIE-DENSE ADD-INS FIRST — cooking oils and butter (use less, or a spray), heavy cream, full-fat cheese and dairy, mayo-based sauces, sugar, added nuts and oils in sauces. These are where the calories hide.
3. USE REAL SUBSTITUTIONS people actually make: fat-free Greek yogurt for sour cream/mayo/cream, leaner protein cuts (93/7 beef, chicken breast, turkey), reduced-fat or portion-reduced cheese, egg whites for some whole eggs, cauliflower rice or a smaller rice portion, broth or water to replace some oil, zero-calorie sweetener where sugar is only for sweetness.
4. ADD VOLUME with vegetables so the portion still looks and eats like a full meal.
5. A realistic cut is roughly 25-45% fewer calories. Not 80%.
6. Name it something like "Cut version".`,

  bulk: `You are converting this recipe into a BULKING version: same dish, meaningfully MORE calories, in a form a person can actually finish.

Direction-specific rules:
1. CALORIE DENSITY IS THE WHOLE PROBLEM. On a bulk, stomach volume is the binding constraint, not appetite for food in the abstract. Add calories that take up little space: olive oil, butter, nut butters, whole nuts and seeds, avocado, full-fat dairy, cheese, cream, coconut milk, dried fruit, granola, honey, maple syrup. Do NOT simply scale up the portion size — that produces a plate nobody can finish, which is the classic way bulking recipes fail.
2. RAISE PROTEIN TOO, not just fat and carbs. Extra protein sources, whole eggs instead of whites, whole milk or milk powder instead of water, a scoop of whey where it fits. A bulk version that is pure fat and sugar is a bad bulk version.
3. KEEP IT PALATABLE AND REPEATABLE. This is food someone eats several times a week, possibly with a suppressed appetite. Do not make it greasy, cloying, or heavy to the point of nausea. Richness should read as satisfying, not punishing.
4. PREFER ADDING/UPGRADING INGREDIENTS over increasing every quantity. Swapping water for whole milk, or adding two tablespoons of peanut butter, beats doubling the whole bowl.
5. A realistic bulk is roughly 30-60% more calories. Going much past that usually means an unfinishable portion.
6. Name it something like "Bulk version".`,
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { recipe, mode } = req.body || {};
  if (!recipe || typeof recipe !== 'object' || !recipe.name) {
    return res.status(400).json({ error: 'Missing recipe' });
  }
  const m = mode === 'bulk' ? 'bulk' : 'cut';
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const payload = {
    name: recipe.name,
    servings: recipe.servings,
    ingredients: recipe.ingredients || [],
    instructions: recipe.instructions || [],
    macros: recipe.macros || null,
  };

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
        max_tokens: 3000,
        system: `${MODE_GUIDANCE[m]}\n\n${SHARED_RULES}`,
        messages: [
          { role: 'user', content: `RECIPE:\n${JSON.stringify(payload)}\n\nProduce the ${m === 'bulk' ? 'bulking' : 'cutting'} version. Return the JSON now.` },
        ],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return res.status(aiRes.status).json({ error: `Anthropic API: ${errText.slice(0, 300)}` });
    }

    const aiData = await aiRes.json();
    const responseText = aiData.content?.[0]?.text;
    if (!responseText) return res.status(500).json({ error: 'Empty response from model' });

    const cleaned = responseText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return res.status(500).json({ error: `Could not parse model response. First 200 chars: ${cleaned.slice(0, 200)}` });
    }

    const mm = parsed.macros || {};
    const clean = {
      mode: m,
      name: String(parsed.name || (m === 'bulk' ? 'Bulk version' : 'Cut version')).slice(0, 40),
      note: String(parsed.note || ''),
      headroom: String(parsed.headroom || ''),
      macros: {
        cal: parseInt(mm.cal) || 0,
        protein: parseInt(mm.protein) || 0,
        carbs: parseInt(mm.carbs) || 0,
        fat: parseInt(mm.fat) || 0,
      },
      ingredients: Array.isArray(parsed.ingredients)
        ? parsed.ingredients
            .map((i) => ({
              name: String(i.name || '').trim(),
              qty: parseFloat(i.qty) || 1,
              unit: String(i.unit || 'ea').trim() || 'ea',
            }))
            .filter((i) => i.name)
        : [],
      swaps: Array.isArray(parsed.swaps)
        ? parsed.swaps.slice(0, 12).map((s) => ({
            from: String(s.from || ''),
            to: String(s.to || ''),
            saves: String(s.saves || ''),
          }))
        : [],
    };

    if (clean.ingredients.length === 0) {
      return res.status(500).json({ error: 'Model returned no ingredients. Try again.' });
    }

    return res.status(200).json(clean);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Unknown error' });
  }
}
