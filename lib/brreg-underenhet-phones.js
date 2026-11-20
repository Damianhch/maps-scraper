/**
 * Phone from Brreg underenheter (branches) when the hovedenhet has none.
 * Unique 8-digit number only; if several, keep the one at the same postcode.
 */

const { fetchUnderenheterByParent, pickBusinessPhone } = require('./brreg');
const { normalizePhone } = require('./normalize');
const { brregPostcode } = require('./brreg-places-match');

function padPostcode(raw) {
  const d = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (!d) return '';
  return d.padStart(4, '0').slice(-4);
}

function unitPhone(unit) {
  const raw = pickBusinessPhone(unit);
  if (!raw || raw === 'Not found') return '';
  const n = normalizePhone(raw);
  return n.length === 8 ? n : '';
}

function samePostcode(unit, postcode) {
  const pc = padPostcode(postcode);
  const up = padPostcode(unit.postnummer);
  return Boolean(pc && up && pc === up);
}

function pickUnderenhetPhone(units, { postcode } = {}) {
  const live = (units || []).filter((u) => !u.slettedato && unitPhone(u));
  const unique = [...new Set(live.map(unitPhone))];
  if (!unique.length) {
    return {
      status: units?.length ? 'no_phone' : 'no_unit',
      reason: units?.length ? 'underenhet_no_phone' : 'no_underenhet',
      phone: '',
      unit: null,
    };
  }
  if (unique.length === 1) {
    const unit = live.find((u) => unitPhone(u) === unique[0]);
    return { status: 'hit', reason: 'unique', phone: unique[0], unit };
  }
  const local = live.filter((u) => samePostcode(u, postcode));
  const localPhones = [...new Set(local.map(unitPhone))];
  if (localPhones.length === 1) {
    const unit = local.find((u) => unitPhone(u) === localPhones[0]);
    return { status: 'hit', reason: 'same_postcode', phone: localPhones[0], unit };
  }
  return { status: 'ambiguous', reason: 'multiple_phones', phone: '', unit: null };
}

async function lookupUnderenhetPhone(row) {
  const orgnr = String(row.Orgnr || '').replace(/\D/g, '');
  const units = await fetchUnderenheterByParent(orgnr);
  const picked = pickUnderenhetPhone(units, {
    postcode: brregPostcode(row) || row.Postnummer,
  });
  picked.unitCount = units.length;
  return picked;
}

function applyUnderenhetPhone(row, result) {
  row['Underenhet Status'] = result.status;
  row['Underenhet Reason'] = result.reason || '';
  if (result.status !== 'hit' || !result.phone) return row;
  row.Phone = result.phone;
  row['Business Phone'] = result.phone;
  row['Has Valid Phone'] = true;
  row['Phone Source'] = 'brreg-underenhet';
  if (result.unit?.orgnr) row['Underenhet Orgnr'] = result.unit.orgnr;
  return row;
}

module.exports = {
  lookupUnderenhetPhone,
  pickUnderenhetPhone,
  applyUnderenhetPhone,
};
