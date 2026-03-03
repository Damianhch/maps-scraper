const puppeteer = require('puppeteer');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');

// Setup page with anti-detection (same as scraper)
async function setupPageAntiDetection(page) {
  // Set realistic viewport
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  
  // Set modern user agent (Chrome 120)
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  // Set additional headers to appear more realistic
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9,no;q=0.8,nb;q=0.7',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0'
  });
  
  // Hide automation indicators
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
    
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );
    
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en', 'no'],
    });
    
    window.chrome = {
      runtime: {},
    };
  });

  // Set consent cookies (may fail on about:blank - navigate to Google first)
  try {
    await page.setCookie(
      {
        name: 'CONSENT',
        value: 'YES+cb.20241219-17-0.en+FX+667',
        domain: '.google.com',
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60
      },
      {
        name: 'CONSENT',
        value: 'YES+cb.20241219-17-0.en+FX+667',
        domain: '.google.no',
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60
      }
    );
  } catch (e) {
    // Cookies may fail on about:blank - will be set after first navigation
  }
}

// Handle Google consent - mirrors scraper.js handleConsent exactly (proven to work)
async function handleGoogleConsentProper(page, url) {
  console.log('  🍪 [handleConsent] Starting. Target: ' + url.substring(0, 70) + '...');
  console.log('  📍 [handleConsent] Current URL: "' + page.url() + '"');
  
  // Exact same as scraper: networkidle2, catch timeout and continue (page IS loaded, just background reqs)
  try {
    console.log('  🔄 [handleConsent] goto (networkidle2, 30s)...');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    console.log('  ✅ [handleConsent] Success. URL: "' + page.url() + '"');
  } catch (e) {
    // Timeout is EXPECTED on Google - page IS loaded, background requests keep running
    console.log('  ⚠️ [handleConsent] Timeout (expected on Google) - continuing. URL: "' + page.url() + '"');
  }
  
  // Wait for page to load
  await new Promise(resolve => setTimeout(resolve, 4000));
  
  // Handle Google consent page if it appears
  let currentUrl = page.url();
  let consentAttempts = 0;
  const maxConsentAttempts = 3;
  
  while ((currentUrl.includes('consent.google.com') || currentUrl.includes('/consent') || currentUrl.includes('consent')) && consentAttempts < maxConsentAttempts) {
    console.log(`  🍪 Consent page detected (attempt ${consentAttempts + 1}/${maxConsentAttempts})`);
    consentAttempts++;
    
    try {
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Try multiple methods to find and click accept button
      const clicked = await page.evaluate(() => {
        const allClickable = Array.from(document.querySelectorAll('button, div[role="button"], [role="button"], a[role="button"]'));
        const acceptButton = allClickable.find(btn => {
          const text = (btn.textContent || btn.innerText || btn.getAttribute('aria-label') || btn.title || '').toLowerCase().trim();
          return text === 'accept all' || 
                 text === 'godta alle' ||
                 text === 'accept' ||
                 text === 'godta' ||
                 text.includes('accept all') ||
                 text.includes('godta alle') ||
                 text.includes('i agree');
        });
        
        if (acceptButton) {
          acceptButton.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setTimeout(() => acceptButton.click(), 100);
          return true;
        }
        
        const selectors = [
          '#L2AGLb',
          'button[data-ved]',
          'button[id*="accept"]',
          'button[class*="accept"]',
          'form button[type="submit"]',
          'button[jsname]',
          '[data-ved][role="button"]'
        ];
        
        for (const selector of selectors) {
          const btn = document.querySelector(selector);
          if (btn && btn.offsetParent !== null) {
            btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(() => btn.click(), 100);
            return true;
          }
        }
        
        return false;
      });
      
      if (clicked) {
        console.log('  ✅ Clicked accept button, waiting for redirect...');
        await new Promise(resolve => setTimeout(resolve, 4000));
        
        try {
          await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 }).catch(() => {});
        } catch (e) {}
      } else {
        console.log('  ⚠️  Could not find accept button automatically');
        const continueUrl = await page.evaluate(() => {
          const continueLink = document.querySelector('a[href*="continue="]');
          if (continueLink) {
            const href = continueLink.getAttribute('href');
            const match = href.match(/continue=([^&]+)/);
            if (match) {
              return decodeURIComponent(match[1]);
            }
          }
          const urlParams = new URLSearchParams(window.location.search);
          return urlParams.get('continue');
        });
        
        if (continueUrl) {
          console.log(`  🔄 Found continue URL, navigating directly...`);
          await page.goto(continueUrl, { waitUntil: 'networkidle2', timeout: 30000 });
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }
      
      currentUrl = page.url();
      
      if (!currentUrl.includes('consent.google.com') && !currentUrl.includes('/consent') && !currentUrl.includes('consent')) {
        console.log('  ✅ Successfully passed consent screen!');
        break;
      }
    } catch (error) {
      console.log(`  ⚠️  Error handling consent (attempt ${consentAttempts}): ${error.message}`);
    }
  }
  
  // Final check
  currentUrl = page.url();
  if (currentUrl.includes('consent.google.com') || currentUrl.includes('/consent') || currentUrl.includes('consent')) {
    console.log('  ⚠️  Still on consent page, trying to extract continue URL...');
    try {
      const continueUrl = await page.evaluate(() => {
        const urlParams = new URLSearchParams(window.location.search);
        return urlParams.get('continue');
      });
      if (continueUrl) {
        await page.goto(decodeURIComponent(continueUrl), { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    } catch (e) {
      console.log('  ⚠️  Could not extract continue URL');
    }
  }
}

// TESTING MODE: Set to number of businesses to process, or null/undefined to process all
// Example: const TEST_LIMIT = 5;  // Process only first 5 businesses
//          const TEST_LIMIT = null; // Process all businesses
const TEST_LIMIT = null; // Set to a number (e.g., 5) to limit processing, or null to process all

// DEBUG MODE: Set to true to enable detailed HTML inspection and selector discovery
// This will help identify the exact HTML classes/selectors that contain the information
const DEBUG_MODE = false;

// MANUAL SELECTORS: If you find the exact selectors, add them here for objective extraction
// Format: { contactPerson: 'selector', businessPhone: 'selector' }
// Leave as null to use automatic discovery
const MANUAL_SELECTORS = {
  contactPerson: null, // e.g., '.mui-1m20kv8' or '[data-testid="contact-person"]'
  businessPhone: 'a.addax.addax-cs_ip_phone_click'  // Found from debug: This is the clickable phone link
};

// --- Normalization and matching (for two-step Proff search) ---
/** Normalize address for matching: strip building-name prefix, expand street abbreviations, lowercase, collapse space. */
function normalizeAddress(s) {
  if (!s || typeof s !== 'string') return '';
  let t = s.trim();
  // Strip leading "BUILDINGNAME, " only when the part before the first comma has no digits (likely building/area name)
  if (t.includes(',')) {
    const firstSegment = t.split(',')[0].trim();
    if (!/\d/.test(firstSegment)) {
      t = t.replace(/^[^,]+\s*,\s*/, '');
    }
  }
  t = t
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[,.]/g, '');
  // Collapse digit + single letter so "25 a" matches "25a"
  t = t.replace(/\b(\d+)\s+([a-zæøå])\b/g, '$1$2');
  // Norwegian street abbreviations -> "gate" so "gt" matches "gate"
  t = t.replace(/\bgt\b/g, 'gate');
  t = t.replace(/\bgata\b/g, 'gate');
  t = t.replace(/\bvegen\b/g, 'veg');
  t = t.replace(/\bvei\b/g, 'veg');
  t = t.replace(/\bveg\b/g, 'veg');
  t = t.replace(/\b(\d{4})\s*([A-Za-zÆØÅæøå]+)?/g, '$1 $2').trim();
  return t;
}

function normalizeName(s) {
  if (!s || typeof s !== 'string') return '';
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[,.]/g, '');
}

/** Strip special characters from business name for search queries (Proff, Google). Removes / \\ and similar to avoid broken URLs and noisy queries. */
function cleanBusinessNameForSearch(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .replace(/[/\\|*?"<>]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Address match: normalize both and compare. Also true if one contains the other (handles extra tokens). */
function addressesMatch(addr1, addr2) {
  const a = normalizeAddress(addr1);
  const b = normalizeAddress(addr2);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  return false;
}

/** Clean address for Google/search: same normalization so query matches how Proff.no lists addresses. */
function addressForSearch(rawAddress) {
  return normalizeAddress(rawAddress);
}

/** Name similarity for step 2: one contains the other, or high word overlap (same business, different wording). */
function namesSimilar(name1, name2) {
  const a = normalizeName(name1);
  const b = normalizeName(name2);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 1));
  const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 1));
  const intersection = [...wordsA].filter(w => wordsB.has(w));
  const unionSize = new Set([...wordsA, ...wordsB]).size;
  if (unionSize === 0) return false;
  const ratio = intersection.length / Math.min(wordsA.size, wordsB.size);
  return ratio >= 0.6;
}

/** Score 0–1 for how similar name is to the business name (for picking best among same-address results). Not strict. */
function nameSimilarityScore(businessName, title) {
  const a = normalizeName(businessName);
  const b = normalizeName(title);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.85;
  const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 1));
  const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 1));
  const intersection = [...wordsA].filter(w => wordsB.has(w));
  const ratio = intersection.length / Math.min(wordsA.size, wordsB.size) || 0;
  return ratio;
}

/** Detect Proff category/search result (e.g. "golf i bedrifter - 2694 treff", "golfklubb - 324 selskaper") - not a single business. */
function isCategoryResult(title) {
  if (!title || typeof title !== 'string') return true;
  const t = title.trim();
  if (/i bedrifter\s*[-–]\s*\d+\s*treff/i.test(t)) return true;
  if (/\d+\s*treff\s*\|\s*Side\s+\d+\s+av\s+\d+/i.test(t)) return true;
  if (/\d+\s*selskaper\s+i Norge/i.test(t)) return true;
  if (/-\s*\d+\s*selskaper/i.test(t)) return true;
  if (/Side\s+\d+\s+av\s+\d+/.test(t)) return true;
  return false;
}

/** Dismiss Proff.no consent/cookie banner if present (handles multiple CMP frameworks + iframes). Fast waits for Step 1. */
async function handleProffConsent(page) {
  try {
    await new Promise(resolve => setTimeout(resolve, 100));

    // 1. Try common button selectors on the main page
    const consentSelectors = [
      'button[aria-label*="Godta"]',
      'button[aria-label*="Accept"]',
      '#onetrust-accept-btn-handler',
      'button[id*="accept"]',
      'button[class*="accept"]',
      'button[class*="consent"]',
      'button[title="ENIG"]',
      'button[title="Enig"]',
    ];
    for (const selector of consentSelectors) {
      try {
        const btn = await page.$(selector);
        if (btn) {
          await btn.click();
          await new Promise(resolve => setTimeout(resolve, 150));
          return;
        }
      } catch (e) {}
    }

    // 2. Text-based search: find any button containing "ENIG", "Godta", "Aksepter", "Accept" on main page
    const clicked = await page.evaluate(() => {
      const targets = ['ENIG', 'Enig', 'Godta alle', 'Godta', 'Aksepter', 'Accept all', 'Accept'];
      const buttons = [...document.querySelectorAll('button, [role="button"], a.btn, a[class*="button"]')];
      for (const target of targets) {
        for (const btn of buttons) {
          const text = (btn.textContent || '').trim();
          if (text === target || text.toUpperCase() === target.toUpperCase()) {
            btn.click();
            return true;
          }
        }
      }
      return false;
    });
    if (clicked) {
      await new Promise(resolve => setTimeout(resolve, 150));
      return;
    }

    // 3. Check inside iframes (many CMP frameworks use iframes for the consent dialog)
    const frames = page.frames();
    for (const frame of frames) {
      try {
        const frameClicked = await frame.evaluate(() => {
          const targets = ['ENIG', 'Enig', 'Godta alle', 'Godta', 'Aksepter', 'Accept all', 'Accept'];
          const buttons = [...document.querySelectorAll('button, [role="button"], a.btn, a[class*="button"]')];
          for (const target of targets) {
            for (const btn of buttons) {
              const text = (btn.textContent || '').trim();
              if (text === target || text.toUpperCase() === target.toUpperCase()) {
                btn.click();
                return true;
              }
            }
          }
          return false;
        });
        if (frameClicked) {
          await new Promise(resolve => setTimeout(resolve, 150));
          return;
        }
      } catch (e) {}
    }
  } catch (e) {}
}

/** Extract company name, address, contact person, phone, selskapsform, antall ansatte from current Proff page. */
async function extractAllFromProffPage(page) {
  const extracted = await page.evaluate(() => {
    const bodyText = document.body.innerText || '';

    // --- Company name (for matching) ---
    let proffCompanyName = '';
    const h1 = document.querySelector('h1');
    if (h1) proffCompanyName = h1.textContent.trim();
    if (!proffCompanyName) proffCompanyName = (document.title || '').split('|')[0].split('-')[0].trim();

    // --- Address (for matching) ---
    let proffAddress = '';
    const adresseLabels = ['Adresse', 'Besøksadresse', 'Postadresse'];
    for (const label of adresseLabels) {
      const idx = bodyText.indexOf(label);
      if (idx !== -1) {
        const after = bodyText.substring(idx + label.length, idx + label.length + 120);
        const line = after.split('\n')[0].trim();
        const cleaned = line.replace(/^\s*[:\-]\s*/, '').trim();
        if (cleaned.length > 5 && /\d{4}/.test(cleaned)) {
          proffAddress = cleaned;
          break;
        }
      }
    }
    if (!proffAddress) {
      const addrMatch = bodyText.match(/(?:Adresse|Besøksadresse)[:\s]*([^\n]{10,80}\d{4}\s*[A-Za-zÆØÅæøå]+)/);
      if (addrMatch) proffAddress = addrMatch[1].trim();
    }

    // --- Contact person and phone (existing logic) ---
    const roles = ['Daglig leder', 'Styrets leder', 'Styreleder', 'Administrerende direktør', 'CEO', 'Kontaktperson'];
    let contactPerson = null;
    for (const role of roles) {
      const allElements = document.querySelectorAll('*');
      for (const element of allElements) {
        const elementText = element.textContent || '';
        if (elementText.includes(role)) {
          const roleIndex = elementText.indexOf(role);
          const afterRole = elementText.substring(roleIndex + role.length).trim();
          const sameLineMatch = afterRole.match(/^[:\s]*([A-ZÆØÅ][a-zæøå]+(?:\s+[A-ZÆØÅ][a-zæøå]+)+)/);
          if (sameLineMatch && sameLineMatch[1]) {
            let name = sameLineMatch[1].trim();
            const adresseIndex = name.toLowerCase().indexOf('adresse');
            if (adresseIndex !== -1) name = name.substring(0, adresseIndex).trim();
            if (name.length > 2 && name.length < 100) {
              contactPerson = name;
              break;
            }
          }
          let nextSibling = element.nextElementSibling;
          if (nextSibling) {
            let name = (nextSibling.textContent || '').trim();
            const adresseIndex = name.toLowerCase().indexOf('adresse');
            if (adresseIndex !== -1) name = name.substring(0, adresseIndex).trim();
            if (name.length > 2 && name.length < 100 && /[A-ZÆØÅa-zæøå]/.test(name) && !name.match(/^\d+$/) && !name.toLowerCase().includes(role.toLowerCase())) {
              contactPerson = name;
              break;
            }
          }
          if (element.parentElement) {
            const children = Array.from(element.parentElement.children);
            const ri = children.indexOf(element);
            if (ri !== -1 && ri < children.length - 1) {
              const nextChild = children[ri + 1];
              let name = (nextChild.textContent || '').trim();
              const adresseIndex = name.toLowerCase().indexOf('adresse');
              if (adresseIndex !== -1) name = name.substring(0, adresseIndex).trim();
              if (name.length > 2 && name.length < 100 && /[A-ZÆØÅa-zæøå]/.test(name) && !name.match(/^\d+$/) && !name.toLowerCase().includes(role.toLowerCase())) {
                contactPerson = name;
                break;
              }
            }
          }
        }
        if (contactPerson) break;
      }
      if (contactPerson) break;
    }
    if (!contactPerson) {
      for (const role of roles) {
        const roleIndex = bodyText.indexOf(role);
        if (roleIndex !== -1) {
          const afterRole = bodyText.substring(roleIndex + role.length, roleIndex + role.length + 200);
          const sameLineMatch = afterRole.match(/^[:\s]*([A-ZÆØÅ][a-zæøå]+(?:\s+[A-ZÆØÅ][a-zæøå]+)+)/);
          if (sameLineMatch && sameLineMatch[1]) {
            let name = sameLineMatch[1].trim();
            const adresseIndex = name.toLowerCase().indexOf('adresse');
            if (adresseIndex !== -1) name = name.substring(0, adresseIndex).trim();
            if (name.length > 2 && name.length < 100) {
              contactPerson = name;
              break;
            }
          }
          const lines = afterRole.split(/\n/).filter(l => l.trim().length > 0);
          for (let i = 0; i < Math.min(lines.length, 3); i++) {
            let name = lines[i].trim();
            if (name.toLowerCase().includes(role.toLowerCase())) continue;
            const adresseIndex = name.toLowerCase().indexOf('adresse');
            if (adresseIndex !== -1) name = name.substring(0, adresseIndex).trim();
            if (name.length > 2 && name.length < 100 && /[A-ZÆØÅa-zæøå]/.test(name) && !name.match(/^\d+$/)) {
              contactPerson = name;
              break;
            }
          }
          if (contactPerson) break;
        }
      }
    }

    let businessPhone = null;
    const phoneLinks = document.querySelectorAll('a[href^="tel:"]');
    for (const phoneLink of phoneLinks) {
      const href = phoneLink.getAttribute('href');
      if (href) {
        const phone = href.replace('tel:', '').trim();
        if (phone.length >= 8) {
          businessPhone = phone;
          break;
        }
      }
    }
    if (!businessPhone) {
      const telefonIndex = bodyText.indexOf('Telefon');
      if (telefonIndex !== -1) {
        const afterTelefon = bodyText.substring(telefonIndex + 7, telefonIndex + 30);
        const phoneMatch = afterTelefon.match(/(\+47\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{2}|\d{2}\s?\d{2}\s?\d{2}\s?\d{2}|\d{8})/);
        if (phoneMatch) businessPhone = phoneMatch[1].replace(/\s+/g, '').trim();
      }
    }
    if (!businessPhone) {
      const phoneMatch = bodyText.match(/(\+47\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{2}|\d{2}\s?\d{2}\s?\d{2}\s?\d{2}|\d{8})/);
      if (phoneMatch) businessPhone = phoneMatch[1].replace(/\s+/g, '').trim();
    }

    let selskapsform = null;
    let antallAnsatte = null;
    const companyTypeLabels = ['Selskapsform', 'Organisasjonsform', 'Foretaksform'];
    for (const label of companyTypeLabels) {
      const labelIndex = bodyText.indexOf(label);
      if (labelIndex !== -1) {
        const afterLabel = bodyText.substring(labelIndex + label.length, labelIndex + label.length + 100);
        const companyTypes = [
          { pattern: 'enkeltpersonforetak', short: 'ENK' }, { pattern: 'aksjeselskap', short: 'AS' },
          { pattern: 'ansvarlig selskap', short: 'ANS' }, { pattern: 'delt ansvar', short: 'DA' },
          { pattern: 'norskregistrert utenlandsk foretak', short: 'NUF' }, { pattern: 'samvirkeforetak', short: 'SA' },
          { pattern: 'allmennaksjeselskap', short: 'ASA' }, { pattern: 'stiftelse', short: 'Stiftelse' }
        ];
        for (const type of companyTypes) {
          if (afterLabel.toLowerCase().includes(type.pattern)) {
            selskapsform = type.short;
            break;
          }
        }
        if (!selskapsform) {
          const rawMatch = afterLabel.match(/^\s*:?\s*([A-ZÆØÅa-zæøå\s]+)/);
          if (rawMatch && rawMatch[1].trim().length > 1) selskapsform = rawMatch[1].trim();
        }
        if (selskapsform) break;
      }
    }
    if (!selskapsform) {
      const asMatch = bodyText.match(/\b(ENK|AS|ANS|DA|NUF|SA|ASA)\b/);
      if (asMatch) selskapsform = asMatch[1];
    }
    const ansatteIndex = bodyText.indexOf('Antall ansatte');
    if (ansatteIndex !== -1) {
      const afterAnsatte = bodyText.substring(ansatteIndex + 14, ansatteIndex + 50);
      const numMatch = afterAnsatte.match(/(\d+[-–]?\d*\+?)/);
      if (numMatch) antallAnsatte = numMatch[1];
    }

    return {
      proffCompanyName: proffCompanyName || '',
      proffAddress: proffAddress || '',
      contactPerson: contactPerson,
      businessPhone: businessPhone,
      selskapsform: selskapsform,
      antallAnsatte: antallAnsatte
    };
  });
  return extracted;
}

// Function to scrape Proff.no for contact person/owner name (two-step: Proff direct, then Google)
const STEP2_MAX_SERP_RESULTS = 15;
const STEP1_NAV_TIMEOUT = 5000;
const STEP1_CANDIDATE_TIMEOUT = 5000;

/** Step 1: Search Proff.no by business name across all result pages; match by address visible on listing; open ONLY the matching profile (never open every result). */
async function step1ProffDirectSearch(businessName, address, page) {
  const searchName = cleanBusinessNameForSearch(businessName) || businessName;
  console.log(`  🔍 Proff.no direct: "${searchName}"`);
  try {
    const currentUrl = page.url();
    if (!currentUrl.includes('proff.no')) {
      await page.goto('https://www.proff.no', { waitUntil: 'domcontentloaded', timeout: STEP1_NAV_TIMEOUT });
      await handleProffConsent(page);
      await new Promise(resolve => setTimeout(resolve, 150));
    }

    const normalizedSearchAddress = normalizeAddress(address);
    const allCandidates = [];
    let pageNum = 1;
    let hasNextPage = true;

    while (hasNextPage) {
      const searchUrl = pageNum === 1
        ? `https://www.proff.no/s%C3%B8k-etter-firmanavn?q=${encodeURIComponent(searchName)}`
        : `https://www.proff.no/s%C3%B8k-etter-firmanavn?q=${encodeURIComponent(searchName)}&side=${pageNum}`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: STEP1_NAV_TIMEOUT });
      await handleProffConsent(page);
      await new Promise(resolve => setTimeout(resolve, 150));

      const pageResult = await page.evaluate((currentPage) => {
        const out = [];
        const seen = new Set();
        const links = document.querySelectorAll('a[href*="/selskap/"], a[href*="/bedrift/"], a[href*="/firma/"]');
        for (const a of links) {
          let href = a.href || a.getAttribute('href');
          if (!href || href.includes('sok') || href.includes('s%C3%B8k') || href.includes('bransje')) continue;
          try {
            const u = new URL(href, 'https://www.proff.no');
            const pathParts = u.pathname.split('/').filter(Boolean);
            if (pathParts.length < 2 || seen.has(u.pathname)) continue;
            seen.add(u.pathname);
            let snippet = '';
            // Walk up to find the result card that contains both link and address (postcode in text)
            let el = a.parentElement;
            while (el && el !== document.body) {
              const text = (el.innerText || el.textContent || '').trim();
              if (text.length >= 50 && /\d{4}\s*[A-Za-zÆØÅæøå]+/.test(text)) {
                snippet = text;
                break;
              }
              el = el.parentElement;
            }
            if (!snippet) {
              const row = a.closest('article') || a.closest('[data-testid]') || a.closest('div[class]') || a.parentElement;
              if (row) snippet = (row.innerText || row.textContent || '').trim();
            }
            if (!snippet) snippet = (a.innerText || a.textContent || '').trim();
            out.push({ href: u.href, snippet });
          } catch (e) {}
        }
        const nextPage = currentPage + 1;
        const nextLinks = document.querySelectorAll(`a[href*="side=${nextPage}"]`);
        const hasNext = nextLinks.length > 0;
        return { candidates: out, hasNext };
      }, pageNum);

      hasNextPage = pageResult.hasNext && pageResult.candidates.length > 0;

      pageResult.candidates.forEach(c => allCandidates.push(c));

      if (pageResult.candidates.length > 0 && pageResult.hasNext) {
        console.log(`  📄 Step 1: page ${pageNum} → ${pageResult.candidates.length} candidates (${allCandidates.length} total), more pages`);
      }

      // If we got 0 candidates we might be on a single-result redirect (profile page)
      if (pageResult.candidates.length === 0) {
        const url = page.url();
        if (/proff\.no\/(selskap|bedrift|firma)\/[^/]+\//.test(url)) {
          console.log('  📋 Step 1: Single result (redirect to profile), extracting');
          const data = await extractAllFromProffPage(page);
          if (data && data.proffAddress && addressesMatch(address, data.proffAddress)) {
            console.log(`  📍 Address match: "${data.proffAddress}"`);
            return { ...data, tier: 1 };
          }
        }
        break;
      }

      const matchOnListing = allCandidates.find(c => normalizedSearchAddress && addressesMatch(address, c.snippet));
      if (matchOnListing) {
        console.log(`  📋 Step 1: Address match on listing (page ${pageNum}), opening 1 profile only`);
        await page.goto(matchOnListing.href, { waitUntil: 'domcontentloaded', timeout: STEP1_CANDIDATE_TIMEOUT });
        await handleProffConsent(page);
        await new Promise(resolve => setTimeout(resolve, 150));
        const data = await extractAllFromProffPage(page);
        if (data && data.proffAddress && addressesMatch(address, data.proffAddress)) {
          console.log(`  📍 Address match: "${data.proffAddress}"`);
          return { ...data, tier: 1 };
        }
      }

      if (!hasNextPage) break;
      pageNum++;
      console.log(`  📄 Step 1: loading result page ${pageNum}...`);
    }

    // Never open every candidate – only open when we matched on listing. If no listing match, return null (Step 2 will run).
    if (allCandidates.length > 0) {
      console.log(`  📋 Step 1: ${allCandidates.length} candidate(s) on ${pageNum} page(s), no address on listing – skip (no profile opened)`);
    }
  } catch (e) {
    console.log(`  ⚠️  Step 1 error: ${e.message}`);
  }
  return null;
}

/** Wait for Bing bot challenge to be solved by the user, if one appears.
 *  Bing shows "Et siste trinn" / "Verifying..." CAPTCHA for automated browsers.
 *  Pauses and waits up to 3 minutes for the user to solve it manually. */
async function waitForBingChallenge(page) {
  const isChallenge = await page.evaluate(() => {
    const body = (document.body ? document.body.innerText : '').toLowerCase();
    return body.includes('et siste trinn') || body.includes('one more step') ||
           body.includes('verifying') || body.includes('captcha') ||
           body.includes('løs utfordringen') || body.includes('solve the challenge');
  }).catch(() => false);

  if (!isChallenge) return; // No challenge, continue normally

  console.log('\n  ⚠️  ⚠️  ⚠️  BING CHALLENGE DETECTED — PLEASE SOLVE THE PUZZLE IN THE BROWSER WINDOW  ⚠️  ⚠️  ⚠️');
  console.log('  ⏳ Waiting up to 3 minutes for you to complete the verification...\n');

  const maxWaitMs = 3 * 60 * 1000;
  const pollMs = 2000;
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, pollMs));
    const stillChallenge = await page.evaluate(() => {
      const body = (document.body ? document.body.innerText : '').toLowerCase();
      return body.includes('et siste trinn') || body.includes('one more step') ||
             body.includes('verifying') || body.includes('løs utfordringen') ||
             body.includes('solve the challenge');
    }).catch(() => false);
    if (!stillChallenge) {
      console.log('  ✅ Challenge solved! Continuing...\n');
      await new Promise(r => setTimeout(r, 1500)); // Let results render
      return;
    }
  }
  console.log('  ❌ Challenge not solved within 3 minutes — skipping this business.\n');
}

/** Step 2: DuckDuckGo HTML search for proff.no company profile.
 *  Uses html.duckduckgo.com/html/ — plain HTML, no JS, no redirects, no bot detection, Norwegian results. */
async function step2BingSearch(businessName, address, page) {
  if (!address || !String(address).trim()) return null;
  if (!page) return null;
  const normalizedSearchAddress = normalizeAddress(address);

  const doSearch = async (query) => {
    // DDG HTML endpoint: plain HTML page, direct links, Norwegian region (kl=no-no)
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=no-no`;
    console.log(`  🔍 DDG: ${query.substring(0, 80)}...`);
    try {
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } catch (e) { /* page loads even on timeout */ }
    await new Promise(r => setTimeout(r, 800));

    const currentUrl = page.url();
    if (!currentUrl.includes('duckduckgo.com')) {
      console.log(`  ⚠️  Unexpected URL: ${currentUrl.substring(0, 60)}`);
      return [];
    }

    // DDG HTML returns direct links (no redirect wrapping like Bing/Google)
    const found = await page.evaluate((max) => {
      const out = [], seen = new Set();
      // Results are in <div class="result"> or <div class="web-result">
      const items = Array.from(document.querySelectorAll('.result, .web-result, [data-testid="result"]'));
      for (const item of items) {
        // Main link: .result__a or .result__title a
        const a = item.querySelector('a.result__a, .result__title a, h2 a, a[href*="proff.no"]');
        if (!a) continue;
        let href = a.href || a.getAttribute('href') || '';
        if (!href.startsWith('http')) continue;
        if (!href.includes('proff.no')) continue;
        if (href.includes('/sok') || href.includes('/s%C3%B8k') || href.includes('/bransje')) continue;
        try {
          const parts = new URL(href).pathname.split('/').filter(Boolean);
          if (parts.length < 2) continue;
          if (!parts.some(p => ['selskap', 'bedrift', 'firma'].includes(p.toLowerCase()))) continue;
        } catch (e) { continue; }
        if (seen.has(href)) continue; seen.add(href);
        const title = (a.textContent || '').trim();
        const blockText = (item.innerText || item.textContent || '').trim();
        if (title) { out.push({ href, title, blockText }); if (out.length >= max) break; }
      }
      return out;
    }, STEP2_MAX_SERP_RESULTS).catch(() => []);

    console.log(`  📊 ${found.length} proff.no company pages found`);
    return found;
  };

  try {
    // Tier 2: name + quoted address + site:proff.no → accept only if address in snippet
    const q2 = `${cleanBusinessNameForSearch(businessName) || businessName} "${address}" site:proff.no`;
    console.log(`  🔎 Tier 2: ${q2}`);
    const r2 = await doSearch(q2);
    const r2addr = r2.filter(r =>
      !isCategoryResult(r.title) && normalizedSearchAddress && addressesMatch(address, r.blockText)
    );
    if (r2addr.length > 0) {
      r2addr.sort((a, b) => nameSimilarityScore(businessName, b.title) - nameSimilarityScore(businessName, a.title));
      console.log(`  📍 Tier 2 match: "${r2addr[0].title.slice(0, 60)}"`);
      const d = await openProffUrlAndExtract(r2addr[0].href, page);
      if (d) return { ...d, tier: 2 };
    }
    console.log(`  📋 Tier 2: ${r2.length} results, ${r2addr.length} with matching address`);

    // Tier 3: name only + site:proff.no → first viable result
    const q3 = `${cleanBusinessNameForSearch(businessName) || businessName} site:proff.no`;
    console.log(`  🔎 Tier 3: ${q3}`);
    const r3 = await doSearch(q3);
    const r3v = r3.filter(r => !isCategoryResult(r.title));
    if (r3v.length > 0) {
      console.log(`  📌 Tier 3: "${r3v[0].title.slice(0, 60)}"`);
      const d = await openProffUrlAndExtract(r3v[0].href, page);
      if (d) return { ...d, tier: 3 };
    } else {
      console.log('  ⚠️  No proff.no results found for this business');
    }
  } catch (e) {
    console.log(`  ⚠️  Step 2 error: ${e.message}`);
  }
  return null;
}

async function openProffUrlAndExtract(href, page) {
  try {
    // Validate URL before navigating
    if (!href || !href.includes('proff.no')) {
      console.log(`  ⚠️  Invalid Proff URL: ${href}`);
      return null;
    }
    
    // Navigate with retry logic
    let navSuccess = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await page.goto(href, { waitUntil: 'networkidle', timeout: 20000 });
        navSuccess = true;
        break;
      } catch (navErr) {
        if (attempt === 0) {
          // Try with domcontentloaded as fallback
          try {
            await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 20000 });
            navSuccess = true;
            break;
          } catch (e) {
            console.log(`  ⚠️  Navigation attempt ${attempt + 1} failed: ${e.message}`);
          }
        } else {
          throw navErr;
        }
      }
    }
    
    if (!navSuccess) {
      console.log(`  ⚠️  Failed to navigate to Proff URL: ${href}`);
      return null;
    }
    
    // Handle consent banner
    await handleProffConsent(page);
    
    // Wait for page content to load
    await new Promise(resolve => setTimeout(resolve, 2500));
    
    // Verify we're on a proff.no page
    const currentUrl = page.url();
    if (!currentUrl.includes('proff.no')) {
      console.log(`  ⚠️  Not on Proff page after navigation: ${currentUrl}`);
      return null;
    }
    
    // Extract data
    const data = await extractAllFromProffPage(page);
    if (data) {
      console.log(`  ✅ Got data from: ${data.proffCompanyName || '(page)'}`);
    } else {
      console.log(`  ⚠️  No data extracted from Proff page`);
    }
    return data || null;
  } catch (e) {
    console.log(`  ⚠️  Error opening Proff URL (${href}): ${e.message}`);
    if (e.stack) {
      console.log(`  Stack: ${e.stack.split('\n').slice(0, 3).join('\n')}`);
    }
    return null;
  }
}

async function scrapeProffContactPerson(businessName, address, page) {
  try {
    const excelAddress = (address && address !== 'Not found' && String(address).trim()) ? String(address).trim() : '';

    // Step 1: Proff.no direct search by name, match by address (top 10 results)
    if (excelAddress) {
      const result1 = await step1ProffDirectSearch(businessName, excelAddress, page);
      if (result1) {
        console.log('  ✅ Matched via Step 1 (Proff direct) → Tier 1');
        return formatProffResult(result1);
      }
    }

    // Step 2: Google search "address site:proff.no" only; parse SERP, pick result with address in snippet + name in title
    if (excelAddress) {
      const result2 = await step2BingSearch(businessName, excelAddress, page);
      if (result2) {
        console.log(`  ✅ Matched via Step 2 (Google SERP) → Tier ${result2.tier}`);
        return formatProffResult(result2);
      }
    }

    console.log('  ⚠️  No matching Proff.no profile found');
    return { contactPerson: 'Not found', businessPhone: 'Not found', selskapsform: 'Not found', antallAnsatte: 'Not found', tier: '' };
  } catch (error) {
    console.log(`  ❌ Error scraping Proff.no: ${error.message}`);
    return {
      contactPerson: 'Not found',
      businessPhone: 'Not found',
      selskapsform: 'Not found',
      antallAnsatte: 'Not found',
      tier: ''
    };
  }
}

function formatProffResult(data) {
  let contactPerson = (data.contactPerson || '').trim();
  const adresseIndex = contactPerson.toLowerCase().indexOf('adresse');
  if (adresseIndex !== -1) contactPerson = contactPerson.substring(0, adresseIndex).trim();
  contactPerson = contactPerson.replace(/^(Daglig leder|Styrets leder|Styreleder|Administrerende direktør|CEO|Kontaktperson)[:\s]*/i, '').trim();
  return {
    contactPerson: contactPerson || 'Not found',
    businessPhone: data.businessPhone || 'Not found',
    selskapsform: data.selskapsform || 'Not found',
    antallAnsatte: data.antallAnsatte || 'Not found',
    tier: data.tier != null ? data.tier : ''
  };
}

// Function to find the most recent Excel file
function findMostRecentExcelFile() {
  const files = fs.readdirSync('.')
    .filter(file => file.endsWith('.xlsx') && !file.startsWith('~$'))
    .map(file => ({
      name: file,
      time: fs.statSync(file).mtime.getTime()
    }))
    .sort((a, b) => b.time - a.time);
  
  return files.length > 0 ? files[0].name : null;
}

// Function to backup Excel file
function backupExcelFile(filename) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupName = filename.replace('.xlsx', `_backup_${timestamp}.xlsx`);
  fs.copyFileSync(filename, backupName);
  console.log(`📦 Backup created: ${backupName}`);
  return backupName;
}

// Main function to expand Excel file with contact person information
async function expandExcelWithContactPersons(excelFilename = null) {
  // Find Excel file if not provided
  if (!excelFilename) {
    excelFilename = findMostRecentExcelFile();
    if (!excelFilename) {
      console.error('❌ No Excel file found in current directory');
      process.exit(1);
    }
    console.log(`📄 Using most recent file: ${excelFilename}`);
  } else {
    if (!fs.existsSync(excelFilename)) {
      console.error(`❌ File not found: ${excelFilename}`);
      process.exit(1);
    }
    console.log(`📄 Using specified file: ${excelFilename}`);
  }
  
  // Read the Excel file (no backup - we save progress continuously)
  console.log('\n📖 Reading Excel file...');
  const workbook = xlsx.readFile(excelFilename);
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = xlsx.utils.sheet_to_json(worksheet);
  
  if (data.length === 0) {
    console.error('❌ No data found in Excel file');
    process.exit(1);
  }
  
  console.log(`✅ Found ${data.length} businesses to process\n`);
  
  // Check if Contact Person, Business Phone, and Selskapsform columns exist, if not add them
  const hasContactPersonColumn = data.length > 0 && 'Contact Person' in data[0];
  const hasBusinessPhoneColumn = data.length > 0 && 'Business Phone' in data[0];
  const hasSelskapsformColumn = data.length > 0 && 'Selskapsform' in data[0];
  
  if (!hasContactPersonColumn) {
    console.log('📝 Adding "Contact Person" column to data...');
    data.forEach(row => {
      if (!row['Contact Person']) {
        row['Contact Person'] = 'Not found';
      }
    });
  }
  
  if (!hasBusinessPhoneColumn) {
    console.log('📝 Adding "Business Phone" column to data...');
    data.forEach(row => {
      if (!row['Business Phone']) {
        row['Business Phone'] = 'Not found';
      }
    });
  }
  
  if (!hasSelskapsformColumn) {
    console.log('📝 Adding "Selskapsform" column to data...');
    data.forEach(row => {
      if (!row['Selskapsform']) {
        row['Selskapsform'] = 'Not found';
      }
    });
  }
  
  const hasAntallAnsatteColumn = data.length > 0 && 'Antall Ansatte' in data[0];
  if (!hasAntallAnsatteColumn) {
    console.log('📝 Adding "Antall Ansatte" column to data...');
    data.forEach(row => {
      if (!row['Antall Ansatte']) {
        row['Antall Ansatte'] = 'Not found';
      }
    });
  }

  const hasTierColumn = data.length > 0 && 'Tier' in data[0];
  if (!hasTierColumn) {
    console.log('📝 Adding "Tier" column to data...');
    data.forEach(row => {
      if (row['Tier'] == null) row['Tier'] = '';
    });
  }
  
  // Browser launch function
  const BROWSER_RESTART_INTERVAL = 50; // Restart browser every 100 businesses to prevent memory issues
  
  async function launchBrowser() {
    console.log('🌐 Launching browser...');
    // Match scraper.js createBrowser args - proven to work for Google
    const newBrowser = await puppeteer.launch({ 
      headless: false,
      protocolTimeout: 300000,
      ignoreHTTPSErrors: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=VizDisplayCompositor',
        '--disable-infobars',
        '--window-size=1280,720'
      ]
    });
    
    const newPage = await newBrowser.newPage();
    
    // Set user agent
    await newPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
    
    // Set additional headers
    await newPage.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9,no;q=0.8'
    });
    
    // Hide automation indicators
    await newPage.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
    });
    
    return { browser: newBrowser, page: newPage };
  }
  
  let { browser, page } = await launchBrowser();

  let processedSinceRestart = 0; // Track businesses processed since last browser restart
  
  let updatedCount = 0;
  let foundCount = 0;
  let notFoundCount = 0;
  let skippedCount = 0;
  let shouldStop = false;
  
  // Function to save progress incrementally
  // Saves to a consistent filename so we always have the latest progress
  let lastSavedFilename = null;
  const saveProgress = async (force = false) => {
    try {
      // Make sure we're using the updated data array
      // When TEST_LIMIT is null, businessesToProcess === data, so updates are already in data
      // When TEST_LIMIT is set, we need to merge back
      if (TEST_LIMIT) {
        businessesToProcess.forEach((processed, idx) => {
          const originalIdx = data.findIndex(b => (b.Name || b.name) === (processed.Name || processed.name));
          if (originalIdx !== -1) {
            data[originalIdx] = processed;
          }
        });
      }
      
      const newWorksheet = xlsx.utils.json_to_sheet(data);
      const newWorkbook = xlsx.utils.book_new();
      xlsx.utils.book_append_sheet(newWorkbook, newWorksheet, workbook.SheetNames[0]);
      
      // Preserve other sheets
      for (let i = 1; i < workbook.SheetNames.length; i++) {
        const sheet = workbook.Sheets[workbook.SheetNames[i]];
        xlsx.utils.book_append_sheet(newWorkbook, sheet, workbook.SheetNames[i]);
      }
      
      // Use a consistent filename for progress (overwrites previous - only 1 file)
      const progressFilename = excelFilename.replace('.xlsx', '_EXPANDED.xlsx');
      xlsx.writeFile(newWorkbook, progressFilename);
      lastSavedFilename = progressFilename;
      
      // Only log every 10th save to avoid spam
      if (updatedCount % 10 === 0 || force) {
        console.log(`\n💾 Progress saved to: ${progressFilename} (${updatedCount} processed)`);
      }
      return progressFilename;
    } catch (error) {
      console.error(`\n⚠️  Error saving progress: ${error.message}`);
      console.error(error.stack);
      return null;
    }
  };
  
  // Graceful shutdown handler
  let isShuttingDown = false;
  const shutdownHandler = async (signal) => {
    if (isShuttingDown) {
      console.log('\n⚠️  Already shutting down, please wait...');
      return;
    }
    isShuttingDown = true;
    
    console.log(`\n\n⚠️  ${signal} received. Saving progress and shutting down gracefully...`);
    shouldStop = true;
    
    // Save progress FIRST (before closing browser) - CRITICAL!
    try {
      console.log('\n🔄 Saving all progress before shutdown...');
      const savedFile = await saveProgress(true);
      if (savedFile) {
        console.log(`\n✅ Progress saved successfully!`);
        console.log(`📁 Latest save: ${path.resolve(savedFile)}`);
        if (lastSavedFilename) {
          console.log(`📁 Also check: ${path.resolve(lastSavedFilename)}`);
        }
      } else {
        console.error('\n❌ CRITICAL: Failed to save progress!');
        console.error('   Trying emergency save...');
        // Emergency save attempt
        try {
          const emergencyFilename = excelFilename.replace('.xlsx', '_EMERGENCY_SAVE.xlsx');
          const newWorksheet = xlsx.utils.json_to_sheet(data);
          const newWorkbook = xlsx.utils.book_new();
          xlsx.utils.book_append_sheet(newWorkbook, newWorksheet, workbook.SheetNames[0]);
          xlsx.writeFile(newWorkbook, emergencyFilename);
          console.log(`✅ Emergency save successful: ${emergencyFilename}`);
        } catch (e) {
          console.error(`❌ Emergency save also failed: ${e.message}`);
        }
      }
    } catch (error) {
      console.error(`\n❌ Error saving progress: ${error.message}`);
      // Try one more time with emergency save
      try {
        const emergencyFilename = excelFilename.replace('.xlsx', '_EMERGENCY_SAVE.xlsx');
        const newWorksheet = xlsx.utils.json_to_sheet(data);
        const newWorkbook = xlsx.utils.book_new();
        xlsx.utils.book_append_sheet(newWorkbook, newWorksheet, workbook.SheetNames[0]);
        xlsx.writeFile(newWorkbook, emergencyFilename);
        console.log(`✅ Emergency save successful: ${emergencyFilename}`);
      } catch (e) {
        console.error(`❌ Emergency save failed: ${e.message}`);
      }
    }
    
    // Close browsers
    try {
      if (browser) {
        await browser.close();
        console.log('🌐 Browser closed');
      }
    } catch (e) {
      console.error('Error closing browser:', e.message);
    }
    
    console.log(`\n📊 Progress Summary:`);
    console.log(`   Processed: ${updatedCount + skippedCount} businesses`);
    console.log(`   Contact persons found: ${foundCount}`);
    console.log(`   Not found: ${notFoundCount}`);
    console.log(`   Skipped: ${skippedCount}`);
    console.log('\n👋 Exiting...\n');
    
    // Give it a moment to finish writing
    setTimeout(() => {
      process.exit(0);
    }, 500);
  };
  
  // Register shutdown handlers
  process.on('SIGINT', () => {
    shutdownHandler('SIGINT').catch(err => {
      console.error('Shutdown error:', err);
      process.exit(1);
    });
  });
  process.on('SIGTERM', () => {
    shutdownHandler('SIGTERM').catch(err => {
      console.error('Shutdown error:', err);
      process.exit(1);
    });
  });
  
  // Apply test limit if set
  const businessesToProcess = TEST_LIMIT ? data.slice(0, TEST_LIMIT) : data;
  if (TEST_LIMIT) {
    console.log(`🧪 TESTING MODE: Processing only first ${TEST_LIMIT} businesses\n`);
  }
  
  // START_FROM_INDEX: Set to skip already processed businesses (0 = start from beginning)
  const START_FROM_INDEX = 0; // Change this to resume from a specific point
  
  if (START_FROM_INDEX > 0) {
    console.log(`⏭️  Skipping first ${START_FROM_INDEX} businesses, starting at #${START_FROM_INDEX + 1}\n`);
    skippedCount = START_FROM_INDEX;
  }
  
  // ========== HORIZONTAL: Phase 1 = all Tier 1 (Proff only), Phase 2 = Tier 2/3 (Google only) ==========
  console.log('\n' + '='.repeat(60));
  console.log('📌 PHASE 1: Tier 1 only (Proff.no)');
  console.log('='.repeat(60) + '\n');

  for (const [index, business] of businessesToProcess.entries()) {
    if (index < START_FROM_INDEX) continue;
    if (shouldStop) break;
    const businessName = business.Name || business.name || 'Unknown';
    const excelAddress = (business.Address || business.address || '') !== 'Not found' ? String(business.Address || business.address || '').trim() : '';
    console.log(`\n[${index + 1}/${businessesToProcess.length}] 🔍 Phase 1 (Proff): ${businessName}`);
    try {
      const result1 = excelAddress ? await step1ProffDirectSearch(businessName, excelAddress, page) : null;
      if (result1) {
        const result = formatProffResult(result1);
        business['Contact Person'] = result.contactPerson;
        business['Business Phone'] = result.businessPhone;
        business['Selskapsform'] = result.selskapsform;
        business['Antall Ansatte'] = result.antallAnsatte;
        business['Tier'] = result.tier != null ? result.tier : '';
        const dataIndex = data.findIndex(b => (b.Name || b.name) === businessName);
        if (dataIndex !== -1) {
          data[dataIndex]['Contact Person'] = result.contactPerson;
          data[dataIndex]['Business Phone'] = result.businessPhone;
          data[dataIndex]['Selskapsform'] = result.selskapsform;
          data[dataIndex]['Antall Ansatte'] = result.antallAnsatte;
          data[dataIndex]['Tier'] = result.tier != null ? result.tier : '';
        }
        foundCount++;
        updatedCount++;
        console.log(`  ✅ Tier 1`);
      } else {
        business['Contact Person'] = 'Not found';
        business['Business Phone'] = 'Not found';
        business['Selskapsform'] = 'Not found';
        business['Antall Ansatte'] = 'Not found';
        business['Tier'] = '';
        const dataIndex = data.findIndex(b => (b.Name || b.name) === businessName);
        if (dataIndex !== -1) {
          data[dataIndex]['Contact Person'] = 'Not found';
          data[dataIndex]['Business Phone'] = 'Not found';
          data[dataIndex]['Selskapsform'] = 'Not found';
          data[dataIndex]['Antall Ansatte'] = 'Not found';
          data[dataIndex]['Tier'] = '';
        }
        notFoundCount++;
        updatedCount++;
      }
      await saveProgress();
      processedSinceRestart++;
      if (processedSinceRestart >= BROWSER_RESTART_INTERVAL && index < businessesToProcess.length - 1 && !shouldStop) {
        console.log(`\n🔄 Restarting browser...`);
        try { await browser.close(); } catch (e) {}
        const newSession = await launchBrowser();
        browser = newSession.browser;
        page = newSession.page;
        processedSinceRestart = 0;
      }
      if (index < businessesToProcess.length - 1 && !shouldStop) {
        const delay = result1 ? 300 + Math.random() * 150 : 150 + Math.random() * 100;
        await new Promise(r => setTimeout(r, delay));
      }
    } catch (e) {
      console.error(`  ❌ Phase 1: ${e.message}`);
      if (e.name === 'ProtocolError' || (e.message && e.message.includes('timed out'))) {
        console.log('  🔄 Restarting browser after protocol/timeout error...');
        try {
          await browser.close();
        } catch (closeErr) {}
        const newSession = await launchBrowser();
        browser = newSession.browser;
        page = newSession.page;
        processedSinceRestart = 0;
      }
      business['Contact Person'] = 'Not found';
      business['Business Phone'] = 'Not found';
      business['Selskapsform'] = 'Not found';
      business['Antall Ansatte'] = 'Not found';
      business['Tier'] = '';
      updatedCount++;
      notFoundCount++;
    }
  }

  const phase2List = businessesToProcess.filter(b => (b['Tier'] !== 1 && b['Tier'] !== '1') && (b.Address || b.address));
  console.log('\n' + '='.repeat(60));
  console.log(`📌 PHASE 2: Tier 2/3 (Google) – ${phase2List.length} businesses`);
  console.log('='.repeat(60));
  console.log('ℹ️  Phase 2 uses the same browser/page as Phase 1 (no new tab).\n');

  for (const [index, business] of businessesToProcess.entries()) {
    if (shouldStop) break;
    if (business['Tier'] === 1 || business['Tier'] === '1') continue;
    const businessName = business.Name || business.name || 'Unknown';
    const excelAddress = (business.Address || business.address || '') !== 'Not found' ? String(business.Address || business.address || '').trim() : '';
    if (!excelAddress) continue;
    console.log(`\n[${index + 1}/${businessesToProcess.length}] 🔍 Phase 2 (Google): ${businessName}`);
    try {
      const result2 = await step2BingSearch(businessName, excelAddress, page);
      if (result2) {
        const result = formatProffResult(result2);
        business['Contact Person'] = result.contactPerson;
        business['Business Phone'] = result.businessPhone;
        business['Selskapsform'] = result.selskapsform;
        business['Antall Ansatte'] = result.antallAnsatte;
        business['Tier'] = result.tier != null ? result.tier : '';
        const dataIndex = data.findIndex(b => (b.Name || b.name) === businessName);
        if (dataIndex !== -1) {
          data[dataIndex]['Contact Person'] = result.contactPerson;
          data[dataIndex]['Business Phone'] = result.businessPhone;
          data[dataIndex]['Selskapsform'] = result.selskapsform;
          data[dataIndex]['Antall Ansatte'] = result.antallAnsatte;
          data[dataIndex]['Tier'] = result.tier != null ? result.tier : '';
        }
        foundCount++;
        console.log(`  ✅ Tier ${result.tier}`);
      }
      await saveProgress();
      processedSinceRestart++;
      if (processedSinceRestart >= BROWSER_RESTART_INTERVAL && index < businessesToProcess.length - 1 && !shouldStop) {
        console.log(`\n🔄 Restarting browser (Phase 2)...`);
        try { await browser.close(); } catch (e) {}
        const newSession = await launchBrowser();
        browser = newSession.browser;
        page = newSession.page;
        processedSinceRestart = 0;
      }
      await new Promise(r => setTimeout(r, Math.random() * 1000 + 2000));
    } catch (e) {
      console.error(`  ❌ Phase 2: ${e.message}`);
    }
  }
  
  // Final save before closing
  if (!shouldStop) {
    console.log('\n💾 Saving final progress...');
    await saveProgress();
  }
  
  console.log('\n🌐 Closing browser...');
  if (browser && !shouldStop) {
    await browser.close();
  }
  
  // ============================================
  // QUALITY FILTERING - Remove low-quality leads
  // ============================================
  console.log('\n' + '='.repeat(60));
  console.log('🔍 APPLYING QUALITY FILTERS');
  console.log('='.repeat(60));
  
  const beforeFilterCount = data.length;
  let filteredOutENK = 0;
  let filteredOutPhone = 0;
  
  // Filter 1: Remove ENK (Enkeltpersonforetak) only - all other company types are OK
  console.log('\n📋 Filter 1: Checking Selskapsform (company type)...');
  console.log('   Rule: Remove ONLY Enkeltpersonforetak (ENK) - all other types are accepted');
  const afterENKFilter = data.filter(business => {
    const selskapsform = (business['Selskapsform'] || '').toUpperCase().trim();
    
    // Check for ENK variations (Enkeltpersonforetak)
    const isENK = selskapsform === 'ENK' || 
                  selskapsform.includes('ENKELTPERSON') || 
                  selskapsform.includes('ENKELTMANNS') ||
                  selskapsform.includes('ENKELTFORETAK');
    
    if (isENK) {
      console.log(`  ❌ Removing "${business.Name || business.name}" - Selskapsform: ${business['Selskapsform']} (Enkeltpersonforetak)`);
      filteredOutENK++;
      return false;
    }
    
    // Keep all other company types (AS, ANS, DA, NUF, SA, ASA, Stiftelse, etc.)
    return true;
  });
  
  console.log(`  ✅ Kept ${afterENKFilter.length} businesses (removed ${filteredOutENK} Enkeltpersonforetak)`);
  
  // Filter 2: Remove businesses with no phone numbers
  console.log('\n📋 Filter 2: Checking phone availability...');
  const afterPhoneFilter = afterENKFilter.filter(business => {
    const googlePhone = (business['Phone'] || '').trim();
    const businessPhone = (business['Business Phone'] || '').trim();
    
    // Check if at least one phone is valid (not empty and not "Not found")
    const hasGooglePhone = googlePhone && googlePhone !== 'Not found' && googlePhone.length >= 8;
    const hasBusinessPhone = businessPhone && businessPhone !== 'Not found' && businessPhone.length >= 8;
    
    if (hasGooglePhone || hasBusinessPhone) {
      // Add a helper column to indicate phone status
      business['Has Valid Phone'] = true;
      return true;
    }
    
    console.log(`  ❌ Removing "${business.Name || business.name}" - No valid phone numbers found`);
    business['Has Valid Phone'] = false;
    filteredOutPhone++;
    return false;
  });
  
  console.log(`  ✅ Kept ${afterPhoneFilter.length} businesses (removed ${filteredOutPhone} with no phones)`);
  
  // Update data array with filtered results
  const filteredData = afterPhoneFilter;
  const totalFiltered = beforeFilterCount - filteredData.length;
  
  console.log('\n' + '-'.repeat(60));
  console.log(`📊 FILTERING SUMMARY:`);
  console.log(`   Before filtering: ${beforeFilterCount} businesses`);
  console.log(`   After filtering: ${filteredData.length} businesses`);
  console.log(`   Removed (Enkeltpersonforetak): ${filteredOutENK}`);
  console.log(`   Removed (no phone): ${filteredOutPhone}`);
  console.log(`   Total removed: ${totalFiltered}`);
  console.log('='.repeat(60) + '\n');
  
  // Write updated data back to Excel
  console.log('\n💾 Writing FILTERED data to Excel file...');
  const newWorksheet = xlsx.utils.json_to_sheet(filteredData);
  const newWorkbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(newWorkbook, newWorksheet, workbook.SheetNames[0]);
  
  // Also preserve the "scraper analyzing" sheet if it exists
  if (workbook.SheetNames.length > 1) {
    const analysisSheet = workbook.Sheets[workbook.SheetNames[1]];
    xlsx.utils.book_append_sheet(newWorkbook, analysisSheet, workbook.SheetNames[1]);
  }
  
  try {
    xlsx.writeFile(newWorkbook, excelFilename);
    console.log(`✅ Excel file "${excelFilename}" has been updated successfully.`);
  } catch (error) {
    if (error.code === 'EBUSY') {
      console.log('⚠️  File is locked, trying with a different name...');
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const altFilename = excelFilename.replace('.xlsx', `_expanded_${timestamp}.xlsx`);
      xlsx.writeFile(newWorkbook, altFilename);
      console.log(`✅ Excel file "${altFilename}" has been created successfully.`);
    } else {
      throw error;
    }
  }
  
  // Update the original data array with processed results
  if (TEST_LIMIT) {
    // Copy results back to original data array
    businessesToProcess.forEach((processed, idx) => {
      const originalIdx = data.findIndex(b => (b.Name || b.name) === (processed.Name || processed.name));
      if (originalIdx !== -1) {
        data[originalIdx] = processed;
      }
    });
  }
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 EXPANSION & FILTERING SUMMARY');
  console.log('='.repeat(60));
  if (TEST_LIMIT) {
    console.log(`🧪 TESTING MODE: Processed ${businessesToProcess.length} of ${beforeFilterCount} businesses`);
  } else {
    console.log(`Total businesses processed: ${beforeFilterCount}`);
  }
  console.log(`Proff.no enrichment:`);
  console.log(`  - Updated: ${updatedCount}`);
  console.log(`  - Contact persons found: ${foundCount}`);
  console.log(`  - Not found: ${notFoundCount}`);
  console.log(`  - Skipped: ${skippedCount}`);
  console.log(`Quality filtering:`);
  console.log(`  - Removed (Enkeltpersonforetak): ${filteredOutENK}`);
  console.log(`  - Removed (no phone numbers): ${filteredOutPhone}`);
  console.log(`  - Total removed: ${totalFiltered}`);
  console.log(`\n✅ FINAL QUALITY LEADS: ${filteredData.length}`);
  console.log('='.repeat(60) + '\n');
}

// Main execution
const excelFile = process.argv[2]; // Get filename from command line argument if provided

console.log('🚀 Starting Excel expansion with contact person information...\n');
expandExcelWithContactPersons(excelFile)
  .then(() => {
    console.log('✅ Expansion completed successfully!');
  })
  .catch((error) => {
    console.error('❌ Expansion failed with error:', error);
    process.exit(1);
  });



