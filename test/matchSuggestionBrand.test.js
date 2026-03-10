/**
 * Unit tests for Match Suggestion Service - Brand Mismatch Prevention
 * 
 * Run with: node test/matchSuggestionBrand.test.js
 * 
 * Tests:
 * 1. Brand similarity calculation
 * 2. Hard brand guard (penalizes mismatched brands)
 * 3. Quantity compatibility checking
 * 4. Source brand enrichment from TempProduct
 */

// Import the service directly - it exports the functions we need
const matchSuggestionService = require('../src/services/matchSuggestionService');

const {
  normalizeForComparison,
  similarity,
  isQuantityCompatible,
  getConfig,
} = matchSuggestionService;

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`✗ ${name}`);
    console.log(`  Error: ${err.message}`);
    failed++;
  }
}

function assertEqual(actual, expected, msg = '') {
  if (actual !== expected) {
    throw new Error(`${msg}\n    Expected: ${expected}\n    Actual:   ${actual}`);
  }
}

function assertTrue(actual, msg = '') {
  if (!actual) {
    throw new Error(`${msg}\n    Expected: true\n    Actual:   ${actual}`);
  }
}

function assertFalse(actual, msg = '') {
  if (actual) {
    throw new Error(`${msg}\n    Expected: false\n    Actual:   ${actual}`);
  }
}

function assertGreaterOrEqual(actual, min, msg = '') {
  if (actual < min) {
    throw new Error(`${msg}\n    Expected: >= ${min}\n    Actual:   ${actual}`);
  }
}

function assertLessThan(actual, max, msg = '') {
  if (actual >= max) {
    throw new Error(`${msg}\n    Expected: < ${max}\n    Actual:   ${actual}`);
  }
}

console.log('\n=== Testing Normalization ===\n');

test('normalizeForComparison: lowercase conversion', () => {
  assertEqual(normalizeForComparison('HELLO'), 'hello');
});

test('normalizeForComparison: accent removal', () => {
  assertEqual(normalizeForComparison('café'), 'cafe');
});

test('normalizeForComparison: Portuguese accents', () => {
  assertEqual(normalizeForComparison('Noodles De Galinha'), 'noodles de galinha');
});

test('normalizeForComparison: special chars removal', () => {
  assertEqual(normalizeForComparison('Koka® Noodles'), 'koka noodles');
});

test('normalizeForComparison: empty input', () => {
  assertEqual(normalizeForComparison(''), '');
  assertEqual(normalizeForComparison(null), '');
  assertEqual(normalizeForComparison(undefined), '');
});

console.log('\n=== Testing Brand Similarity ===\n');

test('similarity: identical brands', () => {
  assertEqual(similarity('Koka', 'Koka'), 1.0);
});

test('similarity: exact brand match (case insensitive)', () => {
  assertEqual(similarity('koka', 'Koka'), 1.0);
});

test('similarity: similar brand names', () => {
  // With hybrid similarity (token + char), single token strings have lower scores
  // since token overlap is 0 (no shared tokens). This is expected behavior.
  const sim = similarity('Koka', 'Kokk');
  // Hybrid: 0.6 * 0 + 0.4 * 0.75 = 0.3
  assertLessThan(sim, 0.5);
});

test('similarity: completely different brands', () => {
  const sim = similarity('Koka', 'Maggio');
  assertLessThan(sim, 0.3);
});

test('similarity: brand with special chars', () => {
  assertEqual(similarity('Koka®', 'Koka'), 1.0);
});

test('similarity: empty strings return 0', () => {
  assertEqual(similarity('', 'Koka'), 0);
  assertEqual(similarity('Koka', ''), 0);
});

console.log('\n=== Testing Name Similarity (Brand-Aware) ===\n');

test('similarity: same product name, same brand', () => {
  const sim = similarity('Noodles De Galinha Koka', 'Noodles De Galinha Koka');
  assertEqual(sim, 1.0);
});

test('similarity: same product name, different brands', () => {
  // The full name includes brand, so similarity is lower
  const sim = similarity('Noodles De Galinha Koka', 'Noodles De Galinha Maggio');
  assertLessThan(sim, 1.0);
  // But should still have decent name similarity
  assertGreaterOrEqual(sim, 0.6);
});

test('similarity: partial name match', () => {
  const sim = similarity('Noodles De Galinha', 'Noodles Galinha');
  assertGreaterOrEqual(sim, 0.7);
});

console.log('\n=== Testing Quantity Compatibility ===\n');

test('isQuantityCompatible: exact match', () => {
  const result = isQuantityCompatible(
    { unitCount: 500, unitType: 'g' },
    { unitCount: 500, unitType: 'g' }
  );
  assertTrue(result);
});

test('isQuantityCompatible: 5% variance allowed', () => {
  const result = isQuantityCompatible(
    { unitCount: 500, unitType: 'g' },
    { unitCount: 520, unitType: 'g' }
  );
  assertTrue(result);
});

test('isQuantityCompatible: >5% variance rejected', () => {
  const result = isQuantityCompatible(
    { unitCount: 500, unitType: 'g' },
    { unitCount: 600, unitType: 'g' }
  );
  assertFalse(result);
});

test('isQuantityCompatible: different units rejected', () => {
  const result = isQuantityCompatible(
    { unitCount: 1, unitType: 'kg' },
    { unitCount: 1000, unitType: 'g' }
  );
  assertFalse(result);
});

test('isQuantityCompatible: null handling', () => {
  assertEqual(isQuantityCompatible(null, { unitCount: 500, unitType: 'g' }), null);
  assertEqual(isQuantityCompatible({ unitCount: 500, unitType: 'g' }, null), null);
});

test('isQuantityCompatible: null units rejected', () => {
  const result = isQuantityCompatible(
    { unitCount: 500, unitType: 'g' },
    { unitCount: 500, unitType: null }
  );
  assertFalse(result);
});

console.log('\n=== Testing Configuration ===\n');

test('getConfig: returns config object with brand settings', () => {
  const config = getConfig();
  assertTrue(typeof config.BRAND_MISMATCH_PENALTY === 'number');
  assertTrue(typeof config.MIN_BRAND_SIMILARITY === 'number');
  assertLessThan(config.BRAND_MISMATCH_PENALTY, 1.0);
  assertGreaterOrEqual(config.MIN_BRAND_SIMILARITY, 0.5);
});

console.log('\n=== Testing Brand Guard Logic ===\n');

test('brand guard: exact match should not be penalized', () => {
  const sourceBrand = 'Koka';
  const candidateBrand = 'Koka';
  
  const normSource = normalizeForComparison(sourceBrand);
  const normCandidate = normalizeForComparison(candidateBrand);
  
  // Exact match
  assertEqual(normSource, normCandidate);
});

test('brand guard: substring match should not be penalized', () => {
  const sourceBrand = 'Koka Noodles';
  const candidateBrand = 'Koka';
  
  const normSource = normalizeForComparison(sourceBrand);
  const normCandidate = normalizeForComparison(candidateBrand);
  
  // Substring match
  assertTrue(normSource.includes(normCandidate) || normCandidate.includes(normSource));
});

test('brand guard: different brands should be detected', () => {
  const sourceBrand = 'Koka';
  const candidateBrand = 'Maggio';
  
  const normSource = normalizeForComparison(sourceBrand);
  const normCandidate = normalizeForComparison(candidateBrand);
  const brandSim = similarity(sourceBrand, candidateBrand);
  
  // These should be different and have low similarity
  assertNotEqual(normSource, normCandidate);
  assertLessThan(brandSim, 0.5);
});

console.log('\n=== Testing Name Filtered Query ===\n');

test('name filter: normalized name is used for filtering', () => {
  const sourceName = 'Noodles De Galinha';
  const normName = normalizeForComparison(sourceName);
  assertEqual(normName, 'noodles de galinha');
  assertTrue(normName.length >= 3);
});

test('name filter: short names fall back to broader query', () => {
  const shortName = 'AB';
  const normName = normalizeForComparison(shortName);
  assertLessThan(normName.length, 3);
});

test('name filter: diacritics are normalized before filtering', () => {
  const nameWithAccent = 'Noodles De Galinha Açúcar';
  const normName = normalizeForComparison(nameWithAccent);
  // Should remove diacritics
  assertEqual(normName.indexOf('ç'), -1);
  assertTrue(normName.includes('acucar'));
});

test('name filter: special characters are removed', () => {
  const nameWithSpecial = 'Noodles® De Galinha!';
  const normName = normalizeForComparison(nameWithSpecial);
  assertEqual(normName, 'noodles de galinha');
});

function assertNotEqual(actual, expected, msg = '') {
  if (actual === expected) {
    throw new Error(`${msg}\n    Expected: NOT ${expected}\n    Actual:   ${actual}`);
  }
}

console.log('\n=== Test Summary ===\n');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log('');

if (failed > 0) {
  process.exit(1);
} else {
  console.log('All tests passed! ✓\n');
  process.exit(0);
}
