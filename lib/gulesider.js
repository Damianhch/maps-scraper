/**
 * Gule Sider lookup via Puppeteer (Cloudflare blocks plain fetch).
 * Parses the company profile page — never harvests random 8-digit strings from JS.
 */

const { normalizePhone } = require('./normalize');
const { companyNamesMatch } = require('./1881-lookup');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const state = {
  blocked: 0,
  skip: false,
  browser: null,
  page: null,
  cookiesAccepted: false,
  lookups: 0,
};

function skipRemaining() {
  state.skip = true;
}

function parseCompanyPageText(text) {
  const t = String(text || '');
  const orgnr = ((t.match(/Org\.?\s*nr:?\s*(\d{9})/i) || [])[1] || '').replace(/\D/g, '');
  const phoneFaq = (t.match(/følgende nummer\.\s*(\d{8})/i) || [])[1] || '';
  const formatted = (t.match(/\b(\d{2}\s\d{2}\s\d{2}\s\d{2})\b/) || [])[1] || '';
  const truncated = /\b\d{2}\s\d{2}\s\d{2}\.\.\./.test(t);
  let phone = normalizePhone(phoneFaq || formatted);
  if (phone.length !== 8) phone = '';

  const dagl = ((t.match(/Daglig leder\s+([^\n]+)/i) || [])[1] || '').trim();
  const lede = ((t.match(/Styrets leder\s+([^\n]+)/i) || [])[1] || '').trim();
  const website = ((t.match(/Hjemmeside\s+(https?:\/\/\S+)/i) || [])[1] || '').trim();
  const email = ((t.match(/E-post\s+(\S+@\S+)/i) || [])[1] || '').trim();

  if (!phone) {
    return {
      status: truncated ? 'phone-hidden' : 'miss',
      reason: truncated ? 'truncated' : 'no_phone',
      phone: '',
      phones: [],
      emails: email ? [email] : [],
      website,
      orgnr,
      dagligLeder: dagl,
      styreleder: lede,
      source: 'gulesider',
    };
  }
  return {
    status: 'hit',
    reason: phoneFaq ? 'profile-faq' : 'formatted',
    phone,
    phones: [phone],
    emails: email ? [email] : [],
    website,
    orgnr,
    dagligLeder: dagl,
    styreleder: lede,
    source: 'gulesider-puppeteer',
  };
}

function listingHrefFromSearch(html, name) {
  const re = /href="(\/[^"]+\/\d+\/bedrift)"/gi;
  const hrefs = [...html.matchAll(re)].map((m) => m[1]);
  if (!hrefs.length) return '';
    const named = hrefs.find((h) => {
    const slug = decodeURIComponent(h.split('/')[1] || '').replace(/\+/g, ' ');
    return companyNamesMatch(name, slug);
  });
  if (named) return named;
  return hrefs.length === 1 ? hrefs[0] : '';
}

async function getBrowserPage() {
  if (state.page) return state.page;
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    return null;
  }
  state.browser = await puppeteer.launch({
    headless: true,
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  state.page = await state.browser.newPage();
  await state.page.setUserAgent(UA);
  await state.page.setViewport({ width: 1365, height: 900 });
  return state.page;
}

async function acceptCookies(page) {
  if (state.cookiesAccepted) return;
  await page
    .evaluate(() => {
      const btns = [...document.querySelectorAll('button, [role="button"]')];
      const allow = btns.find((b) => /tillat alle|allow all/i.test(b.textContent || ''));
      if (allow) allow.click();
    })
    .catch(() => {});
  state.cookiesAccepted = true;
  await new Promise((r) => setTimeout(r, 800));
}

async function closeGulesiderBrowser() {
  if (state.browser) {
    try {
      await state.browser.close();
    } catch {
      /* ignore */
    }
  }
  state.browser = null;
  state.page = null;
  state.cookiesAccepted = false;
}

function searchUrl(name, poststed) {
  const q = `${name || ''} ${poststed || ''}`.trim();
  return `https://www.gulesider.no/finn:${encodeURIComponent(q)}`;
}

async function lookupGulesider(name, geo = {}) {
  if (state.skip) {
    return { status: 'blocked', reason: 'skipped_after_cloudflare', phone: '', source: 'gulesider' };
  }
  if (state.lookups >= 40) {
    await closeGulesiderBrowser();
    state.lookups = 0;
  }
  const page = await getBrowserPage();
  if (!page) {
    return { status: 'blocked', reason: 'no_puppeteer', phone: '', source: 'gulesider' };
  }
  state.lookups += 1;
  try {
    await page.goto(searchUrl(name, geo.poststed), { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => !/just a moment/i.test(document.title), { timeout: 20000 }).catch(() => {});
    const title = await page.title();
    if (/just a moment/i.test(title)) {
      state.blocked += 1;
      if (state.blocked >= 2) skipRemaining();
      return { status: 'blocked', reason: 'cloudflare', phone: '', source: 'gulesider' };
    }
    await acceptCookies(page);
    await new Promise((r) => setTimeout(r, 1500));

    const html = await page.content();
    const href = listingHrefFromSearch(html, name);
    if (href) {
      await page.goto(`https://www.gulesider.no${href}`, {
        waitUntil: 'domcontentloaded',
        timeout: 45000,
      });
      await new Promise((r) => setTimeout(r, 2000));
    }

    const text = await page.evaluate(() => document.body.innerText || '');
    const parsed = parseCompanyPageText(text);
    if (geo.orgnr && parsed.orgnr && parsed.orgnr !== String(geo.orgnr).replace(/\D/g, '')) {
      return { ...parsed, status: 'miss', reason: 'orgnr_mismatch', phone: '' };
    }
    return parsed;
  } catch (err) {
    state.blocked += 1;
    if (state.blocked >= 2) skipRemaining();
    return { status: 'blocked', reason: err.message, phone: '', source: 'gulesider' };
  }
}

function isJunkDirectoryResult(result) {
  if (!result) return false;
  if ((result.phones || []).length > 4) return true;
  if (/cookiebot|cloudflare/i.test(result.website || '')) return true;
  if (result.phone === '60442212' || result.phone === '22123456') return true;
  return false;
}

module.exports = {
  lookupGulesider,
  parseCompanyPageText,
  listingHrefFromSearch,
  isJunkDirectoryResult,
  closeGulesiderBrowser,
  skipRemaining,
};
