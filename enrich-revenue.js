/**
 * Add Brreg accounting (omsetning) to an existing Maps/expand Excel without re-matching.
 *
 * Usage:
 *   node enrich-revenue.js
 *   node enrich-revenue.js path/to/file.xlsx
 */

const fs = require('fs');
const xlsx = require('xlsx');
const { fetchFinancialsForOrgnr, flushRegnskapCache, digits9 } = require('./lib/brreg-regnskap');
const { hasValidPhone } = require('./lib/phone-filter');
const {
  MIN_REVENUE_NOK,
  passesOrgFormFilter,
  meetsMinRevenue,
  hasBrregWebsite,
} = require('./lib/filters');

const CONCURRENCY = 4;
const DEFAULT_FILE = 'GoogleMapsResults_2026-05-20T17-26-17_RECOVERED_EXPANDED.xlsx';

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

function isConstructionIndustry(row) {
  const ind = String(row.Industry || row['NACE Code'] || '').toLowerCase();
  return /renov|roof|bygg|tømr|tomr|elektr|rør|ror|maler|snekk|anlegg|entrepren|murer/.test(ind);
}

async function main() {
  const input = process.argv[2] || DEFAULT_FILE;
  if (!fs.existsSync(input)) {
    console.error(`❌ File not found: ${input}`);
    process.exit(1);
  }

  console.log(`📄 Enriching ${input} with Brreg accounting...\n`);
  const workbook = xlsx.readFile(input);
  const sheetName = workbook.SheetNames[0];
  const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });

  let done = 0;
  await mapPool(rows, CONCURRENCY, async (row) => {
    const orgnr = digits9(row.Orgnr);
    if (!orgnr) {
      row['Accounting Orgnr'] = row['Accounting Orgnr'] || '';
      row['Revenue NOK'] = row['Revenue NOK'] || '';
      row['Revenue Year'] = row['Revenue Year'] || '';
      row['Operating Profit'] = row['Operating Profit'] || '';
      row['Net Profit'] = row['Net Profit'] || '';
      row.Equity = row.Equity || '';
      row['Accounting Status'] = row['Accounting Status'] || 'no_orgnr';
      row['Has Brreg Website'] = hasBrregWebsite(row['Brreg Website']);
      done += 1;
      return row;
    }
    const fin = await fetchFinancialsForOrgnr(orgnr, row.Selskapsform, row['Brreg Parent Orgnr']);
    row['Accounting Orgnr'] = fin.accountingOrgnr;
    row['Revenue NOK'] = fin.revenueNok ?? '';
    row['Revenue Year'] = fin.revenueYear || '';
    row['Operating Profit'] = fin.operatingProfit ?? '';
    row['Net Profit'] = fin.netProfit ?? '';
    row.Equity = fin.equity ?? '';
    row['Accounting Status'] = fin.accountingStatus;
    row['Has Brreg Website'] = hasBrregWebsite(row['Brreg Website']);
    done += 1;
    if (done % 25 === 0 || done === rows.length) {
      console.log(`   ${done}/${rows.length}`);
      flushRegnskapCache();
    }
    return row;
  });
  flushRegnskapCache();

  const withRevenue = rows.filter((r) => r['Revenue NOK'] !== '' && r['Revenue NOK'] != null);
  const tenM = rows.filter((r) => meetsMinRevenue(r) && passesOrgFormFilter(r));
  const tenMPhone = tenM.filter((r) => hasValidPhone(r));
  const construction10m = tenMPhone.filter(isConstructionIndustry);

  const summary = [
    { Metric: 'Source file', Value: input },
    { Metric: 'Rows in', Value: rows.length },
    { Metric: 'With orgnr', Value: rows.filter((r) => digits9(r.Orgnr)).length },
    { Metric: 'With revenue figure', Value: withRevenue.length },
    { Metric: '10M+ and not ENK', Value: tenM.length },
    { Metric: '10M+ not ENK with phone', Value: tenMPhone.length },
    { Metric: 'Of those, construction-ish industry', Value: construction10m.length },
    { Metric: 'Min revenue NOK', Value: MIN_REVENUE_NOK },
    { Metric: 'Generated at', Value: new Date().toISOString() },
  ];

  const outName = input.replace(/\.xlsx$/i, '_WITH_REVENUE.xlsx');
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(rows), 'All with revenue');
  xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(tenMPhone), '10M not ENK phone');
  xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(construction10m), 'Construction 10M');
  xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(summary), 'Summary');
  for (let i = 1; i < workbook.SheetNames.length; i++) {
    const name = workbook.SheetNames[i];
    if (['All with revenue', '10M not ENK phone', 'Construction 10M', 'Summary'].includes(name)) continue;
    xlsx.utils.book_append_sheet(wb, workbook.Sheets[name], name);
  }
  xlsx.writeFile(wb, outName);

  console.log('\n' + '='.repeat(60));
  console.log('📊 EXISTING MAPS LIST + BRREG REVENUE');
  console.log('='.repeat(60));
  console.log(`Rows: ${rows.length}`);
  console.log(`With revenue: ${withRevenue.length}`);
  console.log(`10M+ not ENK with phone: ${tenMPhone.length}`);
  console.log(`Construction-ish 10M+: ${construction10m.length}`);
  console.log(`📁 ${outName}`);
  console.log('='.repeat(60) + '\n');
}

main().catch((err) => {
  console.error('❌ enrich-revenue failed:', err);
  try {
    flushRegnskapCache();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
