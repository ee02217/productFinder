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

async function fetchAllProductUrls() {
  const sitemapUrls = await fetchProductSitemapUrls();
  const all = [];

  for (const s of sitemapUrls) {
    const urls = await fetchProductUrlsFromSitemap(s);
    all.push(...urls);
  }

  return [...new Set(all)];
}

module.exports = {
  extractLocs,
  fetchProductSitemapUrls,
  fetchProductUrlsFromSitemap,
  fetchAllProductUrls,
};
