import 'dotenv/config';
import { TwitterApi } from 'twitter-api-v2';
import { getJwkFromEnv, requireEnv } from './lib/utils.js';
import { createMentionArchive, buildMetadataObject } from './lib/archive.js';
import { addToMentionIndex, saveMentionIndex, loadMentionIndex } from './lib/mention-index.js';
import { uploadToArweave, uploadManifest, getTurboClient, getTurboBalanceWithShared, estimateUploadCostWinc, assertSufficientCredits } from './lib/arweave.js';
import { processMediaFromTweet } from './lib/media.js';
import { generateManifest } from './lib/manifest.js';
import fs from 'fs';

const MENTION_ID = '2012125101446320624';
const UNDERNAME = 'bobby-forever';
const TEMPLATE_HTML_TXID = requireEnv('TEMPLATE_HTML_TXID');

async function main() {
  console.log('🔧 Retrying mention:', MENTION_ID);
  console.log('📝 Undername:', UNDERNAME);

  const jwk = getJwkFromEnv();

  // Create Twitter client with credentials
  const twitter = new TwitterApi({
    appKey: process.env.TWITTER_APP_KEY,
    appSecret: process.env.TWITTER_APP_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_SECRET,
  });

  // Fetch the mention tweet using v2.tweets (works with OAuth 1.0a)
  console.log('\n📡 Fetching mention tweet...');
  const mentionRes = await twitter.v2.tweets([MENTION_ID], {
    'tweet.fields': ['referenced_tweets', 'created_at', 'entities', 'text', 'author_id', 'attachments'],
    expansions: ['referenced_tweets.id', 'author_id', 'attachments.media_keys', 'referenced_tweets.id.attachments.media_keys', 'referenced_tweets.id.author_id'],
    'user.fields': ['username', 'name', 'profile_image_url'],
    'media.fields': ['type', 'url', 'preview_image_url', 'width', 'height', 'variants', 'alt_text'],
  });

  const mention = mentionRes.data?.[0];
  if (!mention) {
    console.log('❌ Could not fetch mention tweet');
    return;
  }
  const includes = mentionRes.includes || {};
  console.log('✅ Got mention:', mention.text?.substring(0, 50) + '...');

  // Find the parent tweet (what they're replying to)
  const parentRef = mention.referenced_tweets?.find(r => r.type === 'replied_to');
  if (!parentRef) {
    console.log('❌ No parent tweet found - this mention is not a reply');
    return;
  }

  const parent = includes.tweets?.find(t => t.id === parentRef.id);
  if (!parent) {
    console.log('❌ Could not find parent tweet in includes');
    return;
  }
  console.log('✅ Got parent tweet:', parent.text?.substring(0, 50) + '...');

  // Get user objects
  const mentionUser = includes.users?.find(u => u.id === mention.author_id);
  const parentUser = includes.users?.find(u => u.id === parent.author_id);

  console.log('👤 Mention by:', mentionUser?.username || 'unknown');
  console.log('👤 Parent by:', parentUser?.username || 'unknown');

  // Process media from the parent tweet
  console.log('\n📱 Processing media attachments...');
  let mediaArray = [];
  const mediaResult = await processMediaFromTweet(parent, includes, (buffer, contentType) =>
    uploadToArweave(buffer, contentType, 'NeedsArNS-Bot', jwk)
  );

  if (mediaResult.success) {
    mediaArray = mediaResult.media || [];
    console.log(`✅ Processed ${mediaArray.length} media items`);
  } else if (mediaResult.error === 'no_media') {
    console.log('ℹ️ No media attachments');
  } else {
    console.error('❌ Media processing failed:', mediaResult.error);
    return;
  }

  // Build metadata object
  console.log('\n📄 Building metadata...');
  const metadataObj = buildMetadataObject(mention, parent, mentionUser, parentUser, mediaArray, includes);
  metadataObj.metadata.undername = UNDERNAME;
  metadataObj.metadata.path = UNDERNAME;

  // Preflight check
  console.log('🔍 Checking Turbo credit balance...');
  const turbo = getTurboClient(jwk);
  const balance = await getTurboBalanceWithShared(turbo);

  const metadataBuffer = Buffer.from(JSON.stringify(metadataObj, null, 2));
  const tempManifest = generateManifest('', mediaArray, TEMPLATE_HTML_TXID);
  const manifestBuffer = Buffer.from(JSON.stringify(tempManifest, null, 2));
  const totalUploadBytes = metadataBuffer.length + manifestBuffer.length;

  const estimatedWinc = await estimateUploadCostWinc(turbo, totalUploadBytes);
  assertSufficientCredits(estimatedWinc, balance);
  console.log('✅ Sufficient credits available');

  // Upload metadata.json
  console.log('\n📤 Uploading metadata.json...');
  const metadataTxId = await uploadToArweave(
    Buffer.from(JSON.stringify(metadataObj, null, 2)),
    'application/json',
    'NeedsArNS-Metadata',
    jwk
  );
  console.log('✅ Metadata uploaded:', metadataTxId);

  // Create and upload manifest
  console.log('📦 Creating Arweave manifest...');
  const manifest = generateManifest(metadataTxId, mediaArray, TEMPLATE_HTML_TXID);
  const manifestTxId = await uploadManifest(
    Buffer.from(JSON.stringify(manifest, null, 2)),
    jwk
  );
  console.log('✅ Manifest uploaded:', manifestTxId);

  // Update mention index
  console.log('\n🔗 Updating index...');
  loadMentionIndex();

  addToMentionIndex({
    path: UNDERNAME,
    mentionId: MENTION_ID,
    manifestTxId,
    metadataTxId,
    mediaCount: mediaArray.length,
    hasVideo: mediaArray.some(m => m.type === 'video' || m.type === 'animated_gif'),
    isLegacyUndername: false
  }, parent, mentionUser, parentUser);

  saveMentionIndex();
  console.log('✅ Added to index');

  // Update metadata object with final archive info
  metadataObj.archive.htmlTxId = TEMPLATE_HTML_TXID;
  metadataObj.archive.manifestTxId = manifestTxId;
  metadataObj.archive.metadataTxId = metadataTxId;
  metadataObj.archive.assignedAt = new Date().toISOString();

  // Save individual mention archive
  await createMentionArchive(metadataObj);

  // Update processed_mentions.json
  const processedPath = './processed_mentions.json';
  const processed = JSON.parse(fs.readFileSync(processedPath, 'utf-8'));
  processed[MENTION_ID] = {
    mentionUsername: mentionUser?.username || 'unknown',
    path: UNDERNAME,
    txId: manifestTxId,
    isUploadedMedia: mediaArray.length > 0,
    success: true,
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(processedPath, JSON.stringify(processed, null, 2));
  console.log('✅ Updated processed_mentions.json');

  console.log('\n🎉 Done! Archive available at:');
  console.log(`   https://needsarns.ar.io/#/${UNDERNAME}`);
}

main().catch(console.error);
