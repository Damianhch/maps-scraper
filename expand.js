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
    // Use DuckDuckGo - supports site: operator properly and low bot blocking
    const searchQuery = `${businessName} site:proff.no`;
    const encodedQuery = encodeURIComponent(searchQuery);
    const searchUrl = `https://duckduckgo.com/?q=${encodedQuery}`;
    
    console.log(`  🔍 DuckDuckGo: ${businessName} site:proff.no`);
    
    // Navigate to DuckDuckGo search
    try {
      await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    } catch (e) {
      // If timeout, try with shorter timeout
      try {
        await page.goto(searchUrl, { waitUntil: 'load', timeout: 15000 });
      } catch (e2) {
        console.log(`  ⚠️  Search timeout, continuing anyway...`);
      }
    }
    
    // Wait for search results to load (DuckDuckGo uses JavaScript rendering)
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // Find and click the first Proff.no result
    let proffUrl = null;
    try {
      // Find the first result that links to proff.no
      proffUrl = await page.evaluate(() => {
        // DuckDuckGo result selectors
        const resultSelectors = [
          'a[href*="proff.no/selskap"]',
          'a[href*="proff.no/bedrift"]',
          'a[href*="proff.no/firma"]',
          'article a[href*="proff.no"]',
          '[data-testid="result"] a[href*="proff.no"]',
          '.result__a[href*="proff.no"]',
          'a.result__url[href*="proff.no"]'
        ];
        
        for (const selector of resultSelectors) {
          const links = document.querySelectorAll(selector);
          for (const link of links) {
            const href = link.href || link.getAttribute('href');
            if (href && href.includes('proff.no') && 
                (href.includes('/selskap/') || href.includes('/bedrift/') || href.includes('/firma/'))) {
              return href;
            }
          }
        }
        
        // Fallback: get any proff.no link from results
        const allLinks = document.querySelectorAll('a[href*="proff.no"]');
        for (const link of allLinks) {
          const href = link.href || link.getAttribute('href');
          // Skip DuckDuckGo's redirect wrapper if present
          if (href && href.includes('proff.no') && !href.includes('duckduckgo.com')) {
            return href;
          }
        }
        
        return null;
      });
      
      // Handle DuckDuckGo redirect URLs (they sometimes wrap links)
      if (proffUrl && proffUrl.includes('uddg=')) {
        const match = proffUrl.match(/uddg=([^&]+)/);
        if (match) {
          proffUrl = decodeURIComponent(match[1]);
        }
      }
      
      if (proffUrl) {
        
        console.log(`  🔗 Found Proff.no link: ${proffUrl}`);
        // Navigate directly to the Proff.no page
        try {
          await page.goto(proffUrl, { waitUntil: 'networkidle2', timeout: 20000 });
        } catch (e) {
          // If timeout, try with shorter timeout
          try {
            await page.goto(proffUrl, { waitUntil: 'load', timeout: 10000 });
          } catch (e2) {
            console.log(`  ⚠️  Proff.no page timeout, continuing anyway...`);
          }
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      } else {
        console.log(`  ⚠️  No Proff.no result found in search`);
        return { contactPerson: 'Not found', businessPhone: 'Not found' };
      }
    } catch (e) {
      console.log(`  ❌ Error finding Proff.no link: ${e.message}`);
      return { contactPerson: 'Not found', businessPhone: 'Not found' };
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
      
      // Extract Selskapsform (company type) and Antall ansatte (employee count)
      // Using specific Proff.no HTML selectors
      let selskapsform = null;
      let antallAnsatte = null;
      
      // Method 1: Use specific Proff.no selectors (OfficialCompanyInformationCard)
      try {
        // Find all property containers in the official company info card
        const propertyContainers = document.querySelectorAll('.OfficialCompanyInformationCard-propertyList, [class*="OfficialCompanyInformationCard"]');
        
        propertyContainers.forEach(container => {
          const text = container.textContent || '';
          
          // Look for Selskapsform
          if (text.toLowerCase().includes('selskapsform') || text.toLowerCase().includes('organisasjonsform')) {
            // Find the property value element
            const valueElements = container.querySelectorAll('.OfficialCompanyInformationCard-propertyValue, [class*="propertyValue"]');
            valueElements.forEach(valueEl => {
              const value = valueEl.textContent?.trim();
              if (value && !selskapsform) {
                selskapsform = value;
              }
            });
          }
          
          // Look for Antall ansatte (employee count)
          if (text.toLowerCase().includes('antall ansatte') || text.toLowerCase().includes('ansatte')) {
            const valueElements = container.querySelectorAll('.OfficialCompanyInformationCard-propertyValue, [class*="propertyValue"]');
            valueElements.forEach(valueEl => {
              const value = valueEl.textContent?.trim();
              // Extract number from text like "5" or "5-10" or "10+"
              const numMatch = value?.match(/(\d+)/);
              if (numMatch && !antallAnsatte) {
                antallAnsatte = value;
              }
            });
          }
        });
        
        // Also try MuiGrid containers
        const muiGridContainers = document.querySelectorAll('.MuiGrid-root.MuiGrid-grid-xs-12.MuiGrid-grid-md-6');
        muiGridContainers.forEach(container => {
          const text = container.textContent || '';
          
          if (text.toLowerCase().includes('selskapsform') && !selskapsform) {
            const valueEl = container.querySelector('.OfficialCompanyInformationCard-propertyValue');
            if (valueEl) {
              selskapsform = valueEl.textContent?.trim();
            }
          }
          
          if (text.toLowerCase().includes('antall ansatte') && !antallAnsatte) {
            const valueEl = container.querySelector('.OfficialCompanyInformationCard-propertyValue');
            if (valueEl) {
              antallAnsatte = valueEl.textContent?.trim();
            }
          }
        });
      } catch (e) {
        // Continue to fallback methods
      }
      
      // Method 2: Fallback - text-based search
      if (!selskapsform) {
        const companyTypeLabels = ['Selskapsform', 'Organisasjonsform', 'Foretaksform'];
        
        for (const label of companyTypeLabels) {
          const labelIndex = bodyText.indexOf(label);
          if (labelIndex !== -1) {
            const afterLabel = bodyText.substring(labelIndex + label.length, labelIndex + label.length + 100);
            
            // Common Norwegian company types
            const companyTypes = [
              { pattern: 'enkeltpersonforetak', short: 'ENK' },
              { pattern: 'aksjeselskap', short: 'AS' },
              { pattern: 'ansvarlig selskap', short: 'ANS' },
              { pattern: 'delt ansvar', short: 'DA' },
              { pattern: 'norskregistrert utenlandsk foretak', short: 'NUF' },
              { pattern: 'samvirkeforetak', short: 'SA' },
              { pattern: 'allmennaksjeselskap', short: 'ASA' },
              { pattern: 'stiftelse', short: 'Stiftelse' }
            ];
            
            for (const type of companyTypes) {
              if (afterLabel.toLowerCase().includes(type.pattern)) {
                selskapsform = type.short;
                break;
              }
            }
            
            // If still not found, try to extract the raw value
            if (!selskapsform) {
              const rawMatch = afterLabel.match(/^\s*:?\s*([A-ZÆØÅa-zæøå\s]+)/);
              if (rawMatch && rawMatch[1].trim().length > 1) {
                selskapsform = rawMatch[1].trim();
              }
            }
            
            if (selskapsform) break;
          }
        }
      }
      
      // Method 3: Last resort - look for abbreviations
      if (!selskapsform) {
        const asMatch = bodyText.match(/\b(ENK|AS|ANS|DA|NUF|SA|ASA)\b/);
        if (asMatch) {
          selskapsform = asMatch[1];
        }
      }
      
      // Extract antall ansatte from text if not found via selectors
      if (!antallAnsatte) {
        const ansatteIndex = bodyText.indexOf('Antall ansatte');
        if (ansatteIndex !== -1) {
          const afterAnsatte = bodyText.substring(ansatteIndex + 14, ansatteIndex + 50);
          const numMatch = afterAnsatte.match(/(\d+[-–]?\d*\+?)/);
          if (numMatch) {
            antallAnsatte = numMatch[1];
          }
        }
      }
      
      return {
        contactPerson: contactPerson,
        businessPhone: businessPhone,
        selskapsform: selskapsform,
        antallAnsatte: antallAnsatte
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
    
    // Return contact person, business phone, selskapsform, and employee count
    const finalResult = {
      contactPerson: cleanedContactPerson || 'Not found',
      businessPhone: extractedData.businessPhone || 'Not found',
      selskapsform: extractedData.selskapsform || 'Not found',
      antallAnsatte: extractedData.antallAnsatte || 'Not found'
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
    
    if (extractedData.selskapsform) {
      console.log(`  🏢 Found selskapsform: ${extractedData.selskapsform}`);
    } else {
      console.log(`  ⚠️  No selskapsform found on Proff.no page`);
    }
    
    if (extractedData.antallAnsatte) {
      console.log(`  👥 Found antall ansatte: ${extractedData.antallAnsatte}`);
    } else {
      console.log(`  ⚠️  No employee count found on Proff.no page`);
    }
    
    return finalResult;
    
  } catch (error) {
    console.log(`  ❌ Error scraping Proff.no: ${error.message}`);
    return {
      contactPerson: 'Not found',
      businessPhone: 'Not found',
      selskapsform: 'Not found',
      antallAnsatte: 'Not found'
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
  
  // Browser launch function (reusable for restarts)
  const BROWSER_RESTART_INTERVAL = 100; // Restart browser every 100 businesses to prevent memory issues
  
  async function launchBrowser() {
    console.log('🌐 Launching browser...');
    const newBrowser = await puppeteer.launch({ 
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
  
  // START_FROM_INDEX: Set to skip already processed businesses (0 = start from beginning)
  const START_FROM_INDEX = 376; // Change this to resume from a specific point
  
  if (START_FROM_INDEX > 0) {
    console.log(`⏭️  Skipping first ${START_FROM_INDEX} businesses, starting at #${START_FROM_INDEX + 1}\n`);
    skippedCount = START_FROM_INDEX;
  }
  
  // Process each business
  for (const [index, business] of businessesToProcess.entries()) {
    // Skip to start index
    if (index < START_FROM_INDEX) {
      continue;
    }
    
    // Check if we should stop
    if (shouldStop) {
      console.log('\n⚠️  Stopping processing...');
      break;
    }
    const businessName = business.Name || business.name || 'Unknown';
    
    console.log(`\n[${index + 1}/${businessesToProcess.length}] 🔍 Processing: ${businessName}`);
    
    try {
      const result = await scrapeProffContactPerson(businessName, page);
      
      // Update the business object (which is a reference to data array when TEST_LIMIT is null)
      business['Contact Person'] = result.contactPerson;
      business['Business Phone'] = result.businessPhone;
      business['Selskapsform'] = result.selskapsform;
      business['Antall Ansatte'] = result.antallAnsatte;
      
      // Also update directly in data array to ensure it's saved (in case of reference issues)
      const dataIndex = data.findIndex(b => (b.Name || b.name) === businessName);
      if (dataIndex !== -1) {
        data[dataIndex]['Contact Person'] = result.contactPerson;
        data[dataIndex]['Business Phone'] = result.businessPhone;
        data[dataIndex]['Selskapsform'] = result.selskapsform;
        data[dataIndex]['Antall Ansatte'] = result.antallAnsatte;
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
      
      // Increment restart counter
      processedSinceRestart++;
      
      // Restart browser every 100 businesses to prevent memory issues
      if (processedSinceRestart >= BROWSER_RESTART_INTERVAL && index < businessesToProcess.length - 1 && !shouldStop) {
        console.log(`\n🔄 Restarting browser after ${BROWSER_RESTART_INTERVAL} businesses to prevent memory issues...`);
        try {
          await browser.close();
        } catch (e) {
          console.log(`  ⚠️  Error closing browser: ${e.message}`);
        }
        const newSession = await launchBrowser();
        browser = newSession.browser;
        page = newSession.page;
        processedSinceRestart = 0;
        console.log(`✅ Browser restarted successfully!\n`);
      }
      
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
      business['Selskapsform'] = 'Not found';
      business['Antall Ansatte'] = 'Not found';
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



