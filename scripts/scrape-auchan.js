#!/usr/bin/env node
require('dotenv').config();
const { runForeground, resumeBackground, parseRunnerOptions } = require('../src/retailers/auchan/runner');

function parseArgs(argv) {
  const out = {
    dryRun: false,
    limit: 500,
    delayMs: 400,
    resume: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    if (a === '--limit' && argv[i + 1]) out.limit = parseInt(argv[++i], 10) || 0;
    if (a === '--delay-ms' && argv[i + 1]) out.delayMs = parseInt(argv[++i], 10) || 400;
    if (a === '--resume' && argv[i + 1]) out.resume = argv[++i];
  }

  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));

  // For script mode, --resume starts a background resume and exits quickly.
  if (args.resume) {
    const { startBackground, resumeBackground } = require('../src/retailers/auchan/runner');
    // try resume first
    try {
      const res = await resumeBackground(args.resume, { delayMs: args.delayMs });
      console.log(JSON.stringify({ mode: 'resume-background', ...res }));
      return;
    } catch (e) {
      console.error(JSON.stringify({ error: e.message }));
      process.exit(1);
    }
  }

  try {
    const summary = await runForeground(parseRunnerOptions(args));
    console.log(JSON.stringify(summary));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
})();
