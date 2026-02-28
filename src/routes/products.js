const express = require('express');
const { PrismaClient } = require('@prisma/client');

const router = express.Router();
const prisma = new PrismaClient();

// Get all products with pagination
router.get('/', async (req, res) => {
  const { page = 1, limit = 50, search = '', category = '' } = req.query;
  const skip = (page - 1) * limit;

  try {
    const where = {};
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { brand: { contains: search, mode: 'insensitive' } },
        { ean: { contains: search } },
      ];
    }
    if (category) {
      where.category = { contains: category, mode: 'insensitive' };
    }

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        include: {
          prices: {
            orderBy: { capturedAt: 'desc' },
            take: 1,
          },
        },
        skip: parseInt(skip),
        take: parseInt(limit),
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.product.count({ where }),
    ]);

    res.json({
      products: products.map(p => ({
        id: p.id,
        ean: p.ean,
        name: p.name,
        brand: p.brand,
        category: p.category,
        imageUrl: p.imageUrl,
        currentPrice: p.prices[0]?.priceCents,
        currentPricePerKg: p.prices[0]?.pricePerKgCents,
        currentPvp: p.prices[0]?.pvpCents,
        lastUpdated: p.updatedAt,
      })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// Get single product with price history
router.get('/:id', async (req, res) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: {
        prices: {
          orderBy: { capturedAt: 'desc' },
          take: 30,
        },
      },
    });

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json(product);
  } catch (error) {
    console.error('Error fetching product:', error);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// Get product by EAN
router.get('/ean/:ean', async (req, res) => {
  try {
    const product = await prisma.product.findUnique({
      where: { ean: req.params.ean },
      include: {
        prices: {
          orderBy: { capturedAt: 'desc' },
          take: 30,
        },
      },
    });

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json(product);
  } catch (error) {
    console.error('Error fetching product:', error);
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

// Get categories
router.get('/meta/categories', async (req, res) => {
  try {
    const categories = await prisma.product.findMany({
      select: { category: true },
      distinct: ['category'],
      where: { category: { not: null } },
    });

    res.json(categories.map(c => c.category).filter(Boolean));
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

// Get stats
router.get('/meta/stats', async (req, res) => {
  try {
    const [totalProducts, totalPrices, recentScrapes] = await Promise.all([
      prisma.product.count(),
      prisma.price.count(),
      prisma.scrapeJob.findMany({
        orderBy: { startedAt: 'desc' },
        take: 5,
      }),
    ]);

    res.json({
      totalProducts,
      totalPrices,
      recentScrapes,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

// Update product
router.put('/:id', async (req, res) => {
  try {
    const { name, brand, category, imageUrl } = req.body;
    
    const product = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        ...(name && { name }),
        ...(brand !== undefined && { brand }),
        ...(category !== undefined && { category }),
        ...(imageUrl !== undefined && { imageUrl }),
      },
    });

    res.json(product);
  } catch (error) {
    console.error('Error updating product:', error);
    res.status(500).json({ error: 'Failed to update product' });
  }
});

// Delete price record
router.delete('/price/:priceId', async (req, res) => {
  try {
    await prisma.price.delete({
      where: { id: req.params.priceId },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting price:', error);
    res.status(500).json({ error: 'Failed to delete price' });
  }
});

// Delete product and all its prices
router.delete('/:id', async (req, res) => {
  try {
    await prisma.product.delete({
      where: { id: req.params.id },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({ error: 'Failed to delete product' });
  }
});

module.exports = router;
