/**
 * Local scoring: Maps record vs Brreg candidate (max 100).
 */

const {
  addressKeysExact,
  normalizePhone,
  nameSimilarityScore,
  significantNameTokens,
  tokenMatches,
} = require('./normalize');

const LEGAL_SUFFIXES = new Set(['as', 'asa', 'ans', 'da', 'enk', 'nuf', 'sa', 'ba']);

function scoreAddress(maps, candidate) {
  const exact = addressKeysExact(maps.addressKey, candidate.addressKey);
  if (exact) return { points: 45, exact: true, sameStreet: true };

  const parts = candidate.addressKey.split('|');
  const candStreet = parts[0];
  const candPost = parts[3];
  const mapsParts = maps.addressKey.split('|');
  const streetMatch = mapsParts[0] && mapsParts[0] === candStreet;
  const postMatch = maps.postcode && maps.postcode === candPost;

  if (streetMatch && postMatch) {
    const mapsNum = mapsParts[1];
    const candNum = parts[1];
    if (mapsNum && candNum && mapsNum === candNum) {
      const mapsLet = mapsParts[2];
      const candLet = parts[2];
      if (mapsLet === candLet) return { points: 40, exact: false, sameStreet: true };
      return { points: 35, exact: false, sameStreet: true };
    }
    return { points: 30, exact: false, sameStreet: true };
  }

  if (postMatch && maps.postcode) {
    return { points: 18, exact: false, sameStreet: false };
  }

  if (candidate.foundViaNationalNameSearch && maps.postcode) {
    return { points: 8, exact: false, sameStreet: false };
  }

  return { points: 0, exact: false, sameStreet: false };
}

function scoreName(mapsName, candidateName) {
  const sim = nameSimilarityScore(mapsName, candidateName);
  if (sim >= 1) return 35;
  if (sim >= 0.85) return Math.round(30 + (sim - 0.85) * 33);
  if (sim >= 0.65) return Math.round(22 + (sim - 0.65) * 40);
  if (sim >= 0.45) return Math.round(14 + (sim - 0.45) * 40);

  const a = mapsName.toLowerCase().split(/\s+/).filter((w) => w.length > 1 && !LEGAL_SUFFIXES.has(w));
  const b = candidateName.toLowerCase().split(/\s+/).filter((w) => w.length > 1 && !LEGAL_SUFFIXES.has(w));
  if (a.length && b.length) {
    const overlap = a.filter((w) => b.some((x) => tokenMatches(w, x)));
    if (overlap.length >= 1) {
      return Math.round(8 + overlap.length * 5);
    }
  }

  return Math.round(sim * 12);
}

function scorePhone(mapsPhone, candidate) {
  if (candidate.phoneMatch) return 15;
  const m = normalizePhone(mapsPhone);
  if (!m || m.length < 8) return 0;
  const c1 = normalizePhone(candidate.phone);
  const c2 = normalizePhone(candidate.mobil);
  if (m === c1 || m === c2) return 15;
  if ((c1 && (c1.includes(m) || m.includes(c1))) || (c2 && (c2.includes(m) || m.includes(c2)))) {
    return 8;
  }
  return 0;
}

function scoreCategory(mapsCategory, candidate) {
  if (!mapsCategory || !candidate.naceBeskrivelse) return 0;
  const words = mapsCategory
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 3);
  const nace = candidate.naceBeskrivelse.toLowerCase();
  let hits = 0;
  for (const w of words) {
    if (nace.includes(w)) hits += 1;
  }
  if (hits >= 2) return 5;
  if (hits === 1) return 3;
  return 0;
}

function scoreSearchBonus(candidate) {
  let bonus = 0;
  if (candidate.foundViaNameSearch) bonus += 2;
  if (candidate.foundViaNationalNameSearch) bonus += 1;
  if (candidate.foundViaAddressSearch) bonus += 2;
  return Math.min(5, bonus);
}

function hasStrongLocalAddressCandidate(scored) {
  return scored.some(
    (s) =>
      s.addressExact ||
      (s.addressSameStreet && s.breakdown.address >= 30 && s.nameSimilarity >= 0.4)
  );
}

function scoreCandidate(maps, candidate, opts = {}) {
  const addr = scoreAddress(maps, candidate);
  let namePts = scoreName(maps.name, candidate.navn);

  // Only penalize distant national name hits when a plausible local address match exists
  if (
    opts.penalizeNationalOnly !== false &&
    maps.houseNumber &&
    candidate.foundViaNationalNameSearch &&
    !candidate.foundViaAddressSearch
  ) {
    namePts = Math.round(namePts * 0.62);
  }

  const phonePts = scorePhone(maps.phone, candidate);
  const catPts = scoreCategory(maps.category, candidate);
  const searchBonus = scoreSearchBonus(candidate);

  const total = Math.min(
    100,
    addr.points + namePts + phonePts + catPts + searchBonus
  );
  const nameSim = nameSimilarityScore(maps.name, candidate.navn);

  return {
    total,
    breakdown: {
      address: addr.points,
      name: namePts,
      phone: phonePts,
      category: catPts,
      searchBonus,
    },
    addressExact: addr.exact,
    addressSameStreet: addr.sameStreet,
    nameSimilarity: nameSim,
  };
}

/** Prefer exact location over distant name matches (e.g. Kafé Perrongen vs another city). */
function addressPriorityRank(scored) {
  if (scored.addressExact) return 5;
  if (scored.addressSameStreet && scored.breakdown.address >= 35) return 4;
  if (scored.addressSameStreet && scored.breakdown.address >= 30) return 3;
  if (scored.breakdown.address >= 18) return 2;
  const c = scored.candidate;
  if (c.foundViaAddressSearch && scored.breakdown.address > 0) return 2;
  if (c.foundViaNationalNameSearch && !c.foundViaAddressSearch) return 0;
  return 1;
}

function compareByTotalScore(a, b) {
  if (b.total !== a.total) return b.total - a.total;
  if (b.nameSimilarity !== a.nameSimilarity) return b.nameSimilarity - a.nameSimilarity;
  if (a.candidate.type === 'underenhet' && b.candidate.type !== 'underenhet') return -1;
  return 0;
}

function compareByAddressPriority(a, b) {
  const pra = addressPriorityRank(a);
  const prb = addressPriorityRank(b);
  if (prb !== pra) return prb - pra;
  return compareByTotalScore(a, b);
}

function scoreAllCandidates(maps, candidates) {
  const raw = candidates.map((c) => ({
    candidate: c,
    _mapsName: maps.name,
    ...scoreCandidate(maps, c),
  }));

  const penalizeNationalOnly = hasStrongLocalAddressCandidate(raw);
  if (penalizeNationalOnly) {
    for (const s of raw) {
      Object.assign(s, {
        _mapsName: maps.name,
        ...scoreCandidate(maps, s.candidate, { penalizeNationalOnly: true }),
      });
    }
  }

  const byTotal = [...raw].sort(compareByTotalScore);
  const byAddress = [...raw].sort(compareByAddressPriority);

  return {
    all: raw,
    byTotal,
    byAddress,
    best: byTotal[0] || null,
  };
}

/** Merge top total-scorers with top address-scorers for AI (coverage + location quality). */
function candidatesForAiHybrid(scoredResult) {
  const { byTotal, byAddress } = scoredResult;
  const seen = new Set();
  const merged = [];

  for (const s of [...byAddress.slice(0, 5), ...byTotal.slice(0, AI_CANDIDATE_MAX)]) {
    const id = s.candidate.orgnr;
    if (seen.has(id)) continue;
    if (s.total < MATCH_FLOOR) continue;
    seen.add(id);
    merged.push(s);
    if (merged.length >= AI_CANDIDATE_MAX) break;
  }

  if (merged.length === 0 && byTotal[0]?.total >= MATCH_FLOOR) {
    return byTotal.slice(0, AI_CANDIDATE_MAX);
  }
  return merged;
}

function classifyBand(score) {
  if (score >= 90) return 'confirmed';
  if (score >= 75) return 'probable';
  if (score >= 40) return 'review';
  return 'no_match';
}

const TIER1_MIN_NAME_SIM = 0.72;
const AI_MIN_CONFIDENCE = 50;
const AI_CANDIDATE_MAX = 8;
const MATCH_FLOOR = 32;

function multiTokenNameOk(mapsName, candidateName) {
  const wordsA = significantNameTokens(mapsName);
  if (wordsA.length <= 1) return true;
  const tokens = (candidateName || '').toLowerCase().split(/\s+/);
  const realHits = wordsA.filter((w) => {
    if (w.length < 4) return false;
    return tokens.some((t) => tokenMatches(w, t));
  });
  return realHits.length >= 2 || (wordsA.length === 2 && realHits.length >= 1 && wordsA.some((w) => w.length >= 5));
}

/** Genuine name overlap — blocks address-only false Tier 1 */
function hasMeaningfulNameMatch(scored) {
  const ns = scored.nameSimilarity;
  const mapsName = scored._mapsName || '';
  const candName = scored.candidate?.navn || '';
  if (ns >= TIER1_MIN_NAME_SIM) return true;
  if (scored.candidate?.foundViaNameSearch && ns >= 0.55 && scored.breakdown.name >= 14) return true;
  if (scored.candidate?.phoneMatch && ns >= 0.45) return true;
  if (mapsName && multiTokenNameOk(mapsName, candName) && ns >= 0.45 && scored.breakdown.name >= 14) {
    return true;
  }
  return false;
}

function canAutoTier1(scored) {
  const { nameSimilarity: ns, addressExact, addressSameStreet, breakdown, total } = scored;
  const mapsName = scored._mapsName || '';

  if (!hasMeaningfulNameMatch(scored)) return false;

  if (addressExact && ns >= 0.8 && multiTokenNameOk(mapsName, scored.candidate?.navn)) return true;
  if (addressExact && ns >= TIER1_MIN_NAME_SIM && breakdown.name >= 20) return true;

  if (addressSameStreet && ns >= 0.82 && breakdown.address >= 28) return true;
  if (addressSameStreet && ns >= 0.78 && breakdown.address >= 28 && breakdown.name >= 22) {
    return true;
  }

  if (
    scored.candidate?.foundViaNameSearch &&
    !scored.candidate?.foundViaNationalNameSearch &&
    ns >= 0.88 &&
    breakdown.name >= 28 &&
    (breakdown.address >= 15 || addressExact || scored.candidate.phoneMatch)
  ) {
    return true;
  }

  if (scored.candidate?.phoneMatch && ns >= 0.65 && breakdown.name >= 18) return true;

  if (total >= 88 && ns >= 0.7) return true;

  return false;
}

/** @deprecated use candidatesForAiHybrid */
function candidatesForAi(scored) {
  const list = Array.isArray(scored) ? scored : scored.byTotal || [];
  const top = list.slice(0, AI_CANDIDATE_MAX);
  if (top.length > 0 && top[0].total >= MATCH_FLOOR) return top;
  return list.filter((s) => s.total >= MATCH_FLOOR).slice(0, AI_CANDIDATE_MAX);
}

function canLocalTier2(scored, best) {
  if (!best) return false;
  if (!hasMeaningfulNameMatch(best) && !best.candidate?.phoneMatch) return false;
  if (best.candidate?.phoneMatch && best.nameSimilarity >= 0.5) return true;
  if (best.nameSimilarity >= 0.68 && best.total >= 40) return true;
  if (
    best.candidate?.foundViaNameSearch &&
    best.nameSimilarity >= 0.78 &&
    best.breakdown.name >= 22
  ) {
    return true;
  }
  if (pickLocalAmbiguous(scored, best)) return true;
  return false;
}

function pickLocalAmbiguous(scored, best) {
  if (!best || best.nameSimilarity < 0.55 || best.total < 38) return false;
  const second = scored[1];
  if (!second) return best.nameSimilarity >= 0.65 && best.total >= 40;
  const gap = best.total - second.total;
  const nameGap = best.nameSimilarity - second.nameSimilarity;
  return (gap >= 8 && nameGap >= 0.1 && best.nameSimilarity >= 0.55) ||
    (best.candidate?.phoneMatch && best.nameSimilarity >= 0.45);
}

module.exports = {
  scoreCandidate,
  scoreAllCandidates,
  addressPriorityRank,
  classifyBand,
  canAutoTier1,
  canLocalTier2,
  candidatesForAi,
  candidatesForAiHybrid,
  hasMeaningfulNameMatch,
  multiTokenNameOk,
  pickLocalAmbiguous,
  compareByTotalScore,
  TIER1_MIN_NAME_SIM,
  AI_MIN_CONFIDENCE,
  AI_CANDIDATE_MAX,
  MATCH_FLOOR,
};
