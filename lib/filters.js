/**
 * Shared lead-quality rules for Maps scrape, Brreg expand, and Brreg-first leads.
 */

const MIN_REVIEW_COUNT = 0;
const MIN_REVENUE_NOK = 10_000_000;
const EXCLUDE_ORG_FORMS = ['ENK'];
const REQUIRE_PHONE_AFTER_EXPAND = true;
const REQUIRE_NO_REAL_WEBSITE = true;

/** Construction NACE prefixes (SN2007/SN2025): buildings, civil, specialized trades. */
const CONSTRUCTION_NACE = ['41', '42', '43'];

/**
 * Physical-labor / trades AS we can sell a high-ticket ops marketing suite to.
 * Includes construction plus betong, trevare, metall, maskinreparasjon, renovasjon,
 * anleggsgartner, renhold, godstransport, verksted (SN2025 95.3), maskinutleie.
 */
const PHYSICAL_LABOR_NACE = [
  '08',
  '16',
  '23',
  '25',
  '31',
  '33',
  '38',
  '39',
  '41',
  '42',
  '43',
  '49.4',
  '52',
  '77.3',
  '81',
  '95',
];

const PHYSICAL_LABOR_GROUPS = [
  { id: 'construction_buildings', label: 'Oppføring av bygninger', prefixes: ['41'] },
  { id: 'civil', label: 'Anlegg / infrastruktur', prefixes: ['42'] },
  { id: 'trades', label: 'Byggfag (elektro, rør, maler, tak, snekker, murer, betongarbeid)', prefixes: ['43'] },
  { id: 'concrete_mineral', label: 'Betong / stein / glass / mineral', prefixes: ['08', '23'] },
  { id: 'wood', label: 'Trevare / treindustri', prefixes: ['16'] },
  { id: 'metal', label: 'Metallvarer', prefixes: ['25'] },
  { id: 'furniture', label: 'Møbelproduksjon', prefixes: ['31'] },
  { id: 'machinery_repair', label: 'Reparasjon og installasjon av maskiner', prefixes: ['33'] },
  { id: 'waste', label: 'Renovasjon / gjenvinning', prefixes: ['38', '39'] },
  { id: 'freight', label: 'Godstransport på vei', prefixes: ['49.4'] },
  { id: 'warehouse', label: 'Lagring og transportstøtte', prefixes: ['52'] },
  { id: 'rental', label: 'Utleie av anleggsmaskiner', prefixes: ['77.3'] },
  { id: 'facilities', label: 'Renhold / vaktmester / eiendomsdrift', prefixes: ['81.1', '81.2'] },
  { id: 'landscape', label: 'Anleggsgartner / uteanlegg', prefixes: ['81.3'] },
  { id: 'vehicle_repair', label: 'Bilverksted / kjøretøyreparasjon', prefixes: ['95.3'] },
  { id: 'other_repair', label: 'Annen reparasjon', prefixes: ['95.1', '95.2'] },
];

function naceMatchesPrefix(code, prefix) {
  const c = String(code || '');
  if (!c || !prefix) return false;
  if (c === prefix) return true;
  if (c.startsWith(`${prefix}.`)) return true;
  if (prefix.includes('.')) return c.startsWith(prefix);
  return c.split('.')[0] === prefix;
}

function naceMatchesAny(code, prefixes) {
  return (prefixes || []).some((p) => naceMatchesPrefix(code, p));
}

function naceCodesOf(enhet) {
  return [enhet.naeringskode1, enhet.naeringskode2, enhet.naeringskode3]
    .filter(Boolean)
    .map((n) => n.kode)
    .filter(Boolean);
}

function isPhysicalLaborEnhet(enhet) {
  return naceCodesOf(enhet).some((code) => naceMatchesAny(code, PHYSICAL_LABOR_NACE));
}

function physicalLaborGroup(naceCode) {
  const hit = PHYSICAL_LABOR_GROUPS.find((g) => naceMatchesAny(naceCode, g.prefixes));
  return hit ? hit.label : 'Annen fysisk arbeid';
}

/** Trondheim — same geography as the Google Maps scraper. */
const TRONDHEIM_KOMMUNER = ['5001'];

/** Trondheim + nearby municipalities we can realistically sell into. */
const GREATER_TRONDHEIM_KOMMUNER = ['5001', '5028', '5031', '5029', '5007', '5035'];

function normalizeOrgForm(kode) {
  return String(kode || '')
    .toUpperCase()
    .trim();
}

function isExcludedOrgForm(kode) {
  const form = normalizeOrgForm(kode);
  if (!form || form === 'NOT FOUND') return false;
  return EXCLUDE_ORG_FORMS.includes(form);
}

function passesOrgFormFilter(row) {
  return !isExcludedOrgForm(row.Selskapsform || row.selskapsform || row.orgFormKode);
}

function parseRevenueNok(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const n = Number(String(value).replace(/\s/g, '').replace(/,/g, '.'));
  return Number.isFinite(n) ? n : null;
}

function meetsMinRevenue(row, minNok = MIN_REVENUE_NOK) {
  const n = parseRevenueNok(row['Revenue NOK'] ?? row.revenueNok);
  return n != null && n >= minNok;
}

function hasBrregWebsite(value) {
  const s = String(value || '')
    .trim()
    .toLowerCase();
  return Boolean(s) && s !== 'not found' && s !== 'n/a';
}

module.exports = {
  MIN_REVIEW_COUNT,
  MIN_REVENUE_NOK,
  EXCLUDE_ORG_FORMS,
  REQUIRE_PHONE_AFTER_EXPAND,
  REQUIRE_NO_REAL_WEBSITE,
  CONSTRUCTION_NACE,
  PHYSICAL_LABOR_NACE,
  PHYSICAL_LABOR_GROUPS,
  TRONDHEIM_KOMMUNER,
  GREATER_TRONDHEIM_KOMMUNER,
  normalizeOrgForm,
  isExcludedOrgForm,
  passesOrgFormFilter,
  parseRevenueNok,
  meetsMinRevenue,
  hasBrregWebsite,
  naceMatchesPrefix,
  naceMatchesAny,
  naceCodesOf,
  isPhysicalLaborEnhet,
  physicalLaborGroup,
};
