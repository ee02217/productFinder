const express = require('express');
const { PrismaClient } = require('@prisma/client');

const router = express.Router();
const prisma = new PrismaClient();

// Get settings
router.get('/', async (req, res) => {
  try {
    let settings = await prisma.settings.findUnique({ where: { id: 'default' } });
    
    if (!settings) {
      settings = await prisma.settings.create({
        data: { id: 'default', delayMs: 2000 },
      });
    }
    
    res.json(settings);
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Update settings
router.put('/', async (req, res) => {
  try {
    const { delayMs } = req.body;
    
    const settings = await prisma.settings.upsert({
      where: { id: 'default' },
      create: { id: 'default', delayMs: delayMs || 2000 },
      update: { delayMs: delayMs || 2000 },
    });
    
    res.json(settings);
  } catch (error) {
    console.error('Error updating settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

module.exports = router;
