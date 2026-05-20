const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
const { matchBusinessToBrreg } = require('./lib/match');
const { loadEnv } = require('./lib/ai-match');

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

  const saveProgress = async (force = false) => {
    try {
      if (TEST_LIMIT) {
        businessesToProcess.forEach((processed) => {
          const originalIdx = data.findIndex(
            (b) => (b.Name || b.name) === (processed.Name || processed.name)
          );
          if (originalIdx !== -1) data[originalIdx] = processed;
        });
      }

      const newWorksheet = xlsx.utils.json_to_sheet(data);
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
        console.log(`\n💾 Progress saved to: ${progressFilename} (${updatedCount} processed)`);
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
        console.log(`  📋 Orgnr: ${match.orgnr} | ${match.brregName} | Tier ${match.tier}`);
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

  if (!shouldStop) {
    console.log('\n💾 Saving final progress...');
    await saveProgress(true);
  }

  console.log('\n' + '='.repeat(60));
  console.log('🔍 PHONE FILTER (report only — source file unchanged)');
  console.log('='.repeat(60));

  const beforeFilterCount = data.length;
  let filteredOutPhone = 0;

  const withPhone = data.filter((business) => {
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

  const matchedCount = data.filter(
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
    console.log(`📁 Output: ${lastSavedFilename}`);
  }
  console.log('='.repeat(60) + '\n');
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
