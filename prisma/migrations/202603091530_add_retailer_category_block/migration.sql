CREATE TABLE IF NOT EXISTS "RetailerCategoryBlock" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid(),
  "retailer" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "subcategory" TEXT,
  "blocked" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "RetailerCategoryBlock_retailer_category_subcategory_key"
  ON "RetailerCategoryBlock"("retailer", "category", "subcategory");

CREATE INDEX IF NOT EXISTS "RetailerCategoryBlock_retailer_blocked_idx"
  ON "RetailerCategoryBlock"("retailer", "blocked");