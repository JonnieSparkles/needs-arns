#!/usr/bin/env node

/**
 * Migration Script: Undername to Path-Based Routing
 *
 * This script migrates existing archive-index.json to the new mention-index.json format
 * and sets up the landing page with ArNS records.
 *
 * Usage:
 *   node tools/migrate-to-path-based.js [--dry-run] [--force]
 *
 * Options:
 *   --dry-run  Show what would happen without making changes
 *   --force    Skip confirmation prompts
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { ANT, ArweaveSigner } from '@ar.io/sdk';
import { requireEnv, getJwkFromEnv } from '../lib/utils.js';
import { uploadToArweave, uploadManifest } from '../lib/arweave.js';
import { createUndernameRecord, updateUndernameRecord } from '../lib/arns.js';

// Parse command line arguments
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');
const SKIP_LANDING = args.includes('--skip-landing');
const LANDING_TXID = args.find(a => a.startsWith('--landing-txid='))?.split('=')[1];

// Environment
const ROOT_ARNS_NAME = requireEnv('ROOT_ARNS_NAME');
const ANT_PROCESS_ID = requireEnv('ANT_PROCESS_ID');
const DEFAULT_TTL_SECONDS = parseInt(process.env.DEFAULT_TTL_SECONDS || '60', 10);

// Paths
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '.';
const OLD_INDEX_FILE = path.join(DATA_DIR, 'archive/metadata/archive-index.json');
const NEW_INDEX_FILE = path.join(DATA_DIR, 'archive/metadata/mention-index.json');
const LANDING_TEMPLATE = path.join(process.cwd(), 'archive-templates/needsarns/index.html');

async function confirm(message) {
  if (FORCE) return true;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(`${message} (y/N): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

function loadOldIndex() {
  if (!fs.existsSync(OLD_INDEX_FILE)) {
    console.log('No existing archive-index.json found, starting fresh');
    return null;
  }

  try {
    const data = JSON.parse(fs.readFileSync(OLD_INDEX_FILE, 'utf8'));
    console.log(`Loaded existing index: ${data.mentions?.length || 0} mentions`);
    return data;
  } catch (error) {
    console.error(`Error reading old index: ${error.message}`);
    return null;
  }
}

function loadExistingNewIndex() {
  if (!fs.existsSync(NEW_INDEX_FILE)) {
    return null;
  }

  try {
    const data = JSON.parse(fs.readFileSync(NEW_INDEX_FILE, 'utf8'));
    console.log(`  Found existing new index: ${data.posts?.length || 0} posts`);
    return data;
  } catch (error) {
    console.error(`  Error reading existing new index: ${error.message}`);
    return null;
  }
}

function convertToNewFormat(oldIndex) {
  // Load any existing new index entries (posts created after new code was deployed)
  const existingNewIndex = loadExistingNewIndex();
  const existingNewPosts = existingNewIndex?.posts || [];
  const existingPaths = new Set(existingNewPosts.map(p => p.path));
  const existingPostIds = new Set(existingNewPosts.map(p => p.postId));

  console.log(`  Preserving ${existingNewPosts.length} existing new posts`);

  const newIndex = {
    metadata: {
      lastUpdated: new Date().toISOString(),
      totalPosts: 0,
      indexVersion: '3.0.0',
      description: 'NeedsArNS Archive Index',
      rootArnsName: ROOT_ARNS_NAME,
      migratedAt: new Date().toISOString(),
      migratedFrom: 'archive-index.json v' + (oldIndex?.metadata?.indexVersion || '1.0')
    },
    posts: [...existingNewPosts] // Start with existing new posts
  };

  if (!oldIndex?.mentions || oldIndex.mentions.length === 0) {
    console.log('No legacy mentions to migrate');
    newIndex.metadata.totalPosts = newIndex.posts.length;
    return newIndex;
  }

  // Convert each legacy mention to a post entry (skip if already exists)
  let skipped = 0;
  for (const mention of oldIndex.mentions) {
    // Skip if this path or postId already exists in the new index
    if (existingPaths.has(mention.undername) || existingPostIds.has(mention.mentionId)) {
      skipped++;
      continue;
    }

    const post = {
      // Use undername as path for legacy entries
      path: mention.undername,
      postId: mention.mentionId, // Using mentionId as postId for legacy
      mentionId: mention.mentionId,
      mentionUsername: mention.mentionUsername || 'unknown',
      parentUsername: mention.parentUsername || mention.mentionUsername || 'unknown',
      text: '', // Legacy index doesn't have text preview
      createdAt: mention.processedAt,
      processedAt: mention.processedAt,
      manifestTxId: mention.manifestTxId,
      metadataTxId: null, // Legacy doesn't have separate metadata TXID
      mediaCount: mention.mediaCount || 0,
      hasVideo: false,
      isLegacyUndername: true // Mark as legacy for backward compatibility links
    };

    newIndex.posts.push(post);
  }

  if (skipped > 0) {
    console.log(`  Skipped ${skipped} entries already in new index`);
  }

  newIndex.metadata.totalPosts = newIndex.posts.length;
  return newIndex;
}

async function uploadLandingPage(jwk) {
  // Check if we should skip and use existing TXID
  if (SKIP_LANDING && LANDING_TXID) {
    console.log(`\nSkipping landing page upload, using existing: ${LANDING_TXID}`);
    return LANDING_TXID;
  }

  if (!fs.existsSync(LANDING_TEMPLATE)) {
    console.error(`Landing template not found: ${LANDING_TEMPLATE}`);
    return null;
  }

  console.log('\nUploading landing page template...');
  const templateContent = fs.readFileSync(LANDING_TEMPLATE, 'utf8');
  const templateBuffer = Buffer.from(templateContent);

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would upload landing template (${templateBuffer.length} bytes)`);
    return 'DRY_RUN_LANDING_TXID';
  }

  const txId = await uploadToArweave(templateBuffer, 'text/html', 'NeedsArNS-Landing', jwk);
  console.log(`  Uploaded landing template: ${txId}`);
  return txId;
}

async function uploadIndex(newIndex, jwk) {
  console.log('\nUploading mention index...');
  const indexBuffer = Buffer.from(JSON.stringify(newIndex, null, 2));

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would upload index (${indexBuffer.length} bytes, ${newIndex.posts.length} posts)`);
    return 'DRY_RUN_INDEX_TXID';
  }

  const txId = await uploadToArweave(indexBuffer, 'application/json', 'NeedsArNS-MentionIndex', jwk);
  console.log(`  Uploaded mention index: ${txId}`);
  return txId;
}

async function createLandingManifest(landingTxId, indexTxId, jwk) {
  console.log('\nCreating landing page manifest...');

  const manifest = {
    manifest: 'arweave/paths',
    version: '0.2.0',
    index: { path: 'index.html' },
    fallback: { id: landingTxId },
    paths: {
      'index.html': { id: landingTxId },
      'index.json': { id: indexTxId }
    }
  };

  const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2));

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would upload manifest (${manifestBuffer.length} bytes)`);
    console.log('  Manifest contents:');
    console.log(JSON.stringify(manifest, null, 2));
    return 'DRY_RUN_MANIFEST_TXID';
  }

  const txId = await uploadManifest(manifestBuffer, jwk);
  console.log(`  Uploaded landing manifest: ${txId}`);
  return txId;
}

async function setupArnsRecords(ant, manifestTxId, indexTxId) {
  console.log('\nSetting up ArNS records...');

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would create/update root record: ${ROOT_ARNS_NAME}.ar.io -> ${manifestTxId}`);
    console.log(`  [DRY RUN] Would create/update index record: index_${ROOT_ARNS_NAME}.ar.io -> ${indexTxId}`);
    return { success: true };
  }

  // Create/update root record (@ for root)
  console.log(`  Setting root record: ${ROOT_ARNS_NAME}.ar.io -> ${manifestTxId}`);
  try {
    const rootResult = await updateUndernameRecord(ant, '@', manifestTxId, DEFAULT_TTL_SECONDS);
    if (!rootResult.success) {
      console.log('  Root update failed, trying to create...');
      const createResult = await createUndernameRecord(ant, '@', manifestTxId, DEFAULT_TTL_SECONDS);
      if (!createResult.success) {
        console.warn(`  Warning: Could not set root record: ${createResult.message}`);
        console.warn(`  You may need to manually set the root record.`);
      }
    }
  } catch (error) {
    console.warn(`  Warning: Root record error: ${error.message}`);
  }

  // Create/update index record
  console.log(`  Setting index record: index_${ROOT_ARNS_NAME}.ar.io -> ${indexTxId}`);
  try {
    const indexResult = await updateUndernameRecord(ant, 'index', indexTxId, DEFAULT_TTL_SECONDS);
    if (!indexResult.success) {
      console.log('  Index update failed, trying to create...');
      const createResult = await createUndernameRecord(ant, 'index', indexTxId, DEFAULT_TTL_SECONDS);
      if (!createResult.success) {
        console.error(`  Error: Could not set index record: ${createResult.message}`);
        return { success: false, error: createResult.message };
      }
    }
  } catch (error) {
    console.error(`  Error setting index record: ${error.message}`);
    return { success: false, error: error.message };
  }

  console.log('  ArNS records configured successfully');
  return { success: true };
}

function saveNewIndex(newIndex) {
  if (DRY_RUN) {
    console.log(`\n[DRY RUN] Would save new index to: ${NEW_INDEX_FILE}`);
    return;
  }

  // Ensure directory exists
  const dir = path.dirname(NEW_INDEX_FILE);
  fs.mkdirSync(dir, { recursive: true });

  // Save new index
  fs.writeFileSync(NEW_INDEX_FILE, JSON.stringify(newIndex, null, 2));
  console.log(`\nSaved new index to: ${NEW_INDEX_FILE}`);
}

async function main() {
  console.log('='.repeat(60));
  console.log('NeedsArNS Migration: Undername to Path-Based Routing');
  console.log('='.repeat(60));

  if (DRY_RUN) {
    console.log('\n*** DRY RUN MODE - No changes will be made ***\n');
  }

  // Load wallet
  console.log('Loading wallet...');
  const jwk = getJwkFromEnv();
  console.log('  Wallet loaded');

  // Initialize ANT
  console.log(`Initializing ANT (${ANT_PROCESS_ID})...`);
  const ant = ANT.init({
    signer: new ArweaveSigner(jwk),
    processId: ANT_PROCESS_ID
  });
  console.log('  ANT initialized');

  // Load old index
  console.log('\nLoading existing archive index...');
  const oldIndex = loadOldIndex();

  // Convert to new format
  console.log('\nConverting to new format...');
  const newIndex = convertToNewFormat(oldIndex);
  console.log(`  Converted ${newIndex.posts.length} posts`);

  // Show summary
  console.log('\n' + '-'.repeat(60));
  console.log('Migration Summary:');
  console.log('-'.repeat(60));
  console.log(`  Total posts to migrate: ${newIndex.posts.length}`);
  console.log(`  Root ArNS name: ${ROOT_ARNS_NAME}`);
  console.log(`  ANT Process ID: ${ANT_PROCESS_ID}`);
  console.log(`  Index version: ${newIndex.metadata.indexVersion}`);
  if (newIndex.posts.length > 0) {
    console.log('\n  Sample entries:');
    newIndex.posts.slice(0, 3).forEach((p, i) => {
      console.log(`    ${i + 1}. path='${p.path}' by @${p.mentionUsername} (legacy=${p.isLegacyUndername})`);
    });
    if (newIndex.posts.length > 3) {
      console.log(`    ... and ${newIndex.posts.length - 3} more`);
    }
  }
  console.log('-'.repeat(60));

  // Confirm migration
  if (!await confirm('\nProceed with migration?')) {
    console.log('Migration cancelled.');
    process.exit(0);
  }

  try {
    // Step 1: Upload landing page
    const landingTxId = await uploadLandingPage(jwk);
    if (!landingTxId) {
      throw new Error('Failed to upload landing page');
    }

    // Step 2: Upload index
    const indexTxId = await uploadIndex(newIndex, jwk);
    if (!indexTxId) {
      throw new Error('Failed to upload index');
    }

    // Step 3: Create landing manifest
    const manifestTxId = await createLandingManifest(landingTxId, indexTxId, jwk);
    if (!manifestTxId) {
      throw new Error('Failed to create manifest');
    }

    // Step 4: Set up ArNS records
    const arnsResult = await setupArnsRecords(ant, manifestTxId, indexTxId);
    if (!arnsResult.success) {
      console.warn('\nWarning: ArNS record setup had issues. You may need to configure manually.');
    }

    // Step 5: Save new index locally
    saveNewIndex(newIndex);

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('Migration Complete!');
    console.log('='.repeat(60));
    console.log(`\nLanding page: https://${ROOT_ARNS_NAME}.ar.io`);
    console.log(`Index URL: https://index_${ROOT_ARNS_NAME}.ar.io`);
    console.log(`\nTXIDs:`);
    console.log(`  Landing template: ${landingTxId}`);
    console.log(`  Index JSON: ${indexTxId}`);
    console.log(`  Landing manifest: ${manifestTxId}`);
    console.log(`\nNext steps:`);
    console.log(`  1. Verify the landing page loads: https://${ROOT_ARNS_NAME}.ar.io`);
    console.log(`  2. Test hash routing: https://${ROOT_ARNS_NAME}.ar.io/#/test-path`);
    console.log(`  3. Set MENTION_LANDING_TXID=${landingTxId} in .env (for reference)`);
    console.log(`\nExisting undername archives will continue to work at:`);
    console.log(`  https://{undername}_${ROOT_ARNS_NAME}.ar.io`);

  } catch (error) {
    console.error(`\nMigration failed: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
