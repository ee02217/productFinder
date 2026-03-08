-- Temporary staging tables for unmatched retailer products/prices

CREATE TABLE IF NOT EXISTS "TempProduct" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "retailer" TEXT NOT NULL,
  "sourceUrl" TEXT NOT NULL,
  "ean" TEXT,
  "name" TEXT,
  "brand" TEXT,
  "category" TEXT,
  "subcategory" TEXT,
  "unitCount" INTEGER,
  "unitType" TEXT,
  "imageUrl" TEXT,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "TempProduct_sourceUrl_key" ON "TempProduct"("sourceUrl");
CREATE INDEX IF NOT EXISTS "TempProduct_retailer_status_createdAt_idx" ON "TempProduct"("retailer", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "TempProduct_ean_idx" ON "TempProduct"("ean");

CREATE TABLE IF NOT EXISTS "TempPrice" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "tempProductId" TEXT NOT NULL,
  "priceCents" INTEGER NOT NULL,
  "pvpCents" INTEGER,
  "pricePerKgCents" INTEGER,
  "priceUnit" TEXT,
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TempPrice_tempProductId_fkey"
    FOREIGN KEY ("tempProductId") REFERENCES "TempProduct"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "TempPrice_tempProductId_capturedAt_idx" ON "TempPrice"("tempProductId", "capturedAt");
