import 'dotenv/config';
import { TwitterApi } from 'twitter-api-v2';
import { ANT, ArweaveSigner, AOProcess } from '@ar.io/sdk';
import express from 'express';
import fs from 'fs';
import { requireEnv, getJwkFromEnv, isValidUndername, isInfrastructureErrorType, verifyTxIdExists, ARWEAVE_TXID_RE, ASSIGN_CMD_RE } from './lib/utils.js';
import { uploadToArweave, downloadMedia, getTurboClient } from './lib/arweave.js';
import { updateArchive } from './lib/archive.js';
import { reply, retweet, getTwitterClient } from './lib/twitter.js';
import { checkUndernameAvailability, createUndernameRecord } from './lib/arns.js';
import { hasMediaAttachments, extractTxIdFromTweetData, getMediaUrls, processMediaFromTweet } from './lib/media.js';
import { fetchParentTweet, fetchParentUser, isUserAllowed, extractCommandFromMention, handleHelpCommand, handleAccessDenied, handleNameTaken, handleTxIdFailed, handleNoMedia, handleUploadFailed, handleNoContent, handleGeneralError, handleSuccess } from './lib/mentions.js';
import { saveProcessedState, loadProcessedState } from './lib/state.js';
import { renderTemplate } from './response-templates/loader.js';

// ---------- config & env ----------

const {
  TWITTER_APP_KEY,
  TWITTER_APP_SECRET,
  TWITTER_ACCESS_TOKEN,
  TWITTER_ACCESS_SECRET,
  OWNER_ARNS_NAME,
} = {
  TWITTER_APP_KEY: requireEnv('TWITTER_APP_KEY'),
  TWITTER_APP_SECRET: requireEnv('TWITTER_APP_SECRET'),
  TWITTER_ACCESS_TOKEN: requireEnv('TWITTER_ACCESS_TOKEN'),
  TWITTER_ACCESS_SECRET: requireEnv('TWITTER_ACCESS_SECRET'),
  OWNER_ARNS_NAME: requireEnv('OWNER_ARNS_NAME')
};

const ANT_PROCESS_ID = requireEnv('ANT_PROCESS_ID');
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || 'Unknown';

const DEFAULT_TTL_SECONDS = parseInt(process.env.DEFAULT_TTL_SECONDS || '60', 10); // 60 seconds minimum
const POLL_INTERVAL_MINUTES = parseInt(process.env.POLL_INTERVAL_MINUTES || '16', 10); // 16 minutes for free plan (with buffer)
const POLL_INTERVAL_MS = POLL_INTERVAL_MINUTES * 60 * 1000; // Convert minutes to milliseconds
const RATE_LIMIT_BACKOFF_MINUTES = 16; // 16 minutes for Twitter free plan (with buffer)
const RATE_LIMIT_BACKOFF_MS = RATE_LIMIT_BACKOFF_MINUTES * 60 * 1000; // Convert minutes to milliseconds

// Retweet rate limiting
let lastRetweetTime = 0;
const RETWEET_COOLDOWN_MS = 60000; // 1 minute between retweets (more conservative)
const ENABLE_RETWEETS = String(process.env.ENABLE_RETWEETS || 'true').toLowerCase() !== 'false';

// Bot user ID (known from previous runs)
const BOT_USER_ID = '1971034918240256000';
console.log('🤖 Bot initialized: @NeedsArNS');

// Access control - comma-separated list of allowed usernames (without @)
const ALLOWED_USERS = process.env.ALLOWED_USERS ? process.env.ALLOWED_USERS.split(',').map(u => u.trim().toLowerCase()) : [];
console.log('🔐 Access control:', ALLOWED_USERS.length > 0 ? ALLOWED_USERS.join(', ') : 'ALL USERS');

// Time-based filtering - ignore mentions older than X hours
const MENTION_MAX_AGE_HOURS = parseInt(process.env.MENTION_MAX_AGE_HOURS || '24', 10);
console.log(`⏰ Time filter: ${MENTION_MAX_AGE_HOURS}h max age`);

// Persistent storage
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '.';
const PROCESSED_MENTIONS_FILE = `${DATA_DIR}/processed_mentions.json`;


// ---------- wallet ----------

// ---------- clients ----------
const twitter = getTwitterClient({
  appKey: TWITTER_APP_KEY,
  appSecret: TWITTER_APP_SECRET,
  accessToken: TWITTER_ACCESS_TOKEN,
  accessSecret: TWITTER_ACCESS_SECRET,
});

const jwk = getJwkFromEnv();
const ant = ANT.init({ 
  signer: new ArweaveSigner(jwk), 
  processId: ANT_PROCESS_ID 
});

// Initialize Turbo client for Arweave uploads
const turbo = getTurboClient(jwk);

// Wallet address is set in .env file

// ---------- helpers ----------





// ---------- core handler ----------
async function handleMention(twitterClient, mention, includes) {
  const authorId = mention.author_id;
  const author = includes?.users?.find(u => u.id === authorId);
  const username = author?.username || 'unknown';
  
  try {
    // Check format FIRST - if it's not a valid command, completely ignore
    const command = extractCommandFromMention(mention.text || '');
    if (!command) {
      // Silently ignore - don't log, don't process, don't track
      return;
    }
    
    console.log(`🔍 Processing: ${mention.id}`);
    
    // Handle help command
    if (command.type === 'help') {
      await handleHelpCommand(twitterClient, mention.id);
      return;
    }
    
    const undername = command.undername;
    console.log(`🏷️ Undername: ${undername}`);
    
    // Check if undername already exists BEFORE processing media
    const availability = await checkUndernameAvailability(ant, undername);
    if (!availability.available) {
      console.log(`❌ Name taken: ${undername}`);
      
      // Record failed assignment (name taken)
      processedDetails[mention.id] = {
        username: username,
        undername: undername,
        success: false,
        reason: 'undername_taken',
        timestamp: new Date().toISOString()
      };
      
      await handleNameTaken(twitterClient, mention.id, undername);
      return;
    }
    console.log(`✅ Name available: ${undername}`);
    
    // Check access control
    if (!isUserAllowed(mention, includes, ALLOWED_USERS)) {
      // Record denied access attempt
      processedDetails[mention.id] = {
        username: username,
        success: false,
        reason: 'access_denied',
        timestamp: new Date().toISOString()
      };
      
      await handleAccessDenied(twitterClient, mention.id, username);
      return;
    }
    
    // We only act when the mention is in reply to a tweet (the parent should have the link)
    const parent = fetchParentTweet(includes, mention);
    if (!parent) {
      console.log(`❌ No parent tweet: ${mention.id}`);
      return;
    }
    console.log(`📝 Parent: ${parent.id}`);

    // Check for existing Arweave links first (faster, cheaper)
    let txId = extractTxIdFromTweetData(parent);
    let isUploadedMedia = false;
    
    if (txId) {
      // Handle existing Arweave link flow (PRIORITY)
      console.log(`🔗 Found TXID: ${txId}`);
      
      // Verify existing TXID
      const ok = await verifyTxIdExists(txId);
      if (!ok) {
        console.log(`❌ TXID verification failed: ${txId}`);
        await handleTxIdFailed(twitterClient, mention.id, txId);
        return;
      }
      console.log(`✅ TXID verified: ${txId}`);
      
    } else if (hasMediaAttachments(parent)) {
      // Fallback: Handle media upload flow
      console.log(`📱 No Arweave link found, checking for media attachments`);
      
      const mediaResult = await processMediaFromTweet(parent, includes, (buffer, contentType) => 
        uploadToArweave(buffer, contentType, 'NeedsArNS-Bot', jwk)
      );
      
      if (!mediaResult.success) {
        if (mediaResult.error === 'no_media') {
          await handleNoMedia(twitterClient, mention.id);
        } else if (mediaResult.error === 'upload_failed') {
          await handleUploadFailed(twitterClient, mention.id, mediaResult.message);
        }
        return;
      }
      
      txId = mediaResult.txId;
      isUploadedMedia = mediaResult.isUploadedMedia;
      
    } else {
      // No Arweave link AND no media found
      console.log(`❌ No Arweave TXID or media found in parent tweet ${parent.id}`);
      await handleNoContent(twitterClient, mention.id);
      return;
    }

    // Create ArNS record
    const recordResult = await createUndernameRecord(ant, undername, txId, DEFAULT_TTL_SECONDS);
    if (!recordResult.success) {
      if (recordResult.error === 'undername_taken') {
        console.log(`❌ Undername '${undername}' is already taken`);
        
        // Record failed assignment (name taken)
        processedDetails[mention.id] = {
          username: username,
          undername: undername,
          txId: txId,
          success: false,
          reason: 'undername_taken',
          timestamp: new Date().toISOString()
        };
        
        await handleNameTaken(twitterClient, mention.id, undername);
        return;
      }
      throw new Error(recordResult.message);
    }
    
    const onchainId = recordResult.recordId;
    
    // Record successful assignment
    processedDetails[mention.id] = {
      username: username,
      undername: undername,
      txId: txId,
      onchainId: onchainId,
      isUploadedMedia: isUploadedMedia,
      success: true,
      timestamp: new Date().toISOString()
    };
    
    // Update archive with new record
    await updateArchive({
      username: username,
      undername: undername,
      txId: txId,
      isUploadedMedia: isUploadedMedia,
      timestamp: new Date().toISOString()
    }, true, ant, OWNER_ARNS_NAME, DEFAULT_TTL_SECONDS, jwk);

    // Send success reply
    const replyTweetId = await handleSuccess(twitterClient, mention.id, undername, OWNER_ARNS_NAME, txId, isUploadedMedia);
    
    // Retweet the success message to promote the archived content
    if (replyTweetId && ENABLE_RETWEETS) {
      console.log('🔄 Retweeting success message...');
      await retweet(twitterClient, replyTweetId, BOT_USER_ID);
    } else if (replyTweetId && !ENABLE_RETWEETS) {
      console.log('📝 Retweets disabled via ENABLE_RETWEETS=false');
    }
  } catch (err) {
    console.error('handleMention error:', err?.message || err);
    
    // Categorize error type
    const isInfrastructureError = isInfrastructureErrorType(err);
    
    // Record failed assignment (error)
    processedDetails[mention.id] = {
      username: username,
      success: false,
      reason: 'error',
      error: err?.message || 'unknown error',
      timestamp: new Date().toISOString(),
      isInfrastructureError: isInfrastructureError
    };
    
    // Only reply to user-related errors, not infrastructure issues
    if (!isInfrastructureError) {
      await handleGeneralError(twitterClient, mention.id, err?.message ?? 'unknown error');
    } else {
      console.log(`🔧 Infrastructure error - skipping reply to user`);
    }
  }
}

// ---------- request queuing ----------
let isProcessing = false;
let isPolling = false;

// Load persistent state on startup
const { processedMentions, sinceId: initialSinceId, processedDetails } = loadProcessedState(PROCESSED_MENTIONS_FILE);

async function processMentionQueue(twitterClient, mention, includes) {
  // Wait if another mention is being processed
  while (isProcessing) {
    console.log('⏳ Waiting for previous mention to finish processing...');
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
  }
  
  isProcessing = true;
  try {
    await handleMention(twitterClient, mention, includes);
  } finally {
    isProcessing = false;
  }
}

// ---------- polling loop ----------
async function pollMentionsForever() {

  let sinceId = initialSinceId; // Load from persistent storage
  let backoffMs = POLL_INTERVAL_MS;
  let isFirstPoll = !sinceId; // Only first poll if we don't have a saved since_id
  // Countdown timer removed for now - was causing scheduling issues

  async function pollOnce() {
    if (isPolling) {
      console.log('⏳ Poll already in progress, skipping...');
      return;
    }
    
    console.log('🔒 Setting isPolling = true');
    isPolling = true;
    try {
      // On first poll, don't use since_id to catch all recent mentions
      const actualSinceId = isFirstPoll ? undefined : sinceId;
      console.log(`🔍 Fetching mentions since_id: ${actualSinceId || 'none'}${isFirstPoll ? ' (first poll - getting all recent)' : ''}`);
    const res = await twitter.v2.userMentionTimeline(BOT_USER_ID, {
      since_id: actualSinceId,
      'tweet.fields': ['referenced_tweets', 'created_at', 'entities', 'text', 'author_id', 'attachments', 'public_metrics', 'lang', 'possibly_sensitive', 'conversation_id'],
      expansions: ['referenced_tweets.id', 'author_id', 'attachments.media_keys', 'referenced_tweets.id.attachments.media_keys'],
      'user.fields': ['username', 'name', 'verified', 'public_metrics', 'created_at', 'description'],
      'media.fields': ['type', 'url', 'preview_image_url', 'width', 'height', 'variants', 'public_metrics', 'alt_text'],
      max_results: 100
    });
      console.log(`📊 API Response: ${res._realData?.data?.length || 0} mentions found`);
      console.log('🔍 Raw API response object:', JSON.stringify(res, null, 2));
      
      // Debug: Log the raw API response
      if (res._realData?.data && res._realData.data.length > 0) {
        console.log('🔍 Raw mentions from API:');
        res._realData.data.forEach((mention, i) => {
          console.log(`  ${i + 1}. ID: ${mention.id}`);
          console.log(`     Text: ${JSON.stringify(mention.text)}`);
          console.log(`     Created: ${mention.created_at}`);
        });
      } else {
        console.log('❌ No mentions in API response');
        console.log('❌ Raw response data:', res._realData?.data);
        console.log('❌ Response meta:', res._realData?.meta);
      }

      const batch = res._realData?.data ?? [];
      if (batch.length) {
        console.log(`📨 Found ${batch.length} new mentions`);
        
        // Apply time-based filtering first
        const cutoffTime = Date.now() - (MENTION_MAX_AGE_HOURS * 60 * 60 * 1000);
        const recentMentions = batch.filter(m => {
          const mentionTime = new Date(m.created_at).getTime();
          const isRecent = mentionTime > cutoffTime;
          if (!isRecent) {
            const ageHours = ((Date.now() - mentionTime) / (60 * 60 * 1000)).toFixed(1);
            console.log(`⏰ Skipping old mention ${m.id} (${ageHours}h old): "${m.text}"`);
          }
          return isRecent;
        });
        
        if (recentMentions.length !== batch.length) {
          console.log(`⏰ Filtered out ${batch.length - recentMentions.length} old mentions (older than ${MENTION_MAX_AGE_HOURS}h)`);
        }
        
        if (recentMentions.length > 0) {
        // newest first from API; remember the newest
          sinceId = recentMentions[0].id;
          isFirstPoll = false;
          
          // Save updated since_id immediately
          saveProcessedState(processedMentions, sinceId, processedDetails, PROCESSED_MENTIONS_FILE);
          
          // Queue mentions for processing (oldest -> newest)
          const newMentions = recentMentions.reverse().filter(m => !processedMentions.has(m.id));
          if (newMentions.length > 0) {
            console.log(`📋 Queuing ${newMentions.length} new mentions for processing`);
            const includes = res._realData?.includes || {};
            for (const m of newMentions) {
              processedMentions.add(m.id);
              await processMentionQueue(twitter, m, includes);
            // Save state after each processed mention
            saveProcessedState(processedMentions, sinceId, processedDetails, PROCESSED_MENTIONS_FILE);
            }
          }
        } else {
          console.log('⏰ No recent mentions to process after time filtering');
        }
      } else {
        console.log('🔍 No new mentions found');
      }
      
      // Reset backoff on successful request
      backoffMs = POLL_INTERVAL_MS;
      
    } catch (e) {
      if (e?.code === 429) {
        console.log(`⏳ Rate limited! Waiting 16 minutes for Twitter free plan reset...`);
        console.log(`📊 Rate limit details: ${e.message || 'No details'}`);
        backoffMs = RATE_LIMIT_BACKOFF_MS; // Wait full 15 minutes
      } else {
      console.error('poll error:', e?.message || e);
        console.error('poll error code:', e?.code);
        console.error('poll error details:', e);
      }
    } finally {
      console.log('🔓 Setting isPolling = false');
      isPolling = false;
      
      // Schedule next poll only after current poll is completely done
      console.log(`⏰ Scheduling next poll in ${backoffMs}ms (${(backoffMs/1000/60).toFixed(1)} minutes)`);
      setTimeout(pollOnce, backoffMs);
    }
  }
  
  // Wait 1 minute before first poll to give time for setup
  console.log('⏳ Waiting 1 minute before first poll...');
  
  setTimeout(async () => {
    console.log('🚀 Starting first poll...');
    pollOnce();
  }, 60000);
}

// ---------- tiny health server (useful on PaaS) ----------
const app = express();
app.get('/', (_req, res) => res.send('ok'));
app.get('/debug', (_req, res) => {
  res.json({
    status: 'running',
    botName: 'NeedsArNS',
    testnet: true,
    gateway: 'ar-io.dev',
    walletAddress: WALLET_ADDRESS,
    timestamp: new Date().toISOString(),
    env: {
      hasTwitterKeys: !!(TWITTER_APP_KEY && TWITTER_APP_SECRET),
      hasArweaveWallet: !!jwk,
      hasArnsProcessId: !!ANT_PROCESS_ID,
      ownerArnsName: OWNER_ARNS_NAME
    }
  });
});
const port = parseInt(process.env.PORT || '3000', 10);
app.listen(port, () => console.log(`health server on :${port}`));

// ---------- boot ----------
pollMentionsForever().catch(err => {
  console.error('fatal:', err);
  process.exit(1);
});
