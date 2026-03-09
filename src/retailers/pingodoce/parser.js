/**
 * Pingo Doce Product Parser
 * 
 * Improvements:
 * - Better data-gtm-info parsing: find one with actual items (non-zero value)
 * - Extract quantity from multiple sources: Peso Líquido, URL patterns, product name
 * - Guard against bogus quantity parsing
 * - Extract from JSON-LD for rich product data
 */

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
  if (!html) return { pricePerKgCents: null, priceUnit: null };

  // Pattern 1: data-gtm-info with price/kg if available
  // e.g., data-gtm-info="..."pricePer...">39,83 €/L"
  const m1 = html.match(/pricePer[^>]*>[\s\S]*?([\d.,]+)\s*€\s*\/\s*([A-Za-z]+)/i);
  if (m1) {
    const cents = toCents(m1[1]);
    const unitRaw = (m1[2] || '').toLowerCase();
    let priceUnit = null;
    if (unitRaw === 'kg') priceUnit = 'kg';
    else if (unitRaw === 'l' || unitRaw === 'lt') priceUnit = 'l';
    else if (unitRaw === 'un') priceUnit = 'un';
    if (cents != null) return { pricePerKgCents: cents, priceUnit };
  }

  // Pattern 2: Volume/weight + price per unit
  // e.g., "0.06 L | 39,83 €/L" or "250 g | 1,16 €/Kg"
  // Also handles: "0.06L | 39,83€/L", "250g | 1,16€/Kg", "1 L | 2,50 €/L"
  const m2 = html.match(/([\d.,]+)\s*(L|l|KG|Kg|kg|G|g|ML|ml|UN|Un|un)\s*\|\s*([\d.,]+)\s*€\s*\/\s*(L|l|KG|Kg|kg|G|g|ML|ml|Un|un)/i);
  if (m2) {
    // m2[3] is the price, m2[4] is the unit
    const cents = toCents(m2[3]);
    const unitRaw = (m2[4] || '').toLowerCase();
    let priceUnit = null;
    if (unitRaw === 'kg') priceUnit = 'kg';
    else if (unitRaw === 'l' || unitRaw === 'lt') priceUnit = 'l';
    else if (unitRaw === 'un' || unitRaw === 'ml') priceUnit = 'un';
    if (cents != null) return { pricePerKgCents: cents, priceUnit };
  }

  // Pattern 3: Standalone price per unit (pricePer, €/Kg, €/L patterns)
  // e.g., "39,83 €/L", "1,16 €/Kg", "0.85 €/un"
  const m3 = html.match(/([\d.,]+)\s*€\s*\/\s*(kg|l|lt|un|ml)/i);
  if (m3) {
    const cents = toCents(m3[1]);
    const unitRaw = (m3[2] || '').toLowerCase();
    let priceUnit = null;
    if (unitRaw === 'kg') priceUnit = 'kg';
    else if (unitRaw === 'l' || unitRaw === 'lt') priceUnit = 'l';
    else if (unitRaw === 'un' || unitRaw === 'ml') priceUnit = 'un';
    if (cents != null) return { pricePerKgCents: cents, priceUnit };
  }

  return { pricePerKgCents: null, priceUnit: null };
}

function normalizeQty(valueRaw, unitRaw) {
  const v = parseFloat(String(valueRaw).replace(',', '.'));
  if (!Number.isFinite(v) || v <= 0) return null;
  const u = String(unitRaw || '').toLowerCase();

  // Guard: reject unrealistic quantities
  if (u === 'g' || u === 'gr') {
    if (v >= 50000) return null; // >= 50kg seems bogus
  }
  if (u === 'kg') {
    if (v > 1000) return null; // > 1000kg seems bogus
  }
  if (u === 'ml') {
    if (v > 100000) return null; // > 100L seems bogus
  }
  if (u === 'l') {
    if (v > 10000) return null; // > 10000L seems bogus
  }

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

/**
 * Parse quantity from product name or URL patterns
 * e.g., "massa-500g", "sopa-de-espargos-986672.html"
 */
function parseQuantityFromUrlOrName(text) {
  if (!text) return null;
  
  // Pattern: name-XXXg, name-XXXkg, name-XXxml, name-Xl, name-XXxYYg (multipack)
  // Also: product-id.html with numeric ID
  
  // Multipack: 6x21.5g / 6 x 21,5 g / 12x1L / 4x33cl
  const multipackMatch = String(text).match(/(\d{1,3})\s*[x×]\s*([0-9]+(?:[\.,][0-9]+)?)\s*(kg|g|gr|ml|cl|l|un)\b/i);
  if (multipackMatch) {
    const packCount = parseInt(multipackMatch[1], 10);
    const per = parseFloat(String(multipackMatch[2]).replace(',', '.'));
    const unitRaw = multipackMatch[3].toLowerCase();
    if (!Number.isFinite(packCount) || !Number.isFinite(per) || packCount <= 0 || per <= 0) return null;

    const normalizedPer = normalizeQty(per, unitRaw);
    if (!normalizedPer) return null;

    // Calculate total: packCount * per (not rounded per * packCount)
    const totalCount = Math.round(packCount * per);

    return {
      packCount,
      packUnitSize: per,
      packUnitType: normalizedPer.unitType,
      total: {
        unitCount: totalCount,
        unitType: normalizedPer.unitType,
      },
    };
  }
  
  // Single quantity: 500g, 1.5kg, 750ml, 2l
  const singleMatch = String(text).match(/([0-9]+(?:[\.,][0-9]+)?)\s*(kg|g|gr|ml|cl|l|un)\b/i);
  if (singleMatch) {
    const qty = normalizeQty(singleMatch[1], singleMatch[2]);
    if (qty) {
      return { total: qty };
    }
  }
  
  return null;
}

/**
 * Parse quantity from page text (looks for patterns like "0.065 Kg" or "250 g")
 * Only used as fallback when no other quantity source available
 */
function parseQuantityFromPageText(html) {
  if (!html) return null;
  
  // Look for patterns like "0.065 Kg", "250 g", "1.5 l" anywhere in the page
  // Be specific to avoid false positives
  const patterns = [
    // Decimal quantities: 0.065 Kg, 1.5 l (prefer these as they're usually real weights)
    /([0-9]+[\.,][0-9]+)\s*(kg|g|ml|cl|l)\b/i,
    // Integer quantities: 250 g, 500 ml (only smaller values to avoid false positives)
    /\b([1-9][0-9]{1,2})\s*(g|ml|cl|l)\b/i,  // 10-999 range only
  ];
  
  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m) {
      const qty = normalizeQty(m[1], m[2]);
      if (qty) return qty;
    }
  }
  
  return null;
}

function parseMultipack(text) {
  return parseQuantityFromUrlOrName(text);
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

/**
 * Parse data-gtm-info, finding the one with actual product data (non-zero value + items)
 */
function parseGtmData(html) {
  // Find ALL data-gtm-info attributes
  const matches = html.matchAll(/data-gtm-info="([^"]+)"/g);
  
  for (const match of matches) {
    try {
      const decoded = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      const parsed = JSON.parse(decoded);
      
      // Look for the one with actual product data (has items with non-zero price)
      if (parsed && parsed.items && parsed.items.length > 0) {
        const item = parsed.items[0];
        // Check if it has valid product data (item_id, non-zero value)
        if (item.item_id && parsed.value > 0) {
          return parsed;
        }
      }
    } catch (_) {
      continue;
    }
  }
  
  // Fallback: try again with any data that has items
  for (const match of matches) {
    try {
      const decoded = match[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      const parsed = JSON.parse(decoded);
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
  // Extract product ID from URL: product-name-1234.html or product-name-id.html
  // Prefer the numeric ID at the end before .html
  const match = url.match(/[-\/](\d{6,})\.html$/i) ||  // 6+ digit IDs (canonical)
                url.match(/[-\/](\d{3,6})\.html$/i);   // 3-6 digit IDs (promo variants)
  return match ? match[1] : null;
}

function parseProduct(html, url) {
  const jsonLd = parseJsonLdProduct(html);
  const gtmData = parseGtmData(html);

  // Extract internal product ID from URL
  const internalId = extractInternalId(url);

  // Product name from JSON-LD, data-gtm-info, or HTML
  const rawName =
    (jsonLd && jsonLd.name) ||
    (gtmData && gtmData.items && gtmData.items[0]?.item_name) ||
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

  // Price from data-gtm-info value field (prefer the one with actual product data)
  let currentPrice = null;
  if (gtmData && gtmData.value != null && gtmData.value > 0) {
    currentPrice = String(gtmData.value);
  }
  // Fallback: look for price in page
  if (!currentPrice) {
    // Look for price in standard location
    const priceMatch = html.match(/<span[^>]*class="[^"]*price[^"]*"[^>]*content="([\d.]+)"[^>]*>/i) ||
                       html.match(/<span[^>]*class="value"[^>]*content="([\d.]+)"[^>]*>/i);
    if (priceMatch) {
      currentPrice = priceMatch[1];
    }
  }

  // Old price - look for "was" or "original" price patterns
  const oldPrice = null;

  // Unit price - parse from page if available
  const { pricePerKgCents, priceUnit } = parsePerUnit(html);

  const decodedRawName = rawName ? decodeHtmlEntities(String(rawName)) : null;
  const decodedRawBrand = rawBrand ? decodeHtmlEntities(String(rawBrand)) : null;

  // Quantity extraction - multiple sources with priority:
  // 1. Peso Líquido (most reliable - explicit weight label)
  // 2. URL or product name patterns (explicit in URL)
  // 3. Page text patterns like "0.065 Kg" (fallback - can have false positives)
  // 
  // Guard: For page text, only accept if reasonable for the product type
  
  const pesoLiquido = parsePesoLiquido(html);
  const urlQty = parseQuantityFromUrlOrName(decodedRawName || url);
  const multipack = parseMultipack(decodedRawName || url);
  
  // Page text is fallback only - has false positives (e.g., "5kG" from "500k" or similar)
  // Only use if we don't have other sources
  let pageTextQty = null;
  if (!pesoLiquido && !urlQty && !multipack) {
    pageTextQty = parseQuantityFromPageText(html);
  }
  
  const qty = pesoLiquido || urlQty?.total || multipack?.total || pageTextQty;
  
  const unitCount = qty?.unitCount ?? null;
  const unitType = qty?.unitType ?? null;

  const cleanName = decodedRawName ? toTitleCase(stripTrailingQuantity(decodedRawName)) : null;
  const cleanBrand = decodedRawBrand ? toTitleCase(decodedRawBrand) : null;

  // Get categories from breadcrumbs or URL
  const crumbs = parseBreadcrumbs(html);
  const urlCategories = parseCategoriesFromUrl(url);
  const category = crumbs.length >= 2 ? crumbs[1] : (crumbs[0] || urlCategories.category);
  const subcategory = crumbs.length >= 1 ? crumbs[crumbs.length - 1] : (urlCategories.subcategory);

  // Use category from gtmData if available
  const gtmCategory = gtmData?.items?.[0]?.item_category;

  return {
    url,
    internalId,
    ean: null, // Pingo Doce doesn't expose EAN in HTML
    name: cleanName,
    brand: cleanBrand,
    imageUrl: imageUrl || null,
    category: gtmCategory || category || null,
    subcategory: subcategory || null,
    priceCents: toCents(currentPrice),
    pvpCents: toCents(oldPrice),
    pricePerKgCents,
    priceUnit,
    unitCount,
    unitType,
    packCount: multipack?.packCount ?? urlQty?.packCount ?? null,
    packUnitSize: multipack?.packUnitSize ?? urlQty?.packUnitSize ?? null,
    packUnitType: multipack?.packUnitType ?? urlQty?.packUnitType ?? null,
  };
}

module.exports = {
  toCents,
  parsePerUnit,
  parsePesoLiquido,
  parseMultipack,
  parseQuantityFromUrlOrName,
  parseQuantityFromPageText,
  parseProduct,
  extractInternalId,
  normalizeQty, // Export for testing guards
};
