/**
 * Match Review API Routes
 * 
 * Endpoints for human-in-the-loop match suggestion workflow:
 * - POST /generate - Generate suggestions from unmatched products
 * - GET /suggestions - List suggestions with filters
 * - POST /suggestions/:id/approve - Approve a suggestion
 * - POST /suggestions/:id/reject - Reject a suggestion
 * - GET /products/search - Search products for manual selection
 * - GET /stats - Get suggestion stats
 */

const express = require('express');
const router = express.Router();
const matchSuggestionService = require('../services/matchSuggestionService');

/**
 * POST /generate
 * Generate match suggestions from unmatched products
 */
router.post('/generate', async (req, res) => {
  try {
    const { 
      retailer = 'pingodoce', 
      minConfidence, 
      maxConfidence, 
      limit,
      dryRun = false 
    } = req.body || {};
    
    const result = await matchSuggestionService.generateSuggestions(retailer, {
      minConfidence: minConfidence ? parseFloat(minConfidence) : undefined,
      maxConfidence: maxConfidence ? parseFloat(maxConfidence) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      dryRun: !!dryRun,
    });
    
    res.json({
      status: 'ok',
      ...result,
    });
  } catch (err) {
    console.error('Error generating suggestions:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /suggestions
 * List suggestions with filters
 */
router.get('/suggestions', async (req, res) => {
  try {
    const { 
      retailer = 'pingodoce', 
      status = 'pending', 
      limit = 100 
    } = req.query;
    
    const suggestions = await matchSuggestionService.getSuggestions(
      retailer,
      status,
      {
        limit: parseInt(limit, 10),
        includeProduct: true,
      }
    );
    
    // Format for display
    const formatted = suggestions.map(s => ({
      id: s.id,
      retailer: s.retailer,
      sourceInternalId: s.sourceInternalId,
      sourceName: s.sourceName,
      suggestedProduct: s.suggestedProduct ? {
        id: s.suggestedProduct.id,
        name: s.suggestedProduct.name,
        brand: s.suggestedProduct.brand,
        ean: s.suggestedProduct.ean,
        category: s.suggestedProduct.category,
      } : null,
      approvedProduct: s.approvedProduct ? {
        id: s.approvedProduct.id,
        name: s.approvedProduct.name,
        brand: s.approvedProduct.brand,
      } : null,
      confidence: s.confidence,
      signals: s.signals,
      status: s.status,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
    
    res.json(formatted);
  } catch (err) {
    console.error('Error fetching suggestions:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /suggestions/:id/approve
 * Approve a suggestion (optionally with a different product)
 */
router.post('/suggestions/:id/approve', async (req, res) => {
  try {
    const { id } = req.params;
    const { productId: overrideProductId } = req.body || {};
    
    const result = await matchSuggestionService.approveSuggestion(id, overrideProductId);
    
    res.json({
      status: 'approved',
      suggestionId: id,
      mapping: {
        id: result.mapping.id,
        retailer: result.mapping.retailer,
        sourceInternalId: result.mapping.sourceInternalId,
        productId: result.mapping.productId,
      },
    });
  } catch (err) {
    console.error('Error approving suggestion:', err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * POST /suggestions/:id/reject
 * Reject a suggestion
 */
router.post('/suggestions/:id/reject', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await matchSuggestionService.rejectSuggestion(id);
    
    res.json({
      status: 'rejected',
      suggestionId: id,
    });
  } catch (err) {
    console.error('Error rejecting suggestion:', err);
    res.status(400).json({ error: err.message });
  }
});

/**
 * GET /products/search
 * Search products for manual selection
 */
router.get('/products/search', async (req, res) => {
  try {
    const { q = '', limit = 20 } = req.query;
    
    const products = await matchSuggestionService.searchProducts(q, {
      limit: parseInt(limit, 10),
      includePrices: true,
    });
    
    const formatted = products.map(p => ({
      id: p.id,
      name: p.name,
      brand: p.brand,
      ean: p.ean,
      category: p.category,
      subcategory: p.subcategory,
      unitCount: p.unitCount,
      unitType: p.unitType,
      currentPrice: p.prices?.[0]?.priceCents,
    }));
    
    res.json(formatted);
  } catch (err) {
    console.error('Error searching products:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /stats
 * Get suggestion stats
 */
router.get('/stats', async (req, res) => {
  try {
    const { retailer = 'pingodoce' } = req.query;
    
    const stats = await matchSuggestionService.getSuggestionStats(retailer);
    
    res.json(stats);
  } catch (err) {
    console.error('Error fetching stats:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /mappings
 * Get existing mappings
 */
router.get('/mappings', async (req, res) => {
  try {
    const { retailer = 'pingodoce', limit = 100 } = req.query;
    
    const { PrismaClient } = require('@prisma/client');
    const prisma = new PrismaClient();
    
    const mappings = await prisma.productMapping.findMany({
      where: { retailer },
      include: {
        product: true,
      },
      take: parseInt(limit, 10),
      orderBy: { updatedAt: 'desc' },
    });
    
    const formatted = mappings.map(m => ({
      id: m.id,
      retailer: m.retailer,
      sourceInternalId: m.sourceInternalId,
      productId: m.productId,
      product: m.product ? {
        name: m.product.name,
        brand: m.product.brand,
        ean: m.product.ean,
      } : null,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));
    
    res.json(formatted);
  } catch (err) {
    console.error('Error fetching mappings:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
