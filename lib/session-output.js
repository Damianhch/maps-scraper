const fs = require('fs');
const path = require('path');
const { CUMULATIVE_ALL_FILE } = require('./performance-config');

const PROGRESS_JSON = path.join(__dirname, '..', 'run-progress.json');

let sessionBasename = null;

function initSession() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  sessionBasename = `GoogleMapsResults_${timestamp}`;
  return sessionBasename;
}

function getSessionBasename() {
  if (!sessionBasename) initSession();
  return sessionBasename;
}

function getScrapeOutputFile() {
  return `${getSessionBasename()}.xlsx`;
}

/** All Places rows, deduped only — no review/website/status filters. */
function getScrapeAllOutputFile() {
  return `${getSessionBasename()}_ALL.xlsx`;
}

function getCumulativeAllOutputFile() {
  return CUMULATIVE_ALL_FILE;
}

function getExpandOutputFile(scrapeFile) {
  const base = scrapeFile || getScrapeOutputFile();
  return base.replace(/\.xlsx$/i, '_EXPANDED.xlsx');
}

function persistSessionPaths() {
  const scrapeOutputFile = getScrapeOutputFile();
  const scrapeAllOutputFile = getScrapeAllOutputFile();
  const expandOutputFile = getExpandOutputFile(scrapeOutputFile);
  let prev = {};
  try {
    prev = JSON.parse(fs.readFileSync(PROGRESS_JSON, 'utf8'));
  } catch {
    /* no prior progress */
  }
  fs.writeFileSync(
    PROGRESS_JSON,
    JSON.stringify(
      {
        ...prev,
        sessionBasename: getSessionBasename(),
        scrapeOutputFile,
        scrapeAllOutputFile,
        cumulativeAllOutputFile: getCumulativeAllOutputFile(),
        expandOutputFile,
        updatedAt: new Date().toISOString(),
      },
      null,
      2
    ),
    'utf8'
  );
  return {
    scrapeOutputFile,
    scrapeAllOutputFile,
    expandOutputFile,
    cumulativeAllOutputFile: getCumulativeAllOutputFile(),
  };
}

function readScrapeOutputFromProgress() {
  try {
    const progress = JSON.parse(fs.readFileSync(PROGRESS_JSON, 'utf8'));
    if (progress.scrapeOutputFile && fs.existsSync(progress.scrapeOutputFile)) {
      return progress.scrapeOutputFile;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function readExpandOutputFromProgress() {
  try {
    const progress = JSON.parse(fs.readFileSync(PROGRESS_JSON, 'utf8'));
    if (progress.expandOutputFile) {
      return progress.expandOutputFile;
    }
    if (progress.scrapeOutputFile) {
      return getExpandOutputFile(progress.scrapeOutputFile);
    }
  } catch {
    /* ignore */
  }
  return null;
}

module.exports = {
  initSession,
  getSessionBasename,
  getScrapeOutputFile,
  getScrapeAllOutputFile,
  getCumulativeAllOutputFile,
  getExpandOutputFile,
  persistSessionPaths,
  readScrapeOutputFromProgress,
  readExpandOutputFromProgress,
};
