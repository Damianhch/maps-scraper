const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const { matchBusinessToBrreg } = require('./lib/match');
const { loadEnv } = require('./lib/ai-match');
const { FAST_MODE, EXPAND: EXPAND_PERF } = require('./lib/performance-config');
const {
  clearProgress,
  reportExpandProgress,
  markDone,
  writeProgress,
  PROGRESS_TXT,
} = require('./lib/run-progress');
const {
  readScrapeOutputFromProgress,
  readExpandOutputFromProgress,
  getExpandOutputFile,
} = require('./lib/session-output');
const {
  loadCombinedExistingLeadIndex,
  discoverExclusionPaths,
  filterNewLeads,
} = require('./lib/existing-leads');

loadEnv();

const TEST_LIMIT = null;
const START_FROM_INDEX = 0;
const API_DELAY_MS = EXPAND_PERF.API_DELAY_MS;
const MATCH_CONCURRENCY = EXPAND_PERF.MATCH_CONCURRENCY;
const SAVE_EVERY_N = EXPAND_PERF.SAVE_EVERY_N;

const MASTER_LIST_PATTERNS = [/hoved-liste/i, /_export\.xlsx$/i];

function isScraperOutputFile(filename) {
  return /^GoogleMapsResults/i.test(filename);
}

function isExcludedInputFile(filename) {
  return (
    filename.includes('_EXPANDED') ||
    filename.includes('_ALL') ||
    filename.includes('_NEW_ONLY') ||
    filename.includes('CHECKPOINT') ||
    filename.startsWith('PARTIAL_') ||
    MASTER_LIST_PATTERNS.some((re) => re.test(filename))
  );
}

function resolveScrapeInputFile(cliFilename) {
  if (cliFilename) return cliFilename;
  const fromProgress = readScrapeOutputFromProgress();
  if (fromProgress) return fromProgress;
  return findMostRecentExcelFile();
}

function findMostRecentExcelFile() {
  const candidates = fs
    .readdirSync('.')
    .filter(
      (file) =>
        file.endsWith('.xlsx') && !file.startsWith('~$') && !isExcludedInputFile(file)
    )
    .map((file) => ({
      name: file,
      time: fs.statSync(file).mtime.getTime(),
      isScraper: isScraperOutputFile(file),
    }))
    .sort((a, b) => {
      if (a.isScraper !== b.isScraper) return a.isScraper ? -1 : 1;
      return b.time - a.time;
    });

  return candidates.length > 0 ? candidates[0].name : null;
}

function ensureColumns(data) {
  const defaults = {
    'Contact Person': 'Not found',
    'Business Phone': 'Not found',
    Selskapsform: 'Not found',
    'Antall Ansatte': 'Not found',
    Tier: '',
    Orgnr: '',
    'Brreg Name': '',
    'Brreg Parent Orgnr': '',
    'Match Score': '',
    'Match Confidence': '',
  };

  for (const row of data) {
    for (const [col, val] of Object.entries(defaults)) {
      if (row[col] == null || row[col] === '') {
        if (col === 'Tier' || col === 'Orgnr' || col === 'Match Score' || col === 'Match Confidence') {
          if (row[col] == null) row[col] = val;
        } else if (!row[col]) {
          row[col] = val;
        }
      }
    }
  }
}

function applyMatchToRow(business, match, data, dataIndex) {
  if (match) {
    business['Contact Person'] = match.contactPerson;
    business['Business Phone'] = match.businessPhone;
    business.Selskapsform = match.selskapsform;
    business['Antall Ansatte'] = match.antallAnsatte;
    business.Tier = match.tier;
    business.Orgnr = match.orgnr;
    business['Brreg Name'] = match.brregName;
    business['Brreg Parent Orgnr'] = match.parentOrgnr || '';
    business['Match Score'] = match.matchScore;
    business['Match Confidence'] = match.matchConfidence;
  } else {
    business['Contact Person'] = 'Not found';
    business['Business Phone'] = 'Not found';
    business.Selskapsform = 'Not found';
    business['Antall Ansatte'] = 'Not found';
    business.Tier = '';
    business.Orgnr = '';
    business['Brreg Name'] = '';
    business['Brreg Parent Orgnr'] = '';
    business['Match Score'] = '';
    business['Match Confidence'] = '';
  }

  if (dataIndex !== -1) {
    Object.assign(data[dataIndex], business);
  }
}

async function expandExcelWithContactPersons(excelFilename = null) {
  if (!excelFilename) {
    excelFilename = resolveScrapeInputFile(null);
    if (!excelFilename) {
      console.error('❌ No Excel file found in current directory');
      process.exit(1);
    }
    console.log(`📄 Using scrape file: ${excelFilename}`);
  } else if (!fs.existsSync(excelFilename)) {
    console.error(`❌ File not found: ${excelFilename}`);
    process.exit(1);
  } else {
    console.log(`📄 Using specified file: ${excelFilename}`);
  }

  console.log('\n📖 Reading Excel file...');
  const workbook = xlsx.readFile(excelFilename);
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = xlsx.utils.sheet_to_json(worksheet);

  if (data.length === 0) {
    console.error('❌ No data found in Excel file');
    process.exit(1);
  }

  ensureColumns(data);
  console.log(`✅ Found ${data.length} businesses in scrape file\n`);

  const skipMasterList = EXPAND_PERF.SKIP_MASTER_LIST_DEDUPE;
  const exclusionPaths = skipMasterList ? [] : discoverExclusionPaths(process.argv[3]);
  const existingLeads =
    exclusionPaths.length > 0 ? loadCombinedExistingLeadIndex(exclusionPaths) : null;

  if (skipMasterList) {
    console.log('ℹ️  Existing-lead dedupe skipped (SKIP_MASTER_LIST=1). All scrape rows will be expanded.\n');
  }

  let dataToExpand = data;
  if (existingLeads) {
    console.log('='.repeat(60));
    console.log('🚫 EXCLUDING EXISTING LEADS');
    console.log('='.repeat(60));
    console.log(`📋 Exclusion sources (${existingLeads.sourceFiles.length} files, ${existingLeads.count} rows read):`);
    for (const src of existingLeads.sourceFiles) {
      console.log(`   - ${src}`);
    }

    const { kept, excluded } = filterNewLeads(data, existingLeads);
    const byReason = {};
    for (const { reason } of excluded) {
      byReason[reason] = (byReason[reason] || 0) + 1;
    }

    console.log(`   Scrape rows: ${data.length}`);
    console.log(`   Already in master list: ${excluded.length}`);
    console.log(`   New leads to expand: ${kept.length}`);
    if (excluded.length > 0) {
      console.log('   Match reasons:', Object.entries(byReason).map(([k, v]) => `${k}=${v}`).join(', '));
    }
    console.log('='.repeat(60) + '\n');

    if (kept.length === 0) {
      console.error('❌ No new leads left after excluding your existing list.');
      process.exit(1);
    }

    const newOnlyFilename = excelFilename.replace('.xlsx', '_NEW_ONLY.xlsx');
    const newOnlyWorkbook = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(newOnlyWorkbook, xlsx.utils.json_to_sheet(kept), 'New leads');
    xlsx.writeFile(newOnlyWorkbook, newOnlyFilename);
    console.log(`💾 New-leads-only file: ${newOnlyFilename}\n`);

    dataToExpand = kept;
    excelFilename = newOnlyFilename;
  } else if (!skipMasterList && exclusionPaths.length > 0 && !existingLeads) {
    console.log('⚠️  Exclusion files not found — processing all rows\n');
  } else if (!skipMasterList) {
    console.log('ℹ️  No master list file — processing all scrape rows\n');
  }

  const businessesToProcess = TEST_LIMIT ? dataToExpand.slice(0, TEST_LIMIT) : dataToExpand;
  if (TEST_LIMIT) {
    console.log(`🧪 TESTING MODE: Processing only first ${TEST_LIMIT} businesses\n`);
  }

  let updatedCount = 0;
  let foundCount = 0;
  let notFoundCount = 0;
  let shouldStop = false;
  let lastSavedFilename = null;
  const expandOutputFile = getExpandOutputFile(excelFilename);
  writeProgress({
    scrapeOutputFile: excelFilename,
    expandOutputFile,
  });
  console.log(`📁 Expand output (one file, updated during matching): ${expandOutputFile}\n`);

  const saveProgress = async (force = false) => {
    try {
      const newWorksheet = xlsx.utils.json_to_sheet(businessesToProcess);
      const newWorkbook = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(newWorkbook, newWorksheet, 'Results');

      xlsx.writeFile(newWorkbook, expandOutputFile);
      lastSavedFilename = expandOutputFile;

      if (updatedCount % 10 === 0 || force) {
        console.log(
          `\n💾 Expand saved: ${expandOutputFile} (${updatedCount}/${businessesToProcess.length} rows)`
        );
      }
      return expandOutputFile;
    } catch (error) {
      console.error(`\n⚠️  Error saving progress: ${error.message}`);
      return null;
    }
  };

  let isShuttingDown = false;
  const shutdownHandler = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n\n⚠️  ${signal} received. Saving progress...`);
    shouldStop = true;
    const savedFile = await saveProgress(true);
    if (savedFile) {
      console.log(`\n✅ Progress saved: ${path.resolve(savedFile)}`);
    }
    console.log('\n👋 Exiting...\n');
    setTimeout(() => process.exit(0), 500);
  };

  process.on('SIGINT', () => shutdownHandler('SIGINT').catch(() => process.exit(1)));
  process.on('SIGTERM', () => shutdownHandler('SIGTERM').catch(() => process.exit(1)));

  console.log('='.repeat(60));
  console.log(
    `📌 Brreg matching (${FAST_MODE ? '⚡ fast' : 'standard'} — concurrency ${MATCH_CONCURRENCY})`
  );
  console.log(`📊 Live progress: ${PROGRESS_TXT}`);
  console.log('='.repeat(60) + '\n');

  const expandStartedAtMs = Date.now();
  clearProgress('expand');
  reportExpandProgress(
    {
      processed: 0,
      total: businessesToProcess.length,
      startedAtMs: expandStartedAtMs,
      matched: 0,
      inputFile: excelFilename,
    },
    { log: true }
  );

  const matchLog = EXPAND_PERF.QUIET_LOGS ? () => {} : (msg) => console.log(msg);

  async function processOneBusiness(business, index) {
    if (index < START_FROM_INDEX || shouldStop) return;

    const businessName = business.Name || business.name || 'Unknown';
    if (!EXPAND_PERF.QUIET_LOGS) {
      console.log(`\n[${index + 1}/${businessesToProcess.length}] 🔍 ${businessName}`);
    }

    try {
      const match = await matchBusinessToBrreg(business, matchLog);

      if (match) {
        foundCount++;
        if (!EXPAND_PERF.QUIET_LOGS) {
          console.log(`  📋 Orgnr: ${match.orgnr} | ${match.brregName} | Tier ${match.tier}`);
        }
      } else {
        notFoundCount++;
      }

      applyMatchToRow(business, match, null, -1);
      updatedCount++;

      if (API_DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, API_DELAY_MS));
      }
    } catch (e) {
      console.error(`  ❌ ${businessName}: ${e.message}`);
      applyMatchToRow(business, null, null, -1);
      updatedCount++;
      notFoundCount++;
    }
  }

  const queue = businessesToProcess.map((business, index) => ({ business, index }));
  for (let i = 0; i < queue.length && !shouldStop; i += MATCH_CONCURRENCY) {
    const batch = queue.slice(i, i + MATCH_CONCURRENCY);
    await Promise.all(batch.map(({ business, index }) => processOneBusiness(business, index)));

    if (updatedCount % SAVE_EVERY_N === 0 || i + MATCH_CONCURRENCY >= queue.length) {
      await saveProgress();
    }

    const shouldLogExpand =
      updatedCount % 10 === 0 || i + MATCH_CONCURRENCY >= queue.length;
    if (shouldLogExpand) {
      reportExpandProgress(
        {
          processed: updatedCount,
          total: businessesToProcess.length,
          startedAtMs: expandStartedAtMs,
          matched: foundCount,
          inputFile: excelFilename,
        },
        { log: true }
      );
    }
  }

  if (!shouldStop) {
    console.log('\n💾 Saving final progress...');
    await saveProgress(true);
  }

  console.log('\n' + '='.repeat(60));
  console.log('🔍 PHONE FILTER (report only — source file unchanged)');
  console.log('='.repeat(60));

  const beforeFilterCount = businessesToProcess.length;
  let filteredOutPhone = 0;

  const withPhone = businessesToProcess.filter((business) => {
    const googlePhone = (business.Phone || '').trim();
    const businessPhone = (business['Business Phone'] || '').trim();
    const hasGooglePhone = googlePhone && googlePhone !== 'Not found' && googlePhone.length >= 8;
    const hasBusinessPhone = businessPhone && businessPhone !== 'Not found' && businessPhone.length >= 8;

    if (hasGooglePhone || hasBusinessPhone) {
      business['Has Valid Phone'] = true;
      return true;
    }
    business['Has Valid Phone'] = false;
    filteredOutPhone++;
    return false;
  });

  const matchedCount = businessesToProcess.filter(
    (b) => b.Orgnr && String(b.Orgnr).replace(/\D/g, '').length >= 8
  ).length;
  const matchedWithPhone = withPhone.filter(
    (b) => b.Orgnr && String(b.Orgnr).replace(/\D/g, '').length >= 8
  ).length;

  console.log('\n' + '-'.repeat(60));
  console.log(`📊 All rows kept in _EXPANDED: ${beforeFilterCount}`);
  console.log(`📊 With valid phone: ${withPhone.length} (would remove ${filteredOutPhone})`);
  console.log(`📊 Matched (all): ${matchedCount} (${((matchedCount / beforeFilterCount) * 100).toFixed(1)}%)`);
  console.log(
    `📊 Matched + phone: ${matchedWithPhone} (${((matchedWithPhone / beforeFilterCount) * 100).toFixed(1)}%)`
  );
  console.log('='.repeat(60) + '\n');

  console.log('\n' + '='.repeat(60));
  console.log('📊 EXPANSION SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total processed: ${updatedCount}`);
  console.log(`Matched (Brreg): ${foundCount}`);
  console.log(`Not matched: ${notFoundCount}`);
  console.log(`Match rate: ${((foundCount / updatedCount) * 100).toFixed(1)}%`);
  console.log(`Rows without phone (kept in file): ${filteredOutPhone}`);
  if (lastSavedFilename) {
    console.log(`✅ Expand complete — final file: ${lastSavedFilename}`);
  }
  console.log('='.repeat(60) + '\n');
  markDone(
    `Expand finished · ${updatedCount} rows · ${foundCount} Brreg matches · ${lastSavedFilename || expandOutputFile}`
  );
}

const excelFile = process.argv[2];

console.log('🚀 Starting Brreg-based Excel expansion...\n');
expandExcelWithContactPersons(excelFile)
  .then(() => {
    console.log('✅ Expansion completed successfully!');
  })
  .catch((error) => {
    console.error('❌ Expansion failed:', error);
    process.exit(1);
  });
