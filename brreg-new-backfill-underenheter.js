/**
 * Backfill missing Brreg-new phones from underenheter of the same orgnr.
 *
 * Usage:
 *   node brreg-new-backfill-underenheter.js
 *   node brreg-new-backfill-underenheter.js path/to/file.xlsx
 */
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { rowHasValidPhone } = require('./lib/brreg-places-match');
const { lookupUnderenhetPhone, applyUnderenhetPhone } = require('./lib/brreg-underenhet-phones');
const { jsonToLeadSheet } = require('./lib/lead-columns');
const {
  writeProgress,
  markDone,
  formatDuration,
  PROGRESS_TXT,
} = require('./lib/run-progress');

const SAVE_EVERY_N = 40;
const CONCURRENCY = 4;

function parseArgs(argv) {
  const args = { file: null, dryRun: false, limit: null, inPlace: false, out: null };
  for (const raw of argv) {
    if (raw === '--dry-run') args.dryRun = true;
    else if (raw === '--in-place') args.inPlace = true;
    else if (raw.startsWith('--limit=')) args.limit = Number(raw.slice(8));
    else if (raw.startsWith('--out=')) args.out = raw.slice(6);
    else if (!raw.startsWith('--')) args.file = raw;
  }
  return args;
}

function findLatestInput() {
  const files = fs
    .readdirSync('.')
    .filter(
      (f) =>
        /^BrregNewBusinesses_.*\.xlsx$/i.test(f) &&
        !f.startsWith('~$') &&
        !/_TEST\.xlsx$/i.test(f)
    )
    .map((name) => ({ name, time: fs.statSync(name).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  const owner = files.find((f) => /_OWNER\.xlsx$/i.test(f.name) && !/_PLUS/i.test(f.name));
  return owner?.name || files[0]?.name || null;
}

function outputPath(inputFile, { inPlace, dryRun, out }) {
  if (dryRun) return null;
  if (out) return out;
  if (inPlace) return inputFile;
  if (/_OWNER\.xlsx$/i.test(inputFile)) return inputFile.replace(/_OWNER\.xlsx$/i, '_OWNER_PLUS.xlsx');
  return inputFile.replace(/\.xlsx$/i, '_UNDER.xlsx');
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
  const { dryRun = false, limit = null, onProgress = () => {}, save = null } = options;
  const pending = [];
  for (let i = 0; i < rows.length; i++) {
    if (rowHasValidPhone(rows[i])) continue;
    pending.push({ row: rows[i], index: i });
  }
  const work = limit ? pending.slice(0, limit) : pending;
  const startedAtMs = Date.now();
  const counts = {
    hit: 0,
    no_phone: 0,
    no_unit: 0,
    ambiguous: 0,
    error: 0,
    already_had_phone: rows.length - pending.length,
  };

  for (let i = 0; i < work.length; i += CONCURRENCY) {
    const batch = work.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async ({ row }) => {
        try {
          return await lookupUnderenhetPhone(row);
        } catch (err) {
          return { status: 'error', reason: err.message, phone: '' };
        }
      })
    );
    for (let b = 0; b < batch.length; b++) {
      const { row } = batch[b];
      const result = results[b];
      counts[result.status] = (counts[result.status] || 0) + 1;
      if (!dryRun) applyUnderenhetPhone(row, result);
      const done = i + b + 1;
      onProgress({
        i: done,
        total: work.length,
        row,
        result,
        counts,
        elapsedSec: (Date.now() - startedAtMs) / 1000,
      });
    }
    if (save && !dryRun && (i + batch.length) % SAVE_EVERY_N < CONCURRENCY) save();
  }
  return { counts, processed: work.length, pending: pending.length };
}

async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const inputFile = args.file || findLatestInput();
  if (!inputFile || !fs.existsSync(inputFile)) {
    console.error('No BrregNewBusinesses_*.xlsx file found.');
    process.exit(1);
  }
  const workbook = xlsx.readFile(inputFile);
  const sheet = workbook.Sheets.Results || workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet);
  const outFile = outputPath(inputFile, args);

  console.log('Brreg underenhet phone backfill');
  console.log(`  Input: ${path.resolve(inputFile)}`);
  console.log(`  Rows: ${rows.length}`);
  if (args.limit) console.log(`  Limit: ${args.limit}`);
  if (outFile) console.log(`  Output: ${path.resolve(outFile)}`);
  console.log(`  Progress: ${PROGRESS_TXT}\n`);

  const save = outFile
    ? () => xlsx.writeFile(preserveExtraSheets(workbook, rows), outFile)
    : null;

  const { counts, processed } = await backfillRows(rows, {
    dryRun: args.dryRun,
    limit: args.limit,
    save,
    onProgress: ({ i, total, row, result, counts: c, elapsedSec }) => {
      const remainingSec = ((total - i) / Math.max(i, 1)) * elapsedSec;
      if (i % 20 === 0 || i === total || result.status === 'hit') {
        console.log(
          `[${i}/${total}] ${String(result.status).padEnd(12)} ${result.reason || ''} | ${String(row.Name || '').slice(0, 40)}`
        );
        writeProgress(
          {
            phase: 'underenhet-phones',
            processed: i,
            total,
            matched: c.hit || 0,
            elapsedSec: Math.round(elapsedSec),
            remainingSec: Math.round(remainingSec),
            brregNewOutputFile: outFile || inputFile,
            summary: `Underenheter ${i}/${total} · ${c.hit || 0} hits · ~${formatDuration(remainingSec)} left`,
          },
          { log: true }
        );
      }
    },
  });

  if (save && !args.dryRun) save();

  console.log('\n' + '='.repeat(60));
  console.log('UNDERENHET PHONE SUMMARY');
  console.log('='.repeat(60));
  console.log(`Processed: ${processed}`);
  console.log(`hit: ${counts.hit || 0}`);
  console.log(`no_unit: ${counts.no_unit || 0}`);
  console.log(`no_phone: ${counts.no_phone || 0}`);
  console.log(`ambiguous: ${counts.ambiguous || 0}`);
  console.log(`already_had_phone: ${counts.already_had_phone}`);
  if (outFile && !args.dryRun) console.log(`File: ${outFile}`);
  console.log('='.repeat(60) + '\n');
  markDone(`Underenheter finished · ${counts.hit || 0} hits / ${processed} processed · ${outFile || 'dry-run'}`);
  return { counts, outFile };
}

module.exports = { runCli, backfillRows, parseArgs };

if (require.main === module) {
  runCli().catch((err) => {
    console.error('Underenhet backfill failed:', err);
    process.exit(1);
  });
}
