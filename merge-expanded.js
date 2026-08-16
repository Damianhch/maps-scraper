/**
 * Merge all GoogleMapsResults_*_EXPANDED.xlsx files into one deduped workbook.
 * Usage: node merge-expanded.js [output-filename]
 */
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const DEFAULT_OUTPUT = 'master-expanded-leads.xlsx';

function uniqueLeads(rows) {
  const seenPlaceIds = new Set();
  const seenNameAddress = new Set();
  const kept = [];

  for (const business of rows) {
    const placeId = (business.place_id || '').trim();
    if (placeId) {
      if (seenPlaceIds.has(placeId)) continue;
      seenPlaceIds.add(placeId);
      kept.push(business);
      continue;
    }
    const key = `${business.Name || ''}|${business.Address || ''}`.toLowerCase();
    if (seenNameAddress.has(key)) continue;
    seenNameAddress.add(key);
    kept.push(business);
  }

  return kept;
}

function readExpandedFile(filePath) {
  const workbook = xlsx.readFile(filePath);
  const sheet = workbook.Sheets.Results || workbook.Sheets[workbook.SheetNames[0]];
  return xlsx.utils.sheet_to_json(sheet);
}

function findExpandedFiles(dir) {
  return fs
    .readdirSync(dir)
    .filter(
      (file) =>
        file.endsWith('_EXPANDED.xlsx') &&
        !file.startsWith('~$') &&
        /^GoogleMapsResults_/i.test(file)
    )
    .map((file) => ({
      name: file,
      path: path.join(dir, file),
      time: fs.statSync(path.join(dir, file)).mtimeMs,
    }))
    .sort((a, b) => a.time - b.time);
}

function main() {
  const root = __dirname;
  const outputName = process.argv[2] || DEFAULT_OUTPUT;
  const outputPath = path.join(root, outputName);
  const files = findExpandedFiles(root);

  if (files.length === 0) {
    console.error('❌ No *_EXPANDED.xlsx files found.');
    process.exit(1);
  }

  const perFile = [];
  let combined = [];

  for (const { name, path: filePath } of files) {
    const rows = readExpandedFile(filePath);
    const withSource = rows.map((row) => ({
      ...row,
      'Merged From': row['Merged From'] || name,
    }));
    perFile.push({ file: name, rows: rows.length });
    combined = combined.concat(withSource);
  }

  const beforeDedup = combined.length;
  const merged = uniqueLeads(combined);
  const duplicatesRemoved = beforeDedup - merged.length;

  const meta = [
    { Field: 'Created', Value: new Date().toISOString() },
    { Field: 'Source files', Value: files.length },
    { Field: 'Rows before dedupe', Value: beforeDedup },
    { Field: 'Rows after dedupe', Value: merged.length },
    { Field: 'Duplicates removed', Value: duplicatesRemoved },
    ...perFile.map(({ file, rows }) => ({ Field: `  ${file}`, Value: rows })),
  ];

  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(merged), 'Results');
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(meta), 'About');

  xlsx.writeFile(workbook, outputPath);

  console.log('\n✅ Merged expanded leads\n');
  console.log(`   Output: ${outputPath}`);
  console.log(`   Source files: ${files.length}`);
  for (const { file, rows } of perFile) {
    console.log(`     - ${file}: ${rows} rows`);
  }
  console.log(`   Combined: ${beforeDedup} → ${merged.length} after dedupe (${duplicatesRemoved} duplicates)\n`);
}

main();
