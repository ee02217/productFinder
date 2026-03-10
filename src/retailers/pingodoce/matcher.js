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
 * - ADDED: hybrid similarity (token overlap + Levenshtein)
 * - ADDED: brand-aware name normalization to avoid double-counting brand
 */

const { RETAILER } = require('./constants');
const {
  normalizeForComparison,
  hybridSimilarity,
  levenshteinSimilarity,
  brandAwareNameNormalization,
  isQuantityCompatible,
  tokenContainmentRatio,
} = require('../../utils/nameNormalization');

// Thresholds for matching (strict for Pingo Doce since no EAN)
const SIMILARITY_THRESHOLDS = {
  HIGH: 0.92,    // Auto-match if similarity >= 0.92
  MEDIUM: 0.75,  // Manual review threshold - but DOES NOT auto-link
};

// Generic-name uplift configuration
// Applies to short generic names that match a branded product well
const GENERIC_NAME_UPLIFT = {
  // Minimum brand similarity to qualify for uplift (0.95 = very strong)
  MIN_BRAND_SIMILARITY: 0.95,
  // Minimum token containment ratio (0.8 = 80% of source tokens found in candidate)
  MIN_CONTAINMENT_RATIO: 0.8,
  // Uplift amount (conservative: +0.03 to +0.06)
  UPLIFT_MIN: 0.03,
  UPLIFT_MAX: 0.06,
  // Maximum final confidence (cap at 1.0)
  MAX_CONFIDENCE: 1.0,
};

/**
 * Calculate name similarity using hybrid approach with brand-aware normalization.
 * If both source and candidate have brands, strips brand tokens from names
 * before computing similarity to avoid double-counting brand.
 */
function similarity(sourceName, candidateName, sourceBrand = null, candidateBrand = null) {
  if (!sourceName || !candidateName) return 0;
  
  // Use brand-aware name normalization
  const { sourceNormalized, candidateNormalized, brandsStripped } = brandAwareNameNormalization(
    sourceName, candidateName, sourceBrand, candidateBrand
  );
  
  // If brands were stripped, use the normalized names for comparison
  // This avoids double-counting brand in name similarity
  const nameA = brandsStripped ? sourceNormalized : normalizeForComparison(sourceName);
  const nameB = brandsStripped ? candidateNormalized : normalizeForComparison(candidateName);
  
  // Use hybrid similarity (token overlap + character similarity)
  return hybridSimilarity(nameA, nameB);
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
  
  const { product, score, signals } = similarityResult;
  
  // Apply generic-name uplift if conditions are met
  let finalConfidence = score;
  let upliftSignal = null;
  
  // Only apply uplift to matches in the review band (not already high-confidence)
  if (score >= SIMILARITY_THRESHOLDS.MEDIUM && score < SIMILARITY_THRESHOLDS.HIGH && signals) {
    const uplift = calculateGenericNameUplift(parsed, product, signals);
    if (uplift) {
      upliftSignal = uplift;
      finalConfidence = Math.min(score + uplift.upliftAmount, GENERIC_NAME_UPLIFT.MAX_CONFIDENCE);
    }
  }
  
  // TIER 2: High similarity - auto-match
  // After uplift, check if we crossed the threshold
  if (finalConfidence >= SIMILARITY_THRESHOLDS.HIGH) {
    return {
      product,
      confidence: finalConfidence,
      tier: upliftSignal ? 'tier2_high_uplift' : 'tier2_high',
      reason: upliftSignal 
        ? `similarity_high_uplift:${finalConfidence.toFixed(2)}_${upliftSignal.upliftReason}`
        : `similarity_high:${finalConfidence.toFixed(2)}`,
      matchKey: `similarity:${finalConfidence.toFixed(2)}`,
      uplift: upliftSignal,
    };
  }
  
  // TIER 3: Medium similarity - UNMATCHED (no auto-link)
  // This requires manual review, does NOT auto-link
  // Still include uplift signal for transparency
  if (finalConfidence >= SIMILARITY_THRESHOLDS.MEDIUM) {
    return {
      product: null,  // CHANGED: return null instead of product
      confidence: finalConfidence,
      tier: upliftSignal ? 'tier3_review_uplift' : 'tier3_review',  // Changed tier name to indicate review needed
      reason: upliftSignal 
        ? `similarity_review_requires_manual:${finalConfidence.toFixed(2)}_${upliftSignal.upliftReason}`
        : `similarity_review_requires_manual:${finalConfidence.toFixed(2)}`,
      uplift: upliftSignal,
    };
  }
  
  // Below threshold - no match
  return {
    product: null,
    confidence: finalConfidence,
    tier: null,
    reason: `below_threshold:${finalConfidence.toFixed(2)}`,
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
    // Use brand-aware similarity - passes both names and brands
    const nameSimilarity = similarity(
      parsed.name, 
      candidate.name, 
      parsed.brand || null, 
      candidate.brand || null
    );
    const brandSimilarity = parsed.brand && candidate.brand 
      ? levenshteinSimilarity(parsed.brand, candidate.brand) 
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

/**
 * Check if a match qualifies for generic-name uplift
 * 
 * Uplift applies when:
 * - Brand similarity is strong (>=0.95 or exact normalized brand match)
 * - Quantity is compatible (same unit type, within tolerance)
 * - Source name tokens are mostly contained in candidate name (>=0.8)
 * - No brand mismatch penalty was triggered
 * 
 * @param {Object} parsed - The parsed source product
 * @param {Object} candidate - The candidate product
 * @param {Object} signals - The scoring signals from findBestSimilarityMatch
 * @returns {Object|null} - { upliftAmount, upliftReason, upliftDetails } if qualifies, null otherwise
 */
function calculateGenericNameUplift(parsed, candidate, signals) {
  const { brandSimilarity, qtyCompatible, finalScore } = signals;
  
  // Check brand similarity threshold
  const normBrand = normalizeForComparison(parsed.brand);
  const normCandidateBrand = normalizeForComparison(candidate.brand);
  const exactBrandMatch = normBrand && normCandidateBrand && normBrand === normCandidateBrand;
  const strongBrandSimilarity = brandSimilarity >= GENERIC_NAME_UPLIFT.MIN_BRAND_SIMILARITY;
  
  if (!exactBrandMatch && !strongBrandSimilarity) {
    return null;
  }
  
  // Check quantity compatibility
  if (qtyCompatible !== true) {
    return null;
  }
  
  // Check token containment ratio
  const containmentRatio = tokenContainmentRatio(parsed.name, candidate.name);
  if (containmentRatio < GENERIC_NAME_UPLIFT.MIN_CONTAINMENT_RATIO) {
    return null;
  }
  
  // Calculate uplift amount (conservative)
  // Higher containment ratio gets slightly higher uplift
  let upliftAmount = GENERIC_NAME_UPLIFT.UPLIFT_MIN;
  if (containmentRatio >= 0.9) {
    upliftAmount = GENERIC_NAME_UPLIFT.UPLIFT_MAX;
  } else if (containmentRatio >= 0.85) {
    upliftAmount = (GENERIC_NAME_UPLIFT.UPLIFT_MIN + GENERIC_NAME_UPLIFT.UPLIFT_MAX) / 2;
  }
  
  // Cap at maximum confidence
  const newConfidence = Math.min(finalScore + upliftAmount, GENERIC_NAME_UPLIFT.MAX_CONFIDENCE);
  upliftAmount = newConfidence - finalScore;
  
  return {
    upliftAmount,
    upliftReason: 'generic_name_uplift',
    upliftDetails: {
      brandSimilarity,
      exactBrandMatch,
      containmentRatio,
      qtyCompatible,
    },
  };
}

module.exports = {
  findProduct,
  similarity,
  normalizeForComparison,
  SIMILARITY_THRESHOLDS,
  isQuantityCompatible,
  GENERIC_NAME_UPLIFT,
  calculateGenericNameUplift,
};
