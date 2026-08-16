const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');

function isRealBusinessWebsite(url, businessName) {
  if (!url || url === 'Not found') return false;

  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname.toLowerCase().replace(/^www\./, '');

    const nonBusinessDomains = [
      'facebook.com',
      'instagram.com',
      'linkedin.com',
      'twitter.com',
      'x.com',
      'youtube.com',
      'tiktok.com',
      'snapchat.com',
      'pinterest.com',
      'tripadvisor.com',
      'yelp.com',
      'foursquare.com',
      'google.com',
      'maps.google.com',
      'goo.gl',
      'g.page',
      'booking.com',
      'airbnb.com',
      'wixsite.com',
    ];

    for (const nonBusiness of nonBusinessDomains) {
      if (domain === nonBusiness || domain.endsWith(`.${nonBusiness}`)) {
        return false;
      }
    }

    if (businessName && businessName !== 'Unknown Business') {
      const cleanBusinessName = businessName
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')
        .substring(0, 8);
      const cleanDomain = domain.replace(/[^a-z0-9]/g, '');
      if (cleanBusinessName.length > 3 && cleanDomain.includes(cleanBusinessName)) {
        return true;
      }
    }

    const businessTlds = ['.no', '.com', '.net', '.org', '.biz', '.info'];
    return businessTlds.some((tld) => domain.endsWith(tld)) && domain.length > 5;
  } catch {
    return false;
  }
}

function loadRunProgress() {
  const p = path.join(__dirname, 'run-progress.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function resolveInputFile(cliArg) {
  if (cliArg) return cliArg;
  const progress = loadRunProgress();
  if (progress?.scrapeAllOutputFile && fs.existsSync(progress.scrapeAllOutputFile)) {
    return progress.scrapeAllOutputFile;
  }
  return null;
}

function main() {
  const inputFile = resolveInputFile(process.argv[2]);
  if (!inputFile) {
    throw new Error('No input file found. Pass _ALL.xlsx as argument or ensure run-progress.json has scrapeAllOutputFile.');
  }
  if (!fs.existsSync(inputFile)) {
    throw new Error(`Input file not found: ${inputFile}`);
  }

  const workbook = xlsx.readFile(inputFile);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet);

  let removedClosed = 0;
  let removedWebsite = 0;

  const kept = rows.filter((row) => {
    const status = String(row['Business Status'] || '').toUpperCase();
    if (status === 'CLOSED_PERMANENTLY') {
      removedClosed += 1;
      return false;
    }

    if (isRealBusinessWebsite(row.Website, row.Name)) {
      removedWebsite += 1;
      return false;
    }

    // Review filter intentionally disabled here (0+ reviews).
    return true;
  });

  const outputFile = inputFile.replace(/_ALL\.xlsx$/i, '_REVIEWS_0PLUS.xlsx');
  const outWorkbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(outWorkbook, xlsx.utils.json_to_sheet(kept), 'Results');
  xlsx.writeFile(outWorkbook, outputFile);

  console.log(`Input: ${inputFile}`);
  console.log(`Rows in _ALL: ${rows.length}`);
  console.log(`Removed closed permanently: ${removedClosed}`);
  console.log(`Removed because has real website: ${removedWebsite}`);
  console.log(`Kept with 0+ reviews: ${kept.length}`);
  console.log(`Output: ${outputFile}`);
}

main();
