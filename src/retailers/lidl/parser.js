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
  // Lidl uses various formats for unit price
  // e.g., "€1.99/L" or "€4.99/kg" or "€0.99/un"
  const patterns = [
    /price--per-unit[^>]*>[\s\S]*?([\d.,]+)\s*&euro;\s*\/\s*([A-Za-z]+)/i,
    /unit-price[^>]*>[\s\S]*?([\d.,]+)\s*&euro;\s*\/\s*([A-Za-z]+)/i,
    /class="[^"]*unit[^"]*price[^"]*"[^>]*>[\s\S]*?([\d.,]+)\s*&euro;\s*\/\s*([A-Za-z]+)/i,
  ];

  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m) {
      const cents = toCents(m[1]);
      const unitRaw = (m[2] || '').toLowerCase();

      let priceUnit = null;
      if (unitRaw === 'kg') priceUnit = 'kg';
      else if (unitRaw === 'l' || unitRaw === 'lt') priceUnit = 'l';
      else if (unitRaw === 'un' || unitRaw === 'st') priceUnit = 'un';

      return { pricePerKgCents: cents, priceUnit };
    }
  }
  return { pricePerKgCents: null, priceUnit: null };
}

function normalizeQty(valueRaw, unitRaw) {
  const v = parseFloat(String(valueRaw).replace(',', '.'));
  if (!Number.isFinite(v) || v <= 0) return null;
  const u = String(unitRaw || '').toLowerCase();

  if (u === 'un' || u === 'st') return { unitCount: Math.round(v), unitType: 'un' };
  if (u === 'ml') return { unitCount: Math.round(v), unitType: 'ml' };
  if (u === 'cl') return { unitCount: Math.round(v * 10), unitType: 'ml' };
  if (u === 'l') return { unitCount: Math.round(v * 1000), unitType: 'ml' };
  if (u === 'g' || u === 'gr') return { unitCount: Math.round(v), unitType: 'g' };
  if (u === 'kg') return { unitCount: Math.round(v * 1000), unitType: 'g' };

  return null;
}

function parseQuantidadeLiquida(html) {
  // Try various Lidl patterns for quantity
  const patterns = [
    // Weight/Volume from nutritional info or product details
    /Quantidade\s+Liquida[\s\S]{0,450}?([0-9]+(?:[\.,][0-9]+)?)\s*(KG|G|GR|L|ML|CL|UN)\b/i,
    /Conte[uú]do[\s\S]{0,200}?([0-9]+(?:[\.,][0-9]+)?)\s*(KG|G|GR|L|ML|CL|UN)\b/i,
    /Net\s+content[\s\S]{0,200}?([0-9]+(?:[\.,][0-9]+)?)\s*(KG|G|GR|L|ML|CL|UN)\b/i,
  ];

  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m) return normalizeQty(m[1], m[2]);
  }
  return null;
}

function parseMultipack(text) {
  if (!text) return null;
  // 6x21.5g / 6 x 21,5 g / 12x1L / 4x33cl
  const m = String(text).match(/(\d{1,3})\s*[x×]\s*([0-9]+(?:[\.,][0-9]+)?)\s*(kg|g|gr|ml|cl|l|un|st)\b/i);
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
  // Lidl uses nav.breadcrumb or similar
  const block = html.match(/<nav[^>]*class="[^"]*breadcrumb[^"]*"[^>]*>([\s\S]*?)<\/nav>/i)?.[1] ||
                html.match(/<ol[^>]*class="[^"]*breadcrumb[^"]*"[^>]*>([\s\S]*?)<\/ol>/i)?.[1] || '';
  const crumbs = [...block.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => decodeHtmlEntities(m[1]))
    .filter(Boolean);
  return crumbs;
}

function toTitleCase(str) {
  if (!str) return str;
  const lower = String(str).toLocaleLowerCase('pt-PT');
  return lower.replace(/(^|[\s\-\/])(\p{L})/gu, (m, sep, ch) => `${sep}${ch.toLocaleUpperCase('pt-PT')}`);
}

function stripTrailingQuantity(name) {
  if (!name) return name;
  let s = String(name).trim();
  const patterns = [
    /\s+(?:\d+\s*[x×]\s*)?\d+(?:[.,]\d+)?\s*(?:kg|g|gr|ml|cl|l|un|st)\s*$/i,
    /\s+\d+\s*(?:un|unid(?:ades)?|unidades?|st|uni\.?)\s*$/i,
  ];

  let changed = true;
  while (changed) {
    changed = false;
    for (const p of patterns) {
      const next = s.replace(p, '');
      if (next !== s) {
        s = next.trim();
        changed = true;
      }
    }
  }
  return s;
}

function parseProduct(html, url) {
  const jsonLd = parseJsonLdProduct(html);

  // EAN extraction from various sources
  const ean =
    html.match(/data-ean="(\d{8,14})"/i)?.[1] ||
    html.match(/data-gtin="(\d{8,14})"/i)?.[1] ||
    html.match(/"ean"\s*:\s*"?(\d{8,14})"?/i)?.[1] ||
    (jsonLd && (jsonLd.gtin || jsonLd.gtin13 || jsonLd.gtin8)) ||
    null;

  // Product name from JSON-LD or HTML
  const rawName =
    (jsonLd && jsonLd.name) ||
    html.match(/<h1[^>]*class="[^"]*product[^"]*title[^"]*"[^>]*>([^<]+)<\/h1>/i)?.[1] ||
    html.match(/<h1[^>]*>([^<]+)<\/h1>/i)?.[1] ||
    null;

  // Brand extraction
  const rawBrand =
    (jsonLd && (typeof jsonLd.brand === 'string' ? jsonLd.brand : jsonLd.brand?.name)) ||
    html.match(/<[^>]*class="[^"]*product[^"]*brand[^"]*"[^>]*>([^<]+)<\/[^>]*>/i)?.[1] ||
    null;

  // Image URL
  const imageUrl =
    (jsonLd && (Array.isArray(jsonLd.image) ? jsonLd.image[0] : jsonLd.image)) ||
    html.match(/property="og:image"\s+content="([^"]+)"/i)?.[1] ||
    html.match(/<img[^>]*class="[^"]*product[^"]*image[^"]*"[^>]*src="([^"]+)"/i)?.[1] ||
    null;

  // Price extraction - Lidl uses various formats
  const currentPrice =
    html.match(/class="[^"]*price[^"]*"[^>]*>[\s\S]*?([\d.,]+)\s*&euro;/i)?.[1] ||
    html.match(/"price"\s*:\s*"?([\d.]+)"?/i)?.[1] ||
    (jsonLd && jsonLd.offers && (jsonLd.offers.price || jsonLd.offers[0]?.price)) ||
    html.match(/data-price="(\d+\.?\d*)"/i)?.[1] ||
    null;

  // Old price (if on sale)
  const oldPrice =
    html.match(/class="[^"]*strike-through[^"]*"[^>]*>([\s\S]*?)<\/[^>]*>/i)?.[1] ||
    html.match(/class="[^"]*was[^"]*"[^>]*>([\s\S]*?)<\/[^>]*>/i)?.[1] ||
    null;

  const { pricePerKgCents, priceUnit } = parsePerUnit(html);

  const decodedRawName = rawName ? decodeHtmlEntities(String(rawName)) : null;
  const decodedRawBrand = rawBrand ? decodeHtmlEntities(String(rawBrand)) : null;

  // quantity precedence: Quantidade Líquida > multipack from raw name/url
  const qtyLiquida = parseQuantidadeLiquida(html);
  const multipack = parseMultipack(decodedRawName || url);

  const unitCount = qtyLiquida?.unitCount ?? multipack?.total?.unitCount ?? null;
  const unitType = qtyLiquida?.unitType ?? multipack?.total?.unitType ?? null;

  const cleanName = decodedRawName ? toTitleCase(stripTrailingQuantity(decodedRawName)) : null;
  const cleanBrand = decodedRawBrand ? toTitleCase(decodedRawBrand) : null;

  const crumbs = parseBreadcrumbs(html);
  const category = crumbs.length >= 2 ? crumbs[1] : (crumbs[0] || null);
  const subcategory = crumbs.length >= 1 ? crumbs[crumbs.length - 1] : null;

  return {
    url,
    ean: ean ? String(ean).trim() : null,
    name: cleanName,
    brand: cleanBrand,
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
