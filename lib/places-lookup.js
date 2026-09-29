/**
 * Places API (New) client for Brreg → Maps reverse lookup.
 * Text Search uses a Pro field mask (no phone). Phone is Place Details Enterprise only.
 */

const { loadEnv } = require('./ai-match');

const SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText';
const SEARCH_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.googleMapsUri',
  'places.businessStatus',
].join(',');
const DETAILS_FIELD_MASK = [
  'nationalPhoneNumber',
  'internationalPhoneNumber',
  'websiteUri',
].join(',');

function getApiKey() {
  loadEnv();
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

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function placesFetch(url, { method, headers, body }, attempt = 0) {
  const response = await fetch(url, { method, headers, body });
  if ((response.status === 429 || response.status === 503) && attempt < 4) {
    await delay(800 * (attempt + 1));
    return placesFetch(url, { method, headers, body }, attempt + 1);
  }
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Places API ${response.status}: ${text.slice(0, 400)}`);
  }
  return response.json();
}

/**
 * Text Search (New) — Pro SKU. Do not add phone/website/rating to the mask.
 */
async function searchText(textQuery, { pageSize = 5, regionCode = 'NO', apiKey } = {}) {
  const q = String(textQuery || '').trim();
  if (!q) return [];

  const data = await placesFetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey || getApiKey(),
      'X-Goog-FieldMask': SEARCH_FIELD_MASK,
    },
    body: JSON.stringify({
      textQuery: q,
      pageSize,
      regionCode,
    }),
  });

  return data.places || [];
}

async function fetchPlaceDetails(placeId, { apiKey } = {}) {
  const id = String(placeId || '').replace(/^places\//, '');
  if (!id) return null;

  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`;
  return placesFetch(url, {
    method: 'GET',
    headers: {
      'X-Goog-Api-Key': apiKey || getApiKey(),
      'X-Goog-FieldMask': DETAILS_FIELD_MASK,
    },
  });
}

module.exports = {
  getApiKey,
  searchText,
  fetchPlaceDetails,
  SEARCH_FIELD_MASK,
  DETAILS_FIELD_MASK,
};
