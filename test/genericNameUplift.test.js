/**
 * Unit tests for Generic Name Uplift Feature
 * 
 * Run with: node test/genericNameUplift.test.js
 * 
 * Tests:
 * 1. tokenContainmentRatio calculation
 * 2. Generic name uplift conditions (brand + qty + containment)
 * 3. Uplift does NOT apply for cross-brand matches
 * 4. Uplift does NOT apply for qty-incompatible matches
 * 5. Uplift applies correctly for generic short names
 */

const matchSuggestionService = require('../src/services/matchSuggestionService');
const { calculateGenericNameUplift } = require('../src/retailers/pingodoce/matcher');

const {
  normalizeForComparison,
  similarity,
  isQuantityCompatible,
  tokenContainmentRatio,
  GENERIC_NAME_UPLIFT,
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

function assertNotNull(actual, msg = '') {
  if (actual === null || actual === undefined) {
    throw new Error(`${msg}\n    Expected: NOT null\n    Actual:   ${actual}`);
  }
}

console.log('\n=== Testing tokenContainmentRatio ===\n');

test('tokenContainmentRatio: identical names', () => {
  const ratio = tokenContainmentRatio('noodles de galinha', 'noodles de galinha');
  assertEqual(ratio, 1.0);
});

test('tokenContainmentRatio: source contained in candidate', () => {
  // Source: "galinha" (1 token), Candidate: "noodles de galinha" (3 tokens)
  // 1/1 = 1.0 since "galinha" is in candidate
  const ratio = tokenContainmentRatio('galinha', 'noodles de galinha');
  assertEqual(ratio, 1.0);
});

test('tokenContainmentRatio: partial containment', () => {
  // Source: "noodles galinha" (2 tokens), Candidate: "noodles de galinha" (3 tokens)
  // Both tokens present: 2/2 = 1.0
  const ratio = tokenContainmentRatio('noodles galinha', 'noodles de galinha');
  assertEqual(ratio, 1.0);
});

test('tokenContainmentRatio: no containment', () => {
  const ratio = tokenContainmentRatio('arroz', 'noodles de galinha');
  assertEqual(ratio, 0);
});

test('tokenContainmentRatio: partial containment (50%)', () => {
  // Source: "arroz branco" (2 tokens), Candidate: "arroz" (1 token)
  // 1 token found / 2 source tokens = 0.5
  const ratio = tokenContainmentRatio('arroz branco', 'arroz');
  assertEqual(ratio, 0.5);
});

test('tokenContainmentRatio: empty source returns 0', () => {
  const ratio = tokenContainmentRatio('', 'noodles');
  assertEqual(ratio, 0);
});

test('tokenContainmentRatio: empty candidate returns 0', () => {
  const ratio = tokenContainmentRatio('noodles', '');
  assertEqual(ratio, 0);
});

console.log('\n=== Testing Generic Name Uplift Configuration ===\n');

test('GENERIC_NAME_UPLIFT: config exists with correct thresholds', () => {
  assertTrue(GENERIC_NAME_UPLIFT.MIN_BRAND_SIMILARITY >= 0.9);
  assertTrue(GENERIC_NAME_UPLIFT.MIN_CONTAINMENT_RATIO >= 0.7);
  assertTrue(GENERIC_NAME_UPLIFT.UPLIFT_MIN > 0);
  assertTrue(GENERIC_NAME_UPLIFT.UPLIFT_MAX > GENERIC_NAME_UPLIFT.UPLIFT_MIN);
  assertTrue(GENERIC_NAME_UPLIFT.MAX_CONFIDENCE <= 1.0);
});

console.log('\n=== Testing Uplift Conditions ===\n');

test('uplift: applies when strong brand match + qty compatible + high containment', () => {
  // Simulate: source = "Koka Noodles 400g", candidate = "Koka Noodles 400g"
  const parsed = { name: 'noodles galinha', brand: 'koka' };
  const candidate = { name: 'noodles galinha koka', brand: 'koka' };
  const signals = {
    brandSimilarity: 1.0,
    qtyCompatible: true,
    finalScore: 0.89,
  };
  
  const uplift = calculateGenericNameUplift(parsed, candidate, signals);
  assertNotNull(uplift);
  assertTrue(uplift.upliftAmount > 0);
  assertTrue(uplift.upliftAmount <= GENERIC_NAME_UPLIFT.UPLIFT_MAX);
});

test('uplift: applies when brandSimilarity >= 0.95 (even without exact match)', () => {
  const parsed = { name: 'noodles', brand: 'koka' };
  const candidate = { name: 'koka noodles 400g', brand: 'koka' };
  const signals = {
    brandSimilarity: 0.97,  // High but not exact
    qtyCompatible: true,
    finalScore: 0.85,
  };
  
  const uplift = calculateGenericNameUplift(parsed, candidate, signals);
  assertNotNull(uplift);
});

test('uplift: does NOT apply when brand similarity is weak', () => {
  const parsed = { name: 'noodles', brand: 'unknown' };
  const candidate = { name: 'koka noodles 400g', brand: 'koka' };
  const signals = {
    brandSimilarity: 0.5,  // Low brand similarity
    qtyCompatible: true,
    finalScore: 0.85,
  };
  
  const uplift = calculateGenericNameUplift(parsed, candidate, signals);
  assertTrue(uplift === null);
});

test('uplift: does NOT apply when qty incompatible', () => {
  const parsed = { name: 'noodles galinha', brand: 'koka' };
  const candidate = { name: 'noodles galinha koka', brand: 'koka' };
  const signals = {
    brandSimilarity: 1.0,
    qtyCompatible: false,  // Incompatible!
    finalScore: 0.85,
  };
  
  const uplift = calculateGenericNameUplift(parsed, candidate, signals);
  assertTrue(uplift === null);
});

test('uplift: does NOT apply when containment ratio is low', () => {
  const parsed = { name: 'noodles galinha pizza', brand: 'koka' };  // 3 tokens
  const candidate = { name: 'noodles galinha', brand: 'koka' };  // Only 2 tokens - 2/3 = 0.67
  const signals = {
    brandSimilarity: 1.0,
    qtyCompatible: true,
    finalScore: 0.85,
  };
  
  const uplift = calculateGenericNameUplift(parsed, candidate, signals);
  // Should be null since containment < 0.8
  assertTrue(uplift === null || uplift.upliftAmount === 0);
});

test('uplift: does NOT apply to cross-brand matches', () => {
  const parsed = { name: 'noodles galinha', brand: 'koka' };
  const candidate = { name: 'noodles galinho magee', brand: 'magee' };  // Different brand!
  const signals = {
    brandSimilarity: 0.3,  // Low - different brand
    qtyCompatible: true,
    finalScore: 0.80,
  };
  
  const uplift = calculateGenericNameUplift(parsed, candidate, signals);
  assertTrue(uplift === null);
});

console.log('\n=== Testing Uplift Magnitude ===\n');

test('uplift: magnitude is conservative (+0.03 to +0.06)', () => {
  const parsed = { name: 'noodles', brand: 'koka' };
  const candidate = { name: 'koka noodles', brand: 'koka' };
  
  // Test different containment ratios
  const signalsHigh = {
    brandSimilarity: 1.0,
    qtyCompatible: true,
    finalScore: 0.85,
  };
  
  const uplift = calculateGenericNameUplift(parsed, candidate, signalsHigh);
  assertNotNull(uplift);
  assertGreaterOrEqual(uplift.upliftAmount, GENERIC_NAME_UPLIFT.UPLIFT_MIN);
  assertLessThan(uplift.upliftAmount, GENERIC_NAME_UPLIFT.UPLIFT_MAX + 0.01);
});

test('uplift: caps at 1.0', () => {
  const parsed = { name: 'noodles', brand: 'koka' };
  const candidate = { name: 'koka noodles', brand: 'koka' };
  
  // Test with a score very close to 1.0
  const signalsNearCap = {
    brandSimilarity: 1.0,
    qtyCompatible: true,
    finalScore: 0.98,
  };
  
  const uplift = calculateGenericNameUplift(parsed, candidate, signalsNearCap);
  assertNotNull(uplift);
  // Final confidence should be capped at 1.0
  const finalConfidence = signalsNearCap.finalScore + uplift.upliftAmount;
  assertLessThan(finalConfidence, 1.01);  // Allow tiny floating point error
});

console.log('\n=== Testing Brand-Aware Containment ===\n');

test('uplift: exact brand match triggers uplift', () => {
  const parsed = { name: 'noodles galinha', brand: 'koka' };
  const candidate = { name: 'koka noodles galinha', brand: 'koka' };
  const signals = {
    brandSimilarity: 0.8,  // Below 0.95 but exact brand match!
    qtyCompatible: true,
    finalScore: 0.85,
  };
  
  const uplift = calculateGenericNameUplift(parsed, candidate, signals);
  // Should apply because exactBrandMatch is true (normalized brands are equal)
  assertNotNull(uplift);
});

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
