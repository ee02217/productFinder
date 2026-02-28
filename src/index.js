require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const path = require('path');

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;

// Fix path - __dirname is /app/src but public is at /app/public
const PUBLIC_DIR = path.resolve(__dirname, '../public');

console.log('Serving static from:', PUBLIC_DIR);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// Import routes
const productsRouter = require('./routes/products');
const scraperRouter = require('./routes/scraper');
const settingsRouter = require('./routes/settings');
const vpnRouter = require('./routes/vpn');

// API Routes
app.use('/api/products', productsRouter);
app.use('/api/scraper', scraperRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/vpn', vpnRouter);

// Health check
app.get('/api/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', database: 'connected' });
  } catch (e) {
    res.json({ status: 'error', database: 'disconnected' });
  }
});

// Serve admin GUI
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 ProductFinder running at http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
