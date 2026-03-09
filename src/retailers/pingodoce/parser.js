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
  // Pingo Doce uses data-gtm-info with price/kg if available
  // Also look for "price per" patterns in the page
  const m = html.match(/pricePer[^>]*>[\s\S]*?([\d.,]+)\s*&euro;\s*\/\s*([A-Za-z]+)/i);
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

function parsePesoLiquido(html) {
  // Pingo Doce uses "Peso Líquido" pattern
  // e.g., "Peso Líquido 250 g" or "Peso Líquido 1 l"
  const patterns = [
    /Peso\s+Líquido[\s\S]{0,450}?([0-9]+(?:[\.,][0-9]+)?)\s*(KG|G|GR|L|ML|CL|UN)\b/i,
    /Peso\s+Liquido[\s\S]{0,450}?([0-9]+(?:[\.,][0-9]+)?)\s*(KG|G|GR|L|ML|CL|UN)\b/i,
    /Peso[\s\S]{0,200}?([0-9]+(?:[\.,][0-9]+)?)\s*(KG|G|GR|L|ML|CL|UN)\b/i,
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
  const m = String(text).match(/(\d{1,3})\s*[x×]\s*([0-9]+(?:[\.,][0-9]+)?)\s*(kg|g|gr|ml|cl|l|un)\b/i);
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

function parseGtmData(html) {
  // Extract product data from data-gtm-info attribute
  // Find the one that contains item_id (the actual product data, not cart/minicart)
  const matches = html.matchAll(/data-gtm-info="([^"]+)"/g);
  for (const match of matches) {
    try {
      const decoded = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      const parsed = JSON.parse(decoded);
      // Only return if it has items (product data)
      if (parsed && parsed.items && parsed.items.length > 0) {
        return parsed;
      }
    } catch (_) {
      continue;
    }
  }
  return null;
}

function parseBreadcrumbs(html) {
  // Pingo Doce uses nav.breadcrumb or similar
  const block = html.match(/<nav[^>]*class="[^"]*breadcrumb[^"]*"[^>]*>([\s\S]*?)<\/nav>/i)?.[1] ||
                html.match(/<ol[^>]*class="[^"]*breadcrumb[^"]*"[^>]*>([\s\S]*?)<\/ol>/i)?.[1] || '';
  const crumbs = [...block.matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)]
    .map((m) => decodeHtmlEntities(m[1]))
    .filter(Boolean);
  return crumbs;
}

function parseCategoriesFromUrl(url) {
  // URL pattern: /home/produtos/category/subcategory/product-name-id.html
  try {
    const path = new URL(url).pathname;
    const segments = path.split('/').filter(Boolean);
    
    // Find 'produtos' segment and get categories after it
    const prodIdx = segments.indexOf('produtos');
    if (prodIdx === -1 || segments.length < prodIdx + 2) {
      return { category: null, subcategory: null };
    }

    const category = segments[prodIdx + 1] || null;
    const subcategory = segments[prodIdx + 2] || null;

    // Convert URL-friendly slugs to title case for display
    const formatSlug = (slug) => {
      if (!slug) return null;
      return slug
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (c) => c.toUpperCase());
    };

    return {
      category: category ? formatSlug(category) : null,
      subcategory: subcategory ? formatSlug(subcategory) : null,
    };
  } catch {
    return { category: null, subcategory: null };
  }
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
    /\s+(?:\d+\s*[x×]\s*)?\d+(?:[.,]\d+)?\s*(?:kg|g|gr|ml|cl|l|un)\s*$/i,
    /\s+\d+\s*(?:un|unid(?:ades)?|unidades?)\s*$/i,
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

function extractInternalId(url) {
  // Extract product ID from URL: product-name-1234.html
  const match = url.match(/[-\/](\d{3,6})\.html$/i);
  return match ? match[1] : null;
}

function parseProduct(html, url) {
  const jsonLd = parseJsonLdProduct(html);
  const gtmData = parseGtmData(html);

  // Pingo Doce typically doesn't expose EAN in HTML - we rely on internal ID
  // No EAN extraction available for Pingo Doce
  const internalId = extractInternalId(url);

  // Product name from JSON-LD or HTML title
  const rawName =
    (jsonLd && jsonLd.name) ||
    html.match(/<title>([^<]+)\s*\|/i)?.[1] ||
    html.match(/<h1[^>]*>([^<]+)<\/h1>/i)?.[1] ||
    null;

  // Brand extraction
  const rawBrand =
    (jsonLd && (typeof jsonLd.brand === 'string' ? jsonLd.brand : jsonLd.brand?.name)) ||
    (gtmData && gtmData.items && gtmData.items[0]?.item_brand) ||
    null;

  // Image URL from JSON-LD or og:image
  const imageUrl =
    (jsonLd && (Array.isArray(jsonLd.image) ? jsonLd.image[0] : jsonLd.image)) ||
    html.match(/property="og:image"\s+content="([^"]+)"/i)?.[1] ||
    null;

  // Price from data-gtm-info value field
  let currentPrice = null;
  if (gtmData && gtmData.value != null) {
    currentPrice = String(gtmData.value);
  }
  // Fallback to span.value content
  if (!currentPrice) {
    currentPrice = html.match(/<span[^>]*class="value"[^>]*content="([\d.]+)"[^>]*>/i)?.[1] || null;
  }

  // Old price - look for "was" or "original" price patterns
  const oldPrice = null; // Pingo Doce doesn't typically show old prices in the same way

  // Unit price - parse from page if available
  const { pricePerKgCents, priceUnit } = parsePerUnit(html);

  const decodedRawName = rawName ? decodeHtmlEntities(String(rawName)) : null;
  const decodedRawBrand = rawBrand ? decodeHtmlEntities(String(rawBrand)) : null;

  // quantity precedence: Peso Líquido > multipack from raw name/url
  const pesoLiquido = parsePesoLiquido(html);
  const multipack = parseMultipack(decodedRawName || url);

  const unitCount = pesoLiquido?.unitCount ?? multipack?.total?.unitCount ?? null;
  const unitType = pesoLiquido?.unitType ?? multipack?.total?.unitType ?? null;

  const cleanName = decodedRawName ? toTitleCase(stripTrailingQuantity(decodedRawName)) : null;
  const cleanBrand = decodedRawBrand ? toTitleCase(decodedRawBrand) : null;

  // Get categories from breadcrumbs or URL
  const crumbs = parseBreadcrumbs(html);
  const urlCategories = parseCategoriesFromUrl(url);
  const category = crumbs.length >= 2 ? crumbs[1] : (crumbs[0] || urlCategories.category);
  const subcategory = crumbs.length >= 1 ? crumbs[crumbs.length - 1] : (urlCategories.subcategory);

  return {
    url,
    internalId, // Pingo Doce internal product ID (e.g., 1805)
    ean: null, // Pingo Doce doesn't expose EAN in HTML
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
  parsePesoLiquido,
  parseMultipack,
  parseProduct,
  extractInternalId,
};
