/**
 * Shared lead-list column order.
 * First 25 columns match GoogleMapsResults_*_EXPANDED.xlsx so both
 * scrapers can be used in the same downstream workbooks.
 */

const SHARED_LEAD_COLUMNS = [
  'Name',
  'Address',
  'Website',
  'Phone',
  'Email',
  'Contact Person',
  'Business Phone',
  'Rating',
  'Review Count',
  'Hours',
  'PriceLevel',
  'Industry',
  'place_id',
  'Google Maps URL',
  'Lat',
  'Lng',
  'Business Status',
  'Selskapsform',
  'Antall Ansatte',
  'Tier',
  'Orgnr',
  'Brreg Name',
  'Brreg Parent Orgnr',
  'Match Score',
  'Match Confidence',
];

const BRREG_NEW_EXTRA_COLUMNS = [
  'Has Valid Phone',
  'Phone Source',
  'Phone Role',
  'NACE',
  'NACE Description',
  'Stiftelsesdato',
  'Registreringsdato',
  'Kommune',
  'Postnummer',
  'Poststed',
  'MVA-registrert',
  'Aktivitet',
  'Formål',
  'Maps Match Status',
  'Maps Match Score',
  'Maps Match Reason',
  'Owner Phone Status',
  'Owner Phone Reason',
  'Owner Phone Name',
  'Underenhet Status',
  'Underenhet Reason',
  'Underenhet Orgnr',
];

const LEAD_COLUMN_ORDER = [...SHARED_LEAD_COLUMNS, ...BRREG_NEW_EXTRA_COLUMNS];

const NOT_FOUND_COLS = new Set([
  'Website',
  'Phone',
  'Email',
  'Contact Person',
  'Business Phone',
  'Hours',
  'PriceLevel',
  'Selskapsform',
  'Antall Ansatte',
]);

function defaultFor(key) {
  if (NOT_FOUND_COLS.has(key)) return 'Not found';
  if (key === 'Has Valid Phone') return false;
  return '';
}

function shapeLeadRow(row) {
  const src = row || {};
  const out = {};
  for (const key of LEAD_COLUMN_ORDER) {
    let v = src[key];
    if (v == null || v === '') {
      if (key === 'Match Score' && src['Maps Match Status'] === 'matched' && src['Maps Match Score'] != null && src['Maps Match Score'] !== '') {
        v = src['Maps Match Score'];
      } else if (key === 'Match Confidence' && src['Maps Match Status'] === 'matched') {
        v = 'High';
      } else if (key === 'Has Valid Phone') {
        const digits = String(src.Phone || src['Business Phone'] || '').replace(/\D/g, '');
        v = digits.length >= 8;
      } else {
        v = defaultFor(key);
      }
    }
    out[key] = v;
  }
  return out;
}

function shapeLeadRows(rows) {
  return (rows || []).map(shapeLeadRow);
}

function jsonToLeadSheet(xlsx, rows) {
  return xlsx.utils.json_to_sheet(shapeLeadRows(rows), { header: LEAD_COLUMN_ORDER });
}

module.exports = {
  SHARED_LEAD_COLUMNS,
  BRREG_NEW_EXTRA_COLUMNS,
  LEAD_COLUMN_ORDER,
  shapeLeadRow,
  shapeLeadRows,
  jsonToLeadSheet,
};
