const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const { matchBusinessToBrreg } = require('./lib/match');
const { loadEnv } = require('./lib/ai-match');
const { hasValidPhone, filterRowsWithValidPhone } = require('./lib/phone-filter');
const { passesOrgFormFilter, hasBrregWebsite } = require('./lib/filters');
const { flushRegnskapCache } = require('./lib/brreg-regnskap');

loadEnv();

const TEST_LIMIT = null;
const START_FROM_INDEX = 0;
const API_DELAY_MS = 300;

function findMostRecentExcelFile() {
  const files = fs
    .readdirSync('.')
    .filter((file) => file.endsWith('.xlsx') && !file.startsWith('~$') && !file.includes('_EXPANDED'))
    .map((file) => ({
      name: file,
      time: fs.statSync(file).mtime.getTime(),
    }))
    .sort((a, b) => b.time - a.time);

  return files.length > 0 ? files[0].name : null;
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
    'Accounting Orgnr': '',
    'Revenue NOK': '',
    'Revenue Year': '',
    'Operating Profit': '',
    'Net Profit': '',
    Equity: '',
    'Accounting Status': '',
    'Brreg Website': '',
    'Has Brreg Website': '',
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
    business['Accounting Orgnr'] = match.accountingOrgnr || '';
    business['Revenue NOK'] = match.revenueNok ?? '';
    business['Revenue Year'] = match.revenueYear || '';
    business['Operating Profit'] = match.operatingProfit ?? '';
    business['Net Profit'] = match.netProfit ?? '';
    business.Equity = match.equity ?? '';
    business['Accounting Status'] = match.accountingStatus || '';
    business['Brreg Website'] = match.brregWebsite || '';
    business['Has Brreg Website'] = hasBrregWebsite(match.brregWebsite);
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
    business['Accounting Orgnr'] = '';
    business['Revenue NOK'] = '';
    business['Revenue Year'] = '';
    business['Operating Profit'] = '';
    business['Net Profit'] = '';
    business.Equity = '';
    business['Accounting Status'] = '';
    business['Brreg Website'] = '';
    business['Has Brreg Website'] = '';
  }

  if (dataIndex !== -1) {
    Object.assign(data[dataIndex], business);
  }
}

async function expandExcelWithContactPersons(excelFilename = null) {
  if (!excelFilename) {
    excelFilename = findMostRecentExcelFile();
    if (!excelFilename) {
      console.error('❌ No Excel file found in current directory');
      process.exit(1);
    }
    console.log(`📄 Using most recent file: ${excelFilename}`);
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
  console.log(`✅ Found ${data.length} businesses to process\n`);

  const businessesToProcess = TEST_LIMIT ? data.slice(0, TEST_LIMIT) : data;
  if (TEST_LIMIT) {
    console.log(`🧪 TESTING MODE: Processing only first ${TEST_LIMIT} businesses\n`);
  }

  let updatedCount = 0;
  let foundCount = 0;
  let notFoundCount = 0;
  let shouldStop = false;
  let lastSavedFilename = null;

  const saveProgress = async (force = false, options = {}) => {
    const { applyPhoneFilter = false } = options;
    try {
      if (TEST_LIMIT) {
        businessesToProcess.forEach((processed) => {
          const originalIdx = data.findIndex(
            (b) => (b.Name || b.name) === (processed.Name || processed.name)
          );
          if (originalIdx !== -1) data[originalIdx] = processed;
        });
      }

      let rowsToWrite = data;
      if (applyPhoneFilter) {
        rowsToWrite = filterRowsWithValidPhone([...data]).filter(passesOrgFormFilter);
      }
      const newWorksheet = xlsx.utils.json_to_sheet(rowsToWrite);
      const newWorkbook = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(newWorkbook, newWorksheet, workbook.SheetNames[0]);

      for (let i = 1; i < workbook.SheetNames.length; i++) {
        const sheet = workbook.Sheets[workbook.SheetNames[i]];
        xlsx.utils.book_append_sheet(newWorkbook, sheet, workbook.SheetNames[i]);
      }

      const progressFilename = excelFilename.replace('.xlsx', '_EXPANDED.xlsx');
      xlsx.writeFile(newWorkbook, progressFilename);
      lastSavedFilename = progressFilename;

      if (updatedCount % 10 === 0 || force) {
        const suffix = applyPhoneFilter ? ', phone filter applied' : ', all rows (pre phone filter)';
        console.log(`\n💾 Progress saved to: ${progressFilename} (${updatedCount} processed${suffix})`);
      }
      return progressFilename;
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
  console.log('📌 Brreg matching (API + DeepSeek for Tier 2/3)');
  console.log('='.repeat(60) + '\n');

  for (const [index, business] of businessesToProcess.entries()) {
    if (index < START_FROM_INDEX) continue;
    if (shouldStop) break;

    const businessName = business.Name || business.name || 'Unknown';
    console.log(`\n[${index + 1}/${businessesToProcess.length}] 🔍 ${businessName}`);

    try {
      const dataIndex = data.findIndex((b) => (b.Name || b.name) === businessName);
      const match = await matchBusinessToBrreg(business, (msg) => console.log(msg));

      if (match) {
        foundCount++;
        const rev =
          match.revenueNok != null ? `${Math.round(match.revenueNok / 1e6)}M (${match.revenueYear})` : match.accountingStatus;
        console.log(`  📋 Orgnr: ${match.orgnr} | ${match.brregName} | Tier ${match.tier} | omsetning ${rev}`);
      } else {
        notFoundCount++;
      }

      applyMatchToRow(business, match, data, dataIndex);
      updatedCount++;
      await saveProgress();

      if (index < businessesToProcess.length - 1 && !shouldStop) {
        await new Promise((r) => setTimeout(r, API_DELAY_MS));
      }
    } catch (e) {
      console.error(`  ❌ Error: ${e.message}`);
      const dataIndex = data.findIndex((b) => (b.Name || b.name) === businessName);
      applyMatchToRow(business, null, data, dataIndex);
      updatedCount++;
      notFoundCount++;
    }
  }

  const beforeFilterCount = data.length;
  let filteredOutPhone = 0;
  let withPhoneCount = 0;

  if (!shouldStop) {
    console.log('\n📞 Applying phone filter (Google Phone or Business Phone, 8+ digits)...');
    withPhoneCount = data.filter((b) => hasValidPhone(b)).length;
    filteredOutPhone = beforeFilterCount - withPhoneCount;
    const enkCount = data.filter((b) => !passesOrgFormFilter(b)).length;
    console.log(`   Before: ${beforeFilterCount} | With phone: ${withPhoneCount} | No phone: ${filteredOutPhone} | ENK removed: ${enkCount}`);
    console.log('\n💾 Saving final _EXPANDED (phone + ENK filters applied)...');
    await saveProgress(true, { applyPhoneFilter: true });
  } else {
    console.log('\n💾 Interrupted — saving progress without phone filter (re-run expand to finish + filter)');
    await saveProgress(true);
    withPhoneCount = data.filter((b) => hasValidPhone(b)).length;
    filteredOutPhone = beforeFilterCount - withPhoneCount;
  }

  const matchedCount = data.filter(
    (b) => b.Orgnr && String(b.Orgnr).replace(/\D/g, '').length >= 8
  ).length;
  const matchedWithPhone = data.filter(
    (b) =>
      hasValidPhone(b) && b.Orgnr && String(b.Orgnr).replace(/\D/g, '').length >= 8
  ).length;

  console.log('\n' + '='.repeat(60));
  console.log('📞 PHONE FILTER');
  console.log('='.repeat(60));
  console.log(`📊 Expanded (before phone filter): ${beforeFilterCount}`);
  console.log(`📊 With valid phone: ${withPhoneCount}`);
  console.log(`📊 Removed (no phone): ${filteredOutPhone}`);
  console.log(`📊 Matched (Brreg, all expanded): ${matchedCount}`);
  console.log(`📊 Matched + valid phone: ${matchedWithPhone}`);
  console.log('='.repeat(60) + '\n');

  console.log('\n' + '='.repeat(60));
  console.log('📊 EXPANSION SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total processed: ${updatedCount}`);
  console.log(`Matched (Brreg): ${foundCount}`);
  console.log(`Not matched: ${notFoundCount}`);
  console.log(`Match rate: ${((foundCount / updatedCount) * 100).toFixed(1)}%`);
  console.log(
    `Rows in final file: ${shouldStop ? beforeFilterCount : withPhoneCount} (${shouldStop ? 'no phone filter — interrupted' : 'phone filter applied'})`
  );
  if (lastSavedFilename) {
    console.log(`📁 Output: ${lastSavedFilename}`);
  }
  console.log('='.repeat(60) + '\n');
  flushRegnskapCache();
}

module.exports = { expandExcelWithContactPersons, hasValidPhone, filterRowsWithValidPhone };

if (require.main === module) {
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
}
