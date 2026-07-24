// Drop this at /api/adjust-program.js in your Vercel project.
// Requires ANTHROPIC_API_KEY in environment variables.
//
// Accepts: { schedule, performance, volume, targets, inbody, goals }
//   schedule:    the active 1-7 day schedule object (same shape the app uses)
//   performance: per-exercise summary over the last ~28 days
//   volume:      { muscle: weeklySets } from the app's rolling 7-day counter
//   targets:     { muscle: {min,max} } weekly set targets
//   inbody:      { latest, first } key scan fields (may be null)
//   goals:       free-text goals note (may be null)
// Returns: { summary, changes: [...], proposedSchedule }

export const config = {
  api: {
    bodyParser: { sizeLimit: '2mb' },
  },
};

const SYSTEM_PROMPT = `You are an evidence-based strength coach reviewing one client's actual training data to propose the next training block. You are careful, conservative, and honest about uncertainty.

You will receive:
- Their CURRENT SCHEDULE: a JSON object with days 1-7, each { name, type, focus, duration, blocks: [{ name, exercises: [{ name, sets, reps, track }] }] }.
- PERFORMANCE: per-exercise data from the last ~28 days (sets completed, rep ranges, top/latest weights, completion rate).
- WEEKLY VOLUME vs TARGETS: working sets per muscle over the last 7 days against min-max set targets.
- INBODY data (may be partial): body composition trend and left/right segment balance.
- GOALS: the client's stated goals, if any.

Propose the next block. Rules:

1. BE CONSERVATIVE. Keep the overall split, day structure, and session count. This is an adjustment, not a rewrite. Change at most ~30% of the program.
2. Address UNDER-TARGET muscles first (redistribute or add sets), then OVER-TARGET recovery risks (trim sets), then stalled lifts (swap for a close variation or adjust rep range), then InBody imbalances (add a unilateral option).
3. Respect what's working: exercises with steady weight progression and high completion should not be touched.
4. Every change needs a rationale grounded in the provided data. Never invent data. If the data is too thin to justify a change (e.g. <2 weeks of logs), make fewer changes and say so in the summary.
5. Keep total weekly sets per muscle within the provided targets. Keep session durations similar (±10 min).
6. PRESERVE THE SCHEMA EXACTLY. proposedSchedule must have the same shape as the input schedule: days 1-7, same field names, exercises as { name, sets (number), reps (string), track (boolean) }. Keep 'track' flags from the original where the exercise is unchanged; new exercises: track=true for weighted lifts, false for stretches/timed holds.
7. Exercise names in changes must match proposedSchedule exactly.

Return ONLY valid JSON, no markdown fences, no commentary:

{
  "summary": "2-4 sentence plain-language overview of the block's intent and the data that drove it",
  "confidence": "high" | "medium" | "low",
  "changes": [
    {
      "day": number (1-7),
      "dayName": "string",
      "type": "add_sets" | "remove_sets" | "swap_exercise" | "add_exercise" | "remove_exercise" | "rep_range" | "note",
      "before": "string (what it was, e.g. 'Incline DB Press 3x8-10')",
      "after": "string (what it becomes, e.g. 'Incline DB Press 4x8-10')",
      "rationale": "string, 1-2 sentences citing the specific data"
    }
  ],
  "proposedSchedule": { ...full 1-7 schedule object... }
}`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { schedule, performance, volume, targets, inbody, goals } = req.body || {};
  if (!schedule || typeof schedule !== 'object') {
    return res.status(400).json({ error: 'Missing schedule' });
  }

  const userPrompt = `CURRENT SCHEDULE:
${JSON.stringify(schedule)}

PERFORMANCE (last ~28 days, per exercise):
${JSON.stringify(performance || [])}

WEEKLY VOLUME (working sets, last 7 days):
${JSON.stringify(volume || {})}

WEEKLY SET TARGETS per muscle:
${JSON.stringify(targets || {})}

INBODY:
${JSON.stringify(inbody || null)}

GOALS:
${goals || 'None provided.'}

Analyze this and propose the next block. Return the JSON now.`;

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-fable-5',
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userPrompt }],
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

    // Server-side sanity: proposedSchedule must have days 1-7 with blocks arrays.
    const ps = parsed.proposedSchedule;
    const validSchedule =
      ps && typeof ps === 'object' &&
      [1, 2, 3, 4, 5, 6, 7].every((d) => {
        const day = ps[d] || ps[String(d)];
        return day && typeof day.name === 'string' && Array.isArray(day.blocks);
      });
    if (!validSchedule) {
      return res.status(500).json({ error: 'Model returned an invalid proposedSchedule shape. Try again.' });
    }
    if (!Array.isArray(parsed.changes)) parsed.changes = [];

    return res.status(200).json({
      summary: parsed.summary || '',
      confidence: parsed.confidence || 'medium',
      changes: parsed.changes,
      proposedSchedule: ps,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Unknown error' });
  }
}
