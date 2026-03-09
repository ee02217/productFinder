const { URLS } = require('./constants');
const { fetchText } = require('./http');

function extractLocs(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

async function fetchProductSitemapUrls() {
  const indexXml = await fetchText(URLS.sitemapIndex);
  return extractLocs(indexXml).filter((u) => /sitemap_\d+-product\.xml$/i.test(u));
}

async function fetchProductUrlsFromSitemap(sitemapUrl) {
  const xml = await fetchText(sitemapUrl);
  return extractLocs(xml).filter((u) => u.includes('/home/produtos/') && /\.html$/i.test(u));
}

/**
 * Deduplicate URLs by preferring /home/produtos/ over /promocoes/
 * Uses product name + brand key for deduplication
 */
function deduplicateUrls(urls) {
  const seen = new Map(); // key -> preferred url
  
  for (const url of urls) {
    // Extract product key from URL for deduplication
    // Example: /produtos/nome-marca-id.html
    const key = extractProductKey(url);
    
    if (!key) {
      // No key extractable, keep as-is
      if (!seen.has(url)) {
        seen.set(url, url);
      }
      continue;
    }
    
    const isPromocoes = url.includes('/promocoes/');
    const isProdutos = url.includes('/home/produtos/');
    
    const existing = seen.get(key);
    
    if (!existing) {
      seen.set(key, url);
    } else {
      // Prefer /home/produtos/ over /promocoes/
      const existingIsProdutos = existing.includes('/home/produtos/');
      const existingIsPromocoes = existing.includes('/promocoes/');
      
      if (isProdutos && existingIsPromocoes) {
        // Replace promotion with produto
        seen.set(key, url);
      } else if (isPromocoes && existingIsPromocoes && !existingIsProdutos) {
        // Keep firstpromo, skip duplicates
      }
      // Otherwise keep existing (prioritize produto or keep first seen)
    }
  }
  
  return Array.from(seen.values());
}

/**
 * Extract product key from URL for deduplication
 * Returns normalized product identifier (brand+name)
 */
function extractProductKey(url) {
  try {
    // URL format: https://www.pingodoce.pt/produtos/brand-name-id.html
    // or: https://www.pingodoce.pt/home/produtos/brand-name-id.html
    const u = new URL(url);
    const path = u.pathname;
    
    // Extract the filename part (e.g., "nome-produto-12345.html")
    const parts = path.split('/').filter(Boolean);
    const filename = parts[parts.length - 1];
    
    if (!filename || !filename.endsWith('.html')) return null;
    
    // Remove .html and split by dash to get name parts
    const base = filename.replace('.html', '');
    
    // Last part is typically the ID (numeric or alphanumeric)
    // Everything before is the product name/brand
    // We'll use the full base as key for simplicity
    return base.toLowerCase().replace(/-/g, '');
  } catch {
    return null;
  }
}

/**
 * Pre-filter: Hard-skip URLs containing '/promocoes/' in pathname
 * This is a safety filter applied BEFORE deduplication
 */
function filterPromocoesUrls(urls) {
  return urls.filter((url) => {
    try {
      const u = new URL(url);
      return !u.pathname.includes('/promocoes/');
    } catch {
      return true; // Keep if URL parsing fails
    }
  });
}

async function fetchAllProductUrls() {
  const sitemapUrls = await fetchProductSitemapUrls();
  const all = [];

  for (const s of sitemapUrls) {
    const urls = await fetchProductUrlsFromSitemap(s);
    all.push(...urls);
  }

  // Hard-skip /promocoes/ URLs before any processing
  const filtered = filterPromocoesUrls(all);

  // Deduplicate remaining URLs, preferring /home/produtos/ over other paths
  return deduplicateUrls([...new Set(filtered)]);
}

module.exports = {
  extractLocs,
  fetchProductSitemapUrls,
  fetchProductUrlsFromSitemap,
  fetchAllProductUrls,
  deduplicateUrls,
  extractProductKey,
  filterPromocoesUrls,
};
