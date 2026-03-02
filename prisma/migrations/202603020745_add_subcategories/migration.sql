-- Add subcategory and subsubcategory columns
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "subcategory" TEXT;
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "subsubcategory" TEXT;
