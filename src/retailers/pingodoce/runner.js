require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { RETAILER, DEFAULTS } = require('./constants');
const { fetchText, delay } = require('./http');
const { fetchAllProductUrls } = require('./sitemap');
const { parseProduct } = require('./parser');
const { findProduct } = require('./matcher');
const { writeMatchedPrice, writeUnmatched, stageTempProductAndPrice, hasMinimumStagingDetails, createProductFromParsed } = require('./writer');

const prisma = new PrismaClient();

const runtime = {
  running: false,
  stopRequested: false,
  currentJobId: null,
  promise: null,
};

function slugify(v) {
  return String(v || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function getUrlSegments(url) {
  try {
    const path = new URL(url).pathname;
    return path.split('/').filter(Boolean).map(slugify).filter(Boolean);
  } catch {
    return [];
  }
}

function isUrlBlocked(url, blockedRules) {
  if (!blockedRules || blockedRules.length === 0) return false;
  const segments = getUrlSegments(url);
  for (const rule of blockedRules) {
    if (!rule.categorySlug) continue;
    const hasCat = segments.includes(rule.categorySlug);
    if (!hasCat) continue;
    if (!rule.subcategorySlug) return true; // block whole category
    if (segments.includes(rule.subcategorySlug)) return true;
  }
  return false;
}

function parseRunnerOptions(opts = {}) {
  return {
    dryRun: !!opts.dryRun,
    limit: Number.isFinite(parseInt(opts.limit, 10)) ? parseInt(opts.limit, 10) : DEFAULTS.limit,
    delayMs: Number.isFinite(parseInt(opts.delayMs, 10)) ? parseInt(opts.delayMs, 10) : DEFAULTS.delayMs,
    timeoutMs: Number.isFinite(parseInt(opts.timeoutMs, 10)) ? parseInt(opts.timeoutMs, 10) : DEFAULTS.timeoutMs,
    retries: Number.isFinite(parseInt(opts.retries, 10)) ? parseInt(opts.retries, 10) : DEFAULTS.retries,
    retryBaseMs: Number.isFinite(parseInt(opts.retryBaseMs, 10)) ? parseInt(opts.retryBaseMs, 10) : DEFAULTS.retryBaseMs,
  };
}

async function updateJob(jobId, data) {
  return prisma.retailerScrapeJob.update({ where: { id: jobId }, data });
}

async function createJob(options) {
  return prisma.retailerScrapeJob.create({
    data: {
      retailer: RETAILER,
      status: 'running',
      dryRun: options.dryRun,
      cursor: 0,
    },
  });
}

async function markFinished(jobId, status, statsPatch = {}) {
  return updateJob(jobId, {
    status,
    completedAt: new Date(),
    ...statsPatch,
  });
}

async function runWithJob(job, options) {
  const opts = parseRunnerOptions(options);

  let urls = [];
  try {
    urls = await fetchAllProductUrls();
  } catch (err) {
    await markFinished(job.id, 'failed', { errors: job.errors + 1 });
    throw err;
  }

  const blocks = await prisma.retailerCategoryBlock.findMany({
    where: { retailer: RETAILER, blocked: true },
  });
  const blockSet = new Set(blocks.map(b => `${(b.category || '').toLowerCase()}|${(b.subcategory || '').toLowerCase()}`));

  // Fast pre-filter by URL path slugs (avoid fetching/parsing blocked categories)
  const blockedRules = blocks.map(b => ({
    categorySlug: slugify(b.category),
    subcategorySlug: b.subcategory ? slugify(b.subcategory) : null,
  }));

  const discoveredUrls = urls.length;
  const allowedUrls = urls.filter((u) => !isUrlBlocked(u, blockedRules));
  const skippedByBlock = discoveredUrls - allowedUrls.length;

  const selectedUrls = opts.limit > 0 ? allowedUrls.slice(0, opts.limit) : allowedUrls;
  const totalUrls = selectedUrls.length;
  let cursor = Math.min(job.cursor || 0, totalUrls);

  let stats = {
    processed: job.processed || 0,
    matched: job.matched || 0,
    unmatched: job.unmatched || 0,
    insertedPrices: job.insertedPrices || 0,
    unchanged: job.unchanged || 0,
    errors: job.errors || 0,
  };

  console.log(`[PINGODOCE] discovered=${discoveredUrls}, skippedByBlock=${skippedByBlock}, selected=${totalUrls}`);

  await updateJob(job.id, { totalUrls, cursor });

  for (let idx = cursor; idx < totalUrls; idx++) {
    if (runtime.stopRequested) {
      await markFinished(job.id, 'canceled', {
        cursor: idx,
        ...stats,
      });
      return { jobId: job.id, status: 'canceled', ...stats, totalUrls, cursor: idx };
    }

    const url = selectedUrls[idx];
    try {
      const html = await fetchText(url, {
        timeoutMs: opts.timeoutMs,
        retries: opts.retries,
        retryBaseMs: opts.retryBaseMs,
      });
      const parsed = parseProduct(html, url);

      stats.processed++;

      // Skip blocked categories/subcategories
      const catKey = `${(parsed.category || '').toLowerCase()}|${(parsed.subcategory || '').toLowerCase()}`;
      const catOnlyKey = `${(parsed.category || '').toLowerCase()}|`;
      if (blockSet.has(catKey) || blockSet.has(catOnlyKey)) {
        stats.unchanged++;
        if (opts.delayMs > 0) await delay(opts.delayMs);
        cursor = idx + 1;
        if (cursor % 20 === 0 || cursor === totalUrls) {
          await updateJob(job.id, { cursor, ...stats });
        }
        continue;
      }

      // Pingo Doce always has no EAN - go directly to fallback matching
      if (!parsed.priceCents) {
        stats.unmatched++;
        await writeUnmatched(prisma, {
          jobId: job.id,
          url,
          ean: null,
          name: parsed.name,
          reason: 'missing_price',
          internalId: parsed.internalId,
          matchConfidence: null,
          matchTier: null,
          matchReason: 'no_price_parsed',
        });
        // Stage only if we have minimum identity (name)
        if (!opts.dryRun && hasMinimumStagingDetails(parsed)) {
          await stageTempProductAndPrice(prisma, {
            parsed,
            reason: 'missing_price',
            matchConfidence: null,
            matchTier: null,
            matchReason: 'no_price_parsed',
          });
        }
      } else {
        // Try to find matching product via fallback matching (no EAN available)
        const matchResult = await findProduct(prisma, parsed);
        
        if (matchResult.product) {
          // Found a match - write price
          stats.matched++;
          const result = await writeMatchedPrice(prisma, { product: matchResult.product, parsed, dryRun: opts.dryRun });
          if (result.inserted) stats.insertedPrices++;
          if (result.unchanged) stats.unchanged++;
          
          // Still write to unmatched for transparency about match tier
          await writeUnmatched(prisma, {
            jobId: job.id,
            url,
            ean: null,
            name: parsed.name,
            reason: `matched_tier_${matchResult.tier}`,
            internalId: parsed.internalId,
            matchConfidence: matchResult.confidence,
            matchTier: matchResult.tier,
            matchReason: matchResult.reason,
          });
        } else {
          // No match found - goes to unmatched for manual review
          stats.unmatched++;
          await writeUnmatched(prisma, {
            jobId: job.id,
            url,
            ean: null,
            name: parsed.name,
            reason: matchResult.reason || 'no_match_found',
            internalId: parsed.internalId,
            matchConfidence: matchResult.confidence,
            matchTier: matchResult.tier,
            matchReason: matchResult.reason,
          });
          
          // Stage for manual review if we have minimum identity
          if (!opts.dryRun && hasMinimumStagingDetails(parsed)) {
            await stageTempProductAndPrice(prisma, {
              parsed,
              reason: matchResult.reason || 'no_match_found',
              matchConfidence: matchResult.confidence,
              matchTier: matchResult.tier,
              matchReason: matchResult.reason,
            });
          }
        }
      }
    } catch (err) {
      stats.errors++;
      await writeUnmatched(prisma, {
        jobId: job.id,
        url,
        ean: null,
        name: null,
        reason: `fetch_or_parse_error:${err.message.slice(0, 120)}`,
        internalId: null,
        matchConfidence: null,
        matchTier: null,
        matchReason: `error:${err.message.slice(0, 100)}`,
      });
    }

    cursor = idx + 1;

    // Persist progress frequently
    if (cursor % 20 === 0 || cursor === totalUrls) {
      await updateJob(job.id, {
        cursor,
        ...stats,
      });
    }

    if (opts.delayMs > 0) {
      await delay(opts.delayMs);
    }
  }

  await markFinished(job.id, 'completed', {
    cursor,
    ...stats,
  });

  return { jobId: job.id, status: 'completed', ...stats, totalUrls, cursor };
}

async function startBackground(options = {}) {
  if (runtime.running) {
    throw new Error('Pingo Doce scraper already running');
  }

  const opts = parseRunnerOptions(options);
  const job = await createJob(opts);

  runtime.running = true;
  runtime.stopRequested = false;
  runtime.currentJobId = job.id;

  runtime.promise = runWithJob(job, opts)
    .catch(async (err) => {
      await markFinished(job.id, 'failed', { errors: job.errors + 1 });
      throw err;
    })
    .finally(() => {
      runtime.running = false;
      runtime.currentJobId = null;
      runtime.stopRequested = false;
      runtime.promise = null;
    });

  return { jobId: job.id };
}

async function resumeBackground(jobId, options = {}) {
  if (runtime.running) throw new Error('Pingo Doce scraper already running');

  const job = await prisma.retailerScrapeJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error('Job not found');
  if (job.retailer !== RETAILER) throw new Error('Invalid retailer job');
  if (job.status === 'completed') throw new Error('Job already completed');

  const opts = parseRunnerOptions({ ...options, dryRun: job.dryRun });
  await updateJob(jobId, { status: 'running', completedAt: null });

  runtime.running = true;
  runtime.stopRequested = false;
  runtime.currentJobId = job.id;

  runtime.promise = runWithJob({ ...job, status: 'running' }, opts)
    .catch(async () => {
      const latest = await prisma.retailerScrapeJob.findUnique({ where: { id: job.id } });
      await markFinished(job.id, 'failed', { errors: (latest?.errors || 0) + 1 });
    })
    .finally(() => {
      runtime.running = false;
      runtime.currentJobId = null;
      runtime.stopRequested = false;
      runtime.promise = null;
    });

  return { jobId: job.id };
}

async function runForeground(options = {}) {
  const opts = parseRunnerOptions(options);
  const job = await createJob(opts);
  return runWithJob(job, opts);
}

async function requestStop() {
  runtime.stopRequested = true;
  if (runtime.currentJobId) {
    await updateJob(runtime.currentJobId, { status: 'canceled', completedAt: new Date() });
  }
  return { stopping: true, currentJobId: runtime.currentJobId };
}

function getRuntimeStatus() {
  return {
    running: runtime.running,
    stopRequested: runtime.stopRequested,
    currentJobId: runtime.currentJobId,
  };
}

async function listJobs(limit = 30) {
  return prisma.retailerScrapeJob.findMany({
    where: { retailer: RETAILER },
    orderBy: { startedAt: 'desc' },
    take: limit,
  });
}

async function listUnmatched({ jobId, limit = 100 }) {
  return prisma.retailerUnmatched.findMany({
    where: {
      retailer: RETAILER,
      ...(jobId ? { jobId } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

module.exports = {
  parseRunnerOptions,
  runForeground,
  startBackground,
  resumeBackground,
  requestStop,
  getRuntimeStatus,
  listJobs,
  listUnmatched,
};
