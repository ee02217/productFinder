/**
 * Sanity tests for source details merge precedence
 * Tests the logic: prefer tempProduct values, fallback to retailerUnmatched
 */

// Helper function that mirrors the merge logic in matchReview.js
function mergeSourceDetails(unmatched, tempProduct) {
  if (!unmatched && !tempProduct) {
    return null;
  }
  
  const tempLatestPrice = tempProduct?.prices?.[0] || null;
  
  return {
    // Prefer tempProduct.name, fallback to unmatched.name
    name: tempProduct?.name ?? unmatched?.name ?? null,
    // Only tempProduct has brand
    brand: tempProduct?.brand ?? null,
    // Prefer tempProduct EAN, fallback to unmatched EAN
    ean: tempProduct?.ean ?? unmatched?.ean ?? null,
    // Only tempProduct has unitCount/unitType
    unitCount: tempProduct?.unitCount ?? null,
    unitType: tempProduct?.unitType ?? null,
    // Prefer tempProduct prices
    priceCents: tempLatestPrice?.priceCents ?? null,
    pricePerKgCents: tempLatestPrice?.pricePerKgCents ?? null,
    priceUnit: tempLatestPrice?.priceUnit ?? null,
    // Internal ID: prefer tempProduct, fallback to unmatched
    internalId: tempProduct?.internalId ?? unmatched?.internalId ?? null,
    // URL: prefer tempProduct sourceUrl, fallback to unmatched url
    url: tempProduct?.sourceUrl ?? unmatched?.url ?? null,
  };
}

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
  } catch (err) {
    console.log(`❌ ${name}: ${err.message}`);
    process.exitCode = 1;
  }
}

function assertEqual(actual, expected, msg = '') {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${msg}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`);
  }
}

// ====================
// Merge precedence tests
// ====================

test('precedence: tempProduct preferred over unmatched for name', () => {
  const unmatched = { name: 'Unmatched Name', internalId: '123', url: 'http://test.com' };
  const tempProduct = { name: 'Temp Product Name', internalId: '123' };
  
  const result = mergeSourceDetails(unmatched, tempProduct);
  assertEqual(result.name, 'Temp Product Name', 'tempProduct name should be preferred');
});

test('precedence: fallback to unmatched when tempProduct.name is null', () => {
  const unmatched = { name: 'Unmatched Name', internalId: '123', url: 'http://test.com' };
  const tempProduct = { name: null, internalId: '123' };
  
  const result = mergeSourceDetails(unmatched, tempProduct);
  assertEqual(result.name, 'Unmatched Name', 'should fallback to unmatched name');
});

test('precedence: tempProduct.brand used when present', () => {
  const unmatched = { name: 'Name', internalId: '123', url: 'http://test.com' };
  const tempProduct = { name: 'Name', brand: 'BrandX', internalId: '123' };
  
  const result = mergeSourceDetails(unmatched, tempProduct);
  assertEqual(result.brand, 'BrandX', 'brand should come from tempProduct');
});

test('precedence: fallback to null when tempProduct.brand missing', () => {
  const unmatched = { name: 'Name', internalId: '123', url: 'http://test.com' };
  const tempProduct = { name: 'Name', brand: null, internalId: '123' };
  
  const result = mergeSourceDetails(unmatched, tempProduct);
  assertEqual(result.brand, null, 'brand should be null when tempProduct has no brand');
});

test('precedence: tempProduct.unitCount/unitType preferred', () => {
  const unmatched = { name: 'Name', internalId: '123', url: 'http://test.com' };
  const tempProduct = { name: 'Name', unitCount: 500, unitType: 'g', internalId: '123' };
  
  const result = mergeSourceDetails(unmatched, tempProduct);
  assertEqual(result.unitCount, 500, 'unitCount should come from tempProduct');
  assertEqual(result.unitType, 'g', 'unitType should come from tempProduct');
});

test('precedence: tempProduct prices preferred', () => {
  const unmatched = { name: 'Name', internalId: '123', url: 'http://test.com' };
  const tempProduct = { 
    name: 'Name', 
    internalId: '123',
    prices: [{ priceCents: 999, pricePerKgCents: 1998, priceUnit: 'kg' }]
  };
  
  const result = mergeSourceDetails(unmatched, tempProduct);
  assertEqual(result.priceCents, 999, 'priceCents should come from tempProduct');
  assertEqual(result.pricePerKgCents, 1998, 'pricePerKgCents should come from tempProduct');
  assertEqual(result.priceUnit, 'kg', 'priceUnit should come from tempProduct');
});

test('precedence: fallback when tempProduct has no prices', () => {
  const unmatched = { name: 'Name', internalId: '123', url: 'http://test.com' };
  const tempProduct = { name: 'Name', internalId: '123', prices: [] };
  
  const result = mergeSourceDetails(unmatched, tempProduct);
  assertEqual(result.priceCents, null, 'priceCents should be null');
  assertEqual(result.pricePerKgCents, null, 'pricePerKgCents should be null');
});

test('precedence: only unmatched exists', () => {
  const unmatched = { name: 'Only Unmatched', internalId: '123', url: 'http://test.com', ean: '123456789' };
  const tempProduct = null;
  
  const result = mergeSourceDetails(unmatched, tempProduct);
  assertEqual(result.name, 'Only Unmatched', 'name should come from unmatched');
  assertEqual(result.ean, '123456789', 'ean should come from unmatched');
  assertEqual(result.brand, null, 'brand should be null (no tempProduct)');
  assertEqual(result.url, 'http://test.com', 'url should come from unmatched');
});

test('precedence: only tempProduct exists', () => {
  const unmatched = null;
  const tempProduct = { 
    name: 'Only TempProduct', 
    brand: 'BrandY',
    ean: '987654321',
    internalId: '456',
    sourceUrl: 'http://temp.com',
    unitCount: 250,
    unitType: 'ml',
    prices: [{ priceCents: 150, pricePerKgCents: 600, priceUnit: 'l' }]
  };
  
  const result = mergeSourceDetails(unmatched, tempProduct);
  assertEqual(result.name, 'Only TempProduct', 'name should come from tempProduct');
  assertEqual(result.brand, 'BrandY', 'brand should come from tempProduct');
  assertEqual(result.ean, '987654321', 'ean should come from tempProduct');
  assertEqual(result.unitCount, 250, 'unitCount should come from tempProduct');
  assertEqual(result.priceCents, 150, 'priceCents should come from tempProduct');
  assertEqual(result.url, 'http://temp.com', 'url should come from tempProduct sourceUrl');
});

test('precedence: both null returns null', () => {
  const result = mergeSourceDetails(null, null);
  assertEqual(result, null, 'should return null when both inputs are null');
});

console.log('\n--- All precedence tests completed ---');
