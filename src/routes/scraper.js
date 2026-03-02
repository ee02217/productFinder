const express = require('express');
const { PrismaClient } = require('@prisma/client');
const puppeteer = require('puppeteer-core');

const router = express.Router();
const prisma = new PrismaClient();

// Chrome executable path - use system Chromium in Docker, host Chrome on Mac
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || 
  (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');

// Categories to scrape (main categories)
const CATEGORIES = [
  { name: 'mercearia', url: '/mercearia/', label: 'Mercearia' },
  { name: 'frescos-frutas', url: '/frescos/frutas/', label: 'Frescos - Frutas' },
  { name: 'frescos-legumes', url: '/frescos/legumes/', label: 'Frescos - Legumes' },
  { name: 'frescos-talho', url: '/frescos/talho/', label: 'Frescos - Talho' },
  { name: 'frescos-peixaria', url: '/frescos/peixaria/', label: 'Frescos - Peixaria' },
  { name: 'laticinios', url: '/laticinios-e-ovos/', label: 'Laticínios e Ovos' },
  { name: 'congelados', url: '/congelados/', label: 'Congelados' },
  { name: 'bebidas', url: '/bebidas-e-garrafeira/', label: 'Bebidas' },
  // Subcategories
  { name: 'mercearia/arroz-massa-e-farinha', url: '/mercearia/arroz-massa-e-farinha/', label: 'Arroz, Massa e Farinha' },
  { name: 'mercearia/azeite-oleo-e-vinagre', url: '/mercearia/azeite-oleo-e-vinagre/', label: 'Azeite, Óleo e Vinagre' },
  { name: 'mercearia/bolachas-biscoitos-e-tostas', url: '/mercearia/bolachas-biscoitos-e-tostas/', label: 'Bolachas, Biscoitos e Tostas' },
  { name: 'frescos/frutas', url: '/frescos/frutas/', label: 'Frutas' },
  { name: 'frescos/legumes', url: '/frescos/legumes/', label: 'Legumes' },
  { name: 'frescos/peixaria', url: '/frescos/peixaria/', label: 'Peixaria' },
  { name: 'frescos/talho', url: '/frescos/talho/', label: 'Talho' },
  { name: 'laticinios-e-ovos/leite', url: '/laticinios-e-ovos/leite/', label: 'Leite' },
  { name: 'laticinios-e-ovos/iogurtes', url: '/laticinios-e-ovos/iogurtes/', label: 'Iogurtes' },
  { name: 'congelados/gelados', url: '/congelados/gelados/', label: 'Gelados' },
];

const BASE_URL = 'https://www.continente.pt';
let isScraping = false;
let currentJob = null;

// Get categories
router.get('/categories', (req, res) => {
  res.json(CATEGORIES);
});

// Get scraper status
router.get('/status', (req, res) => {
  res.json({
    isScraping,
    currentJob,
  });
});

// Start scraping
router.post('/start', async (req, res) => {
  if (isScraping) {
    return res.status(400).json({ error: 'Scraping already in progress' });
  }

  const { category, limit = 0 } = req.body;
  
  // Get delay from settings
  const settings = await prisma.settings.findUnique({ where: { id: 'default' } });
  const delayMs = settings?.delayMs || 2000;

  // Check if category is a full URL, has a slash (subcategory), or just a name
  let cat;
  if (category.includes('/')) {
    // It's a subcategory path like "mercearia/arroz-massa-e-farinha"
    const parts = category.split('/');
    const mainCat = CATEGORIES.find(c => c.name === parts[0]);
    const subPath = parts.slice(1).join('/');
    cat = {
      name: category,
      url: '/' + category + '/',
      label: subPath.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    };
  } else if (category.startsWith('http') || category.startsWith('/')) {
    // It's a URL from discovered categories
    const url = category.startsWith('http') ? category : `https://www.continente.pt${category}`;
    const pathParts = url.split('/').filter(p => p);
    const categoryName = pathParts.find(p => 
      p.includes('mercearia') || p.includes('frescos') || p.includes('laticinios') || 
      p.includes('congelados') || p.includes('bebidas') || p.includes('limpeza')
    ) || pathParts[pathParts.length - 1];
    
    cat = { 
      name: categoryName, 
      url: '/' + category.replace(/^\/+/, '').replace(/\/+$/, ''),
      label: pathParts[pathParts.length - 1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    };
  } else {
    // It's a category name
    cat = CATEGORIES.find(c => c.name === category);
  }
  
  if (!cat) {
    return res.status(400).json({ error: 'Invalid category' });
  }

  // Create job
  const job = await prisma.scrapeJob.create({
    data: {
      category: cat.name,
      status: 'running',
      delayMs,
    },
  });

  currentJob = job;
  isScraping = true;

  // Start scraping in background
  scrapeCategory(cat, parseInt(limit), delayMs).then(() => {
    isScraping = false;
    currentJob = null;
  }).catch(err => {
    console.error('Scraping error:', err);
    isScraping = false;
    currentJob = null;
  });

  res.json({ jobId: job.id, status: 'started' });
});

// Stop scraping
router.post('/stop', async (req, res) => {
  isScraping = false;
  res.json({ status: 'stopping' });
});

// Parse price to cents
function parsePrice(priceStr) {
  if (!priceStr) return null;
  const cleaned = priceStr.replace(/[^\d,]/g, '').replace(',', '.');
  const price = parseFloat(cleaned);
  return Math.round(price * 100);
}

// Extract product data - accepts category info from listing page
async function extractProductData(page, categoryInfo = null) {
  const currentUrl = page.url || '';
  const result = await page.evaluate((url, catInfo) => {
    const eanMatch = document.body.innerHTML.match(/ean=([0-9]{13})/);
    const nameEl = document.querySelector('h1');
    const brandEl = document.querySelector('a[href*="/pesquisa/"]');
    // Find product image - largest image that's not a logo/footer
    const allImgs = Array.from(document.querySelectorAll('img')).filter(img => 
      img.src && img.src.length > 50 && !img.src.includes('logo') && !img.src.includes('footer')
    );
    const withSize = allImgs.map(img => ({
      src: img.src,
      width: img.width || img.naturalWidth || 0,
      alt: img.alt || ''
    })).filter(img => img.width > 100);
    const productImg = withSize.find(img => img.alt && img.alt.length > 5) || withSize[0];
    const imgSrc = productImg ? productImg.src : null;
    
    // Extract breadcrumbs from product page
    let breadcrumbs = [];
    
    // Look for breadcrumb navigation - be specific
    const breadcrumbNav = document.querySelector('nav[aria-label="Breadcrumb"]');
    if (breadcrumbNav) {
      const links = breadcrumbNav.querySelectorAll('a, span');
      const items = Array.from(links).map(el => el.textContent.trim()).filter(t => t.length > 0 && t.length < 60);
      // Filter out "Página inicial" and home-related text, and partial category names
      const filtered = items.filter(t => 
        !t.toLowerCase().includes('página inicial') && 
        !t.toLowerCase().includes('home') &&
        t !== 'Arroz' && t !== 'Massa' && t !== 'Farinha'  // Skip partial matches
      );
      // Keep unique in order - take first 3
      const unique = [];
      for (const item of filtered) {
        if (!unique.includes(item)) unique.push(item);
        if (unique.length >= 3) break;
      }
      breadcrumbs = unique;
    }
    
    // If no breadcrumbs found, try to extract from category links in page
    if (breadcrumbs.length < 2) {
      const categoryLinks = document.querySelectorAll('a[href*="/mercearia/"], a[href*="/frescos/"], a[href*="/laticinios"], a[href*="/congelados/"], a[href*="/bebidas"]');
      const linkBreadcrumbs = [];
      categoryLinks.forEach(a => {
        const text = a.textContent.trim();
        // Skip partial category names
        if (text.length > 5 && text.length < 50 && 
            text !== 'Arroz' && text !== 'Massa' && text !== 'Farinha' &&
            !linkBreadcrumbs.includes(text)) {
          linkBreadcrumbs.push(text);
        }
      });
      if (linkBreadcrumbs.length >= 2) {
        breadcrumbs = linkBreadcrumbs.slice(0, 3);
      }
    }
    
    console.log('BREADCRUMBS DEBUG:', JSON.stringify(breadcrumbs));
    
    // Get all text content
    let text = document.body.innerText;
    
    // Handle split prices: "1\n,72€" -> "1,72€"
    const lines = text.split('\n');
    let fixedLines = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Handle ",99€" -> "0,99€" (missing leading zero)
      if (line.match(/^,\d.*€/)) {
        fixedLines.push('0' + line);
        continue;
      }
      
      // If current line is just a number and next line starts with "," and ends with "€"
      if (line.match(/^\d+$/) && i + 1 < lines.length) {
        const next = lines[i + 1].trim();
        if (next.match(/^,\d.*€/)) {
          fixedLines.push(line + next);
          i++; // skip next
          continue;
        }
      }
      
      // If current line has price and next is "/kg"
      if (line.match(/^\d+[\s,]\d+.*$/) && i + 1 < lines.length) {
        const next = lines[i + 1].trim();
        if (next === '/kg' || next.startsWith('/kg')) {
          fixedLines.push(line + '€/kg');
          i++;
          continue;
        }
      }
      
      fixedLines.push(line);
    }
    text = fixedLines.join(' ');
    
    // Find all price positions
    const priceMatches = [...text.matchAll(/(\d+[\s,]\d{2})\s*€/g)];
    
    let unitPrice = null;
    let pricePerKg = null;
    let pvpPrice = null;
    
    // Check each price match to determine type
    for (const match of priceMatches) {
      const priceValue = match[1];
      const endPos = match.index + match[0].length;
      // Use smaller window to check immediate context
      const beforeText = text.substring(Math.max(0, match.index - 6), match.index).toUpperCase();
      const afterText = text.substring(endPos, endPos + 6).toUpperCase().replace(/\s+/g, '');
      
      // Skip if this is a PVPR/PVP price (original price before discount)
      if (beforeText.includes('PVPR') || beforeText.includes('PVP')) {
        if (!pvpPrice) pvpPrice = priceValue;
        continue;
      }
      
      // Price per kg if followed by /kg AND not preceded by PVPR/PVP
      if (afterText.startsWith('/KG')) {
        pricePerKg = priceValue;
      } else if (!unitPrice) {
        // This is the unit price (first price not marked as per-kg or PVP)
        unitPrice = priceValue;
      }
    }
    
    // If no unit price found, use the first non-PVPR price
    if (!unitPrice && priceMatches.length > 0) {
      unitPrice = priceMatches[0][1];
    }
    
    // PVP (original price when on discount): "PVPR 3,15€"
    const pvpMatch = text.match(/PVPR\s*(\d+[\s,]\d{2})\s*€/);
    
    // Extract category from URL
    const pageUrl = url || '';
    const categoryMap = {
      // Main categories
      'mercearia': 'Mercearia', 'frescos': 'Frescos', 'frescos-frutas': 'Frescos',
      'frescos-legumes': 'Frescos', 'frescos-talho': 'Frescos', 'frescos-peixaria': 'Frescos',
      'laticinios-e-ovos': 'Laticínios', 'congelados': 'Congelados', 'bebidas-e-garrafeira': 'Bebidas',
      // Subcategory paths (key = path part, value = parent category)
      'arroz-massa-e-farinha': 'Mercearia', 'azeite-oleo-e-vinagre': 'Mercearia',
      'bolachas-biscoitos-e-tostas': 'Mercearia', 'cafe-cha-e-bebidas-soluveis': 'Mercearia',
      'cereais-e-barras': 'Mercearia', 'chocolate-gomas-e-rebucados': 'Mercearia',
      'conservas': 'Mercearia', 'molhos-temperos-e-sal': 'Mercearia', 'snacks-e-batatas-fritas': 'Mercearia',
      // Frescos subcategories
      'frutas': 'Frescos', 'legumes': 'Frescos', 'peixaria': 'Frescos', 'talho': 'Frescos',
      'charcutaria': 'Frescos', 'queijos': 'Frescos', 'padaria-e-pastelaria': 'Frescos',
      // Laticinios subcategories
      'leite': 'Laticínios', 'iogurtes': 'Laticínios', 'natas-e-bechamel': 'Laticínios',
      'bebidas-vegetais': 'Laticínios', 'manteigas-e-cremes-para-barrar': 'Laticínios',
      // Congelados subcategories
      'gelados': 'Congelados', 'pizzas': 'Congelados', 'refeicoes-prontas': 'Congelados',
    };
    
    const mainCategories = ['mercearia', 'frescos', 'laticinios-e-ovos', 'congelados', 'bebidas-e-garrafeira'];
    
    // Use category info from listing page if available
    // catInfo is passed as second argument to evaluate
    const catPath = catInfo && catInfo.category ? catInfo.category : '';
    
    // Use the listing category info - this is reliable
    // catInfo contains the category path like "mercearia/arroz-massa-e-farinha"
    let productCategory = null, productSubcategory = null, productSubsubcategory = null;
    
    if (catPath && catPath.includes('/')) {
      const parts = catPath.split('/');
      // Map URL path to display names
      const pathToName = {
        'mercearia': 'Mercearia',
        'frescos': 'Frescos',
        'laticinios-e-ovos': 'Laticínios',
        'congelados': 'Congelados',
        'bebidas-e-garrafeira': 'Bebidas',
        'arroz-massa-e-farinha': 'Arroz, Massa e Farinha',
        'farinha-e-pao-ralado': 'Farinha e Pão Ralado',
        'frutas': 'Frutas',
        'legumes': 'Legumes',
        'peixaria': 'Peixaria',
        'talho': 'Talho',
        'charcutaria': 'Charcutaria',
        'queijos': 'Queijos',
        'leite': 'Leite',
        'iogurtes': 'Iogurtes',
        'gelados': 'Gelados',
      };
      
      // First part is main category
      if (parts[0] && pathToName[parts[0]]) {
        productCategory = pathToName[parts[0]];
      }
      // Second part is subcategory
      if (parts[1] && pathToName[parts[1]]) {
        productSubcategory = pathToName[parts[1]];
      }
      // Third part is subsubcategory
      if (parts[2] && pathToName[parts[2]]) {
        productSubsubcategory = pathToName[parts[2]];
      }
    }
    
    return {
      ean: eanMatch ? eanMatch[1] : null,
      name: nameEl ? nameEl.textContent.trim() : null,
      brand: brandEl ? brandEl.textContent.trim() : null,
      imageUrl: imgSrc,
      category: productCategory,
      subcategory: productSubcategory,
      subsubcategory: productSubsubcategory,
      breadcrumbs: breadcrumbs,
      price: unitPrice || null,
      pricePerKg: pricePerKg || null,
      pvp: pvpPrice || null,
    };
  }, currentUrl, categoryInfo);

  return result;
}

// Get product links from category
async function getProductLinks(page, categoryUrl, maxProducts = 0) {
  const allLinks = new Set();
  let start = 0;
  const pageSize = 48;

  while (isScraping) {
    const url = `${BASE_URL}${categoryUrl}?start=${start}&srule=FOOD&pmin=0.01`;
    
    // Retry logic for category pages
    let success = false;
    for (let retry = 0; retry < 3 && !success; retry++) {
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
        success = true;
      } catch (err) {
        if (retry < 2) {
          console.log(`  Category page retry ${retry + 1}...`);
          await new Promise(r => setTimeout(r, 3000));
        } else {
          throw err;
        }
      }
    }

    const links = await page.evaluate(() => {
      const productLinks = document.querySelectorAll('a[href*="/produto/"]');
      return Array.from(productLinks)
        .map(a => a.href)
        .filter(href => href.includes('/produto/') && href.endsWith('.html'));
    });

    links.forEach(link => allLinks.add(link));

    if (allLinks.size >= maxProducts && maxProducts > 0) break;
    if (links.length === 0) break;
    
    start += pageSize;
    if (start > 10000) break;
    
    // Update job progress
    if (currentJob) {
      await prisma.scrapeJob.update({
        where: { id: currentJob.id },
        data: { scraped: allLinks.size },
      });
    }
  }

  const linksArray = Array.from(allLinks);
  return maxProducts > 0 ? linksArray.slice(0, maxProducts) : linksArray;
}

// Main scraping function - streaming approach: scrape as we discover
async function scrapeCategory(category, limit, delayMs) {
  console.log(`Starting scrape: ${category.label}`);
  
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

  let start = 0;
  const pageSize = 48;
  let scraped = 0;
  let errors = 0;
  let productLinks = [];
  const maxPages = limit > 0 ? Math.ceil(limit / pageSize) : 150; // Default max 150 pages (~7,200 products)

  // Scrape as we discover links (streaming)
  for (let pageNum = 1; pageNum <= maxPages && isScraping; pageNum++) {
    const url = `${BASE_URL}${category.url}?start=${start}&srule=FOOD&pmin=0.01`;
    console.log(`  Page ${pageNum}: ${url}`);
    
    try {
      // Retry logic
      let success = false;
      for (let retry = 0; retry < 3 && !success; retry++) {
        try {
          await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
          success = true;
        } catch (err) {
          if (retry < 2) {
            console.log(`    Retry ${retry + 1}...`);
            await new Promise(r => setTimeout(r, 3000));
          } else {
            throw err;
          }
        }
      }
      
      // Extract product links from this page
      productLinks = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="/produto/"]');
        return Array.from(links)
          .map(a => a.href)
          .filter(href => href.includes('/produto/') && href.endsWith('.html'));
      });
      
      console.log(`    Found ${productLinks.length} products`);
      
      // Scrape each product from this page
      for (const url of productLinks) {
        if (!isScraping) break;
        if (limit > 0 && scraped >= limit) break;
        
        try {
          // Navigate to product page
          success = false;
          for (let retry = 0; retry < 3 && !success; retry++) {
            try {
              await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
              success = true;
            } catch (err) {
              if (retry < 2) {
                await new Promise(r => setTimeout(r, 2000));
              } else {
                throw err;
              }
            }
          }
          
          const data = await extractProductData(page, { category: category.name, label: category.label });
          console.log('EXTRACTED breadcrumbs:', JSON.stringify(data.breadcrumbs), 'category:', data.category, 'sub:', data.subcategory, 'subsub:', data.subsubcategory);

          if (data.ean && data.name) {
            // Upsert product
            const product = await prisma.product.upsert({
              where: { ean: data.ean },
              create: {
                ean: data.ean,
                name: data.name,
                brand: data.brand,
                category: data.category || category.label,
                subcategory: data.subcategory,
                subsubcategory: data.subsubcategory,
                imageUrl: data.imageUrl,
              },
              update: {
                name: data.name,
                brand: data.brand,
                category: data.category || category.label,
                subcategory: data.subcategory,
                subsubcategory: data.subsubcategory,
                imageUrl: data.imageUrl,
              },
            });

            // Add price
            if (data.price) {
              await prisma.price.create({
                data: {
                  productId: product.id,
                  priceCents: parsePrice(data.price),
                  pricePerKgCents: data.pricePerKg ? parsePrice(data.pricePerKg) : null,
                  pvpCents: data.pvp ? parsePrice(data.pvp) : null,
                },
              });
            }

            scraped++;
          } else {
            errors++;
          }
        } catch (err) {
          console.log(`    Error scraping ${url}: ${err.message}`);
          errors++;
        }
        
        // Update progress
        if (currentJob) {
          currentJob = await prisma.scrapeJob.update({
            where: { id: currentJob.id },
            data: { scraped, errors },
          });
        }
        
        // Rate limiting
        await new Promise(r => setTimeout(r, delayMs));
      }
      
    } catch (err) {
      console.log(`  Error on page ${pageNum}: ${err.message}`);
    }
    
    if (productLinks.length === 0) break;
    start += pageSize;
    
    // Check if we hit limit
    if (limit > 0 && scraped >= limit) break;
  }

  // Mark job complete
  if (currentJob) {
    await prisma.scrapeJob.update({
      where: { id: currentJob.id },
      data: { 
        status: 'completed',
        completedAt: new Date(),
        scraped,
        errors,
      },
    });
  }

  await browser.close();
  console.log(`Completed scrape: ${scraped} products, ${errors} errors`);

}

module.exports = router;

