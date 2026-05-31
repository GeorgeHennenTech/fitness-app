// Drop this at /api/parse-recipe.js in your Vercel project.
// Requires ANTHROPIC_API_KEY in environment variables.
//
// Accepts ONE of:
//   { base64, mimeType, isPdf? }  — for image or PDF input
//   { url }                       — for a recipe webpage
//   { text }                      — for pasted recipe text
// Returns: { parsed: { name, mealType, totalTime, difficulty, servings, macros, ingredients, instructions } }

export const config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
  },
};

const SYSTEM_PROMPT = `You are a recipe-parsing assistant. Extract structured data from a recipe (photo of cookbook page, screenshot, PDF, webpage, or pasted text).

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
- 2-5 ingredients should be marked primary. The protein source and main starch are usually primary. Seasonings, garnishes, and oils are not primary.
- Instructions should be concise, action-oriented sentences. Don't number them in the strings — the array order is the sequence.
- If totalTime isn't given, estimate it from the steps.
- For difficulty: easy = <30min, no advanced technique. medium = 30-60min or some technique. hard = >60min or advanced.`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  const { base64, mimeType, isPdf, url, text } = req.body || {};

  let content;

  if (base64 && mimeType) {
    // Image or PDF input
    if (isPdf || mimeType === 'application/pdf') {
      content = [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } },
        { type: 'text', text: 'Extract this recipe and return the JSON.' },
      ];
    } else {
      content = [
        { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
        { type: 'text', text: 'Extract this recipe and return the JSON.' },
      ];
    }
  } else if (url) {
    // Fetch the URL server-side, send HTML/text to Claude
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
      // Strip scripts and styles — Claude doesn't need them and they bloat tokens
      const stripped = html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/\s+/g, ' ');
      // Truncate to ~30k chars to stay within reasonable token bounds
      const truncated = stripped.slice(0, 30000);
      content = [
        {
          type: 'text',
          text: `Extract the recipe from this webpage at ${url}. HTML content follows:\n\n${truncated}\n\nReturn the JSON.`,
        },
      ];
    } catch (e) {
      return res.status(500).json({ error: `URL fetch failed: ${e.message}` });
    }
  } else if (text) {
    content = [
      { type: 'text', text: `Extract the recipe from this text:\n\n${String(text).slice(0, 20000)}\n\nReturn the JSON.` },
    ];
  } else {
    return res.status(400).json({ error: 'Must provide one of: base64+mimeType, url, or text' });
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
        model: 'claude-opus-4-7',
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
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

    return res.status(200).json({ parsed });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Unknown error' });
  }
}
