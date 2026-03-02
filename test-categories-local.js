const puppeteer = require('puppeteer-core');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE_URL = 'https://www.continente.pt';

async function scrapeCategories() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  
  console.log('Navigating to Continente homepage...');
  await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  
  // Wait for page to fully load
  await new Promise(r => setTimeout(r, 5000));
  
  // Try to find the "Produtos" menu button and click it
  console.log('Looking for Produtos menu...');
  
  // Try various selectors to find the menu
  const menuSelectors = [
    'a[href*="/produtos"]',
    'button:contains("Produtos")',
    '[class*="menu"] a[href*="produtos"]',
    'nav a[href*="produtos"]',
  ];
  
  let menuFound = false;
  for (const sel of menuSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        console.log(`Found menu element: ${sel}`);
        menuFound = true;
        break;
      }
    } catch(e) {}
  }
  
  // Get all links on page
  const allLinks = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href]'));
    return links.map(l => ({
      href: l.getAttribute('href'),
      text: l.textContent?.trim().substring(0, 60)
    })).filter(l => l.href && l.href.includes('continente.pt'));
  });
  
  console.log(`Total links: ${allLinks.length}`);
  
  // Show first 30 links
  console.log('\nFirst 30 links:');
  allLinks.slice(0, 30).forEach(l => console.log(`  ${l.href} - ${l.text}`));
  
  await browser.close();
}

scrapeCategories()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
