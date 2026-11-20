/**
 * Recover businesses that were skipped for low reviews (old 8+ rule) from a scraper log,
 * re-apply filters (MIN_REVIEW_COUNT+ reviews, no real website), merge into existing Excel, expand new rows only.
 *
 * Usage:
 *   node recover_review_skipped.js [logPath] [baseExcel]
 */

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { isRealBusinessWebsite, cleanWebsiteUrl } = require('./lib/website-filter');
const { filterRowsWithValidPhone } = require('./lib/phone-filter');
const { matchBusinessToBrreg } = require('./lib/match');
const { loadEnv } = require('./lib/ai-match');
const { MIN_REVIEW_COUNT } = require('./lib/filters');

loadEnv();
const OLD_MAX_SKIPPED = 7; // Old run skipped 0–7 reviews
const API_DELAY_MS = 300;

const DEFAULT_LOG = path.join(
  process.env.USERPROFILE || '',
  '.cursor/projects/c-Asoldi-Asoldi-code-maps-scraper-maps-scraper/terminals/474256.txt'
);
const DEFAULT_BASE = 'GoogleMapsResults_2026-05-20T17-26-17_EXPANDED.xlsx';

function findDebugIndustry(lines, finishedLineIndex) {
  for (let i = finishedLineIndex; i >= Math.max(0, finishedLineIndex - 15); i--) {
    const m = lines[i].match(/no_more_results_[^_]+_debug\.json/);
    if (m) {
      const debugPath = path.join(__dirname, 'error handeling log', m[0]);
      if (fs.existsSync(debugPath)) {
        const debug = JSON.parse(fs.readFileSync(debugPath, 'utf8'));
        if (debug.context?.industry) return debug.context.industry;
      }
    }
  }
  return 'unknown';
}

function buildScrapeSegments(lines) {
  const segments = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^Finished scrolling\. Total business URLs collected: (\d+)/);
    if (!m) continue;
    const industry = findDebugIndustry(lines, i);
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].match(/^Finished scrolling\. Total business URLs collected:/)) {
        end = j;
        break;
      }
    }
    segments.push({ start: i, end, total: +m[1], industry });
  }
  return segments;
}

function segmentForLine(segments, lineIndex) {
  for (const seg of segments) {
    if (lineIndex >= seg.start && lineIndex < seg.end) return seg;
  }
  return null;
}

function parseReviewSkippedFromLog(logPath) {
  const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/);
  const segments = buildScrapeSegments(lines);
  const recovered = [];
  const stats = {
    reviewSkippedInLog: 0,
    inReviewRange: 0,
    hasWebsite: 0,
    kept: 0,
  };

  let current = null;
  let currentLine = 0;

  const flush = () => {
    if (!current) return;
    const seg = segmentForLine(segments, currentLine);
    const industry = seg?.industry || 'unknown';
    const reviewCount = current.reviewCount ?? 0;

    if (current.skipReason === 'reviews') {
      stats.reviewSkippedInLog++;
      if (reviewCount >= MIN_REVIEW_COUNT && reviewCount <= OLD_MAX_SKIPPED) {
        stats.inReviewRange++;
        const name = current.Name || '';
        const website = current['Website (original)'] || current.Website || '';
        if (isRealBusinessWebsite(website, name)) {
          stats.hasWebsite++;
        } else {
          stats.kept++;
          recovered.push({
            Name: name,
            Address: current.Address || '',
            Website: cleanWebsiteUrl(website, name),
            Phone: current.Phone === 'null' ? '' : current.Phone || '',
            Email: 'Not found',
            'Contact Person': 'Not found',
            'Business Phone': 'Not found',
            Rating: current.Rating === 'Not found' ? '' : current.Rating || '',
            'Review Count': reviewCount,
            Hours: current.Hours === 'Not found' ? '' : current.Hours || '',
            PriceLevel: current['Price Level'] === 'Not found' ? '' : current['Price Level'] || '',
            Industry: industry,
            MapsUrl: current.URL || '',
          });
        }
      }
    }
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    currentLine = i;
    const line = lines[i];

    if (line.startsWith('Name: ')) {
      flush();
      current = { Name: line.slice(6).trim() };
      continue;
    }
    if (!current) continue;

    if (line.startsWith('URL: ')) current.URL = line.slice(5).trim();
    else if (line.startsWith('Address: ')) current.Address = line.slice(9).trim();
    else if (line.startsWith('Website (original): ')) current['Website (original)'] = line.slice(20).trim();
    else if (line.startsWith('Phone: ')) current.Phone = line.slice(7).trim();
    else if (line.startsWith('Rating: ')) current.Rating = line.slice(8).trim();
    else if (line.startsWith('Review Count: ')) current.reviewCount = parseInt(line.slice(14), 10) || 0;
    else if (line.startsWith('Hours: ')) current.Hours = line.slice(7).trim();
    else if (line.startsWith('Price Level: ')) current['Price Level'] = line.slice(13).trim();
    else if (/Only \d+ reviews \(need over 7/.test(line)) {
      current.skipReason = 'reviews';
      flush();
    } else if (line.startsWith('✅ KEEPING ') || line.startsWith('❌ SKIPPING') && line.includes('Has real business website')) {
      current.skipReason = 'other';
      flush();
    } else if (line === '---------------------------') {
      flush();
    }
  }
  flush();

  return { recovered, stats };
}

function dedupeKey(row) {
  const url = row.MapsUrl || '';
  if (url) return url.split('?')[0];
  return `${(row.Name || '').toLowerCase()}|${(row.Address || '').toLowerCase()}`;
}

function loadExistingRows(baseExcel) {
  const wb = xlsx.readFile(baseExcel);
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return { workbook: wb, rows: xlsx.utils.sheet_to_json(sheet) };
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

function applyMatchToRow(business, match) {
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
}

async function expandNewRows(rows) {
  ensureColumns(rows);
  for (let i = 0; i < rows.length; i++) {
    const business = rows[i];
    const name = business.Name || 'Unknown';
    console.log(`\n[${i + 1}/${rows.length}] 🔍 ${name}`);
    try {
      const match = await matchBusinessToBrreg(business, (msg) => console.log(msg));
      applyMatchToRow(business, match);
    } catch (e) {
      console.error(`  ❌ ${e.message}`);
      applyMatchToRow(business, null);
    }
    if (i < rows.length - 1) {
      await new Promise((r) => setTimeout(r, API_DELAY_MS));
    }
  }
}

async function main() {
  const logPath = process.argv[2] || DEFAULT_LOG;
  const baseExcel = process.argv[3] || DEFAULT_BASE;

  if (!fs.existsSync(logPath)) {
    console.error(`❌ Log not found: ${logPath}`);
    process.exit(1);
  }
  if (!fs.existsSync(baseExcel)) {
    console.error(`❌ Base Excel not found: ${baseExcel}`);
    process.exit(1);
  }

  console.log('📜 Parsing scraper log for review-skipped businesses...');
  console.log(`   Log: ${logPath}`);
  const { recovered, stats } = parseReviewSkippedFromLog(logPath);

  console.log('\n📊 Recovery parse stats');
  console.log(`   Skipped for reviews in log (old 8+ rule): ${stats.reviewSkippedInLog}`);
  console.log(`   With ${MIN_REVIEW_COUNT}–${OLD_MAX_SKIPPED} reviews: ${stats.inReviewRange}`);
  console.log(`   Excluded (has real website): ${stats.hasWebsite}`);
  console.log(`   Eligible to add: ${stats.kept}`);

  let basePath = baseExcel;
  if (!basePath.includes('_EXPANDED') && fs.existsSync(basePath.replace('.xlsx', '_EXPANDED.xlsx'))) {
    basePath = basePath.replace('.xlsx', '_EXPANDED.xlsx');
    console.log(`   Using expanded base: ${basePath}`);
  }

  const { workbook, rows: existing } = loadExistingRows(basePath);
  ensureColumns(existing);
  const seen = new Set(existing.map(dedupeKey));

  const newRows = [];
  let duplicates = 0;
  for (const row of recovered) {
    const key = dedupeKey(row);
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    const { MapsUrl, ...excelRow } = row;
    newRows.push(excelRow);
  }

  console.log(`\n📂 Existing rows: ${existing.length}`);
  console.log(`   Duplicates vs existing file: ${duplicates}`);
  console.log(`   New rows to add: ${newRows.length}`);

  if (newRows.length === 0) {
    console.log('\n✅ Nothing new to add.');
    return;
  }

  console.log('\n🔍 Expanding new rows only (Brreg)...');
  await expandNewRows(newRows);

  ensureColumns(newRows);
  const mergedAll = [...existing, ...newRows];
  const beforePhone = mergedAll.length;
  const merged = filterRowsWithValidPhone(mergedAll);
  const removedPhone = beforePhone - merged.length;

  console.log(`\n📞 Phone filter: ${beforePhone} → ${merged.length} (removed ${removedPhone} without phone)`);

  const stem = basePath.replace(/_EXPANDED\.xlsx$/i, '').replace(/\.xlsx$/i, '');
  const outExpanded = `${stem}_RECOVERED_EXPANDED.xlsx`;

  const wbE = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wbE, xlsx.utils.json_to_sheet(merged), workbook.SheetNames[0]);
  for (let i = 1; i < workbook.SheetNames.length; i++) {
    xlsx.utils.book_append_sheet(wbE, workbook.Sheets[workbook.SheetNames[i]], workbook.SheetNames[i]);
  }
  xlsx.writeFile(wbE, outExpanded);

  const cp = merged.filter((r) => r['Contact Person'] && r['Contact Person'] !== 'Not found').length;
  const bp = merged.filter((r) => r['Business Phone'] && r['Business Phone'] !== 'Not found').length;
  console.log('\n✅ Done');
  console.log(`   📁 ${path.resolve(outExpanded)} (${merged.length} rows, phone filter applied)`);
  console.log(`   Contact Person filled: ${cp} | Business Phone filled: ${bp}`);
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
