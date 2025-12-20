const puppeteer = require('puppeteer');
const xlsx = require('xlsx'); // Import the xlsx library to handle Excel files
const fs = require('fs'); // Import fs to read the industries file
const path = require('path'); // Import path for file operations
const readline = require('readline'); // Import readline for user input

// TESTING MODE: Set to number of businesses to process, or null/undefined to process all
// Example: const TEST_LIMIT = 10;  // Process only first 10 businesses
//          const TEST_LIMIT = null; // Process all businesses
const TEST_LIMIT = 20; // Set to a number (e.g., 10) to limit processing, or null to process all

// PROXY CONFIGURATION
// Option 1: Use proxy list file (proxies.txt - one proxy per line, format: ip:port or ip:port:user:pass)
// Option 2: Use proxy service API (Bright Data, Oxylabs, etc.)
// Option 3: Leave empty to use no proxy (not recommended for heavy scraping)
const USE_PROXIES = false; // Set to true to enable proxy rotation (DISABLED - no free solution available)
const PROXY_FILE = 'proxies.txt'; // Path to proxy list file
const PROXY_ROTATION_INTERVAL = 50; // Rotate proxy every N businesses
const SESSION_ROTATION_INTERVAL = 100; // Create new browser session every N businesses

// DELAY CONFIGURATION (in milliseconds)
// Balanced delays - fast enough but still safe
const MIN_DELAY_BETWEEN_REQUESTS = 2000; // Minimum delay between requests (2 seconds)
const MAX_DELAY_BETWEEN_REQUESTS = 5000; // Maximum delay between requests (5 seconds)
const MIN_DELAY_BETWEEN_SCROLLS = 3000; // Minimum delay between scrolls (3 seconds)
const MAX_DELAY_BETWEEN_SCROLLS = 6000; // Maximum delay between scrolls (6 seconds)
const MIN_DELAY_BETWEEN_INDUSTRIES = 3000; // Minimum delay between industries (3 seconds)
const MAX_DELAY_BETWEEN_INDUSTRIES = 3000; // Maximum delay between industries (3 seconds)

// Helper function to get random delay
function getRandomDelay(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Helper function to save debugging information
async function saveDebugInfo(page, errorType, context = {}) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const debugDir = path.join(__dirname, 'error handeling log');
  
  // Create debug directory if it doesn't exist
  if (!fs.existsSync(debugDir)) {
    fs.mkdirSync(debugDir, { recursive: true });
  }
  
  const debugPrefix = `${errorType}_${timestamp}`;
  
  try {
    // Take screenshot
    const screenshotPath = path.join(debugDir, `${debugPrefix}_screenshot.png`);
    await page.screenshot({ 
      path: screenshotPath, 
      fullPage: true 
    }).catch(() => {
      // If full page fails, try viewport
      return page.screenshot({ path: screenshotPath });
    });
    console.log(`  📸 Screenshot saved: ${screenshotPath}`);
    
    // Save page HTML
    const htmlPath = path.join(debugDir, `${debugPrefix}_page.html`);
    const html = await page.content().catch(() => 'Could not retrieve HTML');
    fs.writeFileSync(htmlPath, html);
    console.log(`  📄 HTML saved: ${htmlPath}`);
    
    // Save page state info
    const pageInfo = await page.evaluate(() => {
      return {
        url: window.location.href,
        title: document.title,
        bodyText: document.body.innerText.substring(0, 5000), // First 5000 chars
        hasResults: document.querySelector('a[href*="/maps/place/"]') !== null,
        hasBlocked: document.body.innerText.includes('unusual traffic') || 
                   document.body.innerText.includes('automated queries') ||
                   document.body.innerText.includes('sorry'),
        hasCrash: document.body.innerText.includes('Aw, Snap!') ||
                 document.body.innerText.includes('Out of Memory'),
        visibleText: document.body.innerText.substring(0, 2000)
      };
    }).catch(() => ({
      url: page.url(),
      title: 'Could not retrieve',
      error: 'Page evaluation failed'
    }));
    
    // Save debug JSON
    const debugInfo = {
      timestamp: new Date().toISOString(),
      errorType: errorType,
      context: context,
      pageInfo: pageInfo,
      userAgent: await page.evaluate(() => navigator.userAgent).catch(() => 'Unknown')
    };
    
    const jsonPath = path.join(debugDir, `${debugPrefix}_debug.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(debugInfo, null, 2));
    console.log(`  📋 Debug info saved: ${jsonPath}`);
    
    return {
      screenshot: screenshotPath,
      html: htmlPath,
      debug: jsonPath
    };
  } catch (error) {
    console.log(`  ⚠️  Error saving debug info: ${error.message}`);
    return null;
  }
}

// Helper function to simulate human-like mouse movement
async function simulateHumanBehavior(page) {
  // Random mouse movements
  const movements = Math.floor(Math.random() * 3) + 1;
  for (let i = 0; i < movements; i++) {
    await page.mouse.move(
      Math.random() * 1920,
      Math.random() * 1080,
      { steps: Math.floor(Math.random() * 10) + 5 }
    );
    await new Promise(resolve => setTimeout(resolve, Math.random() * 500 + 200));
  }
  
  // Random scroll
  if (Math.random() > 0.7) {
    await page.evaluate(() => {
      window.scrollBy(0, Math.random() * 200 - 100);
    });
    await new Promise(resolve => setTimeout(resolve, Math.random() * 300 + 100));
  }
}

// Load proxies from file
function loadProxies() {
  if (!USE_PROXIES || !fs.existsSync(PROXY_FILE)) {
    return [];
  }
  
  try {
    const proxyContent = fs.readFileSync(PROXY_FILE, 'utf-8');
    const proxies = proxyContent
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'));
    
    console.log(`📡 Loaded ${proxies.length} proxies from ${PROXY_FILE}`);
    return proxies;
  } catch (error) {
    console.error(`⚠️  Error loading proxies: ${error.message}`);
    return [];
  }
}

// Get random proxy
function getRandomProxy(proxies) {
  if (!proxies || proxies.length === 0) return null;
  return proxies[Math.floor(Math.random() * proxies.length)];
}

// Format proxy for Puppeteer
function formatProxy(proxyString) {
  if (!proxyString) return null;
  
  // Format: ip:port or ip:port:user:pass
  const parts = proxyString.split(':');
  if (parts.length === 2) {
    return `http://${parts[0]}:${parts[1]}`;
  } else if (parts.length === 4) {
    return `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`;
  }
  return null;
}

// Function to check if a website is a real business website (not platform/social media)
function isRealBusinessWebsite(url, businessName) {
  if (!url || url === 'Not found') {
    return false; // No website = not a real business website
  }

  // List of domains that are NOT real business websites (social media, delivery platforms, etc.)
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
    'gastroplanner.no'
  ];

  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname.toLowerCase();
    
    // Check if the domain is in the non-business list
    for (const nonBusinessDomain of nonBusinessDomains) {
      if (domain.includes(nonBusinessDomain)) {
        return false; // This is NOT a real business website
      }
    }
    
    // If it's not a non-business domain and has a proper domain structure, it's likely a real business website
    if (domain.includes('.') && !domain.includes('google') && !domain.includes('facebook') && !domain.includes('instagram')) {
      // Check if it's a proper domain (not just a subdomain of a platform)
      const domainParts = domain.split('.');
      if (domainParts.length >= 2) {
        // Handle www. domains by removing www. prefix
        let mainDomain;
        if (domainParts[0] === 'www' && domainParts.length >= 3) {
          mainDomain = domainParts[domainParts.length - 2] + '.' + domainParts[domainParts.length - 1];
        } else {
          mainDomain = domainParts[domainParts.length - 2] + '.' + domainParts[domainParts.length - 1];
        }
        
        // If it's not a known platform domain, it's likely a real business website
        const isKnownPlatform = nonBusinessDomains.some(platform => mainDomain.includes(platform));
        if (!isKnownPlatform) {
          return true; // This is a real business website
        }
      }
    }
    
    return false; // Default to not a real business website
  } catch (error) {
    return false; // If URL parsing fails, not a real business website
  }
}

// Function to clean website URL - empty non-business links, keep real business websites
function cleanWebsiteUrl(url, businessName) {
  if (!url || url === 'Not found') {
    return ''; // No website = empty field
  }

  // If it's a real business website, keep it
  if (isRealBusinessWebsite(url, businessName)) {
    return url;
  }
  
  // Otherwise, empty the field (it's a platform/social media link)
  return '';
}

// Function to read industries from the text file
function readIndustriesFromFile() {
  try {
    const filePath = path.join(__dirname, 'list of industries.txt');
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const industries = fileContent
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0); // Remove empty lines
    return industries;
  } catch (error) {
    console.error('Error reading industries file:', error.message);
    // Fallback to default if file can't be read
    return ['restaurant'];
  }
}

// Function to create browser with proxy and anti-detection
async function createBrowser(proxy = null, industryIndex = 0) {
  const browserArgs = [
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
    '--window-size=1280,720',
    '--disable-web-security',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-site-isolation-trials',
    '--max-old-space-size=4096', // Limit memory usage
    '--js-flags=--expose-gc', // Enable garbage collection
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows'
  ];
  
  // Add proxy if provided
  if (proxy) {
    browserArgs.push(`--proxy-server=${proxy}`);
    console.log(`🌐 Using proxy: ${proxy.replace(/\/\/.*@/, '//***@')}`);
  }
  
  const browser = await puppeteer.launch({ 
    headless: false,
    args: browserArgs,
    ignoreHTTPSErrors: true,
    defaultViewport: null,
    protocolTimeout: 300000 // 5 minute timeout
  });
  
  // Enable garbage collection in browser context
  const pages = await browser.pages();
  if (pages.length > 0) {
    await pages[0].evaluateOnNewDocument(() => {
      // Expose GC if available
      if (typeof gc !== 'undefined') {
        window.gc = gc;
      }
    });
  }
  
  return browser;
}

// Helper function to setup page with anti-detection
async function setupPageAntiDetection(page) {
  // Set realistic viewport (smaller window)
  await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
  
  // Set modern user agent (Chrome 120 - more recent)
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
  
  // Hide automation indicators - comprehensive anti-detection
  await page.evaluateOnNewDocument(() => {
    // Remove webdriver property
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
    
    // Override permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );
    
    // Override plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
    
    // Override languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en', 'no'],
    });
    
    // Chrome runtime
    window.chrome = {
      runtime: {},
    };
  });

  // Set multiple consent cookies with updated values
  await page.setCookie(
    {
      name: 'CONSENT',
      value: 'YES+cb.20241219-17-0.en+FX+667',
      domain: '.google.com',
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60 // 1 year
    },
    {
      name: 'CONSENT',
      value: 'YES+cb.20241219-17-0.en+FX+667',
      domain: '.google.no',
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60
    }
  );
}

// Helper function to handle consent
async function handleConsent(page, url) {
  console.log('Navigating to main URL...');
  
  // Try to navigate, handling consent redirects
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  } catch (e) {
    console.log('Initial navigation timeout, continuing...');
  }
  
  // Wait for page to load
  await new Promise(resolve => setTimeout(resolve, 4000));
  
  // Handle Google consent page if it appears (including /ml consent pages)
  let currentUrl = page.url();
  let consentAttempts = 0;
  const maxConsentAttempts = 3;
  
  while ((currentUrl.includes('consent.google.com') || currentUrl.includes('/consent') || currentUrl.includes('consent')) && consentAttempts < maxConsentAttempts) {
    console.log(`Consent page detected (attempt ${consentAttempts + 1}/${maxConsentAttempts}): ${currentUrl}`);
    consentAttempts++;
    
    try {
      // Wait for page to fully load
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Try multiple methods to find and click accept button
      const clicked = await page.evaluate(() => {
        // Method 1: Find by text content (most reliable)
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
        
        // Method 2: Try common Google consent button IDs and classes
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
          if (btn && btn.offsetParent !== null) { // Check if visible
            btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(() => btn.click(), 100);
            return true;
          }
        }
        
        // Method 3: Try to find form submit button
        const forms = document.querySelectorAll('form');
        for (const form of forms) {
          const submitBtn = form.querySelector('button[type="submit"], input[type="submit"]');
          if (submitBtn) {
            submitBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
            setTimeout(() => submitBtn.click(), 100);
            return true;
          }
        }
        
        return false;
      });
      
      if (clicked) {
        console.log('✅ Clicked accept button, waiting for redirect...');
        await new Promise(resolve => setTimeout(resolve, 4000));
        
        // Check if we were redirected
        try {
          await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 10000 }).catch(() => {});
        } catch (e) {}
      } else {
        console.log('⚠️  Could not find accept button automatically');
        // Try to extract continue URL and navigate directly
        const continueUrl = await page.evaluate(() => {
          const continueLink = document.querySelector('a[href*="continue="]');
          if (continueLink) {
            const href = continueLink.getAttribute('href');
            const match = href.match(/continue=([^&]+)/);
            if (match) {
              return decodeURIComponent(match[1]);
            }
          }
          // Try to get from URL params
          const urlParams = new URLSearchParams(window.location.search);
          return urlParams.get('continue');
        });
        
        if (continueUrl) {
          console.log(`🔄 Found continue URL, navigating directly...`);
          await page.goto(continueUrl, { waitUntil: 'networkidle2', timeout: 30000 });
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }
      
      // Check current URL
      currentUrl = page.url();
      
      if (!currentUrl.includes('consent.google.com') && !currentUrl.includes('/consent') && !currentUrl.includes('consent')) {
        console.log('✅ Successfully passed consent screen!');
        break;
      }
      
      if (consentAttempts >= maxConsentAttempts) {
        console.log('\n⚠️  Could not bypass consent after multiple attempts.');
        console.log('   Please manually accept the consent in the browser, then press Enter to continue...');
        await new Promise(resolve => {
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
          });
          rl.question('Press Enter after you have accepted the consent...', () => {
            rl.close();
            resolve();
          });
        });
        await new Promise(resolve => setTimeout(resolve, 2000));
        currentUrl = page.url();
        break;
      }
    } catch (error) {
      console.log(`Error handling consent (attempt ${consentAttempts}): ${error.message}`);
    }
  }
  
  // Final check - if still on consent page, try extracting continue URL
  currentUrl = page.url();
  if (currentUrl.includes('consent.google.com') || currentUrl.includes('/consent') || currentUrl.includes('consent')) {
    console.log('⚠️  Still on consent page, trying to extract and navigate to continue URL...');
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
      console.log('Could not extract continue URL');
    }
  }
}

async function scrapeGoogleMaps(industry, industryIndex = 0, proxies = [], browserInstance = null, pageInstance = null) {
  const industryStartTime = Date.now(); // Track start time for this industry
  
  // Create URL with the specified industry
  const industryEncoded = encodeURIComponent(industry);
  const url = `https://www.google.com/maps/search/${industryEncoded}/@63.4250829,10.4155537,12z?hl=no&gl=no`; // Norwegian language and region for Trondheim

  // Use existing browser/page or create new ones
  let browser = browserInstance;
  let page = pageInstance;
  let shouldCloseBrowser = false;
  
  if (!browser || !page) {
    // No browser exists, create new one
    console.log(`🚀 Launching browser for industry: ${industry}...`);
    const proxy = USE_PROXIES ? formatProxy(getRandomProxy(proxies)) : null;
    browser = await createBrowser(proxy, industryIndex);
    page = await browser.newPage();
    await setupPageAntiDetection(page);
    await handleConsent(page, url);
    
    // Verify we're on Google Maps search page after consent
    console.log('📍 Verifying we\'re on Google Maps search page...');
    let currentUrl = page.url();
    let retryCount = 0;
    while ((!currentUrl.includes('google.com/maps/search') && !currentUrl.includes('google.com/maps')) && retryCount < 3) {
      console.log(`⚠️  Not on Google Maps (${currentUrl}), navigating to search URL... (attempt ${retryCount + 1})`);
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(resolve => setTimeout(resolve, 3000));
        currentUrl = page.url();
      } catch (e) {
        console.log(`⚠️  Navigation error: ${e.message}`);
        retryCount++;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    shouldCloseBrowser = false; // Don't close, keep for next industry
  } else {
    // Browser exists, just navigate to new industry URL (keep browser open)
    console.log(`🔄 Browser already open, navigating to new industry: ${industry}...`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await handleConsent(page, url); // Handle consent if needed
    await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for page to load
  }
  
  // Wait for page to be fully loaded and results to be visible
  console.log('⏳ Waiting for results to load...');
  await new Promise(resolve => setTimeout(resolve, 3000));
  
  // Verify results are visible
  const hasResults = await page.evaluate(() => {
    return document.querySelector('[role="main"]') !== null || 
           document.querySelector('.m6QErb') !== null ||
           document.querySelector('a[href*="/maps/place/"]') !== null ||
           document.querySelector('[jsaction*="pane"]') !== null;
  });
  
  if (hasResults) {
    console.log('✅ Results panel found, ready to scroll');
  } else {
    console.log('⚠️  Results not immediately visible, will try scrolling anyway...');
    
    // Check if we're blocked
    const isBlocked = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';
      return bodyText.includes('unusual traffic') || 
             bodyText.includes('automated queries') ||
             bodyText.includes('sorry') ||
             bodyText.includes('blocked');
    }).catch(() => false);
    
    if (isBlocked) {
      console.log('  🚫 Google blocking detected!');
      await saveDebugInfo(page, 'google_blocked_industry_start', {
        industry: industry,
        url: page.url()
      });
      throw new Error(`Google blocking detected for industry: ${industry}`);
    }
  }

  console.log('Scrolling to load more results...');
  // In test mode, reduce scroll attempts to 4 for faster testing
  const maxPageDowns = TEST_LIMIT ? 4 : 40; // Test mode: 4 scrolls, Normal: 40 scrolls for 200+ results
  let pageDownAttempts = 0;

  // Collect all business URLs during scrolling
  const allBusinessUrls = new Set();
  
  // More comprehensive scrolling to get more results
  try {
    let previousUrlCount = 0;
    let noNewResultsCount = 0;
    
    while (pageDownAttempts < maxPageDowns) {
      console.log(`Scroll attempt ${pageDownAttempts + 1}/${maxPageDowns}...`);
      
      // Shorter delay before scrolling (faster)
      const randomDelay = getRandomDelay(MIN_DELAY_BETWEEN_SCROLLS, MAX_DELAY_BETWEEN_SCROLLS);
      console.log(`  ⏳ Waiting ${Math.round(randomDelay/1000)}s before scroll...`);
      await new Promise(resolve => setTimeout(resolve, randomDelay));
      
      // Use mouse wheel scrolling (more reliable than panel scrolling)
      console.log('  🖱️  Using mouse wheel to scroll...');
      
      // Find the results panel to scroll over it
      const panelInfo = await page.evaluate(() => {
        const selectors = [
          '[role="main"]',
          '.m6QErb',
          '[aria-label*="Results"]',
          '.siAUzd',
          '[jsaction*="pane"]',
          'div[role="feed"]'
        ];
        
        for (const selector of selectors) {
          const panel = document.querySelector(selector);
          if (panel) {
            const rect = panel.getBoundingClientRect();
            return {
              found: true,
              selector: selector,
              x: rect.left + rect.width / 2,
              y: rect.top + rect.height / 2,
              width: rect.width,
              height: rect.height
            };
          }
        }
        return { found: false };
      });
      
      if (panelInfo.found) {
        console.log(`  ✅ Found panel: ${panelInfo.selector} at (${Math.round(panelInfo.x)}, ${Math.round(panelInfo.y)})`);
        
        // Move mouse to center of panel
        await page.mouse.move(panelInfo.x, panelInfo.y);
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Scroll down using mouse wheel (reduced to avoid triggering too many reloads)
        const scrollAmount = 3; // Number of wheel scrolls (reduced from 5 to avoid suspicion)
        for (let i = 0; i < scrollAmount; i++) {
          await page.mouse.wheel({ deltaY: 500 }); // Scroll down
          await new Promise(resolve => setTimeout(resolve, 150)); // Slightly longer delay between scrolls
        }
        
        console.log(`  📜 Scrolled ${scrollAmount} times with mouse wheel`);
      } else {
        console.log('  ⚠️  Panel not found, using window scroll...');
        // Fallback: scroll window using mouse
        await page.mouse.move(640, 360); // Center of 1280x720 window
        await new Promise(resolve => setTimeout(resolve, 200));
        
        for (let i = 0; i < 3; i++) {
          await page.mouse.wheel({ deltaY: 500 });
          await new Promise(resolve => setTimeout(resolve, 150));
        }
      }
      
      // Also use keyboard scrolling as additional method
      await page.keyboard.press('PageDown');
      await new Promise(resolve => setTimeout(resolve, 300));
      await page.keyboard.press('PageDown');
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // Wait for content to load (shorter wait)
      const loadDelay = getRandomDelay(1500, 2500);
      await new Promise(resolve => setTimeout(resolve, loadDelay));
      
      // Collect business URLs from current page state
      try {
        const currentUrls = await page.evaluate(() => {
          const urls = [];
          
          // Try multiple selectors to find business links
          const linkSelectors = [
            'a[href*="/maps/place/"]',
            '[data-result-index] a[href*="/maps/place/"]',
            '[jsaction*="pane"] a[href*="/maps/place/"]',
            '.Nv2PK a[href*="/maps/place/"]',
            '.hfpxzc a[href*="/maps/place/"]',
            '.THOPZb a[href*="/maps/place/"]',
            '.lI9IFe a[href*="/maps/place/"]'
          ];
          
          linkSelectors.forEach(selector => {
            const links = document.querySelectorAll(selector);
            links.forEach(link => {
              const href = link.getAttribute('href');
              if (href && href.includes('/maps/place/')) {
                const fullUrl = href.startsWith('http') ? href : `https://www.google.com${href}`;
                if (!urls.includes(fullUrl)) {
                  urls.push(fullUrl);
                }
              }
            });
          });
          
          return urls;
        });
        
        // Add new URLs to our collection
        const newUrls = currentUrls.filter(url => !allBusinessUrls.has(url));
        newUrls.forEach(url => allBusinessUrls.add(url));
        
        console.log(`  Found ${currentUrls.length} total URLs, ${newUrls.length} new URLs, total collected: ${allBusinessUrls.size}`);
        
        // Check if we're getting new results
        if (allBusinessUrls.size === previousUrlCount) {
          noNewResultsCount++;
          console.log(`  No new results this scroll (${noNewResultsCount}/3)`);
          
          // If we haven't gotten new results for 3 consecutive scrolls, stop trying
          if (noNewResultsCount >= 3) {
            console.log('  ⚠️  No new results for 3 attempts, stopping early...');
            
            // Save debug info before stopping (could be Google blocking or end of results)
            console.log('  📸 Taking screenshot and saving debug info...');
            await saveDebugInfo(page, 'no_more_results', {
              industry: industry,
              scrollAttempt: pageDownAttempts,
              totalUrlsFound: allBusinessUrls.size,
              lastUrlCount: previousUrlCount
            });
            
            break; // Exit the while loop early
          }
          
          // If we haven't gotten new results for 2 consecutive scrolls, try scrolling more aggressively
          if (noNewResultsCount === 2) {
            console.log('  No new results, trying more aggressive scrolling...');
            // Try multiple Page Down presses to scroll further
            await page.keyboard.press('PageDown');
            await new Promise(resolve => setTimeout(resolve, 500));
            await page.keyboard.press('PageDown');
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        } else {
          noNewResultsCount = 0; // Reset counter if we got new results
          console.log(`  ✅ Got ${newUrls.length} new results!`);
        }
        
        previousUrlCount = allBusinessUrls.size;
        
        // Continue scrolling for all maxPageDowns attempts regardless of results
        console.log(`  Progress: ${pageDownAttempts + 1}/${maxPageDowns} scrolls completed`);
        
      } catch (e) {
        console.log('  Error collecting URLs:', e.message);
      }

      pageDownAttempts++;
    }
    console.log(`Finished scrolling. Total business URLs collected: ${allBusinessUrls.size}`);
    
    // Check if we got very few results (could indicate blocking)
    if (allBusinessUrls.size < 10 && maxPageDowns >= 20) {
      console.log('  ⚠️  Very few results collected, might be blocked. Saving debug info...');
      await saveDebugInfo(page, 'few_results_collected', {
        industry: industry,
        totalUrls: allBusinessUrls.size,
        scrollAttempts: pageDownAttempts
      });
    }
  } catch (error) {
    console.error('Error while scrolling:', error);
    console.log('  📸 Saving debug info for scrolling error...');
    await saveDebugInfo(page, 'scrolling_error', {
      industry: industry,
      error: error.message,
      scrollAttempt: pageDownAttempts
    }).catch(() => {});
  }

  // Convert collected URLs to results array
  const results = Array.from(allBusinessUrls).map(url => ({
    name: 'Business', // We'll get the actual name when we visit each URL
    url: url
  }));

  console.log(`Found ${results.length} business URLs to process`);
  if (results.length > 0) {
    console.log('Sample URLs:', results.slice(0, 3).map(r => r.url));
  }

  console.log(`Found ${results.length} results. Starting to scrape each result...`);

  // Apply test limit if set
  const businessesToProcess = TEST_LIMIT ? results.slice(0, TEST_LIMIT) : results;
  if (TEST_LIMIT) {
    console.log(`🧪 TESTING MODE: Processing only first ${TEST_LIMIT} businesses out of ${results.length} found\n`);
  }

  // Initialize an array to hold the data for the Excel file
  const excelData = [];

  for (const [index, result] of businessesToProcess.entries()) {
    // Periodic refresh every 25 businesses to prevent memory issues
    if (index > 0 && index % 25 === 0) {
      console.log(`\n🔄 Periodic refresh (every 25 businesses) - Business ${index + 1}...`);
      try {
        await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(resolve => setTimeout(resolve, 3000));
        console.log('  ✅ Page refreshed, memory cleared');
      } catch (e) {
        console.log(`  ⚠️  Refresh failed: ${e.message}`);
      }
    }
    
    console.log(`\nScraping details for business ${index + 1}/${businessesToProcess.length}`);
    try {
      // Check for crash/out of memory page before navigating
      const isCrashed = await page.evaluate(() => {
        const bodyText = document.body.innerText || '';
        const title = document.title || '';
        return bodyText.includes('Aw, Snap!') || 
               bodyText.includes('Out of Memory') ||
               bodyText.includes('Something went wrong') ||
               title.includes('Aw, Snap') ||
               document.querySelector('body')?.innerHTML.includes('Aw, Snap');
      }).catch(() => false);
      
      if (isCrashed) {
        console.log('  🚨 CRASH PAGE DETECTED! Refreshing...');
        try {
          await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
          await new Promise(resolve => setTimeout(resolve, 5000));
          console.log('  ✅ Page refreshed after crash detection');
        } catch (e) {
          console.log(`  ⚠️  Refresh failed, trying to recover: ${e.message}`);
          // Try to navigate back to search page
          try {
            await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
            await handleConsent(page, url);
          } catch (e2) {
            console.log(`  ❌ Recovery failed: ${e2.message}`);
          }
        }
      }
      
      // Navigate to business page with memory management
      try {
        // Force garbage collection before navigation
        await page.evaluate(() => {
          if (window.gc) {
            window.gc();
          }
        }).catch(() => {});
        
        // Use faster navigation to reduce memory usage
        await page.goto(result.url, { 
          waitUntil: 'domcontentloaded', 
          timeout: 10000,
          referer: url // Keep referer to stay in context
        });
        
        // Check if we landed on crash page after navigation
        const crashedAfterNav = await page.evaluate(() => {
          const bodyText = document.body.innerText || '';
          const title = document.title || '';
          return bodyText.includes('Aw, Snap!') || 
                 bodyText.includes('Out of Memory') ||
                 bodyText.includes('Something went wrong') ||
                 title.includes('Aw, Snap');
        }).catch(() => false);
        
        if (crashedAfterNav) {
          console.log('  🚨 Crash page detected after navigation! Refreshing...');
          await page.reload({ waitUntil: 'networkidle2', timeout: 30000 });
          await new Promise(resolve => setTimeout(resolve, 3000));
          // Try navigating again
          await page.goto(result.url, { waitUntil: 'domcontentloaded', timeout: 10000 });
        }
        
        // Immediately after navigation, clear any unnecessary resources
        await page.evaluate(() => {
          // Remove images and heavy resources to save memory
          const images = document.querySelectorAll('img');
          images.forEach(img => {
            if (img.src && !img.src.includes('data:')) {
              img.src = ''; // Clear image sources
            }
          });
        }).catch(() => {});
      } catch (e) {
        // If timeout, check if we're on a place page and need to go back
        const currentUrl = page.url();
        if (currentUrl.includes('/maps/place/') && !currentUrl.includes('/search/')) {
          console.log('  ⚠️  Redirected to place page, going back to search results...');
          await page.goBack({ waitUntil: 'domcontentloaded', timeout: 5000 });
          await new Promise(resolve => setTimeout(resolve, 2000));
          // Try navigating again
          await page.goto(result.url, { waitUntil: 'domcontentloaded', timeout: 8000 });
        }
      }
      
      // Check if we accidentally navigated to a place page instead of staying in search
      const currentUrl = page.url();
      if (currentUrl.includes('/maps/place/') && !currentUrl.includes('/search/')) {
        console.log('  ⚠️  On place page, extracting data from here instead...');
        // Continue with extraction from place page
      }

      // Extract business name from the page
      const businessName = await page.evaluate(() => {
        // Try multiple selectors to find the business name
        const nameSelectors = [
          'h1[data-attrid="title"]',
          '.x3AX1-LfntMc-header-title-title',
          '.SPZz6b h1',
          '.x3AX1-LfntMc-header-title',
          'h1',
          '.fontHeadlineLarge',
          '.fontDisplayLarge',
          '[data-attrid="title"]',
          '.section-hero-header-title',
          '.x3AX1-LfntMc-header-title-title',
          '.SPZz6b h1',
          '.x3AX1-LfntMc-header-title',
          '.fontHeadlineLarge',
          '.fontDisplayLarge',
          '[data-attrid="title"]',
          '.section-hero-header-title',
          'h1[data-attrid="title"]',
          '.x3AX1-LfntMc-header-title-title',
          '.SPZz6b h1',
          '.x3AX1-LfntMc-header-title',
          'h1',
          '.fontHeadlineLarge',
          '.fontDisplayLarge',
          '[data-attrid="title"]',
          '.section-hero-header-title'
        ];
        
        for (const selector of nameSelectors) {
          const element = document.querySelector(selector);
          if (element) {
            const name = element.textContent?.trim();
            if (name && name.length > 2 && !name.includes('Google Maps') && !name.includes('Directions')) {
              return name;
            }
          }
        }
        
        // Fallback: try to get from page title
        const title = document.title;
        if (title && !title.includes('Google Maps')) {
          const cleanTitle = title.replace(' - Google Maps', '').replace(' | Google Maps', '').replace(' - Directions', '').trim();
          if (cleanTitle.length > 2) {
            return cleanTitle;
          }
        }
        
        // Last resort: try to extract from URL
        const url = window.location.href;
        const urlMatch = url.match(/\/maps\/place\/([^\/]+)/);
        if (urlMatch) {
          const urlName = decodeURIComponent(urlMatch[1]).replace(/\+/g, ' ').trim();
          if (urlName.length > 2) {
            return urlName;
          }
        }
        
        return 'Unknown Business';
      });
      
      // console.log(`Business name: ${businessName}`);

      // Extract the address using multiple selectors
      let address = 'Not found';
      try {
        const addressSelectors = [
          'button[data-item-id="address"]',
          '[data-item-id="address"]',
          'button[aria-label*="Address"]',
          '[aria-label*="Address"]',
          '.Io6YTe[data-value*="Address"]',
          '.Io6YTe:contains("Address")'
        ];
        
        for (const selector of addressSelectors) {
          try {
            const addressElement = await page.$(selector);
            if (addressElement) {
              address = await addressElement.evaluate(el => {
                const ariaLabel = el.getAttribute('aria-label');
                const textContent = el.textContent?.trim();
                const dataValue = el.getAttribute('data-value');
                
                // Try aria-label first
                if (ariaLabel) {
                  return ariaLabel.replace(/^(Address|Adresse):\s*/i, '').trim();
                }
                
                // Try text content
                if (textContent) {
                  return textContent.replace(/^(Address|Adresse):\s*/i, '').trim();
                }
                
                // Try data-value
                if (dataValue) {
                  return dataValue.replace(/^(Address|Adresse):\s*/i, '').trim();
                }
                
                return null;
              });
              if (address && address !== 'Not found') break;
            }
          } catch (e) {
            // Continue to next selector
          }
        }
      } catch (error) {
        console.log('Could not extract address:', error.message);
      }
      
      // Extract the website using comprehensive selectors
      let website = 'Not found';
      try {
        const websiteSelectors = [
          'a[aria-label*="Website"]',
          'a[aria-label*="Nettsted"]', // Norwegian for website
          'a[href*="http"]:not([href*="google.com"])',
          '[data-item-id="authority"] a',
          '.CsEnBe a[href*="http"]',
          'a[data-value*="Website"]',
          'a[data-value*="Nettsted"]',
          'button[aria-label*="Website"]',
          'button[aria-label*="Nettsted"]',
          '[jsaction*="pane"] a[href*="http"]',
          '.fontBodyMedium a[href*="http"]',
          '.Io6YTe a[href*="http"]',
          'a[href^="http"]:not([href*="google.com"]):not([href*="maps.google.com"])',
          '[role="button"][aria-label*="Website"]',
          '[role="button"][aria-label*="Nettsted"]'
        ];
        
        for (const selector of websiteSelectors) {
          try {
            const websiteElements = await page.$$(selector);
            for (const websiteElement of websiteElements) {
              const href = await websiteElement.evaluate(el => el.getAttribute('href'));
              if (href && !href.includes('google.com') && !href.includes('maps.google.com') && !href.includes('javascript:')) {
                website = href.startsWith('http') ? href : `https://${href}`;
                // console.log(`Found website with selector ${selector}: ${website}`);
                break;
              }
            }
            if (website && website !== 'Not found') break;
          } catch (e) {
            // Continue to next selector
          }
        }
      } catch (error) {
        console.log('Could not extract website:', error.message);
      }
      
      // Extract phone number using comprehensive selectors
      let phone = 'Not found';
      try {
        const phoneSelectors = [
          'button[data-item-id="phone"]',
          '[data-item-id="phone"]',
          'button[aria-label*="Phone"]',
          'button[aria-label*="Telefon"]', // Norwegian for phone
          'button[aria-label*="Ring"]',
          '[aria-label*="Phone"]',
          '[aria-label*="Telefon"]',
          '[aria-label*="Ring"]',
          '.Io6YTe[data-value*="Phone"]',
          '.Io6YTe[data-value*="Telefon"]',
          '.Io6YTe:contains("Phone")',
          '.Io6YTe:contains("Telefon")',
          'span[data-value*="+"]',
          'span[data-value*="47"]',
          'a[href^="tel:"]',
          'button[data-value*="+"]',
          'button[data-value*="47"]',
          '[data-value*="+"]',
          '[data-value*="47"]',
          '.fontBodyMedium span',
          '.fontBodyMedium button',
          'span:contains("+47")',
          'span:contains("+")',
          'button:contains("+47")',
          'button:contains("+")',
          '[jsaction*="pane"] span',
          '[jsaction*="pane"] button',
          '.CsEnBe span',
          '.CsEnBe button'
        ];
        
        for (const selector of phoneSelectors) {
          try {
            const phoneElement = await page.$(selector);
            if (phoneElement) {
              phone = await phoneElement.evaluate(el => {
                const ariaLabel = el.getAttribute('aria-label');
                const textContent = el.textContent?.trim();
                const dataValue = el.getAttribute('data-value');
                const href = el.getAttribute('href');
                
                // Enhanced phone number regex patterns
                const phonePatterns = [
                  /(\+47\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{2})/,  // Norwegian format: +47 XX XX XX XX
                  /(\+47\s?\d{8})/,                          // Norwegian format: +47XXXXXXXX
                  /(\+?\d{1,4}[\s\-]?\d{2,4}[\s\-]?\d{2,4}[\s\-]?\d{2,4})/, // General international
                  /(\d{2,4}[\s\-]?\d{2,4}[\s\-]?\d{2,4})/,   // Local format
                  /(\+47\d{8})/                              // Norwegian without spaces
                ];
                
                // Try to extract phone number from aria-label
                if (ariaLabel) {
                  for (const pattern of phonePatterns) {
                    const phoneMatch = ariaLabel.match(pattern);
                    if (phoneMatch) {
                      const phoneNumber = phoneMatch[1].replace(/\s+/g, ' ').trim();
                      if (phoneNumber.length >= 8) return phoneNumber;
                    }
                  }
                  
                  // Remove common prefixes and try again
                  const cleanLabel = ariaLabel.replace(/^(Phone|Ring|Telefon|Call):\s*/i, '').trim();
                  if (cleanLabel && !cleanLabel.includes('telefonnummeret') && !cleanLabel.includes('Ring')) {
                    for (const pattern of phonePatterns) {
                      const phoneMatch = cleanLabel.match(pattern);
                      if (phoneMatch) {
                        const phoneNumber = phoneMatch[1].replace(/\s+/g, ' ').trim();
                        if (phoneNumber.length >= 8) return phoneNumber;
                      }
                    }
                    // If no pattern matches but it looks like a phone number
                    if (/\d{8,}/.test(cleanLabel)) {
                      return cleanLabel;
                    }
                  }
                }
                
                // Try to extract from text content
                if (textContent) {
                  for (const pattern of phonePatterns) {
                    const phoneMatch = textContent.match(pattern);
                    if (phoneMatch) {
                      const phoneNumber = phoneMatch[1].replace(/\s+/g, ' ').trim();
                      if (phoneNumber.length >= 8) return phoneNumber;
                    }
                  }
                  
                  if (!textContent.includes('telefonnummeret') && !textContent.includes('Ring') && /\d{8,}/.test(textContent)) {
                    return textContent;
                  }
                }
                
                // Try data-value
                if (dataValue) {
                  for (const pattern of phonePatterns) {
                    const phoneMatch = dataValue.match(pattern);
                    if (phoneMatch) {
                      const phoneNumber = phoneMatch[1].replace(/\s+/g, ' ').trim();
                      if (phoneNumber.length >= 8) return phoneNumber;
                    }
                  }
                  if (/\d{8,}/.test(dataValue)) {
                    return dataValue;
                  }
                }
                
                // Try href (tel: links)
                if (href && href.startsWith('tel:')) {
                  const phoneNumber = href.replace('tel:', '').trim();
                  if (phoneNumber.length >= 8) return phoneNumber;
                }
                
                return null;
              });
              if (phone && phone !== 'Not found' && phone !== 'Ring telefonnummeret') break;
            }
          } catch (e) {
            // Continue to next selector
          }
        }
      } catch (error) {
        console.log('Could not extract phone:', error.message);
      }
      
      // Fallback: Search for phone numbers in the entire page content
      if (phone === 'Not found') {
        try {
          const pageContent = await page.evaluate(() => {
            const phonePatterns = [
              /(\+47\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{2})/g,
              /(\+47\s?\d{8})/g,
              /(\+?\d{1,4}[\s\-]?\d{2,4}[\s\-]?\d{2,4}[\s\-]?\d{2,4})/g,
              /(\d{2,4}[\s\-]?\d{2,4}[\s\-]?\d{2,4})/g
            ];
            
            const allText = document.body.innerText;
            const foundPhones = [];
            
            phonePatterns.forEach(pattern => {
              const matches = allText.match(pattern);
              if (matches) {
                matches.forEach(match => {
                  const cleanPhone = match.replace(/\s+/g, ' ').trim();
                  if (cleanPhone.length >= 8 && !foundPhones.includes(cleanPhone)) {
                    foundPhones.push(cleanPhone);
                  }
                });
              }
            });
            
            return foundPhones;
          });
          
          if (pageContent.length > 0) {
            phone = pageContent[0]; // Take the first valid phone number found
            console.log(`Found phone via fallback: ${phone}`);
          }
        } catch (error) {
          console.log('Fallback phone search failed:', error.message);
        }
      }

      // Extract additional business details
      let rating = 'Not found';
      let hours = 'Not found';
      let priceLevel = 'Not found';
      
      try {
        // Extract rating
        const ratingSelectors = [
          '[data-value*="stars"]',
          '.fontDisplayLarge',
          '[aria-label*="stars"]',
          '[aria-label*="rating"]',
          '.section-star-display',
          '.section-star-rating'
        ];
        
        for (const selector of ratingSelectors) {
          try {
            const ratingElement = await page.$(selector);
            if (ratingElement) {
              rating = await ratingElement.evaluate(el => {
                const text = el.textContent?.trim() || el.getAttribute('aria-label') || '';
                const match = text.match(/(\d+[.,]\d+)/);
                return match ? match[1] : text;
              });
              if (rating && rating !== 'Not found') break;
            }
          } catch (e) {
            // Continue to next selector
          }
        }
        
        // Extract hours
        const hoursSelectors = [
          '[data-item-id="oh"]',
          'button[aria-label*="Hours"]',
          'button[aria-label*="Åpningstider"]',
          '[aria-label*="Hours"]',
          '[aria-label*="Åpningstider"]'
        ];
        
        for (const selector of hoursSelectors) {
          try {
            const hoursElement = await page.$(selector);
            if (hoursElement) {
              hours = await hoursElement.evaluate(el => 
                el.getAttribute('aria-label')?.replace(/^(Hours|Åpningstider):\s*/i, '').trim() || 
                el.textContent?.trim()
              );
              if (hours && hours !== 'Not found') break;
            }
          } catch (e) {
            // Continue to next selector
          }
        }
        
        // Extract price level
        const priceSelectors = [
          '[data-value*="$"]',
          '[aria-label*="price"]',
          '[aria-label*="pris"]',
          '.section-price'
        ];
        
        for (const selector of priceSelectors) {
          try {
            const priceElement = await page.$(selector);
            if (priceElement) {
              priceLevel = await priceElement.evaluate(el => 
                el.textContent?.trim() || el.getAttribute('aria-label')?.trim()
              );
              if (priceLevel && priceLevel !== 'Not found') break;
            }
          } catch (e) {
            // Continue to next selector
          }
        }
      } catch (error) {
        console.log('Could not extract additional details:', error.message);
      }

      // Check for Google blocking during scraping
      const isBlocked = await page.evaluate(() => {
        const bodyText = document.body.innerText || '';
        const url = window.location.href;
        return bodyText.includes('unusual traffic') || 
               bodyText.includes('automated queries') ||
               bodyText.includes('sorry') ||
               bodyText.includes('blocked') ||
               url.includes('sorry') ||
               url.includes('blocked');
      }).catch(() => false);
      
      if (isBlocked) {
        console.log('  🚫 GOOGLE BLOCKING DETECTED during business scraping!');
        console.log('  📸 Saving debug info...');
        await saveDebugInfo(page, 'google_blocked_during_scraping', {
          industry: industry,
          businessIndex: index + 1,
          businessName: businessName
        });
        // Don't stop - continue to next business, but we'll detect this pattern
      }
      
      // Check if this business has a real website - if so, skip it
      const hasRealWebsite = isRealBusinessWebsite(website, businessName);
      
      console.log(`Name: ${businessName}`);
      console.log(`URL: ${result.url}`);
      console.log(`Address: ${address}`);
      console.log(`Website (original): ${website}`);
      console.log(`Phone: ${phone}`);
      console.log(`Rating: ${rating}`);
      console.log(`Hours: ${hours}`);
      console.log(`Price Level: ${priceLevel}`);

      if (hasRealWebsite) {
        console.log(`❌ SKIPPING ${businessName} - Has real business website: ${website}`);
        console.log('---------------------------');
        continue; // Skip this business and move to the next one
      }

      // Clean the website URL - empty non-business links, keep real business websites
      const cleanedWebsite = cleanWebsiteUrl(website, businessName);
      console.log(`Website (cleaned): ${cleanedWebsite || 'EMPTY'}`);
      console.log(`✅ KEEPING ${businessName} - No real business website found`);

      // Since we're only keeping businesses WITHOUT real websites, 
      // we don't need to navigate to any websites for email extraction
      let email = 'Not found';
      console.log(`No website navigation needed - business has no real website`);

      console.log(`Email: ${email}`);

      // Add the collected data to the excelData array
      excelData.push({
        Name: businessName,
        Address: address || '',
        Website: cleanedWebsite || '', // Use cleaned website (empty for non-business links)
        Phone: phone || '',
        Email: email || '',
        'Contact Person': 'Not found', // Will be filled by expand.js
        'Business Phone': 'Not found', // Will be filled by expand.js from Proff.no
        Rating: rating || '',
        Hours: hours || '',
        PriceLevel: priceLevel || ''
      });
      
      // Clean up memory after each business
      await page.evaluate(() => {
        if (window.gc) {
          window.gc();
        }
      }).catch(() => {});

    } catch (error) {
      console.error(`Error scraping business ${index + 1}: ${error.message}`);
      
      // Handle crashes - could be memory OR Google blocking
      const isCrashError = error.message.includes('Out of Memory') || 
                           error.message.includes('memory') || 
                           error.message.includes('Aw, Snap') || 
                           error.message.includes('Crash') ||
                           error.message.includes('Target closed') ||
                           error.message.includes('Session closed');
      
      if (isCrashError) {
        // Try to check if it's Google blocking (before page crashed)
        let wasBlocked = false;
        try {
          const currentUrl = page.url();
          wasBlocked = currentUrl.includes('sorry') || 
                      currentUrl.includes('blocked') ||
                      currentUrl.includes('unusual') ||
                      currentUrl.includes('automated');
        } catch (e) {
          // Page might be crashed, check error message
          wasBlocked = error.message.includes('blocked') || 
                      error.message.includes('unusual') ||
                      error.message.includes('automated');
        }
        
        if (wasBlocked) {
          console.log('  🚫 GOOGLE BLOCKING DETECTED! (Not a memory issue)');
          console.log('  ⚠️  Google is intentionally blocking/crashing the browser');
          console.log('  💡 Solutions: Use proxies, increase delays, or wait longer');
        } else {
          console.log('  ⚠️  BROWSER CRASH DETECTED');
          console.log('  💭 Could be: Memory issue OR Google blocking (hard to tell)');
        }
        
        // Force garbage collection
        try {
          await page.evaluate(() => {
            if (window.gc) window.gc();
          });
        } catch (e) {}
        
        // Wait longer if it's a block (Google needs more time)
        const waitTime = wasBlocked ? 60000 : 10000; // 60s for blocks, 10s for crashes
        console.log(`  ⏳ Waiting ${waitTime/1000}s before recovery...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        // Always restart browser after crash
        console.log('  🔄 Restarting browser to recover...');
        try {
          await browser.close().catch(() => {});
          const proxy = USE_PROXIES ? formatProxy(getRandomProxy(proxies)) : null;
          browser = await createBrowser(proxy, industryIndex);
          page = await browser.newPage();
          await setupPageAntiDetection(page);
          await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
          await handleConsent(page, url);
          console.log('  ✅ Browser restarted and recovered');
        } catch (e) {
          console.log(`  ❌ Browser restart failed: ${e.message}`);
          if (wasBlocked) {
            console.log('  ⚠️  Google is likely blocking. Consider:');
            console.log('     - Waiting 1-2 hours before retrying');
            console.log('     - Using residential proxies');
            console.log('     - Significantly increasing delays');
          }
        }
        
        // Skip this business and continue
        continue;
      }
    }
    
    // No delay between businesses - maximum speed for filtering step
    // if (index < results.length - 1) {
    //   const delay = Math.random() * 2000 + 1000; // 1-3 seconds
    //   console.log(`Waiting ${Math.round(delay)}ms before next business...`);
    //   await new Promise(resolve => setTimeout(resolve, delay));
    // }
    
    console.log('---------------------------');
  }

  console.log('Scraping completed.');
  
  // Check if we got very few businesses (could indicate blocking)
  if (excelData.length === 0 && businessesToProcess.length > 0) {
    console.log('  ⚠️  WARNING: No businesses kept! This might indicate blocking.');
    console.log('  📸 Saving debug info...');
    await saveDebugInfo(page, 'no_businesses_kept', {
      industry: industry,
      totalFound: results.length,
      totalProcessed: businessesToProcess.length,
      totalKept: excelData.length
    }).catch(() => {});
  }
  
  // Only close browser if we created it in this function AND it's not being shared
  // If browser is shared, don't close it - let the main function manage it
  if (shouldCloseBrowser && !browserInstance) {
    console.log('Closing browser...');
    await browser.close();
  } else if (browserInstance) {
    // Browser is shared, return it for reuse
    console.log('Keeping browser open for next industry...');
  }

  const industryEndTime = Date.now(); // Track end time for this industry
  const industryDuration = ((industryEndTime - industryStartTime) / 1000).toFixed(2); // Duration in seconds

  // Summary of results
  console.log('\n=== FILTERING SUMMARY ===');
  console.log(`Industry: ${industry}`);
  console.log(`Total businesses found: ${results.length}`);
  if (TEST_LIMIT) {
    console.log(`🧪 TESTING MODE: Processed ${businessesToProcess.length} of ${results.length} businesses`);
  }
  console.log(`Businesses KEPT (no real website): ${excelData.length}`);
  console.log(`Businesses FILTERED OUT (have real website): ${businessesToProcess.length - excelData.length}`);
  console.log(`Time taken: ${industryDuration} seconds`);
  console.log('========================\n');

  // Return the collected data along with timing info and browser instances
  return {
    data: excelData,
    browser: browser,
    page: page,
    timing: {
      industry: industry,
      startTime: new Date(industryStartTime).toISOString(),
      endTime: new Date(industryEndTime).toISOString(),
      durationSeconds: parseFloat(industryDuration),
      totalBusinessesFound: results.length,
      businessesProcessed: businessesToProcess.length,
      businessesKept: excelData.length,
      businessesFiltered: businessesToProcess.length - excelData.length
    }
  };
}

// Main function to process all industries
async function processAllIndustries() {
  const overallStartTime = Date.now(); // Track overall start time
  const industries = readIndustriesFromFile();
  
  // Load proxies if enabled (empty array if disabled)
  const proxies = USE_PROXIES ? loadProxies() : [];
  if (USE_PROXIES && proxies.length === 0) {
    console.log('⚠️  WARNING: Proxy rotation enabled but no proxies found!');
    console.log(`   Create a file named "${PROXY_FILE}" with one proxy per line.`);
    console.log(`   Continuing without proxies...\n`);
  }
  
  console.log(`Found ${industries.length} industries to process: ${industries.join(', ')}`);
  console.log(`Overall start time: ${new Date(overallStartTime).toISOString()}`);
  if (USE_PROXIES && proxies.length > 0) {
    console.log(`📡 Proxy rotation: ENABLED (${proxies.length} proxies loaded)`);
  } else {
    console.log(`📡 Proxy rotation: DISABLED`);
  }
  console.log(`\n`);
  
  // Array to hold all results from all industries
  const allResults = [];
  // Array to hold timing data for analysis
  const timingData = [];
  
  // Shared browser instance for session management
  let sharedBrowser = null;
  let sharedPage = null;
  let businessesProcessed = 0;
  
  // Process each industry sequentially
  for (const [index, industry] of industries.entries()) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Processing industry ${index + 1}/${industries.length}: ${industry}`);
    console.log(`${'='.repeat(60)}\n`);
    
    try {
      // Rotate session every N businesses across all industries
      if (businessesProcessed > 0 && businessesProcessed % SESSION_ROTATION_INTERVAL === 0) {
        console.log(`🔄 Rotating browser session (${businessesProcessed} total businesses processed)...`);
        if (sharedBrowser) {
          try {
            await sharedBrowser.close();
          } catch (e) {}
        }
        sharedBrowser = null;
        sharedPage = null;
      }
      
      // Retry up to 3 times per industry
      let industryRetries = 0;
      const maxIndustryRetries = 3; // 3 tries per industry
      let industryResult = null;
      
      while (industryRetries < maxIndustryRetries) {
        try {
          industryResult = await scrapeGoogleMaps(industry, index, proxies, sharedBrowser, sharedPage);
          
          // If we got results, break out of retry loop
          if (industryResult && industryResult.data && industryResult.data.length > 0) {
            break;
          }
          
          // If no results and we haven't retried yet, try again
          if (industryRetries < maxIndustryRetries - 1) {
            industryRetries++;
            console.log(`  ⚠️  No results for industry "${industry}", retrying... (${industryRetries}/${maxIndustryRetries})`);
            await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5s before retry
          } else {
            break; // Exit retry loop
          }
        } catch (error) {
          industryRetries++;
          
          // Check if it's a blocking error
          const isBlockingError = error.message.includes('blocked') || 
                                  error.message.includes('blocking') ||
                                  error.message.includes('unusual traffic');
          
          if (isBlockingError && industryRetries < maxIndustryRetries) {
            console.log(`  🚫 Blocking detected for industry "${industry}", retrying... (${industryRetries}/${maxIndustryRetries})`);
            await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10s for blocks
            continue;
          }
          
          // If it's the last retry or not a blocking error, save debug and re-throw
          if (industryRetries >= maxIndustryRetries) {
            console.log(`  ❌ Failed for industry "${industry}"`);
            console.log(`  📸 Saving debug info...`);
            
            // Try to get page for screenshot
            try {
              if (sharedPage) {
                await saveDebugInfo(sharedPage, 'industry_failed_after_retries', {
                  industry: industry,
                  retries: industryRetries,
                  error: error.message
                });
              }
            } catch (e) {
              console.log(`  ⚠️  Could not save debug info: ${e.message}`);
            }
            
            throw error; // Re-throw to be caught by outer catch
          }
          
          // Wait before retry
          await new Promise(resolve => setTimeout(resolve, 5000));
        }
      }
      
      // If we still don't have results after retries, STOP the entire process
      if (!industryResult || !industryResult.data || industryResult.data.length === 0) {
        console.log(`  ❌ No results collected for industry "${industry}"`);
        console.log('  📸 Saving debug info...');
        try {
          if (sharedPage) {
            await saveDebugInfo(sharedPage, 'industry_no_results', {
              industry: industry,
              retries: industryRetries
            });
          }
        } catch (e) {}
        
        // Add error entry to timing data
        timingData.push({
          industry: industry,
          startTime: 'Error',
          endTime: 'Error',
          durationSeconds: 0,
          totalBusinessesFound: 0,
          businessesKept: 0,
          businessesFiltered: 0,
          error: 'No results after retries'
        });
        
        // STOP the entire process - don't continue to next industry
        console.log('\n🛑 STOPPING: No results collected. Shutting down...');
        if (sharedBrowser) {
          try {
            await sharedBrowser.close();
          } catch (e) {}
        }
        throw new Error(`No results collected for industry: ${industry}. Process stopped.`);
      }
      
      // Update shared browser/page if we created new ones
      if (industryResult.browser && industryResult.page) {
        sharedBrowser = industryResult.browser;
        sharedPage = industryResult.page;
      }
      
      // Add industry information to each result
      const resultsWithIndustry = industryResult.data.map(result => ({
        ...result,
        Industry: industry // Add industry column to track which industry each business belongs to
      }));
      
      allResults.push(...resultsWithIndustry);
      businessesProcessed += industryResult.data.length;
      
      // Store timing data
      timingData.push(industryResult.timing);
      
      console.log(`\n✅ Completed industry "${industry}": ${industryResult.data.length} businesses collected in ${industryResult.timing.durationSeconds} seconds`);
      
      // Add a randomized delay between industries to avoid rate limiting (except for the last one)
      if (index < industries.length - 1) {
        const delay = getRandomDelay(MIN_DELAY_BETWEEN_INDUSTRIES, MAX_DELAY_BETWEEN_INDUSTRIES);
        console.log(`⏳ Waiting ${Math.round(delay/1000)}s before processing next industry...\n`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    } catch (error) {
      console.error(`❌ Error processing industry "${industry}":`, error.message);
      console.log('  📸 Saving debug info before continuing...');
      
      // Try to save debug info
      try {
        if (sharedPage) {
          await saveDebugInfo(sharedPage, 'industry_error', {
            industry: industry,
            error: error.message,
            stack: error.stack
          });
        }
      } catch (e) {
        console.log(`  ⚠️  Could not save debug info: ${e.message}`);
      }
      
      console.log('Continuing with next industry...\n');
      
      // Add error entry to timing data
      timingData.push({
        industry: industry,
        startTime: 'Error',
        endTime: 'Error',
        durationSeconds: 0,
        totalBusinessesFound: 0,
        businessesKept: 0,
        businessesFiltered: 0,
        error: error.message
      });
      // Continue with next industry even if one fails
    }
  }
  
  // Close shared browser if still open
  if (sharedBrowser) {
    try {
      await sharedBrowser.close();
    } catch (e) {
      console.log(`Error closing shared browser: ${e.message}`);
    }
  }
  
  const overallEndTime = Date.now(); // Track overall end time
  const overallDuration = ((overallEndTime - overallStartTime) / 1000).toFixed(2); // Duration in seconds
  
  // Create analysis data for the "scraper analyzing" sheet
  const analysisData = [
    {
      Metric: 'Overall Start Time',
      Value: new Date(overallStartTime).toISOString()
    },
    {
      Metric: 'Overall End Time',
      Value: new Date(overallEndTime).toISOString()
    },
    {
      Metric: 'Total Duration (seconds)',
      Value: parseFloat(overallDuration)
    },
    {
      Metric: 'Total Duration (minutes)',
      Value: (parseFloat(overallDuration) / 60).toFixed(2)
    },
    {
      Metric: 'Total Duration (hours)',
      Value: (parseFloat(overallDuration) / 3600).toFixed(2)
    },
    {
      Metric: 'Total Industries Processed',
      Value: industries.length
    },
    {
      Metric: 'Total Businesses Collected',
      Value: allResults.length
    },
    {
      Metric: 'Average Time per Industry (seconds)',
      Value: timingData.length > 0 ? (timingData.reduce((sum, t) => sum + (t.durationSeconds || 0), 0) / timingData.length).toFixed(2) : 0
    },
    {
      Metric: 'Average Businesses per Industry',
      Value: timingData.length > 0 ? (timingData.reduce((sum, t) => sum + (t.businessesKept || 0), 0) / timingData.length).toFixed(2) : 0
    }
  ];
  
  // Add per-industry breakdown
  timingData.forEach(timing => {
    analysisData.push({
      Metric: `Industry: ${timing.industry}`,
      Value: ''
    });
    analysisData.push({
      Metric: `  - Duration (seconds)`,
      Value: timing.durationSeconds || 0
    });
    analysisData.push({
      Metric: `  - Total Businesses Found`,
      Value: timing.totalBusinessesFound || 0
    });
    analysisData.push({
      Metric: `  - Businesses Kept`,
      Value: timing.businessesKept || 0
    });
    analysisData.push({
      Metric: `  - Businesses Filtered`,
      Value: timing.businessesFiltered || 0
    });
    if (timing.error) {
      analysisData.push({
        Metric: `  - Error`,
        Value: timing.error
      });
    }
  });

  // Create and write the combined Excel file
  console.log(`\n${'='.repeat(60)}`);
  console.log('Creating combined Excel file with all industries...');
  console.log(`Total duration: ${overallDuration} seconds (${(parseFloat(overallDuration) / 60).toFixed(2)} minutes)`);
  console.log(`${'='.repeat(60)}\n`);
  
  const workbook = xlsx.utils.book_new(); // Create a new workbook
  const worksheet = xlsx.utils.json_to_sheet(allResults); // Convert all data to a worksheet
  xlsx.utils.book_append_sheet(workbook, worksheet, 'Results'); // Append the worksheet to the workbook
  
  // Create the analysis worksheet
  const analysisWorksheet = xlsx.utils.json_to_sheet(analysisData);
  xlsx.utils.book_append_sheet(workbook, analysisWorksheet, 'scraper analyzing'); // Append the analysis worksheet

  // Write the Excel file to disk with timestamp to avoid locking issues
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `GoogleMapsResults_${timestamp}.xlsx`;
  
  try {
    xlsx.writeFile(workbook, filename); 
    console.log(`✅ Excel file "${filename}" has been created successfully.`);
    console.log(`Total businesses collected: ${allResults.length}`);
    console.log(`Analysis data saved to "scraper analyzing" sheet.`);
  } catch (error) {
    if (error.code === 'EBUSY') {
      console.log('File is locked, trying with a different name...');
      const altFilename = `GoogleMapsResults_${Date.now()}.xlsx`;
      xlsx.writeFile(workbook, altFilename);
      console.log(`✅ Excel file "${altFilename}" has been created successfully.`);
      console.log(`Total businesses collected: ${allResults.length}`);
      console.log(`Analysis data saved to "scraper analyzing" sheet.`);
    } else {
      throw error;
    }
  }
}

// Execute the main function to process all industries
console.log('Starting scraper for all industries...');
processAllIndustries()
  .then(() => {
    console.log('\n✅ All industries processed successfully!');
  })
  .catch((error) => {
    console.error('❌ Scraper failed with error:', error);
    process.exit(1);
  });