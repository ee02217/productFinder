const RETAILER = 'continente';

const BASE_URL = 'https://www.continente.pt';

// Chrome executable path - use system Chromium in Docker, host Chrome on Mac
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || 
  (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/usr/bin/chromium');

const DEFAULTS = {
  limit: 500,
  delayMs: 400,
  timeoutMs: 45000,
  retries: 3,
  retryBaseMs: 2000,
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
};

// Blocked root categories (from categoryBlocklist config)
const BLOCKED_ROOT_CATEGORIES = [
  'livros',
  'casa-bricolage-e-jardim',
  'brinquedos-e-jogos',
  'desporto-roupa-e-viagem',
];

module.exports = { 
  RETAILER, 
  BASE_URL, 
  CHROME_PATH, 
  DEFAULTS,
  BLOCKED_ROOT_CATEGORIES,
};
