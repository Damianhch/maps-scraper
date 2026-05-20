/**
 * End-to-end: Google Maps row -> Brreg match + enrichment.
 */

const { mapsRecordFromRow, nameSimilarityScore } = require('./normalize');
const {
  gatherAllCandidates,
  fetchRoller,
  extractContactPerson,
  formatAntallAnsatte,
  pickBusinessPhone,
} = require('./brreg');
const {
  scoreAllCandidates,
  canAutoTier1,
  canLocalTier2,
  classifyBand,
  candidatesForAiHybrid,
  pickLocalAmbiguous,
  hasMeaningfulNameMatch,
  AI_MIN_CONFIDENCE,
  MATCH_FLOOR,
} = require('./scoring');
const { adjudicateWithDeepSeek } = require('./ai-match');

async function enrichFromBrreg(candidate, maps) {
  const rolesOrgnr = candidate.overordnetEnhet || candidate.orgnr;
  const rollerData = await fetchRoller(rolesOrgnr);
  const contactPerson = extractContactPerson(rollerData) || 'Not found';
  let businessPhone = pickBusinessPhone(candidate);
  if (businessPhone === 'Not found' && maps.phone) {
    businessPhone = maps.phone;
  }

  return {
    orgnr: candidate.orgnr,
    parentOrgnr: candidate.overordnetEnhet || '',
    brregName: candidate.navn,
    contactPerson,
    businessPhone,
    selskapsform: candidate.orgFormKode || 'Not found',
    antallAnsatte: formatAntallAnsatte(candidate),
    matchType: candidate.type,
  };
}

function pickCandidateByOrgnr(scored, orgnr) {
  return scored.find((s) => s.candidate.orgnr === orgnr);
}

function assignTier(best, tier3, options = {}) {
  const { tradingNameAtAddress = false } = options;
  const ns = best.nameSimilarity;

  if (ns >= 0.72 && (best.addressExact || (best.addressSameStreet && best.breakdown.address >= 35))) {
    return 1;
  }
  if (tradingNameAtAddress) return 2;
  if (tier3 || !best.addressExact) return best.addressSameStreet ? 3 : 2;
  return 2;
}

function tryLocalFallback(scored, best, tier3, log, reason) {
  if (!hasMeaningfulNameMatch(best) && !best.candidate?.phoneMatch) {
    return null;
  }
  if (canLocalTier2(scored.byTotal, best)) {
    const tier = assignTier(best, tier3);
    log(`  ✅ Tier ${tier} local fallback (${reason}, score ${best.total})`);
    return { chosen: best, tier, matchConfidence: best.total };
  }
  if (pickLocalAmbiguous(scored.byTotal, best) && hasMeaningfulNameMatch(best)) {
    const tier = assignTier(best, tier3);
    log(`  ✅ Tier ${tier} ambiguous local (${reason}, score ${best.total})`);
    return { chosen: best, tier, matchConfidence: best.total };
  }
  return null;
}

async function matchBusinessToBrreg(row, log = console.log) {
  const maps = mapsRecordFromRow(row);

  if (!maps.postcode) {
    log('  ⚠️  Missing postcode — skip');
    return null;
  }

  if (!maps.name && (!maps.brregAddressQueries || maps.brregAddressQueries.length === 0)) {
    log('  ⚠️  Missing business name and address — skip');
    return null;
  }

  log(
    `  🔎 Brreg: ${maps.brregAddressQueries?.length || 0} addr + ${maps.brregNameQueries?.length || 0} name queries`
  );

  const { candidates, usedStreetFallback } = await gatherAllCandidates(maps, log);
  log(`  📦 ${candidates.length} candidates`);

  if (candidates.length === 0) {
    log('  ⚠️  No Brreg candidates');
    return null;
  }

  const scored = scoreAllCandidates(maps, candidates);
  const best = scored.best;
  const ranked = scored.byTotal;

  const nameQueryFoundInBrreg = candidates.some(
    (c) =>
      (c.foundViaNameSearch || c.foundViaNationalNameSearch) &&
      nameSimilarityScore(maps.name, c.navn) >= 0.35
  );

  if (!best || best.total < MATCH_FLOOR) {
    log(
      `  ⚠️  No match (best ${best?.total ?? 0}, nameSim ${best?.nameSimilarity?.toFixed(2) ?? '0'}, top: ${best?.candidate?.navn || '-'})`
    );
    return null;
  }

  const band = classifyBand(best.total);
  let chosen = best;
  let matchConfidence = best.total;
  let tier = '';
  const tier3 = usedStreetFallback;

  if (canAutoTier1(best)) {
    tier = assignTier(best, tier3);
    log(
      `  ✅ Tier ${tier} auto (score ${best.total}, nameSim ${best.nameSimilarity.toFixed(2)})`
    );
  } else if (canLocalTier2(ranked, best)) {
    tier = assignTier(best, tier3);
    log(`  ✅ Tier ${tier} local (score ${best.total}, nameSim ${best.nameSimilarity.toFixed(2)})`);
  } else {
    const forAi = candidatesForAiHybrid(scored);
    if (forAi.length === 0) {
      const fb = tryLocalFallback(scored, best, tier3, log, 'no AI pool');
      if (!fb) {
        log(`  ⚠️  Below match floor (score ${best.total})`);
        return null;
      }
      chosen = fb.chosen;
      tier = fb.tier;
      matchConfidence = fb.matchConfidence;
    } else if (forAi.length === 1 && forAi[0].nameSimilarity >= 0.55 && forAi[0].total >= 38 && hasMeaningfulNameMatch(forAi[0])) {
      chosen = forAi[0];
      tier = assignTier(chosen, tier3);
      matchConfidence = chosen.total;
      log(`  ✅ Tier ${tier} single candidate`);
    } else {
      log(`  🤖 AI (${forAi.length} candidates, band=${band})`);
      try {
        const ai = await adjudicateWithDeepSeek(maps, forAi);
        matchConfidence = ai.confidence || best.total;

        if (ai.best_orgnr) {
          const picked = pickCandidateByOrgnr(ranked, ai.best_orgnr);
          const strongNameHit = ranked.find(
            (s) =>
              s.nameSimilarity >= 0.85 &&
              (s.candidate.foundViaNameSearch || s.candidate.foundViaNationalNameSearch)
          );
          const aiTrustsLocation =
            picked &&
            (picked.addressExact ||
              (picked.addressSameStreet && picked.breakdown.address >= 35) ||
              ai.confidence >= 70);
          let acceptAi =
            picked &&
            (picked.nameSimilarity >= 0.45 ||
              (ai.confidence >= 62 && picked.nameSimilarity >= 0.35) ||
              (aiTrustsLocation && ai.confidence >= 75 && picked.addressExact));

          if (
            acceptAi &&
            picked.nameSimilarity < 0.35 &&
            !picked.candidate?.foundViaNameSearch &&
            !nameQueryFoundInBrreg
          ) {
            acceptAi = false;
            log('  ⚠️  Rejected address-only AI pick — Maps name not in Brreg');
          }

          if (
            acceptAi &&
            picked &&
            strongNameHit &&
            picked.candidate.orgnr !== strongNameHit.candidate.orgnr &&
            picked.nameSimilarity < 0.55 &&
            strongNameHit.nameSimilarity >= 0.85
          ) {
            acceptAi = false;
            log(`  ⚠️  Rejected AI pick — prefer name-search hit ${strongNameHit.candidate.navn}`);
          }

          if (acceptAi) {
            chosen = picked;
            const tradingNameAtAddress =
              picked.nameSimilarity < 0.72 &&
              nameQueryFoundInBrreg &&
              picked.addressExact &&
              ai.confidence >= 75;
            tier = assignTier(chosen, tier3, { tradingNameAtAddress });
            log(`  ✅ Tier ${tier} via AI → ${ai.best_orgnr} (${ai.confidence}%)`);
          } else {
            if (
              strongNameHit &&
              strongNameHit.nameSimilarity >= 0.85 &&
              hasMeaningfulNameMatch(strongNameHit)
            ) {
              chosen = strongNameHit;
              tier = assignTier(chosen, tier3);
              matchConfidence = strongNameHit.total;
              log(`  ✅ Tier ${tier} name-search (over AI reject, nameSim ${strongNameHit.nameSimilarity.toFixed(2)})`);
            } else {
              const fb = tryLocalFallback(scored, best, tier3, log, 'AI pick too weak');
              if (fb) {
                chosen = fb.chosen;
                tier = fb.tier;
                matchConfidence = fb.matchConfidence;
              } else {
                log(`  ⚠️  AI orgnr not in list or rejected: ${ai.best_orgnr}`);
                return null;
              }
            }
          }
        } else {
          const fb = tryLocalFallback(scored, best, tier3, log, 'AI no match');
          if (!fb) {
            log(`  ⚠️  AI rejected (confidence ${ai.confidence})`);
            return null;
          }
          chosen = fb.chosen;
          tier = fb.tier;
          matchConfidence = fb.matchConfidence;
        }
      } catch (e) {
        log(`  ❌ AI error: ${e.message}`);
        const fb = tryLocalFallback(scored, best, tier3, log, 'AI error');
        if (!fb) return null;
        chosen = fb.chosen;
        tier = fb.tier;
        matchConfidence = fb.matchConfidence;
      }
    }
  }

  const enrichment = await enrichFromBrreg(chosen.candidate, maps);

  return {
    tier,
    matchScore: chosen.total,
    matchConfidence,
    ...enrichment,
  };
}

module.exports = {
  matchBusinessToBrreg,
  mapsRecordFromRow,
};
