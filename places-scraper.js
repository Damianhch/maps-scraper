const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { loadEnv } = require('./lib/ai-match');
const { FAST_MODE, SCRAPER: PERF, PLACES } = require('./lib/performance-config');
const {
  clearProgress,
  reportScrapeProgress,
  markDone,
  PROGRESS_TXT,
} = require('./lib/run-progress');
const {
  initSession,
  getScrapeOutputFile,
  getScrapeAllOutputFile,
  getCumulativeAllOutputFile,
  getExpandOutputFile,
  persistSessionPaths,
} = require('./lib/session-output');

loadEnv();

const NUM_PARALLEL_WORKERS = PLACES.PARALLEL_INDUSTRIES || PERF.NUM_PARALLEL_BROWSERS;
const MIN_REVIEW_COUNT = PERF.MIN_REVIEW_COUNT;
const EXCLUDE_BUSINESS_STATUSES = PLACES.EXCLUDE_BUSINESS_STATUSES || ['CLOSED_PERMANENTLY'];
const INDUSTRIES_FILE = 'list of industries.txt';

const gracefulShutdown = {
  isShuttingDown: false,
  shouldStop: false,
  /** Dedupe keys only in RAM — row data lives on disk in the session Excel files. */
  rawDedupe: null,
  filteredDedupe: null,
  timingData: [],
  saveQueue: Promise.resolve(),
  overallStartTime: null,
  industriesProcessed: 0,
  totalIndustries: 0,
  workerStatus: [],
  currentIndustries: [],
  apiRequests: 0,
};

function getApiKey() {
  const key =
    process.env.PLACES_API_KEY ||
    process.env.GOOGLE_MAPS_API_KEY ||
    process.env.GOOGLE_API_KEY;
  if (!key) {
    throw new Error(
      'Missing Places API key. Set PLACES_API_KEY (or GOOGLE_MAPS_API_KEY) in env.'
    );
  }
  return key;
}

function readIndustriesFromFile() {
  const filePath = path.join(__dirname, INDUSTRIES_FILE);
  const content = fs.readFileSync(filePath, 'utf-8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeRating(rating) {
  if (rating == null || Number.isNaN(Number(rating))) return '';
  return String(rating).replace('.', ',');
}

function isRealBusinessWebsite(url, businessName) {
  if (!url || url === 'Not found') {
    return false;
  }

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

function cleanWebsiteUrl(url, businessName) {
  if (!url || url === 'Not found') {
    return '';
  }
  return isRealBusinessWebsite(url, businessName) ? url : '';
}

function placeToBusiness(place, industry) {
  const name = place.displayName?.text || 'Unknown Business';
  const address = place.formattedAddress || '';
  const website = place.websiteUri || 'Not found';
  const phone = place.nationalPhoneNumber || '';
  const rating = normalizeRating(place.rating);
  const reviewCount = Number(place.userRatingCount || 0);
  const location = place.location || {};

  return {
    Name: name,
    Address: address,
    Website: cleanWebsiteUrl(website, name),
    Phone: phone,
    Email: 'Not found',
    'Contact Person': 'Not found',
    'Business Phone': 'Not found',
    Rating: rating,
    'Review Count': reviewCount,
    Hours: 'Not found',
    PriceLevel: 'Not found',
    Industry: industry,
    place_id: place.id || '',
    'Google Maps URL': place.googleMapsUri || '',
    Lat: location.latitude || '',
    Lng: location.longitude || '',
    'Business Status': place.businessStatus || '',
  };
}

function createDedupeRegistry() {
  return { placeIds: new Set(), nameAddresses: new Set(), count: 0 };
}

function initDedupeRegistries() {
  gracefulShutdown.rawDedupe = createDedupeRegistry();
  gracefulShutdown.filteredDedupe = createDedupeRegistry();
}

/** Returns true if this lead is new globally (registry updated). */
function tryRegisterLead(registry, business) {
  const placeId = (business.place_id || '').trim();
  if (placeId) {
    if (registry.placeIds.has(placeId)) return false;
    registry.placeIds.add(placeId);
    registry.count += 1;
    return true;
  }
  const key = `${business.Name}|${business.Address}`.toLowerCase();
  if (registry.nameAddresses.has(key)) return false;
  registry.nameAddresses.add(key);
  registry.count += 1;
  return true;
}

function uniqueLeads(rows) {
  const registry = createDedupeRegistry();
  return rows.filter((business) => tryRegisterLead(registry, business));
}

function loadResultsSheet(filename) {
  if (!filename || !fs.existsSync(filename)) return [];
  try {
    const workbook = xlsx.readFile(filename);
    const sheet = workbook.Sheets.Results || workbook.Sheets[workbook.SheetNames[0]];
    return xlsx.utils.sheet_to_json(sheet);
  } catch {
    return [];
  }
}

function withSaveLock(fn) {
  gracefulShutdown.saveQueue = gracefulShutdown.saveQueue.then(fn).catch((err) => {
    console.log(`⚠️  Save queue error: ${err.message}`);
  });
  return gracefulShutdown.saveQueue;
}

function createAnalysisRows(statusLabel, totalDurationSeconds) {
  const rows = [
    { Metric: 'Status', Value: statusLabel },
    { Metric: 'Saved At', Value: new Date().toISOString() },
    {
      Metric: 'Industries Processed',
      Value: `${gracefulShutdown.industriesProcessed}/${gracefulShutdown.totalIndustries}`,
    },
    { Metric: 'Total Businesses (filtered)', Value: gracefulShutdown.filteredDedupe?.count ?? 0 },
    { Metric: 'Total Businesses (all)', Value: gracefulShutdown.rawDedupe?.count ?? 0 },
    { Metric: 'Total API Requests', Value: gracefulShutdown.apiRequests },
  ];

  if (totalDurationSeconds != null) {
    rows.push({ Metric: 'Total Duration (seconds)', Value: Number(totalDurationSeconds.toFixed(2)) });
    rows.push({
      Metric: 'Total Duration (minutes)',
      Value: Number((totalDurationSeconds / 60).toFixed(2)),
    });
  }

  for (const timing of gracefulShutdown.timingData) {
    if (!timing.industry) continue;
    rows.push({ Metric: `Industry: ${timing.industry}`, Value: '' });
    rows.push({ Metric: '  - Places fetched', Value: timing.placesFetched ?? 0 });
    rows.push({ Metric: '  - Businesses Kept', Value: timing.businessesKept ?? 0 });
    rows.push({ Metric: '  - Duration (seconds)', Value: timing.durationSeconds ?? 0 });
    rows.push({ Metric: '  - API Requests', Value: timing.apiRequests ?? 0 });
    if (timing.gridTiles != null) rows.push({ Metric: '  - Grid tiles', Value: timing.gridTiles });
    if (timing.tilesSaturated != null) {
      rows.push({ Metric: '  - Tiles saturated', Value: timing.tilesSaturated });
    }
    if (timing.tilesSubdivided != null) {
      rows.push({ Metric: '  - Tiles subdivided', Value: timing.tilesSubdivided });
    }
    if (timing.tilesQueried != null) {
      rows.push({ Metric: '  - Tiles queried (incl. sub)', Value: timing.tilesQueried });
    }
    if (timing.error) rows.push({ Metric: '  - Error', Value: timing.error });
  }

  return rows;
}

function writeWorkbookToFile(workbook, filename) {
  try {
    xlsx.writeFile(workbook, filename);
    return { filename };
  } catch (error) {
    if (error.code === 'EBUSY') {
      const alt = filename.replace('.xlsx', `_${Date.now()}.xlsx`);
      xlsx.writeFile(workbook, alt);
      return { filename: alt };
    }
    throw error;
  }
}

function mergeAppendRows(filename, appendRows) {
  if (!appendRows || appendRows.length === 0) {
    return loadResultsSheet(filename);
  }
  const existing = loadResultsSheet(filename);
  return uniqueLeads([...existing, ...appendRows]);
}

function writeAllPlacesWorkbook(filename, statusLabel, rows) {
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(rows), 'Results');
  const meta = [
    { Field: 'Status', Value: statusLabel },
    { Field: 'Rows (deduped)', Value: rows.length },
    { Field: 'Note', Value: 'No filters applied — includes closed, low reviews, websites, etc.' },
  ];
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(meta), 'About');
  return writeWorkbookToFile(workbook, filename);
}

function seedCumulativeAllFromPriorRun() {
  const cumulativeFile = getCumulativeAllOutputFile();
  if (loadResultsSheet(cumulativeFile).length > 0) return null;

  const priorAll = fs
    .readdirSync('.')
    .filter(
      (file) =>
        file.endsWith('_ALL.xlsx') &&
        !file.startsWith('~$') &&
        file !== cumulativeFile &&
        /^GoogleMapsResults_/i.test(file)
    )
    .map((file) => ({ file, time: fs.statSync(file).mtime.getTime() }))
    .sort((a, b) => b.time - a.time);

  if (priorAll.length === 0) return null;

  const rows = loadResultsSheet(priorAll[0].file);
  if (rows.length === 0) return null;

  writeAllPlacesWorkbook(
    cumulativeFile,
    `Seeded from ${priorAll[0].file} — grows with each new run`,
    rows
  );
  console.log(
    `📚 Cumulative ALL seeded: ${cumulativeFile} (${rows.length} rows from ${priorAll[0].file})`
  );
  return priorAll[0].file;
}

function saveAllPlacesWorkbook(filename, statusLabel, appendRows = []) {
  const sessionRows = mergeAppendRows(filename, appendRows);
  if (sessionRows.length === 0) return null;

  const written = writeAllPlacesWorkbook(filename, statusLabel, sessionRows);
  let cumulativeCount = loadResultsSheet(getCumulativeAllOutputFile()).length;

  if (appendRows.length > 0) {
    const cumulativeRows = mergeAppendRows(getCumulativeAllOutputFile(), appendRows);
    const cumWritten = writeAllPlacesWorkbook(
      getCumulativeAllOutputFile(),
      'CUMULATIVE — all runs (deduped)',
      cumulativeRows
    );
    cumulativeCount = cumulativeRows.length;
    return {
      filename: written.filename,
      count: sessionRows.length,
      cumulativeFile: cumWritten.filename,
      cumulativeCount,
    };
  }

  if (cumulativeCount > 0) {
    const cumRows = loadResultsSheet(getCumulativeAllOutputFile());
    writeAllPlacesWorkbook(getCumulativeAllOutputFile(), 'CUMULATIVE — all runs (deduped)', cumRows);
  }

  return { filename: written.filename, count: sessionRows.length, cumulativeCount };
}

function saveFilteredWorkbook(filename, statusLabel, appendRows = []) {
  const rows = mergeAppendRows(filename, appendRows);
  if (rows.length === 0) return null;

  const duration =
    gracefulShutdown.overallStartTime != null
      ? (Date.now() - gracefulShutdown.overallStartTime) / 1000
      : null;
  const analysisData = createAnalysisRows(statusLabel, duration);

  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(rows), 'Results');
  xlsx.utils.book_append_sheet(workbook, xlsx.utils.json_to_sheet(analysisData), 'scraper analyzing');

  const written = writeWorkbookToFile(workbook, filename);
  return { filename: written.filename, count: rows.length };
}

function saveCheckpointExcel(industryRawNew = [], industryFilteredNew = []) {
  const savedAll = saveAllPlacesWorkbook(
    getScrapeAllOutputFile(),
    'IN PROGRESS — all Places rows (deduped only)',
    industryRawNew
  );
  const savedFiltered = saveFilteredWorkbook(
    getScrapeOutputFile(),
    'IN PROGRESS — filtered leads (reviews, website, closed permanent)',
    industryFilteredNew
  );

  if (savedAll) {
    console.log(`💾 All places saved: ${savedAll.filename} (${savedAll.count} rows, no filters)`);
    if (savedAll.cumulativeCount != null) {
      console.log(`📚 Cumulative ALL: ${getCumulativeAllOutputFile()} (${savedAll.cumulativeCount} rows total)`);
    }
  }
  if (savedFiltered) {
    console.log(`💾 Filtered scrape saved: ${savedFiltered.filename} (${savedFiltered.count} leads)`);
  }
  return { savedAll, savedFiltered };
}

async function saveDataAndExit(reason) {
  if (gracefulShutdown.isShuttingDown) return;
  gracefulShutdown.isShuttingDown = true;
  gracefulShutdown.shouldStop = true;
  console.log(`\n🛑 ${reason}. Saving progress...`);

  await withSaveLock(async () => {
    saveAllPlacesWorkbook(
      getScrapeAllOutputFile(),
      `PARTIAL - all places (${reason})`
    );
    saveFilteredWorkbook(
      getScrapeOutputFile(),
      `PARTIAL - filtered (${reason})`
    );
  });
  const allCount = gracefulShutdown.rawDedupe?.count ?? 0;
  const filteredCount = gracefulShutdown.filteredDedupe?.count ?? 0;
  if (allCount > 0) {
    console.log(`✅ All places saved (partial): ${getScrapeAllOutputFile()} (${allCount} rows)`);
  }
  if (filteredCount > 0) {
    console.log(`✅ Filtered scrape saved (partial): ${getScrapeOutputFile()} (${filteredCount} leads)`);
  }
  if (allCount === 0 && filteredCount === 0) {
    console.log('⚠️  No data collected yet, nothing to save.');
  }
  process.exit(0);
}

process.on('SIGINT', () => saveDataAndExit('Ctrl+C').catch(() => process.exit(1)));
process.on('SIGTERM', () => saveDataAndExit('SIGTERM').catch(() => process.exit(1)));

function buildFieldMask() {
  return [
    'places.id',
    'places.displayName',
    'places.formattedAddress',
    'places.nationalPhoneNumber',
    'places.websiteUri',
    'places.rating',
    'places.userRatingCount',
    'places.location',
    'places.googleMapsUri',
    'places.businessStatus',
    'nextPageToken',
  ].join(',');
}

function buildGridTiles() {
  const rows = PLACES.GRID_ROWS || 1;
  const cols = PLACES.GRID_COLS || 1;
  const latSpan = PLACES.RECT_HIGH_LAT - PLACES.RECT_LOW_LAT;
  const lngSpan = PLACES.RECT_HIGH_LNG - PLACES.RECT_LOW_LNG;
  const latStep = latSpan / rows;
  const lngStep = lngSpan / cols;
  const tiles = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      tiles.push({
        id: `r${row + 1}c${col + 1}`,
        rectangle: {
          low: {
            latitude: PLACES.RECT_LOW_LAT + row * latStep,
            longitude: PLACES.RECT_LOW_LNG + col * lngStep,
          },
          high: {
            latitude: PLACES.RECT_LOW_LAT + (row + 1) * latStep,
            longitude: PLACES.RECT_LOW_LNG + (col + 1) * lngStep,
          },
        },
      });
    }
  }

  return tiles;
}

function subdivideRectangle(rectangle, subRows, subCols) {
  const lowLat = rectangle.low.latitude;
  const lowLng = rectangle.low.longitude;
  const highLat = rectangle.high.latitude;
  const highLng = rectangle.high.longitude;
  const latStep = (highLat - lowLat) / subRows;
  const lngStep = (highLng - lowLng) / subCols;
  const children = [];

  for (let row = 0; row < subRows; row += 1) {
    for (let col = 0; col < subCols; col += 1) {
      children.push({
        low: {
          latitude: lowLat + row * latStep,
          longitude: lowLng + col * lngStep,
        },
        high: {
          latitude: lowLat + (row + 1) * latStep,
          longitude: lowLng + (col + 1) * lngStep,
        },
      });
    }
  }

  return children;
}

function buildSubTiles(parentTile) {
  const subRows = PLACES.SUBDIVIDE_ROWS || 2;
  const subCols = PLACES.SUBDIVIDE_COLS || 2;
  const childRects = subdivideRectangle(parentTile.rectangle, subRows, subCols);
  const depth = (parentTile.depth || 0) + 1;

  return childRects.map((rectangle, index) => {
    const row = Math.floor(index / subCols) + 1;
    const col = (index % subCols) + 1;
    return {
      id: `${parentTile.id}/r${row}c${col}`,
      rectangle,
      depth,
    };
  });
}

const GRID_TILES = buildGridTiles().map((tile) => ({ ...tile, depth: 0 }));

async function searchPlacesPage(apiKey, industry, rectangle, pageToken = null) {
  const endpoint = 'https://places.googleapis.com/v1/places:searchText';
  const body = {
    textQuery: industry,
    pageSize: PLACES.PAGE_SIZE,
    regionCode: PLACES.REGION_CODE,
    locationRestriction: {
      rectangle,
    },
  };
  if (pageToken) body.pageToken = pageToken;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': buildFieldMask(),
    },
    body: JSON.stringify(body),
  });

  gracefulShutdown.apiRequests += 1;

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Places API ${response.status}: ${text}`);
  }
  return response.json();
}

async function fetchPlacesForTile(apiKey, industry, tile, workerPrefix) {
  let pageToken = null;
  let page = 0;
  const places = [];
  let saturated = false;

  while (!gracefulShutdown.shouldStop && page < PLACES.MAX_PAGES_PER_TILE) {
    if (pageToken) {
      await sleep(PLACES.NEXT_PAGE_DELAY_MS);
    }

    const payload = await searchPlacesPage(apiKey, industry, tile.rectangle, pageToken);
    const currentPlaces = payload.places || [];
    places.push(...currentPlaces);
    page += 1;

    if (!payload.nextPageToken) {
      break;
    }
    if (page >= PLACES.MAX_PAGES_PER_TILE) {
      saturated = true;
      break;
    }
    pageToken = payload.nextPageToken;
  }

  if (saturated) {
    console.log(
      `${workerPrefix} ⚠️ Tile ${tile.id} hit page cap (${PLACES.MAX_PAGES_PER_TILE}); cell may have more than ${PLACES.MAX_PAGES_PER_TILE * PLACES.PAGE_SIZE} matches`
    );
  }

  return { places, saturated };
}

function mergePlacesIntoMap(byPlaceId, tilePlaces) {
  let added = 0;
  for (const place of tilePlaces) {
    const placeId = place.id || '';
    if (!placeId || byPlaceId.has(placeId)) continue;
    byPlaceId.set(placeId, place);
    added += 1;
  }
  return added;
}

async function fetchPlacesForIndustry(apiKey, industry, workerPrefix) {
  const requestsBefore = gracefulShutdown.apiRequests;
  const byPlaceId = new Map();
  let tilesSaturated = 0;
  let tilesSubdivided = 0;
  let tilesQueried = 0;

  const adaptiveSubdivide = PLACES.ADAPTIVE_SUBDIVIDE !== false;
  const maxSubdivideDepth = PLACES.MAX_SUBDIVIDE_DEPTH ?? 1;
  const queue = [...GRID_TILES];

  while (queue.length > 0 && !gracefulShutdown.shouldStop) {
    const tile = queue.shift();
    tilesQueried += 1;

    const { places: tilePlaces, saturated } = await fetchPlacesForTile(
      apiKey,
      industry,
      tile,
      workerPrefix
    );
    if (saturated) tilesSaturated += 1;

    const added = mergePlacesIntoMap(byPlaceId, tilePlaces);
    const depthLabel = tile.depth > 0 ? ` depth ${tile.depth}` : '';
    console.log(
      `${workerPrefix} 🧩 ${tile.id}${depthLabel}: +${added} new (unique ${byPlaceId.size}, queue ${queue.length})`
    );

    if (
      tilesQueried % 6 === 0 &&
      gracefulShutdown.overallStartTime != null
    ) {
      reportScrapeProgress(
        {
          industriesDone: gracefulShutdown.industriesProcessed,
          totalIndustries: gracefulShutdown.totalIndustries,
          startedAtMs: gracefulShutdown.overallStartTime,
          leadsKept: gracefulShutdown.filteredDedupe?.count ?? 0,
          leadsAll: gracefulShutdown.rawDedupe?.count ?? 0,
          apiRequests: gracefulShutdown.apiRequests,
          currentIndustries: gracefulShutdown.currentIndustries,
          currentTile: `${industry} · ${tile.id} (${tilesQueried} tiles this industry)`,
        },
        { log: false }
      );
    }

    if (
      saturated &&
      adaptiveSubdivide &&
      (tile.depth || 0) < maxSubdivideDepth
    ) {
      const subTiles = buildSubTiles(tile);
      queue.push(...subTiles);
      tilesSubdivided += 1;
      console.log(
        `${workerPrefix} 🔀 Tile ${tile.id} saturated → ${subTiles.length} sub-tiles (${subTiles.map((t) => t.id).join(', ')})`
      );
    }

    if (queue.length > 0) {
      await sleep(PLACES.TILE_DELAY_MS);
    }
  }

  return {
    places: Array.from(byPlaceId.values()),
    apiRequests: gracefulShutdown.apiRequests - requestsBefore,
    tilesSaturated,
    tilesSubdivided,
    tilesQueried,
  };
}

function applyLeadFilters(business) {
  const status = String(business['Business Status'] || '').toUpperCase();
  if (status && EXCLUDE_BUSINESS_STATUSES.includes(status)) {
    const label = status.replace(/_/g, ' ').toLowerCase();
    return { keep: false, reason: label };
  }
  const reviewCount = Number(business['Review Count'] || 0);
  if (reviewCount < MIN_REVIEW_COUNT) {
    return { keep: false, reason: `<${MIN_REVIEW_COUNT} reviews` };
  }
  if (isRealBusinessWebsite(business.Website, business.Name)) {
    return { keep: false, reason: 'has real website' };
  }
  return { keep: true };
}

async function processIndustry(industry, workerId, apiKey) {
  const workerPrefix = `[Worker ${workerId + 1}]`;
  const start = Date.now();
  console.log(`\n${workerPrefix} ==================================================`);
  console.log(`${workerPrefix} Processing industry: ${industry}`);
  console.log(`${workerPrefix} ==================================================`);

  try {
    const { places, apiRequests, tilesSaturated, tilesSubdivided, tilesQueried } =
      await fetchPlacesForIndustry(apiKey, industry, workerPrefix);
    let kept = 0;
    let filtered = 0;
    const industryRawNew = [];
    const industryFilteredNew = [];

    for (const place of places) {
      const business = placeToBusiness(place, industry);
      if (!tryRegisterLead(gracefulShutdown.rawDedupe, business)) {
        continue;
      }
      industryRawNew.push(business);

      const decision = applyLeadFilters(business);
      if (!decision.keep) {
        filtered += 1;
        continue;
      }
      if (!tryRegisterLead(gracefulShutdown.filteredDedupe, business)) {
        continue;
      }
      industryFilteredNew.push(business);
      kept += 1;
    }

    const durationSeconds = (Date.now() - start) / 1000;
    const timing = {
      industry,
      durationSeconds: Number(durationSeconds.toFixed(2)),
      placesFetched: places.length,
      businessesKept: kept,
      businessesFiltered: filtered,
      apiRequests,
      gridTiles: GRID_TILES.length,
      tilesQueried: tilesQueried || GRID_TILES.length,
      tilesSaturated: tilesSaturated || 0,
      tilesSubdivided: tilesSubdivided || 0,
    };
    gracefulShutdown.timingData.push(timing);
    gracefulShutdown.industriesProcessed += 1;

    console.log(`${workerPrefix} ✅ Completed "${industry}": ${kept} businesses kept`);
    console.log(
      `${workerPrefix} 📊 Places fetched: ${places.length}, filtered: ${filtered}, api requests: ${apiRequests}`
    );
    console.log(
      `${workerPrefix} 💾 Totals (on disk): ${gracefulShutdown.rawDedupe.count} all / ${gracefulShutdown.filteredDedupe.count} filtered`
    );
    reportScrapeProgress(
      {
        industriesDone: gracefulShutdown.industriesProcessed,
        totalIndustries: gracefulShutdown.totalIndustries,
        startedAtMs: gracefulShutdown.overallStartTime,
        leadsKept: gracefulShutdown.filteredDedupe.count,
        leadsAll: gracefulShutdown.rawDedupe.count,
        apiRequests: gracefulShutdown.apiRequests,
        currentIndustries: gracefulShutdown.currentIndustries,
        currentTile: null,
      },
      { log: true }
    );
    await withSaveLock(async () => {
      saveCheckpointExcel(industryRawNew, industryFilteredNew);
    });
    return timing;
  } catch (error) {
    const durationSeconds = (Date.now() - start) / 1000;
    const timing = {
      industry,
      durationSeconds: Number(durationSeconds.toFixed(2)),
      placesFetched: 0,
      businessesKept: 0,
      businessesFiltered: 0,
      apiRequests: 0,
      error: error.message,
    };
    gracefulShutdown.timingData.push(timing);
    gracefulShutdown.industriesProcessed += 1;
    console.log(`${workerPrefix} ❌ Failed "${industry}": ${error.message}`);
    return timing;
  }
}

async function workerLoop(workerId, industries, apiKey) {
  const workerPrefix = `[Worker ${workerId + 1}]`;
  gracefulShutdown.workerStatus[workerId] = 'running';
  console.log(`${workerPrefix} 🚀 Starting with ${industries.length} industries: ${industries.join(', ')}`);

  for (let index = 0; index < industries.length; index += 1) {
    if (gracefulShutdown.shouldStop) break;
    const industry = industries[index];
    gracefulShutdown.currentIndustries[workerId] = industry;
    await processIndustry(industry, workerId, apiKey);
    if (index < industries.length - 1) {
      const delay = getRandomDelay(PERF.MIN_DELAY_BETWEEN_INDUSTRIES, PERF.MAX_DELAY_BETWEEN_INDUSTRIES);
      await sleep(delay);
    }
  }

  gracefulShutdown.workerStatus[workerId] = 'completed';
  console.log(`${workerPrefix} 🏁 Worker finished.`);
}

function buildIndustryBuckets(industries) {
  const buckets = Array.from({ length: NUM_PARALLEL_WORKERS }, () => []);
  industries.forEach((industry, index) => {
    buckets[index % NUM_PARALLEL_WORKERS].push(industry);
  });
  return buckets.filter((bucket) => bucket.length > 0);
}

async function runPlacesScraper() {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is unavailable in this Node runtime.');
  }

  const apiKey = getApiKey();
  const industries = readIndustriesFromFile();

  gracefulShutdown.overallStartTime = Date.now();
  gracefulShutdown.totalIndustries = industries.length;
  gracefulShutdown.workerStatus = new Array(NUM_PARALLEL_WORKERS).fill('pending');
  gracefulShutdown.currentIndustries = new Array(NUM_PARALLEL_WORKERS).fill(null);

  const buckets = buildIndustryBuckets(industries);

  console.log('\n' + '='.repeat(70));
  console.log('🚀 PLACES API SCRAPER');
  console.log('='.repeat(70));
  console.log(`Mode: ${FAST_MODE ? 'FAST' : 'STANDARD'}`);
  console.log(`Workers: ${buckets.length} (configured ${NUM_PARALLEL_WORKERS})`);
  console.log(`Industries: ${industries.length}`);
  console.log(
    `Area bounds: low=(${PLACES.RECT_LOW_LAT}, ${PLACES.RECT_LOW_LNG}) high=(${PLACES.RECT_HIGH_LAT}, ${PLACES.RECT_HIGH_LNG})`
  );
  console.log(
    `Grid: ${PLACES.GRID_ROWS}x${PLACES.GRID_COLS} (${GRID_TILES.length} tiles per industry)`
  );
  console.log(
    `Per tile: pageSize=${PLACES.PAGE_SIZE}, maxPages=${PLACES.MAX_PAGES_PER_TILE} (up to ${PLACES.PAGE_SIZE * PLACES.MAX_PAGES_PER_TILE} places/tile)`
  );
  const baseTiles = GRID_TILES.length;
  const subFactor = (PLACES.SUBDIVIDE_ROWS || 2) * (PLACES.SUBDIVIDE_COLS || 2);
  const maxDepth = PLACES.MAX_SUBDIVIDE_DEPTH ?? 1;
  const maxTilesIfAllSaturate =
    PLACES.ADAPTIVE_SUBDIVIDE !== false
      ? baseTiles * Math.pow(subFactor, maxDepth)
      : baseTiles;
  const maxApiPerIndustry = maxTilesIfAllSaturate * PLACES.MAX_PAGES_PER_TILE;
  console.log(
    `Max API calls per industry (worst case, base grid only): ${baseTiles * PLACES.MAX_PAGES_PER_TILE}`
  );
  if (PLACES.ADAPTIVE_SUBDIVIDE !== false) {
    console.log(
      `Adaptive subdivide: ${PLACES.SUBDIVIDE_ROWS}x${PLACES.SUBDIVIDE_COLS}, depth ${maxDepth} (only saturated tiles)`
    );
    console.log(
      `Max API if every base tile saturates: ${maxTilesIfAllSaturate} tiles x ${PLACES.MAX_PAGES_PER_TILE} pages = ${maxApiPerIndustry}`
    );
  }
  console.log(
    `All industries worst case: ${industries.length * maxApiPerIndustry} (typical: much lower)`
  );
  console.log(
    `Filters: ${MIN_REVIEW_COUNT}+ reviews, no real website, exclude status: ${EXCLUDE_BUSINESS_STATUSES.join(', ')}`
  );
  console.log('='.repeat(70));
  console.log(`📊 Live progress file: ${PROGRESS_TXT} (also run-progress.json)\n`);

  initSession();
  const { scrapeOutputFile, scrapeAllOutputFile, expandOutputFile, cumulativeAllOutputFile } =
    persistSessionPaths();
  console.log(`📁 1) This run ALL:     ${scrapeAllOutputFile}`);
  console.log(`📁 2) Cumulative ALL:  ${cumulativeAllOutputFile} (appends every run)`);
  console.log(`📁 3) Filtered scrape: ${scrapeOutputFile}`);
  console.log(`📁 4) Expand output:   ${expandOutputFile}\n`);

  initDedupeRegistries();
  seedCumulativeAllFromPriorRun();
  console.log('💾 Row data saved to Excel each industry; RAM holds dedupe keys only.\n');

  clearProgress('scrape');
  reportScrapeProgress(
    {
      industriesDone: 0,
      totalIndustries: industries.length,
      startedAtMs: gracefulShutdown.overallStartTime,
      leadsKept: 0,
      apiRequests: 0,
      currentIndustries: [],
      currentTile: null,
    },
    { log: true }
  );

  const promises = buckets.map((bucket, i) => workerLoop(i, bucket, apiKey));
  await Promise.all(promises);

  const overallDuration = ((Date.now() - gracefulShutdown.overallStartTime) / 1000).toFixed(2);
  const allFile = getScrapeAllOutputFile();
  const filteredFile = getScrapeOutputFile();

  await withSaveLock(async () => {
    saveAllPlacesWorkbook(allFile, 'SCRAPE COMPLETED — all places');
    saveFilteredWorkbook(filteredFile, 'SCRAPE COMPLETED — filtered');
  });

  const dedupedAll = loadResultsSheet(allFile);
  const deduped = loadResultsSheet(filteredFile);

  console.log(`\n${'='.repeat(70)}`);
  console.log('📁 Finalizing scrape files (same paths as progressive saves)...');
  console.log(`⏱️  Total duration: ${overallDuration} seconds (${(Number(overallDuration) / 60).toFixed(2)} minutes)`);
  console.log(`📊 All places (deduped): ${dedupedAll.length}`);
  console.log(`📊 Filtered leads: ${deduped.length}`);
  console.log(`🌐 Total Places API requests: ${gracefulShutdown.apiRequests}`);
  console.log(`${'='.repeat(70)}\n`);

  const savedAll = dedupedAll.length > 0 ? { filename: allFile, count: dedupedAll.length } : null;
  const savedFiltered = deduped.length > 0 ? { filename: filteredFile, count: deduped.length } : null;

  if (savedAll) {
    console.log(`✅ All places file: ${savedAll.filename} (${savedAll.count} rows, deduped)`);
  }
  if (savedFiltered) {
    console.log(`✅ Filtered scrape file: ${savedFiltered.filename} (${savedFiltered.count} leads)`);
    console.log(`   Next: expand reads filtered file → ${getExpandOutputFile(filteredFile)}`);
  }
  markDone(
    `Scrape finished · ${dedupedAll.length} all / ${deduped.length} filtered · ${overallDuration}s`
  );
}

console.log(
  `Starting scraper for all industries... (${FAST_MODE ? '⚡ FAST MODE' : 'safe mode'} — ${NUM_PARALLEL_WORKERS} workers, ${MIN_REVIEW_COUNT}+ reviews)`
);

runPlacesScraper()
  .then(() => {
    console.log('\n✅ All industries processed successfully!');
  })
  .catch((error) => {
    console.error('❌ Scraper failed with error:', error);
    process.exit(1);
  });
