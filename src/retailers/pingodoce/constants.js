const RETAILER = 'pingodoce';

const URLS = {
  robots: 'https://www.pingodoce.pt/robots.txt',
  sitemapIndex: 'https://www.pingodoce.pt/home/sitemap_index.xml',
};

const DEFAULTS = {
  limit: 0,
  delayMs: 400,
  timeoutMs: 20000,
  retries: 3,
  retryBaseMs: 400,
  userAgent: 'Mozilla/5.0 (compatible; ProductFinder/1.0; +https://localhost)',
};

module.exports = { RETAILER, URLS, DEFAULTS };
