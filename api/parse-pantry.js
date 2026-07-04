// Drop this at /api/parse-pantry.js in your Vercel project.
// Requires ANTHROPIC_API_KEY in environment variables.
//
// Accepts: { base64, mimeType }  — a photo of grocery/pantry items
//          (e.g. a shelf of seasonings, a fridge drawer, a haul on the counter)
// Returns: { items: [{ name, category, qty, unit }] }
//
// Uses Claude vision to identify distinct food/pantry items in the photo. It is
// intentionally conservative: it only returns items it can actually see and
// name, and guesses a sensible category + quantity. The client shows the list
// for confirmation/editing before anything is written to the pantry.

export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
  },
};

const CATEGORIES = [
  'protein', 'produce', 'dairy', 'carbs', 'snacks',
  'supplements', 'beverages', 'household', 'alcohol', 'other',
];

const SYSTEM_PROMPT = `You identify distinct grocery / pantry items in a photo so they can be added to a kitchen inventory. The photo might show a spice rack, a fridge shelf, a pile of groceries on a counter, a freezer drawer, etc.

Return STRICT JSON only — no markdown, no commentary — in this exact shape:
{
  "items": [
    { "name": "string", "category": "one of the allowed categories", "qty": number, "unit": "string" }
  ]
}

Rules:
- One entry per DISTINCT item you can clearly see and name. If you see three different spice jars, return three entries.
- "name": the specific item, lowercase, no brand unless it's the only identifier (e.g. "garlic powder", "cumin", "sriracha", "frozen broccoli", "greek yogurt"). Don't invent details you can't see.
- "category": exactly one of: ${CATEGORIES.join(', ')}. Seasonings/spices/condiments → "other" unless clearly another category. Protein powder/vitamins → "supplements".
- "qty": how many of that item are visible (e.g. 2 identical jars → 2). Default 1 if unsure.
- "unit": a sensible container unit — "ea", "jar", "bottle", "box", "bag", "can", "container", "carton". Default "ea".
- If you can read a label clearly, use it. If a jar is unlabeled or you genuinely can't tell what it is, skip it rather than guessing wildly.
- Do NOT include non-food clutter (utensils, towels, the shelf itself).
- If the photo contains no identifiable food/pantry items, return {"items": []}.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { base64, mimeType } = req.body || {};
  if (!base64) {
    return res.status(400).json({ error: 'base64 image required' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

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
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mimeType === 'image/png' ? 'image/png' : 'image/jpeg',
                  data: base64,
                },
              },
              { type: 'text', text: 'Identify the pantry/grocery items in this photo.' },
            ],
          },
        ],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return res.status(aiRes.status).json({ error: `Anthropic API: ${errText.slice(0, 400)}` });
    }

    const aiData = await aiRes.json();
    const text = aiData.content?.[0]?.text;
    if (!text) return res.status(500).json({ error: 'Empty response from model' });

    const cleaned = text
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

    const items = Array.isArray(parsed.items)
      ? parsed.items
          .filter((it) => it && String(it.name || '').trim())
          .map((it) => ({
            name: String(it.name).trim().toLowerCase(),
            category: CATEGORIES.includes(it.category) ? it.category : 'other',
            qty: parseFloat(it.qty) > 0 ? parseFloat(it.qty) : 1,
            unit: String(it.unit || 'ea').trim() || 'ea',
          }))
      : [];

    return res.status(200).json({ items });
  } catch (e) {
    return res.status(502).json({ error: e?.message || 'Parse failed' });
  }
}
