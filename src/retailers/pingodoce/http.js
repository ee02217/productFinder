const zlib = require('zlib');
const { DEFAULTS } = require('./constants');

async function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const retries = opts.retries ?? DEFAULTS.retries;
  const retryBaseMs = opts.retryBaseMs ?? DEFAULTS.retryBaseMs;
  const userAgent = opts.userAgent ?? DEFAULTS.userAgent;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'user-agent': userAgent,
          'accept': '*/*',
        },
      });
      clearTimeout(timer);

      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);

      const buf = Buffer.from(await res.arrayBuffer());
      if (url.endsWith('.gz')) {
        return zlib.gunzipSync(buf).toString('utf8');
      }
      return buf.toString('utf8');
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        await delay(retryBaseMs * Math.pow(2, attempt));
        continue;
      }
    }
  }

  throw lastErr || new Error(`Failed to fetch ${url}`);
}

module.exports = { delay, fetchText };
