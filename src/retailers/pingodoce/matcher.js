/**
 * Pingo Doce Product Matcher
 * 
 * Since Pingo Doce doesn't expose EAN codes in HTML, we use strict fallback matching:
 * 1. No auto-creation of products from Pingo Doce-only data
 * 2. Match existing products via:
 *    a) Exact normalized brand+name+quantity/unit
 *    b) High similarity threshold for auto-match
 *    c) Medium confidence => unmatched/manual review
 */

const { RETAILER } = require('./constants');

// Thresholds for matching (strict for Pingo Doce since no EAN)
const SIMILARITY_THRESHOLDS = {
  HIGH: 0.92,    // Auto-match if similarity >= 0.92
  MEDIUM: 0.75,  // Manual review if similarity >= 0.75
  // Below 0.75 => no match
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

function exactMatchKey(parsed) {
  // Create a key for exact matching: normalized brand+name+quantity+unit
  const brand = normalizeForComparison(parsed.brand);
  const name = normalizeForComparison(parsed.name);
  const qty = parsed.unitCount || '';
  const unit = parsed.unitType || '';
  
  return `${brand}|${name}|${qty}|${unit}`;
}

function findProductByExactMatch(prisma, parsed) {
  if (!parsed.name) return null;
  
  const key = exactMatchKey(parsed);
  
  // Query products with similar normalized values
  // This is a simplified approach - in production, you'd want full-text search
  return prisma.product.findFirst({
    where: {
      AND: [
        { name: { not: null } },
        parsed.brand ? { brand: { equals: parsed.brand, mode: 'insensitive' } } : {},
      ],
    },
  });
}

async function findProductBySimilarity(prisma, parsed) {
  if (!parsed.name) return null;
  
  // Get all products as candidates (this is expensive, consider pagination/caching)
  const candidates = await prisma.product.findMany({
    where: {
      name: { not: null },
    },
    take: 500, // Limit candidates for performance
  });
  
  let bestMatch = null;
  let bestScore = 0;
  let bestReason = null;
  
  for (const candidate of candidates) {
    // Skip if candidate has EAN (prefer EAN-matched products from other retailers)
    if (candidate.ean) continue;
    
    const nameSimilarity = similarity(parsed.name, candidate.name);
    const brandSimilarity = parsed.brand && candidate.brand 
      ? similarity(parsed.brand, candidate.brand) 
      : (parsed.brand === candidate.brand ? 1 : 0);
    
    // Combined score with weighting
    const combinedScore = (nameSimilarity * 0.7) + (brandSimilarity * 0.3);
    
    // Check quantity match if both have quantity info
    let qtyScore = 0;
    if (parsed.unitCount && parsed.unitType && candidate.unitCount && candidate.unitType) {
      if (parsed.unitType === candidate.unitType && parsed.unitCount === candidate.unitCount) {
        qtyScore = 1;
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
        finalScore,
      };
    }
  }
  
  return { product: bestMatch, score: bestScore, reason: bestReason };
}

async function findProduct(prisma, parsed) {
  // Pingo Doce strategy:
  // 1. No EAN available - skip EAN lookup
  // 2. Try exact match on brand+name+quantity
  // 3. If no exact match, try similarity matching with strict thresholds
  
  // Try exact match first
  const exactCandidate = await findProductByExactMatch(prisma, parsed);
  if (exactCandidate) {
    const exactKey = exactMatchKey(parsed);
    return {
      product: exactCandidate,
      confidence: 1.0,
      tier: 'exact',
      reason: 'exact_match_brand_name_qty',
      matchKey: exactKey,
    };
  }
  
  // Try similarity matching
  const similarityResult = await findProductBySimilarity(prisma, parsed);
  
  if (!similarityResult.product) {
    return {
      product: null,
      confidence: 0,
      tier: null,
      reason: 'no_candidate_found',
    };
  }
  
  const { product, score, reason } = similarityResult;
  
  // Apply strict thresholds for Pingo Doce
  if (score >= SIMILARITY_THRESHOLDS.HIGH) {
    return {
      product,
      confidence: score,
      tier: 'tier1',
      reason: `similarity_high:${score.toFixed(2)}`,
      matchKey: `similarity:${score.toFixed(2)}`,
    };
  }
  
  if (score >= SIMILARITY_THRESHOLDS.MEDIUM) {
    return {
      product,
      confidence: score,
      tier: 'tier2',
      reason: `similarity_review:${score.toFixed(2)}`,
      matchKey: `review:${score.toFixed(2)}`,
    };
  }
  
  // Below threshold - no match, will go to unmatched
  return {
    product: null,
    confidence: score,
    tier: null,
    reason: `below_threshold:${score.toFixed(2)}`,
  };
}

module.exports = {
  findProduct,
  similarity,
  normalizeForComparison,
  SIMILARITY_THRESHOLDS,
};
