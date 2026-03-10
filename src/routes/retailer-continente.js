const express = require('express');
const { PrismaClient } = require('@prisma/client');
const router = express.Router();
const prisma = new PrismaClient();

// Continente uses the same scraper system as the original queue-based scraper
// We wrap the scraper.js functionality in retailer-style endpoints

// Get current scrape status from scraper.js (we'll read directly from DB)
async function getContinenteRuntimeStatus() {
  const runningJob = await prisma.scrapeJob.findFirst({
    where: { status: 'running' },
    orderBy: { startedAt: 'desc' },
  });
  
  const pendingCount = await prisma.scrapeJob.count({
    where: { status: 'pending' },
  });
  
  return {
    isScraping: !!runningJob,
    currentJob: runningJob,
    pendingJobs: pendingCount,
  };
}

// List Continente jobs
async function listContinenteJobs(limit = 20) {
  return await prisma.scrapeJob.findMany({
    orderBy: { startedAt: 'desc' },
    take: limit,
  });
}

// Resume a job
async function resumeContinenteJob(jobId, options = {}) {
  const job = await prisma.scrapeJob.findUnique({ where: { id: jobId } });
  if (!job) {
    throw new Error('Job not found');
  }
  
  const settings = await prisma.settings.findUnique({ where: { id: 'default' } });
  const delayMs = options.delayMs || settings?.delayMs || 2000;
  
  // Re-queue the job
  await prisma.scrapeJob.update({
    where: { id: jobId },
    data: { 
      status: 'pending',
      cursorStart: job.cursorEnd || 0,
      delayMs,
      completedAt: null,
    },
  });
  
  // Trigger queue processing if not already running
  // The scraper.js should handle this automatically
  
  return { jobId, status: 'resumed' };
}

router.post('/start', async (req, res) => {
  try {
    const { dryRun = false, limit = 0, delayMs = 400, categories } = req.body || {};
    
    // If categories provided, add them to queue
    if (categories && Array.isArray(categories) && categories.length > 0) {
      const jobs = [];
      for (const cat of categories) {
        const job = await prisma.scrapeJob.create({
          data: {
            category: cat.value || cat,
            label: cat.label || cat.value || cat,
            limit: parseInt(limit, 10) || 0,
            cursorStart: 0,
            status: 'pending',
            delayMs: delayMs || 400,
          },
        });
        jobs.push(job);
      }
      return res.json({ status: 'queued', jobIds: jobs.map(j => j.id), count: jobs.length });
    }
    
    // Default: start scraping all categories (legacy behavior)
    // For now, require explicit categories or return an error
    // This matches the new UI flow where user selects categories first
    const settings = await prisma.settings.findUnique({ where: { id: 'default' } });
    const defaultDelay = settings?.delayMs || 2000;
    
    // Get all available categories from DB
    const dbCategories = await prisma.category.findMany({
      where: { parentId: null }, // Get root categories
      orderBy: { label: 'asc' },
    });
    
    if (dbCategories.length === 0) {
      return res.status(400).json({ error: 'No categories found in database. Please seed categories first.' });
    }
    
    const jobs = [];
    for (const cat of dbCategories) {
      const job = await prisma.scrapeJob.create({
        data: {
          category: cat.urlPath || cat.label,
          label: cat.label,
          limit: parseInt(limit, 10) || 0,
          cursorStart: 0,
          status: 'pending',
          delayMs: delayMs || defaultDelay,
        },
      });
      jobs.push(job);
    }
    
    res.json({ status: 'queued', jobIds: jobs.map(j => j.id), count: jobs.length });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/resume/:jobId', async (req, res) => {
  try {
    const { delayMs = 400 } = req.body || {};
    const out = await resumeContinenteJob(req.params.jobId, { delayMs });
    res.json({ status: 'resumed', ...out });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/stop', async (req, res) => {
  try {
    const now = new Date();
    
    // Cancel running + pending jobs
    const canceled = await prisma.scrapeJob.updateMany({
      where: { status: { in: ['running', 'pending'] } },
      data: { status: 'canceled', completedAt: now },
    });
    
    res.json({ status: 'stopping', canceledJobs: canceled.count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/status', async (req, res) => {
  try {
    const [jobs, status] = await Promise.all([
      listContinenteJobs(1),
      getContinenteRuntimeStatus(),
    ]);
    res.json({
      running: status.isScraping,
      latestJob: jobs[0] || null,
      pendingJobs: status.pendingJobs,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/jobs', async (req, res) => {
  try {
    const limit = Number.isFinite(parseInt(req.query.limit, 10)) ? parseInt(req.query.limit, 10) : 30;
    const jobs = await listContinenteJobs(limit);
    
    // Transform to match expected format (processed/totalUrls, matched, etc.)
    const transformed = jobs.map(j => ({
      id: j.id,
      startedAt: j.startedAt,
      status: j.status,
      processed: j.cursorEnd || 0,
      totalUrls: j.limit || 0,
      matched: 0, // Continente doesn't track this the same way
      unmatched: 0,
      insertedPrices: j.scraped || 0,
      errors: j.errorCount || 0,
      completedAt: j.completedAt,
    }));
    
    res.json(transformed);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List existing Continente categories from current product DB
router.get('/categories', async (req, res) => {
  try {
    const grouped = await prisma.product.groupBy({
      by: ['category', 'subcategory'],
      where: { source: 'continente' },
      _count: { _all: true },
      _max: { updatedAt: true },
      orderBy: [{ category: 'asc' }, { subcategory: 'asc' }],
    });

    const blocks = await prisma.retailerCategoryBlock.findMany({
      where: { retailer: 'continente' },
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

// Block/unblock category
router.post('/categories/block', async (req, res) => {
  try {
    const { category, subcategory = null, blocked = true } = req.body || {};
    if (!category) {
      return res.status(400).json({ error: 'category is required' });
    }

    const saved = await prisma.retailerCategoryBlock.upsert({
      where: {
        retailer_category_subcategory: {
          retailer: 'continente',
          category,
          subcategory,
        },
      },
      create: {
        retailer: 'continente',
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
          source: 'continente',
          category,
          ...(typeof subcategory === 'string' ? { subcategory } : {}),
        },
      });
      deletedProducts = deleted.count;

      const deletedTemp = await prisma.tempProduct.deleteMany({
        where: {
          retailer: 'continente',
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
            retailer: 'continente',
            category,
            subcategory,
          },
        },
        create: {
          retailer: 'continente',
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
            source: 'continente',
            category,
            ...(typeof subcategory === 'string' ? { subcategory } : {}),
          },
        });
        deletedProducts += delP.count;

        const delT = await prisma.tempProduct.deleteMany({
          where: {
            retailer: 'continente',
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
        source: 'continente',
        category,
        ...(typeof subcategory === 'string' ? { subcategory } : {}),
      },
    });

    const deletedTempProducts = await prisma.tempProduct.deleteMany({
      where: {
        retailer: 'continente',
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
