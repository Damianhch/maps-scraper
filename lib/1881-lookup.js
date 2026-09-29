/**
 * Look up a person's listed Norwegian number on 1881 public person pages.
 *
 * Flow: autocomplete name → fetch /tlf/{slug}_{id}/ → parse tel + address.
 * Accept only a unique name match in the same postcode or poststed.
 * Official API is used instead when OPPLYSNINGEN_SUBSCRIPTION_KEY is set.
 */

const { loadEnv } = require('./ai-match');
const { normalizeName, normalizePhone } = require('./normalize');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const AUTOCOMPLETE_URL =
  'https://service.1881.no/autocompleteservice/autocomplete/getsuggestions';
const API_PERSON_URL = 'https://api.1881.no/search/v1/person/';

const AUTOCOMPLETE_DELAY_MS = 400;
const PAGE_DELAY_MS = 1500;
const MAX_SUGGESTIONS = 8;

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

function personSlug(title, id) {
  const slug = String(title || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '');
  return `${slug}_${id}`;
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

async function fetchText(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: {
      Accept: 'text/html,application/json,text/javascript,*/*',
      'User-Agent': UA,
      Referer: 'https://www.1881.no/',
      ...extraHeaders,
    },
    redirect: 'follow',
  });
  const text = await res.text();
  if (/Blokkert|g-recaptcha|Just a moment/i.test(text) && /captcha/i.test(res.url + text.slice(0, 2000))) {
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

async function autocompletePerson(name) {
  const q = encodeURIComponent(String(name || '').trim());
  if (!q) return [];
  const { status, text } = await fetchText(`${AUTOCOMPLETE_URL}?mode=search&q=${q}`);
  if (status !== 200) return [];
  const data = parseJsonMaybe(text);
  const rows = Array.isArray(data) ? data : data?.suggestions || data?.items || [];
  return rows
    .filter((r) => String(r.category || r.type || '').toLowerCase() === 'person' && r.id)
    .slice(0, MAX_SUGGESTIONS)
    .map((r) => ({
      id: String(r.id),
      title: String(r.title || r.value || r.name || '').trim(),
    }));
}

function parsePersonHtml(html, suggestion) {
  const title = decodeEntities((html.match(/<title>([^<]+)/i) || [])[1] || '');
  const h1 = decodeEntities((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '');
  const name = h1 || suggestion.title || title.split(',')[0].replace(/\s*-\s*1881.*$/i, '').trim();

  const telHrefs = [...html.matchAll(/href=["']tel:([^"']+)["']/gi)].map((m) => m[1]);
  const visible = [...html.matchAll(/listing-main-buttons__phone-number[^>]*>([\s\S]*?)<\/span>/gi)].map((m) =>
    decodeEntities(m[1])
  );
  const titlePhone = (title.match(/,\s*((?:\+?47)?\s*\d[\d\s]{6,14})\s*(?:,|-)/) || [])[1];

  let phone = '';
  for (const raw of [...telHrefs, ...visible, titlePhone]) {
    const n = normalizePhone(String(raw || ''));
    if (n.length === 8) {
      phone = n;
      break;
    }
  }

  const hidden =
    !phone &&
    /vis[- ]?(nummer|telefon)|mobilsøk|mobilsoek|logg inn for å se/i.test(html);

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
    phone,
    hidden,
    postcode: postMatch ? postMatch[1] : '',
    poststed: (postMatch ? postMatch[2] : titlePlace || '').trim(),
    url: `https://www.1881.no/tlf/${personSlug(suggestion.title || name, suggestion.id)}/`,
    rawTitle: title,
  };
}

async function fetchPersonPage(suggestion) {
  const slug = personSlug(suggestion.title, suggestion.id);
  const { status, text, url } = await fetchText(`https://www.1881.no/tlf/${slug}/`);
  if (status !== 200 || /sitemap|siden finnes ikke|page not found/i.test(text.slice(0, 800) + (text.match(/<title>[^<]+/i) || [''])[0])) {
    return { ...suggestion, name: suggestion.title, phone: '', hidden: false, postcode: '', poststed: '', url, missing: true };
  }
  const parsed = parsePersonHtml(text, suggestion);
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

async function lookupPersonHtml(name, { postcode, poststed } = {}) {
  await delay(AUTOCOMPLETE_DELAY_MS);
  const suggestions = await autocompletePerson(name);
  if (!suggestions.length) {
    return { status: 'miss', reason: 'no_suggestions', phone: '', hits: 0, source: 'html' };
  }

  const people = [];
  for (const s of suggestions) {
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
    if (n.length === 8) numbers.push(n);
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
  autocompletePerson,
  probeGulesider,
  namesMatch,
  padPostcode,
  get1881ApiKey,
  PAGE_DELAY_MS,
};
