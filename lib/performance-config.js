/**
 * Fast pipeline defaults (target ~45 min for 19 industries + expand).
 * Set FAST_MODE=0 to restore conservative anti-bot timing.
 */
const FAST_MODE = process.env.FAST_MODE !== '0';

const SCRAPER = FAST_MODE
  ? {
      NUM_PARALLEL_BROWSERS: 4,
      MIN_DELAY_BETWEEN_SCROLLS: 400,
      MAX_DELAY_BETWEEN_SCROLLS: 900,
      MIN_DELAY_BETWEEN_INDUSTRIES: 500,
      MAX_DELAY_BETWEEN_INDUSTRIES: 1200,
      BROWSER_STAGGER_MS: 300,
      // Restore full discovery so we don't miss leads due to scroll limits.
      MAX_SCROLL_ATTEMPTS: 100,
      NO_NEW_RESULTS_TO_STOP: 3,
      MIN_REVIEW_COUNT: 2,
      // No pre-cap: process all businesses discovered for each industry.
      MAX_BUSINESSES_PER_INDUSTRY: null,
      NAV_TIMEOUT_MS: 12000,
      SKIP_DEBUG_SCREENSHOTS: true,
      SKIP_PERIODIC_REFRESH: true,
      BLOCK_HEAVY_RESOURCES: false,
      PAGE_WAIT_STRATEGY: 'domcontentloaded',
      CONSENT_WAIT_MS: 1500,
      SCROLL_WHEEL_DELAY_MS: 120,
      SCROLL_LOAD_DELAY_MS: 400,
    }
  : {
      NUM_PARALLEL_BROWSERS: 3,
      MIN_DELAY_BETWEEN_SCROLLS: 5000,
      MAX_DELAY_BETWEEN_SCROLLS: 8000,
      MIN_DELAY_BETWEEN_INDUSTRIES: 5000,
      MAX_DELAY_BETWEEN_INDUSTRIES: 8000,
      BROWSER_STAGGER_MS: 3000,
      MAX_SCROLL_ATTEMPTS: 100,
      NO_NEW_RESULTS_TO_STOP: 3,
      MIN_REVIEW_COUNT: 8,
      MAX_BUSINESSES_PER_INDUSTRY: null,
      NAV_TIMEOUT_MS: 10000,
      SKIP_DEBUG_SCREENSHOTS: false,
      SKIP_PERIODIC_REFRESH: false,
      BLOCK_HEAVY_RESOURCES: false,
      PAGE_WAIT_STRATEGY: 'domcontentloaded',
      CONSENT_WAIT_MS: 4000,
      SCROLL_WHEEL_DELAY_MS: 500,
      SCROLL_LOAD_DELAY_MS: 1500,
    };

const EXPAND = FAST_MODE
  ? {
      API_DELAY_MS: 0,
      // Brreg throttles globally at ~180ms/request; 4 parallel rows is safer than 6 under load.
      MATCH_CONCURRENCY: 4,
      SAVE_EVERY_N: 25,
      QUIET_LOGS: true,
      // Dedupe vs hoved-liste + prior *_EXPANDED.xlsx (set SKIP_MASTER_LIST=1 to disable).
      SKIP_MASTER_LIST_DEDUPE: process.env.SKIP_MASTER_LIST === '1',
    }
  : {
      API_DELAY_MS: 300,
      MATCH_CONCURRENCY: 1,
      SAVE_EVERY_N: 1,
      QUIET_LOGS: false,
      SKIP_MASTER_LIST_DEDUPE: process.env.SKIP_MASTER_LIST === '1',
    };

/** Master file: every unique place ever scraped (deduped), appended each run. */
const CUMULATIVE_ALL_FILE = 'GoogleMapsResults_ALL_CUMULATIVE.xlsx';

const PLACES_AREA_BOUNDS = {
  // ~50 km around Trondheim center — covers city, Tiller, Hommelvik, Orkanger.
  trondheim: {
    RECT_LOW_LAT: 62.98,
    RECT_LOW_LNG: 9.5,
    RECT_HIGH_LAT: 63.88,
    RECT_HIGH_LNG: 11.3,
  },
  // Oslo sentrum-centered area sized to reach Holmenkollen (~6.5 km radius).
  oslo: {
    RECT_LOW_LAT: 59.856,
    RECT_LOW_LNG: 10.623,
    RECT_HIGH_LAT: 59.973,
    RECT_HIGH_LNG: 10.856,
  },
  // Broader Oslo metro area (includes wider west/east/north/south surroundings).
  oslo_broad: {
    RECT_LOW_LAT: 59.72,
    RECT_LOW_LNG: 10.35,
    RECT_HIGH_LAT: 60.12,
    RECT_HIGH_LNG: 11.12,
  },
};

// Switch quickly with PLACES_AREA_PRESET=oslo (default is trondheim).
const AREA_PRESET = String(process.env.PLACES_AREA_PRESET || 'trondheim').toLowerCase();
const ACTIVE_AREA_BOUNDS = PLACES_AREA_BOUNDS[AREA_PRESET] || PLACES_AREA_BOUNDS.trondheim;

const PLACES_AREA = {
  ...ACTIVE_AREA_BOUNDS,
  // 6x6 grid: each cell stays under Google's ~60 results/query cap.
  GRID_ROWS: 6,
  GRID_COLS: 6,
  PAGE_SIZE: 20,
  // Up to 60 places per tile (3 pages x 20).
  MAX_PAGES_PER_TILE: 3,
  NEXT_PAGE_DELAY_MS: 2200,
  TILE_DELAY_MS: 350,
  REGION_CODE: 'NO',
  // Fewer parallel industries when gridding to reduce API burst rate.
  PARALLEL_INDUSTRIES: 2,
  // Only permanently closed are dropped. Temp closed, future opening, missing status are kept.
  EXCLUDE_BUSINESS_STATUSES: ['CLOSED_PERMANENTLY'],
  // When a tile hits MAX_PAGES_PER_TILE (60 places), split it into smaller cells and re-query.
  ADAPTIVE_SUBDIVIDE: true,
  SUBDIVIDE_ROWS: 2,
  SUBDIVIDE_COLS: 2,
  // Extra levels beyond the base grid (1 = each saturated tile → 2x2 sub-tiles once).
  MAX_SUBDIVIDE_DEPTH: 1,
};

const PLACES = FAST_MODE ? { ...PLACES_AREA, AREA_PRESET } : { ...PLACES_AREA, AREA_PRESET };

module.exports = { FAST_MODE, SCRAPER, EXPAND, PLACES, CUMULATIVE_ALL_FILE };
