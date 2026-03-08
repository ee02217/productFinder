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
      brand: parsed.brand || null,
      category: parsed.category || null,
      subcategory: parsed.subcategory || null,
      unitCount: Number.isInteger(parsed.unitCount) ? parsed.unitCount : null,
      unitType: parsed.unitType || null,
      packCount: Number.isInteger(parsed.packCount) ? parsed.packCount : null,
      packUnitSize: Number.isFinite(parsed.packUnitSize) ? parsed.packUnitSize : null,
      packUnitType: parsed.packUnitType || null,
      imageUrl: parsed.imageUrl || null,
      status: 'pending',
    },
    update: {
      ean: parsed.ean || null,
      name: parsed.name || undefined,
      ...(parsed.brand ? { brand: parsed.brand } : {}),
      ...(parsed.category ? { category: parsed.category } : {}),
      ...(parsed.subcategory ? { subcategory: parsed.subcategory } : {}),
      ...(Number.isInteger(parsed.unitCount) ? { unitCount: parsed.unitCount } : {}),
      ...(parsed.unitType ? { unitType: parsed.unitType } : {}),
      ...(Number.isInteger(parsed.packCount) ? { packCount: parsed.packCount } : {}),
      ...(Number.isFinite(parsed.packUnitSize) ? { packUnitSize: parsed.packUnitSize } : {}),
      ...(parsed.packUnitType ? { packUnitType: parsed.packUnitType } : {}),
      ...(parsed.imageUrl ? { imageUrl: parsed.imageUrl } : {}),
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

function looksAllCaps(txt) {
  if (!txt) return false;
  return /^[A-ZÀ-Ý0-9\s'’.,\-]+$/.test(String(txt));
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

    // Metadata enrichment for matched products (conservative)
    const productPatch = {
      ...(Number.isInteger(parsed.unitCount) && product.unitCount == null ? { unitCount: parsed.unitCount } : {}),
      ...(parsed.unitType && product.unitType == null ? { unitType: parsed.unitType } : {}),
      ...(parsed.category && !product.category ? { category: parsed.category } : {}),
      ...(parsed.subcategory && !product.subcategory ? { subcategory: parsed.subcategory } : {}),
      ...(parsed.imageUrl && !product.imageUrl ? { imageUrl: parsed.imageUrl } : {}),
    };

    // Normalize uppercase legacy names/brands or auchan-sourced products
    if (parsed.name && (product.source === RETAILER || !product.source || looksAllCaps(product.name))) {
      productPatch.name = parsed.name;
    }
    if (parsed.brand && (product.source === RETAILER || !product.source || looksAllCaps(product.brand) || !product.brand)) {
      productPatch.brand = parsed.brand;
    }

    if (Object.keys(productPatch).length > 0) {
      await prisma.product.update({
        where: { id: product.id },
        data: productPatch,
      });
    }
  }

  return { inserted: true, unchanged: false };
}

function hasAllScrapingDetails(parsed) {
  return !!(
    parsed?.ean &&
    parsed?.name &&
    parsed?.brand &&
    parsed?.category &&
    parsed?.subcategory &&
    parsed?.priceCents
  );
}

async function createProductFromParsed(prisma, parsed) {
  return prisma.product.create({
    data: {
      ean: parsed.ean,
      name: parsed.name,
      brand: parsed.brand,
      category: parsed.category,
      subcategory: parsed.subcategory,
      unitCount: Number.isInteger(parsed.unitCount) ? parsed.unitCount : null,
      unitType: parsed.unitType || null,
      imageUrl: parsed.imageUrl || null,
      source: RETAILER,
    },
  });
}

module.exports = {
  samePrice,
  writeUnmatched,
  writeMatchedPrice,
  stageTempProductAndPrice,
  hasAllScrapingDetails,
  createProductFromParsed,
};
