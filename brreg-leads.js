/**
 * Nationwide Brreg-first leads: physical-labor AS/ASA with 10M+ NOK revenue.
 * Keeps companies that have a Brreg website. Does not call Google Maps.
 *
 * Usage:
 *   node brreg-leads.js
 *   node brreg-leads.js --trondheim
 *   node brreg-leads.js --greater
 *   node brreg-leads.js --refresh
 */

const fs = require('fs');
const path = require('path');
const xlsx = require('xlsx');
const { searchEnheterFiltered } = require('./lib/brreg');
const { fetchFinancialsForOrgnr, flushRegnskapCache, digits9 } = require('./lib/brreg-regnskap');
const { hasValidPhone } = require('./lib/phone-filter');
const { hasBrregWebsite } = require('./lib/filters');
const {
  MIN_REVENUE_NOK,
  PHYSICAL_LABOR_NACE,
  TRONDHEIM_KOMMUNER,
  GREATER_TRONDHEIM_KOMMUNER,
  physicalLaborGroup,
} = require('./lib/filters');

const CONCURRENCY = 8;
const CACHE_DIR = path.join(__dirname, 'cache');
const ENHETER_CACHE = path.join(CACHE_DIR, 'physical-labor-enheter.json');
const PROGRESS_XLSX = 'BrregLeads_PROGRESS.xlsx';
const LATEST_XLSX = 'BrregLeads_LATEST.xlsx';

const args = process.argv.slice(2);
const refresh = args.includes('--refresh');
const trondheim = args.includes('--trondheim');
const greater = args.includes('--greater');

function region() {
  if (trondheim) return { label: 'trondheim', kommuner: TRONDHEIM_KOMMUNER };
  if (greater) return { label: 'greater-trondheim', kommuner: GREATER_TRONDHEIM_KOMMUNER };
  return { label: 'norway', kommuner: null };
}

function formatAddress(addr) {
  if (!addr) return '';
  const line = Array.isArray(addr.adresse) ? addr.adresse.filter(Boolean).join(', ') : addr.adresse || '';
  return [line, addr.postnummer, addr.poststed].filter(Boolean).join(', ');
}

function pickPhone(enhet) {
  return (enhet.telefon || enhet.mobil || '').trim();
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

async function fetchKommuner() {
  const res = await fetch('https://ws.geonorge.no/kommuneinfo/v1/kommuner');
  if (!res.ok) throw new Error(`Geonorge kommuner HTTP ${res.status}`);
  const data = await res.json();
  return data
    .map((k) => ({
      nr: String(k.kommunenummer).padStart(4, '0'),
      navn: k.kommunenavnNorsk || k.kommunenavn,
    }))
    .sort((a, b) => a.nr.localeCompare(b.nr));
}

function slimEnhet(enhet) {
  return {
    organisasjonsnummer: enhet.organisasjonsnummer,
    navn: enhet.navn,
    organisasjonsform: enhet.organisasjonsform,
    naeringskode1: enhet.naeringskode1,
    naeringskode2: enhet.naeringskode2,
    naeringskode3: enhet.naeringskode3,
    forretningsadresse: enhet.forretningsadresse,
    telefon: enhet.telefon,
    mobil: enhet.mobil,
    epostadresse: enhet.epostadresse,
    hjemmeside: enhet.hjemmeside,
    antallAnsatte: enhet.antallAnsatte,
    registrertIMvaregisteret: enhet.registrertIMvaregisteret,
    sisteInnsendteAarsregnskap: enhet.sisteInnsendteAarsregnskap,
    konkurs: enhet.konkurs,
    underAvvikling: enhet.underAvvikling,
  };
}

function toRow(enhet, financials) {
  const nace = enhet.naeringskode1?.kode || '';
  const phone = pickPhone(enhet);
  const hjemmeside = enhet.hjemmeside || '';
  return {
    Name: enhet.navn || '',
    Orgnr: enhet.organisasjonsnummer || '',
    'Accounting Orgnr': financials.accountingOrgnr || enhet.organisasjonsnummer || '',
    Selskapsform: enhet.organisasjonsform?.kode || '',
    'NACE Code': nace,
    Industry: enhet.naeringskode1?.beskrivelse || '',
    'Industry group': physicalLaborGroup(nace),
    Address: formatAddress(enhet.forretningsadresse),
    Postnummer: enhet.forretningsadresse?.postnummer || '',
    Poststed: enhet.forretningsadresse?.poststed || '',
    Kommune: enhet.forretningsadresse?.kommune || '',
    'Kommune nr': enhet.forretningsadresse?.kommunenummer || '',
    Phone: phone,
    Email: enhet.epostadresse || '',
    'Contact Person': '',
    'Antall Ansatte': enhet.antallAnsatte ?? '',
    'Brreg Website': hjemmeside,
    'Has Brreg Website': hasBrregWebsite(hjemmeside),
    'Revenue NOK': financials.revenueNok ?? '',
    'Revenue Year': financials.revenueYear || '',
    'Operating Profit': financials.operatingProfit ?? '',
    'Net Profit': financials.netProfit ?? '',
    Equity: financials.equity ?? '',
    'Accounting Status': financials.accountingStatus || '',
    'MVA registered': enhet.registrertIMvaregisteret ? 'Yes' : 'No',
    'Last filed year': enhet.sisteInnsendteAarsregnskap || '',
    Source: 'Brreg',
    'Google Maps Website': '',
    'Review Count': '',
    Rating: '',
  };
}

function writeWorkbook(filename, sheets) {
  const wb = xlsx.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(rows.length ? rows : [{ Note: 'empty' }]), name.slice(0, 31));
  }
  xlsx.writeFile(wb, filename);
}

function groupCounts(rows, key) {
  const map = {};
  for (const r of rows) {
    const k = r[key] || '(blank)';
    map[k] = (map[k] || 0) + 1;
  }
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .map(([Group, Count]) => ({ Group, Count }));
}

async function collectEnheter(kommuner) {
  const byOrgnr = new Map();
  for (let i = 0; i < kommuner.length; i++) {
    const k = kommuner[i];
    const { items, totalElements } = await searchEnheterFiltered({
      naeringskode: PHYSICAL_LABOR_NACE.join(','),
      organisasjonsform: 'AS,ASA',
      kommunenummer: k.nr,
      konkurs: false,
      underAvvikling: false,
      size: 100,
    });
    for (const e of items) {
      const orgnr = digits9(e.organisasjonsnummer);
      if (orgnr && !byOrgnr.has(orgnr)) byOrgnr.set(orgnr, slimEnhet(e));
    }
    if ((i + 1) % 20 === 0 || i + 1 === kommuner.length) {
      console.log(`   kommune ${i + 1}/${kommuner.length} ${k.nr} ${k.navn}: +${items.length} (unique ${byOrgnr.size})`);
    }
  }
  return [...byOrgnr.values()];
}

async function main() {
  const { label, kommuner: onlyKommuner } = region();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const outFile = `BrregLeads_${label}_${stamp}.xlsx`;

  console.log('🏗️  Brreg physical-labor leads (no Google Maps)');
  console.log(`   Region: ${label}`);
  console.log(`   NACE: ${PHYSICAL_LABOR_NACE.join(', ')}`);
  console.log(`   Form: AS, ASA | min omsetning: ${MIN_REVENUE_NOK.toLocaleString('nb-NO')} NOK`);
  console.log('   Website: keep Brreg websites (Maps both-places filter is later)\n');

  let items = null;
  if (!refresh && fs.existsSync(ENHETER_CACHE) && label === 'norway') {
    try {
      const cached = JSON.parse(fs.readFileSync(ENHETER_CACHE, 'utf8'));
      if (Array.isArray(cached.items) && cached.items.length > 1000) {
        items = cached.items;
        console.log(`📦 Loaded ${items.length} cached enheter from ${cached.fetchedAt || ENHETER_CACHE}\n`);
      }
    } catch {
      items = null;
    }
  }

  if (!items) {
    let kommuner;
    if (onlyKommuner) {
      kommuner = onlyKommuner.map((nr) => ({ nr, navn: nr }));
    } else {
      console.log('📍 Fetching Norwegian kommuner...');
      kommuner = await fetchKommuner();
      console.log(`   ${kommuner.length} kommuner\n`);
    }
    console.log('📋 Collecting Enhetsregisteret (physical labor AS/ASA)...');
    items = await collectEnheter(kommuner);
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    if (label === 'norway') {
      fs.writeFileSync(
        ENHETER_CACHE,
        JSON.stringify({ fetchedAt: new Date().toISOString(), nace: PHYSICAL_LABOR_NACE, items })
      );
    }
  }

  const withPhone = items.filter((e) => String(pickPhone(e)).replace(/\D/g, '').length >= 8);
  const withWeb = items.filter((e) => hasBrregWebsite(e.hjemmeside));
  const demographyAll = groupCounts(
    items.map((e) => ({ g: physicalLaborGroup(e.naeringskode1?.kode) })),
    'g'
  );

  console.log(`\n📊 Universe: ${items.length} AS/ASA`);
  console.log(`   Brreg phone: ${withPhone.length}`);
  console.log(`   Brreg website: ${withWeb.length}`);
  console.log('   Industry mix:');
  for (const row of demographyAll) {
    console.log(`     ${row.Count}  ${row.Group}`);
  }

  console.log('\n💶 Fetching annual accounts (cached orgnr skipped)...\n');

  let done = 0;
  const withAccounts = await mapPool(items, CONCURRENCY, async (enhet) => {
    const financials = await fetchFinancialsForOrgnr(enhet.organisasjonsnummer, enhet.organisasjonsform?.kode);
    done += 1;
    if (done % 200 === 0 || done === items.length) {
      console.log(`   accounts ${done}/${items.length}`);
      flushRegnskapCache();
    }
    return { enhet, financials };
  });
  flushRegnskapCache();

  const tenM = withAccounts.filter(
    ({ financials }) => financials.revenueNok != null && financials.revenueNok >= MIN_REVENUE_NOK
  );
  const qualifiedRows = tenM.map(({ enhet, financials }) => toRow(enhet, financials));
  qualifiedRows.sort((a, b) => Number(b['Revenue NOK'] || 0) - Number(a['Revenue NOK'] || 0));

  const callable = qualifiedRows.filter((r) => hasValidPhone(r));
  const needMapsPhone = qualifiedRows.filter((r) => !hasValidPhone(r));
  const noAccounts = withAccounts.filter((x) => x.financials.accountingStatus !== 'ok').length;
  const below = withAccounts.filter(
    (x) => x.financials.revenueNok != null && x.financials.revenueNok < MIN_REVENUE_NOK
  ).length;

  const summary = [
    { Metric: 'Region', Value: label },
    { Metric: 'NACE prefixes', Value: PHYSICAL_LABOR_NACE.join(', ') },
    { Metric: 'Org forms', Value: 'AS, ASA' },
    { Metric: 'Physical-labor AS/ASA found', Value: items.length },
    { Metric: 'With Brreg phone (any revenue)', Value: withPhone.length },
    { Metric: 'With Brreg website (any revenue)', Value: withWeb.length },
    { Metric: 'With filed accounts (revenue field)', Value: withAccounts.length - noAccounts },
    { Metric: 'No accounts / no revenue field', Value: noAccounts },
    { Metric: 'Below 10M NOK', Value: below },
    { Metric: '10M+ NOK (all, websites kept)', Value: qualifiedRows.length },
    { Metric: 'CALLABLE now (10M+ and Brreg phone)', Value: callable.length },
    { Metric: '10M+ missing Brreg phone (Maps later)', Value: needMapsPhone.length },
    { Metric: 'Min revenue NOK', Value: MIN_REVENUE_NOK },
    { Metric: 'Google Maps', Value: 'NOT RUN — wait for confirmation (maps-backfill.js --run)' },
    { Metric: 'Website rule', Value: 'Keep Brreg websites. Later drop only if website is on BOTH Brreg and Google Maps.' },
    { Metric: 'Source', Value: 'Brønnøysundregistrene Enhetsregisteret + Regnskapsregisteret' },
    { Metric: 'Generated at', Value: new Date().toISOString() },
  ];

  const sheets = {
    'Callable 10M phone': callable,
    '10M need Maps phone': needMapsPhone,
    '10M all': qualifiedRows,
    'Industry mix 10M': groupCounts(qualifiedRows, 'Industry group'),
    'Industry mix universe': demographyAll.map((r) => ({ Group: r.Group, Count: r.Count })),
    Summary: summary,
  };

  writeWorkbook(outFile, sheets);
  writeWorkbook(LATEST_XLSX, sheets);
  writeWorkbook(PROGRESS_XLSX, sheets);

  console.log('\n' + '='.repeat(60));
  console.log('📊 BRREG PHYSICAL-LABOR LEADS');
  console.log('='.repeat(60));
  console.log(`Universe AS/ASA: ${items.length}`);
  console.log(`10M+ NOK (websites kept): ${qualifiedRows.length}`);
  console.log(`Callable now (phone): ${callable.length}`);
  console.log(`10M+ without Brreg phone (do not Maps until you say yes): ${needMapsPhone.length}`);
  console.log(`📁 ${outFile}`);
  console.log(`📁 ${LATEST_XLSX}`);
  console.log('='.repeat(60) + '\n');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ brreg-leads failed:', err);
    try {
      flushRegnskapCache();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
}

module.exports = { main };
