async function findProductByEan(prisma, ean) {
  if (!ean) return null;
  return prisma.product.findUnique({ where: { ean } });
}

module.exports = { findProductByEan };
