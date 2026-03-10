const { BASE_URL, BLOCKED_ROOT_CATEGORIES } = require('./constants');
const { fetchPage, delay } = require('./http');

// Category mapping from URL paths to display names
const CATEGORY_MAP = {
  // Main categories
  'mercearia': 'Mercearia',
  'frescos': 'Frescos',
  'laticinios-e-ovos': 'Laticínios',
  'congelados': 'Congelados',
  'bebidas-e-garrafeira': 'Bebidas',
  'limpeza': 'Limpeza',
  'higiene': 'Higiene',
  'bebe': 'Bebé',
  'animais': 'Animais',
  'bio-e-saudavel': 'Bio e Saudável',
};

function slugify(v) {
  return String(v || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function isRootBlocked(categoryPath) {
  if (!categoryPath) return false;
  const cleanPath = String(categoryPath)
    .split('?')[0]
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  const rootSlug = cleanPath.split('/')[0];
  return BLOCKED_ROOT_CATEGORIES.includes(rootSlug);
}

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

function parseCategoryFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) return null;

    const categorySlug = parts[0];
    const subcategorySlug = parts[1] || null;

    return {
      rootSlug: categorySlug,
      categorySlug,
      subcategorySlug,
      category: CATEGORY_MAP[categorySlug] || categorySlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      subcategory: subcategorySlug ? (CATEGORY_MAP[subcategorySlug] || subcategorySlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())) : null,
      url: '/' + parts.join('/') + '/',
    };
  } catch {
    return null;
  }
}

// Discover available categories from Continente's main navigation
async function discoverCategories() {
  const browser = await fetchPage(BASE_URL + '/', { waitUntil: 'domcontentloaded' });
  
  const categories = await browser.evaluate(() => {
    const results = [];
    
    // Try to find main navigation categories
    const navLinks = document.querySelectorAll('nav a[href*="/mercearia"], nav a[href*="/frescos"], nav a[href*="/laticinios"], nav a[href*="/congelados"], nav a[href*="/bebidas"], nav a[href*="/limpeza"], nav a[href*="/higiene"], nav a[href*="/bebe"], nav a[href*="/animais"], nav a[href*="/bio"]');
    
    const seen = new Set();
    navLinks.forEach(a => {
      const href = a.getAttribute('href');
      if (!href || !href.includes('continente.pt')) return;
      
      try {
        const url = new URL(href);
        const path = url.pathname;
        const parts = path.split('/').filter(Boolean);
        if (parts.length === 0) return;
        
        const rootSlug = parts[0];
        if (seen.has(rootSlug)) return;
        seen.add(rootSlug);
        
        results.push({
          rootSlug,
          url: '/' + rootSlug + '/',
          label: CATEGORY_MAP[rootSlug] || rootSlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        });
      } catch (e) {}
    });
    
    // Fallback: known main categories if none found
    if (results.length === 0) {
      const fallback = ['mercearia', 'frescos', 'laticinios-e-ovos', 'congelados', 'bebidas-e-garrafeira'];
      fallback.forEach(slug => {
        results.push({
          rootSlug: slug,
          url: '/' + slug + '/',
          label: CATEGORY_MAP[slug] || slug,
        });
      });
    }
    
    return results;
  });

  await browser.close();
  
  // Filter out blocked root categories
  const allowedCategories = categories.filter(cat => !isRootBlocked(cat.rootSlug));
  
  console.log(`[CONTINENTE] Discovered ${categories.length} categories, ${allowedCategories.length} allowed (${BLOCKED_ROOT_CATEGORIES.join(', ')} blocked)`);
  
  return allowedCategories;
}

// Fetch product URLs from a category page (with pagination)
async function fetchProductUrlsFromCategory(categoryUrl, maxProducts = 0, options = {}) {
  const { delayMs = 200, maxPages = 50 } = options;
  const allLinks = new Set();
  const pageSize = 48;
  let start = 0;
  let pageNum = 0;

  while (pageNum < maxPages) {
    const pageUrl = `${BASE_URL}${categoryUrl}?start=${start}&srule=FOOD&pmin=0.01`;
    
    let browser;
    try {
      browser = await fetchPage(pageUrl, { waitUntil: 'networkidle2', timeoutMs: 90000 });
    } catch (err) {
      console.log(`[CONTINENTE] Error fetching category page ${categoryUrl}: ${err.message}`);
      break;
    }

    const links = await browser.evaluate(() => {
      const productLinks = document.querySelectorAll('a[href*="/produto/"]');
      return Array.from(productLinks)
        .map(a => a.href)
        .filter(href => href.includes('/produto/') && href.endsWith('.html'));
    });

    links.forEach(link => allLinks.add(link));
    await browser.close();

    if (links.length === 0 || (maxProducts > 0 && allLinks.size >= maxProducts)) break;
    
    start += pageSize;
    pageNum++;
    
    if (delayMs > 0) await delay(delayMs);
  }

  const linksArray = Array.from(allLinks);
  return maxProducts > 0 ? linksArray.slice(0, maxProducts) : linksArray;
}

// Discover all product URLs from all allowed categories
async function discoverAllProductUrls(options = {}) {
  const { limit = 0, delayMs = 200 } = options;
  
  // First discover categories
  const categories = await discoverCategories();
  
  const allUrls = [];
  
  for (const cat of categories) {
    console.log(`[CONTINENTE] Fetching products from ${cat.label}...`);
    
    const urls = await fetchProductUrlsFromCategory(
      cat.url, 
      limit > 0 ? Math.ceil(limit / categories.length) : 0,
      { delayMs }
    );
    
    // Tag each URL with category info for later filtering
    const taggedUrls = urls.map(url => ({
      url,
      category: cat.label,
      categorySlug: cat.rootSlug,
    }));
    
    allUrls.push(...taggedUrls);
    
    console.log(`[CONTINENTE] Found ${urls.length} products in ${cat.label}`);
  }
  
  return allUrls;
}

module.exports = {
  CATEGORY_MAP,
  BLOCKED_ROOT_CATEGORIES,
  slugify,
  isRootBlocked,
  normalizeCategoryPath,
  parseCategoryFromUrl,
  discoverCategories,
  fetchProductUrlsFromCategory,
  discoverAllProductUrls,
};
