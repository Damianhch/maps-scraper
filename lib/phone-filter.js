/** True if Google Maps Phone or Brreg Business Phone looks like a real number (8+ digits). */
function hasValidPhone(business) {
  const googlePhone = String(business.Phone || business.phone || '').trim();
  const businessPhone = String(business['Business Phone'] || business.businessPhone || '').trim();
  const digitCount = (s) => (s.replace(/\D/g, '') || '').length;

  const hasGooglePhone =
    googlePhone &&
    googlePhone !== 'Not found' &&
    googlePhone !== 'null' &&
    digitCount(googlePhone) >= 8;
  const hasBusinessPhone =
    businessPhone &&
    businessPhone !== 'Not found' &&
    digitCount(businessPhone) >= 8;

  return hasGooglePhone || hasBusinessPhone;
}

/** Keep only rows with a valid phone; sets Has Valid Phone on each row. */
function filterRowsWithValidPhone(rows) {
  return rows.filter((business) => {
    const valid = hasValidPhone(business);
    business['Has Valid Phone'] = valid;
    return valid;
  });
}

module.exports = { hasValidPhone, filterRowsWithValidPhone };
