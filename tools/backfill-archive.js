// Backfill script to create tweet replica archives for existing mentions
// Creates COMPLETE tweet replicas: metadata, HTML, manifest, and re-assigns ArNS

import 'dotenv/config';
import { TwitterApi } from 'twitter-api-v2';
import { ANT, ArweaveSigner } from '@ar.io/sdk';
import fs from 'fs';
import { createMentionArchive, buildMetadataObject, updateMentionArchive, uploadAndAssignArchiveIndex } from '../lib/archive.js';
import { uploadToArweave, uploadManifest, getTurboClient } from '../lib/arweave.js';
import { generateManifest } from '../lib/manifest.js';
import { getMediaUrls } from '../lib/media.js';
import { updateUndernameRecord } from '../lib/arns.js';
import { requireEnv, getJwkFromEnv } from '../lib/utils.js';

// ---------- config ----------
const LIMIT = parseInt(process.argv[2] || '5', 10);
console.log(`🔧 Backfill limit: ${LIMIT} mentions\n`);

// Twitter client
const twitter = new TwitterApi({
  appKey: process.env.TWITTER_APP_KEY,
  appSecret: process.env.TWITTER_APP_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
});

// Arweave/ArNS setup
const ANT_PROCESS_ID = requireEnv('ANT_PROCESS_ID');
const ROOT_ARNS_NAME = requireEnv('ROOT_ARNS_NAME');
const DEFAULT_TTL_SECONDS = parseInt(process.env.DEFAULT_TTL_SECONDS || '60', 10);
const TEMPLATE_HTML_TXID = requireEnv('TEMPLATE_HTML_TXID');
const jwk = getJwkFromEnv();
const signer = new ArweaveSigner(jwk);
const ant = ANT.init({ processId: ANT_PROCESS_ID, signer });
const turbo = getTurboClient(jwk);

// ---------- main ----------
async function backfillArchive() {
  try {
    console.log('📚 Starting archive backfill...\n');
    
    // Load processed mentions
    if (!fs.existsSync('processed_mentions.json')) {
      console.error('❌ processed_mentions.json not found');
      return;
    }
    
    const processedData = JSON.parse(fs.readFileSync('processed_mentions.json', 'utf8'));
    const processedDetails = processedData.processedDetails || {};
    
    // Get all successful mentions at once (more efficient than individual API calls)
    const successfulMentionIds = Object.entries(processedDetails)
      .filter(([id, details]) => details.success === true)
      .slice(0, LIMIT)
      .map(([id, details]) => ({ id, details }))
      .filter((mention, index, array) => 
        array.findIndex(m => m.id === mention.id) === index
      ); // Remove duplicates
    
    console.log(`📊 Found ${successfulMentionIds.length} successful mentions to backfill\n`);
    
    if (successfulMentionIds.length === 0) {
      console.log('❌ No successful mentions found to backfill');
      return;
    }
    
    // Fetch all tweet data in one API call using tweet lookup
    console.log('🔍 Fetching tweet data from Twitter...');
    const tweetIds = successfulMentionIds.map(({ id }) => id);
    const tweetResponse = await twitter.v2.tweets(tweetIds, {
      'tweet.fields': ['referenced_tweets', 'created_at', 'entities', 'text', 'author_id', 'attachments'],
      expansions: ['referenced_tweets.id', 'author_id', 'referenced_tweets.id.author_id', 'attachments.media_keys', 'referenced_tweets.id.attachments.media_keys'],
      'user.fields': ['username', 'name', 'verified'],
      'media.fields': ['type', 'url', 'preview_image_url', 'width', 'height', 'variants', 'alt_text']
    });
    
    if (!tweetResponse.data || tweetResponse.data.length === 0) {
      console.error('❌ No tweet data found');
      return;
    }
    
    console.log(`✅ Retrieved ${tweetResponse.data.length} tweets from API`);
    
    let processedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    
    for (const { id: mentionId, details } of successfulMentionIds) {
      try {
        console.log(`\n${'='.repeat(70)}`);
        console.log(`Processing mention ${processedCount + 1}/${successfulMentionIds.length}: ${mentionId}`);
        console.log(`Undername: ${details.undername}`);
        console.log(`Mention Username: ${details.mentionUsername || details.username || 'unknown'}`);
        
        // Find tweet data from API response
        const mention = tweetResponse.data.find(t => t.id === mentionId);
        if (!mention) {
          console.warn('⚠️  Tweet not found in API response, skipping...');
          skippedCount++;
          continue;
        }
        
        const includes = tweetResponse.includes || {};
        
        // Find parent tweet
        const replied = mention?.referenced_tweets?.find(t => t.type === 'replied_to');
        if (!replied) {
          console.warn('⚠️  No parent tweet found, skipping...');
          skippedCount++;
          continue;
        }
        
        const parent = includes?.tweets?.find(t => t.id === replied.id);
        if (!parent) {
          console.warn('⚠️  Parent tweet data not available, skipping...');
          skippedCount++;
          continue;
        }
        
        // Get user data - use the correct username from processed_mentions.json
        const mentionUser = includes?.users?.find(u => u.username === details.mentionUsername);
        const parentUser = includes?.users?.find(u => u.id === parent.author_id);
        
        // Detect media type properly from Twitter API response
        let mediaArray = [];
        if (details.isUploadedMedia) {
          // Media was uploaded - detect type from Twitter API
          const mediaUrls = await getMediaUrls(parent, includes);
          if (mediaUrls.length > 0) {
            // Use the detected type from Twitter API, but keep the existing txId
            mediaArray = mediaUrls.map((media, index) => ({
              index,
              type: media.type, // Use detected type (video, photo, animated_gif, etc.)
              txId: details.txId, // Keep existing txId (media already uploaded)
              alt_text: media.alt_text || ''
            }));
          } else {
            // Fallback: couldn't detect from API, assume photo
            mediaArray = [{
              index: 0,
              type: 'photo',
              txId: details.txId,
              alt_text: ''
            }];
          }
        } else {
          // Link to existing Arweave content
          mediaArray = [{
            index: 0,
            type: 'link',
            txId: details.txId,
            alt_text: 'Existing Arweave content'
          }];
        }
        
        // Build metadata object
        const metadataObj = buildMetadataObject(mention, parent, mentionUser, parentUser, mediaArray, includes);
        metadataObj.metadata.mentionId = mentionId;
        metadataObj.metadata.undername = details.undername;
        metadataObj.metadata.processedAt = details.timestamp;
        
        // Upload metadata.json
        console.log('📄 Uploading metadata.json...');
        const metadataTxId = await uploadToArweave(
          Buffer.from(JSON.stringify(metadataObj, null, 2)), 
          'application/json',
          'NeedsArNS-Metadata',
          jwk
        );
        console.log(`✅ Metadata uploaded: ${metadataTxId}`);
        
        // Use shared HTML template
        console.log('📄 Using shared HTML template...');
        const htmlTxId = TEMPLATE_HTML_TXID;
        
        // Create and upload manifest
        console.log('📦 Creating Arweave manifest...');
        const manifest = generateManifest(metadataTxId, mediaArray, htmlTxId);
        const manifestTxId = await uploadManifest(
          Buffer.from(JSON.stringify(manifest, null, 2)),
          jwk
        );
        console.log(`✅ Manifest uploaded: ${manifestTxId}`);
        
        // Update ArNS record to point to manifest
        console.log(`🔗 Updating ArNS: ${details.undername} → ${manifestTxId}`);
        const updateResult = await updateUndernameRecord(ant, details.undername, manifestTxId, DEFAULT_TTL_SECONDS);
        if (updateResult.success) {
          console.log(`✅ ArNS updated: ${updateResult.recordId}`);
          metadataObj.archive.arnsRecordId = updateResult.recordId;
        } else {
          console.warn(`⚠️ ArNS update failed (might already exist): ${updateResult.message}`);
        }
        
        // Update metadata object with final ArNS info
        metadataObj.archive.htmlTxId = htmlTxId;
        metadataObj.archive.manifestTxId = manifestTxId;
        metadataObj.archive.assignedAt = details.timestamp;
        
        // Save individual mention archive
        await createMentionArchive(metadataObj);
        
        console.log(`✅ Complete backfill: ${mentionId}`);
        console.log(`🌐 View at: https://${details.undername}_${ROOT_ARNS_NAME}.ar.io`);
        processedCount++;
        
        // No rate limiting needed - we fetched all tweets in one API call
        
      } catch (error) {
        console.error(`❌ Error processing ${mentionId}:`, error.message);
        errorCount++;
      }
    }
    
    // Upload and assign archive index at end of backfill
    if (processedCount > 0) {
      console.log('\n📤 Uploading archive index at end of backfill...');
      try {
        const indexResult = await uploadAndAssignArchiveIndex(ant, jwk, ROOT_ARNS_NAME, DEFAULT_TTL_SECONDS);
        if (indexResult.success) {
          console.log(`✅ Archive index updated: ${indexResult.txId}`);
        } else {
          console.warn(`⚠️ Archive index update failed (non-critical): ${indexResult.message || indexResult.error}`);
        }
      } catch (error) {
        console.warn(`⚠️ Archive index update error (non-critical): ${error.message}`);
      }
    }
    
    console.log(`\n${'='.repeat(70)}`);
    console.log('\n📊 Backfill Summary:');
    console.log(`✅ Processed: ${processedCount}`);
    console.log(`⏭️  Skipped: ${skippedCount}`);
    console.log(`❌ Errors: ${errorCount}`);
    console.log(`\n✨ Backfill complete!`);
    
  } catch (error) {
    console.error('❌ Backfill failed:', error);
    process.exit(1);
  }
}

// Run backfill
backfillArchive().then(() => {
  console.log('\n🎉 Done!');
  process.exit(0);
}).catch(error => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});

