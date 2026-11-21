/**
 * Run: node test/officers.test.js
 */
const { extractOfficers, extractContactPersons, pickPrimaryOfficer } = require('../lib/brreg');
const { applyOfficersToRow, fillCompanyPhoneIfMissing } = require('../lib/contact-enrichment');
const { companyNamesMatch, parseSuggestionTitle, namesMatch } = require('../lib/1881-lookup');
const { parseCompanyPageText } = require('../lib/gulesider');
const roller = require('./fixtures/roller-mce.json');

let passed = 0;
let failed = 0;

function assert(name, cond) {
  if (cond) {
    passed += 1;
    console.log('PASS', name);
  } else {
    failed += 1;
    console.log('FAIL', name);
  }
}

const officers = extractOfficers(roller);
assert('skips auditor company', !officers.some((o) => o.role === 'REVI'));
assert('daglig leder name', pickPrimaryOfficer(officers, 'DAGL')?.name === 'Kenneth Hegerland');
assert('daglig leder birth', pickPrimaryOfficer(officers, 'DAGL')?.birthDate === '1980-09-02');
assert('styreleder name', pickPrimaryOfficer(officers, 'LEDE')?.name === 'Jan Anders Vinje');
assert('board member keeps MEDL not STYR', officers.some((o) => o.role === 'MEDL' && o.name === 'Lars Hovda'));

const contacts = extractContactPersons(roller);
assert('contact order DAGL first', contacts[0].name === 'Kenneth Hegerland' && contacts[0].role === 'DAGL');
assert('styreleder is second person', contacts[1].role === 'LEDE');
assert('MEDL not labeled STYR', contacts.find((c) => c.name === 'Lars Hovda')?.role === 'MEDL');

const row = { Name: 'MCE AS', Orgnr: '982837553' };
applyOfficersToRow(row, officers);
assert('row daglig leder', row['Daglig leder'] === 'Kenneth Hegerland');
assert('row styreleder', row['Styreleder'] === 'Jan Anders Vinje');
assert('row contact person is DAGL', row['Contact Person'] === 'Kenneth Hegerland');
assert('other officers include board', /Lars Hovda/.test(row['Other officers']));

row['Daglig leder phone'] = '41636110';
fillCompanyPhoneIfMissing(row);
assert('missing company phone uses DAGL mobile', row.Phone === '41636110' && row['Phone Source'] === 'daglig-leder-1881');

assert('company exact', companyNamesMatch('MCE AS', 'McE AS'));
assert('company tokens', companyNamesMatch('Teigen Bygg & Trelast AS', 'Teigen Bygg og Trelast'));
assert('company rejects unrelated', !companyNamesMatch('MCE AS', 'Teigen Bygg AS'));

const parsed = parseSuggestionTitle('McE AS, Tongane, Etne');
assert('suggestion name', parsed.name === 'McE AS');
assert('suggestion place', parsed.poststed === 'Etne');
assert('person namesMatch', namesMatch('Kenneth Hegerland', 'Kenneth Hegerland'));
assert('person namesMatch rejects last-name miss', !namesMatch('Kenneth Hegerland', 'Kenneth Vinje'));

const gsText = `
Mce AS
53 77 12...
Org.nr:
982837553
Daglig leder
Kenneth Hegerland
Styrets leder
Jan Anders Vinje
Mce AS ligger på Tongane 53 og kan nås på et av følgende nummer.
53771270
5377 1270
`;
const gs = parseCompanyPageText(gsText);
assert('gulesider faq phone', gs.status === 'hit' && gs.phone === '53771270');
assert('gulesider orgnr', gs.orgnr === '982837553');
assert('gulesider daglig leder', gs.dagligLeder === 'Kenneth Hegerland');
assert('gulesider ignores truncated-only', parseCompanyPageText('Mce AS\n53 77 12...\n').status === 'phone-hidden');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
