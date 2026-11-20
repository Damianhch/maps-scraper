/**
 * Google Maps backfill for Brreg leads: GBP website, phone, reviews.
 * Default is a dry run that only prints counts and cost. Will not scrape Maps
 * unless you pass --run after seeing the numbers.
 *
 * Exclusion rule: drop a row only if a real website exists on BOTH Brreg and Maps.
 *
 * Usage:
 *   node maps-backfill.js
 *   node maps-backfill.js BrregLeads_LATEST.xlsx
 *   node maps-backfill.js BrregLeads_LATEST.xlsx --run
 */

const fs = require('fs');
const xlsx = require('xlsx');
const { hasWebsiteInBothPlaces, isRealBusinessWebsite, cleanWebsiteUrl } = require('./lib/website-filter');
const { extractPhoneFromGoogleMapsPage } = require('./lib/google-maps-phone');
const { hasValidPhone } = require('./lib/phone-filter');

const DEFAULT_FILE = 'BrregLeads_LATEST.xlsx';
const SECONDS_PER_LOOKUP = 12;
const BROWSERS = 5;

function digitsPhone(value) {
  return String(value || '').replace(/\D/g, '').length >= 8;
}

function loadRows(filename) {
  const wb = xlsx.readFile(filename);
  const preferred = ['10M all', 'Callable 10M phone', wb.SheetNames[0]];
  const name = preferred.find((n) => wb.SheetNames.includes(n)) || wb.SheetNames[0];
  return { wb, sheetName: name, rows: xlsx.utils.sheet_to_json(wb.Sheets[name], { defval: '' }) };
}

async function lookupOnGoogleMaps(page, row) {
  const q = [row.Name, row.Poststed, 'Norge'].filter(Boolean).join(' ');
  const url = `https://www.google.com/maps/search/${encodeURIComponent(q)}?hl=no&gl=no`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
  await new Promise((r) => setTimeout(r, 1500));

  const websiteSelectors = [
    'a[data-item-id="authority"]',
    'a[aria-label*="Nettsted"]',
    'a[aria-label*="Website"]',
  ];
  let website = '';
  for (const selector of websiteSelectors) {
    const href = await page.$eval(selector, (el) => el.getAttribute('href')).catch(() => null);
    if (href) {
      website = href;
      break;
    }
  }

  const phone = await extractPhoneFromGoogleMapsPage(page);
  let reviewCount = 0;
  let rating = '';
  try {
    reviewCount = await page.evaluate(() => {
      const t = document.body.innerText || '';
      const m = t.match(/(\d[\d\s]*)\s+anmeldelser/i) || t.match(/(\d[\d\s]*)\s+reviews/i);
      return m ? Number(String(m[1]).replace(/\s/g, '')) : 0;
    });
    rating = await page.evaluate(() => {
      const el = document.querySelector('div.F7nice span[aria-hidden="true"]');
      return el ? el.textContent.trim() : '';
    });
  } catch {
    /* ignore */
  }

  return {
    website: cleanWebsiteUrl(website, row.Name),
    phone: phone && phone !== 'Not found' ? phone : '',
    reviewCount: reviewCount || '',
    rating,
  };
}

async function runBackfill(filename) {
  const puppeteer = require('puppeteer');
  const { rows } = loadRows(filename);
  const browser = await puppeteer.launch({ headless: false });
  const page = await browser.newPage();
  const kept = [];
  const droppedBothWebsites = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    console.log(`[${i + 1}/${rows.length}] ${row.Name}`);
    try {
      const maps = await lookupOnGoogleMaps(page, row);
      row['Google Maps Website'] = maps.website || '';
      if (!digitsPhone(row.Phone) && maps.phone) row.Phone = maps.phone;
      row['Review Count'] = maps.reviewCount;
      row.Rating = maps.rating;
      if (hasWebsiteInBothPlaces(row['Brreg Website'], row['Google Maps Website'], row.Name)) {
        droppedBothWebsites.push(row);
        console.log('   skip — website on Brreg AND Google Maps');
        continue;
      }
      kept.push(row);
    } catch (err) {
      console.log(`   error: ${err.message}`);
      kept.push(row);
    }
  }

  await browser.close();
  const out = filename.replace(/\.xlsx$/i, '_MAPS.xlsx');
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(kept), 'Kept after Maps');
  xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(droppedBothWebsites), 'Dropped both websites');
  xlsx.writeFile(wb, out);
  console.log(`📁 ${out} kept ${kept.length}, dropped ${droppedBothWebsites.length}`);
}

function dryRun(filename) {
  const { sheetName, rows } = loadRows(filename);
  const withBrregWeb = rows.filter((r) => isRealBusinessWebsite(r['Brreg Website'], r.Name)).length;
  const needPhone = rows.filter((r) => !hasValidPhone(r)).length;
  const hours = (rows.length * SECONDS_PER_LOOKUP) / BROWSERS / 3600;
  console.log('Google Maps backfill — DRY RUN (nothing scraped)');
  console.log(`File: ${filename} (sheet ${sheetName})`);
  console.log(`Rows that would be looked up: ${rows.length}`);
  console.log(`Already have Brreg website: ${withBrregWeb}`);
  console.log(`Missing Brreg phone: ${needPhone}`);
  console.log(`Estimated wall time at ${BROWSERS} browsers (~${SECONDS_PER_LOOKUP}s each): ${hours.toFixed(1)} hours`);
  console.log('Drop rule: only if a real website is on BOTH Brreg and Google Maps.');
  console.log('\nNot running. If you accept this volume, pass --run:');
  console.log(`  node maps-backfill.js ${filename} --run`);
}

async function main() {
  const filename = argsFile();
  const run = process.argv.includes('--run');
  if (!fs.existsSync(filename)) {
    console.error(`❌ File not found: ${filename}`);
    process.exit(1);
  }
  if (!run) {
    dryRun(filename);
    return;
  }
  await runBackfill(filename);
}

function argsFile() {
  const a = process.argv.slice(2).filter((x) => x !== '--run');
  return a[0] || DEFAULT_FILE;
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ maps-backfill failed:', err);
    process.exit(1);
  });
}

module.exports = { dryRun, lookupOnGoogleMaps };
