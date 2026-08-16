/**
 * Extract rows from GoogleMapsResults_ALL_CUMULATIVE.xlsx by Industry search term.
 * Usage: node extract-cumulative-industries.js [output.xlsx] [industries.txt]
 */
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { CUMULATIVE_ALL_FILE } = require('./lib/performance-config');

const DEFAULT_INDUSTRIES = [
  'rørlegger',
  'elektriker',
  'snekker',
  'maler',
  'håndverker',
  'bilverksted',
  'roofing',
  'home renovation',
  'bathroom renovation',
  'kitchen renovation',
  'byggentreprenør',
];

function readIndustryList(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return DEFAULT_INDUSTRIES;
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function loadCumulativeRows() {
  const filePath = path.join(__dirname, CUMULATIVE_ALL_FILE);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${CUMULATIVE_ALL_FILE}`);
  }
  const workbook = xlsx.readFile(filePath);
  const sheet = workbook.Sheets.Results || workbook.Sheets[workbook.SheetNames[0]];
  return xlsx.utils.sheet_to_json(sheet);
}

function extractByIndustries(rows, industries) {
  const wanted = new Set(industries.map((i) => i.toLowerCase()));
  const seen = new Set();
  const out = [];

  for (const row of rows) {
    const industry = String(row.Industry || '').trim();
    if (!wanted.has(industry.toLowerCase())) continue;

    const key = row.place_id || `${row.Name}|${row.Address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }

  out.sort((a, b) => {
    const ia = String(a.Industry || '').localeCompare(String(b.Industry || ''), 'nb');
    if (ia !== 0) return ia;
    return String(a.Name || '').localeCompare(String(b.Name || ''), 'nb');
  });

  return out;
}

function main() {
  const outputFile =
    process.argv[2] || 'GoogleMapsResults_trades-from-cumulative.xlsx';
  const industryFile = process.argv[3] || 'list of industries - trades-extract.txt';
  const industries = readIndustryList(path.join(__dirname, industryFile));
  const rows = loadCumulativeRows();
  const extracted = extractByIndustries(rows, industries);

  const counts = {};
  for (const row of extracted) {
    const key = String(row.Industry || '').trim();
    counts[key] = (counts[key] || 0) + 1;
  }

  const about = [
    { Field: 'Source', Value: CUMULATIVE_ALL_FILE },
    { Field: 'Industry filter file', Value: industryFile },
    { Field: 'Extracted rows', Value: extracted.length },
    { Field: 'Generated at', Value: new Date().toISOString() },
    ...industries.map((term) => ({
      Field: `Industry: ${term}`,
      Value: counts[term] ?? counts[Object.keys(counts).find((k) => k.toLowerCase() === term.toLowerCase())] ?? 0,
    })),
  ];

  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(extracted), 'Results');
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(about), 'About');
  xlsx.writeFile(workbook, path.join(__dirname, outputFile));

  console.log(`✅ Extracted ${extracted.length} businesses → ${outputFile}`);
  console.log('By industry:');
  for (const [industry, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${industry}: ${count}`);
  }
  const missing = industries.filter(
    (term) => !Object.keys(counts).some((k) => k.toLowerCase() === term.toLowerCase())
  );
  if (missing.length > 0) {
    console.log(`\n⚠️  No rows in cumulative for: ${missing.join(', ')}`);
  }
  console.log(`\nExpand later: node expand.js "${outputFile}"`);
}

main();
