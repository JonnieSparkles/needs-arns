// Recreate post manifests from archived data without re-polling Twitter
// This script reads from your existing archive and creates fresh manifests

import 'dotenv/config';
import { ANT, ArweaveSigner } from '@ar.io/sdk';
import fs from 'fs';
import { generateManifest } from '../lib/manifest.js';
import { uploadToArweave, uploadManifest } from '../lib/arweave.js';
import { updateUndernameRecord } from '../lib/arns.js';
import { requireEnv, getJwkFromEnv } from '../lib/utils.js';

// ---------- config ----------
const LIMIT = parseInt(process.argv[2] || '5', 10);
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE_RECREATE = process.argv.includes('--force');
console.log(`🔧 Recreate limit: ${LIMIT} mentions`);
console.log(`🔧 Dry run mode: ${DRY_RUN}`);
console.log(`🔧 Force recreate: ${FORCE_RECREATE}\n`);

// Arweave/ArNS setup
const ANT_PROCESS_ID = requireEnv('ANT_PROCESS_ID');
const ROOT_ARNS_NAME = requireEnv('ROOT_ARNS_NAME');
const DEFAULT_TTL_SECONDS = parseInt(process.env.DEFAULT_TTL_SECONDS || '60', 10);
const TEMPLATE_HTML_TXID = requireEnv('TEMPLATE_HTML_TXID');
const jwk = getJwkFromEnv();
const signer = new ArweaveSigner(jwk);
const ant = ANT.init({ processId: ANT_PROCESS_ID, signer });

// ---------- main ----------
async function recreateManifestsFromArchive() {
  try {
    console.log('📚 Starting manifest recreation from archive...\n');
    
    // Load archive index
    if (!fs.existsSync('archive/metadata/archive-index.json')) {
      console.error('❌ archive/metadata/archive-index.json not found');
      return;
    }
    
    const archiveIndex = JSON.parse(fs.readFileSync('archive/metadata/archive-index.json', 'utf8'));
    const mentions = archiveIndex.mentions || [];
    
    console.log(`📊 Found ${mentions.length} mentions in archive`);
    
    if (mentions.length === 0) {
      console.log('❌ No mentions found in archive');
      return;
    }
    
    // Process mentions
    const mentionsToProcess = mentions.slice(0, LIMIT);
    console.log(`\n🔄 Processing ${mentionsToProcess.length} mentions...\n`);
    
    let processedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    
    for (const mention of mentionsToProcess) {
      try {
        console.log(`\n${'='.repeat(70)}`);
        console.log(`Processing mention ${processedCount + 1}/${mentionsToProcess.length}: ${mention.mentionId}`);
        console.log(`Undername: ${mention.undername}`);
        console.log(`Current manifest: ${mention.manifestTxId}`);
        
        // Load individual mention data
        const mentionFilePath = `archive/mentions/${mention.mentionId}.json`;
        if (!fs.existsSync(mentionFilePath)) {
          console.warn('⚠️  Mention file not found, skipping...');
          skippedCount++;
          continue;
        }
        
        const mentionData = JSON.parse(fs.readFileSync(mentionFilePath, 'utf8'));
        
        // Check if already has manifest (unless force recreate)
        if (mentionData.archive?.manifestTxId && !FORCE_RECREATE) {
          console.log('⏭️  Already has manifest, skipping...');
          skippedCount++;
          continue;
        }
        
        // Extract data from archive
        const mediaArray = mentionData.archive?.media || [];
        const rawApiResponse = mentionData.rawApiResponse;
        
        if (!rawApiResponse) {
          console.warn('⚠️  No raw API response found, skipping...');
          skippedCount++;
          continue;
        }
        
        console.log(`📄 Raw API data available from: ${rawApiResponse.fetchedAt}`);
        console.log(`🖼️  Media count: ${mediaArray.length}`);
        
        if (DRY_RUN) {
          console.log(`🔍 DRY RUN: Would recreate manifest for ${mention.undername}`);
          console.log(`🔍 DRY RUN: Would use template: ${TEMPLATE_HTML_TXID}`);
          processedCount++;
          continue;
        }
        
        // Upload fresh metadata.json (using archived data)
        console.log('📄 Uploading fresh metadata.json...');
        const metadataTxId = await uploadToArweave(
          Buffer.from(JSON.stringify(mentionData, null, 2)),
          'application/json',
          'NeedsArNS-Metadata',
          jwk
        );
        console.log(`✅ Metadata uploaded: ${metadataTxId}`);
        
        // Generate new manifest
        console.log('📦 Creating new manifest...');
        const manifest = generateManifest(metadataTxId, mediaArray, TEMPLATE_HTML_TXID);
        const manifestTxId = await uploadManifest(
          Buffer.from(JSON.stringify(manifest, null, 2)),
          jwk
        );
        console.log(`✅ Manifest uploaded: ${manifestTxId}`);
        
        // Update ArNS record to point to new manifest
        console.log(`🔗 Updating ArNS: ${mention.undername} -> ${manifestTxId}`);
        const updateResult = await updateUndernameRecord(ant, mention.undername, manifestTxId, DEFAULT_TTL_SECONDS);
        
        if (updateResult.success) {
          console.log(`✅ ArNS updated: ${updateResult.recordId}`);
          
          // Update the mention data with new manifest info
          mentionData.archive.metadataTxId = metadataTxId;
          mentionData.archive.manifestTxId = manifestTxId;
          mentionData.archive.htmlTxId = TEMPLATE_HTML_TXID;
          mentionData.archive.recreatedAt = new Date().toISOString();
          
          // Save updated mention data
          fs.writeFileSync(mentionFilePath, JSON.stringify(mentionData, null, 2));
          console.log(`💾 Updated mention archive file`);
          
        } else {
          console.warn(`⚠️ ArNS update failed: ${updateResult.message}`);
          errorCount++;
          continue;
        }
        
        console.log(`✅ Manifest recreation complete: ${mention.undername}`);
        console.log(`🌐 View at: https://${mention.undername}_${ROOT_ARNS_NAME}.ar.io`);
        processedCount++;
        
        // Small delay to avoid overwhelming the network
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        console.error(`❌ Error processing ${mention.mentionId}:`, error.message);
        errorCount++;
      }
    }
    
    // Update archive index
    if (processedCount > 0 && !DRY_RUN) {
      console.log('\n📤 Updating archive index...');
      try {
        archiveIndex.metadata.lastUpdated = new Date().toISOString();
        archiveIndex.metadata.recreatedAt = new Date().toISOString();
        
        fs.writeFileSync('archive/metadata/archive-index.json', JSON.stringify(archiveIndex, null, 2));
        console.log(`✅ Archive index updated`);
      } catch (error) {
        console.warn(`⚠️ Archive index update failed (non-critical): ${error.message}`);
      }
    }
    
    console.log(`\n${'='.repeat(70)}`);
    console.log('\n📊 Manifest Recreation Summary:');
    console.log(`✅ Processed: ${processedCount}`);
    console.log(`⏭️  Skipped: ${skippedCount}`);
    console.log(`❌ Errors: ${errorCount}`);
    console.log(`\n✨ Manifest recreation complete!`);
    
  } catch (error) {
    console.error('❌ Manifest recreation failed:', error);
    process.exit(1);
  }
}

// Run manifest recreation
recreateManifestsFromArchive().then(() => {
  console.log('\n🎉 Done!');
  process.exit(0);
}).catch(error => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
