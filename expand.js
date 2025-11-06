const puppeteer = require('puppeteer');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');

// Function to scrape Proff.no for contact person/owner name
async function scrapeProffContactPerson(businessName, page) {
  try {
    // URL encode the business name for the search
    const encodedName = encodeURIComponent(businessName);
    const searchUrl = `https://www.proff.no/bransjes%C3%B8k?q=${encodedName}`;
    
    console.log(`  Searching Proff.no for: ${businessName}`);
    
    // Navigate to Proff.no search page
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 15000 });
    
    // Wait a bit for the page to load
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Find the first result link
    const firstResult = await page.evaluate(() => {
      // Try multiple selectors for the first result
      const selectors = [
        '.mui-105wgyd',
        'a[href*="/bedrift/"]',
        '.search-result a',
        '[data-testid="company-link"]'
      ];
      
      for (const selector of selectors) {
        const resultElement = document.querySelector(selector);
        if (resultElement) {
          const href = resultElement.href || resultElement.getAttribute('href');
          if (href) {
            return href.startsWith('http') 
              ? href 
              : `https://www.proff.no${href}`;
          }
        }
      }
      return null;
    });
    
    if (!firstResult) {
      console.log(`  ⚠️  No Proff.no results found for: ${businessName}`);
      return 'Not found';
    }
    
    console.log(`  Found Proff.no page: ${firstResult}`);
    
    // Navigate to the company page
    await page.goto(firstResult, { waitUntil: 'networkidle2', timeout: 15000 });
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Extract the contact person name
    const contactPerson = await page.evaluate(() => {
      // Try multiple selectors for contact person
      const selectors = [
        '.mui-1m20kv8',
        '[data-testid="contact-person"]',
        '.contact-person',
        '.kontaktperson',
        'h2:contains("Kontaktperson")',
        'div:contains("Kontaktperson")'
      ];
      
      for (const selector of selectors) {
        const contactElement = document.querySelector(selector);
        if (contactElement) {
          const text = contactElement.textContent?.trim();
          if (text && text.length > 0 && !text.includes('Kontaktperson')) {
            return text;
          }
        }
      }
      
      // Try to find any name-like element near "Kontaktperson" text
      const allText = document.body.innerText;
      const kontaktIndex = allText.indexOf('Kontaktperson');
      if (kontaktIndex !== -1) {
        // Look for text after "Kontaktperson"
        const afterKontakt = allText.substring(kontaktIndex + 13, kontaktIndex + 100);
        const lines = afterKontakt.split('\n').filter(line => line.trim().length > 0);
        if (lines.length > 0) {
          const potentialName = lines[0].trim();
          // Basic validation: looks like a name (has letters, not too long)
          if (/^[A-Za-zÆØÅæøå\s-]+$/.test(potentialName) && potentialName.length < 50) {
            return potentialName;
          }
        }
      }
      
      return null;
    });
    
    if (contactPerson) {
      console.log(`  ✅ Found contact person: ${contactPerson}`);
      return contactPerson;
    } else {
      console.log(`  ⚠️  No contact person found on Proff.no page`);
      return 'Not found';
    }
    
  } catch (error) {
    console.log(`  ❌ Error scraping Proff.no: ${error.message}`);
    return 'Not found';
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
  
  // Check if Contact Person column exists, if not add it
  const hasContactPersonColumn = data.length > 0 && 'Contact Person' in data[0];
  if (!hasContactPersonColumn) {
    console.log('📝 Adding "Contact Person" column to data...');
    data.forEach(row => {
      if (!row['Contact Person']) {
        row['Contact Person'] = 'Not found';
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
  
  // Process each business
  for (const [index, business] of data.entries()) {
    const businessName = business.Name || business.name || 'Unknown';
    const currentContactPerson = business['Contact Person'] || business['contact person'] || '';
    
    // Skip if contact person already exists and is not "Not found"
    if (currentContactPerson && currentContactPerson !== 'Not found' && currentContactPerson.trim().length > 0) {
      console.log(`\n[${index + 1}/${data.length}] ⏭️  Skipping ${businessName} - Already has contact person: ${currentContactPerson}`);
      skippedCount++;
      continue;
    }
    
    console.log(`\n[${index + 1}/${data.length}] 🔍 Processing: ${businessName}`);
    
    try {
      const contactPerson = await scrapeProffContactPerson(businessName, page);
      
      // Update the data
      business['Contact Person'] = contactPerson;
      
      if (contactPerson !== 'Not found') {
        foundCount++;
        updatedCount++;
      } else {
        notFoundCount++;
        updatedCount++;
      }
      
      // Rate limiting: wait 2-3 seconds between requests
      if (index < data.length - 1) {
        const delay = Math.random() * 1000 + 2000; // 2-3 seconds
        console.log(`  ⏳ Waiting ${Math.round(delay)}ms before next request...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
      
    } catch (error) {
      console.error(`  ❌ Error processing ${businessName}: ${error.message}`);
      business['Contact Person'] = 'Not found';
      updatedCount++;
      notFoundCount++;
    }
  }
  
  console.log('\n🌐 Closing browser...');
  await browser.close();
  
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
  
  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 EXPANSION SUMMARY');
  console.log('='.repeat(60));
  console.log(`Total businesses: ${data.length}`);
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

