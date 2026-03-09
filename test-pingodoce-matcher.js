/**
 * Unit tests for Pingo Doce Matcher - Strict Deterministic Matching
 * 
 * Run with: node test-pingodoce-matcher.js
 */

const {
  findProduct,
  similarity,
  normalizeForComparison,
  SIMILARITY_THRESHOLDS,
  isQuantityCompatible,
} = require('./src/retailers/pingodoce/matcher');

const {
  parseProduct,
  parsePesoLiquido,
  parseQuantityFromPageText,
  parseQuantityFromUrlOrName,
  extractInternalId,
} = require('./src/retailers/pingodoce/parser');

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

function assertNull(actual, msg = '') {
  if (actual !== null) {
    throw new Error(`${msg}\n    Expected: null\n    Actual:   ${actual}`);
  }
}

function assertGreaterOrEqual(actual, min, msg = '') {
  if (actual < min) {
    throw new Error(`${msg}\n    Expected: >= ${min}\n    Actual:   ${actual}`);
  }
}

console.log('\n=== Testing Quantity Compatibility ===\n');

test('isQuantityCompatible: exact match (g)', () => {
  const q1 = { unitCount: 500, unitType: 'g' };
  const q2 = { unitCount: 500, unitType: 'g' };
  assertTrue(isQuantityCompatible(q1, q2));
});

test('isQuantityCompatible: 5% variance allowed', () => {
  const q1 = { unitCount: 500, unitType: 'g' };
  const q2 = { unitCount: 520, unitType: 'g' };  // 4% difference
  assertTrue(isQuantityCompatible(q1, q2));
});

test('isQuantityCompatible: >5% variance rejected', () => {
  const q1 = { unitCount: 500, unitType: 'g' };
  const q2 = { unitCount: 600, unitType: 'g' };  // 20% difference
  assertEqual(isQuantityCompatible(q1, q2), false);
});

test('isQuantityCompatible: different units rejected', () => {
  const q1 = { unitCount: 500, unitType: 'g' };
  const q2 = { unitCount: 500, unitType: 'ml' };
  assertEqual(isQuantityCompatible(q1, q2), false);
});

test('isQuantityCompatible: null handling', () => {
  assertEqual(isQuantityCompatible(null, { unitCount: 500, unitType: 'g' }), null);
  assertEqual(isQuantityCompatible({ unitCount: 500, unitType: 'g' }, null), null);
});

console.log('\n=== Testing Normalization ===\n');

test('normalizeForComparison: removes diacritics', () => {
  assertEqual(normalizeForComparison('café'), 'cafe');
});

test('normalizeForComparison: removes special chars', () => {
  assertEqual(normalizeForComparison('Arroz!@#'), 'arroz');
});

test('normalizeForComparison: collapses whitespace', () => {
  assertEqual(normalizeForComparison('arroz  integral'), 'arroz integral');
});

console.log('\n=== Testing Similarity ===\n');

test('similarity: identical strings', () => {
  assertEqual(similarity('arroz', 'arroz'), 1.0);
});

test('similarity: empty strings', () => {
  assertEqual(similarity('', 'hello'), 0);
  assertEqual(similarity('hello', ''), 0);
});

test('similarity: partial match', () => {
  const sim = similarity('sopa de espargos', 'sopa de');
  assertGreaterOrEqual(sim, 0.4);
});

console.log('\n=== Testing Threshold Constants ===\n');

test('HIGH threshold is 0.92', () => {
  assertEqual(SIMILARITY_THRESHOLDS.HIGH, 0.92);
});

test('MEDIUM threshold is 0.75', () => {
  assertEqual(SIMILARITY_THRESHOLDS.MEDIUM, 0.75);
});

console.log('\n=== Testing Quantity Extraction (Unit Cases) ===\n');

test('parseQuantityFromUrlOrName: 250g', () => {
  const result = parseQuantityFromUrlOrName('massa-500g');
  assertEqual(result.total.unitCount, 500);
  assertEqual(result.total.unitType, 'g');
});

test('parseQuantityFromUrlOrName: 1L', () => {
  const result = parseQuantityFromUrlOrName('leite-1l');
  assertEqual(result.total.unitCount, 1000);
  assertEqual(result.total.unitType, 'ml');
});

test('parseQuantityFromUrlOrName: 6x21.5g multipack', () => {
  const result = parseQuantityFromUrlOrName('6x21.5g');
  assertEqual(result.packCount, 6);
  assertEqual(result.packUnitSize, 21.5);
  assertEqual(result.total.unitCount, 129); // 6 * 21.5 = 129
  assertEqual(result.total.unitType, 'g');
});

test('parseQuantityFromPageText: 0.065 Kg', () => {
  const result = parseQuantityFromPageText('some text 0.065 Kg more text');
  assertEqual(result.unitCount, 65);
  assertEqual(result.unitType, 'g');
});

test('parseQuantityFromPageText: 250 g', () => {
  const result = parseQuantityFromPageText('Peso Líquido 250 g');
  assertEqual(result.unitCount, 250);
  assertEqual(result.unitType, 'g');
});

test('parsePesoLiquido: 250 g', () => {
  const html = 'Algo <span class="weight">Peso Líquido 250 g</span> algo';
  const result = parsePesoLiquido(html);
  assertEqual(result.unitCount, 250);
  assertEqual(result.unitType, 'g');
});

test('parsePesoLiquido: 1 l', () => {
  const html = 'Algo <span class="weight">Peso Líquido 1 l</span> algo';
  const result = parsePesoLiquido(html);
  assertEqual(result.unitCount, 1000);
  assertEqual(result.unitType, 'ml');
});

console.log('\n=== Testing Internal ID Extraction ===\n');

test('extractInternalId: canonical URL (6 digits)', () => {
  const url = 'https://www.pingodoce.pt/home/produtos/mercearia/sopas/sopa-de-espargos-knorr-986672.html';
  assertEqual(extractInternalId(url), '986672');
});

test('extractInternalId: promo URL (5 digits)', () => {
  const url = 'https://www.pingodoce.pt/home/produtos/promocoes/sopa-de-espargos-knorr-11203.html';
  assertEqual(extractInternalId(url), '11203');
});

test('extractInternalId: short ID', () => {
  const url = 'https://www.pingodoce.pt/home/produtos/papelaria/caderno-11525.html';
  assertEqual(extractInternalId(url), '11525');
});

console.log('\n=== Testing Guard Against Bogus Quantities ===\n');

test('normalizeQty: rejects unrealistic 50000g', () => {
  const { normalizeQty } = require('./src/retailers/pingodoce/parser');
  const result = normalizeQty('50000', 'g');
  assertNull(result);
});

test('normalizeQty: accepts 500g', () => {
  const { normalizeQty } = require('./src/retailers/pingodoce/parser');
  const result = normalizeQty('500', 'g');
  assertEqual(result.unitCount, 500);
  assertEqual(result.unitType, 'g');
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
