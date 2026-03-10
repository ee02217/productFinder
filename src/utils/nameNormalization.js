/**
 * Shared Name Normalization Utilities
 * 
 * Provides brand-aware normalization for product matching.
 * Used by both retailer matchers and the match suggestion service.
 */

/**
 * Normalize a string for comparison (used everywhere)
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
 * Tokenize a normalized string into an array of tokens
 */
function tokenize(str) {
  const normalized = normalizeForComparison(str);
  if (!normalized) return [];
  return normalized.split(/\s+/).filter(t => t.length > 0);
}

/**
 * Calculate Jaccard-like token overlap similarity
 * Returns 0-1 based on intersection/union of tokens
 */
function tokenOverlapSimilarity(a, b) {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  
  if (tokensA.length === 0 || tokensB.length === 0) return 0;
  
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  
  // Calculate intersection
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) {
      intersection++;
    }
  }
  
  // Calculate union
  const union = setA.size + setB.size - intersection;
  
  if (union === 0) return 0;
  return intersection / union;
}

/**
 * Levenshtein-based character similarity (original implementation)
 */
function levenshteinSimilarity(a, b) {
  if (!a || !b) return 0;
  const normA = normalizeForComparison(a);
  const normB = normalizeForComparison(b);
  
  if (normA === normB) return 1;
  if (normA.length === 0 || normB.length === 0) return 0;

  const longer = normA.length > normB.length ? normA : normB;
  const shorter = normA.length > normB.length ? normB : normA;
  
  const editDistance = levenshtein(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

/**
 * Hybrid similarity: combines token overlap + character similarity
 * Default weights: 0.6 token overlap + 0.4 character similarity
 */
function hybridSimilarity(a, b, options = {}) {
  const {
    tokenWeight = 0.6,
    charWeight = 0.4,
  } = options;
  
  if (!a || !b) return 0;
  
  const tokenSim = tokenOverlapSimilarity(a, b);
  const charSim = levenshteinSimilarity(a, b);
  
  return (tokenSim * tokenWeight) + (charSim * charWeight);
}

/**
 * Compute Levenshtein edit distance
 */
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
 * Brand-aware name normalization
 * 
 * If both source and candidate have known brands, strips brand tokens
 * from both names before computing similarity (avoids double-counting brand).
 * 
 * @param {string} sourceName - The source product name
 * @param {string} candidateName - The candidate product name  
 * @param {string} sourceBrand - The source product brand (optional)
 * @param {string} candidateBrand - The candidate product brand (optional)
 * @returns {Object} - { sourceNormalized, candidateNormalized, brandsWereStripped }
 */
function brandAwareNameNormalization(sourceName, candidateName, sourceBrand, candidateBrand) {
  const sourceNormalized = normalizeForComparison(sourceName);
  const candidateNormalized = normalizeForComparison(candidateName);
  
  let srcNorm = sourceNormalized;
  let candNorm = candidateNormalized;
  let brandsStripped = false;
  
  // If both have brands, try to strip brand tokens from names
  if (sourceBrand && candidateBrand) {
    const srcBrandTokens = tokenize(sourceBrand);
    const candBrandTokens = tokenize(candidateBrand);
    const allBrandTokens = [...new Set([...srcBrandTokens, ...candBrandTokens])];
    
    // Check if brands are the same or highly similar
    const brandSimilarity = levenshteinSimilarity(sourceBrand, candidateBrand);
    const sameBrand = srcBrandTokens.some(st => candBrandTokens.includes(st)) || 
                      brandSimilarity >= 0.8;
    
    if (sameBrand && allBrandTokens.length > 0) {
      // Strip brand tokens from both names
      srcNorm = stripTokens(sourceNormalized, allBrandTokens);
      candNorm = stripTokens(candidateNormalized, allBrandTokens);
      brandsStripped = true;
    }
  }
  
  return {
    sourceNormalized: srcNorm,
    candidateNormalized: candNorm,
    brandsStripped,
  };
}

/**
 * Strip specified tokens from a normalized string
 */
function stripTokens(normalizedStr, tokensToStrip) {
  const tokens = normalizedStr.split(/\s+/);
  const filtered = tokens.filter(t => !tokensToStrip.includes(t));
  return filtered.join(' ');
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
 * Calculate token containment ratio
 * Measures how many tokens from source are contained in candidate
 * Returns ratio of source tokens found in candidate (0-1)
 * 
 * This is key for generic-name uplift: if source name is short and its tokens
 * are all present in candidate name, it's likely a generic/short version of the same product
 */
function tokenContainmentRatio(sourceName, candidateName) {
  const sourceTokens = tokenize(sourceName);
  const candidateTokens = tokenize(candidateName);
  
  if (sourceTokens.length === 0) return 0;
  if (candidateTokens.length === 0) return 0;
  
  const candidateTokenSet = new Set(candidateTokens);
  
  // Count how many source tokens are contained in candidate
  let containedCount = 0;
  for (const token of sourceTokens) {
    if (candidateTokenSet.has(token)) {
      containedCount++;
    }
  }
  
  return containedCount / sourceTokens.length;
}

module.exports = {
  normalizeForComparison,
  tokenize,
  tokenOverlapSimilarity,
  levenshteinSimilarity,
  hybridSimilarity,
  levenshtein,
  brandAwareNameNormalization,
  stripTokens,
  isQuantityCompatible,
  tokenContainmentRatio,
};
