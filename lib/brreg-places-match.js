/**
 * Reverse match: Brreg row → Google Places profile, with strict accept gates.
 * Phone is fetched only after a match is accepted (Place Details Enterprise).
 */

const {
  mapsRecordFromRow,
  parseMapsAddress,
  addressKey,
  normalizePhone,
} = require('./normalize');
const {
  scoreAllCandidates,
  canAutoTier1,
  classifyBand,
  hasMeaningfulNameMatch,
  TIER1_MIN_NAME_SIM,
} = require('./scoring');
const { searchText, fetchPlaceDetails } = require('./places-lookup');

const AMBIGUOUS_GAP = 8;
const PAGE_SIZE = 5;

function rowHasValidPhone(row) {
  const vals = [row.Phone, row['Business Phone']];
  return vals.some((v) => {
    const t = String(v || '').trim();
    return t && t !== 'Not found' && normalizePhone(t).length >= 8;
  });
}

function brregPostcode(row) {
  const raw = row.Postnummer;
  const fromField = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (fromField) return fromField.padStart(4, '0').slice(-4);
  const parsed = parseMapsAddress(String(row.Address || ''));
  return parsed.postcode || '';
}

function strippedName(row) {
  const raw = String(row['Brreg Name'] || row.Name || '').trim();
  return raw.replace(/\s+(AS|ASA|ANS|DA|ENK|NUF|SA)\s*$/i, '').trim();
}

function buildSearchQueries(row) {
  const name = strippedName(row);
  const postcode = brregPostcode(row);
  const place = String(row.Poststed || '').trim();
  if (!name || name.length < 3) return [];

  const queries = [];
  if (postcode && place) queries.push(`"${name}" ${postcode} ${place}`);
  else if (postcode) queries.push(`"${name}" ${postcode}`);
  if (place) {
    const fallback = `"${name}" ${place}`;
    if (!queries.includes(fallback)) queries.push(fallback);
  }
  if (queries.length === 0) queries.push(`"${name}"`);
  return queries;
}

function isInNorway(place, maps) {
  const addr = String(place.formattedAddress || '');
  if (/\b(norge|norway)\b/i.test(addr)) return true;
  if (/,\s*NO\b/i.test(addr)) return true;
  return Boolean(maps.postcode && /^\d{4}$/.test(maps.postcode));
}

function brregCandidateFromRow(row) {
  const address = String(row.Address || '').trim();
  const parsed = parseMapsAddress(address);
  const postnummer = brregPostcode(row) || String(parsed.postcode || '').trim();
  return {
    orgnr: String(row.Orgnr || ''),
    navn: String(row['Brreg Name'] || row.Name || '').trim(),
    type: 'enhet',
    addressKey: addressKey(parsed),
    postnummer,
    poststed: String(row.Poststed || parsed.city || '').toLowerCase(),
    phone: '',
    mobil: '',
    naceBeskrivelse: String(row['NACE Description'] || ''),
    rawAddressLine: address,
    foundViaNameSearch: true,
    foundViaNationalNameSearch: false,
    foundViaAddressSearch: false,
  };
}

function placeToMapsRecord(place, industry) {
  return mapsRecordFromRow({
    Name: place.displayName?.text || '',
    Address: place.formattedAddress || '',
    Industry: industry || '',
  });
}

function scorePlaceAgainstBrreg(place, brregCandidate, industry) {
  const maps = placeToMapsRecord(place, industry);
  const scored = scoreAllCandidates(maps, [brregCandidate]);
  const best = scored.best;
  if (!best) return null;
  return { place, maps, ...best };
}

function passesHardFilters(item, brregPostcode) {
  if (!item) return false;
  if (item.place.businessStatus === 'CLOSED_PERMANENTLY') return false;
  if (!isInNorway(item.place, item.maps)) return false;
  if (!brregPostcode || item.maps.postcode !== brregPostcode) return false;
  return true;
}

function isAcceptedMatch(item, runnerUp) {
  if (!hasMeaningfulNameMatch(item)) return { ok: false, reason: 'weak_name' };
  const band = classifyBand(item.total);
  const streetAndName =
    item.addressSameStreet && item.nameSimilarity >= TIER1_MIN_NAME_SIM;
  const okBand = band === 'probable' || band === 'confirmed';
  if (!okBand && !canAutoTier1(item) && !streetAndName) {
    return { ok: false, reason: `score_band_${band}` };
  }
  if (runnerUp && item.total - runnerUp.total < AMBIGUOUS_GAP) {
    return { ok: false, reason: 'ambiguous' };
  }
  return { ok: true, reason: okBand ? band : canAutoTier1(item) ? 'tier1' : 'same_street' };
}

async function collectPlaceCandidates(row, { apiKey } = {}) {
  const queries = buildSearchQueries(row);
  const byId = new Map();
  for (let i = 0; i < queries.length; i++) {
    const hits = await searchText(queries[i], { pageSize: PAGE_SIZE, apiKey });
    for (const place of hits) {
      if (place?.id && !byId.has(place.id)) byId.set(place.id, place);
    }
    if (byId.size > 0) break;
  }
  return [...byId.values()];
}

/**
 * @returns {{
 *   status: 'matched'|'no_profile'|'ambiguous'|'already_had_phone'|'error',
 *   reason: string,
 *   score: number|'',
 *   placeId: string,
 *   mapsUrl: string,
 *   phone: string,
 *   website: string,
 *   placeName: string,
 * }}
 */
async function matchBrregRowToPlaces(row, options = {}) {
  const { apiKey, fetchDetails = true } = options;

  if (rowHasValidPhone(row)) {
    return {
      status: 'already_had_phone',
      reason: 'brreg_phone',
      score: '',
      placeId: '',
      mapsUrl: '',
      phone: '',
      website: '',
      placeName: '',
    };
  }

  const postcode = brregPostcode(row);
  if (!postcode || !/^\d{4}$/.test(postcode)) {
    return reject('no_profile', 'missing_postcode');
  }

  let places;
  try {
    places = await collectPlaceCandidates(row, { apiKey });
  } catch (err) {
    return reject('error', err.message);
  }

  if (!places.length) return reject('no_profile', 'no_places');

  const brregCandidate = brregCandidateFromRow(row);
  const scored = places
    .map((place) => scorePlaceAgainstBrreg(place, brregCandidate, row.Industry))
    .filter(Boolean)
    .sort((a, b) => b.total - a.total);

  const eligible = scored.filter((item) => passesHardFilters(item, postcode));
  if (!eligible.length) return reject('no_profile', 'no_postcode_match');

  const best = eligible[0];
  const second = eligible[1] || null;
  const decision = isAcceptedMatch(best, second);
  if (!decision.ok) {
    return reject(decision.reason === 'ambiguous' ? 'ambiguous' : 'no_profile', decision.reason, {
      score: best.total,
      placeId: best.place.id || '',
      mapsUrl: best.place.googleMapsUri || '',
      placeName: best.place.displayName?.text || '',
    });
  }

  let phone = '';
  let website = '';
  if (fetchDetails) {
    try {
      const details = await fetchPlaceDetails(best.place.id, { apiKey });
      phone = (details?.nationalPhoneNumber || details?.internationalPhoneNumber || '').trim();
      website = (details?.websiteUri || '').trim();
    } catch (err) {
      return reject('error', `details: ${err.message}`, {
        score: best.total,
        placeId: best.place.id || '',
        mapsUrl: best.place.googleMapsUri || '',
        placeName: best.place.displayName?.text || '',
      });
    }
  }

  return {
    status: 'matched',
    reason: decision.reason,
    score: best.total,
    placeId: best.place.id || '',
    mapsUrl: best.place.googleMapsUri || '',
    phone,
    website,
    placeName: best.place.displayName?.text || '',
  };
}

function reject(status, reason, extra = {}) {
  return {
    status,
    reason,
    score: extra.score ?? '',
    placeId: extra.placeId || '',
    mapsUrl: extra.mapsUrl || '',
    phone: '',
    website: '',
    placeName: extra.placeName || '',
  };
}

function applyMatchToRow(row, result) {
  row['Maps Match Status'] = result.status;
  row['Maps Match Score'] = result.score;
  row['Maps Match Reason'] = result.reason || '';
  row['Match Score'] = result.status === 'matched' ? result.score : '';
  row['Match Confidence'] = result.status === 'matched' ? 'High' : '';
  if (result.placeId) row.place_id = result.placeId;
  if (result.mapsUrl) row['Google Maps URL'] = result.mapsUrl;

  if (result.status !== 'matched') return row;

  if (result.phone) {
    row.Phone = result.phone;
    row['Business Phone'] = result.phone;
    row['Has Valid Phone'] = normalizePhone(result.phone).length >= 8;
    if (!row['Phone Source']) row['Phone Source'] = 'maps';
  }
  if (result.website && (!row.Website || row.Website === 'Not found')) {
    row.Website = result.website;
  }
  return row;
}

module.exports = {
  matchBrregRowToPlaces,
  applyMatchToRow,
  rowHasValidPhone,
  buildSearchQueries,
  strippedName,
  brregPostcode,
};
