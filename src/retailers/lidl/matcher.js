const { RETAILER } = require('./constants');

function samePrice(latest, incoming) {
  return (
    (latest?.priceCents ?? null) === (incoming.priceCents ?? null) &&
    (latest?.pvpCents ?? null) === (incoming.pvpCents ?? null) &&
    (latest?.pricePerKgCents ?? null) === (incoming.pricePerKgCents ?? null) &&
    (latest?.priceUnit ?? null) === (incoming.priceUnit ?? null) &&
    (latest?.retailer ?? null) === RETAILER
  );
}

async function findProductByEan(prisma, ean) {
  if (!ean) return null;
  return prisma.product.findUnique({ where: { ean } });
}

module.exports = { findProductByEan };
