function toCents(raw) {
  if (raw == null) return null;
  const n = parseFloat(String(raw).replace(',', '.').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function parsePerUnit(html) {
  // <span class="auc-measures--price-per-unit">19.47 &euro;/Kg</span>
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
  // Quantidade Liquida ... 0.228 KG
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

  const name =
    html.match(/"@type":"Product"[\s\S]{0,250}?"name":"([^"]+)"/i)?.[1] ||
    html.match(/<h1[^>]*class="[^"]*product-name[^"]*"[^>]*>([^<]+)<\/h1>/i)?.[1] ||
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
    name: name ? String(name).trim() : null,
    priceCents: toCents(currentPrice),
    pvpCents: toCents(oldPrice),
    pricePerKgCents,
    priceUnit,
    unitCount,
    unitType,
  };
}

module.exports = {
  toCents,
  parsePerUnit,
  parsePackageInfo,
  parseProduct,
};
