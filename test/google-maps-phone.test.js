/**
 * Run: node test/google-maps-phone.test.js
 */
const { normalizeScrapedPhone } = require('../lib/google-maps-phone');

let passed = 0;
let failed = 0;

function assert(name, cond) {
  if (cond) {
    passed++;
    console.log('PASS', name);
  } else {
    failed++;
    console.log('FAIL', name);
  }
}

// Why the old scraper missed numbers: exact data-item-id="phone" never matches Maps
const mapsItemId = 'phone:tel:73600022';
assert('old selector data-item-id="phone" does NOT match', mapsItemId !== 'phone');
assert('new prefix phone:tel: matches', /^phone:tel:(\d+)/i.test(mapsItemId));

const digits = mapsItemId.match(/^phone:tel:(\d+)/i)[1];
assert('digits from id', digits === '73600022');

assert('normalize display', normalizeScrapedPhone('73 60 00 22') === '73 60 00 22');
assert('normalize null', normalizeScrapedPhone(null) === 'Not found');
assert('normalize literal null string', normalizeScrapedPhone('null') === 'Not found');
assert('reject copy tooltip text', normalizeScrapedPhone('Kopiér telefonnummeret') === 'Not found');

const aria = 'Telefon: 73 60 00 22 ';
const ariaMatch = aria.match(/(?:Telefon|Phone|Ring)\s*:\s*([\d\s+()-]{8,})/i);
assert('aria-label parse', ariaMatch && ariaMatch[1].trim() === '73 60 00 22');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
