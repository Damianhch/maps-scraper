const fs = require('fs');
const path = require('path');
const { PLACES } = require('./lib/performance-config');

const INDUSTRIES_FILE = 'list of industries.txt';

function readIndustries() {
  const filePath = path.join(__dirname, INDUSTRIES_FILE);
  return fs
    .readFileSync(filePath, 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function main() {
  const industries = readIndustries();
  const tilesPerIndustry = (PLACES.GRID_ROWS || 1) * (PLACES.GRID_COLS || 1);
  const maxPagesPerTile = PLACES.MAX_PAGES_PER_TILE || 3;
  const pageSize = PLACES.PAGE_SIZE || 20;

  const subFactor =
    PLACES.ADAPTIVE_SUBDIVIDE !== false
      ? (PLACES.SUBDIVIDE_ROWS || 2) * (PLACES.SUBDIVIDE_COLS || 2)
      : 1;
  const maxDepth = PLACES.MAX_SUBDIVIDE_DEPTH ?? 1;
  const maxTilesIfAllSaturate =
    PLACES.ADAPTIVE_SUBDIVIDE !== false
      ? tilesPerIndustry * Math.pow(subFactor, maxDepth)
      : tilesPerIndustry;
  const maxCallsPerIndustry = maxTilesIfAllSaturate * maxPagesPerTile;
  const baseCallsPerIndustry = tilesPerIndustry * maxPagesPerTile;
  const maxCallsTotal = industries.length * maxCallsPerIndustry;
  const maxRawPlacesPerIndustry = tilesPerIndustry * maxPagesPerTile * pageSize;

  console.log('\nPlaces API run estimate (no API calls — config only)\n');
  console.log('='.repeat(60));
  console.log(`Industries in "${INDUSTRIES_FILE}": ${industries.length}`);
  if (industries.length > 0) {
    console.log(`  ${industries.join(', ')}`);
  }
  console.log('');
  console.log('Area rectangle:');
  console.log(
    `  low  (${PLACES.RECT_LOW_LAT}, ${PLACES.RECT_LOW_LNG})  high (${PLACES.RECT_HIGH_LAT}, ${PLACES.RECT_HIGH_LNG})`
  );
  console.log('');
  console.log(`Grid: ${PLACES.GRID_ROWS}x${PLACES.GRID_COLS} = ${tilesPerIndustry} tiles per industry`);
  console.log(`Per tile: up to ${maxPagesPerTile} pages x ${pageSize} places = ${maxPagesPerTile * pageSize} raw places max`);
  console.log('');
  console.log('API requests (Text Search):');
  console.log(
    `  Base grid only:          ${tilesPerIndustry} tiles x ${maxPagesPerTile} pages = ${baseCallsPerIndustry} calls/industry`
  );
  if (PLACES.ADAPTIVE_SUBDIVIDE !== false) {
    console.log(
      `  Adaptive subdivide:     ${PLACES.SUBDIVIDE_ROWS || 2}x${PLACES.SUBDIVIDE_COLS || 2}, depth ${maxDepth} (saturated tiles only)`
    );
    console.log(
      `  If ALL base tiles hit 60: up to ${maxTilesIfAllSaturate} tiles x ${maxPagesPerTile} = ${maxCallsPerIndustry} calls/industry`
    );
  }
  console.log(`  Worst case full run:     ${industries.length} x ${maxCallsPerIndustry} = ${maxCallsTotal} calls`);
  console.log(`  Typical run:             lower (few saturated tiles, fewer pages)`);
  console.log('');
  console.log('Raw Places results (before review/website filters, per industry):');
  console.log(`  Up to ${tilesPerIndustry * maxPagesPerTile * pageSize} per industry (deduped by place_id across tiles)`);
  console.log('');
  console.log('Cost:');
  console.log('  1. Google Cloud → Billing → Catalog');
  console.log('  2. Search "Places API" / "Text Search"');
  console.log('  3. Note price per Text Search request for your SKU/region');
  console.log(`  4. Multiply: ${maxCallsTotal} x (price per request) = worst-case scrape cost`);
  console.log('');
  console.log('After scrape, expand.js runs Brreg (separate from Places billing).');
  console.log('='.repeat(60) + '\n');
}

main();
