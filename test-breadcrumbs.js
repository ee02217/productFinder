const puppeteer = require('puppeteer-core');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function testBreadcrumbs() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  
  // Test with product that has 3-level breadcrumbs
  const url = 'https://www.continente.pt/produto/tapioca-hidratada-sem-gluten-da-terrinha-da-terrinha-6207593.html';
  
  console.log('Loading:', url);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
  
  // Extract breadcrumbs
  const data = await page.evaluate(() => {
    // Try multiple selectors for breadcrumbs
    const selectors = [
      'nav[aria-label="Breadcrumb"] a, nav[aria-label="Breadcrumb"] span',
      '.breadcrumb a, .breadcrumb span',
      '[class*="breadcrumb"] a, [class*="breadcrumb"] span',
      'ul.breadcrumb li a, ul.breadcrumb li span',
    ];
    
    let breadcrumbs = [];
    for (const sel of selectors) {
      const els = document.querySelectorAll(sel);
      if (els.length >= 2) {
        breadcrumbs = Array.from(els).map(el => el.textContent.trim()).filter(t => t.length > 0);
        break;
      }
    }
    
    // Also try looking for any navigation with links containing category paths
    if (breadcrumbs.length < 2) {
      const allNavLinks = document.querySelectorAll('nav a[href*="/mercearia/"], nav a[href*="/frescos/"]');
      breadcrumbs = Array.from(allNavLinks).map(a => a.textContent.trim()).filter(t => t.length > 0 && t.length < 50);
    }
    
    return { breadcrumbs, count: breadcrumbs.length };
  });
  
  console.log('Breadcrumbs found:', JSON.stringify(data, null, 2));
  
  await browser.close();
}

testBreadcrumbs()
  .then(() => process.exit(0))
  .catch(err => { console.error(err); process.exit(1); });
