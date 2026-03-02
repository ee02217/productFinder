const puppeteer = require('puppeteer-core');
const fs = require('fs');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const BASE_URL = 'https://www.continente.pt';
const OUTPUT_FILE = '/Users/ee02217/.openclaw/workspace-richard/product-finder/categories-output.json';

async function scrapeCategories() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  
  console.log('Navigating to Continente...');
  await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  
  // Get all category links from the homepage
  const allLinks = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href]'));
    return links.map(l => ({
      href: l.getAttribute('href')?.split('?')[0], // Remove query params
      text: l.textContent?.trim()
    })).filter(l => l.href && l.href.includes('continente.pt/') && !l.href.includes('#'));
  });
  
  // Filter to only category links (main categories + subcategories)
  const categoryLinks = allLinks.filter(l => {
    const path = l.href.replace('https://www.continente.pt', '');
    return path.match(/^\/[a-z\-]+\/?$/)?.[0] || 
           path.match(/^\/[a-z\-]+\/[a-z\-]+\/?$/)?.[0] ||
           path.match(/^\/[a-z\-]+\/[a-z\-]+\/[a-z\-]+\/?$/)?.[0];
  });
  
  // Build tree
  const tree = {};
  const seen = new Set();
  
  categoryLinks.forEach(link => {
    if (seen.has(link.href)) return;
    seen.add(link.href);
    
    const path = link.href.replace('https://www.continente.pt', '');
    const parts = path.split('/').filter(p => p);
    
    if (parts.length >= 1) {
      const main = parts[0];
      const sub = parts[1] || null;
      const subsub = parts[2] || null;
      
      if (!tree[main]) tree[main] = {};
      if (sub) {
        if (!tree[main][sub]) tree[main][sub] = new Set();
        if (subsub) tree[main][sub].add(subsub);
      }
    }
  });
  
  // Convert to structured output
  const output = [];
  
  for (const [main, subs] of Object.entries(tree)) {
    const mainEntry = { 
      category: main, 
      subcategories: [] 
    };
    
    for (const [sub, subsubs] of Object.entries(subs)) {
      mainEntry.subcategories.push({ 
        name: sub, 
        subsubcategories: Array.from(subsubs).sort() 
      });
    }
    
    // Sort subcategories
    mainEntry.subcategories.sort((a, b) => a.name.localeCompare(b.name));
    output.push(mainEntry);
  }
  
  // Sort by category name
  output.sort((a, b) => a.category.localeCompare(b.category));
  
  // Save to file
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\nSaved ${output.length} main categories to ${OUTPUT_FILE}`);
  
  // Print summary
  console.log('\n=== CATEGORY TREE ===\n');
  output.forEach(main => {
    console.log(`## ${main.category}`);
    main.subcategories.forEach(sub => {
      console.log(`  - ${sub.name}`);
      sub.subsubcategories.forEach(ss => {
        console.log(`    - ${ss}`);
      });
    });
    console.log('');
  });
  
  await browser.close();
  return output;
}

scrapeCategories()
  .then(() => {
    console.log('Done!');
    process.exit(0);
  })
  .catch(err => { 
    console.error('Error:', err); 
    process.exit(1); 
  });
