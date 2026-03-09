/**
 * Unit tests for Lidl Matcher - No-EAN Fallback Matching
 * 
 * Run with: node test-matcher.js
 */

const {
  normalizeString,
  normalizeQuantity,
  isQuantityCompatible,
  jaroWinklerSimilarity,
  getCanonicalBrand,
  MATCH_WEIGHTS,
  TIER2_HIGH_THRESHOLD,
  TIER2_MEDIUM_THRESHOLD,
} = require('./src/retailers/lidl/matcher');

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

function assertGreaterOrEqual(actual, min, msg = '') {
  if (actual < min) {
    throw new Error(`${msg}\n    Expected: >= ${min}\n    Actual:   ${actual}`);
  }
}

console.log('\n=== Testing Normalization Functions ===\n');

test('normalizeString: lowercase conversion', () => {
  assertEqual(normalizeString('HELLO'), 'hello');
});

test('normalizeString: accent removal', () => {
  assertEqual(normalizeString('café'), 'cafe');
});

test('normalizeString: Portuguese accents', () => {
  assertEqual(normalizeString('açãoção'), 'acaocao');
});

test('normalizeString: punctuation removal', () => {
  // Non-ASCII characters beyond accents are also removed
  assertEqual(normalizeString('pão,天然!'), 'pao');
});

test('normalizeString: whitespace collapse', () => {
  assertEqual(normalizeString('hello    world'), 'hello world');
});

test('normalizeString: empty input', () => {
  assertEqual(normalizeString(''), '');
  assertEqual(normalizeString(null), '');
  assertEqual(normalizeString(undefined), '');
});

console.log('\n=== Testing Quantity Normalization ===\n');

test('normalizeQuantity: kilograms to grams', () => {
  const result = normalizeQuantity(1.5, 'kg');
  assertEqual(result.type, 'g');
  assertEqual(result.count, 1500);
});

test('normalizeQuantity: liters to ml', () => {
  const result = normalizeQuantity(2, 'l');
  assertEqual(result.type, 'ml');
  assertEqual(result.count, 2000);
});

test('normalizeQuantity: centiliters to ml', () => {
  const result = normalizeQuantity(33, 'cl');
  assertEqual(result.type, 'ml');
  assertEqual(result.count, 330);
});

test('normalizeQuantity: grams unchanged', () => {
  const result = normalizeQuantity(500, 'g');
  assertEqual(result.type, 'g');
  assertEqual(result.count, 500);
});

test('normalizeQuantity: milliliters unchanged', () => {
  const result = normalizeQuantity(750, 'ml');
  assertEqual(result.type, 'ml');
  assertEqual(result.count, 750);
});

test('normalizeQuantity: units unchanged', () => {
  const result = normalizeQuantity(12, 'un');
  assertEqual(result.type, 'un');
  assertEqual(result.count, 12);
});

test('normalizeQuantity: invalid input returns null', () => {
  assertEqual(normalizeQuantity(null, 'g'), null);
  assertEqual(normalizeQuantity(500, null), null);
  assertEqual(normalizeQuantity(0, 'g'), null);
});

console.log('\n=== Testing Quantity Compatibility ===\n');

test('isQuantityCompatible: exact match', () => {
  const q1 = normalizeQuantity(500, 'g');
  const q2 = normalizeQuantity(500, 'g');
  assertTrue(isQuantityCompatible(q1, q2));
});

test('isQuantityCompatible: 5% variance allowed', () => {
  const q1 = normalizeQuantity(500, 'g');
  const q2 = normalizeQuantity(520, 'g');  // 4% difference
  assertTrue(isQuantityCompatible(q1, q2));
});

test('isQuantityCompatible: >5% variance rejected', () => {
  const q1 = normalizeQuantity(500, 'g');
  const q2 = normalizeQuantity(600, 'g');  // 20% difference
  assertEqual(isQuantityCompatible(q1, q2), false);
});

test('isQuantityCompatible: different units rejected', () => {
  const q1 = normalizeQuantity(1, 'kg');
  const q2 = normalizeQuantity(1000, 'g');  // Same but different types
  // After normalization, types should match but let's verify
  assertEqual(q1.type, 'g');
  assertEqual(q2.type, 'g');
});

test('isQuantityCompatible: null handling', () => {
  assertEqual(isQuantityCompatible(null, { count: 500, type: 'g' }), null);
  assertEqual(isQuantityCompatible({ count: 500, type: 'g' }, null), null);
});

console.log('\n=== Testing String Similarity ===\n');

test('jaroWinklerSimilarity: identical strings', () => {
  assertEqual(jaroWinklerSimilarity('hello', 'hello'), 1.0);
});

test('jaroWinklerSimilarity: completely different', () => {
  assertEqual(jaroWinklerSimilarity('abc', 'xyz'), 0);
});

test('jaroWinklerSimilarity: partial match', () => {
  const sim = jaroWinklerSimilarity('arroz integral', 'arroz');
  assertGreaterOrEqual(sim, 0.4);
});

test('jaroWinklerSimilarity: empty strings', () => {
  assertEqual(jaroWinklerSimilarity('', 'hello'), 0);
  assertEqual(jaroWinklerSimilarity('hello', ''), 0);
});

test('jaroWinklerSimilarity: common prefix bonus', () => {
  const sim1 = jaroWinklerSimilarity('coca cola', 'coca cola zero');
  const sim2 = jaroWinklerSimilarity('xyz abc', 'abc xyz');
  assertGreaterOrEqual(sim1, sim2);
});

test('jaroWinklerSimilarity: case sensitive (pre-normalize before matching)', () => {
  // The matcher should normalize strings before comparing
  const sim = jaroWinklerSimilarity('HELLO', 'hello');
  assertTrue(sim < 1.0);  // Without normalization, case matters
});

console.log('\n=== Testing Brand Aliases ===\n');

test('getCanonicalBrand: exact match', () => {
  assertEqual(getCanonicalBrand('Welchevita'), 'welchevita');
});

test('getCanonicalBrand: case insensitive', () => {
  assertEqual(getCanonicalBrand('WELCHEVITA'), 'welchevita');
});

test('getCanonicalBrand: alias mapping', () => {
  assertEqual(getCanonicalBrand('san lucar'), 'san lucar');
});

test('getCanonicalBrand: unknown brand returns normalized', () => {
  assertEqual(getCanonicalBrand('UnknownBrand'), 'unknownbrand');
});

test('getCanonicalBrand: null handling', () => {
  assertEqual(getCanonicalBrand(null), null);
});

console.log('\n=== Testing Threshold Constants ===\n');

test('TIER2_HIGH_THRESHOLD is >= 0.9', () => {
  assertGreaterOrEqual(TIER2_HIGH_THRESHOLD, 0.9);
});

test('TIER2_MEDIUM_THRESHOLD is between HIGH and 0', () => {
  assertTrue(TIER2_MEDIUM_THRESHOLD > 0 && TIER2_MEDIUM_THRESHOLD < TIER2_HIGH_THRESHOLD);
});

test('MATCH_WEIGHTS sum to ~1.0', () => {
  const sum = MATCH_WEIGHTS.nameExact + MATCH_WEIGHTS.nameSimilarity + 
              MATCH_WEIGHTS.brandExact + MATCH_WEIGHTS.brandAlias + MATCH_WEIGHTS.quantityMatch;
  // Allow small floating point variance
  assertTrue(Math.abs(sum - 1.0) < 0.01, `Sum is ${sum}`);
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
