const express = require('express');
const router = express.Router();
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

module.exports = router;
