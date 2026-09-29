/**
 * Brreg Enhetsregisteret API client.
 */

const { addressKeyFromBrreg } = require('./normalize');

const BASE = 'https://data.brreg.no/enhetsregisteret/api';
/** Street-only queries (no house no.) — busy strips can have 100+ entities in one postcode */
const MAX_PAGES_STREET = 12;
/** Street fallback query (generalized street search) — paginate a bit deeper still */
const MAX_PAGES_STREET_BUSY = 14;
/** Address query includes a house number — fetch enough pages to cover the building */
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

async function brregFetch(path, timeoutMs = 30000, attempt = 0) {
  await throttle();
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      const backoffMs = 1500 * (attempt + 1);
      await delay(backoffMs);
      return brregFetch(path, timeoutMs, attempt + 1);
    }
    if (!res.ok) {
      throw new Error(`Brreg HTTP ${res.status}: ${url}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAllPages(buildUrl, maxPages = MAX_PAGES_STREET) {
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

function maxPagesForAddressQuery(adresse, { streetBusy = false } = {}) {
  if (!adresse || typeof adresse !== 'string') return MAX_PAGES_STREET;
  if (/\d/.test(adresse)) return MAX_PAGES_SPECIFIC_ADDRESS;
  return streetBusy ? MAX_PAGES_STREET_BUSY : MAX_PAGES_STREET;
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
    slettedato: u.slettedato || '',
    rawAddressLine: Array.isArray(addr?.adresse) ? addr.adresse[0] : '',
    foundViaNameSearch: meta.foundViaNameSearch || false,
    foundViaNationalNameSearch: meta.foundViaNationalNameSearch || false,
    foundViaAddressSearch: meta.foundViaAddressSearch || false,
  };
}

function formatBrregAddress(addr) {
  if (!addr) return '';
  const line = Array.isArray(addr.adresse)
    ? addr.adresse.filter(Boolean).join(', ')
    : addr.adresse || '';
  const city = [addr.postnummer, addr.poststed].filter(Boolean).join(' ');
  return [line, city].filter(Boolean).join(', ');
}

function joinTextList(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join('; ');
  return value ? String(value) : '';
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
    kommune: addr?.kommune || '',
    kommunenummer: addr?.kommunenummer || '',
    phone: e.telefon || '',
    mobil: e.mobil || '',
    epost: e.epostadresse || '',
    hjemmeside: e.hjemmeside || '',
    orgFormKode: e.organisasjonsform?.kode || '',
    orgFormBeskrivelse: e.organisasjonsform?.beskrivelse || '',
    naceKode: e.naeringskode1?.kode || '',
    naceBeskrivelse: e.naeringskode1?.beskrivelse || '',
    naceKode2: e.naeringskode2?.kode || '',
    naceBeskrivelse2: e.naeringskode2?.beskrivelse || '',
    antallAnsatte: e.antallAnsatte,
    harRegistrertAntallAnsatte: e.harRegistrertAntallAnsatte,
    registrertIMvaregisteret: e.registrertIMvaregisteret,
    stiftelsesdato: e.stiftelsesdato || '',
    registreringsdato: e.registreringsdatoEnhetsregisteret || '',
    aktivitet: joinTextList(e.aktivitet),
    formaal: joinTextList(e.vedtektsfestetFormaal),
    konkurs: Boolean(e.konkurs),
    underAvvikling: Boolean(e.underAvvikling),
    overordnetEnhet: null,
    rawAddressLine: Array.isArray(addr?.adresse) ? addr.adresse[0] : '',
    formattedAddress: formatBrregAddress(addr),
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
    const isStreetBusy = Boolean(maps.brregStreetQuery && aq === maps.brregStreetQuery);
    const deepPages = maxPagesForAddressQuery(aq, { streetBusy: isStreetBusy });
    const [under, enheter] = await Promise.all([
      searchUnderenheterByAddress(aq, postcode, deepPages),
      searchEnheterByAddress(aq, postcode, deepPages),
    ]);
    mergeCandidates(byOrnr, under, { foundViaAddressSearch: true });
    mergeCandidates(byOrnr, enheter, { foundViaAddressSearch: true });
    if (isStreetBusy || deepPages > MAX_PAGES_STREET) {
      log(
        `  📄 Address "${aq}": ${deepPages} pages → ${under.length + enheter.length} hits (this query)`
      );
    }
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
    searchUnderenheterByAddress(adresse, postnummer, MAX_PAGES_STREET),
    searchEnheterByAddress(adresse, postnummer, MAX_PAGES_STREET),
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

async function fetchUnderenheterByParent(orgnr) {
  const n = String(orgnr || '').replace(/\D/g, '');
  if (n.length !== 9) return [];
  try {
    const items = await fetchAllPages(
      (page) => `/underenheter?overordnetEnhet=${n}&page=${page}&size=${PAGE_SIZE}`,
      6
    );
    return items.map((u) => mapUnderenhet(u));
  } catch {
    return [];
  }
}

const ROLE_PRIORITY = [
  { group: 'DAGL', type: 'DAGL' },
  { group: 'INNH', type: 'INNH' },
  { group: 'STYR', type: 'LEDE' },
  { group: 'STYR', type: null },
];

function personNameFromRolle(rolle) {
  const n = rolle?.person?.navn;
  if (!n) return null;
  const parts = [n.fornavn, n.mellomnavn, n.etternavn].filter(Boolean);
  return parts.join(' ').trim() || null;
}

function roleCodeFromRolle(rg, rolle) {
  return rolle?.type?.kode || rg?.type?.kode || '';
}

function extractContactPersons(rollerData) {
  if (!rollerData?.rollegrupper) return [];
  const seen = new Set();
  const out = [];

  function add(rg, rolle, role) {
    if (rolle.fratraadt || rolle.avregistrert) return;
    const name = personNameFromRolle(rolle);
    if (!name) return;
    const key = name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      name,
      role: role || roleCodeFromRolle(rg, rolle),
    });
  }

  for (const { group, type } of ROLE_PRIORITY) {
    const rg = rollerData.rollegrupper.find((g) => g.type?.kode === group);
    if (!rg?.roller?.length) continue;
    for (const rolle of rg.roller) {
      if (type && rolle.type?.kode !== type) continue;
      add(rg, rolle, type || group);
    }
  }

  for (const rg of rollerData.rollegrupper) {
    for (const rolle of rg.roller || []) {
      add(rg, rolle, roleCodeFromRolle(rg, rolle));
    }
  }

  return out;
}

function extractContactPerson(rollerData) {
  return extractContactPersons(rollerData)[0]?.name || null;
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

function pickEmail(candidate) {
  const t = candidate.epost || '';
  return t.trim() || 'Not found';
}

function pickWebsite(candidate) {
  const t = candidate.hjemmeside || '';
  return t.trim() || 'Not found';
}

function isoDateDaysAgo(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function isoDateToday() {
  return new Date().toISOString().slice(0, 10);
}

function buildEnheterFilterParams(filters = {}, page = 0, size = PAGE_SIZE) {
  const params = new URLSearchParams();
  const {
    fraStiftelsesdato,
    tilStiftelsesdato,
    fraRegistreringsdato,
    tilRegistreringsdato,
    naeringskode,
    organisasjonsform,
    kommunenummer,
    konkurs = false,
    underAvvikling = false,
    underTvangsavviklingEllerTvangsopplosning = false,
  } = filters;

  if (fraStiftelsesdato) params.set('fraStiftelsesdato', fraStiftelsesdato);
  if (tilStiftelsesdato) params.set('tilStiftelsesdato', tilStiftelsesdato);
  if (fraRegistreringsdato) {
    params.set('fraRegistreringsdatoEnhetsregisteret', fraRegistreringsdato);
  }
  if (tilRegistreringsdato) {
    params.set('tilRegistreringsdatoEnhetsregisteret', tilRegistreringsdato);
  }
  if (naeringskode) {
    params.set(
      'naeringskode',
      Array.isArray(naeringskode) ? naeringskode.join(',') : naeringskode
    );
  }
  if (organisasjonsform) {
    params.set(
      'organisasjonsform',
      Array.isArray(organisasjonsform) ? organisasjonsform.join(',') : organisasjonsform
    );
  }
  if (kommunenummer) {
    params.set(
      'forretningsadresse.kommunenummer',
      Array.isArray(kommunenummer) ? kommunenummer.join(',') : kommunenummer
    );
  }
  if (konkurs != null) params.set('konkurs', String(konkurs));
  if (underAvvikling != null) params.set('underAvvikling', String(underAvvikling));
  if (underTvangsavviklingEllerTvangsopplosning != null) {
    params.set(
      'underTvangsavviklingEllerTvangsopplosning',
      String(underTvangsavviklingEllerTvangsopplosning)
    );
  }
  params.set('page', String(page));
  params.set('size', String(size));
  return params;
}

/**
 * List entities by date + NACE + org form. Splits the date window if a query
 * would exceed Brreg's 10 000-result pagination cap.
 */
async function searchEnheterByFilters(filters = {}, options = {}) {
  const pageSize = options.pageSize || 100;
  const maxResults = options.maxResults || 10000;
  const first = await brregFetch(
    `/enheter?${buildEnheterFilterParams(filters, 0, pageSize)}`
  );
  const totalElements = first.page?.totalElements ?? 0;
  const firstBatch = first._embedded?.enheter || [];

  if (totalElements > 10000) {
    const from = filters.fraRegistreringsdato || filters.fraStiftelsesdato;
    const to = filters.tilRegistreringsdato || filters.tilStiftelsesdato;
    if (from && to && from < to) {
      const mid = splitIsoDateRange(from, to);
      const leftFilters = { ...filters };
      const rightFilters = { ...filters };
      if (filters.fraRegistreringsdato) {
        leftFilters.tilRegistreringsdato = mid.leftTo;
        rightFilters.fraRegistreringsdato = mid.rightFrom;
      } else {
        leftFilters.tilStiftelsesdato = mid.leftTo;
        rightFilters.fraStiftelsesdato = mid.rightFrom;
      }
      const [left, right] = await Promise.all([
        searchEnheterByFilters(leftFilters, options),
        searchEnheterByFilters(rightFilters, options),
      ]);
      return {
        items: [...left.items, ...right.items],
        totalElements: left.totalElements + right.totalElements,
        truncated: left.truncated || right.truncated,
      };
    }
  }

  const items = [...firstBatch];
  const totalPages = Math.min(first.page?.totalPages ?? 1, Math.floor(10000 / pageSize));
  for (let page = 1; page < totalPages && items.length < maxResults; page++) {
    const data = await brregFetch(
      `/enheter?${buildEnheterFilterParams(filters, page, pageSize)}`
    );
    const batch = data._embedded?.enheter || [];
    items.push(...batch);
    if (batch.length === 0) break;
  }

  return {
    items: items.slice(0, maxResults),
    totalElements,
    truncated: items.length < totalElements && items.length >= maxResults,
  };
}

function splitIsoDateRange(from, to) {
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  const midMs = start.getTime() + Math.floor((end.getTime() - start.getTime()) / 2);
  const mid = new Date(midMs).toISOString().slice(0, 10);
  const right = new Date(midMs + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return { leftTo: mid, rightFrom: right > to ? to : right };
}

module.exports = {
  gatherAllCandidates,
  searchCandidates,
  searchEnheterByFilters,
  fetchEnhet,
  fetchRoller,
  fetchUnderenheterByParent,
  extractContactPerson,
  extractContactPersons,
  formatAntallAnsatte,
  formatBrregAddress,
  pickBusinessPhone,
  pickEmail,
  pickWebsite,
  mapUnderenhet,
  mapEnhet,
  isoDateDaysAgo,
  isoDateToday,
};
