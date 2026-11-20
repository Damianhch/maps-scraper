/**
 * Extract phone from Google Maps place panel (Norwegian layout).
 * Primary source: button.CsEnBe with data-item-id="phone:tel:XXXXXXXX"
 */

function normalizeScrapedPhone(value) {
  if (value == null || value === 'null' || value === 'undefined') {
    return 'Not found';
  }
  const trimmed = String(value).trim();
  if (!trimmed || trimmed === 'Not found' || /kopiér|kopier|telefonnummeret/i.test(trimmed)) {
    return 'Not found';
  }
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 8) return 'Not found';
  return trimmed;
}

/** Runs in browser context on the Maps place page. */
function extractPhoneInPage() {
  const formatFromDigits = (raw) => {
    let d = String(raw).replace(/\D/g, '');
    if (d.startsWith('47') && d.length > 8) d = d.slice(-8);
    if (d.length === 8) {
      return `${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4, 6)} ${d.slice(6, 8)}`;
    }
    if (d.length >= 8) return d;
    return null;
  };

  const fromDisplayText = (text) => {
    const t = (text || '').trim();
    if (!t || /kopiér|kopier/i.test(t)) return null;
    const digits = t.replace(/\D/g, '');
    if (digits.length < 8) return null;
    if (/^\d[\d\s]+$/.test(t)) return t.replace(/\s+/g, ' ').trim();
    return formatFromDigits(digits);
  };

  const fromAriaLabel = (label) => {
    const m = (label || '').match(/(?:Telefon|Phone|Ring)\s*:\s*([\d\s+()-]{8,})/i);
    if (m) return fromDisplayText(m[1]);
    return null;
  };

  const tryButton = (btn) => {
    if (!btn) return null;

    const itemId = btn.getAttribute('data-item-id') || '';
    const telInId = itemId.match(/^phone:tel:(\d+)/i);
    if (telInId) {
      const formatted = formatFromDigits(telInId[1]);
      if (formatted) return formatted;
    }

    const fromLabel = fromAriaLabel(btn.getAttribute('aria-label'));
    if (fromLabel) return fromLabel;

    const io = btn.querySelector('.Io6YTe.fontBodyMedium, .Io6YTe');
    if (io) {
      const fromIo = fromDisplayText(io.textContent);
      if (fromIo) return fromIo;
    }

    return null;
  };

  // 1) Standard Maps phone button (CsEnBe + phone:tel:)
  const primary = document.querySelectorAll(
    'button.CsEnBe[data-item-id^="phone:tel:"], button[data-item-id^="phone:tel:"]'
  );
  for (const btn of primary) {
    const hit = tryButton(btn);
    if (hit) return hit;
  }

  // 2) Same panel, aria-label Telefon:/Phone: without tel id variant
  const labeled = document.querySelectorAll(
    'button.CsEnBe[aria-label*="Telefon"], button.CsEnBe[aria-label*="Phone"], button[aria-label*="Telefon:"], button[aria-label*="Phone:"]'
  );
  for (const btn of labeled) {
    const hit = tryButton(btn);
    if (hit) return hit;
  }

  return null;
}

async function extractPhoneFromGoogleMapsPage(page) {
  try {
    await page
      .waitForSelector(
        'button[data-item-id^="phone:tel:"], button.CsEnBe[aria-label*="Telefon"], button.CsEnBe[aria-label*="Phone"]',
        { timeout: 4000 }
      )
      .catch(() => {});

    const raw = await page.evaluate(extractPhoneInPage);
    const phone = normalizeScrapedPhone(raw);
    return phone;
  } catch (error) {
    console.log('Could not extract phone:', error.message);
    return 'Not found';
  }
}

module.exports = {
  normalizeScrapedPhone,
  extractPhoneFromGoogleMapsPage,
  extractPhoneInPage,
};
