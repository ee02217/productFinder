/**
 * Lidl Product Matcher
 * 
 * Matching strategy:
 * 1. EAN-first (existing) - exact EAN match
 * 2. Tier 1 (deterministic) - exact normalized brand + name + quantity/unit
 * 3. Tier 2 (conservative similarity) - weighted score with high threshold
 */

const { RETAILER } = require('./constants');

// Weight configuration for Tier 2 similarity scoring
const MATCH_WEIGHTS = {
  nameExact: 0.50,       // Exact name match
  nameSimilarity: 0.25,   // Name similarity score
  brandExact: 0.15,       // Brand exact match
  brandAlias: 0.10,      // Brand alias match
  quantityMatch: 0.00,   // Quantity compatibility (bonus, not deducted)
};

// Threshold for auto-matching (Tier 2)
const TIER2_HIGH_THRESHOLD = 0.90;  // Auto-match above this
const TIER2_MEDIUM_THRESHOLD = 0.70; // Below this = no match; between = review

// Brand aliases - maps common variations to canonical names
const BRAND_ALIASES = {
  // Lidl-specific brands
  'welchevita': 'welchevita',
  'biologic': 'biologic',
  'crespo': 'crespo',
  'sofree': 'sofree',
  'freeway': 'freeway',
  'alvalle': 'alvalle',
  'tavola': 'tavola',
  'pastificio': 'pastificio',
  'canada': 'canada',
  'domac': 'domac',
  'delacre': 'delacre',
  'ricqlès': 'ricqles',
  'julius': 'julius',
  'bjorg': 'bjorg',
  'allerheiligen': 'allerheiligen',
  'schwarzwald': 'schwarzwald',
  'san lucar': 'san lucar',
  'sanlucar': 'sanlucar',
  // Common brand name variations
  'pao': 'pão',  // Portuguese
  'pao de forma': 'pão de forma',
  'leite': 'leite',
};

/**
 * Normalize a string for comparison:
 * - lowercase
 * - remove accents
 * - remove extra whitespace
 * - remove common punctuation
 */
function normalizeString(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // remove accents
    .replace(/[^\w\s]/g, ' ')        // replace punctuation with space
    .replace(/\s+/g, ' ')             // collapse whitespace
    .trim();
}

/**
 * Normalize quantity for comparison:
 * - convert to standard units (g, ml, un)
 * - return null if invalid
 */
function normalizeQuantity(unitCount, unitType) {
  if (!unitCount || !unitType) return null;
  
  const normalized = {
    count: unitCount,
    type: unitType.toLowerCase().trim(),
  };
  
  // Normalize to base units
  if (normalized.type === 'kg') {
    normalized.count = unitCount * 1000;
    normalized.type = 'g';
  } else if (normalized.type === 'l') {
    normalized.count = unitCount * 1000;
    normalized.type = 'ml';
  } else if (normalized.type === 'cl') {
    normalized.count = unitCount * 10;
    normalized.type = 'ml';
  }
  
  return normalized;
}

/**
 * Check if two normalized quantities are compatible
 * Allow 5% variance for floating point differences
 */
function isQuantityCompatible(q1, q2) {
  if (!q1 || !q2) return null;  // Can't determine
  if (q1.type !== q2.type) return false;
  
  const ratio = Math.max(q1.count, q2.count) / Math.min(q1.count, q2.count);
  return ratio <= 1.05;  // Within 5% difference
}

/**
 * Calculate Jaro-Winkler similarity between two strings
 * This is more forgiving than Levenshtein for product names
 */
function jaroWinklerSimilarity(s1, s2) {
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  
  const len1 = s1.length;
  const len2 = s2.length;
  
  if (len1 === 0 || len2 === 0) return 0;
  
  const matchWindow = Math.floor(Math.max(len1, len2) / 2) - 1;
  
  const s1Matches = new Array(len1).fill(false);
  const s2Matches = new Array(len2).fill(false);
  
  let matches = 0;
  let transpositions = 0;
  
  // Find matches
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, len2);
    
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }
  
  if (matches === 0) return 0;
  
  // Count transpositions
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }
  
  const jaro = (
    matches / len1 +
    matches / len2 +
    (matches - transpositions / 2) / matches
  ) / 3;
  
  // Winkler modification - bonus for common prefix
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(len1, len2)); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Get canonical brand name from alias
 */
function getCanonicalBrand(brand) {
  if (!brand) return null;
  const normalized = normalizeString(brand);
  return BRAND_ALIASES[normalized] || normalized;
}

/**
 * EAN-first matching (existing)
 */
async function findProductByEan(prisma, ean) {
  if (!ean) return null;
  return prisma.product.findUnique({ where: { ean } });
}

/**
 * Tier 1: Deterministic matching
 * Exact normalized brand + normalized product name + normalized quantity/unit
 */
async function findProductByTier1(prisma, { brand, name, unitCount, unitType }) {
  if (!brand || !name) return null;
  
  const normBrand = normalizeString(brand);
  const normName = normalizeString(name);
  const normQty = normalizeQuantity(unitCount, unitType);

  // Query candidates: filter by normalized brand to avoid loading all products
  // Use case-insensitive contains on the normalized brand
  const candidates = await prisma.product.findMany({
    where: {
      brand: {
        not: null,
        // Use contains with mode case-insensitive for partial brand match
        // This reduces the candidate set significantly
      },
    },
    include: {
      prices: {
        where: { retailer: RETAILER },
        orderBy: { capturedAt: 'desc' },
        take: 1,
      },
    },
    // Limit candidates to prevent bind variable overflow and memory issues
    take: 5000,
  });
  
  for (const product of candidates) {
    const prodBrandNorm = normalizeString(product.brand);
    const prodNameNorm = normalizeString(product.name);
    
    // Exact match on normalized brand and name
    if (prodBrandNorm !== normBrand) continue;
    if (prodNameNorm !== normName) continue;
    
    // Check quantity if both have it
    if (normQty) {
      const prodQty = normalizeQuantity(product.unitCount, product.unitType);
      if (prodQty && !isQuantityCompatible(normQty, prodQty)) continue;
    }
    
    return {
      product,
      confidence: 1.0,
      tier: 1,
      reason: 'exact_brand_name_quantity_match',
      signals: {
        brandMatch: true,
        nameMatch: true,
        quantityMatch: !!normQty,
      },
    };
  }
  
  return null;
}

/**
 * Tier 2: Conservative similarity matching
 * Weighted score using name similarity, brand exact/alias match, quantity compatibility
 */
async function findProductByTier2(prisma, { brand, name, unitCount, unitType }) {
  if (!name) return null;
  
  const normBrand = normalizeString(brand);
  const normName = normalizeString(name);
  const normQty = normalizeQuantity(unitCount, unitType);
  
  // Get products as candidates with a reasonable limit to prevent bind variable overflow
  // In production, this should use database-side similarity (e.g., pg_trgm) for better performance
  const candidates = await prisma.product.findMany({
    include: {
      prices: {
        where: { retailer: RETAILER },
        orderBy: { capturedAt: 'desc' },
        take: 1,
      },
    },
    // Limit to prevent memory/bind variable issues - adjust based on performance needs
    take: 5000,
  });
  
  let bestMatch = null;
  let bestScore = 0;
  
  for (const product of candidates) {
    const prodBrandNorm = normalizeString(product.brand);
    const prodNameNorm = normalizeString(product.name);
    
    // Calculate name similarity
    const nameSimilarity = jaroWinklerSimilarity(normName, prodNameNorm);
    
    // Brand match scores
    let brandScore = 0;
    if (prodBrandNorm === normBrand) {
      brandScore = MATCH_WEIGHTS.brandExact;
    } else {
      // Check alias
      const canonicalBrand = getCanonicalBrand(brand);
      const prodCanonicalBrand = getCanonicalBrand(product.brand);
      if (canonicalBrand && prodCanonicalBrand && canonicalBrand === prodCanonicalBrand) {
        brandScore = MATCH_WEIGHTS.brandAlias;
      }
    }
    
    // Quantity compatibility bonus
    let qtyBonus = 0;
    if (normQty) {
      const prodQty = normalizeQuantity(product.unitCount, product.unitType);
      if (prodQty && isQuantityCompatible(normQty, prodQty)) {
        qtyBonus = MATCH_WEIGHTS.quantityMatch;
      }
    }
    
    // Calculate total score
    const exactNameBonus = nameSimilarity === 1.0 ? MATCH_WEIGHTS.nameExact : 0;
    const nameSimScore = nameSimilarity * MATCH_WEIGHTS.nameSimilarity;
    
    const totalScore = exactNameBonus + nameSimScore + brandScore + qtyBonus;
    
    // Only consider if above minimum threshold
    if (totalScore > bestScore && totalScore >= TIER2_MEDIUM_THRESHOLD) {
      bestScore = totalScore;
      bestMatch = {
        product,
        confidence: totalScore,
        tier: 2,
        reason: totalScore >= TIER2_HIGH_THRESHOLD 
          ? 'high_confidence_similarity_match' 
          : 'medium_confidence_similarity_review',
        signals: {
          nameSimilarity: Math.round(nameSimilarity * 100) / 100,
          brandExact: brandScore === MATCH_WEIGHTS.brandExact,
          brandAlias: brandScore === MATCH_WEIGHTS.brandAlias,
          quantityCompatible: qtyBonus > 0,
        },
      };
    }
  }
  
  return bestMatch;
}

/**
 * Main fallback matching function:
 * - Tier 1: deterministic exact match
 * - Tier 2: similarity-based match with thresholds
 * Returns null if no confident match found
 */
async function findProductByFallback(prisma, parsedProduct) {
  // Tier 1: Deterministic matching
  const tier1Result = await findProductByTier1(prisma, parsedProduct);
  if (tier1Result) {
    return tier1Result;
  }
  
  // Tier 2: Similarity matching
  const tier2Result = await findProductByTier2(prisma, parsedProduct);
  if (tier2Result) {
    return tier2Result;
  }
  
  return null;
}

/**
 * Full matching pipeline:
 * 1. Try EAN first (existing)
 * 2. Fallback to Tier 1/2 if no EAN
 */
async function findProduct(prisma, { ean, brand, name, unitCount, unitType }) {
  // First try EAN
  if (ean) {
    const product = await findProductByEan(prisma, ean);
    if (product) {
      return {
        product,
        confidence: 1.0,
        tier: 'ean',
        reason: 'ean_match',
        signals: { eanMatch: true },
      };
    }
  }
  
  // Fallback matching (no EAN or EAN not found)
  return findProductByFallback(prisma, { brand, name, unitCount, unitType });
}

module.exports = {
  // Existing
  findProductByEan,
  // New exports
  findProductByFallback,
  findProduct,
  // Utilities (exposed for testing)
  normalizeString,
  normalizeQuantity,
  isQuantityCompatible,
  jaroWinklerSimilarity,
  getCanonicalBrand,
  // Constants
  MATCH_WEIGHTS,
  TIER2_HIGH_THRESHOLD,
  TIER2_MEDIUM_THRESHOLD,
};
