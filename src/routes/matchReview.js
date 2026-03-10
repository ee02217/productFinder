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
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
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
        includePrices: true,
      }
    );
    
    // Format for display
    const formatted = suggestions.map(s => {
      // Get latest price for suggested product
      const latestPrice = s.suggestedProduct?.prices?.[0] || null;
      
      return {
        id: s.id,
        retailer: s.retailer,
        sourceInternalId: s.sourceInternalId,
        sourceUrl: s.sourceUrl,
        sourceName: s.sourceName,
        suggestedProduct: s.suggestedProduct ? {
          id: s.suggestedProduct.id,
          name: s.suggestedProduct.name,
          brand: s.suggestedProduct.brand,
          ean: s.suggestedProduct.ean,
          category: s.suggestedProduct.category,
          unitCount: s.suggestedProduct.unitCount,
          unitType: s.suggestedProduct.unitType,
          priceCents: latestPrice?.priceCents || null,
          pricePerKgCents: latestPrice?.pricePerKgCents || null,
          priceUnit: latestPrice?.priceUnit || null,
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
      };
    });
    
    res.json(formatted);
  } catch (err) {
    console.error('Error fetching suggestions:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /suggestions/:id
 * Get detailed suggestion info with source details and full product info
 */
router.get('/suggestions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const suggestion = await prisma.matchSuggestion.findUnique({
      where: { id },
      include: {
        suggestedProduct: {
          include: {
            prices: {
              orderBy: { capturedAt: 'desc' },
              take: 1,
            },
          },
        },
        approvedProduct: {
          include: {
            prices: {
              orderBy: { capturedAt: 'desc' },
              take: 1,
            },
          },
        },
      },
    });
    
    if (!suggestion) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }
    
    // Try to get source details from RetailerUnmatched or TempProduct
    let sourceDetails = null;
    
    if (suggestion.sourceInternalId || suggestion.sourceUrl) {
      // Try RetailerUnmatched first (no prices in this model)
      const unmatched = await prisma.retailerUnmatched.findFirst({
        where: {
          retailer: suggestion.retailer,
          ...(suggestion.sourceInternalId ? { internalId: suggestion.sourceInternalId } : {}),
          ...(suggestion.sourceUrl && !suggestion.sourceInternalId ? { url: suggestion.sourceUrl } : {}),
        },
      });
      
      if (unmatched) {
        sourceDetails = {
          name: unmatched.name,
          brand: null, // RetailerUnmatched doesn't have brand
          ean: unmatched.ean,
          unitCount: null,
          unitType: null,
          priceCents: null,
          pricePerKgCents: null,
          priceUnit: null,
          internalId: unmatched.internalId,
          url: unmatched.url,
        };
      } else {
        // Try TempProduct
        const tempProduct = await prisma.tempProduct.findFirst({
          where: {
            retailer: suggestion.retailer,
            ...(suggestion.sourceInternalId ? { internalId: suggestion.sourceInternalId } : {}),
            ...(suggestion.sourceUrl && !suggestion.sourceInternalId ? { sourceUrl: suggestion.sourceUrl } : {}),
          },
          include: {
            prices: {
              orderBy: { capturedAt: 'desc' },
              take: 1,
            },
          },
        });
        
        if (tempProduct) {
          const latestPrice = tempProduct.prices?.[0] || null;
          sourceDetails = {
            name: tempProduct.name,
            brand: tempProduct.brand,
            ean: tempProduct.ean,
            unitCount: tempProduct.unitCount,
            unitType: tempProduct.unitType,
            priceCents: latestPrice?.priceCents || null,
            pricePerKgCents: latestPrice?.pricePerKgCents || null,
            priceUnit: latestPrice?.priceUnit || null,
            internalId: tempProduct.internalId,
            url: tempProduct.sourceUrl,
          };
        }
      }
    }
    
    // If no source details found, use what's in the suggestion itself
    if (!sourceDetails) {
      sourceDetails = {
        name: suggestion.sourceName,
        brand: null,
        ean: null,
        unitCount: null,
        unitType: null,
        priceCents: null,
        pricePerKgCents: null,
        priceUnit: null,
        internalId: suggestion.sourceInternalId,
        url: suggestion.sourceUrl,
      };
    }
    
    // Get suggested product details
    const suggestedLatestPrice = suggestion.suggestedProduct?.prices?.[0] || null;
    const suggestedProductDetails = suggestion.suggestedProduct ? {
      id: suggestion.suggestedProduct.id,
      name: suggestion.suggestedProduct.name,
      brand: suggestion.suggestedProduct.brand,
      ean: suggestion.suggestedProduct.ean,
      category: suggestion.suggestedProduct.category,
      unitCount: suggestion.suggestedProduct.unitCount,
      unitType: suggestion.suggestedProduct.unitType,
      priceCents: suggestedLatestPrice?.priceCents || null,
      pricePerKgCents: suggestedLatestPrice?.pricePerKgCents || null,
      priceUnit: suggestedLatestPrice?.priceUnit || null,
    } : null;
    
    // Get approved product details if different from suggested
    let approvedProductDetails = null;
    if (suggestion.approvedProduct && suggestion.approvedProductId !== suggestion.suggestedProductId) {
      const approvedLatestPrice = suggestion.approvedProduct?.prices?.[0] || null;
      approvedProductDetails = {
        id: suggestion.approvedProduct.id,
        name: suggestion.approvedProduct.name,
        brand: suggestion.approvedProduct.brand,
        ean: suggestion.approvedProduct.ean,
        category: suggestion.approvedProduct.category,
        unitCount: suggestion.approvedProduct.unitCount,
        unitType: suggestion.approvedProduct.unitType,
        priceCents: approvedLatestPrice?.priceCents || null,
        pricePerKgCents: approvedLatestPrice?.pricePerKgCents || null,
        priceUnit: approvedLatestPrice?.priceUnit || null,
      };
    }
    
    res.json({
      id: suggestion.id,
      retailer: suggestion.retailer,
      confidence: suggestion.confidence,
      signals: suggestion.signals,
      status: suggestion.status,
      createdAt: suggestion.createdAt,
      updatedAt: suggestion.updatedAt,
      source: sourceDetails,
      suggestedProduct: suggestedProductDetails,
      approvedProduct: approvedProductDetails,
    });
  } catch (err) {
    console.error('Error fetching suggestion details:', err);
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
