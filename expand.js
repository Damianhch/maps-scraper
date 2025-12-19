const puppeteer = require('puppeteer');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');

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

// Function to scrape Proff.no for contact person/owner name
async function scrapeProffContactPerson(businessName, page) {
  try {
    // Use Google search to find Proff.no page for the business
    // No quotes around business name - allows Google to find most relevant match even if name differs slightly
    const googleSearchQuery = `${businessName} site:proff.no`;
    const encodedQuery = encodeURIComponent(googleSearchQuery);
    const googleSearchUrl = `https://www.google.com/search?q=${encodedQuery}`;
    
    console.log(`  🔍 Google searching: ${businessName} proff.no`);
    
    // Navigate to Google search with retry logic
    let googleLoaded = false;
    for (let retry = 0; retry < 2; retry++) {
      try {
        await page.goto(googleSearchUrl, { waitUntil: 'load', timeout: 20000 });
        googleLoaded = true;
        break;
      } catch (e) {
        if (retry === 1) {
          // On last retry, try with even shorter timeout
          try {
            await page.goto(googleSearchUrl, { waitUntil: 'load', timeout: 10000 });
            googleLoaded = true;
          } catch (e2) {
            console.log(`  ⚠️  Google search timeout, continuing anyway...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
        }
      }
    }
    
    // Handle Google consent if it appears
    try {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const consentSelectors = [
        'button[aria-label*="Accept"]',
        'button[aria-label*="Godta"]',
        '#L2AGLb',
        'button:contains("Accept all")',
        'button:contains("Godta alle")'
      ];
      
      for (const selector of consentSelectors) {
        try {
          const consentButton = await page.$(selector);
          if (consentButton) {
            console.log(`  🔘 Clicking Google consent button...`);
            await consentButton.click();
            await new Promise(resolve => setTimeout(resolve, 2000));
            break;
          }
        } catch (e) {
          // Continue to next selector
        }
      }
    } catch (e) {
      // No consent popup
    }
    
    // Wait for search results to load
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Find and click the first Proff.no result from Google
    let proffUrl = null;
    try {
      // Find the first result that links to proff.no
      proffUrl = await page.evaluate(() => {
        // Try multiple selectors for Google search results
        const resultSelectors = [
          'a[href*="proff.no"]',
          'a[href*="proff.no/bedrift"]',
          'a[href*="proff.no/firma"]',
          'a[href*="proff.no/selskap"]',
          '.g a[href*="proff.no"]',
          'h3 a[href*="proff.no"]'
        ];
        
        for (const selector of resultSelectors) {
          const links = document.querySelectorAll(selector);
          for (const link of links) {
            const href = link.href || link.getAttribute('href');
            if (href && href.includes('proff.no') && 
                (href.includes('/bedrift/') || href.includes('/firma/') || href.includes('/selskap/'))) {
              return href;
            }
          }
        }
        
        // Fallback: get any proff.no link from search results
        const allLinks = document.querySelectorAll('a[href*="proff.no"]');
        if (allLinks.length > 0) {
          const href = allLinks[0].href || allLinks[0].getAttribute('href');
          if (href) return href;
        }
        
        return null;
      });
      
      if (proffUrl) {
        console.log(`  🔗 Found Proff.no link: ${proffUrl}`);
        // Navigate directly to the Proff.no page
        try {
          await page.goto(proffUrl, { waitUntil: 'load', timeout: 20000 });
        } catch (e) {
          // If timeout, try with shorter timeout
          try {
            await page.goto(proffUrl, { waitUntil: 'load', timeout: 10000 });
          } catch (e2) {
            console.log(`  ⚠️  Proff.no page timeout, continuing anyway...`);
          }
        }
        await new Promise(resolve => setTimeout(resolve, 3000));
      } else {
        console.log(`  ⚠️  No Proff.no result found in Google search`);
        return 'Not found';
      }
    } catch (e) {
      console.log(`  ❌ Error finding Proff.no link: ${e.message}`);
      return 'Not found';
    }
    
    // Handle Proff.no consent if it appears
    try {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const consentSelectors = [
        'button[aria-label*="Godta"]',
        'button[aria-label*="Accept"]',
        'button:contains("Godta alle")',
        'button:contains("Accept all")',
        '#onetrust-accept-btn-handler',
        'button[id*="accept"]',
        'button[class*="accept"]'
      ];
      
      for (const selector of consentSelectors) {
        try {
          const consentButton = await page.$(selector);
          if (consentButton) {
            console.log(`  🔘 Clicking Proff.no consent button...`);
            await consentButton.click();
            await new Promise(resolve => setTimeout(resolve, 2000));
            break;
          }
        } catch (e) {
          // Continue to next selector
        }
      }
    } catch (e) {
      // No consent popup
    }
    
    // DEBUG MODE: Inspect HTML structure to find actual selectors
    if (DEBUG_MODE) {
      console.log(`\n  🔍 DEBUG MODE: Inspecting HTML structure for "${businessName}"...`);
      
      const htmlInspection = await page.evaluate(() => {
        const inspection = {
          pageTitle: document.title,
          pageUrl: window.location.href,
          contactPersonElements: [],
          phoneElements: [],
          allTextContent: document.body.innerText.substring(0, 2000) // First 2000 chars
        };
        
        // Find all elements that might contain contact person info
        const possibleContactSelectors = [
          '*[class*="contact"]',
          '*[class*="kontakt"]',
          '*[class*="leder"]',
          '*[class*="leader"]',
          '*[class*="person"]',
          '*[id*="contact"]',
          '*[id*="kontakt"]',
          '*[data-testid*="contact"]',
          '*[data-testid*="person"]'
        ];
        
        possibleContactSelectors.forEach(selector => {
          try {
            const elements = document.querySelectorAll(selector);
            elements.forEach((el, idx) => {
              if (idx < 5) { // Limit to first 5 of each type
                const text = el.textContent?.trim();
                const className = el.className || '';
                const id = el.id || '';
                if (text && text.length > 0 && text.length < 200) {
                  inspection.contactPersonElements.push({
                    selector: selector,
                    className: className,
                    id: id,
                    text: text.substring(0, 100),
                    tagName: el.tagName,
                    parentClass: el.parentElement?.className || '',
                    parentId: el.parentElement?.id || ''
                  });
                }
              }
            });
          } catch (e) {}
        });
        
        // Find all elements that might contain phone info
        const possiblePhoneSelectors = [
          'a[href^="tel:"]',
          'a[href*="tel:"]',
          '*[class*="phone"]',
          '*[class*="telefon"]',
          '*[id*="phone"]',
          '*[id*="telefon"]',
          '*[data-phone]',
          '*[data-telefon]',
          'button[aria-label*="Ring"]',
          'button[aria-label*="Call"]'
        ];
        
        possiblePhoneSelectors.forEach(selector => {
          try {
            const elements = document.querySelectorAll(selector);
            elements.forEach((el, idx) => {
              if (idx < 5) {
                const text = el.textContent?.trim();
                const href = el.getAttribute('href') || '';
                const className = el.className || '';
                const id = el.id || '';
                const dataPhone = el.getAttribute('data-phone') || el.getAttribute('data-telefon') || '';
                
                inspection.phoneElements.push({
                  selector: selector,
                  className: className,
                  id: id,
                  href: href,
                  dataPhone: dataPhone,
                  text: text ? text.substring(0, 100) : '',
                  tagName: el.tagName,
                  parentClass: el.parentElement?.className || '',
                  parentId: el.parentElement?.id || ''
                });
              }
            });
          } catch (e) {}
        });
        
        // Also search for text patterns that might indicate structure
        const bodyHTML = document.body.innerHTML;
        const contactPatterns = [
          /Daglig\s+leder[^<]*<[^>]*>([^<]+)/i,
          /Kontaktperson[^<]*<[^>]*>([^<]+)/i,
          /Daily\s+leader[^<]*<[^>]*>([^<]+)/i
        ];
        
        contactPatterns.forEach(pattern => {
          const match = bodyHTML.match(pattern);
          if (match) {
            inspection.contactPersonElements.push({
              selector: 'PATTERN_MATCH',
              pattern: pattern.toString(),
              matchedText: match[1].substring(0, 100),
              context: match[0].substring(0, 200)
            });
          }
        });
        
        return inspection;
      });
      
      // Save inspection to file for analysis
      const fs = require('fs');
      const inspectionFile = `debug_inspection_${businessName.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.json`;
      fs.writeFileSync(inspectionFile, JSON.stringify(htmlInspection, null, 2));
      console.log(`  💾 Saved HTML inspection to: ${inspectionFile}`);
      
      // Also log key findings to console
      console.log(`  📋 Found ${htmlInspection.contactPersonElements.length} potential contact person elements`);
      console.log(`  📋 Found ${htmlInspection.phoneElements.length} potential phone elements`);
      
      if (htmlInspection.contactPersonElements.length > 0) {
        console.log(`  🔍 Sample contact person elements:`);
        htmlInspection.contactPersonElements.slice(0, 3).forEach((el, idx) => {
          console.log(`    ${idx + 1}. Class: "${el.className}", Text: "${el.text}"`);
        });
      }
      
      if (htmlInspection.phoneElements.length > 0) {
        console.log(`  🔍 Sample phone elements:`);
        htmlInspection.phoneElements.slice(0, 3).forEach((el, idx) => {
          console.log(`    ${idx + 1}. Class: "${el.className}", Href: "${el.href}", Text: "${el.text}"`);
        });
      }
      
      // Take screenshot for visual inspection
      const screenshotPath = `debug_screenshot_${businessName.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });
      console.log(`  📸 Saved screenshot to: ${screenshotPath}`);
    }
    
    // Simple extraction: Find name next to leadership roles
    const extractedData = await page.evaluate(() => {
      const bodyText = document.body.innerText || '';
      
      // Priority order: Daglig leder > Styrets leder > Styreleder > Administrerende direktør > CEO > Kontaktperson
      const roles = [
        'Daglig leder',
        'Styrets leder',  // Chairman of the board (found on S'wich page)
        'Styreleder', 
        'Administrerende direktør',
        'CEO',
        'Kontaktperson'
      ];
      
      let contactPerson = null;
      
      // Method 1: Search in DOM elements (more reliable for structured data)
      for (const role of roles) {
        // Find all elements containing the role text
        const allElements = document.querySelectorAll('*');
        for (const element of allElements) {
          const elementText = element.textContent || '';
          if (elementText.includes(role)) {
            // Check if name is in same element
            const roleIndex = elementText.indexOf(role);
            const afterRole = elementText.substring(roleIndex + role.length).trim();
            
            // Try same line match (role: name or role name)
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
            
            // Check next sibling element
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
            
            // Check parent's next child
            if (element.parentElement) {
              const children = Array.from(element.parentElement.children);
              const roleIndex = children.indexOf(element);
              if (roleIndex !== -1 && roleIndex < children.length - 1) {
                const nextChild = children[roleIndex + 1];
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
        }
        if (contactPerson) break;
      }
      
      // Method 2: Fallback to text-based search
      if (!contactPerson) {
        for (const role of roles) {
          const roleIndex = bodyText.indexOf(role);
          if (roleIndex !== -1) {
            const afterRole = bodyText.substring(roleIndex + role.length, roleIndex + role.length + 200);
            
            // Try same line
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
            
            // Try next lines
            const lines = afterRole.split(/\n/).filter(line => line.trim().length > 0);
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
      
      // Find phone: Look for clickable phone link first
      let businessPhone = null;
      
      // Try all tel: links (there might be multiple)
      const phoneLinks = document.querySelectorAll('a[href^="tel:"]');
      for (const phoneLink of phoneLinks) {
        const href = phoneLink.getAttribute('href');
        if (href) {
          const phone = href.replace('tel:', '').trim();
          // Prefer Norwegian format (8 digits)
          if (phone.length >= 8) {
            businessPhone = phone;
            break;
          }
        }
      }
      
      // Fallback: search for phone pattern in text (look for "Telefon" label)
      if (!businessPhone) {
        const telefonIndex = bodyText.indexOf('Telefon');
        if (telefonIndex !== -1) {
          const afterTelefon = bodyText.substring(telefonIndex + 7, telefonIndex + 30);
          const phoneMatch = afterTelefon.match(/(\+47\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{2}|\d{2}\s?\d{2}\s?\d{2}\s?\d{2}|\d{8})/);
          if (phoneMatch) {
            businessPhone = phoneMatch[1].replace(/\s+/g, '').trim();
          }
        }
      }
      
      // Final fallback: search entire page for phone pattern
      if (!businessPhone) {
        const phoneMatch = bodyText.match(/(\+47\s?\d{2}\s?\d{2}\s?\d{2}\s?\d{2}|\d{2}\s?\d{2}\s?\d{2}\s?\d{2}|\d{8})/);
        if (phoneMatch) {
          businessPhone = phoneMatch[1].replace(/\s+/g, '').trim();
        }
      }
      
      return {
        contactPerson: contactPerson,
        businessPhone: businessPhone
      };
    });
    
    // Clean contact person name - remove "Adresse" if still present
    let cleanedContactPerson = extractedData.contactPerson;
    if (cleanedContactPerson) {
      const adresseIndex = cleanedContactPerson.toLowerCase().indexOf('adresse');
      if (adresseIndex !== -1) {
        cleanedContactPerson = cleanedContactPerson.substring(0, adresseIndex).trim();
      }
      // Remove any role labels that might be at the start
      cleanedContactPerson = cleanedContactPerson.replace(/^(Daglig leder|Styrets leder|Styreleder|Administrerende direktør|CEO|Kontaktperson)[:\s]*/i, '').trim();
    }
    
    // Return both contact person and business phone
    const finalResult = {
      contactPerson: cleanedContactPerson || 'Not found',
      businessPhone: extractedData.businessPhone || 'Not found'
    };
    
    if (cleanedContactPerson) {
      console.log(`  ✅ Found contact person: ${cleanedContactPerson}`);
    } else {
      console.log(`  ⚠️  No contact person found on Proff.no page`);
    }
    
    if (extractedData.businessPhone) {
      console.log(`  📞 Found business phone: ${extractedData.businessPhone}`);
    } else {
      console.log(`  ⚠️  No business phone found on Proff.no page`);
    }
    
    return finalResult;
    
  } catch (error) {
    console.log(`  ❌ Error scraping Proff.no: ${error.message}`);
    return {
      contactPerson: 'Not found',
      businessPhone: 'Not found'
    };
  }
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
  
  // Create backup
  backupExcelFile(excelFilename);
  
  // Read the Excel file
  console.log('\n📖 Reading Excel file...');
  const workbook = xlsx.readFile(excelFilename);
  const worksheet = workbook.Sheets[workbook.SheetNames[0]];
  const data = xlsx.utils.sheet_to_json(worksheet);
  
  if (data.length === 0) {
    console.error('❌ No data found in Excel file');
    process.exit(1);
  }
  
  console.log(`✅ Found ${data.length} businesses to process\n`);
  
  // Check if Contact Person and Business Phone columns exist, if not add them
  const hasContactPersonColumn = data.length > 0 && 'Contact Person' in data[0];
  const hasBusinessPhoneColumn = data.length > 0 && 'Business Phone' in data[0];
  
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
  
  // Launch browser
  console.log('🌐 Launching browser...');
  const browser = await puppeteer.launch({ 
    headless: false,
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
  
  // Set user agent
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
      
      // Use a consistent filename for latest progress (overwrites previous)
      const progressFilename = excelFilename.replace('.xlsx', '_PROGRESS_SAVE.xlsx');
      xlsx.writeFile(newWorkbook, progressFilename);
      lastSavedFilename = progressFilename;
      
      // Also save with timestamp for backup
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const backupFilename = excelFilename.replace('.xlsx', `_expanded_${timestamp}.xlsx`);
      xlsx.writeFile(newWorkbook, backupFilename);
      
      // Only log every 10th save to avoid spam, but always save
      if (updatedCount % 10 === 0 || force) {
        console.log(`\n💾 Progress saved! (${updatedCount} businesses processed)`);
        console.log(`   Latest: ${progressFilename}`);
        console.log(`   Backup: ${backupFilename}`);
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
    
    // Close browser
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
  
  // Process each business
  for (const [index, business] of businessesToProcess.entries()) {
    // Check if we should stop
    if (shouldStop) {
      console.log('\n⚠️  Stopping processing...');
      break;
    }
    const businessName = business.Name || business.name || 'Unknown';
    const currentContactPerson = business['Contact Person'] || business['contact person'] || '';
    
    // Skip if contact person already exists and is not "Not found"
    // But still process if Business Phone is missing
    const currentBusinessPhone = business['Business Phone'] || business['business phone'] || '';
    const shouldSkip = currentContactPerson && 
                       currentContactPerson !== 'Not found' && 
                       currentContactPerson.trim().length > 0 &&
                       currentBusinessPhone && 
                       currentBusinessPhone !== 'Not found' &&
                       currentBusinessPhone.trim().length > 0;
    
    if (shouldSkip) {
      console.log(`\n[${index + 1}/${businessesToProcess.length}] ⏭️  Skipping ${businessName} - Already has contact person and business phone`);
      skippedCount++;
      continue;
    }
    
    console.log(`\n[${index + 1}/${businessesToProcess.length}] 🔍 Processing: ${businessName}`);
    
    try {
      const result = await scrapeProffContactPerson(businessName, page);
      
      // Update the business object (which is a reference to data array when TEST_LIMIT is null)
      business['Contact Person'] = result.contactPerson;
      business['Business Phone'] = result.businessPhone;
      
      // Also update directly in data array to ensure it's saved (in case of reference issues)
      const dataIndex = data.findIndex(b => (b.Name || b.name) === businessName);
      if (dataIndex !== -1) {
        data[dataIndex]['Contact Person'] = result.contactPerson;
        data[dataIndex]['Business Phone'] = result.businessPhone;
      }
      
      if (result.contactPerson !== 'Not found') {
        foundCount++;
        updatedCount++;
      } else {
        notFoundCount++;
        updatedCount++;
      }
      
      // CRITICAL: Save progress after EVERY business to prevent data loss
      // This ensures we never lose more than 1 business worth of data
      await saveProgress();
      
      // Rate limiting: wait 2-3 seconds between requests
      if (index < businessesToProcess.length - 1 && !shouldStop) {
        const delay = Math.random() * 1000 + 2000; // 2-3 seconds
        console.log(`  ⏳ Waiting ${Math.round(delay)}ms before next request...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
    } catch (error) {
      console.error(`  ❌ Error processing ${businessName}: ${error.message}`);
      business['Contact Person'] = 'Not found';
      business['Business Phone'] = 'Not found';
      updatedCount++;
      notFoundCount++;
    }
    
    // Check if we should stop after each business
    if (shouldStop) {
      break;
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
  
  // Write updated data back to Excel
  console.log('\n💾 Writing updated data to Excel file...');
  const newWorksheet = xlsx.utils.json_to_sheet(data);
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
  console.log('📊 EXPANSION SUMMARY');
  console.log('='.repeat(60));
  if (TEST_LIMIT) {
    console.log(`🧪 TESTING MODE: Processed ${businessesToProcess.length} of ${data.length} businesses`);
  } else {
    console.log(`Total businesses: ${data.length}`);
  }
  console.log(`Updated: ${updatedCount}`);
  console.log(`Contact persons found: ${foundCount}`);
  console.log(`Not found: ${notFoundCount}`);
  console.log(`Skipped (already had contact person): ${skippedCount}`);
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



