/**
 * Re-evaluate Pingo Doce match suggestions
 * 1. Get latest completed Pingo Doce scrape job
 * 2. Clear ALL previous pingodoce suggestions
 * 3. Regenerate suggestions based on latest job's unmatched set
 * 4. Return summary
 */

const { PrismaClient } = require('@prisma/client');
const { generateSuggestions, getSuggestions, getSuggestionStats } = require('../src/services/matchSuggestionService');

const prisma = new PrismaClient();

async function main() {
  console.log('=== Pingo Doce Suggestion Re-evaluation ===\n');
  
  // Step 1: Get latest completed Pingo Doce RetailerScrapeJob
  console.log('1. Finding latest completed Pingo Doce RetailerScrapeJob...');
  const latestJob = await prisma.retailerScrapeJob.findFirst({
    where: {
      retailer: 'pingodoce',
      status: 'completed',
    },
    orderBy: { completedAt: 'desc' },
    take: 1,
  });
  
  if (!latestJob) {
    console.log('ERROR: No completed Pingo Doce scrape job found!');
    process.exit(1);
  }
  
  console.log(`   Latest job ID: ${latestJob.id}`);
  console.log(`   Completed at: ${latestJob.completedAt}`);
  console.log(`   Total URLs: ${latestJob.totalUrls}`);
  console.log(`   Processed: ${latestJob.processed}`);
  console.log(`   Matched: ${latestJob.matched}`);
  console.log(`   Unmatched: ${latestJob.unmatched}`);
  console.log('');
  
  // Step 2: Delete ALL previous pingodoce match suggestions (all statuses for full refresh)
  console.log('2. Clearing ALL previous Pingo Doce match suggestions...');
  
  // Get counts by status before deletion
  const countsBefore = await prisma.matchSuggestion.groupBy({
    by: ['status'],
    where: { retailer: 'pingodoce' },
    _count: true,
  });
  
  console.log('   Counts before deletion:');
  countsBefore.forEach(c => console.log(`     ${c.status}: ${c._count}`));
  
  // Delete all pingodoce suggestions (all statuses)
  const deleteResult = await prisma.matchSuggestion.deleteMany({
    where: { retailer: 'pingodoce' },
  });
  
  console.log(`   Deleted ${deleteResult.count} total suggestions`);
  console.log('');
  
  // Step 3: Get unmatched rows from the latest job
  console.log('3. Getting unmatched rows from latest job...');
  const unmatchedRows = await prisma.retailerUnmatched.findMany({
    where: { jobId: latestJob.id },
  });
  
  console.log(`   Found ${unmatchedRows.length} unmatched rows in latest job`);
  console.log('');
  
  // Step 4: Run suggestion generation in batches
  console.log('4. Generating suggestions in batches...');
  
  const BATCH_SIZE = 500;
  const MAX_ITERATIONS = 20;
  
  let totalGenerated = 0;
  let iteration = 0;
  
  while (iteration < MAX_ITERATIONS) {
    iteration++;
    
    // Get unmatched rows that don't already have pending suggestions
    // We need to check which ones still need suggestions
    const allUnmatchedIds = unmatchedRows.map(u => u.id);
    
    // Get unmatched rows that still have no pending suggestion
    // We need to find rows that haven't been matched yet
    const unmatchedWithNoSuggestion = await prisma.retailerUnmatched.findMany({
      where: {
        id: { in: allUnmatchedIds },
        // Also check confidence is in the right range for suggestions
        matchConfidence: {
          gte: 0.60,
          lt: 0.92,
        },
      },
      take: BATCH_SIZE,
    });
    
    if (unmatchedWithNoSuggestion.length === 0) {
      console.log(`   No more unmatched rows eligible for suggestions (iteration ${iteration})`);
      break;
    }
    
    // Generate suggestions for this batch
    const result = await generateSuggestions('pingodoce', {
      limit: BATCH_SIZE,
    });
    
    console.log(`   Iteration ${iteration}: generated ${result.generated} suggestions (found ${result.totalFound} eligible)`);
    totalGenerated += result.generated;
    
    if (result.generated === 0) {
      break;
    }
  }
  
  console.log(`\n   Total iterations: ${iteration}`);
  console.log(`   Total generated: ${totalGenerated}`);
  console.log('');
  
  // Step 5: Get final stats
  console.log('5. Final stats...');
  const finalStats = await getSuggestionStats('pingodoce');
  console.log(`   Pending: ${finalStats.pending}`);
  console.log(`   Approved: ${finalStats.approved}`);
  console.log(`   Rejected: ${finalStats.rejected}`);
  console.log(`   Total Mappings: ${finalStats.totalMappings}`);
  console.log('');
  
  // Step 6: Get top 10 regenerated suggestions
  console.log('6. Top 10 regenerated suggestions:');
  const topSuggestions = await getSuggestions('pingodoce', 'pending', { limit: 10 });
  
  topSuggestions.forEach((s, i) => {
    console.log(`   ${i + 1}. "${s.sourceName}" -> "${s.suggestedProduct.name}"`);
    console.log(`      EAN: ${s.suggestedProduct.ean || 'N/A'}, Confidence: ${s.confidence.toFixed(3)}`);
  });
  
  // Summary output
  console.log('\n=== SUMMARY ===');
  console.log(`Latest job ID: ${latestJob.id}`);
  console.log(`Latest job timestamp: ${latestJob.completedAt}`);
  console.log(`Suggestions deleted: ${deleteResult.count}`);
  console.log(`Newly generated suggestions: ${totalGenerated}`);
  console.log(`Total pending suggestions now: ${finalStats.pending}`);
  
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('Error:', e);
  await prisma.$disconnect();
  process.exit(1);
});
