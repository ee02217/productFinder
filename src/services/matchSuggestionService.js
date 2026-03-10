/**
 * Match Suggestion Service
 * 
 * Generates match suggestions for unmatched products that fall in the mid-confidence band.
 * Provides human-in-the-loop review workflow.
 * 
 * Key features:
 * - Brand-aware scoring (prevents cross-brand suggestions)
 * - Enriches source rows with brand/unit from TempProduct
 * - Hard brand guard to penalize mismatched brands
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

// Configuration for suggestion generation
const CONFIG = {
  // Mid-confidence band for suggestions
  MIN_CONFIDENCE: 0.75,
  MAX_CONFIDENCE: 0.92,
  // Batch size for processing
  BATCH_SIZE: 100,
  // Brand mismatch penalty threshold (if normalized brands differ and both are known, heavily penalize)
  BRAND_MISMATCH_PENALTY: 0.5,
  // Minimum brand similarity to consider (below = skip)
  MIN_BRAND_SIMILARITY: 0.6,
};

/**
 * Normalize a string for comparison (same as matcher's normalizeForComparison)
 */
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

/**
 * Calculate Levenshtein-based similarity (same as matcher's similarity)
 */
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
 * Check if quantity values are compatible
 */
function isQuantityCompatible(q1, q2) {
  if (!q1 || !q2) return null;
  if (q1.unitType !== q2.unitType) return false;
  
  // Allow 5% variance
  const ratio = q1.unitCount / q2.unitCount;
  return ratio >= 0.95 && ratio <= 1.05;
}

/**
 * Enrich unmatched row with brand/unit from TempProduct
 * Lookup by retailer + internalId or sourceUrl
 */
async function enrichWithTempProduct(retailer, unmatchedRow) {
  const { internalId, url } = unmatchedRow;
  
  if (!internalId && !url) {
    return unmatchedRow; // Nothing to lookup
  }
  
  // Try to find TempProduct by internalId or URL
  const tempProduct = await prisma.tempProduct.findFirst({
    where: {
      retailer,
      OR: [
        { internalId: internalId || '' },
        { sourceUrl: url || '' },
      ].filter(cond => cond.internalId || cond.sourceUrl),
    },
    select: {
      brand: true,
      unitCount: true,
      unitType: true,
    },
  });
  
  if (!tempProduct) {
    return unmatchedRow;
  }
  
  // Return enriched row
  return {
    ...unmatchedRow,
    sourceBrand: tempProduct.brand || null,
    sourceUnitCount: tempProduct.unitCount || null,
    sourceUnitType: tempProduct.unitType || null,
  };
}

/**
 * Get configuration (can be overridden)
 */
function getConfig() {
  return { ...CONFIG };
}

/**
 * Set configuration
 */
function setConfig(newConfig) {
  Object.assign(CONFIG, newConfig);
}

/**
 * Find unmatched rows for a retailer that are in the mid-confidence band
 * and don't already have pending suggestions
 */
async function findUnmatchedForSuggestion(retailer, options = {}) {
  const { minConfidence = CONFIG.MIN_CONFIDENCE, maxConfidence = CONFIG.MAX_CONFIDENCE } = options;
  
  // Find unmatched rows with confidence in the mid-band
  // Include rows with or without internalId (use URL as fallback)
  const unmatched = await prisma.retailerUnmatched.findMany({
    where: {
      retailer,
      matchConfidence: {
        gte: minConfidence,
        lt: maxConfidence,
      },
    },
    take: options.limit || CONFIG.BATCH_SIZE,
    orderBy: { createdAt: 'desc' },
  });

  // Filter out those that already have pending suggestions
  // Check both internalId and URL
  const identifiers = unmatched
    .map(u => u.internalId || u.url)
    .filter(Boolean);
  
  if (identifiers.length === 0) return [];

  // Find which identifiers already have pending suggestions
  // Check both internalId and URL based suggestions
  const existingPending = await prisma.matchSuggestion.findMany({
    where: {
      retailer,
      OR: [
        { sourceInternalId: { in: unmatched.map(u => u.internalId).filter(Boolean) } },
        { sourceUrl: { in: unmatched.map(u => u.url).filter(Boolean) } },
      ],
      status: 'pending',
    },
    select: { sourceInternalId: true, sourceUrl: true },
  });
  
  const pendingSet = new Set(
    existingPending.flatMap(p => [p.sourceInternalId, p.sourceUrl]).filter(Boolean)
  );
  
  // Return only those without pending suggestions
  return unmatched.filter(u => !pendingSet.has(u.internalId) && !pendingSet.has(u.url));
}

/**
 * Generate a single match suggestion using brand-aware similarity scoring
 * Includes brand similarity and quantity compatibility in the scoring
 */
async function generateSingleSuggestion(retailer, unmatchedRow) {
  const sourceName = unmatchedRow.name;
  if (!sourceName) return null;
  
  // Enrich with brand/unit from TempProduct
  const enrichedRow = await enrichWithTempProduct(retailer, unmatchedRow);
  const sourceBrand = enrichedRow.sourceBrand || null;
  const sourceUnitCount = enrichedRow.sourceUnitCount || null;
  const sourceUnitType = enrichedRow.sourceUnitType || null;
  
  // Get all products as candidates (limit to avoid memory issues)
  const candidates = await prisma.product.findMany({
    take: 500,
  });
  
  let bestMatch = null;
  let bestScore = 0;
  let bestSignals = null;
  
  for (const candidate of candidates) {
    // Calculate name similarity
    const nameSimilarity = similarity(sourceName, candidate.name);
    
    // Calculate brand similarity (if both have brand info)
    let brandSimilarity = 0;
    let brandMismatch = false;
    
    if (sourceBrand && candidate.brand) {
      brandSimilarity = similarity(sourceBrand, candidate.brand);
      
      // Hard brand guard: if normalized brands differ significantly, apply penalty
      const normSourceBrand = normalizeForComparison(sourceBrand);
      const normCandidateBrand = normalizeForComparison(candidate.brand);
      
      // Check if brands are completely different (not similar at all)
      if (normSourceBrand && normCandidateBrand) {
        // If brands exist and are clearly different (no substring match), flag as mismatch
        const exactMatch = normSourceBrand === normCandidateBrand;
        const substringMatch = normSourceBrand.includes(normCandidateBrand) || 
                               normCandidateBrand.includes(normSourceBrand);
        
        if (!exactMatch && !substringMatch && brandSimilarity < CONFIG.MIN_BRAND_SIMILARITY) {
          brandMismatch = true;
        }
      }
    }
    
    // Calculate quantity compatibility if both have quantity info
    let qtyScore = 0;
    let qtyCompatible = null;
    if (sourceUnitCount && sourceUnitType && candidate.unitCount && candidate.unitType) {
      const compatible = isQuantityCompatible(
        { unitCount: sourceUnitCount, unitType: sourceUnitType },
        { unitCount: candidate.unitCount, unitType: candidate.unitType }
      );
      if (compatible === true) {
        qtyScore = 1;
        qtyCompatible = true;
      } else if (compatible === false) {
        qtyCompatible = false;
      }
    }
    
    // Combined scoring (aligned with matcher: 70% name + 30% brand)
    // If brand mismatch detected, apply heavy penalty
    let combinedScore;
    if (brandMismatch) {
      // Heavily penalize brand mismatches but don't skip entirely (may still be useful for review)
      combinedScore = (nameSimilarity * 0.7 + brandSimilarity * 0.3) * CONFIG.BRAND_MISMATCH_PENALTY;
    } else {
      combinedScore = (nameSimilarity * 0.7 + brandSimilarity * 0.3);
    }
    
    // Add quantity score (30% weight)
    const finalScore = combinedScore * 0.7 + qtyScore * 0.3;
    
    // Skip if brand mismatch and score is too low after penalty
    if (brandMismatch && finalScore < CONFIG.MIN_CONFIDENCE) {
      continue;
    }
    
    if (finalScore > bestScore && finalScore >= CONFIG.MIN_CONFIDENCE && finalScore < CONFIG.MAX_CONFIDENCE) {
      bestScore = finalScore;
      bestMatch = candidate;
      bestSignals = {
        nameSimilarity,
        brandSimilarity,
        brandMismatch,
        qtyScore,
        qtyCompatible,
        finalScore,
        sourceBrand,
        sourceUnitCount,
        sourceUnitType,
      };
    }
  }
  
  if (!bestMatch) return null;
  
  // Create the suggestion - use internalId if available, otherwise use URL
  const suggestion = await prisma.matchSuggestion.create({
    data: {
      retailer,
      sourceInternalId: unmatchedRow.internalId || null,
      sourceUrl: unmatchedRow.url || null,
      sourceName: unmatchedRow.name,
      suggestedProductId: bestMatch.id,
      confidence: bestScore,
      signals: bestSignals,
      status: 'pending',
    },
  });
  
  return suggestion;
}

/**
 * Generate suggestions for a retailer
 */
async function generateSuggestions(retailer, options = {}) {
  const { dryRun = false, minConfidence, maxConfidence } = options;
  
  // Find unmatched rows eligible for suggestions
  const unmatchedRows = await findUnmatchedForSuggestion(retailer, {
    minConfidence,
    maxConfidence,
    limit: options.limit || CONFIG.BATCH_SIZE,
  });
  
  if (dryRun) {
    return {
      wouldGenerate: unmatchedRows.length,
      rows: unmatchedRows,
    };
  }
  
  const suggestions = [];
  const errors = [];
  
  for (const row of unmatchedRows) {
    try {
      // Check again if pending suggestion exists (prevent race conditions)
      const existingPending = await prisma.matchSuggestion.findFirst({
        where: {
          retailer,
          OR: [
            { sourceInternalId: row.internalId ? { equals: row.internalId } : undefined },
            { sourceUrl: row.url ? { equals: row.url } : undefined },
          ].filter(Boolean),
          status: 'pending',
        },
      });
      
      if (existingPending) {
        continue; // Skip if already has pending suggestion
      }
      
      const suggestion = await generateSingleSuggestion(retailer, row);
      if (suggestion) {
        suggestions.push(suggestion);
      }
    } catch (err) {
      errors.push({ rowId: row.id, error: err.message });
    }
  }
  
  return {
    generated: suggestions.length,
    suggestions,
    errors,
    totalFound: unmatchedRows.length,
  };
}

/**
 * Get suggestions by retailer and status
 */
async function getSuggestions(retailer, status = 'pending', options = {}) {
  const { limit = 100, includeProduct = true, includePrices = false } = options;
  
  const where = {
    retailer,
    ...(status && { status }),
  };
  
  const suggestions = await prisma.matchSuggestion.findMany({
    where,
    include: {
      suggestedProduct: includeProduct ? {
        include: {
          prices: includePrices ? { orderBy: { capturedAt: 'desc' }, take: 1 } : false,
        },
      } : false,
      approvedProduct: includeProduct ? {
        include: {
          prices: includePrices ? { orderBy: { capturedAt: 'desc' }, take: 1 } : false,
        },
      } : false,
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
  
  return suggestions;
}

/**
 * Approve a suggestion (optionally with a different product override)
 */
async function approveSuggestion(suggestionId, overrideProductId = null) {
  const suggestion = await prisma.matchSuggestion.findUnique({
    where: { id: suggestionId },
  });
  
  if (!suggestion) {
    throw new Error('Suggestion not found');
  }
  
  if (suggestion.status !== 'pending') {
    throw new Error('Suggestion is not pending');
  }
  
  const finalProductId = overrideProductId || suggestion.suggestedProductId;
  const sourceInternalId = suggestion.sourceInternalId;
  const sourceUrl = suggestion.sourceUrl;
  
  const result = await prisma.$transaction(async (tx) => {
    // 1. Update suggestion status
    const updated = await tx.matchSuggestion.update({
      where: { id: suggestionId },
      data: {
        status: 'approved',
        approvedProductId: finalProductId,
        updatedAt: new Date(),
      },
    });
    
    // 2. Create/update persistent mapping
    let mapping;
    if (sourceInternalId) {
      mapping = await tx.productMapping.upsert({
        where: {
          retailer_sourceInternalId: {
            retailer: suggestion.retailer,
            sourceInternalId: sourceInternalId,
          },
        },
        create: {
          retailer: suggestion.retailer,
          sourceInternalId: sourceInternalId,
          productId: finalProductId,
        },
        update: {
          productId: finalProductId,
          updatedAt: new Date(),
        },
      });
    } else if (sourceUrl) {
      mapping = await tx.productMapping.upsert({
        where: {
          retailer_sourceUrl: {
            retailer: suggestion.retailer,
            sourceUrl: sourceUrl,
          },
        },
        create: {
          retailer: suggestion.retailer,
          sourceUrl: sourceUrl,
          productId: finalProductId,
        },
        update: {
          productId: finalProductId,
          updatedAt: new Date(),
        },
      });
    } else {
      throw new Error('No source identifier for mapping');
    }
    
    return { suggestion: updated, mapping };
  });
  
  return result;
}

/**
 * Reject a suggestion
 */
async function rejectSuggestion(suggestionId) {
  const suggestion = await prisma.matchSuggestion.findUnique({
    where: { id: suggestionId },
  });
  
  if (!suggestion) {
    throw new Error('Suggestion not found');
  }
  
  if (suggestion.status !== 'pending') {
    throw new Error('Suggestion is not pending');
  }
  
  const updated = await prisma.matchSuggestion.update({
    where: { id: suggestionId },
    data: {
      status: 'rejected',
      updatedAt: new Date(),
    },
  });
  
  return updated;
}

/**
 * Get mapping for a retailer + internalId or URL
 */
async function getMapping(retailer, sourceInternalId = null, sourceUrl = null) {
  if (sourceInternalId) {
    const mapping = await prisma.productMapping.findUnique({
      where: {
        retailer_sourceInternalId: { retailer, sourceInternalId },
      },
    });
    if (mapping) return mapping;
  }
  
  if (sourceUrl) {
    return prisma.productMapping.findUnique({
      where: {
        retailer_sourceUrl: { retailer, sourceUrl },
      },
    });
  }
  
  return null;
}

/**
 * Search products by name/brand/EAN
 */
async function searchProducts(query, options = {}) {
  const { limit = 20, includePrices = false } = options;
  
  if (!query || query.length < 2) return [];
  
  const products = await prisma.product.findMany({
    where: {
      OR: [
        { name: { contains: query, mode: 'insensitive' } },
        { brand: { contains: query, mode: 'insensitive' } },
        { ean: { contains: query } },
      ],
    },
    include: {
      prices: includePrices ? { orderBy: { capturedAt: 'desc' }, take: 1 } : false,
    },
    take: limit,
    orderBy: { name: 'asc' },
  });
  
  return products;
}

/**
 * Get stats
 */
async function getSuggestionStats(retailer) {
  const [pending, approved, rejected, totalMappings] = await Promise.all([
    prisma.matchSuggestion.count({ where: { retailer, status: 'pending' } }),
    prisma.matchSuggestion.count({ where: { retailer, status: 'approved' } }),
    prisma.matchSuggestion.count({ where: { retailer, status: 'rejected' } }),
    prisma.productMapping.count({ where: { retailer } }),
  ]);
  
  return { pending, approved, rejected, totalMappings };
}

module.exports = {
  getConfig, setConfig, findUnmatchedForSuggestion, generateSuggestions,
  generateSingleSuggestion, getSuggestions, approveSuggestion, rejectSuggestion,
  getMapping, searchProducts, getSuggestionStats, CONFIG,
  // Export helper functions for testing and external use
  normalizeForComparison,
  similarity,
  levenshtein,
  isQuantityCompatible,
  enrichWithTempProduct,
};
