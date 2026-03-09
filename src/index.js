require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const path = require('path');

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;

const PUBLIC_DIR = path.resolve(__dirname, '../public');
console.log('Serving static from:', PUBLIC_DIR);

app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

const productsRouter = require('./routes/products');
const scraperRouter = require('./routes/scraper');
const settingsRouter = require('./routes/settings');
const vpnRouter = require('./routes/vpn');
const categoriesRouter = require('./routes/categories');
const retailerAuchanRouter = require('./routes/retailer-auchan');
const retailerLidlRouter = require('./routes/retailer-lidl');
const tempProductsRouter = require('./routes/temp-products');

app.use('/api/products', productsRouter);
app.use('/api/scraper', scraperRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/vpn', vpnRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/retailers/auchan', retailerAuchanRouter);
app.use('/api/retailers/lidl', retailerLidlRouter);
app.use('/api/temp-products', tempProductsRouter);

app.get('/api/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', database: 'connected' });
  } catch (e) {
    res.json({ status: 'error', database: 'disconnected' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 ProductFinder running at http://localhost:${PORT}`);
});

process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
