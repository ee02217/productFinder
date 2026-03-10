/**
 * Category Blocklist Configuration
 * 
 * Root categories that should NOT be scraped for the product finder.
 * These are non-food categories that are out of scope.
 * 
 * To update: edit the BLOCKED_CATEGORY_SLUGS array below.
 * The slugs match the URL path segments (e.g., '/livros/' -> 'livros')
 * 
 * Runtime editing supported via setBlockedSlugs() function.
 */

let BLOCKED_CATEGORY_SLUGS = [
  'livros',
  'casa-bricolage-e-jardim',
  'brinquedos-e-jogos',
  'desporto-roupa-e-viagem',
];

/**
 * Check if a category path should be blocked
 * @param {string} categoryPath - Category path (e.g., '/livros/', '/casa-bricolage-e-jardim/tintas/')
 * @returns {boolean} - true if the category should be blocked
 */
function isCategoryBlocked(categoryPath) {
  if (!categoryPath) return false;
  
  // Normalize: remove leading/trailing slashes and query params
  const cleanPath = String(categoryPath)
    .split('?')[0]
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  
  // Get the root category (first path segment)
  const rootSlug = cleanPath.split('/')[0];
  
  return BLOCKED_CATEGORY_SLUGS.includes(rootSlug);
}

/**
 * Get the root category slug from a path
 * @param {string} categoryPath - Category path
 * @returns {string|null} - Root slug or null if invalid
 */
function getRootCategorySlug(categoryPath) {
  if (!categoryPath) return null;
  
  const cleanPath = String(categoryPath)
    .split('?')[0]
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  
  const parts = cleanPath.split('/');
  return parts[0] || null;
}

/**
 * Filter out blocked categories from a list
 * @param {Array<{value: string, label: string}>} categories - Category options
 * @returns {Array<{value: string, label: string}>} - Filtered categories
 */
function filterBlockedCategories(categories) {
  if (!Array.isArray(categories)) return [];
  
  return categories.filter(cat => !isCategoryBlocked(cat.value));
}

/**
 * Get list of blocked slugs (for debugging/display)
 * @returns {string[]} - Array of blocked category slugs
 */
function getBlockedSlugs() {
  return [...BLOCKED_CATEGORY_SLUGS];
}

/**
 * Set the list of blocked category slugs (runtime editable)
 * @param {string[]} slugs - Array of category slugs to block
 */
function setBlockedSlugs(slugs) {
  if (!Array.isArray(slugs)) {
    throw new Error('slugs must be an array');
  }
  BLOCKED_CATEGORY_SLUGS = slugs;
}

module.exports = {
  BLOCKED_CATEGORY_SLUGS,
  isCategoryBlocked,
  getRootCategorySlug,
  filterBlockedCategories,
  getBlockedSlugs,
  setBlockedSlugs,
};
