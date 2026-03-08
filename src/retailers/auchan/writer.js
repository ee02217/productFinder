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

async function writeUnmatched(prisma, { jobId, url, ean, name, reason }) {
  await prisma.retailerUnmatched.create({
    data: {
      retailer: RETAILER,
      url,
      ean: ean || null,
      name: name || null,
      reason,
      jobId,
    },
  });
}

function sameTempPrice(latest, parsed) {
  return (
    (latest?.priceCents ?? null) === (parsed.priceCents ?? null) &&
    (latest?.pvpCents ?? null) === (parsed.pvpCents ?? null) &&
    (latest?.pricePerKgCents ?? null) === (parsed.pricePerKgCents ?? null) &&
    (latest?.priceUnit ?? null) === (parsed.priceUnit ?? null)
  );
}

async function stageTempProductAndPrice(prisma, { parsed, reason }) {
  if (!parsed?.url) return null;

  const tempProduct = await prisma.tempProduct.upsert({
    where: { sourceUrl: parsed.url },
    create: {
      retailer: RETAILER,
      sourceUrl: parsed.url,
      ean: parsed.ean || null,
      name: parsed.name || null,
      unitCount: Number.isInteger(parsed.unitCount) ? parsed.unitCount : null,
      unitType: parsed.unitType || null,
      status: 'pending',
    },
    update: {
      ean: parsed.ean || null,
      name: parsed.name || undefined,
      ...(Number.isInteger(parsed.unitCount) ? { unitCount: parsed.unitCount } : {}),
      ...(parsed.unitType ? { unitType: parsed.unitType } : {}),
      status: 'pending',
    },
  });

  if (parsed.priceCents != null) {
    const latest = await prisma.tempPrice.findFirst({
      where: { tempProductId: tempProduct.id },
      orderBy: { capturedAt: 'desc' },
    });

    if (!sameTempPrice(latest, parsed)) {
      await prisma.tempPrice.create({
        data: {
          tempProductId: tempProduct.id,
          priceCents: parsed.priceCents,
          pvpCents: parsed.pvpCents,
          pricePerKgCents: parsed.pricePerKgCents,
          priceUnit: parsed.priceUnit,
        },
      });
    }
  }

  return tempProduct;
}

async function writeMatchedPrice(prisma, { product, parsed, dryRun }) {
  const latest = await prisma.price.findFirst({
    where: { productId: product.id, retailer: RETAILER },
    orderBy: { capturedAt: 'desc' },
  });

  if (samePrice(latest, parsed)) {
    return { inserted: false, unchanged: true };
  }

  if (!dryRun) {
    await prisma.price.create({
      data: {
        productId: product.id,
        retailer: RETAILER,
        priceCents: parsed.priceCents,
        pvpCents: parsed.pvpCents,
        pricePerKgCents: parsed.pricePerKgCents,
        priceUnit: parsed.priceUnit,
      },
    });

    if (Number.isInteger(parsed.unitCount) && parsed.unitType) {
      await prisma.product.update({
        where: { id: product.id },
        data: {
          ...(product.unitCount == null ? { unitCount: parsed.unitCount } : {}),
          ...(product.unitType == null ? { unitType: parsed.unitType } : {}),
        },
      });
    }
  }

  return { inserted: true, unchanged: false };
}

module.exports = {
  samePrice,
  writeUnmatched,
  writeMatchedPrice,
  stageTempProductAndPrice,
};
