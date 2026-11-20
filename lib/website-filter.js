function normalizeWebsiteUrl(url) {
  if (url == null) return '';
  const s = String(url).trim();
  if (!s || s === 'Not found' || s.toLowerCase() === 'n/a') return '';
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}

function isRealBusinessWebsite(url, businessName) {
  const normalized = normalizeWebsiteUrl(url);
  if (!normalized) {
    return false;
  }
  url = normalized;

  const nonBusinessDomains = [
    'wolt.com',
    'foodora.no',
    'just-eat.no',
    'uber.com',
    'doordash.com',
    'grubhub.com',
    'deliveroo.com',
    'google.com',
    'google.no',
    'googlemaps.com',
    'maps.google.com',
    'facebook.com',
    'instagram.com',
    'tripadvisor.com',
    'yelp.com',
    'foursquare.com',
    'zomato.com',
    'opentable.com',
    'resy.com',
    'bookatable.com',
    'thefork.com',
    'tiktok.com',
    'youtube.com',
    'pinterest.com',
    'snapchat.com',
    'linkedin.com',
    'twitter.com',
    'booking.resdiary.com',
    'booking.gastroplanner.no',
    'resdiary.com',
    'gastroplanner.no',
  ];

  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname.toLowerCase();

    for (const nonBusinessDomain of nonBusinessDomains) {
      if (domain.includes(nonBusinessDomain)) {
        return false;
      }
    }

    if (domain.includes('.') && !domain.includes('google') && !domain.includes('facebook') && !domain.includes('instagram')) {
      const domainParts = domain.split('.');
      if (domainParts.length >= 2) {
        let mainDomain;
        if (domainParts[0] === 'www' && domainParts.length >= 3) {
          mainDomain = domainParts[domainParts.length - 2] + '.' + domainParts[domainParts.length - 1];
        } else {
          mainDomain = domainParts[domainParts.length - 2] + '.' + domainParts[domainParts.length - 1];
        }

        const isKnownPlatform = nonBusinessDomains.some((platform) => mainDomain.includes(platform));
        if (!isKnownPlatform) {
          return true;
        }
      }
    }

    return false;
  } catch (error) {
    return false;
  }
}

function cleanWebsiteUrl(url, businessName) {
  if (!normalizeWebsiteUrl(url)) {
    return '';
  }

  if (isRealBusinessWebsite(url, businessName)) {
    return normalizeWebsiteUrl(url);
  }

  return '';
}

/** Exclude only when a real website is registered in both Brreg and Google Maps. */
function hasWebsiteInBothPlaces(brregWebsite, mapsWebsite, businessName) {
  return isRealBusinessWebsite(brregWebsite, businessName) && isRealBusinessWebsite(mapsWebsite, businessName);
}

module.exports = {
  normalizeWebsiteUrl,
  isRealBusinessWebsite,
  cleanWebsiteUrl,
  hasWebsiteInBothPlaces,
};
