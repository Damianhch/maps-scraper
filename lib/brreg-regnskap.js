/**
 * Brreg Regnskapsregisteret — latest filed annual accounts (open API).
 * Revenue is sumDriftsinntekter on the company (SELSKAP) statement.
 */

const fs = require('fs');
const path = require('path');
const { fetchUnderenhet } = require('./brreg');

const REGNSKAP_BASE = 'https://data.brreg.no/regnskapsregisteret/regnskap';
const CACHE_PATH = path.join(__dirname, '..', 'cache', 'regnskap.json');

let cache = null;

function loadCache() {
  if (cache) return cache;
  try {
    if (fs.existsSync(CACHE_PATH)) {
      cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    } else {
      cache = {};
    }
  } catch {
    cache = {};
  }
  return cache;
}

function saveCache() {
  if (!cache) return;
  const dir = path.dirname(CACHE_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
}

function emptyFinancials() {
  return {
    accountingOrgnr: '',
    revenueNok: null,
    revenueYear: '',
    operatingProfit: null,
    netProfit: null,
    equity: null,
    accountingType: '',
    accountingStatus: 'no_orgnr',
  };
}

function pickLatestSelskap(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const selskap = list.filter((r) => r.regnskapstype === 'SELSKAP');
  const pool = selskap.length ? selskap : list;
  return [...pool].sort((a, b) =>
    String(b.regnskapsperiode?.tilDato || '').localeCompare(String(a.regnskapsperiode?.tilDato || ''))
  )[0];
}

function extractFinancials(regnskap, accountingOrgnr) {
  if (!regnskap) {
    return {
      ...emptyFinancials(),
      accountingOrgnr: accountingOrgnr || '',
      accountingStatus: 'no_accounts',
    };
  }
  const dr = regnskap.resultatregnskapResultat?.driftsresultat;
  return {
    accountingOrgnr: accountingOrgnr || '',
    revenueNok: dr?.driftsinntekter?.sumDriftsinntekter ?? null,
    revenueYear: (regnskap.regnskapsperiode?.tilDato || '').slice(0, 4),
    operatingProfit: dr?.driftsresultat ?? null,
    netProfit: regnskap.resultatregnskapResultat?.aarsresultat ?? null,
    equity: regnskap.egenkapitalGjeld?.egenkapital?.sumEgenkapital ?? null,
    accountingType: regnskap.regnskapstype || '',
    accountingStatus: dr?.driftsinntekter?.sumDriftsinntekter != null ? 'ok' : 'no_revenue_field',
  };
}

function digits9(value) {
  const d = String(value || '').replace(/\D/g, '');
  return d.length === 9 ? d : '';
}

async function resolveAccountingOrgnr(orgnr, orgForm, parentOrgnr) {
  const parent = digits9(parentOrgnr);
  if (parent) return parent;

  const clean = digits9(orgnr);
  if (!clean) return '';

  const form = String(orgForm || '').toUpperCase();
  if (form === 'BEDR' || form === 'AAFY') {
    try {
      const unit = await fetchUnderenhet(clean);
      return digits9(unit?.overordnetEnhet) || clean;
    } catch {
      return clean;
    }
  }
  return clean;
}

let accQueue = Promise.resolve();
let accLastAt = 0;
const ACC_DELAY_MS = 70;

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function accThrottle() {
  accQueue = accQueue.then(async () => {
    const wait = ACC_DELAY_MS - (Date.now() - accLastAt);
    if (wait > 0) await delay(wait);
    accLastAt = Date.now();
  });
  return accQueue;
}

async function fetchRegnskapList(orgnr) {
  const clean = digits9(orgnr);
  if (!clean) return null;
  const store = loadCache();
  if (Object.prototype.hasOwnProperty.call(store, clean)) {
    return store[clean];
  }

  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
    await accThrottle();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 30000);
      const res = await fetch(`${REGNSKAP_BASE}/${clean}`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.status === 404) {
        store[clean] = null;
        return null;
      }
      if (res.status === 429 || res.status >= 500) {
        await delay(1200 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        throw new Error(`Regnskap HTTP ${res.status}`);
      }
      const data = await res.json();
      store[clean] = data;
      if (Object.keys(store).length % 50 === 0) saveCache();
      return data;
    } catch (err) {
      lastErr = err;
      await delay(800 * (attempt + 1));
    }
  }
  throw lastErr || new Error(`Regnskap failed for ${clean}`);
}

async function fetchFinancialsForOrgnr(orgnr, orgForm, parentOrgnr) {
  const accountingOrgnr = await resolveAccountingOrgnr(orgnr, orgForm, parentOrgnr);
  if (!accountingOrgnr) return emptyFinancials();
  try {
    const list = await fetchRegnskapList(accountingOrgnr);
    return extractFinancials(pickLatestSelskap(list), accountingOrgnr);
  } catch (err) {
    return {
      ...emptyFinancials(),
      accountingOrgnr,
      accountingStatus: `error: ${err.message}`,
    };
  }
}

function flushRegnskapCache() {
  saveCache();
}

module.exports = {
  fetchFinancialsForOrgnr,
  resolveAccountingOrgnr,
  fetchRegnskapList,
  pickLatestSelskap,
  extractFinancials,
  emptyFinancials,
  flushRegnskapCache,
  digits9,
};
