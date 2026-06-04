// Drop this at /api/generate-recipes.js in your Vercel project.
// Requires ANTHROPIC_API_KEY in environment variables.
//
// Accepts: { pantry, expiringSoon, count?, mealType? }
// Returns: { recipes: [{ name, mealType, totalTime, difficulty, servings, macros, ingredients, instructions, rationale }] }

export const config = {
  api: {
    bodyParser: { sizeLimit: '1mb' },
  },
};

const SYSTEM_PROMPT = `You are a recipe inventor for a 23-year-old man in a recomposition phase (cut), 6'5", currently around 222 lb, targeting 200 lb at 10-11% body fat. He prioritizes high-protein, real-food meals.

You will receive a list of pantry items the user currently has, plus a list flagging items expiring soon. Your job: invent original recipe ideas that:

1. PRIORITIZE using items from the pantry. Expiring items get extra priority — waste minimization matters.
2. Use 4-10 ingredients per recipe. Assume basic pantry staples (salt, pepper, oil, basic spices) without listing them as primary ingredients.
3. Be HIGH PROTEIN. Aim for 30g+ protein per serving when the pantry supports it.
4. Use realistic, achievable techniques (stovetop, oven, sheet pan). No molecular gastronomy.
5. Have realistic macros. Estimate them honestly from the ingredient quantities.
6. Each recipe should be DIFFERENT from the others — vary the protein source, technique, and meal type.

Return ONLY valid JSON in this exact shape, no markdown fences, no commentary:

{
  "recipes": [
    {
      "name": "string (descriptive recipe name)",
      "mealType": ["breakfast" | "lunch" | "dinner" | "snack" | "post-workout"],
      "totalTime": number (prep + cook minutes),
      "difficulty": "easy" | "medium" | "hard",
      "servings": number,
      "macros": {
        "cal": number,
        "protein": number (grams),
        "carbs": number (grams),
        "fat": number (grams)
      },
      "ingredients": [
        {
          "name": "string (lowercase, ingredient only, no descriptors)",
          "qty": number,
          "unit": "string (lowercase: lb, oz, g, cup, tbsp, tsp, ea, clove, can)",
          "primary": boolean
        }
      ],
      "instructions": [
        "Step 1 instruction",
        "Step 2 instruction"
      ],
      "rationale": "string (one short sentence — why this recipe fits the pantry, especially expiring items)"
    }
  ]
}

Rules:
- 2-4 ingredients per recipe should be marked primary. The protein source and main starch are usually primary. Seasonings, garnishes, and oils are not.
- Ingredient names must be lowercase, lowercase units. Drop descriptors: "fresh boneless skinless chicken breast" → "chicken breast".
- Be honest about macros — calculate from ingredient quantities, don't fabricate impressive numbers.
- The rationale should explicitly mention which pantry items each recipe leverages, especially expiring ones.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const { pantry = [], expiringSoon = [], count = 3, mealType = null } = req.body || {};

  if (!Array.isArray(pantry) || pantry.length === 0) {
    return res.status(400).json({ error: 'Pantry is empty — cannot generate recipes' });
  }

  const pantryStr = pantry
    .map((p) => {
      const exp = p.expiresAt ? ` [exp ${p.expiresAt}]` : '';
      const qty = p.qty && p.unit ? ` (${p.qty} ${p.unit})` : '';
      return `- ${p.name} [${p.category}]${qty}${exp}`;
    })
    .join('\n');

  const expiringStr = expiringSoon.length > 0
    ? `Expiring within 3 days (use these first!):\n${expiringSoon.map((n) => `- ${n}`).join('\n')}`
    : 'No items expiring soon.';

  const mealTypeConstraint = mealType
    ? `\n\nAll recipes should be ${mealType} options.`
    : '';

  const userPrompt = `Pantry inventory (${pantry.length} items in stock):
${pantryStr}

${expiringStr}

Invent ${count} ORIGINAL recipe ideas using what's in this pantry. Each recipe should be distinct in protein source, technique, and meal type. Prioritize using expiring items.${mealTypeConstraint}

Return the JSON now.`;

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
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return res.status(aiRes.status).json({ error: `Anthropic API: ${errText.slice(0, 400)}` });
    }

    const aiData = await aiRes.json();
    const responseText = aiData.content?.[0]?.text;
    if (!responseText) {
      return res.status(500).json({ error: 'Empty response from model' });
    }

    const cleaned = responseText
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return res.status(500).json({
        error: `Could not parse model response as JSON. First 200 chars: ${cleaned.slice(0, 200)}`,
      });
    }

    if (!Array.isArray(parsed.recipes) || parsed.recipes.length === 0) {
      return res.status(500).json({ error: 'No recipes in response' });
    }

    return res.status(200).json({ recipes: parsed.recipes });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Unknown error' });
  }
}
