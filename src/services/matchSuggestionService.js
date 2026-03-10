/**
 * Match Suggestion Service
 * 
 * Generates match suggestions for unmatched products that fall in the mid-confidence band.
 * Provides human-in-the-loop review workflow.
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
};

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
 * Generate a single match suggestion using the matcher's similarity scoring
 */
async function generateSingleSuggestion(retailer, unmatchedRow) {
  const { similarity } = require('../retailers/pingodoce/matcher');
  
  const sourceName = unmatchedRow.name;
  if (!sourceName) return null;
  
  // Get all products as candidates (limit to avoid memory issues)
  const candidates = await prisma.product.findMany({
    take: 500,
  });
  
  let bestMatch = null;
  let bestScore = 0;
  let bestSignals = null;
  
  for (const candidate of candidates) {
    const nameSimilarity = similarity(sourceName, candidate.name);
    // Brand similarity - unmatchedRow doesn't have brand, so use 0
    // Use full nameSimilarity since we don't have brand info in unmatched rows
    // The original matchConfidence was already calculated with proper weighting
    const finalScore = nameSimilarity;
    
    if (finalScore > bestScore && finalScore >= CONFIG.MIN_CONFIDENCE && finalScore < CONFIG.MAX_CONFIDENCE) {
      bestScore = finalScore;
      bestMatch = candidate;
      bestSignals = {
        nameSimilarity,
        finalScore,
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
  const { limit = 100, includeProduct = true } = options;
  
  const where = {
    retailer,
    ...(status && { status }),
  };
  
  const suggestions = await prisma.matchSuggestion.findMany({
    where,
    include: {
      suggestedProduct: includeProduct,
      approvedProduct: includeProduct,
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
};
