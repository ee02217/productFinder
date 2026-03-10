const { CHROME_PATH, DEFAULTS } = require('./constants');
const puppeteer = require('puppeteer-core');

let sharedBrowser = null;

async function getBrowser() {
  if (!sharedBrowser) {
    sharedBrowser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return sharedBrowser;
}

async function closeBrowser() {
  if (sharedBrowser) {
    await sharedBrowser.close();
    sharedBrowser = null;
  }
}

async function fetchPage(url, options = {}) {
  const {
    timeoutMs = DEFAULTS.timeoutMs,
    retries = DEFAULTS.retries,
    retryBaseMs = DEFAULTS.retryBaseMs,
    waitUntil = 'networkidle2',
  } = options;

  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setUserAgent(DEFAULTS.userAgent);

  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await page.goto(url, { waitUntil, timeout: timeoutMs });
      return page;
    } catch (err) {
      lastError = err;
      if (attempt < retries - 1) {
        await new Promise(r => setTimeout(r, retryBaseMs));
      }
    }
  }

  await page.close();
  throw lastError;
}

async function fetchHtml(url, options = {}) {
  const page = await fetchPage(url, options);
  const html = await page.content();
  await page.close();
  return html;
}

async function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  getBrowser,
  closeBrowser,
  fetchPage,
  fetchHtml,
  delay,
};
