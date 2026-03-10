/**
 * Demonstration: Old vs New Similarity for Brand Token Cases
 * 
 * This script demonstrates how the new hybrid similarity + brand-aware
 * normalization improves matching for cases where one product name includes
 * the brand token and the other doesn't.
 * 
 * Run with: node test/demo-massanoodles.js
 */

const {
  normalizeForComparison,
  hybridSimilarity,
  levenshteinSimilarity,
  brandAwareNameNormalization,
} = require('../src/utils/nameNormalization');

console.log('\n=== Test Case 1: Brand in Name vs Brand Not In Name ===\n');

// Scenario: Source has brand in name, candidate has brand separate
// Source: "Maggi Noodles Wok" (brand "Maggi" is IN the name)
// Candidate: "Noodles" with brand "Maggi"

console.log('Scenario: "Maggi Noodles Wok" (brand=Maggi) vs "Noodles" (brand=Maggi)');

// OLD APPROACH (pure Levenshtein):
const oldSimilarity1 = levenshteinSimilarity('Maggi Noodles Wok', 'Noodles');
console.log(`OLD (Levenshtein): ${oldSimilarity1.toFixed(4)}`);

// NEW APPROACH (brand-aware normalization + hybrid)
const brandNorm1 = brandAwareNameNormalization('Maggi Noodles Wok', 'Noodles', 'Maggi', 'Maggi');
console.log(`Brand-aware normalization: brandsStripped=${brandNorm1.brandsStripped}`);
console.log(`  source: "${brandNorm1.sourceNormalized}" -> "${brandNorm1.sourceNormalized.replace(/maggi/g, '').replace(/\s+/g, ' ').trim()}"`);
console.log(`  candidate: "${brandNorm1.candidateNormalized}"`);

const newSim1 = hybridSimilarity(
  brandNorm1.sourceNormalized.replace(/maggi/g, '').replace(/\s+/g, ' ').trim(),
  brandNorm1.candidateNormalized
);
console.log(`NEW (hybrid): ${newSim1.toFixed(4)}`);

// Wait, the brand normalization strips the BRAND from the name if it matches
// Let's trace what actually happens
console.log('\n--- Actual flow in matcher ---');
// In the matcher, similarity() is called with (sourceName, candidateName, sourceBrand, candidateBrand)
// It calls brandAwareNameNormalization which checks if brands are similar
// If brands match, it strips brand tokens from BOTH names

const actualNorm = brandAwareNameNormalization('Maggi Noodles Wok', 'Noodles', 'Maggi', 'Maggi');
console.log(`After brandAwareNameNormalization:`);
console.log(`  sourceNormalized: "${actualNorm.sourceNormalized}"`);
console.log(`  candidateNormalized: "${actualNorm.candidateNormalized}"`);
console.log(`  brandsStripped: ${actualNorm.brandsStripped}`);

// The issue is: "maggi" IS in the source name "maggi noodles wok"
// So stripping "maggi" from source gives "noodles wok"
// And candidate is "noodles"
// Token overlap: {"noodles", "wok"} vs {"noodles"} = 1/2 = 0.5
// Char similarity: levenshtein("noodles wok", "noodles") = chars match but " wok" extra = 6/10 = 0.6
// Hybrid: 0.6*0.5 + 0.4*0.6 = 0.3 + 0.24 = 0.54

const finalSim = hybridSimilarity(actualNorm.sourceNormalized, actualNorm.candidateNormalized);
console.log(`Final similarity: ${finalSim.toFixed(4)}`);

console.log('\n=== Test Case 2: Same Brand, No Brand in Name ===\n');

// Scenario: Neither has brand in name
// Source: "Massa Noodles Wok" (brand "Maggi", but "Massa" = pasta in Portuguese)
// Candidate: "Noodles" with brand "Maggi"

console.log('Scenario: "Massa Noodles Wok" (brand=Maggi) vs "Noodles" (brand=Maggi)');
console.log('(Massa = pasta in Portuguese, not the brand)');

const oldSim2 = levenshteinSimilarity('Massa Noodles Wok', 'Noodles');
console.log(`OLD (Levenshtein): ${oldSim2.toFixed(4)}`);

const norm2 = brandAwareNameNormalization('Massa Noodles Wok', 'Noodles', 'Maggi', 'Maggi');
console.log(`Brand-aware: brandsStripped=${norm2.brandsStripped}`);

const newSim2 = hybridSimilarity(norm2.sourceNormalized, norm2.candidateNormalized);
console.log(`NEW (hybrid): ${newSim2.toFixed(4)}`);

console.log('\n=== Test Case 3: Cross-Brand (should be penalized) ===\n');

console.log('Scenario: "Maggi Noodles" (brand=Maggi) vs "Knorr Noodles" (brand=Knorr)');

const oldCross = levenshteinSimilarity('Maggi Noodles', 'Knorr Noodles');
console.log(`OLD (Levenshtein): ${oldCross.toFixed(4)}`);

const normCross = brandAwareNameNormalization('Maggi Noodles', 'Knorr Noodles', 'Maggi', 'Knorr');
console.log(`Brand-aware: brandsStripped=${normCross.brandsStripped}`);

const newCross = hybridSimilarity(normCross.sourceNormalized, normCross.candidateNormalized);
console.log(`NEW (hybrid): ${newCross.toFixed(4)}`);

// Brand similarity should be low
const brandSim = levenshteinSimilarity('Maggi', 'Knorr');
console.log(`Brand similarity: ${brandSim.toFixed(4)}`);

console.log('\n=== Final Scores with Quantity Bonus ===\n');

function computeFinalScore(nameSim, brandSim, qtyCompatible) {
  const combinedScore = (nameSim * 0.7) + (brandSim * 0.3);
  const qtyScore = qtyCompatible ? 1 : 0;
  return (combinedScore * 0.7) + (qtyScore * 0.3);
}

const final1 = computeFinalScore(finalSim, 1.0, true);
console.log(`Case 1 (brand in name): name=${finalSim.toFixed(4)}, brand=1.0, qty=1 -> final=${final1.toFixed(4)} [${final1 >= 0.92 ? 'TIER 2 (auto-match!)' : 'TIER 3 (review)'}]`);

const final2 = computeFinalScore(newSim2, 1.0, true);
console.log(`Case 2 (same brand):    name=${newSim2.toFixed(4)}, brand=1.0, qty=1 -> final=${final2.toFixed(4)} [${final2 >= 0.92 ? 'TIER 2 (auto-match!)' : 'TIER 3 (review)'}]`);

const finalCross = computeFinalScore(newCross, brandSim, true);
console.log(`Case 3 (cross-brand):  name=${newCross.toFixed(4)}, brand=${brandSim.toFixed(4)}, qty=1 -> final=${finalCross.toFixed(4)} [${finalCross >= 0.92 ? 'TIER 2' : finalCross >= 0.75 ? 'TIER 3 (review)' : 'no match'}]`);

console.log('\n=== Summary ===\n');
console.log('Results:');
console.log('- Case 1 (brand in name): Higher name similarity due to brand stripping');
console.log('- Case 2 (same brand, no brand in name): Similar to before, but brand comparison helps');
console.log('- Case 3 (cross-brand): Penalty applied through brand comparison');
console.log('- Quantity bonus provides significant boost when units match');
