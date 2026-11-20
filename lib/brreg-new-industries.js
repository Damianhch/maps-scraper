/**
 * Top industries from the cumulative Maps ranking (Aug 2026), mapped to SN2025 NACE.
 * "lokal bedrift" is skipped — it is a catch-all Google query, not a register industry.
 */

const SKIPPED_INDUSTRIES = [
  {
    label: 'lokal bedrift',
    reason: 'Catch-all Google query (943 Maps hits). No NACE equivalent — would dump every new company.',
  },
];

const INDUSTRIES = [
  {
    id: 'restaurant',
    label: 'restaurant',
    naceCodes: ['56.110'],
    classify: classifyFoodService,
  },
  {
    id: 'fast-food-mobile',
    label: 'fast food',
    naceCodes: ['56.120'],
  },
  {
    id: 'butikk',
    label: 'butikk',
    naceCodes: [
      '47.1',
      '47.2',
      '47.4',
      '47.5',
      '47.6',
      '47.72',
      '47.73',
      '47.74',
      '47.75',
      '47.76',
      '47.77',
      '47.78',
      '47.79',
    ],
  },
  {
    id: 'klesbutikk',
    label: 'klesbutikk',
    naceCodes: ['47.710'],
  },
  {
    id: 'arkitekt',
    label: 'arkitekt',
    naceCodes: ['71.110'],
  },
  {
    id: 'frisor',
    label: 'frisør',
    naceCodes: ['96.210'],
  },
  {
    id: 'massasje',
    label: 'massasje',
    naceCodes: ['96.230'],
  },
  {
    id: 'bilverksted',
    label: 'bilverksted',
    naceCodes: ['95.310'],
  },
];

const CAFE_NAME_RE =
  /\b(kaf[eéè]|cafe|kaffebar|coffee house|coffeeshop|espresso bar)\b/i;
const FASTFOOD_NAME_RE =
  /\b(gatekj[øo]kken|burger|hamburger|kebab|shawarma|take\s?away|fast\s?food|hot\s?dog|p[øo]lsebod|food truck|foodtruck)\b/i;
const FASTFOOD_AKTIVITET_RE = /\bgatekj[øo]kken\b|\bmobile serverings/i;

function classifyFoodService(entity) {
  const name = entity.navn || '';
  const aktiviteter = String(entity.aktivitet || '')
    .split(';')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const primary = aktiviteter[0] || '';

  if (FASTFOOD_NAME_RE.test(name)) return 'fast food';
  if (
    /^drift av gatekj[øo]kken/.test(primary) ||
    (aktiviteter.length === 1 && FASTFOOD_AKTIVITET_RE.test(primary))
  ) {
    return 'fast food';
  }
  if (CAFE_NAME_RE.test(name)) return 'kafé';
  return 'restaurant';
}

function assignIndustry(entity, group) {
  if (typeof group.classify === 'function') {
    return group.classify(entity);
  }
  return group.label;
}

function allNaceCodes() {
  return INDUSTRIES.flatMap((g) => g.naceCodes);
}

module.exports = {
  INDUSTRIES,
  SKIPPED_INDUSTRIES,
  assignIndustry,
  classifyFoodService,
  allNaceCodes,
};
