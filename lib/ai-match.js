/**
 * DeepSeek AI adjudication between Brreg candidates.
 */

const path = require('path');

let envLoaded = false;

function loadEnv() {
  if (envLoaded) return;
  try {
    require('dotenv').config({ path: path.join(process.cwd(), '.env.local') });
    require('dotenv').config();
  } catch {
    // dotenv optional at require time
  }
  envLoaded = true;
}

function compactMaps(maps) {
  return {
    name: maps.name,
    address: [maps.street, maps.houseNumber, maps.houseLetter].filter(Boolean).join(' '),
    postcode: maps.postcode,
    phone: maps.phone || undefined,
  };
}

function compactCandidate(c, score) {
  return {
    orgnr: c.orgnr,
    navn: c.navn,
    type: c.type,
    address: c.rawAddressLine,
    postnummer: c.postnummer,
    score,
  };
}

async function adjudicateWithDeepSeek(maps, scoredCandidates, options = {}) {
  loadEnv();
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY not set in .env.local');
  }

  const top = scoredCandidates.slice(0, options.maxCandidates || 10);
  if (top.length === 0) {
    return { best_orgnr: null, confidence: 0, reasoning: 'No candidates' };
  }

  if (top.length === 1) {
    return {
      best_orgnr: top[0].candidate.orgnr,
      confidence: Math.min(95, top[0].total),
      reasoning: 'Single candidate',
    };
  }

  const systemPrompt =
    'Match Google Maps listing to Norwegian Brreg candidates. ' +
    'Strongly prefer the legal entity physically at the same street address and postcode as Google Maps (underenhet if present). ' +
    'The Google trading name often differs from Brreg (e.g. café name vs foundation/landlord AS). ' +
    'Return JSON only: {"best_orgnr":"9 digits or null","confidence":0-100}';

  const userPayload = {
    google_maps: compactMaps(maps),
    candidates: top.map((s) => compactCandidate(s.candidate, s.total)),
  };

  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: JSON.stringify(userPayload),
        },
      ],
      temperature: 0.1,
      response_format: { type: 'json_object' },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`DeepSeek API ${res.status}: ${errText.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
  }

  let best_orgnr = parsed.best_orgnr ? String(parsed.best_orgnr).replace(/\D/g, '') : null;
  let confidence = Number(parsed.confidence) || 0;

  if (!best_orgnr && top.length > 0) {
    const byScore = [...top].sort((a, b) => b.total - a.total);
    const lead = byScore[0];
    if (lead.nameSimilarity >= 0.55 && lead.total >= 40) {
      best_orgnr = lead.candidate.orgnr;
      confidence = Math.max(confidence, Math.min(85, lead.total));
    } else if (
      lead.breakdown?.address >= 35 &&
      (lead.addressExact || lead.addressSameStreet) &&
      lead.total >= 38
    ) {
      best_orgnr = lead.candidate.orgnr;
      confidence = Math.max(confidence, Math.min(80, lead.total));
    }
  }

  return {
    best_orgnr,
    confidence,
    reasoning: parsed.reasoning || '',
  };
}

module.exports = {
  adjudicateWithDeepSeek,
  loadEnv,
};
