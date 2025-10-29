# Google Sheets Setup Guide

## Step 1: Create Google Cloud Project
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use existing one)
3. Note your project ID

## Step 2: Enable Google Sheets API
1. Go to "APIs & Services" > "Library"
2. Search for "Google Sheets API"
3. Click on it and press "Enable"

## Step 3: Create Service Account
1. Go to "APIs & Services" > "Credentials"
2. Click "Create Credentials" > "Service Account"
3. Give it a name (e.g., "scraper-service")
4. Click "Create and Continue"
5. Skip optional steps and click "Done"

## Step 4: Create Credentials
1. Click on your service account
2. Go to "Keys" tab
3. Click "Add Key" > "Create new key"
4. Choose "JSON" format
5. Download the JSON file
6. Rename it to `credentials.json`
7. Place it in your project folder (same folder as scraper.js)

## Step 5: Create Google Sheet
1. Go to [Google Sheets](https://sheets.google.com)
2. Create a new sheet
3. Copy the Sheet ID from the URL (the long string between `/d/` and `/edit`)
4. Example: `https://docs.google.com/spreadsheets/d/1ABC123DEF456GHI789JKL/edit`
   - Sheet ID is: `1ABC123DEF456GHI789JKL`

## Step 6: Share Sheet with Service Account
1. In your Google Sheet, click "Share" button
2. Add the email from your credentials.json file
   - It looks like: `scraper-service@your-project.iam.gserviceaccount.com`
3. Give it "Editor" permissions
4. Click "Send"

## Step 7: Update the Script
1. Open `scraper.js`
2. Find the line: `const SHEET_ID = 'YOUR_SHEET_ID_HERE';`
3. Replace `YOUR_SHEET_ID_HERE` with your actual Sheet ID
4. Save the file

## Step 8: Run the Scraper
```bash
node scraper.js
```

The data will be automatically saved to your Google Sheet!

## Troubleshooting
- Make sure `credentials.json` is in the same folder as `scraper.js`
- Make sure the service account email has access to the sheet
- Make sure the Sheet ID is correct
- Check that Google Sheets API is enabled in your project
