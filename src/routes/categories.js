const express = require('express');
const { PrismaClient } = require('@prisma/client');
const puppeteer = require('puppeteer-core');

const router = express.Router();
const prisma = new PrismaClient();

const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || 
  (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');

const BASE_URL = 'https://www.continente.pt';

// Category name mappings (URL path -> display name)
const CATEGORY_NAMES = {
  // Main categories
  'mercearia': 'Mercearia',
  'frescos': 'Frescos',
  'laticinios-e-ovos': 'Laticínios e Ovos',
  'congelados': 'Congelados',
  'bebidas-e-garrafeira': 'Bebidas e Garrafeira',
  'limpeza': 'Limpeza',
  'higiene': 'Higiene',
  'bebe': 'Bebé',
  'animais': 'Animais',
  'casa-bricolage-e-jardim': 'Casa, Bricolage e Jardim',
  'desporto-roupa-e-viagem': 'Desporto, Roupa e Viagem',
  'papelaria': 'Papelaria',
  'livros': 'Livros',
  'brinquedos-e-jogos': 'Brinquedos e Jogos',
  'bio-e-saudavel': 'Bio e Saudável',
  'marcas': 'Marcas',
};

// Get all categories from database
router.get('/', async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      orderBy: [{ level: 'asc' }, { label: 'asc' }],
    });
    res.json(categories);
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// Get category tree (hierarchical)
router.get('/tree', async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      where: { parentId: null },
      include: {
        children: {
          include: { children: true }
        }
      },
      orderBy: { label: 'asc' },
    });
    res.json(categories);
  } catch (error) {
    console.error('Error fetching category tree:', error);
    res.status(500).json({ error: 'Failed to fetch category tree' });
  }
});

// Get category options for scraping (flattened list with full paths)
router.get('/options', async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      orderBy: [{ level: 'asc' }, { label: 'asc' }],
    });
    
    // Build options with full path
    const options = [];
    const mainCategories = categories.filter(c => c.level === 1);
    
    for (const main of mainCategories) {
      // Add main category option
      options.push({
        value: main.urlPath,
        label: main.label,
        level: 1
      });
      
      // Add subcategories
      const subs = categories.filter(c => c.parentId === main.id);
      for (const sub of subs) {
        options.push({
          value: sub.urlPath,
          label: `${main.label} > ${sub.label}`,
          level: 2
        });
        
        // Add subsubcategories
        const subsubs = categories.filter(c => c.parentId === sub.id);
        for (const subsub of subsubs) {
          options.push({
            value: subsub.urlPath,
            label: `${main.label} > ${sub.label} > ${subsub.label}`,
            level: 3
          });
        }
      }
    }
    
    res.json(options);
  } catch (error) {
    console.error('Error fetching category options:', error);
    res.status(500).json({ error: 'Failed to fetch category options' });
  }
});

// Scrape categories from Continente and populate database
router.post('/scrape', async (req, res) => {
  res.json({ status: 'Use /scrape-full instead for full category tree' });
});

// Seed default categories manually
router.post('/seed', async (req, res) => {
  try {
    const defaultCategories = [
      { name: 'mercearia', label: 'Mercearia', urlPath: '/mercearia/' },
      { name: 'frescos', label: 'Frescos', urlPath: '/frescos/' },
      { name: 'laticinios-e-ovos', label: 'Laticínios e Ovos', urlPath: '/laticinios-e-ovos/' },
      { name: 'congelados', label: 'Congelados', urlPath: '/congelados/' },
      { name: 'bebidas-e-garrafeira', label: 'Bebidas e Garrafeira', urlPath: '/bebidas-e-garrafeira/' },
      { name: 'limpeza', label: 'Limpeza', urlPath: '/limpeza/' },
      { name: 'higiene', label: 'Higiene', urlPath: '/higiene/' },
      { name: 'bebe', label: 'Bebé', urlPath: '/bebe/' },
      { name: 'animais', label: 'Animais', urlPath: '/animais/' },
      { name: 'bio-e-saudavel', label: 'Bio e Saudável', urlPath: '/bio-e-saudavel/' },
    ];
    
    // Clear and insert
    await prisma.category.deleteMany();
    
    for (const cat of defaultCategories) {
      await prisma.category.create({
        data: {
          name: cat.name,
          label: cat.label,
          level: 1,
          urlPath: cat.urlPath,
        },
      });
    }
    
    res.json({ status: 'seeded', count: defaultCategories.length });
  } catch (error) {
    console.error('Error seeding categories:', error);
    res.status(500).json({ error: 'Failed to seed categories' });
  }
});

// Full scrape of category tree from Continente (may not work in Docker)
router.post('/scrape-full', async (req, res) => {
  try {
    res.json({ status: 'started', message: 'Scraping category tree from Continente...' });
    
    const categories = await scrapeCategoryTree();
    
    // Clear existing and insert new
    await prisma.category.deleteMany();
    
    // Insert main categories first
    for (const cat of categories) {
      await prisma.category.create({
        data: {
          name: cat.name,
          label: cat.label,
          level: 1,
          urlPath: cat.urlPath,
        },
      });
    }
    
    // Insert subcategories
    for (const cat of categories) {
      const mainCat = await prisma.category.findFirst({ where: { name: cat.name } });
      if (mainCat && cat.children) {
        for (const sub of cat.children) {
          await prisma.category.create({
            data: {
              name: sub.name,
              label: sub.label,
              level: 2,
              parentId: mainCat.id,
              urlPath: sub.urlPath,
            },
          });
        }
      }
    }
    
    // Insert subsubcategories
    for (const cat of categories) {
      const mainCat = await prisma.category.findFirst({ where: { name: cat.name } });
      if (mainCat && cat.children) {
        for (const sub of cat.children) {
          const subCat = await prisma.category.findFirst({ 
            where: { name: sub.name, parentId: mainCat.id } 
          });
          if (subCat && sub.children) {
            for (const subsub of sub.children) {
              await prisma.category.create({
                data: {
                  name: subsub.name,
                  label: subsub.label,
                  level: 3,
                  parentId: subCat.id,
                  urlPath: subsub.urlPath,
                },
              });
            }
          }
        }
      }
    }
    
    console.log(`Category tree scraped: ${categories.length} main categories`);
    
  } catch (error) {
    console.error('Error scraping categories:', error);
    res.status(500).json({ error: 'Failed to scrape categories: ' + error.message });
  }
});

async function scrapeCategoryTree() {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
  
  // Navigate to homepage (has all category links in menu)
  console.log('Scraping category tree from Continente homepage...');
  await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 60000 });
  
  // Wait for page to fully load
  await new Promise(r => setTimeout(r, 3000));
  
  // Extract category links from the page
  const categoryData = await page.evaluate(() => {
    const results = [];
    const seen = new Set();
    
    // Get all links on the page
    const links = document.querySelectorAll('a[href]');
    
    links.forEach(link => {
      const href = link.getAttribute('href');
      const text = link.textContent?.trim();
      
      if (href && text && text.length > 2 && text.length < 60) {
        // Clean href
        const cleanHref = href.split('?')[0];
        
        // Match category paths like /mercearia/, /frescos/, /mercearia/arroz-massa-e-farinha/
        if (cleanHref.match(/^\/[a-z\-]+\/?$/) || cleanHref.match(/^\/[a-z\-]+\/[a-z\-]+\/?$/) || cleanHref.match(/^\/[a-z\-]+\/[a-z\-]+\/[a-z\-]+\/?$/)) {
          if (!seen.has(cleanHref)) {
            seen.add(cleanHref);
            results.push({
              href: cleanHref,
              text: text
            });
          }
        }
      }
    });
    
    return results;
  });
  
  console.log(`Found ${categoryData.length} category links`);
  
  // Parse into hierarchy
  const categoryTree = [];
  const nameMap = {};
  
  for (const item of categoryData) {
    const parts = item.href.split('/').filter(p => p);
    if (parts.length >= 1) {
      const mainName = parts[0];
      const subName = parts[1] || null;
      const subsubName = parts[2] || null;
      
      // Main category
      if (!nameMap[mainName]) {
        const mainLabel = CATEGORY_NAMES[mainName] || mainName.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        nameMap[mainName] = {
          name: mainName,
          label: mainLabel,
          urlPath: `/${mainName}/`,
          children: []
        };
        categoryTree.push(nameMap[mainName]);
      }
      
      // Subcategory
      if (subName && !nameMap[mainName].children.find(c => c.name === subName)) {
        const subLabel = subName.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        nameMap[mainName].children.push({
          name: subName,
          label: subLabel,
          urlPath: `/${mainName}/${subName}/`,
          children: []
        });
      }
      
      // Subsubcategory
      if (subsubName && subName) {
        const subCat = nameMap[mainName].children.find(c => c.name === subName);
        if (subCat && !subCat.children.find(c => c.name === subsubName)) {
          const subsubLabel = subsubName.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          subCat.children.push({
            name: subsubName,
            label: subsubLabel,
            urlPath: `/${mainName}/${subName}/${subsubName}/`,
          });
        }
      }
    }
  }
  
  await browser.close();
  
  // Sort children
  categoryTree.forEach(cat => {
    cat.children.sort((a, b) => a.label.localeCompare(b.label));
    cat.children.forEach(sub => {
      if (sub.children) {
        sub.children.sort((a, b) => a.label.localeCompare(b.label));
      }
    });
  });
  
  return categoryTree;
}

// Discover subcategories for a main category
router.post('/discover-subs/:mainCategory', async (req, res) => {
  const { mainCategory } = req.params;
  
  try {
    const mainCat = await prisma.category.findFirst({
      where: { name: mainCategory, level: 1 }
    });
    
    if (!mainCat) {
      return res.status(404).json({ error: 'Main category not found' });
    }
    
    // Scrape subcategories from Continente
    const browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    
    // Navigate to main category page
    console.log(`Discovering subcategories for ${mainCategory}...`);
    await page.goto(`${BASE_URL}${mainCat.urlPath}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));
    
    // Extract subcategory links
    const subs = await page.evaluate(() => {
      const results = [];
      const seen = new Set();
      
      const links = document.querySelectorAll('a[href]');
      links.forEach(link => {
        const href = link.getAttribute('href');
        const text = link.textContent?.trim();
        
        if (href && text && text.length > 2 && text.length < 50) {
          // Match subcategory paths like /mercearia/arroz-massa-e-farinha/
          const match = href.match(new RegExp(`^/${mainCategory}/([^/]+)/?$`));
          if (match && !seen.has(match[1])) {
            seen.add(match[1]);
            results.push({ name: match[1], text: text });
          }
        }
      });
      
      return results;
    });
    
    await browser.close();
    
    // Insert subcategories
    let added = 0;
    for (const sub of subs) {
      const existing = await prisma.category.findFirst({
        where: { name: sub.name, parentId: mainCat.id }
      });
      
      if (!existing) {
        await prisma.category.create({
          data: {
            name: sub.name,
            label: sub.text,
            level: 2,
            parentId: mainCat.id,
            urlPath: `/${mainCategory}/${sub.name}/`,
          },
        });
        added++;
      }
    }
    
    res.json({ discovered: added, subcategories: subs });
  } catch (error) {
    console.error('Error discovering subcategories:', error);
    res.status(500).json({ error: 'Failed to discover subcategories' });
  }
});

// Get scrape options - subcategories only (level 2)
router.get('/scrape-options', async (req, res) => {
  try {
    const categories = await prisma.category.findMany({
      where: { level: 2 },
      include: { parent: true },
      orderBy: [{ parent: { label: 'asc' } }, { label: 'asc' }],
    });

    const options = categories.map(c => ({
      value: c.urlPath,
      label: c.parent ? `${c.parent.label} > ${c.label}` : c.label,
    }));

    res.json(options);
  } catch (error) {
    console.error('Error fetching scrape options:', error);
    res.status(500).json({ error: 'Failed to fetch scrape options' });
  }
});

// Update category label/url used for scraping
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { label, urlPath } = req.body || {};

    const existing = await prisma.category.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Category not found' });

    const data = {};

    if (typeof label === 'string' && label.trim()) {
      data.label = label.trim();
    }

    if (typeof urlPath === 'string' && urlPath.trim()) {
      const normalized = '/' + urlPath.trim().replace(/^\/+/, '').replace(/\/+$/, '') + '/';
      data.urlPath = normalized;

      // Keep name aligned with path leaf segment (helps consistency)
      const parts = normalized.split('/').filter(Boolean);
      if (parts.length > 0) data.name = parts[parts.length - 1];
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'Nothing to update (label/urlPath)' });
    }

    const updated = await prisma.category.update({
      where: { id },
      data,
    });

    res.json(updated);
  } catch (error) {
    console.error('Error updating category:', error);
    res.status(500).json({ error: 'Failed to update category' });
  }
});

// Delete category (and descendants)
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const root = await prisma.category.findUnique({
      where: { id },
      include: { children: { include: { children: true } } },
    });

    if (!root) return res.status(404).json({ error: 'Category not found' });

    const ids = [id];
    for (const child of root.children || []) {
      ids.push(child.id);
      for (const grand of child.children || []) ids.push(grand.id);
    }

    await prisma.category.deleteMany({ where: { id: { in: ids } } });

    res.json({ deleted: ids.length });
  } catch (error) {
    console.error('Error deleting category:', error);
    res.status(500).json({ error: 'Failed to delete category' });
  }
});

module.exports = router;
