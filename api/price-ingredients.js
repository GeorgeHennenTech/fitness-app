// Drop this at /api/price-ingredients.js in your Vercel project.
// Requires ANTHROPIC_API_KEY in environment variables.
//
// Accepts: { ingredients: ["chicken breast", "rolled oats", ...] }
// Returns: { prices: [{ name, perGram, perEach, refPrice, refQty, refUnit, note }] }
//
// Produces a REFERENCE price per ingredient — what a typical US grocery store
// charges — so a recipe can be fully costed even for items the user has never
// scanned a receipt for. These are estimates and the app labels them as such;
// a real receipt or a manually-entered price always takes precedence.

export const config = {
  api: {
    bodyParser: { sizeLimit: '1mb' },
  },
};

const SYSTEM_PROMPT = `You estimate typical US grocery prices for cooking ingredients, so a recipe app can approximate what a dish costs.

For each ingredient you receive, give the price of a normal package at a mainstream US supermarket (think Kroger/Safeway/Walmart store brand, national average, current year), then express it as a unit price.

Return STRICT JSON only — no markdown, no commentary:
{
  "prices": [
    {
      "name": "exactly the ingredient name you were given",
      "refPrice": number,        // price of one typical package, in dollars
      "refQty": number,          // size of that package
      "refUnit": "oz" | "lb" | "g" | "kg" | "ml" | "l" | "ea",
      "perGram": number,         // dollars per GRAM, or 0 if not weight-measurable
      "perEach": number,         // dollars per single item, or 0 if not sold by count
      "note": "short basis, under 8 words"
    }
  ]
}

Rules:
- Return one entry for EVERY ingredient given, in the same order, with the name copied exactly as provided.
- perGram must be dollars per gram — a small decimal. Example: chicken breast at $3.99/lb is 3.99/453.6 = 0.0088. Compute it carefully from refPrice and refQty; do not guess it independently.
- perEach applies to things bought as countable units (1 banana, 1 avocado, 1 egg). For a dozen eggs at $3.60, perEach is 0.30. Set perEach to 0 for things not sold by count (flour, oil, rice).
- Many ingredients support BOTH (a banana has a per-item price and a per-gram price). Fill both when both are sensible.
- For spices, extracts, and seasonings sold in small jars, price the jar realistically — these have a high per-gram cost and that is correct, not an error.
- For water, ice, or anything with no meaningful cost, set all prices to 0 and note "negligible".
- Be realistic and middle-of-the-road. Do not price premium organic unless the ingredient name says organic. Do not price bulk/wholesale.
- Round dollar values sensibly; perGram may need 4-5 decimal places.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { ingredients } = req.body || {};
  if (!Array.isArray(ingredients) || ingredients.length === 0) {
    return res.status(400).json({ error: 'ingredients array required' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const list = ingredients
    .map((s) => String(s || '').trim())
    .filter(Boolean)
    .slice(0, 60);

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
        messages: [
          { role: 'user', content: `Price these ingredients:\n${list.map((n) => `- ${n}`).join('\n')}\n\nReturn the JSON now.` },
        ],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return res.status(aiRes.status).json({ error: `Anthropic API: ${errText.slice(0, 300)}` });
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

    const num = (v) => {
      const n = parseFloat(v);
      return Number.isFinite(n) && n >= 0 ? n : 0;
    };

    const prices = Array.isArray(parsed.prices)
      ? parsed.prices
          .map((p) => ({
            name: String(p.name || '').trim(),
            refPrice: num(p.refPrice),
            refQty: num(p.refQty),
            refUnit: String(p.refUnit || '').trim(),
            perGram: num(p.perGram),
            perEach: num(p.perEach),
            note: String(p.note || '').trim(),
          }))
          .filter((p) => p.name)
      : [];

    if (prices.length === 0) {
      return res.status(500).json({ error: 'No prices returned. Try again.' });
    }

    return res.status(200).json({ prices });
  } catch (e) {
    return res.status(502).json({ error: e?.message || 'Pricing failed' });
  }
}
