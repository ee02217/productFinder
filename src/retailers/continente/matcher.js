const { RETAILER } = require('./constants');

async function findProductByEan(prisma, ean) {
  if (!ean) return null;
  return prisma.product.findUnique({
    where: { ean },
  });
}

async function findProduct(prisma, { ean, brand, name, unitCount, unitType }) {
  // Simple fallback matching - could be enhanced with hybrid similarity
  if (!name) return null;
  
  // Try exact name match with same brand
  if (brand) {
    const exact = await prisma.product.findFirst({
      where: {
        name: { equals: name, mode: 'insensitive' },
        brand: { equals: brand, mode: 'insensitive' },
      },
    });
    if (exact) return { product: exact, confidence: 0.9, tier: 'exact_name_brand', reason: 'exact_name_brand' };
  }
  
  return null;
}

module.exports = {
  findProductByEan,
  findProduct,
};
