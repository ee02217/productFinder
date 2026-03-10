/**
 * Category Blocklist Tests
 */
const { 
  isCategoryBlocked, 
  getRootCategorySlug, 
  filterBlockedCategories, 
  getBlockedSlugs,
  BLOCKED_CATEGORY_SLUGS 
} = require('../src/config/categoryBlocklist');

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

function assertTrue(actual, msg = '') {
  if (actual !== true) {
    throw new Error(`${msg}\nExpected: true\nActual: ${actual}`);
  }
}

function assertFalse(actual, msg = '') {
  if (actual !== false) {
    throw new Error(`${msg}\nExpected: false\nActual: ${actual}`);
  }
}

// ====================
// Configuration tests
// ====================

test('BLOCKED_CATEGORY_SLUGS contains required categories', () => {
  assertTrue(BLOCKED_CATEGORY_SLUGS.includes('livros'), 'livros should be blocked');
  assertTrue(BLOCKED_CATEGORY_SLUGS.includes('casa-bricolage-e-jardim'), 'casa-bricolage-e-jardim should be blocked');
  assertTrue(BLOCKED_CATEGORY_SLUGS.includes('brinquedos-e-jogos'), 'brinquedos-e-jogos should be blocked');
  assertTrue(BLOCKED_CATEGORY_SLUGS.includes('desporto-roupa-e-viagem'), 'desporto-roupa-e-viagem should be blocked');
});

test('getBlockedSlugs returns array', () => {
  const slugs = getBlockedSlugs();
  assertEqual(Array.isArray(slugs), true);
  assertEqual(slugs.length, 4);
});

// ====================
// isCategoryBlocked tests
// ====================

test('isCategoryBlocked: null/empty returns false', () => {
  assertFalse(isCategoryBlocked(null));
  assertFalse(isCategoryBlocked(''));
  assertFalse(isCategoryBlocked(undefined));
});

test('isCategoryBlocked: blocks livros', () => {
  assertTrue(isCategoryBlocked('/livros/'));
  assertTrue(isCategoryBlocked('livros'));
  assertTrue(isCategoryBlocked('/livros/fiction/'));
});

test('isCategoryBlocked: blocks casa-bricolage-e-jardim', () => {
  assertTrue(isCategoryBlocked('/casa-bricolage-e-jardim/'));
  assertTrue(isCategoryBlocked('casa-bricolage-e-jardim'));
  assertTrue(isCategoryBlocked('/casa-bricolage-e-jardim/tintas/'));
});

test('isCategoryBlocked: blocks brinquedos-e-jogos', () => {
  assertTrue(isCategoryBlocked('/brinquedos-e-jogos/'));
  assertTrue(isCategoryBlocked('brinquedos-e-jogos'));
  assertTrue(isCategoryBlocked('/brinquedos-e-jogos/acao/'));
});

test('isCategoryBlocked: blocks desporto-roupa-e-viagem', () => {
  assertTrue(isCategoryBlocked('/desporto-roupa-e-viagem/'));
  assertTrue(isCategoryBlocked('desporto-roupa-e-viagem'));
  assertTrue(isCategoryBlocked('/desporto-roupa-e-viagem/fitness/'));
});

test('isCategoryBlocked: allows food categories', () => {
  assertFalse(isCategoryBlocked('/mercearia/'));
  assertFalse(isCategoryBlocked('mercearia'));
  assertFalse(isCategoryBlocked('/frescos/frutas/'));
  assertFalse(isCategoryBlocked('/laticinios-e-ovos/'));
  assertFalse(isCategoryBlocked('/congelados/'));
  assertFalse(isCategoryBlocked('/bebidas-e-garrafeira/'));
  assertFalse(isCategoryBlocked('/bio-e-saudavel/'));
});

test('isCategoryBlocked: handles query strings', () => {
  assertTrue(isCategoryBlocked('/livros/?page=2'));
  assertFalse(isCategoryBlocked('/mercearia/?sort=price'));
});

test('isCategoryBlocked: case sensitive (must match exactly)', () => {
  assertFalse(isCategoryBlocked('/LIVROS/'));
  assertFalse(isCategoryBlocked('/MERCEARIA/'));
});

// ====================
// getRootCategorySlug tests
// ====================

test('getRootCategorySlug: extracts root from path', () => {
  assertEqual(getRootCategorySlug('/livros/fiction/'), 'livros');
  assertEqual(getRootCategorySlug('casa-bricolage-e-jardim/tintas/'), 'casa-bricolage-e-jardim');
  assertEqual(getRootCategorySlug('/mercearia/arroz-massa-e-farinha/'), 'mercearia');
});

test('getRootCategorySlug: handles null/empty', () => {
  assertEqual(getRootCategorySlug(null), null);
  assertEqual(getRootCategorySlug(''), null);
});

test('getRootCategorySlug: handles query strings', () => {
  assertEqual(getRootCategorySlug('/livros/?page=2'), 'livros');
});

// ====================
// filterBlockedCategories tests
// ====================

test('filterBlockedCategories: filters out blocked', () => {
  const categories = [
    { value: '/mercearia/', label: 'Mercearia' },
    { value: '/livros/', label: 'Livros' },
    { value: '/frescos/frutas/', label: 'Frescos > Frutas' },
    { value: '/brinquedos-e-jogos/', label: 'Brinquedos e Jogos' },
  ];
  const result = filterBlockedCategories(categories);
  assertEqual(result.length, 2);
  assertEqual(result[0].value, '/mercearia/');
  assertEqual(result[1].value, '/frescos/frutas/');
});

test('filterBlockedCategories: handles empty array', () => {
  assertEqual(filterBlockedCategories([]).length, 0);
});

test('filterBlockedCategories: handles null/undefined', () => {
  assertEqual(filterBlockedCategories(null).length, 0);
  assertEqual(filterBlockedCategories(undefined).length, 0);
});

test('filterBlockedCategories: allows all when none blocked', () => {
  const categories = [
    { value: '/mercearia/', label: 'Mercearia' },
    { value: '/frescos/', label: 'Frescos' },
    { value: '/congelados/', label: 'Congelados' },
  ];
  const result = filterBlockedCategories(categories);
  assertEqual(result.length, 3);
});

console.log('\n✅ All blocklist tests completed');
