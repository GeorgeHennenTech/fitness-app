// Drop this at /api/recipe-suggest.js in your Vercel project.
// Requires ANTHROPIC_API_KEY in environment variables.
//
// Accepts: { pantry, expiringSoon, recipes, targets, recentMeals, avoid?, targetDate?, swapSlot? }
// Returns: { plan: { breakfast, lunch, dinner }, reasoning }

export const config = {
  api: {
    bodyParser: { sizeLimit: '1mb' },
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const {
    pantry = [],
    expiringSoon = [],
    recipes = [],
    targets = {},
    recentMeals = [],
    avoid = [],
    targetDate = '',
    swapSlot = null,
  } = req.body || {};

  if (!Array.isArray(recipes) || recipes.length === 0) {
    return res.status(400).json({ error: 'Missing recipe library' });
  }

  // Build a compact context block for the model. Keep it lean to save tokens.
  const pantryStr = pantry.length
    ? pantry.map((p) => `- ${p.name} (${p.category})${p.expiresAt ? ` [exp ${p.expiresAt}]` : ''}`).join('\n')
    : '(empty pantry)';

  const expiringStr = expiringSoon.length ? expiringSoon.join(', ') : 'none';
  const recentStr = recentMeals.length ? recentMeals.join(', ') : 'none recorded';
  const avoidStr = avoid.length ? avoid.join(', ') : 'none';

  const recipesStr = recipes
    .map((r) => {
      const ings = (r.ingredients || []).join(', ');
      const types = (r.mealType || []).join('/');
      return `- ${r.id} · "${r.name}" [${types}] · ${r.macros.cal}c ${r.macros.protein}p ${r.macros.carbs}c ${r.macros.fat}f · ${r.totalTime}min · serves ${r.servings} · uses: ${ings}`;
    })
    .join('\n');

  const swapInstruction = swapSlot
    ? `\nThis is a SWAP request — the user wants a new ${swapSlot} pick. Avoid the recipe IDs listed in "Avoid". Keep the other slots reasonable but you only NEED to change the ${swapSlot} slot in your response (still include all three slots in output).`
    : '';

  const systemPrompt = `You are a meal-planning assistant for a 23-year-old man in a recomposition phase (cut), targeting 200 lb at 10-11% body fat. He's 6'5", currently around 222 lb. He prioritizes high-protein, real-food meals.

Build a 3-meal day plan (breakfast, lunch, dinner) by picking recipe IDs from the provided recipe library. Your job is to:

1. PRIORITIZE recipes that use pantry items, especially expiring ones (waste minimization is a real value).
2. HIT the daily macro targets within roughly ±10%. Protein target is the most important.
3. AVOID repeating recipes the user ate in the last 2 days.
4. RESPECT meal-type tags — pick breakfast-tagged recipes for breakfast, etc.
5. Keep variety — don't pick three protein-shake-like meals; mix textures and food types.
6. Pick ONLY from the provided recipe IDs; don't invent new recipes.${swapInstruction}

Return ONLY valid JSON in this exact shape, no markdown fences, no other text:

{
  "breakfast": "recipe-id-here",
  "lunch": "recipe-id-here",
  "dinner": "recipe-id-here",
  "reasoning": "2-3 short sentences explaining the picks. Lead with the most important driver (expiring items, hitting macros, etc.)."
}`;

  const userPrompt = `Plan for ${targetDate || 'tomorrow'}.

Macro targets: ${targets.cal} cal · ${targets.protein}g protein · ${targets.carbs}g carbs · ${targets.fat}g fat

Pantry (${pantry.length} items in stock):
${pantryStr}

Expiring within 3 days: ${expiringStr}

Recently eaten (last 2 days): ${recentStr}

Avoid these recipe IDs: ${avoidStr}

Recipe library (pick from these IDs only):
${recipesStr}

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
        model: 'claude-opus-4-7',
        max_tokens: 1200,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return res.status(aiRes.status).json({ error: `Anthropic API: ${errText.slice(0, 400)}` });
    }

    const aiData = await aiRes.json();
    const text = aiData.content?.[0]?.text;
    if (!text) {
      return res.status(500).json({ error: 'Empty response from model' });
    }

    const cleaned = text
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();

    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      return res.status(500).json({ error: `Could not parse model response as JSON. First 200 chars: ${cleaned.slice(0, 200)}` });
    }

    // Validate that all three slots map to real recipe IDs from the library
    const validIds = new Set(recipes.map((r) => r.id));
    if (!validIds.has(parsed.breakfast) || !validIds.has(parsed.lunch) || !validIds.has(parsed.dinner)) {
      return res.status(500).json({
        error: 'AI returned recipe IDs not present in the library',
        got: { breakfast: parsed.breakfast, lunch: parsed.lunch, dinner: parsed.dinner },
      });
    }

    return res.status(200).json({
      plan: {
        breakfast: parsed.breakfast,
        lunch: parsed.lunch,
        dinner: parsed.dinner,
      },
      reasoning: parsed.reasoning || '',
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Unknown error' });
  }
}
