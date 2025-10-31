// Update template script to recreate existing post manifests with new template
// Uses archived data instead of re-polling Twitter - much more efficient!

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
console.log(`🔧 Template update limit: ${LIMIT} mentions`);
console.log(`🔧 Dry run mode: ${DRY_RUN}\n`);

// Arweave/ArNS setup
const ANT_PROCESS_ID = requireEnv('ANT_PROCESS_ID');
const ROOT_ARNS_NAME = requireEnv('ROOT_ARNS_NAME');
const DEFAULT_TTL_SECONDS = parseInt(process.env.DEFAULT_TTL_SECONDS || '60', 10);
const jwk = getJwkFromEnv();
const signer = new ArweaveSigner(jwk);
const ant = ANT.init({ processId: ANT_PROCESS_ID, signer });

// ---------- main ----------
async function updateTemplateFromArchive() {
  try {
    console.log('📚 Starting template update from archive...\n');
    
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
    
    // Upload new template (if not already done)
    console.log('📄 Uploading new template...');
    let newTemplateTxId;
    
    if (DRY_RUN) {
      newTemplateTxId = 'DRY_RUN_TEMPLATE_TXID';
      console.log(`🔍 DRY RUN: Would upload template -> ${newTemplateTxId}`);
    } else {
      const templateBuffer = fs.readFileSync('archive-templates/post-archive-template.html');
      newTemplateTxId = await uploadToArweave(
        templateBuffer,
        'text/html',
        'NeedsArNS-Template',
        jwk
      );
      console.log(`✅ New template uploaded: ${newTemplateTxId}`);
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
        
        // Extract existing data
        const mediaArray = mentionData.archive?.media || [];
        const existingMetadataTxId = mentionData.archive?.metadataTxId;
        
        if (!existingMetadataTxId) {
          console.warn('⚠️  No metadata TXID found, skipping...');
          skippedCount++;
          continue;
        }
        
        console.log(`📄 Using existing metadata: ${existingMetadataTxId}`);
        console.log(`🖼️  Media count: ${mediaArray.length}`);
        
        if (DRY_RUN) {
          console.log(`🔍 DRY RUN: Would create manifest with template ${newTemplateTxId}`);
          console.log(`🔍 DRY RUN: Would update ArNS: ${mention.undername} -> NEW_MANIFEST_TXID`);
          processedCount++;
          continue;
        }
        
        // Generate new manifest with new template
        console.log('📦 Creating new manifest...');
        const manifest = generateManifest(existingMetadataTxId, mediaArray, newTemplateTxId);
        const manifestTxId = await uploadManifest(
          Buffer.from(JSON.stringify(manifest, null, 2)),
          jwk
        );
        console.log(`✅ New manifest uploaded: ${manifestTxId}`);
        
        // Update ArNS record to point to new manifest
        console.log(`🔗 Updating ArNS: ${mention.undername} -> ${manifestTxId}`);
        const updateResult = await updateUndernameRecord(ant, mention.undername, manifestTxId, DEFAULT_TTL_SECONDS);
        
        if (updateResult.success) {
          console.log(`✅ ArNS updated: ${updateResult.recordId}`);
          
          // Update the mention data with new manifest info
          mentionData.archive.manifestTxId = manifestTxId;
          mentionData.archive.htmlTxId = newTemplateTxId;
          mentionData.archive.templateUpdatedAt = new Date().toISOString();
          
          // Save updated mention data
          fs.writeFileSync(mentionFilePath, JSON.stringify(mentionData, null, 2));
          console.log(`💾 Updated mention archive file`);
          
        } else {
          console.warn(`⚠️ ArNS update failed: ${updateResult.message}`);
          errorCount++;
          continue;
        }
        
        console.log(`✅ Template update complete: ${mention.undername}`);
        console.log(`🌐 View at: https://${mention.undername}_${ROOT_ARNS_NAME}.ar.io`);
        processedCount++;
        
        // Small delay to avoid overwhelming the network
        await new Promise(resolve => setTimeout(resolve, 1000));
        
      } catch (error) {
        console.error(`❌ Error processing ${mention.mentionId}:`, error.message);
        errorCount++;
      }
    }
    
    // Update archive index with new template info
    if (processedCount > 0 && !DRY_RUN) {
      console.log('\n📤 Updating archive index...');
      try {
        archiveIndex.metadata.lastUpdated = new Date().toISOString();
        archiveIndex.metadata.templateVersion = newTemplateTxId;
        archiveIndex.metadata.templateUpdatedAt = new Date().toISOString();
        
        fs.writeFileSync('archive/metadata/archive-index.json', JSON.stringify(archiveIndex, null, 2));
        console.log(`✅ Archive index updated with template version: ${newTemplateTxId}`);
      } catch (error) {
        console.warn(`⚠️ Archive index update failed (non-critical): ${error.message}`);
      }
    }
    
    console.log(`\n${'='.repeat(70)}`);
    console.log('\n📊 Template Update Summary:');
    console.log(`✅ Processed: ${processedCount}`);
    console.log(`⏭️  Skipped: ${skippedCount}`);
    console.log(`❌ Errors: ${errorCount}`);
    console.log(`🔧 Template TXID: ${newTemplateTxId}`);
    console.log(`\n✨ Template update complete!`);
    
  } catch (error) {
    console.error('❌ Template update failed:', error);
    process.exit(1);
  }
}

// Run template update
updateTemplateFromArchive().then(() => {
  console.log('\n🎉 Done!');
  process.exit(0);
}).catch(error => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
