// Arweave and Turbo SDK utilities

import { TurboFactory, ArweaveSigner as TurboArweaveSigner } from '@ardrive/turbo-sdk';
import { guessContentType } from './utils.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Get current directory for config file loading
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load upload tags configuration
let uploadTagsConfig = null;

function loadUploadTagsConfig() {
  if (!uploadTagsConfig) {
    try {
      const configPath = join(__dirname, '..', 'upload-tags.json');
      const configData = readFileSync(configPath, 'utf8');
      uploadTagsConfig = JSON.parse(configData);
    } catch (error) {
      console.warn('⚠️ Could not load upload-tags.json, using default tags:', error.message);
      // Fallback to default config
      uploadTagsConfig = {
        'App-Name': 'NeedsArNS-v1.0',
        'Title': 'ArNS Upload',
        'Description': 'Content uploaded via NeedsArNS Twitter bot for ArNS subdomain assignment'
      };
    }
  }
  return uploadTagsConfig;
}

// Load Turbo shared credits configuration
export function loadTurboConfig() {
  return {
    useSharedCredits: process.env.TURBO_USE_SHARED_CREDITS === 'true',
    sharedCreditsPaidBy: process.env.TURBO_SHARED_CREDITS_PAID_BY
      ? process.env.TURBO_SHARED_CREDITS_PAID_BY.split(',').map(addr => addr.trim())
      : []
  };
}

// Generate tags for media uploads
export function generateMediaUploadTags(contentType, customAppName = null) {
  const config = loadUploadTagsConfig();
  const tags = [
    { name: 'Content-Type', value: contentType }
  ];

  // Use upload-tags.json schema for all tags except Content-Type
  Object.entries(config).forEach(([key, value]) => {
    if (key === 'App-Name' && customAppName) {
      // Allow custom App-Name for media uploads
      tags.push({ name: key, value: customAppName });
    } else {
      tags.push({ name: key, value: value });
    }
  });

  return tags;
}

// Generate tags for manifest uploads
export function generateManifestUploadTags() {
  const config = loadUploadTagsConfig();
  const tags = [
    { name: 'Content-Type', value: 'application/x.arweave-manifest+json' }
  ];

  // Use upload-tags.json schema for all tags except Content-Type
  Object.entries(config).forEach(([key, value]) => {
    tags.push({ name: key, value: value });
  });

  return tags;
}

// ---------- turbo balance & shared credits helpers ----------

// Get Turbo balance with shared credits info
export async function getTurboBalanceWithShared(turbo) {
  const balance = await turbo.getBalance();
  // balance has: winc (native), receivedApprovals: [{ payingAddress, approvedWincAmount, usedWincAmount }]
  
  const nativeWinc = BigInt(balance.winc || 0);
  const sharedWinc = (balance.receivedApprovals || [])
    .reduce((sum, a) => {
      // Calculate remaining approved winc (approved - used)
      const approvedWinc = BigInt(a.approvedWincAmount || 0);
      const usedWinc = BigInt(a.usedWincAmount || 0);
      const remainingWinc = approvedWinc - usedWinc;
      return sum + remainingWinc;
    }, 0n);
  
  return {
    nativeWinc,
    sharedWinc,
    totalWinc: nativeWinc + sharedWinc,
    receivedApprovals: balance.receivedApprovals || []
  };
}

// Derive paidBy array based on config and balance
export function derivePaidBy(config, balance) {
  if (!config.useSharedCredits) {
    return undefined; // Use native balance only
  }
  
  if (config.sharedCreditsPaidBy.length > 0) {
    console.log(`🔗 Using shared credits from explicit addresses`);
    return config.sharedCreditsPaidBy;
  }
  
  if (balance.receivedApprovals.length > 0) {
    const paidBy = balance.receivedApprovals.map(a => a.payingAddress);
    console.log(`🔗 Using shared credits from ${paidBy.length} approval(s)`);
    return paidBy;
  }
  
  console.log(`🔗 No shared credits found - will use native balance`);
  return undefined;
}

// Estimate upload cost using Turbo SDK
export async function estimateUploadCostWinc(turbo, byteCount) {
  try {
    // turbo.getUploadCosts({ bytes }) returns [{ winc, adjustments }]
    const [{ winc }] = await turbo.getUploadCosts({ bytes: [byteCount] });
    return BigInt(winc);
  } catch (error) {
    console.warn(`⚠️ Could not estimate upload cost: ${error.message}`);
    return null; // Skip preflight if pricing unavailable
  }
}

// Assert sufficient credits or throw
export function assertSufficientCredits(estimatedWinc, balance) {
  if (estimatedWinc === null) {
    return; // Skip check if estimator unavailable
  }
  
  if (estimatedWinc > balance.totalWinc) {
    const shortfall = estimatedWinc - balance.totalWinc;
    console.error(`❌ INSUFFICIENT TURBO CREDITS`);
    console.error(`   Required: ${estimatedWinc} winc`);
    console.error(`   Available: ${balance.totalWinc} winc (${balance.nativeWinc} native + ${balance.sharedWinc} shared)`);
    console.error(`   Shortfall: ${shortfall} winc`);
    throw new Error('INSUFFICIENT_TURBO_CREDITS');
  }
}

// ---------- upload functions ----------
export async function uploadToArweave(mediaBuffer, contentType = 'application/octet-stream', appName = 'NeedsArNS', jwk = null) {
  try {
    console.log(`☁️ Uploading ${(mediaBuffer.length / 1024).toFixed(1)}KB to Arweave...`);
    
    // Get Turbo client (requires jwk parameter)
    if (!jwk) {
      throw new Error('JWK required for Arweave upload');
    }
    
    const config = loadTurboConfig();
    const turbo = getTurboClient(jwk);
    
    // Check balance (informational + shared credits discovery)
    const balance = await getTurboBalanceWithShared(turbo);
    
    // Estimate cost and validate
    const estimatedWinc = await estimateUploadCostWinc(turbo, mediaBuffer.length);
    assertSufficientCredits(estimatedWinc, balance);
    
    // Generate tags from configuration
    const tags = generateMediaUploadTags(contentType, appName);
    
    // Build dataItemOpts with paidBy if shared credits enabled
    const paidBy = derivePaidBy(config, balance);
    const dataItemOpts = {
      tags,
      ...(paidBy ? { paidBy } : {})
    };
    
    // Upload file
    const uploadResult = await turbo.uploadFile({
      fileStreamFactory: () => Buffer.from(mediaBuffer),
      fileSizeFactory: () => mediaBuffer.length,
      dataItemOpts
    });
    
    console.log(`✅ Uploaded: ${uploadResult.id} (${uploadResult.winc} winc)`);
    
    return uploadResult.id;
  } catch (error) {
    console.error(`❌ Arweave upload failed:`, error);
    throw error;
  }
}

export async function uploadManifest(manifestBuffer, jwk = null) {
  try {
    console.log(`☁️ Uploading manifest ${(manifestBuffer.length / 1024).toFixed(1)}KB to Arweave...`);
    
    // Get Turbo client (requires jwk parameter)
    if (!jwk) {
      throw new Error('JWK required for Arweave upload');
    }
    
    const config = loadTurboConfig();
    const turbo = getTurboClient(jwk);
    
    // Check balance (informational + shared credits discovery)
    const balance = await getTurboBalanceWithShared(turbo);
    
    // Estimate cost and validate
    const estimatedWinc = await estimateUploadCostWinc(turbo, manifestBuffer.length);
    assertSufficientCredits(estimatedWinc, balance);
    
    // Generate tags from configuration
    const tags = generateManifestUploadTags();
    
    // Build dataItemOpts with paidBy if shared credits enabled
    const paidBy = derivePaidBy(config, balance);
    const dataItemOpts = {
      tags,
      ...(paidBy ? { paidBy } : {})
    };
    
    // Upload manifest with proper tags
    const uploadResult = await turbo.uploadFile({
      fileStreamFactory: () => Buffer.from(manifestBuffer),
      fileSizeFactory: () => manifestBuffer.length,
      dataItemOpts
    });
    
    console.log(`✅ Manifest uploaded: ${uploadResult.id} (${uploadResult.winc} winc)`);
    
    return uploadResult.id;
  } catch (error) {
    console.error(`❌ Manifest upload failed:`, error);
    throw error;
  }
}

export async function downloadMedia(mediaUrl) {
  try {
    console.log(`📥 Downloading: ${mediaUrl.split('/').pop()}`);
    const response = await fetch(mediaUrl);
    
    if (!response.ok) {
      throw new Error(`Failed to download media: ${response.status} ${response.statusText}`);
    }
    
    const buffer = await response.arrayBuffer();
    console.log(`✅ Downloaded ${(buffer.byteLength / 1024).toFixed(1)}KB`);
    return Buffer.from(buffer);
  } catch (error) {
    console.error(`❌ Media download failed:`, error);
    throw error;
  }
}

export async function downloadBuffer(url) {
  const head = await fetch(url, { method: 'HEAD' }).catch(() => null);
  const contentType = head?.ok ? head.headers.get('content-type') : null;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  const arr = await res.arrayBuffer();
  return { buffer: Buffer.from(arr), contentType };
}

// ---------- turbo client factory ----------
let turboClient = null;

export function getTurboClient(jwk) {
  if (!turboClient) {
    turboClient = TurboFactory.authenticated({ 
      signer: new TurboArweaveSigner(jwk) 
    });
  }
  return turboClient;
}
