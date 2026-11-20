/**
 * Backfill missing Brreg-new phones from the owner's 1881 listing.
 *
 * Usage:
 *   node brreg-new-backfill-owner-phones.js --probe --limit=40
 *   node brreg-new-backfill-owner-phones.js
 *   node brreg-new-backfill-owner-phones.js path/to/WITH_PHONES.xlsx
 */
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { fetchRoller, extractContactPersons } = require('./lib/brreg');
const { rowHasValidPhone, brregPostcode } = require('./lib/brreg-places-match');
const { lookupPerson, probeGulesider, padPostcode } = require('./lib/1881-lookup');
const { normalizePhone } = require('./lib/normalize');
const { jsonToLeadSheet } = require('./lib/lead-columns');
const {
  writeProgress,
  markDone,
  formatDuration,
  PROGRESS_TXT,
} = require('./lib/run-progress');

const SAVE_EVERY_N = 25;
const ROLE_FALLBACK = ['DAGL', 'INNH', 'LEDE', 'STYR'];

function parseArgs(argv) {
  const args = {
    file: null,
    dryRun: false,
    probe: false,
    limit: null,
    inPlace: false,
    skipGulesider: false,
  };
  for (const raw of argv) {
    if (raw === '--dry-run') args.dryRun = true;
    else if (raw === '--probe') args.probe = true;
    else if (raw === '--in-place') args.inPlace = true;
    else if (raw === '--skip-gulesider') args.skipGulesider = true;
    else if (raw.startsWith('--limit=')) args.limit = Number(raw.slice(8));
    else if (!raw.startsWith('--')) args.file = raw;
  }
  if (args.probe && args.limit == null) args.limit = 40;
  return args;
}

function findWithPhonesFile() {
  const files = fs
    .readdirSync('.')
    .filter(
      (f) =>
        /^BrregNewBusinesses_.*_WITH_PHONES\.xlsx$/i.test(f) &&
        !f.startsWith('~$') &&
        !/_OWNER/i.test(f)
    )
    .map((name) => ({ name, time: fs.statSync(name).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  return files[0]?.name || null;
}

function outputPath(inputFile, { inPlace, dryRun, probe }) {
  if (dryRun || probe) return null;
  if (inPlace) return inputFile;
  if (/_OWNER_PLUS\.xlsx$/i.test(inputFile)) return inputFile.replace(/\.xlsx$/i, '_RETRY.xlsx');
  if (/_OWNER\.xlsx$/i.test(inputFile)) return inputFile.replace(/_OWNER\.xlsx$/i, '_OWNER_PLUS.xlsx');
  return inputFile.replace(/\.xlsx$/i, '_OWNER.xlsx');
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

function defaultRoleForRow(row) {
  return String(row.Selskapsform || '').toUpperCase() === 'ENK' ? 'INNH' : 'DAGL';
}

function sortPersons(persons) {
  const rank = (role) => {
    const i = ROLE_FALLBACK.indexOf(String(role || '').toUpperCase());
    return i === -1 ? ROLE_FALLBACK.length : i;
  };
  return [...persons].sort((a, b) => rank(a.role) - rank(b.role));
}

async function contactPersonsForRow(row, { includeRoller = true } = {}) {
  const seen = new Set();
  const out = [];
  const add = (name, role) => {
    const n = String(name || '').trim();
    if (!n || n === 'Not found') return;
    const key = n.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ name: n, role: role || defaultRoleForRow(row) });
  };

  add(row['Contact Person'], defaultRoleForRow(row));
  if (!includeRoller) return sortPersons(out);

  const orgnr = String(row.Orgnr || '').replace(/\D/g, '');
  if (!orgnr) return sortPersons(out);
  try {
    const roller = await fetchRoller(orgnr);
    for (const p of extractContactPersons(roller)) add(p.name, p.role);
  } catch (err) {
    console.error(`  ⚠️  roller ${orgnr}: ${err.message}`);
  }
  return sortPersons(out);
}

async function lookupRow(row, { probeGulesiderToo = false } = {}) {
  const geo = {
    postcode: padPostcode(brregPostcode(row) || row.Postnummer),
    poststed: String(row.Poststed || '').trim(),
  };
  let persons = await contactPersonsForRow(row, { includeRoller: false });
  const attempts = [];

  const tryPerson = async (person) => {
    const result = await lookupPerson(person.name, geo);
    attempts.push({ ...result, role: person.role, personName: person.name });
    return result.status === 'hit'
      ? { ...result, role: person.role, personName: person.name, attempts, gulesider: null }
      : null;
  };

  for (const person of persons) {
    const hit = await tryPerson(person);
    if (hit) return hit;
  }

  persons = await contactPersonsForRow(row, { includeRoller: true });
  for (const person of persons.slice(1)) {
    const hit = await tryPerson(person);
    if (hit) return hit;
  }

  const last = attempts[attempts.length - 1] || {
    status: 'miss',
    reason: 'no_contact',
    phone: '',
  };
  let gulesider = null;
  if (probeGulesiderToo && persons[0]) {
    gulesider = await probeGulesider(persons[0].name, geo);
  }
  return { ...last, attempts, gulesider };
}

function applyOwnerPhone(row, result) {
  row['Owner Phone Status'] = result.status;
  row['Owner Phone Reason'] = result.reason || '';
  if (result.personName) row['Owner Phone Name'] = result.personName;
  if (result.status !== 'hit' || !result.phone) return row;
  const phone = normalizePhone(result.phone);
  row.Phone = phone;
  row['Business Phone'] = phone;
  row['Has Valid Phone'] = phone.length >= 8;
  row['Phone Source'] =
    result.reason === 'postcode' || result.reason === 'poststed' ? 'owner-1881' : 'owner-1881-national';
  const role = String(result.role || '').toUpperCase();
  row['Phone Role'] = role === 'LEDE' ? 'STYR' : role;
  return row;
}

async function backfillRows(rows, options = {}) {
  const {
    dryRun = false,
    probe = false,
    limit = null,
    onProgress = () => {},
    save = null,
    probeGulesiderToo = false,
  } = options;

  const pending = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (rowHasValidPhone(row)) continue;
    const contact = String(row['Contact Person'] || '').trim();
    if (!contact || contact === 'Not found') continue;
    pending.push({ row, index: i });
  }

  const work = limit ? pending.slice(0, limit) : pending;
  const startedAtMs = Date.now();
  const counts = {
    hit: 0,
    miss: 0,
    ambiguous: 0,
    'phone-hidden': 0,
    error: 0,
    already_had_phone: rows.length - pending.length,
    gulesiderBlocked: 0,
  };
  const table = [];

  for (let i = 0; i < work.length; i++) {
    const { row } = work[i];
    let result;
    try {
      result = await lookupRow(row, { probeGulesiderToo: probe && probeGulesiderToo });
    } catch (err) {
      result = {
        status: 'error',
        reason: err.code === 'CAPTCHA' ? 'captcha' : err.message,
        phone: '',
      };
      counts.error += 1;
      if (err.code === 'CAPTCHA') {
        console.error('Stopped: 1881 captcha/block. Remaining rows left unchanged.');
        table.push({
          i: i + 1,
          name: row['Contact Person'],
          post: `${brregPostcode(row)} ${row.Poststed || ''}`.trim(),
          company: row.Name,
          e1881: 'error',
          gs: '',
          phone: '',
          note: result.reason,
        });
        break;
      }
    }

    if (result.status !== 'error') {
      counts[result.status] = (counts[result.status] || 0) + 1;
    }
    if (result.gulesider?.status === 'blocked') counts.gulesiderBlocked += 1;

    if (!probe && !dryRun) applyOwnerPhone(row, result);

    table.push({
      i: i + 1,
      name: result.personName || row['Contact Person'],
      role: result.role || '',
      post: `${padPostcode(brregPostcode(row))} ${row.Poststed || ''}`.trim(),
      company: String(row.Name || '').slice(0, 36),
      e1881: result.status,
      gs: result.gulesider?.status || (probeGulesiderToo ? '' : 'skipped'),
      phone: result.status === 'hit' ? result.phone : '',
      note: result.reason || '',
    });

    onProgress({
      i: i + 1,
      total: work.length,
      row,
      result,
      counts,
      elapsedSec: (Date.now() - startedAtMs) / 1000,
    });

    if (save && !dryRun && !probe && ((i + 1) % SAVE_EVERY_N === 0 || i + 1 === work.length)) {
      save();
    }
  }

  return { counts, processed: table.length, pending: pending.length, table };
}

function printProbeTable(table, counts) {
  const pad = (s, n) => String(s || '').slice(0, n).padEnd(n);
  console.log('\n' + '='.repeat(110));
  console.log(
    `${pad('#', 3)} ${pad('1881', 13)} ${pad('Gule Sider', 12)} ${pad('phone', 10)} ${pad('role', 5)} ${pad('post', 18)} ${pad('person', 24)} note`
  );
  console.log('-'.repeat(110));
  for (const r of table) {
    console.log(
      `${pad(r.i, 3)} ${pad(r.e1881, 13)} ${pad(r.gs, 12)} ${pad(r.phone, 10)} ${pad(r.role, 5)} ${pad(r.post, 18)} ${pad(r.name, 24)} ${r.note}`
    );
  }
  console.log('-'.repeat(110));
  console.log(
    `1881  hit=${counts.hit || 0}  miss=${counts.miss || 0}  ambiguous=${counts.ambiguous || 0}  phone-hidden=${counts['phone-hidden'] || 0}  error=${counts.error || 0}`
  );
  if (counts.gulesiderBlocked) {
    console.log(`Gule Sider blocked (Cloudflare): ${counts.gulesiderBlocked}/${table.length}`);
  }
  console.log('Phones are public 1881 HTML (tel: / title), not API-gated. Official API is optional.');
  console.log('='.repeat(110) + '\n');
}

async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const inputFile = args.file || findWithPhonesFile();
  if (!inputFile) {
    console.error('No BrregNewBusinesses_*_WITH_PHONES.xlsx file found.');
    process.exit(1);
  }
  if (!fs.existsSync(inputFile)) {
    console.error(`File not found: ${inputFile}`);
    process.exit(1);
  }

  const workbook = xlsx.readFile(inputFile);
  const sheet = workbook.Sheets.Results || workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet);
  const outFile = outputPath(inputFile, args);
  const probeGulesiderToo = args.probe && !args.skipGulesider;

  console.log(args.probe ? '1881 vs Gule Sider owner-phone probe' : 'Brreg → owner 1881 phone backfill');
  console.log(`  Input: ${path.resolve(inputFile)}`);
  console.log(`  Rows: ${rows.length}`);
  if (args.probe) console.log('  PROBE (no file write)');
  if (args.dryRun) console.log('  DRY RUN (no file write)');
  if (args.limit) console.log(`  Limit: ${args.limit}`);
  if (outFile) console.log(`  Output: ${path.resolve(outFile)}`);
  console.log(`  Progress: ${PROGRESS_TXT}\n`);

  const save = outFile
    ? () => {
        const wb = preserveExtraSheets(workbook, rows);
        xlsx.writeFile(wb, outFile);
      }
    : null;

  const { counts, processed, table } = await backfillRows(rows, {
    dryRun: args.dryRun || args.probe,
    probe: args.probe,
    limit: args.limit,
    save,
    probeGulesiderToo,
    onProgress: ({ i, total, row, result, counts: c, elapsedSec }) => {
      const remainingSec = ((total - i) / Math.max(i, 1)) * elapsedSec;
      const name = String(row['Contact Person'] || row.Name || '').slice(0, 40);
      console.log(
        `[${i}/${total}] ${String(result.status).padEnd(13)} ${result.reason || ''} | ${name}`
      );
      if (i % 5 === 0 || i === total) {
        writeProgress(
          {
            phase: 'owner-phones',
            processed: i,
            total,
            matched: c.hit || 0,
            elapsedSec: Math.round(elapsedSec),
            remainingSec: Math.round(remainingSec),
            brregNewOutputFile: outFile || inputFile,
            summary: `Owner-phones ${i}/${total} · ${c.hit || 0} hits · ~${formatDuration(remainingSec)} left`,
          },
          { log: true }
        );
      }
    },
  });

  if (save && !args.dryRun && !args.probe) save();
  if (args.probe) printProbeTable(table, counts);

  console.log('\n' + '='.repeat(60));
  console.log(args.probe ? 'OWNER PHONE PROBE SUMMARY' : 'OWNER PHONE BACKFILL SUMMARY');
  console.log('='.repeat(60));
  console.log(`Processed: ${processed}`);
  console.log(`hit: ${counts.hit || 0}`);
  console.log(`miss: ${counts.miss || 0}`);
  console.log(`ambiguous: ${counts.ambiguous || 0}`);
  console.log(`phone-hidden: ${counts['phone-hidden'] || 0}`);
  console.log(`already_had_phone: ${counts.already_had_phone}`);
  console.log(`error: ${counts.error || 0}`);
  if (outFile && !args.dryRun && !args.probe) console.log(`File: ${outFile}`);
  console.log('='.repeat(60) + '\n');

  markDone(
    `Owner-phones finished · ${counts.hit || 0} hits / ${processed} processed · ${outFile || 'probe/dry-run'}`
  );
  return { counts, outFile, table };
}

module.exports = { runCli, backfillRows, parseArgs, applyOwnerPhone, lookupRow };

if (require.main === module) {
  runCli().catch((err) => {
    console.error('Owner-phone backfill failed:', err);
    process.exit(1);
  });
}
