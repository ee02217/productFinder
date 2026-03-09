/**
 * Pingo Doce Product Matcher
 * 
 * Strict deterministic matching without EAN dependency:
 * 1. TIER 1 (exact): exact normalized brand + exact normalized name + compatible quantity/unit
 * 2. TIER 2 (high similarity): similarity >= 0.92 - auto-match
 * 3. TIER 3 (medium): similarity >= 0.75 - UNMATCHED (manual review only, NO auto-link)
 * 4. Below 0.75: no match
 * 
 * Key fixes:
 * - REMOVED: skip candidates with EAN (should match any existing product)
 * - ADDED: strict deterministic tier for exact brand+name+qty matches
 * - CHANGED: medium confidence now returns unmatched (no auto-link)
 */

const { RETAILER } = require('./constants');

// Thresholds for matching (strict for Pingo Doce since no EAN)
const SIMILARITY_THRESHOLDS = {
  HIGH: 0.92,    // Auto-match if similarity >= 0.92
  MEDIUM: 0.75,  // Manual review threshold - but DOES NOT auto-link
};

function normalizeForComparison(str) {
  if (!str) return '';
  return String(str)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Remove diacritics
    .replace(/[^a-z0-9\s]/g, '')      // Remove special chars
    .replace(/\s+/g, ' ')             // Normalize whitespace
    .trim();
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const normA = normalizeForComparison(a);
  const normB = normalizeForComparison(b);
  
  if (normA === normB) return 1;
  if (normA.length === 0 || normB.length === 0) return 0;

  // Simple Levenshtein-based similarity
  const longer = normA.length > normB.length ? normA : normB;
  const shorter = normA.length > normB.length ? normB : normA;
  
  const editDistance = levenshtein(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function levenshtein(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[b.length][a.length];
}

/**
 * Check if two quantity values are compatible (same unit type, within tolerance)
 */
function isQuantityCompatible(q1, q2) {
  if (!q1 || !q2) return null;
  if (q1.unitType !== q2.unitType) return false;
  
  // Allow 5% variance for quantity differences
  const ratio = q1.unitCount / q2.unitCount;
  return ratio >= 0.95 && ratio <= 1.05;
}

function exactMatchKey(parsed) {
  // Create a key for exact matching: normalized brand+name
  const brand = normalizeForComparison(parsed.brand);
  const name = normalizeForComparison(parsed.name);
  
  return `${brand}|${name}`;
}

/**
 * Find product by STRICT deterministic exact match:
 * - exact normalized brand
 * - exact normalized name
 * - compatible quantity/unit (if both exist)
 */
async function findProductByExactMatch(prisma, parsed) {
  if (!parsed.name) return null;
  
  const normBrand = normalizeForComparison(parsed.brand);
  const normName = normalizeForComparison(parsed.name);
  
  if (!normName) return null;
  
  // Find products with matching normalized name
  const candidates = await prisma.product.findMany({
    where: {
      name: { not: null },
    },
    take: 500,
  });
  
  for (const candidate of candidates) {
    const candBrand = normalizeForComparison(candidate.brand);
    const candName = normalizeForComparison(candidate.name);
    
    // Check exact match on brand + name
    if (candBrand !== normBrand || candName !== normName) {
      continue;
    }
    
    // If both have quantity info, check compatibility
    if (parsed.unitCount && parsed.unitType && candidate.unitCount && candidate.unitType) {
      const compatible = isQuantityCompatible(
        { unitCount: parsed.unitCount, unitType: parsed.unitType },
        { unitCount: candidate.unitCount, unitType: candidate.unitType }
      );
      if (compatible === false) {
        continue; // Quantity mismatch - not an exact match
      }
      // If compatible (true) or both null, proceed
    }
    
    // Found exact match
    return candidate;
  }
  
  return null;
}

async function findProductBySimilarity(prisma, parsed) {
  if (!parsed.name) return null;
  
  // Get all products as candidates
  const candidates = await prisma.product.findMany({
    where: {
      name: { not: null },
    },
    take: 500,
  });
  
  let bestMatch = null;
  let bestScore = 0;
  let bestReason = null;
  
  for (const candidate of candidates) {
    // REMOVED: Skip if candidate has EAN
    // Products with EAN from other retailers should still be matched
    
    const nameSimilarity = similarity(parsed.name, candidate.name);
    const brandSimilarity = parsed.brand && candidate.brand 
      ? similarity(parsed.brand, candidate.brand) 
      : (parsed.brand === candidate.brand ? 1 : 0);
    
    // Combined score with weighting
    const combinedScore = (nameSimilarity * 0.7) + (brandSimilarity * 0.3);
    
    // Check quantity match if both have quantity info
    let qtyScore = 0;
    let qtyCompatible = null;
    if (parsed.unitCount && parsed.unitType && candidate.unitCount && candidate.unitType) {
      const compatible = isQuantityCompatible(
        { unitCount: parsed.unitCount, unitType: parsed.unitType },
        { unitCount: candidate.unitCount, unitType: candidate.unitType }
      );
      if (compatible === true) {
        qtyScore = 1;
        qtyCompatible = true;
      } else if (compatible === false) {
        qtyCompatible = false;
      }
    }
    
    const finalScore = (combinedScore * 0.7) + (qtyScore * 0.3);
    
    if (finalScore > bestScore) {
      bestScore = finalScore;
      bestMatch = candidate;
      bestReason = {
        nameSimilarity,
        brandSimilarity,
        qtyScore,
        qtyCompatible,
        finalScore,
      };
    }
  }
  
  return { product: bestMatch, score: bestScore, reason: bestReason };
}

async function findProduct(prisma, parsed) {
  // Defensive wrapper: catch any errors and return safe unmatched result
  try {
    return await findProductSafe(prisma, parsed);
  } catch (err) {
    // Return safe result instead of throwing - runner will handle gracefully
    return {
      product: null,
      confidence: 0,
      tier: null,
      reason: `matcher_error:${err.message.slice(0, 80)}`,
    };
  }
}

async function findProductSafe(prisma, parsed) {
  // Pingo Doce strategy:
  // 1. No EAN available - skip EAN lookup
  // 2. TIER 1: Strict exact match on brand+name+quantity compatibility
  // 3. TIER 2: High similarity (>= 0.92) - auto-match
  // 4. TIER 3: Medium similarity (>= 0.75) - UNMATCHED, requires manual review
  
  // Build safe query: use contains with normalized name hints, cap at 100 candidates
  const normName = parsed.name ? normalizeForComparison(parsed.name) : '';
  
  // Safe query construction - never use empty objects in AND arrays
  const queryWhere = { name: { not: null } };
  if (normName && normName.length >= 3) {
    queryWhere.name = { contains: normName, mode: 'insensitive' };
  }
  
  const candidates = await prisma.product.findMany({
    where: queryWhere,
    take: 100, // Cap candidates to avoid memory issues
  });
  
  // TIER 1: Try strict exact match (brand + name + quantity compatibility)
  const exactCandidate = findExactMatchFromCandidates(candidates, parsed);
  if (exactCandidate) {
    const hasQtyInfo = parsed.unitCount && parsed.unitType;
    return {
      product: exactCandidate,
      confidence: 1.0,
      tier: 'tier1_exact',
      reason: hasQtyInfo ? 'exact_brand_name_qty' : 'exact_brand_name',
      matchKey: exactMatchKey(parsed),
    };
  }
  
  // TIER 2/3: Try similarity matching
  const similarityResult = findBestSimilarityMatch(candidates, parsed);
  
  if (!similarityResult.product) {
    return {
      product: null,
      confidence: 0,
      tier: null,
      reason: 'no_candidate_found',
    };
  }
  
  const { product, score } = similarityResult;
  
  // TIER 2: High similarity - auto-match
  if (score >= SIMILARITY_THRESHOLDS.HIGH) {
    return {
      product,
      confidence: score,
      tier: 'tier2_high',
      reason: `similarity_high:${score.toFixed(2)}`,
      matchKey: `similarity:${score.toFixed(2)}`,
    };
  }
  
  // TIER 3: Medium similarity - UNMATCHED (no auto-link)
  // This requires manual review, does NOT auto-link
  if (score >= SIMILARITY_THRESHOLDS.MEDIUM) {
    return {
      product: null,  // CHANGED: return null instead of product
      confidence: score,
      tier: 'tier3_review',  // Changed tier name to indicate review needed
      reason: `similarity_review_requires_manual:${score.toFixed(2)}`,
    };
  }
  
  // Below threshold - no match
  return {
    product: null,
    confidence: score,
    tier: null,
    reason: `below_threshold:${score.toFixed(2)}`,
  };
}

/**
 * Find exact match from pre-fetched candidates (avoid DB call per product)
 */
function findExactMatchFromCandidates(candidates, parsed) {
  if (!parsed.name) return null;
  
  const normBrand = normalizeForComparison(parsed.brand);
  const normName = normalizeForComparison(parsed.name);
  
  if (!normName) return null;
  
  for (const candidate of candidates) {
    const candBrand = normalizeForComparison(candidate.brand);
    const candName = normalizeForComparison(candidate.name);
    
    // Check exact match on brand + name
    if (candBrand !== normBrand || candName !== normName) {
      continue;
    }
    
    // If both have quantity info, check compatibility
    if (parsed.unitCount && parsed.unitType && candidate.unitCount && candidate.unitType) {
      const compatible = isQuantityCompatible(
        { unitCount: parsed.unitCount, unitType: parsed.unitType },
        { unitCount: candidate.unitCount, unitType: candidate.unitType }
      );
      if (compatible === false) {
        continue; // Quantity mismatch - not an exact match
      }
    }
    
    // Found exact match
    return candidate;
  }
  
  return null;
}

/**
 * Find best similarity match from pre-fetched candidates
 */
function findBestSimilarityMatch(candidates, parsed) {
  if (!parsed.name) return { product: null, score: 0 };
  
  let bestMatch = null;
  let bestScore = 0;
  let bestReason = null;
  
  for (const candidate of candidates) {
    const nameSimilarity = similarity(parsed.name, candidate.name);
    const brandSimilarity = parsed.brand && candidate.brand 
      ? similarity(parsed.brand, candidate.brand) 
      : (parsed.brand === candidate.brand ? 1 : 0);
    
    // Combined score with weighting
    const combinedScore = (nameSimilarity * 0.7) + (brandSimilarity * 0.3);
    
    // Check quantity match if both have quantity info
    let qtyScore = 0;
    let qtyCompatible = null;
    if (parsed.unitCount && parsed.unitType && candidate.unitCount && candidate.unitType) {
      const compatible = isQuantityCompatible(
        { unitCount: parsed.unitCount, unitType: parsed.unitType },
        { unitCount: candidate.unitCount, unitType: candidate.unitType }
      );
      if (compatible === true) {
        qtyScore = 1;
        qtyCompatible = true;
      } else if (compatible === false) {
        qtyCompatible = false;
      }
    }
    
    const finalScore = (combinedScore * 0.7) + (qtyScore * 0.3);
    
    if (finalScore > bestScore) {
      bestScore = finalScore;
      bestMatch = candidate;
      bestReason = {
        nameSimilarity,
        brandSimilarity,
        qtyScore,
        qtyCompatible,
        finalScore,
      };
    }
  }
  
  return { product: bestMatch, score: bestScore, reason: bestReason };
}

module.exports = {
  findProduct,
  similarity,
  normalizeForComparison,
  SIMILARITY_THRESHOLDS,
  isQuantityCompatible,
};
