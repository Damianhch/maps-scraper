const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

const INPUTS = [
  {
    key: 'trondheim_2plus_expanded',
    file: 'GoogleMapsResults_2026-06-16T18-40-53_EXPANDED.xlsx',
    sourceLabel: 'Trondheim 2+ expanded',
  },
  {
    key: 'oslo_broad_2plus_expanded',
    file: 'GoogleMapsResults_2026-06-18T09-34-51_EXPANDED.xlsx',
    sourceLabel: 'Oslo broad 2+ expanded',
  },
  {
    key: 'trondheim_0plus_expanded',
    file: 'GoogleMapsResults_2026-06-16T18-40-53_REVIEWS_0PLUS_EXPANDED.xlsx',
    sourceLabel: 'Trondheim 0+ expanded',
  },
  {
    key: 'oslo_broad_0plus_expanded',
    file: 'GoogleMapsResults_2026-06-18T09-34-51_REVIEWS_0PLUS_EXPANDED.xlsx',
    sourceLabel: 'Oslo broad 0+ expanded',
  },
];

function readRows(file) {
  const wb = xlsx.readFile(file);
  const ws = wb.Sheets.Results || wb.Sheets[wb.SheetNames[0]];
  return xlsx.utils.sheet_to_json(ws);
}

function dedupeRows(rows) {
  const seenPlaceIds = new Set();
  const seenNameAddress = new Set();
  const kept = [];

  for (const row of rows) {
    const placeId = String(row.place_id || '').trim();
    if (placeId) {
      if (seenPlaceIds.has(placeId)) continue;
      seenPlaceIds.add(placeId);
      kept.push(row);
      continue;
    }

    const key = `${row.Name || ''}|${row.Address || ''}`.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || seenNameAddress.has(key)) continue;
    seenNameAddress.add(key);
    kept.push(row);
  }

  return kept;
}

function main() {
  const missing = INPUTS.filter((x) => !fs.existsSync(x.file));
  if (missing.length > 0) {
    console.error('Missing input files:');
    for (const m of missing) console.error(` - ${m.file}`);
    process.exit(1);
  }

  const wb = xlsx.utils.book_new();
  const perSheet = [];
  let combined = [];

  for (const input of INPUTS) {
    const rows = readRows(input.file).map((row) => ({
      ...row,
      'Final Source': input.sourceLabel,
      'Final Source File': input.file,
    }));
    perSheet.push({ key: input.key, file: input.file, rows: rows.length });
    combined = combined.concat(rows);
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(rows), input.key.slice(0, 31));
  }

  const deduped = dedupeRows(combined);
  xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(deduped), 'combined_deduped');

  const about = [
    { Field: 'Created At', Value: new Date().toISOString() },
    { Field: 'Total rows (combined)', Value: combined.length },
    { Field: 'Total rows (deduped)', Value: deduped.length },
    { Field: 'Duplicates removed', Value: combined.length - deduped.length },
    ...perSheet.map((s) => ({ Field: s.key, Value: `${s.rows} rows (${s.file})` })),
  ];
  xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(about), 'about');

  const output = `FINAL_REQUESTED_TRD_OSLO_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.xlsx`;
  xlsx.writeFile(wb, path.join(__dirname, output));

  console.log(`Output: ${output}`);
  for (const s of perSheet) {
    console.log(`${s.key}: ${s.rows}`);
  }
  console.log(`combined: ${combined.length}`);
  console.log(`combined_deduped: ${deduped.length}`);
}

main();
