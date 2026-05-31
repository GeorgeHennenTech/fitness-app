// Drop this at /api/weekly-review.js in your Vercel project.
// Add ANTHROPIC_API_KEY to your Vercel environment variables.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { weekStart, goals, workouts, nutrition, weights } = req.body || {};

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  }

  // Compress the data into a compact text summary for the model
  const lines = [];
  lines.push(`Week of ${weekStart}.`);
  if (goals) {
    lines.push(`Goals: target ${goals.target} lb at ${goals.bfTarget}% BF; weekly loss ${goals.weeklyLossMin}-${goals.weeklyLossMax} lb.`);
    if (goals.macros) {
      const m = goals.macros;
      lines.push(`Macros (lift/cardio/rest): cal ${m.lift?.cal}/${m.cardio?.cal}/${m.rest?.cal}; protein ${m.lift?.protein}/${m.cardio?.protein}/${m.rest?.protein}g.`);
    }
  }

  if (workouts?.length) {
    lines.push('\nWORKOUTS:');
    for (const w of workouts) {
      const completedCount = Object.values(w.completed || {}).filter(Boolean).length;
      const setsSummary = [];
      for (const ex in (w.sets || {})) {
        if (['scheduleDay', 'notes', 'completed'].includes(ex)) continue;
        const arr = w.sets[ex];
        if (!Array.isArray(arr)) continue;
        const logged = arr.filter(s => s.weight || s.reps);
        if (logged.length) {
          setsSummary.push(`${ex}: ${logged.map(s => `${s.weight || '?'}×${s.reps || '?'}`).join('/')}`);
        }
      }
      lines.push(`  ${w.date} (D${w.scheduleDay}, ${completedCount} done): ${setsSummary.join(' | ') || '(no sets logged)'}`);
    }
  } else {
    lines.push('\nWORKOUTS: none logged this week.');
  }

  if (nutrition?.length) {
    lines.push('\nNUTRITION (daily totals):');
    for (const n of nutrition) {
      lines.push(`  ${n.date}: ${Math.round(n.totals.cal)} cal, ${Math.round(n.totals.protein)}g protein, ${Math.round(n.totals.carbs)}g carbs, ${Math.round(n.totals.fat)}g fat`);
    }
  } else {
    lines.push('\nNUTRITION: nothing logged this week.');
  }

  if (weights?.length) {
    lines.push('\nWEIGHT:');
    for (const w of weights) {
      lines.push(`  ${w.date}: ${w.weight} lb${w.bf ? ` (${w.bf}% BF)` : ''}`);
    }
  }

  const dataDump = lines.join('\n');

  const systemPrompt = `You are a knowledgeable, honest fitness coach reviewing a lifter's week. The user is on a body recomposition cut targeting lean athletic 200lb @ 10-11% BF. Be direct, specific, and concise.

Write a 4-6 sentence weekly review. Cover:
1. What went well (1 sentence)
2. What's off-track or concerning (1-2 sentences, be honest)
3. The single most important adjustment for next week (1-2 sentences)
4. End with one short motivating line that's earned, not generic

Use plain text, no markdown. No greetings, no "Here's your review:" preamble. Use specific numbers from the data. If something is missing (e.g. no nutrition logged), call it out — don't pretend.`;

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
        max_tokens: 600,
        system: systemPrompt,
        messages: [{ role: 'user', content: dataDump }],
      }),
    });

    if (!aiRes.ok) {
      const errText = await aiRes.text();
      return res.status(aiRes.status).json({ error: `Anthropic API: ${errText}` });
    }

    const aiData = await aiRes.json();
    const text = aiData.content?.[0]?.text;
    if (!text) {
      return res.status(500).json({ error: 'Empty response from Claude' });
    }

    return res.status(200).json({ review: text });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Unknown error' });
  }
}
