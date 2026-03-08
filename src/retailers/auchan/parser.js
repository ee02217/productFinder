function toCents(raw) {
  if (raw == null) return null;
  const n = parseFloat(String(raw).replace(',', '.').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function decodeHtmlEntities(str) {
  if (!str) return str;
  const named = {
    '&amp;': '&',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&ccedil;': 'ç',
    '&Ccedil;': 'Ç',
    '&atilde;': 'ã',
    '&Atilde;': 'Ã',
    '&otilde;': 'õ',
    '&Otilde;': 'Õ',
    '&aacute;': 'á',
    '&Aacute;': 'Á',
    '&eacute;': 'é',
    '&Eacute;': 'É',
    '&iacute;': 'í',
    '&Iacute;': 'Í',
    '&oacute;': 'ó',
    '&Oacute;': 'Ó',
    '&uacute;': 'ú',
    '&Uacute;': 'Ú',
    '&agrave;': 'à',
    '&Agrave;': 'À',
  };

  return String(str)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&(amp|quot|apos|#39|ccedil|Ccedil|atilde|Atilde|otilde|Otilde|aacute|Aacute|eacute|Eacute|iacute|Iacute|oacute|Oacute|uacute|Uacute|agrave|Agrave);/g, (m) => named[m] || m)
    .replace(/\s+/g, ' ')
    .trim();
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

function normalizeQty(valueRaw, unitRaw) {
  const v = parseFloat(String(valueRaw).replace(',', '.'));
  if (!Number.isFinite(v) || v <= 0) return null;
  const u = String(unitRaw || '').toLowerCase();

  if (u === 'un') return { unitCount: Math.round(v), unitType: 'un' };
  if (u === 'ml') return { unitCount: Math.round(v), unitType: 'ml' };
  if (u === 'cl') return { unitCount: Math.round(v * 10), unitType: 'ml' };
  if (u === 'l') return { unitCount: Math.round(v * 1000), unitType: 'ml' };
  if (u === 'g' || u === 'gr') return { unitCount: Math.round(v), unitType: 'g' };
  if (u === 'kg') return { unitCount: Math.round(v * 1000), unitType: 'g' };

  return null;
}

function parseQuantidadeLiquida(html) {
  // Quantidade Liquida ... 0.129 KG
  const m = html.match(/Quantidade\s+Liquida[\s\S]{0,450}?([0-9]+(?:[\.,][0-9]+)?)\s*(KG|G|GR|L|ML|CL|UN)\b/i);
  if (!m) return null;
  return normalizeQty(m[1], m[2]);
}

function parseMultipack(text) {
  if (!text) return null;
  // 6x21.5g / 6 x 21,5 g / 12x1L / 4x33cl
  const m = String(text).match(/(\d{1,3})\s*[x×]\s*([0-9]+(?:[\.,][0-9]+)?)\s*(kg|g|gr|l|ml|cl|un)\b/i);
  if (!m) return null;

  const packCount = parseInt(m[1], 10);
  const per = parseFloat(String(m[2]).replace(',', '.'));
  const unitRaw = m[3].toLowerCase();
  if (!Number.isFinite(packCount) || !Number.isFinite(per) || packCount <= 0 || per <= 0) return null;

  const normalizedPer = normalizeQty(per, unitRaw);
  if (!normalizedPer) return null;

  return {
    packCount,
    packUnitSize: per,
    packUnitType: normalizedPer.unitType,
    total: {
      unitCount: Math.round(packCount * normalizedPer.unitCount),
      unitType: normalizedPer.unitType,
    },
  };
}

function parseJsonLdProduct(html) {
  const scripts = [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1])
    .filter(Boolean);

  for (const raw of scripts) {
    try {
      const parsed = JSON.parse(raw.trim());
      const list = Array.isArray(parsed) ? parsed : [parsed];
      const product = list.find((x) => x && String(x['@type'] || '').toLowerCase() === 'product');
      if (product) return product;
    } catch (_) {
      // ignore malformed script block
    }
  }
  return null;
}

function parseBreadcrumbs(html) {
  const block = html.match(/<ol class="breadcrumb">([\s\S]*?)<\/ol>/i)?.[1] || '';
  const crumbs = [...block.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => decodeHtmlEntities(m[1]))
    .filter(Boolean);
  return crumbs;
}

function parseProduct(html, url) {
  const jsonLd = parseJsonLdProduct(html);

  const ean =
    html.match(/data-ean="(\d{8,14})"/i)?.[1] ||
    (jsonLd && (jsonLd.gtin || jsonLd.gtin13 || jsonLd.gtin8)) ||
    html.match(/Ref\.\s*\/\s*EAN:[\s\S]{0,120}?>(\d{8,14})</i)?.[1] ||
    null;

  const name =
    (jsonLd && jsonLd.name) ||
    html.match(/<h1[^>]*class="[^"]*product-name[^"]*"[^>]*>([^<]+)<\/h1>/i)?.[1] ||
    null;

  const brand =
    (jsonLd && (typeof jsonLd.brand === 'string' ? jsonLd.brand : jsonLd.brand?.name)) ||
    null;

  const imageUrl =
    (jsonLd && (Array.isArray(jsonLd.image) ? jsonLd.image[0] : jsonLd.image)) ||
    html.match(/property="og:image"\s+content="([^"]+)"/i)?.[1] ||
    null;

  const currentPrice =
    html.match(/class="sales"[\s\S]{0,240}?class="value"\s+content="([\d.]+)"/i)?.[1] ||
    (jsonLd && jsonLd.offers && jsonLd.offers.price) ||
    null;

  const oldPrice =
    html.match(/class="strike-through value"\s+content="([\d.]+)"/i)?.[1] ||
    null;

  const { pricePerKgCents, priceUnit } = parsePerUnit(html);

  // quantity precedence: Quantidade Líquida > multipack from name/url
  const qtyLiquida = parseQuantidadeLiquida(html);
  const multipack = parseMultipack(name || url);

  const unitCount = qtyLiquida?.unitCount ?? multipack?.total?.unitCount ?? null;
  const unitType = qtyLiquida?.unitType ?? multipack?.total?.unitType ?? null;

  const crumbs = parseBreadcrumbs(html);
  const category = crumbs.length >= 2 ? crumbs[1] : (crumbs[0] || null);
  const subcategory = crumbs.length >= 1 ? crumbs[crumbs.length - 1] : null;

  return {
    url,
    ean: ean ? String(ean).trim() : null,
    name: name ? decodeHtmlEntities(String(name)) : null,
    brand: brand ? decodeHtmlEntities(String(brand)) : null,
    imageUrl: imageUrl || null,
    category: category || null,
    subcategory: subcategory || null,
    priceCents: toCents(currentPrice),
    pvpCents: toCents(oldPrice),
    pricePerKgCents,
    priceUnit,
    unitCount,
    unitType,
    packCount: multipack?.packCount ?? null,
    packUnitSize: multipack?.packUnitSize ?? null,
    packUnitType: multipack?.packUnitType ?? null,
  };
}

module.exports = {
  toCents,
  parsePerUnit,
  parseQuantidadeLiquida,
  parseMultipack,
  parseProduct,
};
