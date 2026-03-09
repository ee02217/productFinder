const { URLS } = require('./constants');
const { fetchText } = require('./http');

function extractLocs(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

async function fetchProductSitemapUrls() {
  const indexXml = await fetchText(URLS.sitemapIndex);
  return extractLocs(indexXml).filter((u) => u.includes('product_sitemap.xml') || u.includes('product'));
}

async function fetchProductUrlsFromSitemap(sitemapUrl) {
  const xml = await fetchText(sitemapUrl);
  return extractLocs(xml).filter((u) => u.includes('/p') && /\/(p\d+)/.test(u));
}

async function fetchAllProductUrls() {
  const sitemapUrls = await fetchProductSitemapUrls();
  const all = [];

  for (const s of sitemapUrls) {
    try {
      const urls = await fetchProductUrlsFromSitemap(s);
      all.push(...urls);
    } catch (err) {
      console.error(`[LIDL] Failed to fetch sitemap ${s}:`, err.message);
    }
  }

  return [...new Set(all)];
}

module.exports = {
  extractLocs,
  fetchProductSitemapUrls,
  fetchProductUrlsFromSitemap,
  fetchAllProductUrls,
};
