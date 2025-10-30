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

// ---------- upload functions ----------
export async function uploadToArweave(mediaBuffer, contentType = 'application/octet-stream', appName = 'NeedsArNS', jwk = null) {
  try {
    console.log(`☁️ Uploading ${(mediaBuffer.length / 1024).toFixed(1)}KB to Arweave...`);
    
    // Get Turbo client (requires jwk parameter)
    if (!jwk) {
      throw new Error('JWK required for Arweave upload');
    }
    const turbo = getTurboClient(jwk);
    
    // Check Turbo balance first
    const balance = await turbo.getBalance();
    
    // Generate tags from configuration
    const tags = generateMediaUploadTags(contentType, appName);
    
    // Upload file
    const uploadResult = await turbo.uploadFile({
      fileStreamFactory: () => Buffer.from(mediaBuffer),
      fileSizeFactory: () => mediaBuffer.length,
      dataItemOpts: {
        tags: tags
      }
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
    const turbo = getTurboClient(jwk);
    
    // Check Turbo balance first
    const balance = await turbo.getBalance();
    
    // Generate tags from configuration
    const tags = generateManifestUploadTags();
    
    // Upload manifest with proper tags
    const uploadResult = await turbo.uploadFile({
      fileStreamFactory: () => Buffer.from(manifestBuffer),
      fileSizeFactory: () => manifestBuffer.length,
      dataItemOpts: {
        tags: tags
      }
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
