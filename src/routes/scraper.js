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

const PATH_TO_NAME = {
  'mercearia': 'Mercearia', 'frescos': 'Frescos', 'laticinios-e-ovos': 'Laticínios',
  'congelados': 'Congelados', 'bebidas-e-garrafeira': 'Bebidas E Garrafeira',
  'limpeza': 'Limpeza', 'higiene': 'Higiene', 'bebe': 'Bebé',
  'animais': 'Animais', 'bio-e-saudavel': 'Bio e Saudável',
  'cao': 'Cão', 'gato': 'Gato', 'frutas': 'Frutas', 'legumes': 'Legumes',
  'peixaria': 'Peixaria', 'talho': 'Talho', 'charcutaria': 'Charcutaria', 'queijos': 'Queijos',
  'leite': 'Leite', 'iogurtes': 'Iogurtes', 'gelados': 'Gelados',
};

function normalizeCategoryPath(categoryInput) {
  let category = String(categoryInput || '');
  if (category.startsWith('http')) {
    try {
      const url = new URL(category);
      category = url.pathname;
    } catch (_) {}
  }
  const cleanPath = category.replace(/^\/+/, '').replace(/\/+$/, '');
  return cleanPath ? ('/' + cleanPath + '/') : '/';
}

async function buildCategoryDescriptor(categoryInput) {
  const normalizedPath = normalizeCategoryPath(categoryInput);
  const cleanPath = normalizedPath.replace(/^\/+/, '').replace(/\/+$/, '');

  // Prefer database category mapping (respects admin edits)
  const dbCategory = await prisma.category.findFirst({
    where: {
      OR: [
        { urlPath: normalizedPath },
        { urlPath: normalizedPath.replace(/\/$/, '') },
      ],
    },
    include: { parent: true },
  });

  if (dbCategory) {
    return {
      name: cleanPath || dbCategory.name,
      url: normalizedPath,
      label: dbCategory.label,
      mainCategory: dbCategory.level === 1 ? dbCategory.label : (dbCategory.parent?.label || dbCategory.label),
    };
  }

  // Fallback: derive from URL/name using slug map
  if (cleanPath.includes('/')) {
    const parts = cleanPath.split('/');
    const mainCatKey = parts[0];
    const mainCatName = PATH_TO_NAME[mainCatKey] || mainCatKey.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const subCatName = parts[1]
      ? (PATH_TO_NAME[parts[1]] || parts[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()))
      : mainCatName;

    return {
      name: cleanPath,
      url: normalizedPath,
      label: subCatName,
      mainCategory: mainCatName,
    };
  }

  return CATEGORIES.find(c => c.name === cleanPath) || {
    name: cleanPath,
    url: normalizedPath,
    label: cleanPath,
  };
}

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

// Get queue (all jobs)
router.get('/queue', async (req, res) => {
  try {
    const jobs = await prisma.scrapeJob.findMany({
      orderBy: { startedAt: 'desc' },
      take: 50,
    });
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add to queue (creates pending jobs without starting)
router.post('/queue', async (req, res) => {
  try {
    const { categories, limit = 0 } = req.body;
    if (!categories || !Array.isArray(categories)) {
      return res.status(400).json({ error: 'categories array required' });
    }

    const parsedLimit = Number.isFinite(parseInt(limit, 10)) ? parseInt(limit, 10) : 0;
    const settings = await prisma.settings.findUnique({ where: { id: 'default' } });
    const delayMs = settings?.delayMs || 2000;

    // Create pending jobs for each category
    const jobs = [];
    for (const cat of categories) {
      const job = await prisma.scrapeJob.create({
        data: {
          category: cat.value,
          label: cat.label,
          limit: parsedLimit,
          cursorStart: 0,
          status: 'pending',
          delayMs,
        },
      });
      jobs.push(job);
    }
    
    // Trigger queue processor if not already running
    if (!isScraping) {
      processQueue();
    }
    
    res.json({ jobs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resume a specific interrupted job
router.post('/resume/:id', async (req, res) => {
  try {
    if (isScraping) {
      return res.status(400).json({ error: 'Scraper is already running' });
    }

    const job = await prisma.scrapeJob.findUnique({ where: { id: req.params.id } });
    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status === 'completed') {
      return res.status(400).json({ error: 'Job already completed' });
    }

    isScraping = true;
    currentJob = job;

    const runningJob = await prisma.scrapeJob.update({
      where: { id: job.id },
      data: { status: 'running', completedAt: null },
    });
    currentJob = runningJob;

    const cat = await buildCategoryDescriptor(job.category);

    scrapeCategory(cat, job.limit || 0, job.delayMs, {
      startOffset: (job.cursorStart && job.cursorStart > 0)
        ? job.cursorStart
        : Math.floor((job.scraped || 0) / 48) * 48,
      initialScraped: job.scraped || 0,
      initialErrors: job.errors || 0,
    }).then(async () => {
      isScraping = false;
      currentJob = null;
      await prisma.scrapeJob.update({
        where: { id: job.id },
        data: { status: 'completed', completedAt: new Date() },
      });
      processQueue();
    }).catch(async (err) => {
      console.error('Resume scrape error:', err);
      isScraping = false;
      currentJob = null;
      await prisma.scrapeJob.update({
        where: { id: job.id },
        data: { status: 'failed', completedAt: new Date() },
      });
      processQueue();
    });

    res.json({ status: 'resumed', jobId: job.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Process queue - pick up pending jobs
async function processQueue() {
  if (isScraping) return;
  
  const nextJob = await prisma.scrapeJob.findFirst({
    where: { status: 'pending' },
    orderBy: { startedAt: 'asc' },
  });
  
  if (!nextJob) return; // No pending jobs
  
  isScraping = true;
  currentJob = nextJob;
  
  // Update status to running
  await prisma.scrapeJob.update({
    where: { id: nextJob.id },
    data: { status: 'running' },
  });
  
  // Get category info and run scrape
  const cat = await buildCategoryDescriptor(nextJob.category);

  try {
    await scrapeCategory(cat, nextJob.limit || 0, nextJob.delayMs, {
      startOffset: (nextJob.cursorStart && nextJob.cursorStart > 0)
        ? nextJob.cursorStart
        : Math.floor((nextJob.scraped || 0) / 48) * 48,
      initialScraped: nextJob.scraped || 0,
      initialErrors: nextJob.errors || 0,
    });

    // If a stop was requested mid-run, keep it canceled (do not overwrite to completed)
    const statusAfterRun = await prisma.scrapeJob.findUnique({ where: { id: nextJob.id }, select: { status: true } });
    if (statusAfterRun?.status === 'running') {
      await prisma.scrapeJob.update({
        where: { id: nextJob.id },
        data: { status: 'completed', completedAt: new Date() },
      });
    }
  } catch (err) {
    const statusAfterErr = await prisma.scrapeJob.findUnique({ where: { id: nextJob.id }, select: { status: true } });
    if (statusAfterErr?.status === 'running') {
      await prisma.scrapeJob.update({
        where: { id: nextJob.id },
        data: { status: 'failed', completedAt: new Date() },
      });
    }
  }

  isScraping = false;
  currentJob = null;

  // Process next in queue
  processQueue();
}

// Scrape a single product URL (debug / targeted refresh)
router.post('/product', async (req, res) => {
  if (isScraping) {
    return res.status(400).json({ error: 'Scraping already in progress' });
  }

  const { url, categoryPath } = req.body || {};
  if (!url || typeof url !== 'string' || !url.startsWith('https://www.continente.pt/produto/')) {
    return res.status(400).json({ error: 'Invalid url (must start with https://www.continente.pt/produto/)' });
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });

    const data = await extractProductData(page, categoryPath ? { category: categoryPath, label: '' } : null);

    if (!data?.ean) {
      return res.status(500).json({ error: 'Failed to extract EAN from product page' });
    }

    const product = await prisma.product.upsert({
      where: { ean: data.ean },
      create: {
        ean: data.ean,
        name: data.name || 'Unknown',
        brand: data.brand,
        category: data.category,
        subcategory: data.subcategory,
        subsubcategory: data.subsubcategory,
        imageUrl: data.imageUrl,
        source: 'continente',
      },
      update: {
        name: data.name || undefined,
        brand: data.brand || undefined,
        imageUrl: data.imageUrl || undefined,
        ...(data.category ? { category: data.category } : {}),
        ...(data.subcategory ? { subcategory: data.subcategory } : {}),
        ...(data.subsubcategory ? { subsubcategory: data.subsubcategory } : {}),
      },
    });

    if (data.price) {
      const latestPrice = await prisma.price.findFirst({
        where: { productId: product.id },
        orderBy: { capturedAt: 'desc' },
      });

      const newPriceCents = parsePrice(data.price);
      const newPricePerKgCents = data.pricePerKg ? parsePrice(data.pricePerKg) : null;
      const newPriceUnit = data.priceUnit; // 'kg' | 'l' | 'un' | null
      const newPvpCents = data.pvp ? parsePrice(data.pvp) : null;

      if (latestPrice) {
        const samePrice = latestPrice.priceCents === newPriceCents;
        const samePer = (latestPrice.pricePerKgCents ?? null) === newPricePerKgCents;
        const samePvp = (latestPrice.pvpCents ?? null) === newPvpCents;
        const sameUnit = (latestPrice.priceUnit ?? null) === newPriceUnit;

        if (samePrice && samePer && samePvp && sameUnit) {
          // ignore
        } else if (samePrice && samePvp && (latestPrice.pricePerKgCents == null) && (newPricePerKgCents != null)) {
          await prisma.price.update({
            where: { id: latestPrice.id },
            data: { pricePerKgCents: newPricePerKgCents, priceUnit: newPriceUnit },
          });
        } else if (samePrice && samePer && (latestPrice.pvpCents == null) && (newPvpCents != null)) {
          await prisma.price.update({
            where: { id: latestPrice.id },
            data: { pvpCents: newPvpCents },
          });
        } else {
          await prisma.price.create({
            data: {
              productId: product.id,
              priceCents: newPriceCents,
              pricePerKgCents: newPricePerKgCents,
              priceUnit: newPriceUnit,
              pvpCents: newPvpCents,
            },
          });
        }
      } else {
        await prisma.price.create({
          data: {
            productId: product.id,
            priceCents: newPriceCents,
            pricePerKgCents: newPricePerKgCents,
            priceUnit: newPriceUnit,
            pvpCents: newPvpCents,
          },
        });
      }
    }

    res.json({ status: 'ok', productId: product.id, extracted: data });
  } catch (err) {
    console.error('Single product scrape error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    await browser.close();
  }
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

  // Build category descriptor from input (name/path/url)
  const cat = await buildCategoryDescriptor(category);
  
  if (!cat || !cat.name) {
    return res.status(400).json({ error: 'Invalid category' });
  }

  // Create job
  const parsedLimit = Number.isFinite(parseInt(limit, 10)) ? parseInt(limit, 10) : 0;
  const job = await prisma.scrapeJob.create({
    data: {
      category: cat.name,
      label: cat.label,
      limit: parsedLimit,
      cursorStart: 0,
      status: 'running',
      delayMs,
    },
  });

  currentJob = job;
  isScraping = true;

  // Start scraping in background
  scrapeCategory(cat, parsedLimit, delayMs).then(() => {
    isScraping = false;
    currentJob = null;
  }).catch(err => {
    console.error('Scraping error:', err);
    isScraping = false;
    currentJob = null;
  });

  res.json({ jobId: job.id, status: 'started' });
});

// Stop current scrape and cancel pending/future queued jobs
router.post('/stop', async (req, res) => {
  try {
    // Signal active loops to stop
    isScraping = false;

    const now = new Date();

    // Cancel currently running + pending queue entries
    const canceled = await prisma.scrapeJob.updateMany({
      where: { status: { in: ['running', 'pending'] } },
      data: { status: 'canceled', completedAt: now },
    });

    currentJob = null;

    res.json({ status: 'stopped', canceledJobs: canceled.count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    
    // --- Price extraction (prefer DOM selectors; fallback to text scan) ---
    let unitPrice = null;
    let pricePerKg = null; // semantics: "price per unit" (kg / lt) but kept for DB compatibility
    let priceUnit = null; // 'kg' | 'l' | 'un' if pricePerKg is set
    let pvpPrice = null;

    const extractPriceNumber = (s) => {
      if (!s) return null;
      const m = String(s).match(/(\d+[,\.]\d{2})/);
      return m ? m[1].replace('.', ',') : null;
    };

    // 1) Primary/secondary price blocks (most reliable)
    unitPrice = extractPriceNumber(document.querySelector('.pwc-tile--price-primary')?.textContent);
    const secondaryText = document.querySelector('.pwc-tile--price-secondary')?.textContent || '';
    const secondaryNorm = secondaryText.toLowerCase().replace(/\s+/g, '');
    pricePerKg = extractPriceNumber(secondaryText);
    // Determine unit (kg, l/lt, un)
    if (secondaryNorm.includes('/kg')) priceUnit = 'kg';
    else if (secondaryNorm.includes('/l') || secondaryNorm.includes('/lt')) priceUnit = 'l';
    else if (secondaryNorm.includes('/un')) priceUnit = 'un';

    // PVPR/original price
    const pvprText = document.querySelector('.prices-wrapper .list')?.textContent;
    const pvprMatch = pvprText ? pvprText.match(/PVPR\s*(\d+[,\.]\d{2})\s*€/i) : null;
    if (pvprMatch) pvpPrice = pvprMatch[1].replace('.', ',');

    // 2) Fallback: scan normalized text
    if (!unitPrice || (!pricePerKg && !pvpPrice)) {
      const priceMatches = [...text.matchAll(/(\d+[\s,]\d{2})\s*€/g)];
      for (const match of priceMatches) {
        const priceValue = match[1];
        const endPos = match.index + match[0].length;
        const beforeText = text.substring(Math.max(0, match.index - 10), match.index).toUpperCase();
        const afterText = text.substring(endPos, endPos + 15).toUpperCase().replace(/\s+/g, '');

        if (beforeText.includes('PVPR') || beforeText.includes('PVP')) {
          if (!pvpPrice) pvpPrice = priceValue;
          continue;
        }

        const afterClean = afterText.replace(/€/g, '');
        if (afterClean.includes('/KG') || afterClean.includes('/L') || afterClean.includes('/LT') || afterClean.includes('/UN')) {
          if (!pricePerKg) pricePerKg = priceValue;
          if (!priceUnit) {
            if (afterClean.includes('/KG')) priceUnit = 'kg';
            else if (afterClean.includes('/LT')) priceUnit = 'l';
            else if (afterClean.includes('/L')) priceUnit = 'l';
            else if (afterClean.includes('/UN')) priceUnit = 'un';
          }
          if (!unitPrice) unitPrice = priceValue;
        } else if (!unitPrice) {
          unitPrice = priceValue;
        }
      }
    }

    // Normalize: if we only found one value, treat it as unit price
    if (!unitPrice && pricePerKg) unitPrice = pricePerKg;
    
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
    
    // Map URL path parts to display names
    const pathToName = {
      'mercearia': 'Mercearia', 'frescos': 'Frescos', 'laticinios-e-ovos': 'Laticínios',
      'congelados': 'Congelados', 'bebidas-e-garrafeira': 'Bebidas', 'limpeza': 'Limpeza',
      'higiene': 'Higiene', 'bebe': 'Bebé', 'animais': 'Animais', 'bio-e-saudavel': 'Bio e Saudável',
      'arroz-massa-e-farinha': 'Arroz, Massa e Farinha', 'cao': 'Cão', 'gato': 'Gato',
    };
    
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
      priceUnit: priceUnit || null,
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
async function scrapeCategory(category, limit, delayMs, opts = {}) {
  console.log(`Starting scrape: ${category.label}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');

  const pageSize = 48;
  let start = opts.startOffset || 0;
  let scraped = opts.initialScraped || 0;
  let errors = opts.initialErrors || 0;
  let productLinks = [];
  const maxPages = limit > 0 ? Math.ceil(limit / pageSize) : 150; // Default max 150 pages (~7,200 products)
  let pageNum = Math.floor(start / pageSize) + 1;

  // Scrape as we discover links (streaming)
  while (pageNum <= maxPages && isScraping) {
    // Persist current cursor so resume can continue from here
    if (currentJob) {
      currentJob = await prisma.scrapeJob.update({
        where: { id: currentJob.id },
        data: { cursorStart: start, scraped, errors },
      });
    }

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


          if (data.ean && data.name) {
            // Upsert product
            const product = await prisma.product.upsert({
              where: { ean: data.ean },
              create: {
                ean: data.ean,
                name: data.name,
                brand: data.brand,
                // Always prefer the parsed main category from URL over extracted data
                category: category.mainCategory || data.category,
                subcategory: category.label || data.subcategory,
                subsubcategory: data.subsubcategory,
                imageUrl: data.imageUrl,
              },
              update: {
                name: data.name,
                brand: data.brand,
                // Always prefer the parsed main category from URL over extracted data
                category: category.mainCategory || data.category,
                subcategory: category.label || data.subcategory,
                subsubcategory: data.subsubcategory,
                imageUrl: data.imageUrl,
              },
            });

            // Add price only if meaningfully different from latest
            if (data.price) {
              const latestPrice = await prisma.price.findFirst({
                where: { productId: product.id },
                orderBy: { capturedAt: 'desc' },
              });

              const newPriceCents = parsePrice(data.price);
              const newPricePerKgCents = data.pricePerKg ? parsePrice(data.pricePerKg) : null;
              const newPriceUnit = data.priceUnit; // 'kg' | 'l' | 'un' | null
              const newPvpCents = data.pvp ? parsePrice(data.pvp) : null;

              if (latestPrice) {
                const samePrice = latestPrice.priceCents === newPriceCents;
                const samePer = (latestPrice.pricePerKgCents ?? null) === newPricePerKgCents;
                const samePvp = (latestPrice.pvpCents ?? null) === newPvpCents;
                const sameUnit = (latestPrice.priceUnit ?? null) === newPriceUnit;

                if (samePrice && samePer && samePvp && sameUnit) {
                  // fully duplicate → ignore
                } else if (samePrice && samePvp && (latestPrice.pricePerKgCents == null) && (newPricePerKgCents != null)) {
                  // data enrichment (we previously failed to capture per-unit price)
                  await prisma.price.update({
                    where: { id: latestPrice.id },
                    data: { pricePerKgCents: newPricePerKgCents, priceUnit: newPriceUnit },
                  });
                } else if (samePrice && samePer && (latestPrice.pvpCents == null) && (newPvpCents != null)) {
                  // data enrichment (we previously failed to capture PVPR)
                  await prisma.price.update({
                    where: { id: latestPrice.id },
                    data: { pvpCents: newPvpCents },
                  });
                } else {
                  // real change (or ambiguous) → create new history row
                  await prisma.price.create({
                    data: {
                      productId: product.id,
                      priceCents: newPriceCents,
                      pricePerKgCents: newPricePerKgCents,
                      priceUnit: newPriceUnit,
                      pvpCents: newPvpCents,
                    },
                  });
                }
              } else {
                await prisma.price.create({
                  data: {
                    productId: product.id,
                    priceCents: newPriceCents,
                    pricePerKgCents: newPricePerKgCents,
                    priceUnit: newPriceUnit,
                    pvpCents: newPvpCents,
                  },
                });
              }
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
            data: { scraped, errors, cursorStart: start },
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
    pageNum++;

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
        cursorStart: start,
      },
    });
  }

  await browser.close();
  console.log(`Completed scrape: ${scraped} products, ${errors} errors`);

}

module.exports = router;

