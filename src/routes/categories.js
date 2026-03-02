const express = require('express');
const { PrismaClient } = require('@prisma/client');
const puppeteer = require('puppeteer-core');

const router = express.Router();
const prisma = new PrismaClient();

const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || 
  (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');

// Get stored category tree
router.get('/tree', async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      select: {
        category: true,
        subcategory: true,
        subsubcategory: true,
      },
      distinct: ['category', 'subcategory', 'subsubcategory'],
      where: { category: { not: null } },
      orderBy: { category: 'asc' },
    });
    res.json(products);
  } catch (error) {
    console.error('Error fetching category tree:', error);
    res.status(500).json({ error: 'Failed to fetch category tree' });
  }
});

// Discover categories from stored products (faster than scraping)
router.get('/discover', async (req, res) => {
  try {
    // Get unique category paths from products
    const products = await prisma.product.findMany({
      select: {
        category: true,
        subcategory: true,
        subsubcategory: true,
      },
      distinct: ['category', 'subcategory', 'subsubcategory'],
      where: {
        OR: [
          { category: { not: null } },
          { subcategory: { not: null } },
          { subsubcategory: { not: null } },
        ],
      },
    });
    
    // Build category tree
    const categoryMap = new Map();
    
    products.forEach(p => {
      const main = p.category || 'Other';
      const sub = p.subcategory || '';
      const subsub = p.subsubcategory || '';
      
      if (main && main !== 'Other') {
        const key = main;
        if (!categoryMap.has(key)) {
          categoryMap.set(key, new Set());
        }
        if (sub) {
          categoryMap.get(key).add(sub);
        }
      }
    });
    
    // Convert to array format
    const categories = [];
    categoryMap.forEach((subs, main) => {
      subs.forEach(sub => {
        categories.push({
          url: `/${main.toLowerCase()}/${sub.toLowerCase().replace(/ /g, '-')}/`,
          name: `${main} > ${sub}`,
          category: main.toLowerCase(),
        });
      });
      // Also add main category without sub
      categories.push({
        url: `/${main.toLowerCase()}/`,
        name: main,
        category: main.toLowerCase(),
      });
    });
    
    res.json({
      discovered: categories.length,
      categories: categories.sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (error) {
    console.error('Error discovering categories:', error);
    res.status(500).json({ error: 'Failed to discover categories: ' + error.message });
  }
});

let isUpdatingCategories = false;

router.get('/status', (req, res) => {
  res.json({ isUpdatingCategories });
});

router.post('/update-all', async (req, res) => {
  if (isUpdatingCategories) {
    return res.status(400).json({ error: 'Category update already in progress' });
  }

  const { limit = 0, delayMs = 1000 } = req.body;
  isUpdatingCategories = true;
  
  updateProductCategories(parseInt(limit), parseInt(delayMs)).finally(() => {
    isUpdatingCategories = false;
  });
  
  res.json({ status: 'started' });
});

router.post('/stop', async (req, res) => {
  isUpdatingCategories = false;
  res.json({ status: 'stopping' });
});

async function updateProductCategories(limit, delayMs) {
  console.log('Starting category update...');
  
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox'],
  });

  const page = await browser.newPage();
  
  const products = await prisma.product.findMany({
    where: { ean: { not: null } },
    take: limit > 0 ? limit : undefined,
    orderBy: { updatedAt: 'asc' },
  });
  
  console.log(`Found ${products.length} products to update`);
  
  let updated = 0;
  let errors = 0;
  
  for (const product of products) {
    if (!isUpdatingCategories) break;
    
    try {
      const searchUrl = `https://www.continente.pt/pesquisa/?q=${product.ean}`;
      
      let success = false;
      for (let retry = 0; retry < 3 && !success; retry++) {
        try {
          await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
          success = true;
        } catch (err) {
          if (retry < 2) await new Promise(r => setTimeout(r, 2000));
        }
      }
      
      // Click on product link
      const productLink = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="/produto/"]');
        for (const link of links) {
          if (link.href.includes('.html')) return link.href;
        }
        return null;
      });
      
      if (productLink) {
        await page.goto(productLink, { waitUntil: 'networkidle2', timeout: 30000 });
      }
      
      // Extract category from URL path
      const breadcrumb = await page.evaluate(() => {
        const url = window.location.href;
        if (url.includes('/pesquisa/')) return null;
        
        const pathParts = url.split('/').filter(p => 
          p && !p.includes('?') && !p.includes('.html') && !p.includes('www.continente.pt') && p !== 'https:'
        );
        
        const categoryMap = {
          'mercearia': 'Mercearia', 'frescos': 'Frescos', 'frescos-frutas': 'Frescos',
          'frescos-legumes': 'Frescos', 'frescos-talho': 'Frescos', 'frescos-peixaria': 'Frescos',
          'frescos-padaria': 'Frescos', 'laticinios-e-ovos': 'Laticínios', 'laticinios': 'Laticínios',
          'congelados': 'Congelados', 'bebidas-e-garrafeira': 'Bebidas', 'bebidas': 'Bebidas',
          'limpeza': 'Limpeza', 'higiene': 'Higiene',
        };
        
        const result = [];
        let currentCategory = null;
        
        for (const part of pathParts) {
          if (categoryMap[part]) {
            currentCategory = categoryMap[part];
            if (!result.includes(currentCategory)) result.push(currentCategory);
          } else if (currentCategory) {
            result.push(part.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()));
          }
        }
        
        if (result.length < 2 && pathParts.length > 2) {
          for (let i = pathParts.length - 2; i >= 0; i--) {
            if (!categoryMap[pathParts[i]]) {
              const formatted = pathParts[i].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
              if (!result.includes(formatted)) result.unshift(formatted);
            }
          }
        }
        
        return result.length > 0 ? result : null;
      });
      
      let category = null, subcategory = null, subsubcategory = null;
      if (breadcrumb && breadcrumb.length > 0) {
        category = breadcrumb[0] || null;
        subcategory = breadcrumb[1] || null;
        subsubcategory = breadcrumb[2] || null;
      }
      
      await prisma.product.update({
        where: { id: product.id },
        data: { category, subcategory, subsubcategory },
      });
      
      updated++;
      if (updated % 10 === 0) console.log(`Updated ${updated} products...`);
      
    } catch (err) {
      errors++;
      console.log(`Error updating ${product.ean}: ${err.message}`);
    }
    
    await new Promise(r => setTimeout(r, delayMs));
  }
  
  await browser.close();
  console.log(`Category update complete: ${updated} updated, ${errors} errors`);
}

module.exports = router;
