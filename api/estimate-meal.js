// Drop this at /api/estimate-meal.js in your Vercel project.
// Requires ANTHROPIC_API_KEY in environment variables.
//
// Accepts ONE of:
//   { text: "Cava bowl with white rice, double chicken, hummus, ..." }
//   { base64, mimeType }  — a screenshot (restaurant app order, menu, a
//                           nutrition panel) or a photo of the meal
// Returns: { name, cal, protein, carbs, fat, note }
//
// Estimates the macros for a single meal/serving so it can prefill the
// "Log custom meal" form. The client shows the result for confirmation/edit
// before logging — so a reasonable estimate is the goal, not false precision.

export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
  },
};

const SYSTEM_PROMPT = `You estimate the nutrition of ONE meal/serving so it can be logged in a fitness tracker. Input is either a text description, a screenshot of a restaurant order / menu / nutrition panel, or a photo of food.

Return STRICT JSON only — no markdown, no commentary — in this exact shape:
{
  "name": "short meal name",
  "cal": number,
  "protein": number,
  "carbs": number,
  "fat": number,
  "note": "one short sentence on assumptions, or empty string"
}

Rules:
- Estimate for the SINGLE serving/meal described (e.g. one Cava bowl as ordered), not the whole menu.
- If the input lists specific components (e.g. "white rice, double chicken, hummus, pita"), sum them. Account for words like "double" or "extra".
- If a published nutrition panel is visible in an image, read the actual numbers rather than estimating — and use the serving size shown.
- "name": concise, e.g. "Cava chicken bowl" — don't dump the whole description.
- Round macros to whole numbers. Calories should roughly reconcile with macros (4/4/9 cal per g of protein/carb/fat).
- "note": briefly flag big assumptions ("assumed regular portion, no extra dressing") or leave "" if confident. Keep under 12 words.
- If the input clearly isn't food (random screenshot, etc.), return {"name":"","cal":0,"protein":0,"carbs":0,"fat":0,"note":"not a meal"}.`;

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
      ? `Estimate the macros for this meal:\n\n${String(text).slice(0, 4000)}`
      : 'Estimate the macros for the meal shown in this image.',
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
        max_tokens: 800,
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

    return res.status(200).json({
      name: String(parsed.name || '').trim(),
      cal: Math.max(0, Math.round(parseFloat(parsed.cal) || 0)),
      protein: Math.max(0, Math.round(parseFloat(parsed.protein) || 0)),
      carbs: Math.max(0, Math.round(parseFloat(parsed.carbs) || 0)),
      fat: Math.max(0, Math.round(parseFloat(parsed.fat) || 0)),
      note: String(parsed.note || '').trim(),
    });
  } catch (e) {
    return res.status(502).json({ error: e?.message || 'Estimate failed' });
  }
}
