// Drop this at /api/suggest-groceries.js in your Vercel project.
// Requires ANTHROPIC_API_KEY in environment variables.
//
// Suggests groceries based on the user's ACTUAL logged eating, along two
// grounded axes:
//   - gaps: target micronutrients they're consistently low on
//   - cost: protein/staples where a cheaper source would save money
//
// Accepts: {
//   nutrientAverages: { potassium: {avg, rdv, pctRdv}, ... },  // daily averages
//   loggedFoods: [{ name, timesLogged }],       // what they eat, most frequent first
//   proteinPerServingAvg: number|null,          // $ per ~30g protein, from price book/receipts
//   goals: string|null,
//   daysOfData: number
// }
// Returns: { suggestions: [{ name, category, axis, reason }] }

export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };

const CATEGORIES = ['protein', 'produce', 'dairy', 'carbs', 'snacks', 'supplements', 'beverages', 'household', 'alcohol', 'other'];

const SYSTEM_PROMPT = `You recommend groceries to a person based on their ACTUAL logged eating over the last couple of weeks. Every recommendation must be grounded in the data you're given — never generic "eat more salmon, it's healthy" advice. If the data doesn't justify a suggestion, don't make it.

You get:
- nutrientAverages: their average DAILY intake of tracked micronutrients vs the reference daily value, as a percentage. Below ~70% of the daily value, sustained, is a real gap worth addressing.
- loggedFoods: the foods they log most, so you know what they actually eat and buy — and can suggest things that fit, and avoid suggesting what they already eat.
- proteinPerServingAvg: roughly what they pay per protein serving, if known.
- goals: their stated goal (e.g. cutting at high protein).

Produce up to 6 suggestions across two axes:

"gap"  — a whole food that directly addresses a micronutrient they're low on. Name the nutrient and how low, and pick a food that's both a strong source AND plausibly fits how they already eat. Prefer foods that slot into their existing meals over exotic ones.

"cost" — only if proteinPerServingAvg suggests they're overpaying, OR their logged foods lean on expensive convenience items. Suggest a cheaper protein or staple that plays a similar role. Skip this axis entirely if there's no real saving to point to.

Rules:
- Ground EVERY reason in their specific numbers or logged foods. "You're averaging 45% of daily potassium and eat a lot of rice — a banana or a potato with dinner closes most of that gap."
- Do not suggest a food they already log frequently.
- Prefer whole, cheap, common ingredients. This is a grocery list, not a wellness catalog.
- Be honest about uncertainty when the data is thin — fewer, better suggestions beat padding.
- No medical claims or supplement megadosing. Food first.

Return STRICT JSON only, no markdown:
{
  "suggestions": [
    {
      "name": "lowercase grocery item",
      "category": "one of: ${CATEGORIES.join(', ')}",
      "axis": "gap" | "cost",
      "reason": "one sentence, citing their specific data"
    }
  ]
}
If the data is too thin to say anything grounded, return {"suggestions": []}.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { nutrientAverages, loggedFoods, proteinPerServingAvg, goals, daysOfData } = req.body || {};

  const payload = {
    daysOfData: daysOfData || 0,
    nutrientAverages: nutrientAverages || {},
    loggedFoods: Array.isArray(loggedFoods) ? loggedFoods.slice(0, 40) : [],
    proteinPerServingAvg: proteinPerServingAvg || null,
    goals: goals || 'not specified',
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
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Here is the person's data:\n${JSON.stringify(payload)}\n\nReturn grounded grocery suggestions as JSON.` }],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return res.status(aiRes.status).json({ error: `Anthropic API: ${errText.slice(0, 300)}` });
    }

    const aiData = await aiRes.json();
    const out = aiData.content?.[0]?.text;
    if (!out) return res.status(500).json({ error: 'Empty response from model' });

    const cleaned = out.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    let parsed;
    try { parsed = JSON.parse(cleaned); }
    catch (e) { return res.status(500).json({ error: `Could not parse response. First 200 chars: ${cleaned.slice(0, 200)}` }); }

    const suggestions = Array.isArray(parsed.suggestions)
      ? parsed.suggestions
          .map((s) => ({
            name: String(s.name || '').toLowerCase().trim(),
            category: CATEGORIES.includes(s.category) ? s.category : 'other',
            axis: s.axis === 'cost' ? 'cost' : 'gap',
            reason: String(s.reason || '').trim(),
          }))
          .filter((s) => s.name && s.reason)
          .slice(0, 6)
      : [];

    return res.status(200).json({ suggestions });
  } catch (e) {
    return res.status(502).json({ error: e?.message || 'Suggestion failed' });
  }
}
