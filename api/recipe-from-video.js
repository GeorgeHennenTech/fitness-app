// Drop this at /api/recipe-from-video.js in your Vercel project.
// Requires ANTHROPIC_API_KEY in environment variables.
//
// Accepts: { url: "https://..." }
// Returns: { recipe, platform, url, extractedText }
//
// Pipeline:
//   1. Detect platform (YouTube / Instagram / TikTok) from URL
//   2. Extract text content:
//      - YouTube → auto-generated transcript via the player response JSON
//      - Instagram / TikTok → post caption via Open Graph / JSON-LD meta tags
//   3. Send extracted text to Anthropic for recipe parsing
//   4. Return the parsed recipe in the same shape as /api/parse-recipe

export const config = {
  api: {
    bodyParser: { sizeLimit: '1mb' },
  },
};

const YOUTUBE_REGEX = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/|youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/;
const INSTAGRAM_REGEX = /instagram\.com\/(?:p|reel|reels|tv)\/([a-zA-Z0-9_-]+)/;
const TIKTOK_REGEX = /tiktok\.com\/[^?]*video\/(\d+)|vm\.tiktok\.com\/([a-zA-Z0-9]+)/;

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function decodeHtmlEntities(str) {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#([0-9]+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

async function extractYouTubeTranscript(videoId) {
  // Fetch the watch page and extract `ytInitialPlayerResponse` JSON, which
  // contains caption track URLs. This is what the youtube-transcript library
  // does under the hood — doing it inline keeps the endpoint dependency-free.
  const pageRes = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: BROWSER_HEADERS,
  });
  if (!pageRes.ok) throw new Error(`YouTube page returned ${pageRes.status}`);
  const html = await pageRes.text();

  const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var|<\/script>)/);
  if (!playerMatch) throw new Error('Could not parse YouTube player response');

  let playerResponse;
  try {
    playerResponse = JSON.parse(playerMatch[1]);
  } catch (e) {
    throw new Error('YouTube player response was not valid JSON');
  }

  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || tracks.length === 0) {
    throw new Error('No transcript available for this video. The creator may have disabled captions.');
  }

  // Prefer English, then auto-generated English, then anything
  const track =
    tracks.find((t) => t.languageCode === 'en' && !t.kind) ||
    tracks.find((t) => t.languageCode === 'en') ||
    tracks.find((t) => t.languageCode?.startsWith('en')) ||
    tracks[0];

  const transcriptRes = await fetch(track.baseUrl);
  if (!transcriptRes.ok) throw new Error(`Transcript fetch returned ${transcriptRes.status}`);
  const xml = await transcriptRes.text();

  // Parse the XML transcript — basic regex pull of <text> tag contents
  const matches = [...xml.matchAll(/<text[^>]*>([^<]+)<\/text>/g)];
  const transcript = matches
    .map((m) => decodeHtmlEntities(m[1]))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Pull the title too, gives the AI more context
  const titleMatch = html.match(/<meta\s+name="title"\s+content="([^"]+)"/i);
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1]) : '';

  return { text: transcript, title, platform: 'youtube' };
}

async function extractCaptionFromHtml(url, platform) {
  const res = await fetch(url, { headers: BROWSER_HEADERS });
  if (!res.ok) throw new Error(`${platform} returned ${res.status}`);
  const html = await res.text();

  // Try JSON-LD first (most reliable when present)
  const ldMatches = [...html.matchAll(/<script\s+type="application\/ld\+json"[^>]*>([\s\S]+?)<\/script>/g)];
  for (const m of ldMatches) {
    try {
      const ld = JSON.parse(m[1]);
      const blocks = Array.isArray(ld) ? ld : [ld];
      for (const b of blocks) {
        const desc = b.description || b.caption || b.articleBody;
        if (typeof desc === 'string' && desc.length > 40) {
          const title = b.headline || b.name || '';
          return { text: desc, title, platform };
        }
      }
    } catch (e) {
      /* keep trying */
    }
  }

  // Fall back to og:description
  const ogDescMatch = html.match(/<meta\s+(?:property|name)="og:description"\s+content="([^"]+)"/i);
  if (ogDescMatch) {
    const text = decodeHtmlEntities(ogDescMatch[1]);
    if (text.length > 20) {
      const ogTitleMatch = html.match(/<meta\s+(?:property|name)="og:title"\s+content="([^"]+)"/i);
      const title = ogTitleMatch ? decodeHtmlEntities(ogTitleMatch[1]) : '';
      return { text, title, platform };
    }
  }

  // Last resort: try the standard description meta
  const descMatch = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
  if (descMatch) {
    const text = decodeHtmlEntities(descMatch[1]);
    if (text.length > 40) return { text, title: '', platform };
  }

  throw new Error(
    `Could not extract caption from ${platform}. The post may be private, deleted, or have no text caption (video-only Reels with no caption can't be parsed yet).`
  );
}

const RECIPE_SYSTEM_PROMPT = `You extract recipes from social-media content (YouTube transcripts, Instagram captions, TikTok captions). The input may be informal, conversational, contain timestamps, host banter, or filler.

Extract the recipe ONLY. Return STRICT JSON, no markdown fences, no commentary, in this exact shape:

{
  "name": "string",
  "servings": number,
  "totalTime": number,
  "difficulty": "easy" | "medium" | "hard",
  "mealType": ["breakfast" | "lunch" | "dinner" | "snack" | "post-workout"],
  "macros": { "cal": number, "protein": number, "carbs": number, "fat": number },
  "ingredients": [
    { "name": "string lowercase", "qty": number, "unit": "string lowercase", "primary": boolean }
  ],
  "instructions": ["Step 1", "Step 2", ...]
}

Rules:
- Ingredient names lowercase, no descriptors ("fresh boneless skinless chicken breast" → "chicken breast")
- Units lowercase (lb, oz, g, kg, ml, l, cup, tbsp, tsp, ea, clove, can, slice)
- 2-4 ingredients marked primary (main protein, main starch — not seasonings/oils/garnishes)
- Macros: honest estimate from quantities. If unclear, use reasonable averages.
- Instructions: clear numbered steps. Drop intro/outro filler ("hey everyone", "smash that subscribe").
- If quantities aren't explicit, infer reasonable defaults (e.g., "a chicken breast" ≈ 1 ea ~6 oz)
- If the input is NOT a recipe (e.g., a vlog, product review, food review of someone else's cooking with no recipe given), respond with: {"error": "not a recipe"}`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url required' });
  }

  // Detect platform and extract content
  let extracted;
  try {
    const ytMatch = url.match(YOUTUBE_REGEX);
    const igMatch = url.match(INSTAGRAM_REGEX);
    const tkMatch = url.match(TIKTOK_REGEX);

    if (ytMatch) {
      extracted = await extractYouTubeTranscript(ytMatch[1]);
    } else if (igMatch) {
      extracted = await extractCaptionFromHtml(url, 'instagram');
    } else if (tkMatch) {
      extracted = await extractCaptionFromHtml(url, 'tiktok');
    } else {
      return res.status(400).json({
        error: 'URL must be from YouTube, Instagram, or TikTok. For recipe blogs and other sites, use "Paste URL" instead.',
      });
    }
  } catch (e) {
    return res.status(502).json({ error: e?.message || 'Could not extract content from URL' });
  }

  if (!extracted.text || extracted.text.length < 20) {
    return res.status(400).json({
      error:
        extracted.platform === 'youtube'
          ? 'Transcript was empty. The video may have no captions.'
          : 'Could not find a recipe caption in this post. Video-only Reels with no caption text aren\'t supported yet.',
      extractedText: extracted.text || '',
      platform: extracted.platform,
    });
  }

  // Parse via Anthropic
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  try {
    const userContent =
      `Source: ${extracted.platform}` +
      (extracted.title ? `\nTitle: ${extracted.title}` : '') +
      `\n\nContent:\n${extracted.text.slice(0, 12000)}`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-8',
        max_tokens: 1800,
        system: RECIPE_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return res.status(aiRes.status).json({
        error: `Anthropic API: ${errText.slice(0, 400)}`,
        extractedText: extracted.text,
      });
    }

    const aiData = await aiRes.json();
    const text = aiData.content?.[0]?.text;
    if (!text) {
      return res.status(500).json({ error: 'Empty response from model', extractedText: extracted.text });
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
      return res.status(500).json({
        error: `Could not parse model response. First 200 chars: ${cleaned.slice(0, 200)}`,
        extractedText: extracted.text,
      });
    }

    if (parsed.error === 'not a recipe') {
      return res.status(400).json({
        error: 'This post does not appear to contain a recipe. Try a different video or use Paste text to enter it manually.',
        extractedText: extracted.text,
        platform: extracted.platform,
      });
    }

    return res.status(200).json({
      recipe: parsed,
      platform: extracted.platform,
      url,
      extractedText: extracted.text,
    });
  } catch (e) {
    return res.status(502).json({
      error: e?.message || 'AI parse failed',
      extractedText: extracted.text,
    });
  }
}
