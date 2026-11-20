/**
 * Backfill missing Brreg-new phones via reverse Places match.
 *
 * Usage:
 *   node brreg-new-backfill-phones.js
 *   node brreg-new-backfill-phones.js --dry-run --limit=40
 *   node brreg-new-backfill-phones.js path/to/file.xlsx --in-place
 */
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { getApiKey } = require('./lib/places-lookup');
const {
  matchBrregRowToPlaces,
  applyMatchToRow,
  rowHasValidPhone,
} = require('./lib/brreg-places-match');
const {
  writeProgress,
  markDone,
  formatDuration,
  PROGRESS_TXT,
} = require('./lib/run-progress');
const { jsonToLeadSheet } = require('./lib/lead-columns');

const SAVE_EVERY_N = 25;

function parseArgs(argv) {
  const args = {
    file: null,
    dryRun: false,
    limit: null,
    inPlace: false,
    skipMaps: false,
  };
  for (const raw of argv) {
    if (raw === '--dry-run') args.dryRun = true;
    else if (raw === '--in-place') args.inPlace = true;
    else if (raw === '--skip-maps') args.skipMaps = true;
    else if (raw.startsWith('--limit=')) args.limit = Number(raw.slice(8));
    else if (!raw.startsWith('--')) args.file = raw;
  }
  return args;
}

function findLatestBrregNewFile() {
  const files = fs
    .readdirSync('.')
    .filter(
      (f) =>
        /^BrregNewBusinesses_.*\.xlsx$/i.test(f) &&
        !f.startsWith('~$') &&
        !/_TEST\.xlsx$/i.test(f) &&
        !/_WITH_PHONES\.xlsx$/i.test(f)
    )
    .map((name) => ({ name, time: fs.statSync(name).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  return files[0]?.name || null;
}

function outputPath(inputFile, { inPlace, dryRun }) {
  if (dryRun) return null;
  if (inPlace) return inputFile;
  return inputFile.replace(/\.xlsx$/i, '_WITH_PHONES.xlsx');
}

function preserveExtraSheets(workbook, rows) {
  const out = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(out, jsonToLeadSheet(xlsx, rows), 'Results');
  for (const name of workbook.SheetNames) {
    if (name === 'Results') continue;
    xlsx.utils.book_append_sheet(out, workbook.Sheets[name], name);
  }
  return out;
}

async function backfillRows(rows, options = {}) {
  const {
    dryRun = false,
    limit = null,
    apiKey,
    onProgress = () => {},
    save = null,
  } = options;

  const pending = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (rowHasValidPhone(row)) {
      if (!row['Maps Match Status']) {
        applyMatchToRow(row, {
          status: 'already_had_phone',
          reason: 'brreg_phone',
          score: '',
          placeId: '',
          mapsUrl: '',
          phone: '',
          website: '',
        });
      }
      continue;
    }
    pending.push({ row, index: i });
  }

  const work = limit ? pending.slice(0, limit) : pending;
  const startedAtMs = Date.now();
  const counts = {
    matched: 0,
    no_profile: 0,
    ambiguous: 0,
    already_had_phone: rows.length - pending.length,
    error: 0,
    withPhone: 0,
  };

  for (let i = 0; i < work.length; i++) {
    const { row } = work[i];
    const result = await matchBrregRowToPlaces(row, {
      apiKey,
      fetchDetails: !dryRun,
    });
    applyMatchToRow(row, result);
    counts[result.status] = (counts[result.status] || 0) + 1;
    if (result.status === 'matched' && result.phone) counts.withPhone += 1;

    onProgress({
      i: i + 1,
      total: work.length,
      row,
      result,
      counts,
      elapsedSec: (Date.now() - startedAtMs) / 1000,
    });

    if (save && !dryRun && ((i + 1) % SAVE_EVERY_N === 0 || i + 1 === work.length)) {
      save();
    }
  }

  return { counts, processed: work.length, pending: pending.length };
}

async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const inputFile = args.file || findLatestBrregNewFile();
  if (!inputFile) {
    console.error('No BrregNewBusinesses_*.xlsx file found.');
    process.exit(1);
  }
  if (!fs.existsSync(inputFile)) {
    console.error(`File not found: ${inputFile}`);
    process.exit(1);
  }

  const apiKey = getApiKey();
  const workbook = xlsx.readFile(inputFile);
  const sheet = workbook.Sheets.Results || workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet);
  const outFile = outputPath(inputFile, args);

  console.log('Brreg → Places phone backfill');
  console.log(`  Input: ${path.resolve(inputFile)}`);
  console.log(`  Rows: ${rows.length}`);
  if (args.dryRun) console.log('  DRY RUN (no Place Details, no file write)');
  if (args.limit) console.log(`  Limit: ${args.limit}`);
  if (outFile) console.log(`  Output: ${path.resolve(outFile)}`);
  console.log(`  Progress: ${PROGRESS_TXT}\n`);

  const save = outFile
    ? () => {
        const wb = preserveExtraSheets(workbook, rows);
        xlsx.writeFile(wb, outFile);
      }
    : null;

  const { counts, processed } = await backfillRows(rows, {
    dryRun: args.dryRun,
    limit: args.limit,
    apiKey,
    save,
    onProgress: ({ i, total, row, result, counts: c, elapsedSec }) => {
      const remainingSec = ((total - i) / Math.max(i, 1)) * elapsedSec;
      const name = String(row.Name || '').slice(0, 48);
      console.log(
        `[${i}/${total}] ${result.status.padEnd(18)} ${String(result.score).padStart(3)} ${result.reason} | ${name}`
      );
      if (i % 10 === 0 || i === total) {
        writeProgress(
          {
            phase: 'brreg-phones',
            processed: i,
            total,
            matched: c.matched,
            elapsedSec: Math.round(elapsedSec),
            remainingSec: Math.round(remainingSec),
            brregNewOutputFile: outFile || inputFile,
            summary: `Brreg-phones ${i}/${total} · ${c.matched} matched · ~${formatDuration(remainingSec)} left`,
          },
          { log: true }
        );
      }
    },
  });

  if (save && !args.dryRun) save();

  console.log('\n' + '='.repeat(60));
  console.log('PHONE BACKFILL SUMMARY');
  console.log('='.repeat(60));
  console.log(`Processed: ${processed}`);
  console.log(`matched: ${counts.matched} (phone fetched: ${counts.withPhone})`);
  console.log(`no_profile: ${counts.no_profile}`);
  console.log(`ambiguous: ${counts.ambiguous}`);
  console.log(`already_had_phone: ${counts.already_had_phone}`);
  console.log(`error: ${counts.error}`);
  if (outFile && !args.dryRun) console.log(`File: ${outFile}`);
  console.log('='.repeat(60) + '\n');

  markDone(
    `Brreg-phones finished · ${counts.matched} matched / ${processed} processed · ${outFile || 'dry-run'}`
  );
  return { counts, outFile };
}

if (require.main === module) {
  runCli().catch((err) => {
    console.error('Phone backfill failed:', err);
    process.exit(1);
  });
}

module.exports = { runCli, backfillRows, parseArgs, findLatestBrregNewFile };
