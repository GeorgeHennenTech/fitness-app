// Drop this at /api/parse.js in your Vercel project.
// Requires ANTHROPIC_API_KEY in environment variables.
//
// REPLACES three endpoints: parse-pantry.js, parse-receipt.js, parse-recipe.js
// Delete those three files after deploying this one.
//
// They were structurally identical — take text or an image, send it to Claude
// with a system prompt, parse JSON back — and differed only in the prompt and
// output schema. Merging them into one function frees two slots against
// Vercel's 12-function Hobby cap.
//
// Accepts: { kind, ...payload }
//   kind: "pantry" | "receipt" | "recipe"
//   payload (varies by kind):
//     pantry:  { base64, mimeType }
//     receipt: { base64, mimeType, isPdf? }
//     recipe:  { base64, mimeType, isPdf? } | { url } | { text }
//
// Response shapes are UNCHANGED from the originals, so the client contract is
// identical apart from the URL and the added `kind` field:
//   pantry  → { items: [...] }
//   receipt → { parsed: { store, date, total, items: [...] } }
//   recipe  → { parsed: {...} }

export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
  },
};

const CATEGORIES = [
  'protein', 'produce', 'dairy', 'carbs', 'snacks',
  'supplements', 'beverages', 'household', 'alcohol', 'other',
];

// ── Prompts ─────────────────────────────────────────────────────────────────

const PANTRY_PROMPT = `You identify distinct grocery / pantry items in a photo so they can be added to a kitchen inventory. The photo might show a spice rack, a fridge shelf, a pile of groceries on a counter, a freezer drawer, etc.

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

const RECEIPT_PROMPT = `You are a receipt-parsing assistant. Extract structured data from a grocery / food / household receipt.

Return ONLY valid JSON in this exact shape, no other text, no markdown fences:

{
  "store": "string (e.g. 'Trader Joe's')",
  "date": "YYYY-MM-DD or empty string",
  "total": number,
  "items": [
    {
      "name": "string (lowercase, product name only, no SKU or codes)",
      "qty": number,
      "unit": "lb | oz | g | kg | ea | gal | l | ml | pk | doz",
      "unitPrice": number,
      "totalPrice": number,
      "category": "protein | produce | dairy | carbs | snacks | supplements | beverages | household | alcohol | other"
    }
  ]
}

Rules:
- Skip tax, subtotal, total, discount lines from items
- For bulk-priced items like "BANANAS 2.3 LB @ 0.59/LB", emit qty=2.3, unit="lb", unitPrice=0.59
- For pack items like "EGGS 12CT", emit qty=1, unit="doz" if 12, otherwise "pk"
- IMPORTANT — record the item's REAL PACKAGE SIZE, not 1. A 32 oz tub of yogurt is qty=32, unit="oz", NOT qty=1. Getting this wrong makes the per-unit price wildly high and breaks recipe costing downstream. If the size is printed on the line, use it; if it isn't, use the count actually purchased.
- For each item, classify into one of the listed categories
- If a price column shows discount/sale, use the final price paid
- Use lowercase for names and units
- Numbers must be numbers, not strings`;

const RECIPE_PROMPT = `You are a recipe-parsing assistant. Extract structured data from a recipe (photo of cookbook page, screenshot, PDF, webpage, or pasted text).

Return ONLY valid JSON in this exact shape, no markdown fences, no commentary:

{
  "name": "string (recipe title)",
  "mealType": ["breakfast" | "lunch" | "dinner" | "snack" | "post-workout"],
  "totalTime": number (total minutes including prep + cook),
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
      "name": "string (lowercase, ingredient only, no descriptors like 'fresh' or 'large')",
      "qty": number,
      "unit": "string (lowercase: lb, oz, g, kg, cup, tbsp, tsp, ea, clove, can, etc)",
      "primary": boolean (true if this is a defining ingredient — main protein, base starch — false for garnishes/seasonings)
    }
  ],
  "instructions": [
    "Step 1 instruction as a single string",
    "Step 2 instruction"
  ]
}

Rules:
- If macros aren't shown in the source, ESTIMATE them based on ingredients. Be realistic — chicken breast is ~25g protein per 4oz.
- mealType is an array — most recipes fit one or two categories.
- For ingredient names, drop descriptors: "fresh boneless skinless chicken breast" → "chicken breast".
- Use lowercase for ingredient names and units.
- Do NOT emit the same ingredient twice. If it appears in multiple steps, combine into one entry with the total quantity.
- 2-5 ingredients should be marked primary. The protein source and main starch are usually primary. Seasonings, garnishes, and oils are not primary.
- Instructions should be concise, action-oriented sentences. Don't number them in the strings — the array order is the sequence.
- If totalTime isn't given, estimate it from the steps.
- For difficulty: easy = <30min, no advanced technique. medium = 30-60min or some technique. hard = >60min or advanced.`;

const KINDS = {
  pantry:  { prompt: PANTRY_PROMPT,  maxTokens: 2000, ask: 'Identify the pantry/grocery items in this photo.' },
  receipt: { prompt: RECEIPT_PROMPT, maxTokens: 4000, ask: 'Parse this receipt and return JSON only.' },
  recipe:  { prompt: RECIPE_PROMPT,  maxTokens: 4000, ask: 'Extract this recipe and return the JSON.' },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const { kind, base64, mimeType, isPdf, url, text } = req.body || {};
  const cfg = KINDS[kind];
  if (!cfg) {
    return res.status(400).json({ error: `Unknown kind "${kind}". Expected one of: ${Object.keys(KINDS).join(', ')}` });
  }

  // ── Build the message content ─────────────────────────────────────────────
  let content;
  if (base64 && (mimeType || isPdf)) {
    if (isPdf || mimeType === 'application/pdf') {
      content = [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: cfg.ask },
      ];
    } else {
      content = [
        {
          type: 'image',
          source: {
            type: 'base64',
            // pantry historically normalized to png/jpeg; other kinds pass through
            media_type: kind === 'pantry'
              ? (mimeType === 'image/png' ? 'image/png' : 'image/jpeg')
              : mimeType,
            data: base64,
          },
        },
        { type: 'text', text: cfg.ask },
      ];
    }
  } else if (url && kind === 'recipe') {
    // Fetch the page server-side and hand Claude the stripped HTML.
    try {
      const fetchRes = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; RecipeBot/1.0)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        redirect: 'follow',
      });
      if (!fetchRes.ok) {
        return res.status(400).json({ error: `Could not fetch URL: ${fetchRes.status}` });
      }
      const html = await fetchRes.text();
      const stripped = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\s+/g, ' ');
      content = [
        { type: 'text', text: `Extract the recipe from this webpage at ${url}. HTML content follows:\n\n${stripped.slice(0, 30000)}\n\nReturn the JSON.` },
      ];
    } catch (e) {
      return res.status(500).json({ error: `URL fetch failed: ${e.message}` });
    }
  } else if (text) {
    content = [{ type: 'text', text: `${cfg.ask}\n\n${String(text).slice(0, 20000)}` }];
  } else {
    return res.status(400).json({ error: 'Must provide one of: base64+mimeType, url (recipe only), or text' });
  }

  // ── Call the model ────────────────────────────────────────────────────────
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
        max_tokens: cfg.maxTokens,
        system: cfg.prompt,
        messages: [{ role: 'user', content }],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return res.status(aiRes.status).json({ error: `Anthropic API: ${errText.slice(0, 400)}` });
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
      return res.status(500).json({ error: `Could not parse model response as JSON. First 200 chars: ${cleaned.slice(0, 200)}` });
    }

    // ── Coerce per kind, preserving each original's response shape ───────────
    if (kind === 'pantry') {
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
    }

    if (kind === 'receipt') {
      const items = Array.isArray(parsed.items)
        ? parsed.items.map((it) => ({
            name: String(it.name || '').toLowerCase().trim(),
            qty: parseFloat(it.qty) || 1,
            unit: String(it.unit || 'ea').toLowerCase().trim(),
            unitPrice: parseFloat(it.unitPrice) || 0,
            totalPrice: parseFloat(it.totalPrice) || 0,
            category: String(it.category || 'other').toLowerCase().trim(),
          }))
        : [];
      return res.status(200).json({
        parsed: {
          store: String(parsed.store || '').trim(),
          date: /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : '',
          total: parseFloat(parsed.total) || items.reduce((s, i) => s + i.totalPrice, 0),
          items,
        },
      });
    }

    // recipe — returned as-is, same as before
    return res.status(200).json({ parsed });
  } catch (e) {
    return res.status(502).json({ error: e?.message || 'Parse failed' });
  }
}
