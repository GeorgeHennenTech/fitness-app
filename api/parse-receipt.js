// Drop this at /api/parse-receipt.js in your Vercel project.
// Requires ANTHROPIC_API_KEY in environment variables.
//
// Accepts: { base64: string, mimeType: string, isPdf?: boolean }
// Returns: { parsed: { store, date, total, items: [...], rawText? } }

export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const { base64, mimeType, isPdf } = req.body || {};
  if (!base64 || !mimeType) {
    return res.status(400).json({ error: 'Missing base64 or mimeType' });
  }

  const systemPrompt = `You are a receipt-parsing assistant. Extract structured data from a grocery / food / household receipt.

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
- For each item, classify into one of the listed categories
- If a price column shows discount/sale, use the final price paid
- Use lowercase for names and units
- Numbers must be numbers, not strings`;

  const content = isPdf
    ? [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64 },
        },
        { type: 'text', text: 'Parse this receipt and return JSON only.' },
      ]
    : [
        {
          type: 'image',
          source: { type: 'base64', media_type: mimeType, data: base64 },
        },
        { type: 'text', text: 'Parse this receipt and return JSON only.' },
      ];

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
        system: systemPrompt,
        messages: [{ role: 'user', content }],
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

    // The model is instructed to return JSON only, but trim any code fences just in case
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

    // Light validation / coercion before returning
    const items = Array.isArray(parsed.items) ? parsed.items.map((it) => ({
      name: String(it.name || '').toLowerCase().trim(),
      qty: parseFloat(it.qty) || 1,
      unit: String(it.unit || 'ea').toLowerCase().trim(),
      unitPrice: parseFloat(it.unitPrice) || 0,
      totalPrice: parseFloat(it.totalPrice) || 0,
      category: String(it.category || 'other').toLowerCase().trim(),
    })) : [];

    return res.status(200).json({
      parsed: {
        store: String(parsed.store || '').trim(),
        date: /^\d{4}-\d{2}-\d{2}$/.test(parsed.date) ? parsed.date : '',
        total: parseFloat(parsed.total) || items.reduce((s, i) => s + i.totalPrice, 0),
        items,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Unknown error' });
  }
}
