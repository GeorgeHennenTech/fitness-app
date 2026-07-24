// Drop this at /api/estimate-meal.js in your Vercel project (replaces the
// existing file). Requires ANTHROPIC_API_KEY in environment variables.
//
// Accepts ONE of:
//   { text: "Cava bowl with white rice, double chicken, hummus, ..." }
//   { base64, mimeType }  — a screenshot (restaurant app order, menu, a
//                           nutrition panel) or a photo of the meal
// Returns: { name, cal, protein, carbs, fat, note, confidence, items[] }
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
  "note": "one short sentence on assumptions, or empty string"
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
- "note": briefly flag the biggest assumption ("assumed 1 tbsp oil in the pan"). Keep under 12 words. Empty string if genuinely confident.
- If the input clearly isn't food, return {"name":"","items":[],"cal":0,"protein":0,"carbs":0,"fat":0,"confidence":"low","note":"not a meal"}.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { text, base64, mimeType } = req.body || {};
  if (!text && !base64) {
    return res.status(400).json({ error: 'text or image required' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  // Build the user message content — text, image, or both
  const content = [];
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
  content.push({
    type: 'text',
    text: text
      ? `Estimate the macros for this meal, broken down by component:\n\n${String(text).slice(0, 4000)}`
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
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return res.status(aiRes.status).json({ error: `Anthropic API: ${errText.slice(0, 400)}` });
    }

    const aiData = await aiRes.json();
    const out = aiData.content?.[0]?.text;
    if (!out) return res.status(500).json({ error: 'Empty response from model' });

    const cleaned = out
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

    return res.status(200).json({
      name: String(parsed.name || '').trim(),
      cal: totals.cal,
      protein: totals.protein,
      carbs: totals.carbs,
      fat: totals.fat,
      confidence: conf,
      note: String(parsed.note || '').trim(),
      items,
    });
  } catch (e) {
    return res.status(502).json({ error: e?.message || 'Estimate failed' });
  }
}
