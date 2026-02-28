const express = require('express');
const { PrismaClient } = require('@prisma/client');
const puppeteer = require('puppeteer-core');

const router = express.Router();
const prisma = new PrismaClient();

// Chrome executable path - use system Chromium in Docker, host Chrome on Mac
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || 
  (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');

// Categories to scrape
const CATEGORIES = [
  { name: 'mercearia', url: '/mercearia/', label: 'Mercearia' },
  { name: 'frescos-frutas', url: '/frescos/frutas/', label: 'Frescos - Frutas' },
  { name: 'frescos-legumes', url: '/frescos/legumes/', label: 'Frescos - Legumes' },
  { name: 'frescos-talho', url: '/frescos/talho/', label: 'Frescos - Talho' },
  { name: 'frescos-peixaria', url: '/frescos/peixaria/', label: 'Frescos - Peixaria' },
  { name: 'laticinios', url: '/laticinios-e-ovos/', label: 'Laticínios e Ovos' },
  { name: 'congelados', url: '/congelados/', label: 'Congelados' },
  { name: 'bebidas', url: '/bebidas-e-garrafeira/', label: 'Bebidas' },
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

  const cat = CATEGORIES.find(c => c.name === category);
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

// Extract product data
async function extractProductData(page) {
  return await page.evaluate(() => {
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
    
    return {
      ean: eanMatch ? eanMatch[1] : null,
      name: nameEl ? nameEl.textContent.trim() : null,
      brand: brandEl ? brandEl.textContent.trim() : null,
      imageUrl: imgSrc,
      price: unitPrice || null,
      pricePerKg: pricePerKg || null,
      pvp: pvpPrice || null,
    };
  });
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
  const maxPages = limit > 0 ? Math.ceil(limit / pageSize) : 50; // Default max 50 pages

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
          
          const data = await extractProductData(page);

          if (data.ean && data.name) {
            // Upsert product
            const product = await prisma.product.upsert({
              where: { ean: data.ean },
              create: {
                ean: data.ean,
                name: data.name,
                brand: data.brand,
                category: category.label,
                imageUrl: data.imageUrl,
              },
              update: {
                name: data.name,
                brand: data.brand,
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
