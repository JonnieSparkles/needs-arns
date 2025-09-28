#!/usr/bin/env node

/**
 * Deploy homepage to Arweave using Turbo SDK
 * Usage: node deploy.js
 */

import { TurboFactory, ArweaveSigner } from '@ardrive/turbo-sdk';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load environment variables
import dotenv from 'dotenv';
dotenv.config();

async function deployHomepage() {
  try {
    console.log('🚀 Deploying homepage to Arweave...');
    
    // Initialize Turbo client
    const jwk = JSON.parse(process.env.ARWEAVE_WALLET_JSON);
    const turbo = TurboFactory.authenticated({ signer: new ArweaveSigner(jwk) });
    
    // Check balance
    const balance = await turbo.getBalance();
    console.log(`💰 Turbo balance: ${balance.winc} winc`);
    
    // Read HTML file
    const htmlPath = path.join(__dirname, 'index.html');
    const htmlContent = fs.readFileSync(htmlPath, 'utf8');
    
    // Replace placeholder with actual wallet address
    const botWalletAddress = process.env.WALLET_ADDRESS || 'Unknown';
    const finalHtml = htmlContent.replace('[BOT_WALLET_ADDRESS]', botWalletAddress);
    
    console.log(`📄 HTML file size: ${finalHtml.length} bytes`);
    console.log(`🤖 Bot wallet address: ${botWalletAddress}`);
    
    // Upload to Arweave
    const uploadResult = await turbo.uploadFile({
      fileStreamFactory: () => Buffer.from(finalHtml, 'utf8'),
      fileSizeFactory: () => finalHtml.length,
      dataItemOpts: {
        tags: [
          { name: 'Content-Type', value: 'text/html; charset=utf-8' },
          { name: 'App-Name', value: 'NeedsArNS-Bot' },
          { name: 'App-Version', value: '1.0.0' },
          { name: 'Title', value: 'NeedsArNS Bot Homepage' },
          { name: 'Description', value: 'Homepage for the NeedsArNS Twitter bot' }
        ]
      }
    });
    
    console.log(`✅ Homepage uploaded successfully!`);
    console.log(`🔗 Arweave TXID: ${uploadResult.id}`);
    console.log(`💸 Cost: ${uploadResult.winc} winc`);
    console.log(`🌐 View at: https://arweave.net/${uploadResult.id}`);
    console.log(`🏠 ArNS domain: needsarns.ar.io (once configured)`);
    
  } catch (error) {
    console.error('❌ Deployment failed:', error);
    process.exit(1);
  }
}

// Run deployment
deployHomepage();
