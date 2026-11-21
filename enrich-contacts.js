/**
 * Enrich Brreg leads with daglig leder / styreleder, then 1881 + Gule Sider phones.
 *
 * Usage:
 *   node enrich-contacts.js
 *   node enrich-contacts.js --roles-only
 *   node enrich-contacts.js --directory
 *   node enrich-contacts.js --officer-phones
 *   node enrich-contacts.js --probe --limit=25
 *   node enrich-contacts.js --gulesider-only
 *   node enrich-contacts.js --directory --skip-gulesider
 *   node enrich-contacts.js BrregLeads_LATEST.xlsx
 */

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { setRequestDelayMs } = require('./lib/brreg');
const { hasValidPhone } = require('./lib/phone-filter');
const {
  loadOfficersCache,
  saveOfficersCache,
  loadDirectoryCache,
  saveDirectoryCache,
} = require('./lib/contact-cache');
const {
  enrichRowRoles,
  enrichRowDirectory,
  explodeOfficers,
  scrubJunkDirectoryHits,
} = require('./lib/contact-enrichment');
const { closeGulesiderBrowser } = require('./lib/gulesider');
const { writeProgress, markDone, formatDuration, PROGRESS_TXT } = require('./lib/run-progress');

const DEFAULT_FILE = 'BrregLeads_LATEST.xlsx';
const MASTER_SHEET = '10M all';
const SAVE_ROLES_EVERY = 400;
const SAVE_DIRECTORY_EVERY = 15;

function parseArgs(argv) {
  const args = {
    file: null,
    rolesOnly: false,
    directory: false,
    officerPhones: false,
    skipGulesider: false,
    gulesider: false,
    gulesiderOnly: false,
    probe: false,
    limit: null,
    refreshRoles: false,
    refreshDirectory: false,
  };
  for (const raw of argv) {
    if (raw === '--roles-only') args.rolesOnly = true;
    else if (raw === '--directory') args.directory = true;
    else if (raw === '--officer-phones') args.officerPhones = true;
    else if (raw === '--skip-gulesider') args.skipGulesider = true;
    else if (raw === '--gulesider') args.gulesider = true;
    else if (raw === '--gulesider-only') args.gulesiderOnly = true;
    else if (raw === '--probe') args.probe = true;
    else if (raw === '--refresh-roles') args.refreshRoles = true;
    else if (raw === '--refresh-directory') args.refreshDirectory = true;
    else if (raw.startsWith('--limit=')) args.limit = Number(raw.slice(8));
    else if (!raw.startsWith('--')) args.file = raw;
  }
  if (args.probe && args.limit == null) args.limit = 25;
  if (args.gulesiderOnly) {
    args.directory = true;
    args.gulesider = true;
    args.rolesOnly = false;
  }
  if (!args.rolesOnly && !args.directory) {
    args.rolesOnly = true;
    args.directory = true;
  }
  if (args.probe) {
    args.directory = true;
    args.rolesOnly = true;
  }
  return args;
}

function groupCounts(rows, key) {
  const map = {};
  for (const r of rows) {
    const k = r[key] || '(blank)';
    map[k] = (map[k] || 0) + 1;
  }
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .map(([Group, Count]) => ({ Group, Count }));
}

function readMaster(filename) {
  const workbook = xlsx.readFile(filename);
  const sheetName = workbook.SheetNames.includes(MASTER_SHEET)
    ? MASTER_SHEET
    : workbook.SheetNames[0];
  const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName], { defval: '' });
  return { workbook, sheetName, rows };
}

function writeLeadsWorkbook(filename, rows, extraSheets = {}, { includeOfficers = true } = {}) {
  const callable = rows.filter((r) => hasValidPhone(r));
  const needPhone = rows.filter((r) => !hasValidPhone(r));
  const officers = includeOfficers ? rows.flatMap(explodeOfficers) : [];
  const sheets = {
    'Callable 10M phone': callable,
    '10M need Maps phone': needPhone,
    '10M all': rows,
    Officers: officers,
    ...extraSheets,
  };
  const wb = xlsx.utils.book_new();
  for (const [name, data] of Object.entries(sheets)) {
    const list = Array.isArray(data) && data.length ? data : [{ Note: 'empty' }];
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(list), name.slice(0, 31));
  }
  xlsx.writeFile(wb, filename);
  return { callable: callable.length, needPhone: needPhone.length, officers: officers.length };
}

function needsRoles(row) {
  return String(row['Officers source'] || '') !== 'brreg-roller';
}

function needsDirectory(row, officerPhones) {
  if (officerPhones) return !row['Daglig leder phone'] && !row['Styreleder phone'];
  return !hasValidPhone(row);
}

function printProbeTable(table) {
  const pad = (s, n) => String(s || '').slice(0, n).padEnd(n);
  console.log('\n' + '='.repeat(120));
  console.log(
    `${pad('#', 3)} ${pad('company', 28)} ${pad('daglig leder', 22)} ${pad('1881', 12)} ${pad('phone', 10)} ${pad('gs', 10)} note`
  );
  console.log('-'.repeat(120));
  for (const r of table) {
    console.log(
      `${pad(r.i, 3)} ${pad(r.company, 28)} ${pad(r.dagl, 22)} ${pad(r.e1881, 12)} ${pad(r.phone, 10)} ${pad(r.gs, 10)} ${r.note}`
    );
  }
  console.log('='.repeat(120) + '\n');
}

async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const inputFile = args.file || DEFAULT_FILE;
  if (!fs.existsSync(inputFile)) {
    console.error(`File not found: ${inputFile}`);
    process.exit(1);
  }

  const { workbook, sheetName, rows } = readMaster(inputFile);
  const extraSheets = {};
  for (const name of workbook.SheetNames) {
    if (name === MASTER_SHEET || name === 'Callable 10M phone' || name === '10M need Maps phone' || name === 'Officers') {
      continue;
    }
    extraSheets[name] = xlsx.utils.sheet_to_json(workbook.Sheets[name], { defval: '' });
  }

  const officersCache = args.refreshRoles ? {} : loadOfficersCache();
  const directoryCache = args.refreshDirectory ? {} : loadDirectoryCache();
  const scrubbed = scrubJunkDirectoryHits(rows, directoryCache);
  if (scrubbed.rowsCleared || scrubbed.cacheCleared) {
    console.log(
      `  Cleared junk Gule Sider hits: ${scrubbed.rowsCleared} rows, ${scrubbed.cacheCleared} cache keys`
    );
  }
  const doDirectory = args.directory || args.probe;
  let useGulesider = doDirectory && (args.gulesider || args.gulesiderOnly) && !args.skipGulesider;
  let skip1881 = Boolean(args.gulesiderOnly);

  console.log('📇 Contact enrichment (Brreg roller → 1881 → Gule Sider)');
  console.log(`  Input: ${path.resolve(inputFile)}`);
  console.log(`  Sheet: ${sheetName} (${rows.length} rows)`);
  if (args.rolesOnly) console.log('  Stage: Brreg daglig leder / styreleder');
  if (doDirectory) console.log(`  Stage: 1881${useGulesider ? ' + Gule Sider' : ''}${args.officerPhones ? ' (all officers)' : ' (missing phones)'}`);
  if (args.probe) console.log('  PROBE (writes roles, limited directory)');
  if (args.limit) console.log(`  Limit: ${args.limit}`);
  console.log(`  Progress: ${PROGRESS_TXT}\n`);

  const saveCaches = () => {
    saveOfficersCache(officersCache);
    saveDirectoryCache(directoryCache);
  };
  const saveWorkbook = (opts = {}) => {
    const counts = writeLeadsWorkbook(inputFile, rows, extraSheets, opts);
    saveCaches();
    return counts;
  };

  const startedAtMs = Date.now();
  let processed = 0;
  let matchedPhones = rows.filter((r) => hasValidPhone(r)).length;

  if (args.rolesOnly) {
    setRequestDelayMs(70);
    const pending = [];
    for (let i = 0; i < rows.length; i++) {
      if (needsRoles(rows[i])) pending.push(i);
    }
    const work = args.limit && !doDirectory ? pending.slice(0, args.limit) : pending;
    console.log(`👥 Brreg roller: ${work.length}/${pending.length} companies need officers\n`);
    for (let i = 0; i < work.length; i++) {
      const row = rows[work[i]];
      try {
        await enrichRowRoles(row, officersCache, { refresh: args.refreshRoles });
      } catch (err) {
        row['Officers source'] = `error:${err.message}`;
        console.error(`  ⚠️  roller ${row.Orgnr}: ${err.message}`);
      }
      processed += 1;
      if ((i + 1) % 20 === 0 || i + 1 === work.length) {
        const elapsedSec = (Date.now() - startedAtMs) / 1000;
        const remainingSec = ((work.length - (i + 1)) / Math.max(i + 1, 1)) * elapsedSec;
        console.log(
          `  roller ${i + 1}/${work.length} ${row.Name} → ${row['Daglig leder'] || '(none)'}`
        );
        writeProgress(
          {
            phase: 'contacts',
            processed: i + 1,
            total: work.length,
            matched: rows.filter((r) => r['Daglig leder']).length,
            elapsedSec: Math.round(elapsedSec),
            remainingSec: Math.round(remainingSec),
            summary: `Officers ${i + 1}/${work.length} · ~${formatDuration(remainingSec)} left`,
          },
          { log: false }
        );
      }
      if ((i + 1) % SAVE_ROLES_EVERY === 0) saveWorkbook({ includeOfficers: false });
    }
    setRequestDelayMs(180);
    saveWorkbook();
  } else {
    for (const row of rows) {
      if (row['Daglig leder'] || row['Styreleder']) continue;
      const cached = officersCache[String(row.Orgnr || '').replace(/\D/g, '')];
      if (cached?.officers) enrichRowRoles(row, officersCache);
    }
  }

  const table = [];
  if (doDirectory) {
    const pending = [];
    for (let i = 0; i < rows.length; i++) {
      if (needsDirectory(rows[i], args.officerPhones)) pending.push(i);
    }
    const work = args.limit ? pending.slice(0, args.limit) : pending;
    console.log(`\n☎️  Directory: ${work.length}/${pending.length} companies\n`);
    if (!args.probe && work.length && !skip1881) {
      console.log('  Cooling 20s before 1881 to avoid captcha from the last burst...\n');
      await new Promise((r) => setTimeout(r, 20000));
    }

    for (let i = 0; i < work.length; i++) {
      const row = rows[work[i]];
      let attempts = [];
      let stopped = false;
      try {
        if (needsRoles(row)) await enrichRowRoles(row, officersCache);
        attempts = await enrichRowDirectory(row, directoryCache, {
          officerPhones: args.officerPhones,
          useGulesider,
          skip1881,
        });
      } catch (err) {
        const reason = err.code === 'CAPTCHA' ? 'captcha' : err.message;
        console.error(`  ⚠️  directory ${row.Name}: ${reason}`);
        if (err.code === 'CAPTCHA') {
          skip1881 = true;
          useGulesider = !args.skipGulesider;
          console.error('1881 captcha/block — switching remaining rows to Gule Sider.');
          try {
            attempts = await enrichRowDirectory(row, directoryCache, {
              officerPhones: args.officerPhones,
              useGulesider,
              skip1881: true,
            });
          } catch (gsErr) {
            attempts = [{ status: 'error', reason: gsErr.message, source: 'gulesider' }];
          }
        } else {
          attempts = [{ status: 'error', reason, source: '1881' }];
        }
      }

      const last1881 = [...attempts].reverse().find((a) => String(a.kind || '').includes('1881')) || attempts[0] || {};
      const gs = attempts.find((a) => a.kind === 'gulesider');
      table.push({
        i: i + 1,
        company: row.Name,
        dagl: row['Daglig leder'],
        e1881: last1881.status || '',
        phone: row.Phone,
        gs: gs?.status || (useGulesider ? '' : 'skipped'),
        note: last1881.reason || '',
      });

      if (hasValidPhone(row)) matchedPhones += 1;
      processed += 1;
      console.log(
        `  [${i + 1}/${work.length}] ${String(last1881.status || '').padEnd(12)} ${row.Name} | ${row['Daglig leder'] || ''} | ${row.Phone || ''}`
      );

      const elapsedSec = (Date.now() - startedAtMs) / 1000;
      writeProgress(
        {
          phase: 'contacts',
          processed: i + 1,
          total: work.length,
          matched: rows.filter((r) => hasValidPhone(r)).length,
          elapsedSec: Math.round(elapsedSec),
          remainingSec: Math.round(((work.length - (i + 1)) / Math.max(i + 1, 1)) * elapsedSec),
        },
        { log: false }
      );

      if (!args.probe && ((i + 1) % SAVE_DIRECTORY_EVERY === 0 || stopped)) {
        saveWorkbook({ includeOfficers: false });
      }
      if (!args.probe && (i + 1) % 8 === 0) {
        await new Promise((r) => setTimeout(r, 12000));
      }
      if (stopped) break;
    }
  }

  const extra = extraSheets;
  extra.Summary = [
    { Metric: 'Companies', Value: rows.length },
    { Metric: 'With daglig leder', Value: rows.filter((r) => r['Daglig leder']).length },
    { Metric: 'With styreleder', Value: rows.filter((r) => r['Styreleder']).length },
    { Metric: 'Callable with phone', Value: rows.filter((r) => hasValidPhone(r)).length },
    { Metric: 'Still missing phone', Value: rows.filter((r) => !hasValidPhone(r)).length },
    { Metric: 'Daglig leder phone', Value: rows.filter((r) => r['Daglig leder phone']).length },
    { Metric: 'Styreleder phone', Value: rows.filter((r) => r['Styreleder phone']).length },
    { Metric: 'Directory source 1881 company', Value: rows.filter((r) => String(r['Phone Source'] || '').includes('1881-company')).length },
    { Metric: 'Phone from daglig leder', Value: rows.filter((r) => r['Phone Source'] === 'daglig-leder-1881').length },
    { Metric: 'Google Maps', Value: 'NOT RUN' },
    { Metric: 'Generated at', Value: new Date().toISOString() },
  ];
  extra['Industry mix 10M'] = extra['Industry mix 10M'] || groupCounts(rows, 'Industry group');

  const counts = args.probe && doDirectory && args.rolesOnly
    ? writeLeadsWorkbook(inputFile, rows, extra)
    : saveWorkbook();

  if (args.probe) printProbeTable(table);

  await closeGulesiderBrowser();

  console.log('\n' + '='.repeat(60));
  console.log('CONTACT ENRICHMENT');
  console.log('='.repeat(60));
  console.log(`Companies: ${rows.length}`);
  console.log(`Daglig leder: ${rows.filter((r) => r['Daglig leder']).length}`);
  console.log(`Styreleder: ${rows.filter((r) => r['Styreleder']).length}`);
  console.log(`Callable with phone: ${counts.callable}`);
  console.log(`Still missing phone: ${counts.needPhone}`);
  console.log(`Officer rows: ${counts.officers}`);
  console.log(`File: ${path.resolve(inputFile)}`);
  console.log('='.repeat(60) + '\n');

  markDone(
    `Contacts · ${counts.callable} callable / ${rows.length} · ${counts.officers} officers · ${inputFile}`
  );
  return { counts, table };
}

module.exports = { runCli, parseArgs };

if (require.main === module) {
  runCli().catch(async (err) => {
    console.error('Contact enrichment failed:', err);
    try {
      await closeGulesiderBrowser();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
}
