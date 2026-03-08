require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const zlib = require('zlib');

const prisma = new PrismaClient();

const RETAILER = 'auchan';
const SITEMAP_INDEX = 'https://www.auchan.pt/sitemap_index.xml';

function parseArgs(argv) {
  const args = {
    dryRun: false,
    limit: 0,
    offset: 0,
    delayMs: 400,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    if (a === '--limit' && argv[i + 1]) args.limit = parseInt(argv[++i], 10) || 0;
    if (a === '--offset' && argv[i + 1]) args.offset = parseInt(argv[++i], 10) || 0;
    if (a === '--delay-ms' && argv[i + 1]) args.delayMs = parseInt(argv[++i], 10) || 400;
  }

  return args;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; ProductFinder/1.0; +https://localhost)',
      'accept': '*/*',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());

  // Handle gzipped sitemaps
  if (url.endsWith('.gz')) {
    return zlib.gunzipSync(buf).toString('utf8');
  }
  return buf.toString('utf8');
}

function extractLocs(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

function toCents(raw) {
  if (raw == null) return null;
  const n = parseFloat(String(raw).replace(',', '.').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function parsePerUnit(html) {
  // Example: <span class="auc-measures--price-per-unit">19.47 &euro;/Kg</span>
  const m = html.match(/auc-measures--price-per-unit[^>]*>\s*([\d.,]+)\s*&euro;\s*\/\s*([A-Za-z]+)/i);
  if (!m) return { pricePerKgCents: null, priceUnit: null };

  const cents = toCents(m[1]);
  const unitRaw = (m[2] || '').toLowerCase();

  let priceUnit = null;
  if (unitRaw === 'kg') priceUnit = 'kg';
  else if (unitRaw === 'l' || unitRaw === 'lt') priceUnit = 'l';
  else if (unitRaw === 'un') priceUnit = 'un';

  return { pricePerKgCents: cents, priceUnit };
}

function parsePackageInfo(html) {
  // Example around "Quantidade Liquida" => "0.228 KG"
  const m = html.match(/Quantidade\s+Liquida[\s\S]{0,450}?([0-9]+(?:[\.,][0-9]+)?)\s*(KG|G|GR|L|ML|CL|UN)\b/i);
  if (!m) return { unitCount: null, unitType: null };

  const v = parseFloat(String(m[1]).replace(',', '.'));
  if (!Number.isFinite(v)) return { unitCount: null, unitType: null };
  const u = m[2].toLowerCase();

  if (u === 'un') return { unitCount: Math.round(v), unitType: 'un' };
  if (u === 'ml') return { unitCount: Math.round(v), unitType: 'ml' };
  if (u === 'cl') return { unitCount: Math.round(v * 10), unitType: 'ml' };
  if (u === 'l') return { unitCount: Math.round(v * 1000), unitType: 'ml' };
  if (u === 'g' || u === 'gr') return { unitCount: Math.round(v), unitType: 'g' };
  if (u === 'kg') return { unitCount: Math.round(v * 1000), unitType: 'g' };

  return { unitCount: null, unitType: null };
}

function parseProduct(html, url) {
  const ean =
    html.match(/data-ean="(\d{8,14})"/i)?.[1] ||
    html.match(/"gtin"\s*:\s*"(\d{8,14})"/i)?.[1] ||
    html.match(/Ref\.\s*\/\s*EAN:[\s\S]{0,120}?>(\d{8,14})</i)?.[1] ||
    null;

  const currentPrice =
    html.match(/class="sales"[\s\S]{0,240}?class="value"\s+content="([\d.]+)"/i)?.[1] ||
    html.match(/"offers"\s*:\s*\{[\s\S]{0,260}?"price"\s*:\s*"([\d.]+)"/i)?.[1] ||
    null;

  const oldPrice =
    html.match(/class="strike-through value"\s+content="([\d.]+)"/i)?.[1] ||
    null;

  const { pricePerKgCents, priceUnit } = parsePerUnit(html);
  const { unitCount, unitType } = parsePackageInfo(html);

  return {
    url,
    ean,
    priceCents: toCents(currentPrice),
    pvpCents: toCents(oldPrice),
    pricePerKgCents,
    priceUnit,
    unitCount,
    unitType,
  };
}

function samePrice(latest, incoming) {
  return (
    (latest?.priceCents ?? null) === (incoming.priceCents ?? null) &&
    (latest?.pvpCents ?? null) === (incoming.pvpCents ?? null) &&
    (latest?.pricePerKgCents ?? null) === (incoming.pricePerKgCents ?? null) &&
    (latest?.priceUnit ?? null) === (incoming.priceUnit ?? null) &&
    (latest?.retailer ?? null) === RETAILER
  );
}

async function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  console.log('[AUCHAN] starting', args);

  // 1) Discover product sitemaps
  const indexXml = await fetchText(SITEMAP_INDEX);
  const sitemapLocs = extractLocs(indexXml).filter((u) => /sitemap_\d+-product\.xml$/i.test(u));
  console.log(`[AUCHAN] product sitemaps: ${sitemapLocs.length}`);

  // 2) Collect product URLs
  const productUrls = [];
  for (const sitemapUrl of sitemapLocs) {
    const xml = await fetchText(sitemapUrl);
    const urls = extractLocs(xml).filter((u) => u.includes('/pt/') && /\/\d+\.html$/i.test(u));
    productUrls.push(...urls);
  }
  const deduped = [...new Set(productUrls)];

  const offset = Math.max(0, args.offset || 0);
  const limited = args.limit > 0 ? deduped.slice(offset, offset + args.limit) : deduped.slice(offset);

  console.log(`[AUCHAN] discovered=${deduped.length} selected=${limited.length} (offset=${offset})`);

  const stats = {
    total: limited.length,
    processed: 0,
    matched: 0,
    unmatched: 0,
    inserted: 0,
    unchanged: 0,
    errors: 0,
  };

  for (const url of limited) {
    try {
      const html = await fetchText(url);
      const parsed = parseProduct(html, url);
      stats.processed++;

      if (!parsed.ean || !parsed.priceCents) {
        stats.unmatched++;
        continue;
      }

      const product = await prisma.product.findUnique({ where: { ean: parsed.ean } });
      if (!product) {
        stats.unmatched++;
        continue;
      }
      stats.matched++;

      const latest = await prisma.price.findFirst({
        where: { productId: product.id, retailer: RETAILER },
        orderBy: { capturedAt: 'desc' },
      });

      if (samePrice(latest, parsed)) {
        stats.unchanged++;
      } else if (!args.dryRun) {
        await prisma.price.create({
          data: {
            productId: product.id,
            retailer: RETAILER,
            priceCents: parsed.priceCents,
            pvpCents: parsed.pvpCents,
            pricePerKgCents: parsed.pricePerKgCents,
            priceUnit: parsed.priceUnit,
          },
        });

        // Optional enrichment: fill missing unit package info
        if (Number.isInteger(parsed.unitCount) && parsed.unitType) {
          await prisma.product.update({
            where: { id: product.id },
            data: {
              ...(product.unitCount == null ? { unitCount: parsed.unitCount } : {}),
              ...(product.unitType == null ? { unitType: parsed.unitType } : {}),
            },
          });
        }

        stats.inserted++;
      }

      if (stats.processed % 100 === 0) {
        console.log('[AUCHAN] progress', stats);
      }

      await delay(args.delayMs);
    } catch (err) {
      stats.errors++;
      console.log(`[AUCHAN] error: ${url} -> ${err.message}`);
    }
  }

  console.log('[AUCHAN] done', stats);
}

run()
  .catch((e) => {
    console.error('[AUCHAN] fatal', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
