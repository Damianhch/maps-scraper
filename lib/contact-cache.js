const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '..', 'cache');
const OFFICERS_FILE = 'brreg-officers.json';
const DIRECTORY_FILE = 'directory-lookups.json';

function ensureDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function loadMap(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function saveMap(file, map) {
  ensureDir();
  fs.writeFileSync(path.join(CACHE_DIR, file), JSON.stringify(map));
}

function loadOfficersCache() {
  return loadMap(OFFICERS_FILE);
}

function saveOfficersCache(map) {
  saveMap(OFFICERS_FILE, map);
}

function loadDirectoryCache() {
  return loadMap(DIRECTORY_FILE);
}

function saveDirectoryCache(map) {
  saveMap(DIRECTORY_FILE, map);
}

function personKey(name, poststed) {
  return `person:${String(name || '')
    .toLowerCase()
    .trim()}|${String(poststed || '')
    .toLowerCase()
    .trim()}`;
}

function companyKey(name, poststed) {
  return `company:${String(name || '')
    .toLowerCase()
    .trim()}|${String(poststed || '')
    .toLowerCase()
    .trim()}`;
}

function gsKey(name, poststed) {
  return `gulesider:${String(name || '')
    .toLowerCase()
    .trim()}|${String(poststed || '')
    .toLowerCase()
    .trim()}`;
}

module.exports = {
  CACHE_DIR,
  loadOfficersCache,
  saveOfficersCache,
  loadDirectoryCache,
  saveDirectoryCache,
  personKey,
  companyKey,
  gsKey,
};
