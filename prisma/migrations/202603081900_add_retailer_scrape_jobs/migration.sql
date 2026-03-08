-- Retailer scrape tracking (independent from Continente ScrapeJob)
CREATE TABLE IF NOT EXISTS "RetailerScrapeJob" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "retailer" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "dryRun" BOOLEAN NOT NULL DEFAULT false,
  "cursor" INTEGER NOT NULL DEFAULT 0,
  "totalUrls" INTEGER NOT NULL DEFAULT 0,
  "processed" INTEGER NOT NULL DEFAULT 0,
  "matched" INTEGER NOT NULL DEFAULT 0,
  "unmatched" INTEGER NOT NULL DEFAULT 0,
  "insertedPrices" INTEGER NOT NULL DEFAULT 0,
  "unchanged" INTEGER NOT NULL DEFAULT 0,
  "errors" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3)
);

CREATE INDEX IF NOT EXISTS "RetailerScrapeJob_retailer_status_startedAt_idx"
  ON "RetailerScrapeJob"("retailer", "status", "startedAt");

CREATE TABLE IF NOT EXISTS "RetailerUnmatched" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "retailer" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "ean" TEXT,
  "name" TEXT,
  "reason" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RetailerUnmatched_jobId_fkey"
    FOREIGN KEY ("jobId") REFERENCES "RetailerScrapeJob"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "RetailerUnmatched_retailer_createdAt_idx"
  ON "RetailerUnmatched"("retailer", "createdAt");
CREATE INDEX IF NOT EXISTS "RetailerUnmatched_jobId_idx"
  ON "RetailerUnmatched"("jobId");
CREATE INDEX IF NOT EXISTS "RetailerUnmatched_ean_idx"
  ON "RetailerUnmatched"("ean");