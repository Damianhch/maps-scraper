# Anti-Detection & Proxy Setup Guide

## 🎯 Goal
Scrape 6000+ businesses across 30 industries over 24 hours without getting banned.

## ✅ What's Been Implemented

### 1. **IP Rotation (Proxy Support)**
- Automatic proxy rotation every 50 businesses
- Supports both authenticated and non-authenticated proxies
- Loads proxies from `proxies.txt` file

### 2. **Session Rotation**
- Creates new browser session every 100 businesses
- Prevents fingerprint accumulation
- Reduces detection risk

### 3. **Realistic Delays**
- **Between businesses**: 3-8 seconds (randomized)
- **Between scrolls**: 5-12 seconds (randomized)
- **Between industries**: 30-60 seconds (randomized)
- All delays are randomized to appear human-like

### 4. **Human Behavior Simulation**
- Random mouse movements
- Random scrolling patterns
- Gradual scrolling instead of instant jumps
- Human-like interaction delays

### 5. **Enhanced Anti-Detection**
- Modern Chrome user agent (v120)
- Realistic HTTP headers
- Browser fingerprinting evasion
- Webdriver property hidden
- Chrome runtime simulation

### 6. **Ban Recovery**
- Detects ban/block signals
- Automatically creates new session with new proxy
- Waits longer before retry (30-60 seconds)

## 📋 Setup Instructions

### Step 1: Get Proxies

**Option A: Residential Proxy Service (RECOMMENDED)**
- **Bright Data** (luminati.io) - Best quality, expensive
- **Oxylabs** - Good quality, mid-range price
- **Smartproxy** - Good balance
- **Proxy-Cheap** - Budget option

**Option B: Free/Cheap Proxies (NOT RECOMMENDED)**
- Free proxy lists (unreliable, often blocked)
- Datacenter proxies (easily detected)

**For 6000 businesses, you need:**
- Minimum: 10-20 proxies
- Recommended: 30-50 proxies
- Format: `ip:port` or `ip:port:username:password`

### Step 2: Create Proxy File

1. Copy `proxies.txt.example` to `proxies.txt`
2. Add your proxies, one per line:
   ```
   123.45.67.89:8080
   98.76.54.32:3128:myuser:mypass
   111.222.333.444:8080
   ```

### Step 3: Configure Settings

In `scraper.js`, adjust these settings:

```javascript
// Enable proxy rotation
const USE_PROXIES = true; // Set to true

// Proxy rotation frequency
const PROXY_ROTATION_INTERVAL = 50; // Rotate every 50 businesses

// Session rotation frequency  
const SESSION_ROTATION_INTERVAL = 100; // New browser every 100 businesses

// Delays (in milliseconds)
const MIN_DELAY_BETWEEN_REQUESTS = 3000; // 3 seconds minimum
const MAX_DELAY_BETWEEN_REQUESTS = 8000; // 8 seconds maximum
```

### Step 4: Test Run

1. Set `TEST_LIMIT = 10` for testing
2. Run: `node scraper.js`
3. Monitor for bans/blocks
4. Adjust delays if needed

### Step 5: Full Run

1. Set `TEST_LIMIT = null` for full scraping
2. Ensure you have enough proxies
3. Run: `node scraper.js`
4. Monitor progress and check for bans

## ⚙️ Configuration Options

### Delay Settings
- **MIN_DELAY_BETWEEN_REQUESTS**: Minimum wait between businesses (ms)
- **MAX_DELAY_BETWEEN_REQUESTS**: Maximum wait between businesses (ms)
- **MIN_DELAY_BETWEEN_SCROLLS**: Minimum wait between scrolls (ms)
- **MAX_DELAY_BETWEEN_SCROLLS**: Maximum wait between scrolls (ms)
- **MIN_DELAY_BETWEEN_INDUSTRIES**: Minimum wait between industries (ms)
- **MAX_DELAY_BETWEEN_INDUSTRIES**: Maximum wait between industries (ms)

### Rotation Settings
- **PROXY_ROTATION_INTERVAL**: How often to rotate IP (number of businesses)
- **SESSION_ROTATION_INTERVAL**: How often to create new browser session

## 🚨 Important Notes

### Google Detection Methods
Google uses multiple detection methods:
1. **IP Address**: Your public IP is always visible
2. **Browser Fingerprinting**: Canvas, WebGL, fonts, etc.
3. **Behavioral Patterns**: Request timing, mouse movements, scrolling
4. **Account Association**: If logged into Google account

### Risk Mitigation
✅ **DO:**
- Use residential proxies
- Enable proxy rotation
- Use realistic delays
- Never log into Google
- Monitor for bans

❌ **DON'T:**
- Scrape without proxies
- Use too short delays
- Scrape while logged in
- Ignore ban warnings

### If You Get Banned
1. The scraper will automatically try to recover
2. Wait 1-2 hours before retrying
3. Use different proxies
4. Increase delays
5. Consider using VPN + proxies

## 📊 Expected Performance

With proper setup:
- **200 businesses per industry** = ~30-45 minutes per industry
- **30 industries** = ~15-22 hours total
- **6000 businesses** = Achievable in 24 hours

## 🔧 Troubleshooting

### "No proxies found"
- Check `proxies.txt` file exists
- Verify proxy format is correct
- Check file permissions

### "Proxy connection failed"
- Verify proxy IP and port
- Check proxy authentication
- Test proxy manually

### "Still getting banned"
- Increase delays
- Use more proxies
- Rotate more frequently
- Use residential proxies instead of datacenter

### "Consent page keeps appearing"
- This is normal - script handles it automatically
- If it fails, manually accept and press Enter

## 💡 Pro Tips

1. **Start Slow**: Test with 1-2 industries first
2. **Monitor Closely**: Watch for ban patterns
3. **Adjust Delays**: If banned, increase delays
4. **Use Quality Proxies**: Residential > Datacenter
5. **Spread Out**: Don't scrape all at once if possible

## 📞 Support

If you encounter issues:
1. Check console logs for errors
2. Verify proxy configuration
3. Test proxies manually
4. Adjust delay settings
5. Check Google's current detection patterns

---

**Remember**: Even with all these measures, Google can still detect automation. The goal is to make it hard enough that you can complete your scraping before detection.

