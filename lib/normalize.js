/**
 * Normalize Google Maps / Brreg fields for matching.
 */

const STREET_SUFFIXES = [
  [/\bgata\b/g, 'gate'],
  [/\bgaten\b/g, 'gate'],
  [/\bgate\b/g, 'gate'],
  [/\bgt\b/g, 'gate'],
  [/\bveien\b/g, 'veg'],
  [/\bvegen\b/g, 'veg'],
  [/\bvei\b/g, 'veg'],
  [/\bveg\b/g, 'veg'],
  [/\bplassen\b/g, 'plass'],
  [/\bplass\b/g, 'plass'],
  [/\bkjøpesenter\b/g, 'senter'],
  [/\bsenter\b/g, 'senter'],
];

function canonicalizeStreetName(street) {
  if (!street) return '';
  let t = street.toLowerCase().trim().replace(/\s+/g, ' ');
  for (const [re, repl] of STREET_SUFFIXES) {
    t = t.replace(re, repl);
  }
  return t.replace(/[,.]/g, '').trim();
}

/**
 * Parse house number and optional letter from trailing part of street line.
 * e.g. "Vidhaugen 25E" -> { houseNumber: "25", houseLetter: "e" }
 */
const NAME_STOPWORDS = new Set([
  'as', 'asa', 'ans', 'da', 'enk', 'nuf', 'sa', 'og', 'the', 'i', 'pa', 'på',
  'cafe', 'kafe', 'café', 'bar', 'restaurant', 'restauranter', 'takeaway',
  'la', 'le', 'de', 'en', 'et', 'av', 'avd', 'for', 'og', 'i',
]);

/** Expand gt./vn. etc. before parsing street line */
function preprocessAddressLine(line) {
  return (line || '')
    .replace(/\bgt\.?\b/gi, 'gate')
    .replace(/\bvn\.?\b/gi, 'veien')
    .replace(/\bvei\.?\b/gi, 'vei')
    .replace(/\bpl\.?\b/gi, 'plass')
    .trim();
}

function parseHouseFromLine(line) {
  const m = preprocessAddressLine(line)
    .trim()
    .match(/^(.*?)\s+(\d+)\s*([a-zæøå])?\s*$/i);
  if (!m) return { streetLine: line || '', houseNumber: '', houseLetter: '' };
  return {
    streetLine: m[1].trim(),
    houseNumber: m[2],
    houseLetter: (m[3] || '').toLowerCase(),
  };
}

/**
 * Parse a Google Maps address string into structured parts.
 */
function parseMapsAddress(raw) {
  if (!raw || typeof raw !== 'string' || raw === 'Not found') {
    return {
      street: '',
      houseNumber: '',
      houseLetter: '',
      postcode: '',
      city: '',
      raw: '',
    };
  }

  let t = raw.trim();

  let postcode = '';
  let city = '';
  const postcodeMatch = t.match(/\b(\d{4})\b/);
  if (postcodeMatch) {
    postcode = postcodeMatch[1];
    const afterPost = t.slice(t.indexOf(postcode) + 4).replace(/^[,\s]+/, '');
    const cityMatch = afterPost.match(/^([A-Za-zÆØÅæøå\s-]+)/);
    if (cityMatch) city = cityMatch[1].trim();
    t = t.slice(0, t.indexOf(postcode)).replace(/[,\s]+$/, '').trim();
  }

  if (t.includes(',')) {
    const firstSegment = t.split(',')[0].trim();
    if (!/\d/.test(firstSegment)) {
      t = t.replace(/^[^,]+\s*,\s*/, '');
    }
  }

  const { streetLine, houseNumber, houseLetter } = parseHouseFromLine(preprocessAddressLine(t));
  const street = canonicalizeStreetName(streetLine);

  return {
    street,
    houseNumber,
    houseLetter,
    postcode,
    city: city.toLowerCase().replace(/\s+/g, ' ').trim(),
    raw,
  };
}

/**
 * Build pipe-separated address key: storgata|10|b|0155|oslo
 */
function addressKey(parts) {
  const p = typeof parts === 'string' ? parseMapsAddress(parts) : parts;
  return [
    p.street || '',
    p.houseNumber || '',
    p.houseLetter || '',
    p.postcode || '',
    p.city || '',
  ].join('|');
}

/** Brreg address object -> address key */
function addressKeyFromBrreg(addr) {
  if (!addr) return '';
  const line = Array.isArray(addr.adresse) ? addr.adresse[0] : (addr.adresse || '');
  const parsed = parseMapsAddress(
    `${line}, ${addr.postnummer || ''} ${addr.poststed || ''}`.trim()
  );
  return addressKey(parsed);
}

/** Street-only key for fuzzy / Tier 3 (no house number) */
function streetPostcodeKey(parts) {
  const p = typeof parts === 'string' ? parseMapsAddress(parts) : parts;
  return [p.street || '', '', '', p.postcode || '', p.city || ''].join('|');
}

/** Query string for Brreg API (street + number + letter) */
function brregAddressQuery(parts) {
  const p = typeof parts === 'string' ? parseMapsAddress(parts) : parts;
  const num = p.houseNumber
    ? p.houseNumber + (p.houseLetter || '').toUpperCase()
    : '';
  const line = [p.street, num].filter(Boolean).join(' ');
  return capitalizeAddressQuery(line);
}

/** Street name only for broader Brreg address filter */
function brregStreetOnlyQuery(parts) {
  const p = typeof parts === 'string' ? parseMapsAddress(parts) : parts;
  if (!p.street) return '';
  return capitalizeAddressQuery(p.street);
}

function capitalizeAddressQuery(line) {
  if (!line) return '';
  return line
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Multiple address strings for Brreg (generalized, like Proff address matching) */
function brregAddressQueries(parts) {
  const p = typeof parts === 'string' ? parseMapsAddress(parts) : parts;
  const queries = new Set();

  const full = brregAddressQuery(p);
  if (full) queries.add(full);

  const street = brregStreetOnlyQuery(p);
  if (street) queries.add(street);

  if (p.houseNumber) {
    const noLetter = { ...p, houseLetter: '' };
    const q = brregAddressQuery(noLetter);
    if (q) queries.add(q);
    if (street) {
      queries.add(`${street} ${p.houseNumber}`);
    }
  }

  return [...queries];
}

/** Clean business name for Brreg navn= search */
function cleanNameForBrregSearch(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[/\\|*?"<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One or more name queries (full name + significant tokens) */
function brregNameQueries(name) {
  const cleaned = cleanNameForBrregSearch(name);
  const queries = new Set();
  if (!cleaned || cleaned.length < 2) return [];

  queries.add(cleaned);

  const withoutSuffix = cleaned.replace(/\s+(as|asa|ans|da|enk|nuf|sa)\s*$/i, '').trim();
  if (withoutSuffix.length >= 3) queries.add(withoutSuffix);

  const words = cleaned
    .split(/\s+/)
    .filter((w) => w.length > 2 && !NAME_STOPWORDS.has(w.toLowerCase()));

  if (words.length >= 2) {
    queries.add(words.slice(0, Math.min(4, words.length)).join(' '));
  }
  if (words.length >= 1 && words[0].length >= 4) {
    queries.add(words[0]);
  }

  return [...queries].filter((q) => q.length >= 3).slice(0, 4);
}

function normalizeName(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[,.]/g, '')
    .replace(/\s+as$/, '')
    .trim();
}

function normalizePhone(s) {
  if (!s || typeof s !== 'string') return '';
  let d = s.replace(/\D/g, '');
  if (d.startsWith('47') && d.length > 8) d = d.slice(2);
  return d.length >= 8 ? d.slice(-8) : d;
}

function significantNameTokens(name) {
  return normalizeName(name)
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !NAME_STOPWORDS.has(w));
}

/** Avoid "gola"↔"la" / "tacohuset"↔"hus" false positives — min 4 chars for partial match */
function tokenMatches(wa, wb) {
  if (wa === wb) return true;
  const short = wa.length <= wb.length ? wa : wb;
  const long = wa.length <= wb.length ? wb : wa;
  if (short.length < 4) return false;
  if (long === short) return true;
  return long.startsWith(`${short} `) || long.endsWith(` ${short}`) || long.includes(` ${short} `);
}

function nameSimilarityScore(name1, name2) {
  const a = normalizeName(name1);
  const b = normalizeName(name2);
  if (!a || !b) return 0;
  if (a === b) return 1;

  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  if (shorter.length >= 4 && (longer.startsWith(`${shorter} `) || longer.endsWith(` ${shorter}`) || longer.includes(` ${shorter} `))) {
    return 0.85;
  }

  const wordsA = significantNameTokens(name1);
  const wordsB = significantNameTokens(name2);
  if (wordsA.length === 0 || wordsB.length === 0) return 0;

  let hits = 0;
  for (const wa of wordsA) {
    if (wordsB.some((wb) => tokenMatches(wa, wb))) {
      hits += 1;
    }
  }
  const ratio = hits / Math.min(wordsA.length, wordsB.length);
  if (ratio >= 0.5) return Math.max(0.65, ratio);
  return ratio * 0.85;
}

function namesSimilar(name1, name2, threshold = 0.6) {
  return nameSimilarityScore(name1, name2) >= threshold;
}

/** Build MapsRecord from Excel row */
function mapsRecordFromRow(row) {
  const rawAddress = (row.Address || row.address || '').trim();
  const parsed = parseMapsAddress(rawAddress);
  return {
    name: (row.Name || row.name || '').trim(),
    ...parsed,
    phone: (row.Phone || row.phone || '').trim(),
    category: (row.Category || row.Industry || row.industry || '').trim(),
    lat: row.Lat || row.lat || null,
    lng: row.Lng || row.lng || null,
    addressKey: addressKey(parsed),
    streetKey: streetPostcodeKey(parsed),
    brregQuery: brregAddressQuery(parsed),
    brregStreetQuery: brregStreetOnlyQuery(parsed),
    brregAddressQueries: brregAddressQueries(parsed),
    brregNameQueries: brregNameQueries((row.Name || row.name || '').trim()),
  };
}

function addressKeysExact(key1, key2) {
  return key1 && key2 && key1 === key2;
}

function addressSameStreet(key1, key2) {
  if (!key1 || !key2) return false;
  const a = key1.split('|');
  const b = key2.split('|');
  return a[0] === b[0] && a[0] !== '' && a[3] === b[3] && a[3] !== '';
}

module.exports = {
  parseMapsAddress,
  addressKey,
  addressKeyFromBrreg,
  streetPostcodeKey,
  brregAddressQuery,
  brregAddressQueries,
  brregStreetOnlyQuery,
  brregNameQueries,
  cleanNameForBrregSearch,
  capitalizeAddressQuery,
  normalizeName,
  normalizePhone,
  nameSimilarityScore,
  namesSimilar,
  significantNameTokens,
  tokenMatches,
  mapsRecordFromRow,
  addressKeysExact,
  addressSameStreet,
  canonicalizeStreetName,
};
