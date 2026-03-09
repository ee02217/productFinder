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

/**
 * Write unmatched product with source-local identity preserved
 * 
 * For Pingo Doce, we don't have EAN, so we store:
 * - internalId: the Pingo Doce product ID from URL
 * - matchConfidence: similarity score if fallback matching was attempted
 * - matchTier: tier used (tier1, tier2, or null if no match)
 * - matchReason: detailed reason text
 */
async function writeUnmatched(prisma, { jobId, url, ean, name, reason, internalId, matchConfidence, matchTier, matchReason }) {
  await prisma.retailerUnmatched.create({
    data: {
      retailer: RETAILER,
      url,
      ean: ean || null, // Will always be null for Pingo Doce
      name: name || null,
      reason,
      matchConfidence: matchConfidence ?? null,
      matchTier: matchTier ?? null,
      matchReason: matchReason ?? null,
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

/**
 * Stage temp product with Pingo Doce-specific fields:
 * - Stores internalId for source-local identity
 * - Stores match confidence/tier/reason for manual review workflow
 */
async function stageTempProductAndPrice(prisma, { parsed, reason, matchConfidence, matchTier, matchReason }) {
  if (!parsed?.url) return null;

  const tempProduct = await prisma.tempProduct.upsert({
    where: { sourceUrl: parsed.url },
    create: {
      retailer: RETAILER,
      sourceUrl: parsed.url,
      ean: parsed.ean || null, // Will be null for Pingo Doce
      internalId: parsed.internalId || null, // Pingo Doce internal ID
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
      matchConfidence: matchConfidence ?? null,
      matchTier: matchTier ?? null,
      matchReason: matchReason ?? null,
    },
    update: {
      ean: parsed.ean || null,
      internalId: parsed.internalId || null,
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
      matchConfidence: matchConfidence ?? null,
      matchTier: matchTier ?? null,
      matchReason: matchReason ?? null,
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

/**
 * Write matched price - Pingo Doce products are matched via similarity
 * Not all metadata enrichment (conservative since no EAN confirmation)
 */
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

    // Conservative metadata enrichment - only fill empty fields
    // Don't overwrite existing data since we can't confirm EAN match
    const productPatch = {
      // Only update quantity if product has none
      ...(Number.isInteger(parsed.unitCount) && product.unitCount == null ? { unitCount: parsed.unitCount } : {}),
      ...(parsed.unitType && product.unitType == null ? { unitType: parsed.unitType } : {}),
      // Category - only if completely missing
      ...(parsed.category && !product.category ? { category: parsed.category } : {}),
      ...(parsed.subcategory && !product.subcategory ? { subcategory: parsed.subcategory } : {}),
      // Image - only if completely missing
      ...(parsed.imageUrl && !product.imageUrl ? { imageUrl: parsed.imageUrl } : {}),
    };

    // Only update name/brand if product was empty or has all-caps legacy data
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

/**
 * Check if parsed product has minimum details for staging
 * For Pingo Doce, require name since we have no EAN
 */
function hasMinimumStagingDetails(parsed) {
  return !!parsed?.name;
}

/**
 * For Pingo Doce, we never auto-create products from scraped data
 * This is because there's no EAN to confirm identity
 */
async function createProductFromParsed(prisma, parsed) {
  // This should never be called for Pingo Doce
  // But keeping the function for interface consistency
  throw new Error('Pingo Doce: Auto-creation of products is disabled (no EAN available)');
}

module.exports = {
  samePrice,
  writeUnmatched,
  writeMatchedPrice,
  stageTempProductAndPrice,
  hasMinimumStagingDetails,
  createProductFromParsed,
};
