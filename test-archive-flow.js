// Test script for full archiving flow (without Twitter posting)
// Usage: node test-archive-flow.js <twitter-post-url> [undername]

import 'dotenv/config';
import { TwitterApi } from 'twitter-api-v2';
import { ANT, ArweaveSigner } from '@ar.io/sdk';
import { getJwkFromEnv, requireEnv, verifyTxIdExists } from './lib/utils.js';
import { extractTxIdFromTweetData, hasMediaAttachments, processMediaFromTweet } from './lib/media.js';
import { uploadToArweave, uploadManifest, getTurboClient } from './lib/arweave.js';
import { generateManifest } from './lib/manifest.js';
import { buildMetadataObject, createMentionArchive } from './lib/archive.js';
import { checkUndernameAvailability } from './lib/arns.js';

// ---------- config ----------
const allArgs = process.argv.slice(2);
const URLs = allArgs.filter(arg => arg.startsWith('http') || arg.includes('x.com') || arg.includes('twitter.com'));

// Find prefix - must be a non-URL that doesn't look like a file path
const potentialPrefix = allArgs.find(arg => 
  !arg.startsWith('http') && 
  !arg.includes('x.com') && 
  !arg.includes('twitter.com') && 
  !arg.includes('node') && 
  !arg.includes('.js') &&
  !arg.includes('.exe') &&
  !arg.includes('\\') &&
  !arg.includes('/') &&
  arg.length < 50  // Reasonable prefix length
);

const UNDERNAME_PREFIX = potentialPrefix || 'test';

if (URLs.length === 0) {
  console.error('❌ Usage: node test-archive-flow.js <twitter-post-url-1> [twitter-post-url-2] [twitter-post-url-3] [undername-prefix]');
  console.error('   Example: node test-archive-flow.js "https://x.com/user/status/123" "https://x.com/user/status/456" "https://x.com/user/status/789"');
  console.error('   Example: node test-archive-flow.js "https://x.com/user/status/123" "my-test"');
  process.exit(1);
}

console.log(`📋 Testing ${URLs.length} tweet(s) with prefix: ${UNDERNAME_PREFIX}\n`);

// Extract tweet ID from URL
function extractTweetId(url) {
  // Match patterns like:
  // - https://x.com/user/status/123456
  // - https://twitter.com/user/status/123456
  // - x.com/user/status/123456
  const match = url.match(/\/(?:status|statuses)\/(\d+)/);
  if (!match) {
    throw new Error(`Could not extract tweet ID from URL: ${url}`);
  }
  return match[1];
}

// ---------- setup ----------
const TWITTER_APP_KEY = requireEnv('TWITTER_APP_KEY');
const TWITTER_APP_SECRET = requireEnv('TWITTER_APP_SECRET');
const TWITTER_ACCESS_TOKEN = requireEnv('TWITTER_ACCESS_TOKEN');
const TWITTER_ACCESS_SECRET = requireEnv('TWITTER_ACCESS_SECRET');

const ANT_PROCESS_ID = requireEnv('ANT_PROCESS_ID');
const OWNER_ARNS_NAME = requireEnv('OWNER_ARNS_NAME');
const DEFAULT_TTL_SECONDS = parseInt(process.env.DEFAULT_TTL_SECONDS || '60', 10);
const TEMPLATE_HTML_TXID = requireEnv('TEMPLATE_HTML_TXID');

const twitter = new TwitterApi({
  appKey: TWITTER_APP_KEY,
  appSecret: TWITTER_APP_SECRET,
  accessToken: TWITTER_ACCESS_TOKEN,
  accessSecret: TWITTER_ACCESS_SECRET,
});

const jwk = getJwkFromEnv();
const signer = new ArweaveSigner(jwk);
const ant = ANT.init({ processId: ANT_PROCESS_ID, signer });
const turbo = getTurboClient(jwk);

// ---------- main flow ----------
async function testArchiveFlowForTweet(tweet, includes, twitterUrl, undername, index, total) {
  try {
    console.log('\n' + '═'.repeat(70));
    console.log(`🧪 TEST ${index}/${total}: ${undername}`);
    console.log('═'.repeat(70));
    console.log(`📋 Input URL: ${twitterUrl}`);
    console.log(`📋 Tweet ID: ${tweet.id}\n`);
    
    console.log(`✅ Tweet loaded: "${tweet.text?.substring(0, 50)}..."\n`);
    
    // Determine if this is a reply or parent tweet
    let parentTweet = tweet;
    let parentUser = includes?.users?.find(u => u.id === tweet.author_id);
    let mentionTweet = null;
    let mentionUser = null;
    
    // Check if this tweet is a reply
    const repliedTo = tweet?.referenced_tweets?.find(t => t.type === 'replied_to');
    if (repliedTo) {
      // This is a reply, get the parent
      const parent = includes?.tweets?.find(t => t.id === repliedTo.id);
      if (parent) {
        mentionTweet = tweet;
        mentionUser = includes?.users?.find(u => u.id === tweet.author_id);
        parentTweet = parent;
        parentUser = includes?.users?.find(u => u.id === parent.author_id);
        console.log(`📝 This is a reply to tweet ${parent.id}`);
      }
    }
    
    console.log(`👤 Parent author: @${parentUser?.username || 'unknown'}`);
    if (mentionTweet) {
      console.log(`👤 Mention author: @${mentionUser?.username || 'unknown'}`);
    }
    console.log('');
    
    // Check Arweave link or media
    let mediaArray = [];
    let isUploadedMedia = false;
    let existingTxId = extractTxIdFromTweetData(parentTweet);
    
    if (existingTxId) {
      console.log(`🔗 Found Arweave TXID in tweet: ${existingTxId}`);
      const ok = await verifyTxIdExists(existingTxId);
      if (!ok) {
        throw new Error(`TXID verification failed: ${existingTxId}`);
      }
      console.log(`✅ TXID verified\n`);
      
      mediaArray = [{
        type: 'link',
        txId: existingTxId,
        alt_text: 'Existing Arweave content',
        index: 0
      }];
    } else if (hasMediaAttachments(parentTweet)) {
      console.log(`📱 No Arweave link found, processing media attachments...`);
      
      const mediaResult = await processMediaFromTweet(parentTweet, includes, (buffer, contentType) => 
        uploadToArweave(buffer, contentType, 'NeedsArNS-Test', jwk)
      );
      
      if (!mediaResult.success) {
        throw new Error(`Media processing failed: ${mediaResult.error}`);
      }
      
      mediaArray = mediaResult.media;
      isUploadedMedia = true;
      console.log(`✅ Processed ${mediaArray.length} media file(s)\n`);
      
      // Show media details
      mediaArray.forEach((media, i) => {
        console.log(`   Media ${i + 1}:`);
        console.log(`     Type: ${media.type}`);
        console.log(`     TXID: ${media.txId}`);
        if (media.alt_text) console.log(`     Alt: ${media.alt_text}`);
      });
      console.log('');
    } else {
      throw new Error('No Arweave link or media found in tweet');
    }
    
    // Check undername availability (optional, skip for testing if fails)
    console.log(`🔍 Checking undername availability: ${undername}`);
    const availability = await checkUndernameAvailability(ant, undername);
    if (!availability.available) {
      console.log(`⚠️  Warning: Undername '${undername}' is not available`);
      console.log(`   Continuing anyway for testing...\n`);
    } else {
      console.log(`✅ Undername available\n`);
    }
    
    // Build metadata object
    console.log('📦 Building metadata object...');
    const mentionForMetadata = mentionTweet || parentTweet;
    const metadataObj = buildMetadataObject(mentionForMetadata, parentTweet, mentionUser || parentUser, parentUser, mediaArray, includes);
    metadataObj.metadata.mentionId = mentionForMetadata.id;
    metadataObj.metadata.undername = undername;
    metadataObj.metadata.processedAt = new Date().toISOString();
    console.log('✅ Metadata object created\n');
    
    // Upload metadata.json
    console.log('📄 Uploading metadata.json to Arweave...');
    const metadataTxId = await uploadToArweave(
      Buffer.from(JSON.stringify(metadataObj, null, 2)), 
      'application/json',
      'NeedsArNS-Metadata',
      jwk
    );
    console.log(`✅ Metadata uploaded: ${metadataTxId}\n`);
    
    // Use shared HTML template
    console.log(`📄 Using shared HTML template: ${TEMPLATE_HTML_TXID}`);
    const htmlTxId = TEMPLATE_HTML_TXID;
    
    // Create and upload manifest
    console.log('📦 Creating Arweave manifest...');
    const manifest = generateManifest(metadataTxId, mediaArray, htmlTxId);
    const manifestTxId = await uploadManifest(
      Buffer.from(JSON.stringify(manifest, null, 2)),
      'NeedsArNS-Manifest',
      jwk
    );
    console.log(`✅ Manifest uploaded: ${manifestTxId}\n`);
    
    // Update metadata with archive info
    metadataObj.archive.htmlTxId = htmlTxId;
    metadataObj.archive.manifestTxId = manifestTxId;
    metadataObj.archive.assignedAt = new Date().toISOString();
    
    // Save to local archive
    console.log('💾 Saving to local archive...');
    const archiveFile = await createMentionArchive(metadataObj);
    if (archiveFile) {
      console.log(`✅ Archive saved: ${archiveFile}\n`);
    }
    
    // Summary
    const result = {
      success: true,
      undername,
      tweetId: parentTweet.id,
      author: parentUser?.username,
      mediaCount: mediaArray.length,
      isUploadedMedia,
      mediaTxIds: isUploadedMedia ? mediaArray.map(m => ({ type: m.type, txId: m.txId })) : [],
      metadataTxId,
      htmlTxId,
      manifestTxId,
      archiveFile,
      arnsUrl: `https://${undername}_${OWNER_ARNS_NAME}.ar.io`
    };
    
    console.log('\n✅ TEST COMPLETE!');
    console.log(`📊 Summary:`);
    console.log(`   Undername: ${undername}`);
    console.log(`   Tweet ID: ${parentTweet.id}`);
    console.log(`   Author: @${parentUser?.username}`);
    console.log(`   Media Count: ${mediaArray.length}`);
    console.log(`   Media Uploaded: ${isUploadedMedia ? 'Yes' : 'No (existing link)'}`);
    console.log(`   Manifest: ${manifestTxId}`);
    console.log(`🌐 View at: ${result.arnsUrl}`);
    
    return result;
    
  } catch (error) {
    console.error(`\n❌ Test ${index} failed:`, error.message);
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    return {
      success: false,
      undername,
      error: error.message,
      url: twitterUrl
    };
  }
}

async function testArchiveFlow() {
  const results = [];
  
  // Step 1: Extract all tweet IDs from URLs
  console.log('🔍 Extracting tweet IDs from URLs...');
  const tweetIdsAndUrls = URLs.map(url => ({
    url,
    tweetId: extractTweetId(url)
  }));
  
  const tweetIds = tweetIdsAndUrls.map(item => item.tweetId);
  console.log(`✅ Extracted ${tweetIds.length} tweet ID(s): ${tweetIds.join(', ')}\n`);
  
  // Step 2: Fetch all tweets in ONE API call
  console.log('🔍 Fetching all tweets from Twitter (single batch request)...');
  const tweetResponse = await twitter.v2.tweets(tweetIds, {
    'tweet.fields': ['referenced_tweets', 'created_at', 'entities', 'text', 'author_id', 'attachments'],
    expansions: ['referenced_tweets.id', 'author_id', 'referenced_tweets.id.author_id', 'attachments.media_keys', 'referenced_tweets.id.attachments.media_keys'],
    'user.fields': ['username', 'name', 'verified'],
    'media.fields': ['type', 'url', 'width', 'height', 'alt_text', 'variants', 'preview_image_url']
  });
  
  if (!tweetResponse.data || tweetResponse.data.length === 0) {
    throw new Error('No tweets found');
  }
  
  console.log(`✅ Retrieved ${tweetResponse.data.length} tweet(s) from API\n`);
  const includes = tweetResponse.includes || {};
  
  // Step 3: Process each tweet
  for (let i = 0; i < URLs.length; i++) {
    const urlItem = tweetIdsAndUrls[i];
    const undername = `${UNDERNAME_PREFIX}-${i + 1}`;
    
    // Find the tweet data for this URL
    const tweet = tweetResponse.data.find(t => t.id === urlItem.tweetId);
    if (!tweet) {
      console.error(`\n⚠️  Tweet ${urlItem.tweetId} not found in API response`);
      results.push({
        success: false,
        undername,
        error: 'Tweet not found in API response',
        url: urlItem.url
      });
      continue;
    }
    
    const result = await testArchiveFlowForTweet(tweet, includes, urlItem.url, undername, i + 1, URLs.length);
    results.push(result);
  }
  
  // Final summary
  console.log('\n\n' + '═'.repeat(70));
  console.log('📊 FINAL SUMMARY');
  console.log('═'.repeat(70));
  
  const successful = results.filter(r => r.success);
  const failed = results.filter(r => !r.success);
  
  console.log(`\n✅ Successful: ${successful.length}/${results.length}`);
  successful.forEach((r, i) => {
    console.log(`\n   ${i + 1}. ${r.undername}`);
    console.log(`      Tweet: ${r.tweetId}`);
    console.log(`      Author: @${r.author}`);
    console.log(`      Media: ${r.mediaCount} (${r.isUploadedMedia ? 'uploaded' : 'existing link'})`);
    console.log(`      Manifest: ${r.manifestTxId}`);
    console.log(`      🌐 ${r.arnsUrl}`);
  });
  
  if (failed.length > 0) {
    console.log(`\n❌ Failed: ${failed.length}/${results.length}`);
    failed.forEach((r, i) => {
      console.log(`\n   ${i + 1}. ${r.undername || r.url}`);
      console.log(`      Error: ${r.error}`);
    });
  }
  
  console.log('\n' + '═'.repeat(70));
  console.log('⚠️  Note: ArNS assignments were skipped (testing mode)');
  console.log('   To actually assign, uncomment the assignment code in the script');
  console.log('═'.repeat(70) + '\n');
  
  if (failed.length > 0) {
    process.exit(1);
  }
}

// Run tests
testArchiveFlow().then(() => {
  console.log('🎉 All tests complete!');
  process.exit(0);
}).catch(error => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});

