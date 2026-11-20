const xlsx = require('xlsx');
const fs = require('fs');
const {
  normalizeName,
  normalizePhone,
  addressKey,
  parseMapsAddress,
  namesSimilar,
} = require('./normalize');

const DEFAULT_EXISTING_LEADS_FILE = 'hoved-liste_export.xlsx';

function normalizeOrgnr(val) {
  const d = String(val || '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : '';
}

function leadKeysFromRow(row) {
  const name = (row.Name || row.name || '').trim();
  const address = (row.Address || row.address || '').trim();
  const parsed = parseMapsAddress(address);
  const addrKey = addressKey(parsed);
  const postcode = addrKey.split('|')[3] || '';

  return {
    name,
    nameNorm: normalizeName(name),
    nameAddressKey: `${name}|${address}`.toLowerCase().replace(/\s+/g, ' ').trim(),
    addressKey: addrKey,
    namePostcodeKey: postcode && normalizeName(name) ? `${normalizeName(name)}|${postcode}` : '',
    orgnr: normalizeOrgnr(row.Orgnr || row.orgnr),
    phone: normalizePhone(row.Phone || row.phone || row['Business Phone'] || ''),
  };
}

function buildExistingLeadIndex(rows) {
  const index = {
    nameAddressKeys: new Set(),
    namePostcodeKeys: new Set(),
    orgnrs: new Set(),
    phones: new Set(),
    entries: [],
  };

  for (const row of rows) {
    const keys = leadKeysFromRow(row);
    if (keys.nameAddressKey) index.nameAddressKeys.add(keys.nameAddressKey);
    if (keys.namePostcodeKey) index.namePostcodeKeys.add(keys.namePostcodeKey);
    if (keys.orgnr) index.orgnrs.add(keys.orgnr);
    if (keys.phone) index.phones.add(keys.phone);
    index.entries.push(keys);
  }

  return index;
}

function loadExistingLeadIndex(filePath = DEFAULT_EXISTING_LEADS_FILE) {
  const resolved = filePath || DEFAULT_EXISTING_LEADS_FILE;
  if (!fs.existsSync(resolved)) {
    return null;
  }

  const workbook = xlsx.readFile(resolved);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(sheet);

  return {
    sourceFile: resolved,
    count: rows.length,
    index: buildExistingLeadIndex(rows),
  };
}

function isDuplicateLead(row, loaded) {
  if (!loaded?.index) {
    return { isDuplicate: false };
  }

  const keys = leadKeysFromRow(row);
  const { index } = loaded;
  const reasons = [];

  if (keys.orgnr && index.orgnrs.has(keys.orgnr)) {
    reasons.push('orgnr');
  }
  if (keys.nameAddressKey && index.nameAddressKeys.has(keys.nameAddressKey)) {
    reasons.push('name+address');
  }
  if (keys.namePostcodeKey && index.namePostcodeKeys.has(keys.namePostcodeKey)) {
    reasons.push('name+postcode');
  }
  if (keys.phone && index.phones.has(keys.phone)) {
    reasons.push('phone');
  }

  if (
    keys.addressKey &&
    keys.addressKey !== '||||' &&
    keys.name
  ) {
    for (const existing of index.entries) {
      if (keys.addressKey === existing.addressKey && namesSimilar(keys.name, existing.name, 0.75)) {
        reasons.push('similar name+address');
        break;
      }
    }
  }

  if (reasons.length > 0) {
    return { isDuplicate: true, reason: reasons[0] };
  }

  return { isDuplicate: false };
}

function filterNewLeads(rows, loaded) {
  const excluded = [];
  const kept = [];

  for (const row of rows) {
    const dup = isDuplicateLead(row, loaded);
    if (dup.isDuplicate) {
      excluded.push({ row, reason: dup.reason });
    } else {
      kept.push(row);
    }
  }

  return { kept, excluded };
}

function mergeLeadIndexes(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    sourceFile: `${a.sourceFile} + ${b.sourceFile}`,
    sourceFiles: [...(a.sourceFiles || [a.sourceFile]), ...(b.sourceFiles || [b.sourceFile])],
    count: a.count + b.count,
    index: {
      nameAddressKeys: new Set([...a.index.nameAddressKeys, ...b.index.nameAddressKeys]),
      namePostcodeKeys: new Set([...a.index.namePostcodeKeys, ...b.index.namePostcodeKeys]),
      orgnrs: new Set([...a.index.orgnrs, ...b.index.orgnrs]),
      phones: new Set([...a.index.phones, ...b.index.phones]),
      entries: [...a.index.entries, ...b.index.entries],
    },
  };
}

function loadCombinedExistingLeadIndex(paths) {
  const uniquePaths = [...new Set((paths || []).filter(Boolean))];
  let combined = null;
  const loaded = [];

  for (const filePath of uniquePaths) {
    const one = loadExistingLeadIndex(filePath);
    if (!one) continue;
    combined = combined ? mergeLeadIndexes(combined, one) : { ...one, sourceFiles: [filePath] };
    loaded.push(filePath);
  }

  if (!combined) return null;
  combined.sourceFiles = loaded;
  combined.sourceFile = loaded.join(', ');
  return combined;
}

function discoverExclusionPaths(extraPath = null) {
  const paths = [];
  if (extraPath) paths.push(extraPath);
  if (process.env.EXISTING_LEADS_FILE) paths.push(process.env.EXISTING_LEADS_FILE);
  if (process.env.EXISTING_LEADS_FILES) {
    paths.push(
      ...process.env.EXISTING_LEADS_FILES.split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }
  if (fs.existsSync(DEFAULT_EXISTING_LEADS_FILE)) {
    paths.push(DEFAULT_EXISTING_LEADS_FILE);
  }

  try {
    const expanded = fs
      .readdirSync('.')
      .filter(
        (file) =>
          file.endsWith('.xlsx') &&
          !file.startsWith('~$') &&
          /GoogleMapsResults_.*_EXPANDED\.xlsx$/i.test(file)
      );
    paths.push(...expanded);
  } catch {
    /* cwd may be unreadable in tests */
  }

  return [...new Set(paths)];
}

function resolveExistingLeadsPath(cliPath) {
  if (cliPath) return cliPath;
  if (process.env.EXISTING_LEADS_FILE) return process.env.EXISTING_LEADS_FILE;
  if (fs.existsSync(DEFAULT_EXISTING_LEADS_FILE)) return DEFAULT_EXISTING_LEADS_FILE;
  return null;
}

module.exports = {
  DEFAULT_EXISTING_LEADS_FILE,
  loadExistingLeadIndex,
  loadCombinedExistingLeadIndex,
  discoverExclusionPaths,
  mergeLeadIndexes,
  isDuplicateLead,
  filterNewLeads,
  resolveExistingLeadsPath,
  leadKeysFromRow,
};
