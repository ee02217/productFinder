/**
 * Parser tests for Pingo Doce
 */
const { parsePerUnit, parseProduct, normalizeQty, toCents } = require('../src/retailers/pingodoce/parser');
const { filterPromocoesUrls, deduplicateUrls } = require('../src/retailers/pingodoce/sitemap');

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
// parsePerUnit tests
// ====================

test('parsePerUnit: data-gtm-info pattern', () => {
  const html = '<span class="pricePer">39,83 €/L</span>';
  const result = parsePerUnit(html);
  assertEqual(result.pricePerKgCents, 3983, 'price should be 3983 cents');
  assertEqual(result.priceUnit, 'l', 'unit should be l');
});

test('parsePerUnit: volume + price pattern (0.06 L | 39,83 €/L)', () => {
  const html = '<div class="unit-info">0.06 L | 39,83 €/L</div>';
  const result = parsePerUnit(html);
  assertEqual(result.pricePerKgCents, 3983, 'price should be 3983 cents');
  assertEqual(result.priceUnit, 'l', 'unit should be l');
});

test('parsePerUnit: volume + price pattern (250 g | 1,16 €/Kg)', () => {
  const html = '<div class="unit-info">250 g | 1,16 €/Kg</div>';
  const result = parsePerUnit(html);
  assertEqual(result.pricePerKgCents, 116, 'price should be 116 cents');
  assertEqual(result.priceUnit, 'kg', 'unit should be kg');
});

test('parsePerUnit: Tabasco-like case (small volume 59ml | price)', () => {
  // Real-world: 0.059 L | 8,90 €/L (Tabasco 60ml is ~€4.50, so this is an example)
  const html = '<span class="product-unit">0.059 L | 8,90 €/L</span>';
  const result = parsePerUnit(html);
  assertEqual(result.pricePerKgCents, 890, 'price should be 890 cents');
  assertEqual(result.priceUnit, 'l', 'unit should be l');
});

test('parsePerUnit: no space between quantity and unit', () => {
  const html = '<div>250g | 1,16€/Kg</div>';
  const result = parsePerUnit(html);
  assertEqual(result.pricePerKgCents, 116, 'price should be 116 cents');
  assertEqual(result.priceUnit, 'kg', 'unit should be kg');
});

test('parsePerUnit: lowercase unit', () => {
  const html = '<div>1 L | 2,50 €/l</div>';
  const result = parsePerUnit(html);
  assertEqual(result.pricePerKgCents, 250, 'price should be 250 cents');
  assertEqual(result.priceUnit, 'l', 'unit should be l');
});

test('parsePerUnit: standalone price per kg', () => {
  const html = '<span class="price">1,16 €/Kg</span>';
  const result = parsePerUnit(html);
  assertEqual(result.pricePerKgCents, 116, 'price should be 116 cents');
  assertEqual(result.priceUnit, 'kg', 'unit should be kg');
});

test('parsePerUnit: standalone price per liter', () => {
  const html = '<span class="unit-price">2,45 €/L</span>';
  const result = parsePerUnit(html);
  assertEqual(result.pricePerKgCents, 245, 'price should be 245 cents');
  assertEqual(result.priceUnit, 'l', 'unit should be l');
});

test('parsePerUnit: price per un (unit)', () => {
  const html = '<span>0,85 €/un</span>';
  const result = parsePerUnit(html);
  assertEqual(result.pricePerKgCents, 85, 'price should be 85 cents');
  assertEqual(result.priceUnit, 'un', 'unit should be un');
});

test('parsePerUnit: no per-unit price returns nulls', () => {
  const html = '<div class="product">Just a regular product</div>';
  const result = parsePerUnit(html);
  assertEqual(result.pricePerKgCents, null);
  assertEqual(result.priceUnit, null);
});

test('parsePerUnit: null input returns nulls', () => {
  const result = parsePerUnit(null);
  assertEqual(result.pricePerKgCents, null);
  assertEqual(result.priceUnit, null);
});

// ====================
// normalizeQty tests
// ====================

test('normalizeQty: grams to g', () => {
  const result = normalizeQty('250', 'g');
  assertEqual(result, { unitCount: 250, unitType: 'g' });
});

test('normalizeQty: kg to g', () => {
  const result = normalizeQty('1.5', 'kg');
  assertEqual(result, { unitCount: 1500, unitType: 'g' });
});

test('normalizeQty: liters to ml', () => {
  const result = normalizeQty('1', 'l');
  assertEqual(result, { unitCount: 1000, unitType: 'ml' });
});

test('normalizeQty: ml stays ml', () => {
  const result = normalizeQty('500', 'ml');
  assertEqual(result, { unitCount: 500, unitType: 'ml' });
});

// ====================
// sitemap filter tests
// ====================

test('filterPromocoesUrls: removes promocoes URLs', () => {
  const urls = [
    'https://www.pingodoce.pt/home/produtos/product1.html',
    'https://www.pingodoce.pt/promocoes/product2.html',
    'https://www.pingodoce.pt/home/produtos/category/product3.html',
    'https://www.pingodoce.pt/promocoes/specials/product4.html',
  ];
  const result = filterPromocoesUrls(urls);
  assertEqual(result.length, 2);
  assertEqual(result[0].includes('/home/produtos/'), true);
  assertEqual(result[1].includes('/home/produtos/'), true);
});

test('filterPromocoesUrls: handles invalid URLs gracefully', () => {
  const urls = [
    'https://www.pingodoce.pt/home/produtos/product1.html',
    'not-a-url',
    'https://www.pingodoce.pt/promocoes/product2.html',
  ];
  const result = filterPromocoesUrls(urls);
  // Invalid URLs should be kept (as per implementation)
  assertEqual(result.length, 2);
});

test('deduplicateUrls: prefers produtos over promocoes', () => {
  const urls = [
    'https://www.pingodoce.pt/promocoes/tabasco-123456.html',
    'https://www.pingodoce.pt/home/produtos/tabasco-123456.html',
  ];
  const result = deduplicateUrls(urls);
  assertEqual(result.length, 1);
  assertEqual(result[0].includes('/home/produtos/'), true);
});

// ====================
// toCents tests
// ====================

test('toCents: handles Portuguese decimals', () => {
  assertEqual(toCents('39,83'), 3983);
  assertEqual(toCents('1,16'), 116);
  assertEqual(toCents('2,50'), 250);
});

test('toCents: handles regular decimals', () => {
  assertEqual(toCents('39.83'), 3983);
  assertEqual(toCents('1.16'), 116);
});

test('toCents: null input', () => {
  assertEqual(toCents(null), null);
});

test('toCents: invalid input', () => {
  assertEqual(toCents('abc'), null);
});

console.log('\n✅ All tests completed');
