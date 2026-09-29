/**
 * Brreg-first new-business scraper.
 * Finds AS/ENK registered in a date window (default last 6 months) in the
 * top Maps industries, then enriches each row with /roller contact person.
 *
 * Usage:
 *   node brreg-new-businesses.js
 *   node brreg-new-businesses.js --test
 *   node brreg-new-businesses.js --months=6 --limit=40
 *   node brreg-new-businesses.js --from=2026-02-16 --to=2026-08-16
 */
const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const {
  searchEnheterByFilters,
  fetchRoller,
  extractContactPerson,
  formatAntallAnsatte,
  pickBusinessPhone,
  pickEmail,
  pickWebsite,
  mapEnhet,
  isoDateDaysAgo,
  isoDateToday,
} = require('./lib/brreg');
const { jsonToLeadSheet, shapeLeadRow } = require('./lib/lead-columns');
const { INDUSTRIES, SKIPPED_INDUSTRIES, assignIndustry } = require('./lib/brreg-new-industries');
const { getApiKey } = require('./lib/places-lookup');
const { backfillRows } = require('./brreg-new-backfill-phones');
const { backfillRows: backfillOwnerPhones } = require('./brreg-new-backfill-owner-phones');
const { backfillRows: backfillUnderenheter } = require('./brreg-new-backfill-underenheter');
const {
  clearProgress,
  writeProgress,
  markDone,
  formatDuration,
  PROGRESS_TXT,
} = require('./lib/run-progress');

const ORG_FORMS = ['AS', 'ENK'];
const ENRICH_CONCURRENCY = 4;
const SAVE_EVERY_N = 40;
const OUTPUT_PREFIX = 'BrregNewBusinesses';

function parseArgs(argv) {
  const args = {
    test: false,
    months: 6,
    limit: null,
    from: null,
    to: null,
    out: null,
    skipMaps: false,
    skipOwnerPhones: false,
    skipUnderenheter: false,
  };
  for (const raw of argv) {
    if (raw === '--test') args.test = true;
    else if (raw === '--skip-maps') args.skipMaps = true;
    else if (raw === '--skip-owner-phones') args.skipOwnerPhones = true;
    else if (raw === '--skip-underenheter') args.skipUnderenheter = true;
    else if (raw.startsWith('--months=')) args.months = Number(raw.slice(9));
    else if (raw.startsWith('--limit=')) args.limit = Number(raw.slice(8));
    else if (raw.startsWith('--from=')) args.from = raw.slice(7);
    else if (raw.startsWith('--to=')) args.to = raw.slice(5);
    else if (raw.startsWith('--out=')) args.out = raw.slice(6);
  }
  if (args.test && args.limit == null) args.limit = 40;
  if (args.test && !args.from && !args.to) args.months = 1;
  return args;
}

function dateWindow(args) {
  const to = args.to || isoDateToday();
  if (args.from) return { from: args.from, to };
  const days = Math.max(1, Math.round(Number(args.months) * 30.44));
  return { from: isoDateDaysAgo(days), to };
}

function outputFilename(args) {
  if (args.out) return args.out;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const tag = args.test ? '_TEST' : '';
  return `${OUTPUT_PREFIX}_${stamp}${tag}.xlsx`;
}

function toRow(candidate, industry, contactPerson) {
  const phone = pickBusinessPhone(candidate);
  const hasPhone = phone !== 'Not found' && phone.replace(/\D/g, '').length >= 8;
  return shapeLeadRow({
    Name: candidate.navn,
    Address: candidate.formattedAddress || 'Not found',
    Website: pickWebsite(candidate),
    Phone: phone,
    Email: pickEmail(candidate),
    'Contact Person': contactPerson || 'Not found',
    'Business Phone': phone,
    Industry: industry,
    Selskapsform: candidate.orgFormKode || 'Not found',
    'Antall Ansatte': formatAntallAnsatte(candidate),
    Orgnr: candidate.orgnr,
    'Brreg Name': candidate.navn,
    NACE: candidate.naceKode,
    'NACE Description': candidate.naceBeskrivelse,
    Stiftelsesdato: candidate.stiftelsesdato || 'Not found',
    Registreringsdato: candidate.registreringsdato || 'Not found',
    Kommune: candidate.kommune || 'Not found',
    Postnummer: candidate.postnummer || '',
    Poststed: candidate.poststed ? candidate.poststed.toUpperCase() : '',
    'MVA-registrert': candidate.registrertIMvaregisteret ? 'Ja' : 'Nei',
    Aktivitet: candidate.aktivitet || '',
    Formål: candidate.formaal || '',
    'Has Valid Phone': hasPhone,
    'Phone Source': hasPhone ? 'brreg' : '',
  });
}

function countBy(rows, key) {
  const counts = {};
  for (const row of rows) {
    const k = String(row[key] || '').trim() || '(blank)';
    counts[k] = (counts[k] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([Field, Value]) => ({ Field, Value }));
}

function writeWorkbook(filePath, rows, meta) {
  const about = [
    { Field: 'Source', Value: 'Brreg Enhetsregisteret (Brreg-first, no Google)' },
    { Field: 'Date field', Value: 'registreringsdatoEnhetsregisteret (ENK has no stiftelsesdato)' },
    { Field: 'From', Value: meta.from },
    { Field: 'To', Value: meta.to },
    { Field: 'Org forms', Value: ORG_FORMS.join(', ') },
    { Field: 'Rows', Value: rows.length },
    { Field: 'Test mode', Value: meta.test ? 'yes' : 'no' },
    { Field: 'Generated at', Value: new Date().toISOString() },
    { Field: 'Skipped industry', Value: SKIPPED_INDUSTRIES.map((s) => `${s.label}: ${s.reason}`).join(' | ') },
    ...INDUSTRIES.map((g) => ({
      Field: `NACE ${g.label}`,
      Value: g.naceCodes.join(', '),
    })),
    { Field: 'With contact person', Value: rows.filter((r) => r['Contact Person'] !== 'Not found').length },
    { Field: 'With phone', Value: rows.filter((r) => r['Has Valid Phone']).length },
    { Field: 'Maps matched', Value: rows.filter((r) => r['Maps Match Status'] === 'matched').length },
    { Field: 'ENK', Value: rows.filter((r) => r.Selskapsform === 'ENK').length },
    { Field: 'AS', Value: rows.filter((r) => r.Selskapsform === 'AS').length },
  ];

  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, jsonToLeadSheet(xlsx, rows), 'Results');
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(about), 'About');
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(countBy(rows, 'Industry')), 'By industry');
  xlsx.writeFile(workbook, filePath);
}

async function collectEntities(from, to, limit, onProgress) {
  const byOrgnr = new Map();
  const perGroup = limit ? Math.max(1, Math.ceil(limit / INDUSTRIES.length)) : null;

  for (const group of INDUSTRIES) {
    onProgress(`Fetching ${group.label} (${group.naceCodes.join(', ')})…`);
    const { items, totalElements } = await searchEnheterByFilters({
      fraRegistreringsdato: from,
      tilRegistreringsdato: to,
      naeringskode: group.naceCodes,
      organisasjonsform: ORG_FORMS,
      konkurs: false,
      underAvvikling: false,
      underTvangsavviklingEllerTvangsopplosning: false,
    });
    onProgress(`  ${group.label}: ${items.length} fetched (API total ${totalElements})`);

    let addedThisGroup = 0;
    for (const raw of items) {
      const candidate = mapEnhet(raw);
      if (!candidate.orgnr || byOrgnr.has(candidate.orgnr)) continue;
      candidate.industry = assignIndustry(candidate, group);
      byOrgnr.set(candidate.orgnr, candidate);
      addedThisGroup += 1;
      if (perGroup && addedThisGroup >= perGroup) break;
    }
  }

  const all = [...byOrgnr.values()];
  if (limit && all.length > limit) return all.slice(0, limit);
  return all;
}

async function enrichContacts(entities, outputFile, meta, startedAtMs) {
  const rows = entities.map((c) => toRow(c, c.industry, null));
  let done = 0;
  let withContact = 0;

  const save = () => writeWorkbook(outputFile, rows, meta);

  for (let i = 0; i < entities.length; i += ENRICH_CONCURRENCY) {
    const batch = entities.slice(i, i + ENRICH_CONCURRENCY);
    await Promise.all(
      batch.map(async (candidate, offset) => {
        const index = i + offset;
        try {
          const roller = await fetchRoller(candidate.orgnr);
          const name = extractContactPerson(roller);
          rows[index]['Contact Person'] = name || 'Not found';
          if (name) withContact += 1;
        } catch (err) {
          rows[index]['Contact Person'] = 'Not found';
          console.error(`  ⚠️  roller ${candidate.orgnr}: ${err.message}`);
        }
      })
    );
    done += batch.length;
    if (done % SAVE_EVERY_N === 0 || done === entities.length) save();

    const elapsedSec = (Date.now() - startedAtMs) / 1000;
    const rate = done / Math.max(elapsedSec, 1);
    const remainingSec = (entities.length - done) / Math.max(rate, 0.001);
    writeProgress(
      {
        phase: 'brreg-new',
        processed: done,
        total: entities.length,
        matched: withContact,
        elapsedSec: Math.round(elapsedSec),
        remainingSec: Math.round(remainingSec),
        brregNewOutputFile: outputFile,
        summary: `Brreg-new ${done}/${entities.length} · ${withContact} contacts · ~${formatDuration(remainingSec)} left`,
      },
      { log: done % 20 === 0 || done === entities.length }
    );
  }

  save();
  return rows;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const { from, to } = dateWindow(args);
  const outputFile = path.resolve(outputFilename(args));
  const startedAtMs = Date.now();

  console.log('Brreg-first new-business scraper');
  console.log(`  Window: ${from} → ${to} (registreringsdato)`);
  console.log(`  Forms: ${ORG_FORMS.join(', ')}`);
  console.log(`  Industries: ${INDUSTRIES.map((g) => g.label).join(', ')} + kafé (from restaurant names)`);
  console.log(`  Skipped: ${SKIPPED_INDUSTRIES.map((s) => s.label).join(', ')}`);
  if (args.limit) console.log(`  Limit: ${args.limit}`);
  if (args.test) console.log('  TEST mode');
  if (args.skipMaps) console.log('  Maps phone backfill: skipped');
  if (args.skipUnderenheter) console.log('  Underenhet phone backfill: skipped');
  if (args.skipOwnerPhones) console.log('  Owner 1881 phone backfill: skipped');
  console.log(`  Output: ${outputFile}`);
  console.log(`  Progress: ${PROGRESS_TXT}\n`);

  clearProgress('brreg-new');
  writeProgress({
    phase: 'brreg-new',
    brregNewOutputFile: outputFile,
    summary: `Brreg-new collecting ${from} → ${to}`,
  });

  const entities = await collectEntities(from, to, args.limit, (msg) => console.log(msg));
  entities.sort((a, b) => {
    const ia = String(a.industry).localeCompare(String(b.industry), 'nb');
    if (ia !== 0) return ia;
    return String(b.registreringsdato).localeCompare(String(a.registreringsdato));
  });
  console.log(`\nCollected ${entities.length} unique entities. Fetching contact persons…\n`);

  const rows = await enrichContacts(
    entities,
    outputFile,
    { from, to, test: args.test },
    startedAtMs
  );

  let underCounts = null;
  if (!args.skipUnderenheter) {
    console.log('\nFilling missing phones from Brreg underenheter…\n');
    const save = () => writeWorkbook(outputFile, rows, { from, to, test: args.test });
    const under = await backfillUnderenheter(rows, {
      save,
      onProgress: ({ i, total, row, result: match, counts, elapsedSec }) => {
        const remainingSec = ((total - i) / Math.max(i, 1)) * elapsedSec;
        if (i % 20 === 0 || i === total || match.status === 'hit') {
          console.log(
            `  [${i}/${total}] ${match.status} ${match.reason} · ${String(row.Name || '').slice(0, 40)}`
          );
        }
        writeProgress(
          {
            phase: 'underenhet-phones',
            processed: i,
            total,
            matched: counts.hit || 0,
            elapsedSec: Math.round(elapsedSec),
            remainingSec: Math.round(remainingSec),
            brregNewOutputFile: outputFile,
            summary: `Underenheter ${i}/${total} · ${counts.hit || 0} hits · ~${formatDuration(remainingSec)} left`,
          },
          { log: i % 40 === 0 || i === total }
        );
      },
    });
    underCounts = under.counts;
    save();
  }

  let mapsCounts = null;
  if (!args.skipMaps) {
    console.log('\nMatching missing phones via Google Places (Norway, high-confidence only)…\n');
    const apiKey = getApiKey();
    const save = () => writeWorkbook(outputFile, rows, { from, to, test: args.test });
    const result = await backfillRows(rows, {
      apiKey,
      save,
      onProgress: ({ i, total, row, result: match, counts, elapsedSec }) => {
        const remainingSec = ((total - i) / Math.max(i, 1)) * elapsedSec;
        if (i % 10 === 0 || i === total || match.status === 'matched') {
          console.log(
            `  [${i}/${total}] ${match.status} ${match.reason} · ${String(row.Name || '').slice(0, 40)}`
          );
        }
        writeProgress(
          {
            phase: 'brreg-phones',
            processed: i,
            total,
            matched: counts.matched,
            elapsedSec: Math.round(elapsedSec),
            remainingSec: Math.round(remainingSec),
            brregNewOutputFile: outputFile,
            summary: `Brreg-phones ${i}/${total} · ${counts.matched} matched · ~${formatDuration(remainingSec)} left`,
          },
          { log: i % 20 === 0 || i === total }
        );
      },
    });
    mapsCounts = result.counts;
    save();
  }

  let ownerCounts = null;
  if (!args.skipOwnerPhones) {
    console.log('\nLooking up missing phones via owner 1881 listings…\n');
    const save = () => writeWorkbook(outputFile, rows, { from, to, test: args.test });
    const owner = await backfillOwnerPhones(rows, {
      save,
      onProgress: ({ i, total, row, result: match, counts, elapsedSec }) => {
        const remainingSec = ((total - i) / Math.max(i, 1)) * elapsedSec;
        if (i % 10 === 0 || i === total || match.status === 'hit') {
          console.log(
            `  [${i}/${total}] ${match.status} ${match.reason} · ${String(row['Contact Person'] || row.Name || '').slice(0, 40)}`
          );
        }
        writeProgress(
          {
            phase: 'owner-phones',
            processed: i,
            total,
            matched: counts.hit || 0,
            elapsedSec: Math.round(elapsedSec),
            remainingSec: Math.round(remainingSec),
            brregNewOutputFile: outputFile,
            summary: `Owner-phones ${i}/${total} · ${counts.hit || 0} hits · ~${formatDuration(remainingSec)} left`,
          },
          { log: i % 20 === 0 || i === total }
        );
      },
    });
    ownerCounts = owner.counts;
    save();
  }

  const byIndustry = countBy(rows, 'Industry');
  const withPhone = rows.filter((r) => r['Has Valid Phone']).length;
  const withContact = rows.filter((r) => r['Contact Person'] !== 'Not found').length;
  const enk = rows.filter((r) => r.Selskapsform === 'ENK').length;
  const as = rows.filter((r) => r.Selskapsform === 'AS').length;

  console.log('\n' + '='.repeat(60));
  console.log('BRREG-NEW SUMMARY');
  console.log('='.repeat(60));
  console.log(`Rows: ${rows.length}`);
  console.log(`AS / ENK: ${as} / ${enk}`);
  console.log(`Contact person: ${withContact} (${pct(withContact, rows.length)})`);
  console.log(`Phone: ${withPhone} (${pct(withPhone, rows.length)})`);
  if (mapsCounts) {
    console.log(
      `Maps: ${mapsCounts.matched} matched · ${mapsCounts.no_profile} no profile · ${mapsCounts.ambiguous} ambiguous`
    );
  }
  if (underCounts) {
    console.log(
      `Underenheter: ${underCounts.hit || 0} hit · ${underCounts.no_unit || 0} none · ${underCounts.no_phone || 0} no phone · ${underCounts.ambiguous || 0} ambiguous`
    );
  }
  if (ownerCounts) {
    console.log(
      `Owner 1881: ${ownerCounts.hit || 0} hit · ${ownerCounts.miss || 0} miss · ${ownerCounts.ambiguous || 0} ambiguous · ${ownerCounts['phone-hidden'] || 0} hidden`
    );
  }
  console.log('By industry:');
  for (const row of byIndustry) console.log(`  ${row.Field}: ${row.Value}`);
  console.log(`File: ${outputFile}`);
  console.log('='.repeat(60) + '\n');

  markDone(`Brreg-new finished · ${rows.length} rows · ${outputFile}`);
  return { outputFile, rows };
}

function pct(part, total) {
  if (!total) return '0%';
  return `${((part / total) * 100).toFixed(1)}%`;
}

if (require.main === module) {
  run().catch((err) => {
    console.error('Brreg-new failed:', err);
    process.exit(1);
  });
}

module.exports = { run, parseArgs, dateWindow, toRow };
