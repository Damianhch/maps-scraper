/**
 * Look up a person or company on 1881 public pages (HTML) or the official API.
 *
 * HTML flow: autocomplete → unique name+place match → one /tlf/{slug}_{id}/ page.
 * Official API is used instead when OPPLYSNINGEN_SUBSCRIPTION_KEY is set.
 */

const { loadEnv } = require('./ai-match');
const { normalizeName, normalizePhone } = require('./normalize');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const AUTOCOMPLETE_URL =
  'https://service.1881.no/autocompleteservice/autocomplete/getsuggestions';
const API_PERSON_URL = 'https://api.1881.no/search/v1/person/';
const API_COMPANY_URL = 'https://api.1881.no/search/v1/company/';

const AUTOCOMPLETE_DELAY_MS = 800;
const PAGE_DELAY_MS = 3500;
const MAX_SUGGESTIONS = 8;
const MAX_PAGES_TO_FETCH = 3;

const cookieJar = new Map();

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function get1881ApiKey() {
  loadEnv();
  return (
    process.env.OPPLYSNINGEN_SUBSCRIPTION_KEY ||
    process.env.API_1881_KEY ||
    process.env.API1881_KEY ||
    ''
  );
}

function foldName(s) {
  return normalizeName(s)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/æ/g, 'ae')
    .replace(/ø/g, 'o')
    .replace(/å/g, 'a');
}

function namesMatch(query, found) {
  const q = foldName(query).split(/\s+/).filter(Boolean);
  const f = foldName(found).split(/\s+/).filter(Boolean);
  if (q.length < 2 || f.length < 2) return false;
  if (q[0] !== f[0]) return false;
  if (q[q.length - 1] !== f[f.length - 1]) return false;
  return true;
}

function foldCompany(s) {
  return foldName(s)
    .replace(/\b(as|asa|ans|nuf|da|sa)\b/g, ' ')
    .replace(/&/g, ' og ')
    .replace(/\s+/g, ' ')
    .trim();
}

function companyNamesMatch(query, found) {
  const q = foldCompany(query);
  const f = foldCompany(found);
  if (!q || !f) return false;
  if (q === f) return true;
  if (q.length >= 4 && f.length >= 4 && (q.includes(f) || f.includes(q))) return true;
  const qt = q.split(' ').filter((t) => t.length >= 3);
  const ft = new Set(f.split(' ').filter((t) => t.length >= 3));
  if (!qt.length || !ft.size) return false;
  const overlap = qt.filter((t) => ft.has(t)).length;
  return overlap >= Math.min(2, qt.length) && overlap / qt.length >= 0.6;
}

function companyQueryVariants(name) {
  const raw = String(name || '').trim();
  const noForm = raw.replace(/\s+(AS|ASA|ANS|DA|NUF|SA)\s*$/i, '').trim();
  const noPunct = noForm.replace(/[&/+,]/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = noPunct.split(/\s+/).filter(Boolean);
  const variants = [raw, noForm, noPunct];
  if (tokens.length > 3) variants.push(tokens.slice(0, 3).join(' '));
  return [...new Set(variants.filter((v) => v.length >= 3))];
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&oslash;/gi, 'ø')
    .replace(/&aring;/gi, 'å')
    .replace(/&aelig;/gi, 'æ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function listingSlug(title, id) {
  const slug = String(title || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '');
  return `${slug}_${id}`;
}

function personSlug(title, id) {
  return listingSlug(title, id);
}

function padPostcode(raw) {
  const d = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (!d) return '';
  return d.padStart(4, '0').slice(-4);
}

function samePlace(a, b) {
  const na = foldName(a);
  const nb = foldName(b);
  return Boolean(na && nb && (na === nb || na.includes(nb) || nb.includes(na)));
}

function parseSuggestionTitle(title) {
  const parts = String(title || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    name: parts[0] || '',
    street: parts.length >= 3 ? parts.slice(1, -1).join(', ') : '',
    poststed: parts.length >= 2 ? parts[parts.length - 1] : '',
  };
}

function cookieHeader() {
  if (!cookieJar.size) return '';
  return [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

function storeCookies(res) {
  const raw =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : res.headers.get('set-cookie')
        ? [res.headers.get('set-cookie')]
        : [];
  for (const line of raw) {
    const pair = String(line || '').split(';')[0];
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    cookieJar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function isCaptcha(res, text) {
  const hay = `${res.url}\n${text.slice(0, 2500)}`;
  return /\/captcha|Blokkert|g-recaptcha|Just a moment/i.test(hay);
}

async function fetchText(url, extraHeaders = {}) {
  const headers = {
    Accept: 'text/html,application/json,text/javascript,*/*',
    'User-Agent': UA,
    Referer: 'https://www.1881.no/',
    ...extraHeaders,
  };
  const cookie = cookieHeader();
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(url, { headers, redirect: 'follow' });
  storeCookies(res);
  const text = await res.text();
  if (isCaptcha(res, text)) {
    const err = new Error('1881 returned a captcha/block page — slowing down or use the official API');
    err.code = 'CAPTCHA';
    throw err;
  }
  return { status: res.status, url: res.url, type: res.headers.get('content-type') || '', text };
}

function parseJsonMaybe(text) {
  const stripped = text.replace(/^[^(]*\(/, '').replace(/\)\s*;?\s*$/, '');
  try {
    return JSON.parse(text);
  } catch {
    try {
      return JSON.parse(stripped);
    } catch {
      return null;
    }
  }
}

function uniquePhonesFromHtml(html) {
  const telHrefs = [...html.matchAll(/href=["']tel:([^"']+)["']/gi)].map((m) => m[1]);
  const visible = [...html.matchAll(/listing-main-buttons__phone-number[^>]*>([\s\S]*?)<\/span>/gi)].map((m) =>
    decodeEntities(m[1])
  );
  const titlePhone = ((html.match(/<title>([^<]+)/i) || [])[1] || '').match(
    /,\s*((?:\+?47)?\s*\d[\d\s]{6,14})\s*(?:,|-)/
  );
  const out = [];
  for (const raw of [...telHrefs, ...visible, titlePhone ? titlePhone[1] : '']) {
    const n = normalizePhone(String(raw || ''));
    if (n.length === 8 && !out.includes(n)) out.push(n);
  }
  return out;
}

function uniqueEmailsFromHtml(html) {
  const skip = /@(1881|gulesider|google|facebook)\./i;
  const out = [];
  for (const m of html.matchAll(/mailto:([^"'?\s]+)/gi)) {
    const email = decodeEntities(m[1]).trim();
    if (!email || skip.test(email) || out.includes(email)) continue;
    out.push(email);
  }
  return out;
}

function websiteFromHtml(html) {
  const skip = /1881\.no|gulesider\.no|facebook\.com|instagram\.com|google\./i;
  for (const m of html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi)) {
    const url = m[1];
    if (!skip.test(url)) return url.split('?')[0];
  }
  return '';
}

function orgnrFromHtml(html) {
  const m = html.match(/org(?:anisasjons)?\.?\s*nr\.?\s*[:.]?\s*(\d{3}\s?\d{3}\s?\d{3}|\d{9})/i);
  return m ? m[1].replace(/\D/g, '') : '';
}

async function autocompleteRaw(query) {
  const q = encodeURIComponent(String(query || '').trim());
  if (!q) return [];
  const { status, text } = await fetchText(`${AUTOCOMPLETE_URL}?mode=search&q=${q}`);
  if (status !== 200) return [];
  const data = parseJsonMaybe(text);
  const rows = Array.isArray(data) ? data : data?.suggestions || data?.items || [];
  return rows
    .filter((r) => r.id)
    .slice(0, MAX_SUGGESTIONS)
    .map((r) => {
      const parsed = parseSuggestionTitle(r.title || r.value || r.name || '');
      return {
        id: String(r.id),
        title: String(r.title || r.value || r.name || '').trim(),
        value: String(r.value || r.title || '').trim(),
        category: String(r.category || r.type || '').trim(),
        lat: r.lat,
        lon: r.lon,
        ...parsed,
      };
    });
}

async function autocompletePerson(name) {
  await delay(AUTOCOMPLETE_DELAY_MS);
  const rows = await autocompleteRaw(name);
  return rows.filter((r) => r.category.toLowerCase() === 'person');
}

async function autocompleteCompany(name) {
  await delay(AUTOCOMPLETE_DELAY_MS);
  const rows = await autocompleteRaw(name);
  return rows.filter((r) => r.category.toLowerCase() === 'company');
}

function parsePersonHtml(html, suggestion) {
  const title = decodeEntities((html.match(/<title>([^<]+)/i) || [])[1] || '');
  const h1 = decodeEntities((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');
  const name = h1 || suggestion.title || title.split(',')[0].replace(/\s*-\s*1881.*$/i, '').trim();
  const phones = uniquePhonesFromHtml(html);
  const hidden = !phones.length && /vis[- ]?(nummer|telefon)|mobilsøk|mobilsoek|logg inn for å se/i.test(html);

  const addressBits = [];
  const listing = html.match(/listing-address[\s\S]{0,500}/i);
  if (listing) addressBits.push(decodeEntities(listing[0]));
  for (const m of html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)) {
    addressBits.push(decodeEntities(m[1]));
  }
  const addressText = addressBits.join(' | ');
  const postMatch = addressText.match(/\b(\d{4})\s+([A-ZÆØÅa-zæøå][A-ZÆØÅa-zæøå\- ]{1,40})/);
  const titlePlace = (title.match(/,\s*\d{8},\s*([^—\-]+?)\s*[-–]\s*1881/i) || [])[1];

  return {
    id: suggestion.id,
    name,
    phone: phones[0] || '',
    phones,
    hidden,
    postcode: postMatch ? postMatch[1] : '',
    poststed: (postMatch ? postMatch[2] : titlePlace || suggestion.poststed || '').trim(),
    url: `https://www.1881.no/tlf/${listingSlug(suggestion.title || name, suggestion.id)}/`,
    rawTitle: title,
  };
}

function parseCompanyHtml(html, suggestion) {
  const title = decodeEntities((html.match(/<title>([^<]+)/i) || [])[1] || '');
  const h1 = decodeEntities((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');
  const name = h1 || suggestion.value || suggestion.title || title.split(',')[0].replace(/\s*-\s*1881.*$/i, '').trim();
  const phones = uniquePhonesFromHtml(html);
  const emails = uniqueEmailsFromHtml(html);
  const website = websiteFromHtml(html);
  const orgnr = orgnrFromHtml(html);
  const hidden = !phones.length && /vis[- ]?(nummer|telefon)|logg inn for å se/i.test(html);
  return {
    id: suggestion.id,
    name,
    phone: phones[0] || '',
    phones,
    emails,
    website,
    orgnr,
    hidden,
    poststed: suggestion.poststed || '',
    url: suggestion.url || '',
    rawTitle: title,
  };
}

async function fetchListingPage(suggestion) {
  const slug = listingSlug(suggestion.title || suggestion.value || suggestion.name, suggestion.id);
  const { status, text, url } = await fetchText(`https://www.1881.no/tlf/${slug}/`);
  const missing =
    status !== 200 ||
    /sitemap|siden finnes ikke|page not found/i.test(
      text.slice(0, 800) + ((text.match(/<title>[^<]+/i) || [''])[0] || '')
    );
  return { status, text, url, missing };
}

async function fetchPersonPage(suggestion) {
  const { text, url, missing } = await fetchListingPage(suggestion);
  if (missing) {
    return {
      ...suggestion,
      name: suggestion.title,
      phone: '',
      phones: [],
      hidden: false,
      postcode: '',
      poststed: suggestion.poststed || '',
      url,
      missing: true,
    };
  }
  const parsed = parsePersonHtml(text, suggestion);
  parsed.url = url;
  return parsed;
}

async function fetchCompanyPage(suggestion) {
  const { text, url, missing } = await fetchListingPage(suggestion);
  if (missing) {
    return {
      ...suggestion,
      name: suggestion.value || suggestion.title,
      phone: '',
      phones: [],
      emails: [],
      website: '',
      orgnr: '',
      hidden: false,
      url,
      missing: true,
    };
  }
  const parsed = parseCompanyHtml(text, suggestion);
  parsed.url = url;
  return parsed;
}

function locationMatch(person, postcode, poststed) {
  const pc = padPostcode(postcode);
  if (pc && person.postcode && person.postcode === pc) return 'postcode';
  if (poststed && person.poststed && samePlace(person.poststed, poststed)) return 'poststed';
  return null;
}

function decideFromNamedPool(pool, { postcode, poststed, fallbackReason }) {
  const hiddenOnly = pool.filter((p) => p.hidden && !p.phone);
  const withPhone = pool.filter((p) => p.phone);
  const uniquePhones = [...new Set(withPhone.map((p) => p.phone))];

  if (!uniquePhones.length) {
    if (hiddenOnly.length) {
      return { status: 'phone-hidden', reason: 'vis_nummer', phone: '', hits: pool.length, person: pool[0] };
    }
    return { status: 'miss', reason: 'no_phone', phone: '', hits: pool.length };
  }
  if (uniquePhones.length > 1) {
    return { status: 'ambiguous', reason: 'multiple_phones', phone: '', hits: uniquePhones.length };
  }

  const winner = withPhone[0];
  return {
    status: 'hit',
    reason: locationMatch(winner, postcode, poststed) || fallbackReason || 'unique',
    phone: uniquePhones[0],
    phones: winner.phones || uniquePhones,
    person: winner,
    hits: pool.length,
  };
}

function pickUnique(people, { name, postcode, poststed }) {
  const named = people.filter((p) => !p.missing && namesMatch(name, p.name));
  if (!named.length) {
    return { status: 'miss', reason: 'no_name_match', phone: '', hits: people.length };
  }

  const located = named.filter((p) => locationMatch(p, postcode, poststed));
  if (located.length) {
    return decideFromNamedPool(located, { postcode, poststed, fallbackReason: 'unique' });
  }

  const fallbackReason = named.some((p) => p.postcode || p.poststed) ? 'wrong_place' : 'no_location';
  return decideFromNamedPool(named, { postcode, poststed, fallbackReason });
}

function filterSuggestionsForLookup(suggestions, { name, poststed, matcher }) {
  const named = suggestions.filter((s) => matcher(name, s.name || s.value || s.title));
  const located = poststed ? named.filter((s) => samePlace(s.poststed, poststed)) : [];
  if (located.length) return { pool: located, located: true };
  return { pool: named, located: false };
}

async function lookupPersonHtml(name, { postcode, poststed } = {}) {
  const suggestions = await autocompletePerson(name);
  if (!suggestions.length) {
    return { status: 'miss', reason: 'no_suggestions', phone: '', hits: 0, source: 'html' };
  }

  const { pool } = filterSuggestionsForLookup(suggestions, { name, poststed, matcher: namesMatch });
  if (!pool.length) {
    return { status: 'miss', reason: 'no_name_match', phone: '', hits: suggestions.length, source: 'html' };
  }
  if (pool.length > MAX_PAGES_TO_FETCH) {
    return {
      status: 'ambiguous',
      reason: 'too_many_suggestions',
      phone: '',
      hits: pool.length,
      source: 'html',
      suggestions: suggestions.length,
    };
  }

  const people = [];
  for (const s of pool) {
    await delay(PAGE_DELAY_MS);
    people.push(await fetchPersonPage(s));
  }
  const picked = pickUnique(people, { name, postcode, poststed });
  picked.source = 'html';
  picked.suggestions = suggestions.length;
  return picked;
}

function parseApiContacts(item) {
  const contacts = item?.contacts || item?.ContactPoints || item?.phoneNumbers || [];
  const list = Array.isArray(contacts) ? contacts : [];
  const numbers = [];
  for (const c of list) {
    const raw = c?.value || c?.number || c?.phone || c;
    const n = normalizePhone(String(raw || ''));
    if (n.length === 8 && !numbers.includes(n)) numbers.push(n);
  }
  if (!numbers.length && item?.phone) {
    const n = normalizePhone(String(item.phone));
    if (n.length === 8) numbers.push(n);
  }
  return numbers;
}

function personFromApiItem(item) {
  const name =
    item?.name ||
    [item?.firstName, item?.middleName, item?.lastName].filter(Boolean).join(' ') ||
    '';
  const addr = item?.address || item?.geography || {};
  const postcode = padPostcode(addr.postCode || addr.postcode || addr.zip || item?.postCode);
  const poststed = String(addr.postArea || addr.city || addr.poststed || item?.postArea || '').trim();
  const phones = parseApiContacts(item);
  return {
    id: String(item?.id || item?.pid || ''),
    name,
    phone: phones[0] || '',
    phones,
    hidden: !phones.length,
    postcode,
    poststed,
    url: '',
  };
}

async function lookupPersonApi(name, { postcode, poststed } = {}, apiKey) {
  const q = encodeURIComponent(String(name || '').trim());
  const { status, text } = await fetchText(`${API_PERSON_URL}?querystring=${q}`, {
    'Ocp-Apim-Subscription-Key': apiKey,
    Accept: 'application/json',
  });
  if (status === 401 || status === 403) {
    return { status: 'miss', reason: 'api_unauthorized', phone: '', hits: 0, source: 'api' };
  }
  if (status !== 200) {
    return { status: 'miss', reason: `api_${status}`, phone: '', hits: 0, source: 'api' };
  }
  const data = parseJsonMaybe(text) || {};
  const items = data.items || data.Persons || data.results || data || [];
  const people = (Array.isArray(items) ? items : []).slice(0, MAX_SUGGESTIONS).map(personFromApiItem);
  const picked = pickUnique(people, { name, postcode, poststed });
  picked.source = 'api';
  picked.suggestions = people.length;
  return picked;
}

/**
 * Look up one person. Returns { status, reason, phone, person, source }.
 * status: hit | miss | ambiguous | phone-hidden
 */
async function lookupPerson(name, geo = {}) {
  const apiKey = get1881ApiKey();
  if (apiKey) return lookupPersonApi(name, geo, apiKey);
  return lookupPersonHtml(name, geo);
}

function companyFromApiItem(item) {
  const name = item?.name || item?.companyName || '';
  const addr = item?.address || {};
  const phones = parseApiContacts(item);
  return {
    id: String(item?.id || ''),
    name,
    phone: phones[0] || '',
    phones,
    emails: [].concat(item?.email || item?.emails || []).filter(Boolean),
    website: item?.homePage || item?.website || '',
    orgnr: String(item?.organizationNumber || item?.orgnr || '').replace(/\D/g, ''),
    poststed: String(addr.postArea || addr.city || item?.postArea || '').trim(),
    hidden: !phones.length,
    missing: false,
  };
}

function decideCompanyPool(pool, { poststed, orgnr, fallbackReason }) {
  const orgMatch = orgnr
    ? pool.filter((c) => c.orgnr && String(c.orgnr).replace(/\D/g, '') === String(orgnr).replace(/\D/g, ''))
    : [];
  const use = orgMatch.length ? orgMatch : pool;
  const withPhone = use.filter((c) => c.phone);
  const uniquePhones = [...new Set(withPhone.flatMap((c) => c.phones || [c.phone]).filter(Boolean))];
  if (!uniquePhones.length) {
    if (use.some((c) => c.hidden)) {
      return { status: 'phone-hidden', reason: 'vis_nummer', phone: '', hits: use.length, company: use[0] };
    }
    return { status: 'miss', reason: 'no_phone', phone: '', hits: use.length, company: use[0] };
  }
  if (use.length > 1 && uniquePhones.length > 1 && !orgMatch.length) {
    return { status: 'ambiguous', reason: 'multiple_companies', phone: '', hits: use.length };
  }
  const winner = withPhone[0] || use[0];
  const placeHit = poststed && winner.poststed && samePlace(winner.poststed, poststed);
  return {
    status: 'hit',
    reason: orgMatch.length ? 'orgnr' : placeHit ? 'poststed' : fallbackReason || 'unique',
    phone: winner.phone || uniquePhones[0],
    phones: winner.phones || uniquePhones,
    emails: winner.emails || [],
    website: winner.website || '',
    orgnr: winner.orgnr || '',
    company: winner,
    hits: use.length,
  };
}

async function lookupCompanyHtml(name, { poststed, orgnr } = {}) {
  let suggestions = [];
  for (const q of companyQueryVariants(name)) {
    suggestions = await autocompleteCompany(q);
    if (suggestions.length) break;
  }
  if (!suggestions.length) {
    return { status: 'miss', reason: 'no_suggestions', phone: '', hits: 0, source: 'html' };
  }

  const { pool, located } = filterSuggestionsForLookup(suggestions, {
    name,
    poststed,
    matcher: companyNamesMatch,
  });
  if (!pool.length) {
    return { status: 'miss', reason: 'no_name_match', phone: '', hits: suggestions.length, source: 'html' };
  }
  if (pool.length > MAX_PAGES_TO_FETCH) {
    return {
      status: 'ambiguous',
      reason: 'too_many_suggestions',
      phone: '',
      hits: pool.length,
      source: 'html',
      suggestions: suggestions.length,
    };
  }

  const companies = [];
  for (const s of pool) {
    await delay(PAGE_DELAY_MS);
    companies.push(await fetchCompanyPage(s));
  }
  const picked = decideCompanyPool(
    companies.filter((c) => !c.missing),
    { poststed, orgnr, fallbackReason: located ? 'poststed' : 'unique' }
  );
  picked.source = 'html';
  picked.suggestions = suggestions.length;
  return picked;
}

async function lookupCompanyApi(name, { poststed, orgnr } = {}, apiKey) {
  const q = encodeURIComponent(String(name || '').trim());
  const { status, text } = await fetchText(`${API_COMPANY_URL}?querystring=${q}`, {
    'Ocp-Apim-Subscription-Key': apiKey,
    Accept: 'application/json',
  });
  if (status === 401 || status === 403) {
    return { status: 'miss', reason: 'api_unauthorized', phone: '', hits: 0, source: 'api' };
  }
  if (status !== 200) {
    return { status: 'miss', reason: `api_${status}`, phone: '', hits: 0, source: 'api' };
  }
  const data = parseJsonMaybe(text) || {};
  const items = data.items || data.Companies || data.results || data || [];
  const companies = (Array.isArray(items) ? items : []).slice(0, MAX_SUGGESTIONS).map(companyFromApiItem);
  const named = companies.filter((c) => companyNamesMatch(name, c.name));
  const located = poststed ? named.filter((c) => samePlace(c.poststed, poststed)) : [];
  const picked = decideCompanyPool(located.length ? located : named, {
    poststed,
    orgnr,
    fallbackReason: located.length ? 'poststed' : 'unique',
  });
  picked.source = 'api';
  picked.suggestions = companies.length;
  return picked;
}

async function lookupCompany(name, geo = {}) {
  const apiKey = get1881ApiKey();
  if (apiKey) return lookupCompanyApi(name, geo, apiKey);
  return lookupCompanyHtml(name, geo);
}

async function probeGulesider(name, geo = {}) {
  const q = encodeURIComponent(`${name} ${geo.poststed || ''}`.trim());
  try {
    const res = await fetch(`https://www.gulesider.no/finn:${q}`, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
      redirect: 'follow',
    });
    const text = await res.text();
    if (res.status === 403 || /just a moment|cf-challenge|cloudflare/i.test(text)) {
      return { status: 'blocked', reason: 'cloudflare', phone: '', source: 'gulesider' };
    }
    const phones = [...text.matchAll(/\b(\d[\d\s]{6,12}\d)\b/g)]
      .map((m) => normalizePhone(m[1]))
      .filter((n) => n.length === 8);
    if (!phones.length) {
      return { status: /vis[- ]nummer/i.test(text) ? 'phone-hidden' : 'miss', reason: 'no_phone', phone: '', source: 'gulesider' };
    }
    return { status: 'hit', reason: 'html_digits', phone: phones[0], source: 'gulesider' };
  } catch (err) {
    return { status: 'blocked', reason: err.message, phone: '', source: 'gulesider' };
  }
}

module.exports = {
  lookupPerson,
  lookupPersonHtml,
  lookupPersonApi,
  lookupCompany,
  lookupCompanyHtml,
  lookupCompanyApi,
  autocompletePerson,
  autocompleteCompany,
  probeGulesider,
  namesMatch,
  companyNamesMatch,
  companyQueryVariants,
  parseSuggestionTitle,
  padPostcode,
  get1881ApiKey,
  PAGE_DELAY_MS,
  uniquePhonesFromHtml,
  parseCompanyHtml,
};
