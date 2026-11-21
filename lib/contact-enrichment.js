const { fetchRoller, extractOfficers, pickPrimaryOfficer } = require('./brreg');
const { lookupPerson, lookupCompany, padPostcode } = require('./1881-lookup');
const { lookupGulesider, isJunkDirectoryResult } = require('./gulesider');
const { hasValidPhone } = require('./phone-filter');
const { normalizePhone } = require('./normalize');
const { personKey, companyKey, gsKey } = require('./contact-cache');

function digits9(value) {
  const d = String(value || '').replace(/\D/g, '');
  return d.length === 9 ? d : '';
}

function slimDirectoryResult(result) {
  if (!result) return null;
  return {
    status: result.status,
    reason: result.reason || '',
    phone: result.phone || '',
    phones: result.phones || (result.phone ? [result.phone] : []),
    emails: result.emails || [],
    website: result.website || '',
    orgnr: result.orgnr || '',
    source: result.source || '',
    personName: result.personName || result.person?.name || '',
    role: result.role || '',
    dagligLeder: result.dagligLeder || '',
    styreleder: result.styreleder || '',
  };
}

function scrubJunkDirectoryHits(rows, directoryCache) {
  let cacheCleared = 0;
  for (const [key, value] of Object.entries(directoryCache)) {
    if (key.startsWith('gulesider:') && isJunkDirectoryResult(value)) {
      delete directoryCache[key];
      cacheCleared += 1;
    }
  }
  const junk = new Set(['60442212', '22123456']);
  let rowsCleared = 0;
  for (const row of rows) {
    const phone = normalizePhone(row.Phone || '');
    const daglPhone = normalizePhone(row['Daglig leder phone'] || '');
    const website = String(row['Directory website'] || '');
    const dirPhones = String(row['Directory phones'] || '');
    const bad =
      junk.has(phone) ||
      junk.has(daglPhone) ||
      /cookiebot|cloudflare/i.test(website) ||
      /60442212/.test(dirPhones);
    if (!bad) continue;
    if (junk.has(phone) || /cookiebot|gulesider/i.test(String(row['Phone Source'] || website + dirPhones))) {
      if (!String(row['Phone Source'] || '').startsWith('brreg')) {
        row.Phone = '';
        row['Phone Source'] = '';
        row['Phone Role'] = '';
        row['Has Valid Phone'] = false;
      }
    }
    row['Directory phones'] = '';
    row['Directory email'] = '';
    row['Directory website'] = '';
    row['Directory source'] = '';
    if (junk.has(daglPhone)) row['Daglig leder phone'] = '';
    rowsCleared += 1;
  }
  return { cacheCleared, rowsCleared };
}

function applyOfficersToRow(row, officers) {
  const persons = (officers || []).filter((o) => o.isPerson !== false);
  const dagl = pickPrimaryOfficer(persons, 'DAGL') || pickPrimaryOfficer(persons, 'INNH');
  const lede = pickPrimaryOfficer(persons, 'LEDE');
  const others = persons.filter((o) => o !== dagl && o !== lede);

  if (dagl?.name || lede?.name || persons[0]?.name) {
    row['Contact Person'] = dagl?.name || lede?.name || persons[0].name;
  }
  row['Daglig leder'] = dagl?.name || '';
  row['Daglig leder rolle'] = dagl?.roleLabel || dagl?.role || '';
  row['Daglig leder fodselsdato'] = dagl?.birthDate || '';
  row['Styreleder'] = lede?.name || '';
  row['Styreleder fodselsdato'] = lede?.birthDate || '';
  row['Other officers'] = others.map((o) => `${o.name} (${o.roleLabel || o.role})`).join('; ');
  row['Officers source'] = officers && officers.length ? 'brreg-roller' : 'none';
  return { dagl, lede, others, persons };
}

async function enrichRowRoles(row, officersCache, { refresh = false } = {}) {
  const orgnr = digits9(row.Orgnr);
  if (!orgnr) {
    row['Officers source'] = 'no-orgnr';
    return [];
  }
  if (!refresh && Array.isArray(officersCache[orgnr]?.officers)) {
    return applyOfficersToRow(row, officersCache[orgnr].officers).persons;
  }
  const roller = await fetchRoller(orgnr);
  const officers = extractOfficers(roller);
  officersCache[orgnr] = { fetchedAt: new Date().toISOString(), officers };
  return applyOfficersToRow(row, officers).persons;
}

function setIfEmpty(row, key, value) {
  if (value == null || value === '') return;
  if (row[key]) return;
  row[key] = value;
}

function applyCompanyDirectory(row, result) {
  if (!result || result.status !== 'hit') return;
  const phones = result.phones || (result.phone ? [result.phone] : []);
  setIfEmpty(row, 'Directory phones', phones.join('; '));
  setIfEmpty(row, 'Directory email', (result.emails || []).join('; '));
  setIfEmpty(row, 'Directory website', result.website || '');
  row['Directory source'] = `1881-company:${result.reason || result.source || ''}`;
}

function applyOfficerPhone(row, result, role) {
  if (!result || result.status !== 'hit' || !result.phone) return;
  const phone = normalizePhone(result.phone);
  if (phone.length !== 8) return;
  if (role === 'LEDE') row['Styreleder phone'] = phone;
  else row['Daglig leder phone'] = phone;
}

function fillCompanyPhoneIfMissing(row) {
  if (hasValidPhone(row)) {
    row['Has Valid Phone'] = true;
    return false;
  }
  const directoryFirst = String(row['Directory phones'] || '')
    .split(/[;,]/)
    .map((s) => normalizePhone(s))
    .find((n) => n.length === 8);
  const dagl = normalizePhone(row['Daglig leder phone'] || '');
  const lede = normalizePhone(row['Styreleder phone'] || '');
  if (directoryFirst) {
    row.Phone = directoryFirst;
    row['Phone Source'] = /gulesider/i.test(String(row['Directory source'] || ''))
      ? 'gulesider'
      : '1881-company';
  } else if (dagl.length === 8) {
    row.Phone = dagl;
    row['Phone Source'] = 'daglig-leder-1881';
    row['Phone Role'] = 'DAGL';
  } else if (lede.length === 8) {
    row.Phone = lede;
    row['Phone Source'] = 'styreleder-1881';
    row['Phone Role'] = 'LEDE';
  } else {
    row['Has Valid Phone'] = false;
    return false;
  }
  row['Has Valid Phone'] = true;
  return true;
}

function geoFromRow(row) {
  return {
    postcode: padPostcode(row.Postnummer || row.Postcode),
    poststed: String(row.Poststed || '').trim(),
    orgnr: digits9(row.Orgnr),
  };
}

async function cachedLookup(cache, key, fn) {
  if (cache[key]?.status) return cache[key];
  const result = slimDirectoryResult(await fn());
  cache[key] = result;
  return result;
}

async function enrichRowDirectory(row, directoryCache, options = {}) {
  const { officerPhones = false, useGulesider = true, skip1881 = false } = options;
  const geo = geoFromRow(row);
  const attempts = [];
  const missingCompanyPhone = !hasValidPhone(row);

  if (missingCompanyPhone && !skip1881) {
    const result = await cachedLookup(directoryCache, companyKey(row.Name, geo.poststed), () =>
      lookupCompany(row.Name, geo)
    );
    attempts.push({ kind: 'company-1881', ...result });
    applyCompanyDirectory(row, result);
    fillCompanyPhoneIfMissing(row);
  }

  const needOfficer = !skip1881 && (officerPhones || !hasValidPhone(row));
  if (needOfficer) {
    const people = [
      { name: row['Daglig leder'], role: 'DAGL' },
      { name: row['Styreleder'], role: 'LEDE' },
    ].filter((p) => p.name);

    for (const person of people) {
      if (!officerPhones && hasValidPhone(row) && (row['Directory phones'] || row['Daglig leder phone'])) {
        break;
      }
      const result = await cachedLookup(directoryCache, personKey(person.name, geo.poststed), async () => {
        const looked = await lookupPerson(person.name, geo);
        return { ...looked, personName: person.name, role: person.role };
      });
      attempts.push({ kind: `person-1881-${person.role}`, ...result });
      applyOfficerPhone(row, result, person.role);
      fillCompanyPhoneIfMissing(row);
      if (!officerPhones && hasValidPhone(row)) break;
    }
  }

  if (useGulesider && !hasValidPhone(row)) {
    const result = await cachedLookup(directoryCache, gsKey(row.Name, geo.poststed), () =>
      lookupGulesider(row.Name, geo)
    );
    attempts.push({ kind: 'gulesider', ...result });
    if (result.dagligLeder && !row['Daglig leder']) row['Daglig leder'] = result.dagligLeder;
    if (result.styreleder && !row['Styreleder']) row['Styreleder'] = result.styreleder;
    if (result.status === 'hit' && result.phone) {
      row['Directory source'] = `gulesider:${result.reason || ''}`;
      if (!row['Directory phones']) row['Directory phones'] = result.phone;
      if (result.emails?.length && !row['Directory email']) row['Directory email'] = result.emails.join('; ');
      if (result.website && !row['Directory website']) row['Directory website'] = result.website;
    }
  }

  fillCompanyPhoneIfMissing(row);
  return attempts;
}

function explodeOfficers(row) {
  const officers = [];
  if (row['Daglig leder']) {
    officers.push({
      Orgnr: row.Orgnr,
      Company: row.Name,
      Poststed: row.Poststed,
      Role: 'DAGL',
      'Role label': row['Daglig leder rolle'] || 'Daglig leder',
      Name: row['Daglig leder'],
      'Birth date': row['Daglig leder fodselsdato'] || '',
      Phone: row['Daglig leder phone'] || '',
      'Company phone': row.Phone || '',
      Email: row.Email || '',
    });
  }
  if (row['Styreleder']) {
    officers.push({
      Orgnr: row.Orgnr,
      Company: row.Name,
      Poststed: row.Poststed,
      Role: 'LEDE',
      'Role label': 'Styreleder',
      Name: row['Styreleder'],
      'Birth date': row['Styreleder fodselsdato'] || '',
      Phone: row['Styreleder phone'] || '',
      'Company phone': row.Phone || '',
      Email: row.Email || '',
    });
  }
  for (const part of String(row['Other officers'] || '').split(';')) {
    const t = part.trim();
    if (!t) continue;
    const m = t.match(/^(.*)\s+\((.+)\)\s*$/);
    officers.push({
      Orgnr: row.Orgnr,
      Company: row.Name,
      Poststed: row.Poststed,
      Role: '',
      'Role label': m ? m[2] : '',
      Name: m ? m[1] : t,
      'Birth date': '',
      Phone: '',
      'Company phone': row.Phone || '',
      Email: row.Email || '',
    });
  }
  return officers;
}

module.exports = {
  applyOfficersToRow,
  enrichRowRoles,
  enrichRowDirectory,
  fillCompanyPhoneIfMissing,
  explodeOfficers,
  slimDirectoryResult,
  scrubJunkDirectoryHits,
  digits9,
};
