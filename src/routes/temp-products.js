const express = require('express');
const { PrismaClient } = require('@prisma/client');

const router = express.Router();
const prisma = new PrismaClient();

router.get('/', async (req, res) => {
  try {
    const retailer = req.query.retailer || 'auchan';
    const status = req.query.status || 'pending';
    const limit = Number.isFinite(parseInt(req.query.limit, 10)) ? parseInt(req.query.limit, 10) : 200;

    const items = await prisma.tempProduct.findMany({
      where: {
        retailer,
        ...(status === 'all' ? {} : { status }),
      },
      include: {
        prices: {
          orderBy: { capturedAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });

    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const item = await prisma.tempProduct.findUnique({
      where: { id: req.params.id },
      include: {
        prices: { orderBy: { capturedAt: 'desc' } },
      },
    });
    if (!item) return res.status(404).json({ error: 'Temp product not found' });
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/approve', async (req, res) => {
  try {
    const temp = await prisma.tempProduct.findUnique({
      where: { id: req.params.id },
      include: {
        prices: { orderBy: { capturedAt: 'asc' } },
      },
    });

    if (!temp) return res.status(404).json({ error: 'Temp product not found' });

    // Find existing by EAN if available, else create product
    let product = null;
    if (temp.ean) {
      product = await prisma.product.findUnique({ where: { ean: temp.ean } });
    }

    if (!product) {
      product = await prisma.product.create({
        data: {
          ean: temp.ean || null,
          name: temp.name || `Temp ${temp.retailer} ${temp.id}`,
          brand: temp.brand || null,
          category: temp.category || null,
          subcategory: temp.subcategory || null,
          unitCount: temp.unitCount || null,
          unitType: temp.unitType || null,
          source: temp.retailer,
          imageUrl: temp.imageUrl || null,
        },
      });
    }

    let imported = 0;
    for (const p of temp.prices) {
      const exists = await prisma.price.findFirst({
        where: {
          productId: product.id,
          retailer: temp.retailer,
          capturedAt: p.capturedAt,
          priceCents: p.priceCents,
        },
      });

      if (!exists) {
        await prisma.price.create({
          data: {
            productId: product.id,
            retailer: temp.retailer,
            priceCents: p.priceCents,
            pvpCents: p.pvpCents,
            pricePerKgCents: p.pricePerKgCents,
            priceUnit: p.priceUnit,
            capturedAt: p.capturedAt,
          },
        });
        imported++;
      }
    }

    await prisma.tempProduct.update({
      where: { id: temp.id },
      data: { status: 'approved' },
    });

    res.json({ status: 'approved', importedPrices: imported, productId: product.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/reject', async (req, res) => {
  try {
    const item = await prisma.tempProduct.update({
      where: { id: req.params.id },
      data: { status: 'rejected' },
    });
    res.json({ status: 'rejected', id: item.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
