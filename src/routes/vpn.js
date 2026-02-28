const express = require('express');
const { PrismaClient } = require('@prisma/client');
const { exec } = require('child_process');

const router = express.Router();
const prisma = new PrismaClient();

// Get VPN status
router.get('/status', (req, res) => {
  // Check if tun0 interface exists (VPN tunnel)
  exec('ip addr show tun0 2>/dev/null', (error, stdout, stderr) => {
    const isVpnConnected = stdout.includes('inet') && stdout.includes('10.243.');
    
    // Get external IP through VPN tunnel using --.Interface=tun0
    const getIpCmd = 'curl -s --max-time 5 --interface tun0 https://api.ipify.org 2>/dev/null';
    
    exec(getIpCmd, (err, ipOut, stderr) => {
      const ip = (ipOut.trim() || '');
      
      res.json({
        isConnected: isVpnConnected,
        ip: isVpnConnected && ip ? ip : (isVpnConnected ? 'Routing through VPN' : 'Not connected'),
        lastChecked: new Date().toISOString(),
      });
    });
  });
});

module.exports = router;
