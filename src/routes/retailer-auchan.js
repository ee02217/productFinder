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
} = require('../retailers/auchan/runner');

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

// List existing Auchan categories/subcategories from current product DB
router.get('/categories', async (req, res) => {
  try {
    const grouped = await prisma.product.groupBy({
      by: ['category', 'subcategory'],
      where: { source: 'auchan' },
      _count: { _all: true },
      _max: { updatedAt: true },
      orderBy: [{ category: 'asc' }, { subcategory: 'asc' }],
    });

    const blocks = await prisma.retailerCategoryBlock.findMany({
      where: { retailer: 'auchan' },
    });

    const blockedSet = new Set(
      blocks.filter(b => b.blocked).map(b => `${(b.category || '').toLowerCase()}|${(b.subcategory || '').toLowerCase()}`)
    );

    const rows = grouped.map(g => ({
      category: g.category,
      subcategory: g.subcategory,
      productCount: g._count._all,
      lastSeenAt: g._max.updatedAt,
      blocked: blockedSet.has(`${(g.category || '').toLowerCase()}|${(g.subcategory || '').toLowerCase()}`),
    }));

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
          retailer: 'auchan',
          category,
          subcategory,
        },
      },
      create: {
        retailer: 'auchan',
        category,
        subcategory,
        blocked: !!blocked,
      },
      update: {
        blocked: !!blocked,
      },
    });

    res.json({
      status: 'ok',
      blocked: !!blocked,
      category,
      subcategory,
      block: saved,
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
        source: 'auchan',
        category,
        ...(typeof subcategory === 'string' ? { subcategory } : {}),
      },
    });

    const deletedTempProducts = await prisma.tempProduct.deleteMany({
      where: {
        retailer: 'auchan',
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
