const puppeteer = require('puppeteer');
const xlsx = require('xlsx'); // Import the xlsx library to handle Excel files

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

async function scrapeGoogleMaps() {
  // Expanded search area to cover more of Trondheim and surrounding areas
  const url = 'https://www.google.com/maps/search/restaurants/@63.4250829,10.4155537,12z'; // Reduced zoom level to cover larger area

  console.log('Launching browser...');
  const browser = await puppeteer.launch({ 
    headless: false, // Run in non-headless mode to appear more human-like
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=VizDisplayCompositor'
    ]
  });
  const page = await browser.newPage();
  
  // Set user agent to avoid consent pages
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
  
  // Set additional headers
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9,no;q=0.8'
  });
  
  // Hide automation indicators
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
  });

  // Set cookies to bypass consent
  await page.setCookie({
    name: 'CONSENT',
    value: 'YES+cb.20210328-17-p0.en+FX+667',
    domain: '.google.com'
  });

  console.log('Navigating to main URL...');
  await page.goto(url, { waitUntil: 'networkidle2' });
  
  // Handle Google consent page if it appears
  const currentUrl = page.url();
  if (currentUrl.includes('consent.google.com')) {
    console.log('Consent page detected, trying to accept...');
    
    try {
      // Try different selectors for accept button
      const acceptSelectors = [
        'button[aria-label*="Accept"]',
        'button[aria-label*="Godta"]',
        'button:contains("Accept all")',
        'button:contains("I agree")',
        'button:contains("Godta alle")',
        '#L2AGLb', // Common Google consent button ID
        'button[data-ved]'
      ];
      
      let acceptButton = null;
      for (const selector of acceptSelectors) {
        try {
          acceptButton = await page.$(selector);
          if (acceptButton) {
            console.log(`Found accept button with selector: ${selector}`);
            break;
          }
        } catch (e) {
          // Continue to next selector
        }
      }
      
      if (acceptButton) {
        await acceptButton.click();
        console.log('Clicked accept button, waiting for redirect...');
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 });
      } else {
        console.log('Could not find accept button, trying to bypass...');
        // Try to bypass by going directly to maps
        const mapsUrl = 'https://www.google.com/maps/search/restaurants/@63.4250829,10.4155537,14z';
        await page.goto(mapsUrl, { waitUntil: 'networkidle2' });
      }
    } catch (error) {
      console.log('Error handling consent:', error.message);
    }
  }

  console.log('Scrolling to load more results using "Page Down"...');
  const maxPageDowns = 5; // Increased to get 200+ results
  const scrollDelay = 200; // Delay between each Page Down key press
  let pageDownAttempts = 0;

  // Collect all business URLs during scrolling
  const allBusinessUrls = new Set();
  
  // More comprehensive scrolling to get more results
  try {
    let previousUrlCount = 0;
    let noNewResultsCount = 0;
    
    while (pageDownAttempts < maxPageDowns) {
      console.log(`Scroll attempt ${pageDownAttempts + 1}...`);
      
      // Longer delay between scroll attempts to avoid bot detection
      const randomDelay = Math.random() * 3000 + 3000; // 3-6 seconds between attempts
      await new Promise(resolve => setTimeout(resolve, randomDelay));
      
      // Use End key to scroll all the way to bottom in one go
      await page.keyboard.press('End');
      
      // Wait for content to load
      const loadDelay = Math.random() * 1000 + 1000; // 1-2 seconds
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
            console.log('  No new results for 3 attempts, stopping early to avoid wasting time...');
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
  } catch (error) {
    console.error('Error while scrolling:', error);
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

  // Initialize an array to hold the data for the Excel file
  const excelData = [];

  for (const [index, result] of results.entries()) {
    console.log(`\nScraping details for business ${index + 1}/${results.length}`);
    try {
      await page.goto(result.url, { waitUntil: 'domcontentloaded', timeout: 5000 });  // Fast timeout for filtering step

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
        Rating: rating || '',
        Hours: hours || '',
        PriceLevel: priceLevel || ''
      });

    } catch (error) {
      console.error(`Error scraping business ${index + 1}: ${error.message}`);
    }
    
    // No delay between businesses - maximum speed for filtering step
    // if (index < results.length - 1) {
    //   const delay = Math.random() * 2000 + 1000; // 1-3 seconds
    //   console.log(`Waiting ${Math.round(delay)}ms before next business...`);
    //   await new Promise(resolve => setTimeout(resolve, delay));
    // }
    
    console.log('---------------------------');
  }

  console.log('Scraping completed. Closing browser...');
  await browser.close();  // Close the Puppeteer browser

  // Summary of results
  console.log('\n=== FILTERING SUMMARY ===');
  console.log(`Total businesses found: ${results.length}`);
  console.log(`Businesses KEPT (no real website): ${excelData.length}`);
  console.log(`Businesses FILTERED OUT (have real website): ${results.length - excelData.length}`);
  console.log('========================\n');

  // Create and write the Excel file
  const workbook = xlsx.utils.book_new(); // Create a new workbook
  const worksheet = xlsx.utils.json_to_sheet(excelData); // Convert the data to a worksheet
  xlsx.utils.book_append_sheet(workbook, worksheet, 'Results'); // Append the worksheet to the workbook

  // Write the Excel file to disk with timestamp to avoid locking issues
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `GoogleMapsResults_${timestamp}.xlsx`;
  
  try {
    xlsx.writeFile(workbook, filename); 
    console.log(`Excel file "${filename}" has been created successfully.`);
  } catch (error) {
    if (error.code === 'EBUSY') {
      console.log('File is locked, trying with a different name...');
      const altFilename = `GoogleMapsResults_${Date.now()}.xlsx`;
      xlsx.writeFile(workbook, altFilename);
      console.log(`Excel file "${altFilename}" has been created successfully.`);
    } else {
      throw error;
    }
  }
}

// Execute the scraping function and handle errors
console.log('Starting scraper...');
scrapeGoogleMaps()
  .then(() => {
    console.log('Scraper completed successfully!');
  })
  .catch((error) => {
    console.error('Scraper failed with error:', error);
    process.exit(1);
  });