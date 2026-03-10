// Product parsing utilities for Continente
// Adapted from scraper.js extractProductData function

function toCents(raw) {
  if (raw == null) return null;
  const n = parseFloat(String(raw).replace(',', '.').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

function extractPriceNumber(s) {
  if (!s) return null;
  const m = String(s).match(/(\d+[,\.]\d{2})/);
  return m ? m[1].replace('.', ',') : null;
}

function normalizePackage(valueRaw, unitRaw) {
  const v = parseFloat(String(valueRaw).replace(',', '.'));
  if (!Number.isFinite(v) || v <= 0) return null;
  const u = String(unitRaw || '').toLowerCase();

  if (['un', 'unid', 'unidade', 'unidades'].includes(u)) {
    return { unitCount: Math.round(v), unitType: 'un' };
  }
  if (u === 'ml') {
    return { unitCount: Math.round(v), unitType: 'ml' };
  }
  if (u === 'cl') {
    return { unitCount: Math.round(v * 10), unitType: 'ml' };
  }
  if (u === 'l') {
    return { unitCount: Math.round(v * 1000), unitType: 'ml' };
  }
  if (u === 'g' || u === 'gr') {
    return { unitCount: Math.round(v), unitType: 'g' };
  }
  if (u === 'kg') {
    return { unitCount: Math.round(v * 1000), unitType: 'g' };
  }
  return null;
}

function extractPackageInfo(s) {
  if (!s) return null;
  const txt = String(s);

  const withContext = /(?:emb\.?|pack(?:\s+poupan[çc]a)?|caixa|cx\.?)\s*([0-9]+(?:[\.,][0-9]+)?)\s*(un|unid|unidade|unidades|ml|cl|l|gr|g|kg)\b/i;
  const m1 = txt.match(withContext);
  if (m1) return normalizePackage(m1[1], m1[2]);

  const re = /([0-9]+(?:[\.,][0-9]+)?)\s*(un|unid|unidade|unidades|ml|cl|l|gr|g|kg)\b/ig;
  let m;
  while ((m = re.exec(txt)) !== null) {
    const idx = m.index;
    const before = txt.substring(Math.max(0, idx - 4), idx).toLowerCase();
    if (before.includes('€/') || before.endsWith('/')) continue;
    const normalized = normalizePackage(m[1], m[2]);
    if (normalized) return normalized;
  }
  return null;
}

// Category mapping from URL to display names
const CATEGORY_MAP = {
  'mercearia': 'Mercearia',
  'frescos': 'Frescos',
  'laticinios-e-ovos': 'Laticínios',
  'congelados': 'Congelados',
  'bebidas-e-garrafeira': 'Bebidas',
  'limpeza': 'Limpeza',
  'higiene': 'Higiene',
  'bebe': 'Bebé',
  'animais': 'Animais',
  'bio-e-saudavel': 'Bio e Saudável',
  'arroz-massa-e-farinha': 'Arroz, Massa e Farinha',
  'cafe-cha-e-bebidas-soluveis': 'Café, Chá e Bebidas Solúveis',
  'bolachas-biscoitos-e-tostas': 'Bolachas, Biscoitos e Tostas',
  'chocolate-gomas-e-rebucados': 'Chocolate, Gomas e Rebucados',
  'frutas': 'Frutas',
  'legumes': 'Legumes',
  'peixaria': 'Peixaria',
  'talho': 'Talho',
  'leite': 'Leite',
  'iogurtes': 'Iogurtes',
  'gelados': 'Gelados',
};

function parseCategoryFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const parts = path.split('/').filter(Boolean);
    
    if (parts.length === 0) return { category: null, subcategory: null };
    
    const categorySlug = parts[0];
    const subcategorySlug = parts[1] || null;
    
    const category = CATEGORY_MAP[categorySlug] || categorySlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const subcategory = subcategorySlug ? (CATEGORY_MAP[subcategorySlug] || subcategorySlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())) : null;
    
    return { category, subcategory };
  } catch {
    return { category: null, subcategory: null };
  }
}

function parseProduct(html, url, categoryInfo = null) {
  // This is a placeholder - actual parsing happens in the runner
  // using page.evaluate for DOM access
  return { url, html };
}

async function extractProductDataFromPage(page, categorySlug = null) {
  const currentUrl = page.url || '';
  
  const result = await page.evaluate((url, catSlug) => {
    const eanMatch = document.body.innerHTML.match(/ean=([0-9]{13})/);
    const nameEl = document.querySelector('h1');
    const brandEl = document.querySelector('a[href*="/pesquisa/"]');
    
    // Find product image
    const allImgs = Array.from(document.querySelectorAll('img')).filter(img => 
      img.src && img.src.length > 50 && !img.src.includes('logo') && !img.src.includes('footer')
    );
    const withSize = allImgs.map(img => ({
      src: img.src,
      width: img.width || img.naturalWidth || 0,
      alt: img.alt || ''
    })).filter(img => img.width > 100);
    const productImg = withSize.find(img => img.alt && img.alt.length > 5) || withSize[0];
    const imageUrl = productImg ? productImg.src : null;
    
    // Extract breadcrumbs
    let breadcrumbs = [];
    const breadcrumbNav = document.querySelector('nav[aria-label="Breadcrumb"]');
    if (breadcrumbNav) {
      const links = breadcrumbNav.querySelectorAll('a, span');
      const items = Array.from(links).map(el => el.textContent.trim()).filter(t => t.length > 0 && t.length < 60);
      const filtered = items.filter(t => 
        !t.toLowerCase().includes('página inicial') && 
        !t.toLowerCase().includes('home') &&
        t !== 'Arroz' && t !== 'Massa' && t !== 'Farinha'
      );
      const unique = [];
      for (const item of filtered) {
        if (!unique.includes(item)) unique.push(item);
        if (unique.length >= 3) break;
      }
      breadcrumbs = unique;
    }
    
    // Get text content with price fix
    let text = document.body.innerText;
    const lines = text.split('\n');
    let fixedLines = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      if (line.match(/^,\d.*€/)) {
        fixedLines.push('0' + line);
        continue;
      }
      
      if (line.match(/^\d+$/) && i + 1 < lines.length) {
        const next = lines[i + 1].trim();
        if (next.match(/^,\d.*€/)) {
          fixedLines.push(line + next);
          i++;
          continue;
        }
      }
      
      if (line.match(/^\d+[\s,]\d+.*$/) && i + 1 < lines.length) {
        const next = lines[i + 1].trim();
        if (next === '/kg' || next.startsWith('/kg')) {
          fixedLines.push(line + '€/kg');
          i++;
          continue;
        }
      }
      
      fixedLines.push(line);
    }
    text = fixedLines.join(' ');
    
    // Price extraction
    let unitPrice = null;
    let pricePerKg = null;
    let priceUnit = null;
    let pvpPrice = null;
    
    // Primary/secondary price blocks
    unitPrice = extractPriceNumber(document.querySelector('.pwc-tile--price-primary')?.textContent);
    const secondaryText = document.querySelector('.pwc-tile--price-secondary')?.textContent || '';
    const secondaryNorm = secondaryText.toLowerCase().replace(/\s+/g, '');
    pricePerKg = extractPriceNumber(secondaryText);
    
    // Package info
    let unitCount = null;
    let unitType = null;
    
    const pkgFromSecondary = extractPackageInfo(secondaryText);
    if (pkgFromSecondary) {
      unitCount = pkgFromSecondary.unitCount;
      unitType = pkgFromSecondary.unitType;
    }
    
    // Determine price-per unit type
    if (secondaryNorm.includes('/kg')) priceUnit = 'kg';
    else if (secondaryNorm.includes('/l') || secondaryNorm.includes('/lt')) priceUnit = 'l';
    else if (secondaryNorm.includes('/un')) priceUnit = 'un';
    
    // PVPR/original price
    const pvprText = document.querySelector('.prices-wrapper .list')?.textContent;
    const pvprMatch = pvprText ? pvprText.match(/PVPR\s*(\d+[,\.]\d{2})\s*€/i) : null;
    if (pvprMatch) pvpPrice = pvprMatch[1].replace('.', ',');
    
    // Fallback: scan text
    if (!unitPrice || (!pricePerKg && !pvpPrice)) {
      const priceMatches = [...text.matchAll(/(\d+[\s,]\d{2})\s*€/g)];
      for (const match of priceMatches) {
        const priceValue = match[1];
        const endPos = match.index + match[0].length;
        const beforeText = text.substring(Math.max(0, match.index - 10), match.index).toUpperCase();
        const afterText = text.substring(endPos, endPos + 15).toUpperCase().replace(/\s+/g, '');
        
        if (beforeText.includes('PVPR') || beforeText.includes('PVP')) {
          if (!pvpPrice) pvpPrice = priceValue;
          continue;
        }
        
        const afterClean = afterText.replace(/€/g, '');
        if (afterClean.includes('/KG') || afterClean.includes('/L') || afterClean.includes('/LT') || afterClean.includes('/UN')) {
          if (!pricePerKg) pricePerKg = priceValue;
          if (!priceUnit) {
            if (afterClean.includes('/KG')) priceUnit = 'kg';
            else if (afterClean.includes('/LT')) priceUnit = 'l';
            else if (afterClean.includes('/L')) priceUnit = 'l';
            else if (afterClean.includes('/UN')) priceUnit = 'un';
          }
          if (!unitPrice) unitPrice = priceValue;
        } else if (!unitPrice) {
          unitPrice = priceValue;
        }
      }
    }
    
    if (!unitPrice && pricePerKg) unitPrice = pricePerKg;
    
    // Fallback package extraction
    if (!unitCount || !unitType) {
      const pkgFromText = extractPackageInfo(text);
      if (pkgFromText) {
        if (!unitCount) unitCount = pkgFromText.unitCount;
        if (!unitType) unitType = pkgFromText.unitType;
      }
    }
    
    // Parse category from URL
    let productCategory = null, productSubcategory = null;
    if (catSlug && catSlug.includes('/')) {
      const parts = catSlug.split('/');
      const pathToName = {
        'mercearia': 'Mercearia', 'frescos': 'Frescos', 'laticinios-e-ovos': 'Laticínios',
        'congelados': 'Congelados', 'bebidas-e-garrafeira': 'Bebidas',
      };
      if (parts[0] && pathToName[parts[0]]) {
        productCategory = pathToName[parts[0]];
      }
    }
    
    return {
      ean: eanMatch ? eanMatch[1] : null,
      name: nameEl ? nameEl.textContent.trim() : null,
      brand: brandEl ? brandEl.textContent.trim() : null,
      imageUrl,
      category: productCategory,
      subcategory: productSubcategory,
      breadcrumbs,
      unitCount: Number.isInteger(unitCount) ? unitCount : null,
      unitType,
      price: unitPrice || null,
      pricePerKg: pricePerKg || null,
      priceUnit,
      pvp: pvpPrice || null,
    };
  }, currentUrl, categorySlug);
  
  return result;
}

module.exports = {
  toCents,
  extractPriceNumber,
  normalizePackage,
  extractPackageInfo,
  parseCategoryFromUrl,
  parseProduct,
  extractProductDataFromPage,
};
