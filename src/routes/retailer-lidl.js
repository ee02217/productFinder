const express = require('express');
const { PrismaClient } = require('@prisma/client');
const router = express.Router();
const prisma = new PrismaClient();
const {
  startBackground,
  resumeBackground,
  requestStop,
  getRuntimeStatus,
  listJobs,
  listUnmatched,
} = require('../retailers/lidl/runner');

router.post('/start', async (req, res) => {
  try {
    const { dryRun = false, limit = 0, delayMs = 400 } = req.body || {};
    const out = await startBackground({ dryRun, limit, delayMs });
    res.json({ status: 'started', ...out });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/resume/:jobId', async (req, res) => {
  try {
    const { delayMs = 400 } = req.body || {};
    const out = await resumeBackground(req.params.jobId, { delayMs });
    res.json({ status: 'resumed', ...out });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/stop', async (req, res) => {
  try {
    const out = await requestStop();
    res.json({ status: 'stopping', ...out });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/status', async (req, res) => {
  try {
    const jobs = await listJobs(1);
    res.json({
      ...getRuntimeStatus(),
      latestJob: jobs[0] || null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/jobs', async (req, res) => {
  try {
    const limit = Number.isFinite(parseInt(req.query.limit, 10)) ? parseInt(req.query.limit, 10) : 30;
    const jobs = await listJobs(limit);
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/unmatched', async (req, res) => {
  try {
    const limit = Number.isFinite(parseInt(req.query.limit, 10)) ? parseInt(req.query.limit, 10) : 100;
    const jobId = req.query.jobId || undefined;
    const rows = await listUnmatched({ jobId, limit });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List existing Lidl categories/subcategories from current product DB
router.get('/categories', async (req, res) => {
  try {
    const grouped = await prisma.product.groupBy({
      by: ['category', 'subcategory'],
      where: { source: 'lidl' },
      _count: { _all: true },
      _max: { updatedAt: true },
      orderBy: [{ category: 'asc' }, { subcategory: 'asc' }],
    });

    const blocks = await prisma.retailerCategoryBlock.findMany({
      where: { retailer: 'lidl' },
    });

    const blockedSet = new Set(
      blocks.filter(b => b.blocked).map(b => `${(b.category || '').toLowerCase()}|${(b.subcategory || '').toLowerCase()}`)
    );

    const rowsMap = new Map();

    // Rows from existing products
    for (const g of grouped) {
      const key = `${(g.category || '').toLowerCase()}|${(g.subcategory || '').toLowerCase()}`;
      rowsMap.set(key, {
        category: g.category,
        subcategory: g.subcategory,
        productCount: g._count._all,
        lastSeenAt: g._max.updatedAt,
        blocked: blockedSet.has(key),
      });
    }

    // Keep blocked rows visible even after purge (0 products)
    for (const b of blocks) {
      const key = `${(b.category || '').toLowerCase()}|${(b.subcategory || '').toLowerCase()}`;
      if (!rowsMap.has(key)) {
        rowsMap.set(key, {
          category: b.category,
          subcategory: b.subcategory,
          productCount: 0,
          lastSeenAt: null,
          blocked: !!b.blocked,
        });
      } else {
        const row = rowsMap.get(key);
        row.blocked = !!b.blocked;
      }
    }

    const rows = Array.from(rowsMap.values()).sort((a,b)=> {
      const ca = (a.category || '').localeCompare(b.category || '');
      if (ca !== 0) return ca;
      return (a.subcategory || '').localeCompare(b.subcategory || '');
    });

    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Block/unblock category for future runs (no deletion)
router.post('/categories/block', async (req, res) => {
  try {
    const { category, subcategory = null, blocked = true } = req.body || {};
    if (!category) {
      return res.status(400).json({ error: 'category is required' });
    }

    const saved = await prisma.retailerCategoryBlock.upsert({
      where: {
        retailer_category_subcategory: {
          retailer: 'lidl',
          category,
          subcategory,
        },
      },
      create: {
        retailer: 'lidl',
        category,
        subcategory,
        blocked: !!blocked,
      },
      update: {
        blocked: !!blocked,
      },
    });

    let deletedProducts = 0;
    let deletedTempProducts = 0;

    // Auto-purge when blocked
    if (blocked) {
      const deleted = await prisma.product.deleteMany({
        where: {
          source: 'lidl',
          category,
          ...(typeof subcategory === 'string' ? { subcategory } : {}),
        },
      });
      deletedProducts = deleted.count;

      const deletedTemp = await prisma.tempProduct.deleteMany({
        where: {
          retailer: 'lidl',
          category,
          ...(typeof subcategory === 'string' ? { subcategory } : {}),
        },
      });
      deletedTempProducts = deletedTemp.count;
    }

    res.json({
      status: 'ok',
      blocked: !!blocked,
      category,
      subcategory,
      deletedProducts,
      deletedTempProducts,
      block: saved,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/categories/block-bulk', async (req, res) => {
  try {
    const { items = [], blocked = true } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items[] is required' });
    }

    let affected = 0;
    let deletedProducts = 0;
    let deletedTempProducts = 0;

    for (const it of items) {
      const category = it?.category;
      const subcategory = typeof it?.subcategory === 'string' ? it.subcategory : null;
      if (!category) continue;

      await prisma.retailerCategoryBlock.upsert({
        where: {
          retailer_category_subcategory: {
            retailer: 'lidl',
            category,
            subcategory,
          },
        },
        create: {
          retailer: 'lidl',
          category,
          subcategory,
          blocked: !!blocked,
        },
        update: {
          blocked: !!blocked,
        },
      });

      affected++;

      if (blocked) {
        const delP = await prisma.product.deleteMany({
          where: {
            source: 'lidl',
            category,
            ...(typeof subcategory === 'string' ? { subcategory } : {}),
          },
        });
        deletedProducts += delP.count;

        const delT = await prisma.tempProduct.deleteMany({
          where: {
            retailer: 'lidl',
            category,
            ...(typeof subcategory === 'string' ? { subcategory } : {}),
          },
        });
        deletedTempProducts += delT.count;
      }
    }

    res.json({
      status: 'ok',
      blocked: !!blocked,
      affected,
      deletedProducts,
      deletedTempProducts,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/categories/delete-products', async (req, res) => {
  try {
    const { category, subcategory } = req.body || {};
    if (!category) return res.status(400).json({ error: 'category is required' });

    const deletedProducts = await prisma.product.deleteMany({
      where: {
        source: 'lidl',
        category,
        ...(typeof subcategory === 'string' ? { subcategory } : {}),
      },
    });

    const deletedTempProducts = await prisma.tempProduct.deleteMany({
      where: {
        retailer: 'lidl',
        category,
        ...(typeof subcategory === 'string' ? { subcategory } : {}),
      },
    });

    res.json({
      status: 'ok',
      deletedProducts: deletedProducts.count,
      deletedTempProducts: deletedTempProducts.count,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
