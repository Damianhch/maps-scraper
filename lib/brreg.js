/**
 * Brreg Enhetsregisteret API client.
 */

const { addressKeyFromBrreg } = require('./normalize');

const BASE = 'https://data.brreg.no/enhetsregisteret/api';
/** Broad street queries return 500+ hits; paginate deeper when query includes house number */
const MAX_PAGES_BROAD = 6;
const MAX_PAGES_SPECIFIC_ADDRESS = 28;
const PAGE_SIZE = 20;
const REQUEST_DELAY_MS = 180;
const MAX_NAME_QUERIES = 4;
const MAX_ADDRESS_QUERIES = 4;
const MAX_NAME_PAGES = 3;

let lastRequestAt = 0;

async function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function throttle() {
  const now = Date.now();
  const wait = REQUEST_DELAY_MS - (now - lastRequestAt);
  if (wait > 0) await delay(wait);
  lastRequestAt = Date.now();
}

async function brregFetch(path, timeoutMs = 30000) {
  await throttle();
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Brreg HTTP ${res.status}: ${url}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAllPages(buildUrl, maxPages = MAX_PAGES_BROAD) {
  const items = [];
  let page = 0;
  let totalPages = 1;

  while (page < totalPages && page < maxPages) {
    const data = await brregFetch(buildUrl(page));
    const embedded = data._embedded || {};
    const batch = embedded.underenheter || embedded.enheter || [];
    items.push(...batch);
    totalPages = data.page?.totalPages ?? 1;
    page += 1;
    if (batch.length === 0) break;
  }

  return items;
}

function maxPagesForAddressQuery(adresse) {
  if (!adresse || typeof adresse !== 'string') return MAX_PAGES_BROAD;
  return /\d/.test(adresse) ? MAX_PAGES_SPECIFIC_ADDRESS : MAX_PAGES_BROAD;
}

function mapUnderenhet(u, meta = {}) {
  const addr = u.beliggenhetsadresse;
  return {
    orgnr: u.organisasjonsnummer,
    navn: u.navn,
    type: 'underenhet',
    addressKey: addressKeyFromBrreg(addr),
    postnummer: addr?.postnummer || '',
    poststed: (addr?.poststed || '').toLowerCase(),
    phone: u.telefon || '',
    mobil: u.mobil || '',
    epost: u.epostadresse || '',
    orgFormKode: u.organisasjonsform?.kode || '',
    orgFormBeskrivelse: u.organisasjonsform?.beskrivelse || '',
    naceKode: u.naeringskode1?.kode || '',
    naceBeskrivelse: u.naeringskode1?.beskrivelse || '',
    antallAnsatte: u.antallAnsatte,
    harRegistrertAntallAnsatte: u.harRegistrertAntallAnsatte,
    registrertIMvaregisteret: u.registrertIMvaregisteret,
    overordnetEnhet: u.overordnetEnhet || null,
    rawAddressLine: Array.isArray(addr?.adresse) ? addr.adresse[0] : '',
    foundViaNameSearch: meta.foundViaNameSearch || false,
    foundViaNationalNameSearch: meta.foundViaNationalNameSearch || false,
    foundViaAddressSearch: meta.foundViaAddressSearch || false,
  };
}

function mapEnhet(e, meta = {}) {
  const addr = e.forretningsadresse;
  return {
    orgnr: e.organisasjonsnummer,
    navn: e.navn,
    type: 'enhet',
    addressKey: addressKeyFromBrreg(addr),
    postnummer: addr?.postnummer || '',
    poststed: (addr?.poststed || '').toLowerCase(),
    phone: e.telefon || '',
    mobil: e.mobil || '',
    epost: e.epostadresse || '',
    orgFormKode: e.organisasjonsform?.kode || '',
    orgFormBeskrivelse: e.organisasjonsform?.beskrivelse || '',
    naceKode: e.naeringskode1?.kode || '',
    naceBeskrivelse: e.naeringskode1?.beskrivelse || '',
    antallAnsatte: e.antallAnsatte,
    harRegistrertAntallAnsatte: e.harRegistrertAntallAnsatte,
    registrertIMvaregisteret: e.registrertIMvaregisteret,
    overordnetEnhet: null,
    rawAddressLine: Array.isArray(addr?.adresse) ? addr.adresse[0] : '',
    foundViaNameSearch: meta.foundViaNameSearch || false,
    foundViaNationalNameSearch: meta.foundViaNationalNameSearch || false,
    foundViaAddressSearch: meta.foundViaAddressSearch || false,
  };
}

function mergeCandidates(into, list, meta) {
  for (const raw of list) {
    const c =
      raw.respons_klasse === 'Underenhet' || raw.beliggenhetsadresse
        ? mapUnderenhet(raw, meta)
        : mapEnhet(raw, meta);
    const prev = into.get(c.orgnr);
    if (!prev) {
      into.set(c.orgnr, c);
    } else {
      into.set(c.orgnr, {
        ...prev,
        foundViaNameSearch: prev.foundViaNameSearch || c.foundViaNameSearch,
        foundViaNationalNameSearch:
          prev.foundViaNationalNameSearch || c.foundViaNationalNameSearch,
        foundViaAddressSearch: prev.foundViaAddressSearch || c.foundViaAddressSearch,
      });
    }
  }
}

async function searchUnderenheterByAddress(adresse, postnummer, maxPages) {
  if (!adresse || !postnummer) return [];
  const lim = maxPages ?? maxPagesForAddressQuery(adresse);
  const q = encodeURIComponent(adresse);
  const items = await fetchAllPages(
    (page) =>
      `/underenheter?beliggenhetsadresse.adresse=${q}&beliggenhetsadresse.postnummer=${postnummer}&page=${page}&size=${PAGE_SIZE}`,
    lim
  );
  return items;
}

async function searchEnheterByAddress(adresse, postnummer, maxPages) {
  if (!adresse || !postnummer) return [];
  const lim = maxPages ?? maxPagesForAddressQuery(adresse);
  const q = encodeURIComponent(adresse);
  const items = await fetchAllPages(
    (page) =>
      `/enheter?forretningsadresse.adresse=${q}&forretningsadresse.postnummer=${postnummer}&page=${page}&size=${PAGE_SIZE}`,
    lim
  );
  return items;
}

async function fetchNamePages(endpoint, navn, postnummer, maxPages = MAX_NAME_PAGES) {
  if (!navn) return [];
  const q = encodeURIComponent(navn);
  const post =
    postnummer && endpoint === 'underenheter'
      ? `&beliggenhetsadresse.postnummer=${postnummer}`
      : postnummer && endpoint === 'enheter'
        ? `&forretningsadresse.postnummer=${postnummer}`
        : '';
  const items = [];
  let page = 0;
  let totalPages = 1;
  while (page < totalPages && page < maxPages) {
    const data = await brregFetch(
      `/${endpoint}?navn=${q}&navnMetodeForSoek=FORTLOEPENDE${post}&page=${page}&size=${PAGE_SIZE}`
    );
    const batch = data._embedded?.[endpoint] || [];
    items.push(...batch);
    totalPages = data.page?.totalPages ?? 1;
    page += 1;
    if (batch.length === 0) break;
  }
  return items;
}

async function searchUnderenheterByName(navn, postnummer) {
  return fetchNamePages('underenheter', navn, postnummer);
}

async function searchEnheterByName(navn, postnummer) {
  return fetchNamePages('enheter', navn, postnummer);
}

/**
 * Collect candidates: generalized address queries + name search (like Proff name + address).
 */
async function gatherAllCandidates(maps, log = () => {}) {
  const byOrnr = new Map();
  const postcode = maps.postcode;
  let usedStreetFallback = false;

  const addressQueries = (maps.brregAddressQueries || [maps.brregQuery]).filter(Boolean);
  const limitedAddr = addressQueries.slice(0, MAX_ADDRESS_QUERIES);

  for (let i = 0; i < limitedAddr.length; i++) {
    const aq = limitedAddr[i];
    const deepPages =
      i === 0 && maps.houseNumber ? maxPagesForAddressQuery(aq) : MAX_PAGES_BROAD;
    const [under, enheter] = await Promise.all([
      searchUnderenheterByAddress(aq, postcode, deepPages),
      searchEnheterByAddress(aq, postcode, deepPages),
    ]);
    mergeCandidates(byOrnr, under, { foundViaAddressSearch: true });
    mergeCandidates(byOrnr, enheter, { foundViaAddressSearch: true });
    if (aq === maps.brregStreetQuery || aq === limitedAddr[limitedAddr.length - 1]) {
      if (aq !== maps.brregQuery) usedStreetFallback = true;
    }
  }

  const nameQueries = (maps.brregNameQueries || []).slice(0, MAX_NAME_QUERIES);
  for (const nq of nameQueries) {
    let [under, enheter] = await Promise.all([
      searchUnderenheterByName(nq, postcode),
      searchEnheterByName(nq, postcode),
    ]);
    let hits = under.length + enheter.length;
    if (hits > 0) {
      log(`  📛 Name+postcode "${nq}": ${hits} hits`);
      mergeCandidates(byOrnr, under, { foundViaNameSearch: true });
      mergeCandidates(byOrnr, enheter, { foundViaNameSearch: true });
      continue;
    }

    [under, enheter] = await Promise.all([
      fetchNamePages('underenheter', nq, null, MAX_NAME_PAGES),
      fetchNamePages('enheter', nq, null, MAX_NAME_PAGES),
    ]);
    hits = under.length + enheter.length;
    if (hits > 0) {
      log(`  📛 Name national "${nq}": ${hits} hits`);
      mergeCandidates(byOrnr, under, {
        foundViaNameSearch: true,
        foundViaNationalNameSearch: true,
      });
      mergeCandidates(byOrnr, enheter, {
        foundViaNameSearch: true,
        foundViaNationalNameSearch: true,
      });
    }
  }

  if (maps.phone) {
    const phoneDigits = maps.phone.replace(/\D/g, '').slice(-8);
    if (phoneDigits.length >= 8) {
      for (const c of byOrnr.values()) {
        const c1 = (c.phone || '').replace(/\D/g, '').slice(-8);
        const c2 = (c.mobil || '').replace(/\D/g, '').slice(-8);
        if (c1 === phoneDigits || c2 === phoneDigits) {
          c.phoneMatch = true;
        }
      }
    }
  }

  const merged = [...byOrnr.values()];
  merged.sort((a, b) => {
    if (a.type === 'underenhet' && b.type !== 'underenhet') return -1;
    if (b.type === 'underenhet' && a.type !== 'underenhet') return 1;
    return 0;
  });

  return { candidates: merged, usedStreetFallback };
}

/** @deprecated use gatherAllCandidates */
async function searchCandidates(adresse, postnummer) {
  const byOrnr = new Map();
  const [under, enheter] = await Promise.all([
    searchUnderenheterByAddress(adresse, postnummer, MAX_PAGES_BROAD),
    searchEnheterByAddress(adresse, postnummer, MAX_PAGES_BROAD),
  ]);
  mergeCandidates(byOrnr, under, { foundViaAddressSearch: true });
  mergeCandidates(byOrnr, enheter, { foundViaAddressSearch: true });
  return { candidates: [...byOrnr.values()], streetOnly: false };
}

async function fetchEnhet(orgnr) {
  return brregFetch(`/enheter/${orgnr}`);
}

async function fetchRoller(orgnr) {
  try {
    return brregFetch(`/enheter/${orgnr}/roller`);
  } catch {
    return null;
  }
}

const ROLE_PRIORITY = [
  { group: 'DAGL', type: 'DAGL' },
  { group: 'STYR', type: 'LEDE' },
  { group: 'STYR', type: null },
];

function personNameFromRolle(rolle) {
  const n = rolle?.person?.navn;
  if (!n) return null;
  const parts = [n.fornavn, n.etternavn].filter(Boolean);
  return parts.join(' ').trim() || null;
}

function extractContactPerson(rollerData) {
  if (!rollerData?.rollegrupper) return null;

  for (const { group, type } of ROLE_PRIORITY) {
    const rg = rollerData.rollegrupper.find((g) => g.type?.kode === group);
    if (!rg?.roller?.length) continue;

    for (const rolle of rg.roller) {
      if (rolle.fratraadt || rolle.avregistrert) continue;
      if (type && rolle.type?.kode !== type) continue;
      const name = personNameFromRolle(rolle);
      if (name) return name;
    }
  }

  for (const rg of rollerData.rollegrupper) {
    for (const rolle of rg.roller || []) {
      if (rolle.fratraadt || rolle.avregistrert) continue;
      const name = personNameFromRolle(rolle);
      if (name) return name;
    }
  }

  return null;
}

function formatAntallAnsatte(candidate) {
  if (candidate.antallAnsatte != null && candidate.antallAnsatte !== '') {
    return String(candidate.antallAnsatte);
  }
  if (candidate.harRegistrertAntallAnsatte) {
    return 'Registrert (antall ikke oppgitt)';
  }
  return 'Not found';
}

function pickBusinessPhone(candidate) {
  const t = candidate.phone || candidate.mobil || '';
  return t.trim() || 'Not found';
}

module.exports = {
  gatherAllCandidates,
  searchCandidates,
  fetchEnhet,
  fetchRoller,
  extractContactPerson,
  formatAntallAnsatte,
  pickBusinessPhone,
  mapUnderenhet,
  mapEnhet,
};
