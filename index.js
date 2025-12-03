import 'dotenv/config';
import { TwitterApi } from 'twitter-api-v2';
import { ANT, ArweaveSigner, AOProcess } from '@ar.io/sdk';
import express from 'express';
import fs from 'fs';
import { requireEnv, getJwkFromEnv, isValidUndername, isInfrastructureErrorType, verifyTxIdExists, ARWEAVE_TXID_RE, ASSIGN_CMD_RE } from './lib/utils.js';
import { uploadToArweave, uploadManifest, getTurboClient, getTurboBalanceWithShared, estimateUploadCostWinc, assertSufficientCredits } from './lib/arweave.js';
import { createMentionArchive, updateMentionArchive, buildMetadataObject, uploadAndAssignArchiveIndex } from './lib/archive.js';
import { reply, retweet, getTwitterClient } from './lib/twitter.js';
import { checkUndernameAvailability, createUndernameRecord } from './lib/arns.js';
import { hasMediaAttachments, extractTxIdFromTweetData, getMediaUrls, processMediaFromTweet } from './lib/media.js';
import { fetchParentTweet, fetchParentUser, isUserAllowed, extractCommandFromMention, handleAccessDenied, handleNameTaken, handleTxIdFailed } from './lib/mentions.js';
import { saveProcessedState, loadProcessedState } from './lib/state.js';
import { renderTemplate } from './response-templates/loader.js';
import { generateManifest } from './lib/manifest.js';
import { checkQuota, incrementUsage, getUserStats, getQuotaMessage } from './lib/quota.js';

// ---------- config & env ----------

const {
  TWITTER_APP_KEY,
  TWITTER_APP_SECRET,
  TWITTER_ACCESS_TOKEN,
  TWITTER_ACCESS_SECRET,
  ROOT_ARNS_NAME,
} = {
  TWITTER_APP_KEY: requireEnv('TWITTER_APP_KEY'),
  TWITTER_APP_SECRET: requireEnv('TWITTER_APP_SECRET'),
  TWITTER_ACCESS_TOKEN: requireEnv('TWITTER_ACCESS_TOKEN'),
  TWITTER_ACCESS_SECRET: requireEnv('TWITTER_ACCESS_SECRET'),
  ROOT_ARNS_NAME: requireEnv('ROOT_ARNS_NAME')
};

const ANT_PROCESS_ID = requireEnv('ANT_PROCESS_ID');
const WALLET_ADDRESS = process.env.WALLET_ADDRESS || 'Unknown';

// Template system (required)
const TEMPLATE_HTML_TXID = requireEnv('TEMPLATE_HTML_TXID');

const DEFAULT_TTL_SECONDS = parseInt(process.env.DEFAULT_TTL_SECONDS || '60', 10); // 60 seconds minimum
const POLL_INTERVAL_MINUTES = parseInt(process.env.POLL_INTERVAL_MINUTES || '16', 10); // 16 minutes for free plan (with buffer)
const POLL_INTERVAL_MS = POLL_INTERVAL_MINUTES * 60 * 1000; // Convert minutes to milliseconds

// Retweet rate limiting
let lastRetweetTime = 0;
const RETWEET_COOLDOWN_MS = 60000; // 1 minute between retweets (more conservative)
const ENABLE_RETWEETS = String(process.env.ENABLE_RETWEETS || 'true').toLowerCase() !== 'false';

// Verbose logging
const VERBOSE_LOGGING = String(process.env.VERBOSE_LOGGING || 'false').toLowerCase() === 'true';

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
  const mentionUsername = author?.username || 'unknown';
  
  try {
    // Check for usage command FIRST (doesn't need parent tweet)
    const mentionText = (mention.text || '').toLowerCase().trim();
    if (/@needsarns\s+usage\b/i.test(mentionText)) {
      console.log(`📊 Usage query from @${mentionUsername}`);
      const stats = getUserStats(authorId);

      if (stats) {
        const percentUsed = Math.round((stats.used / stats.limit) * 100);
        const periodEnd = new Date(stats.periodEnd).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

        const usageMsg = `📊 Your Usage Stats\n\n` +
          `Tier: ${stats.tierName}\n` +
          `This Month: ${stats.used}/${stats.limit} (${percentUsed}%)\n` +
          `Remaining: ${stats.remaining}\n` +
          `Lifetime: ${stats.lifetime}\n` +
          `Resets: ${periodEnd}\n\n` +
          `${stats.tier === 'free' ? '💡 Upgrade to Pro for 100/month!' : '✨ Thank you for supporting @NeedsArNS!'}`;

        await reply(twitterClient, mention.id, usageMsg);
        console.log(`✅ Sent usage stats to @${mentionUsername}`);
      } else {
        // New user
        const welcomeMsg = `👋 Welcome to @NeedsArNS!\n\n` +
          `You have 5 free assignments per month.\n\n` +
          `Usage: Reply to any tweet with:\n` +
          `@NeedsArNS assign <name>\n\n` +
          `Check usage anytime: @NeedsArNS usage`;

        await reply(twitterClient, mention.id, welcomeMsg);
        console.log(`✅ Sent welcome message to @${mentionUsername}`);
      }
      return;
    }

    // Check format - if it's not a valid command, completely ignore
    const command = extractCommandFromMention(mention.text || '');
    if (!command) {
      // Silently ignore - don't log, don't process, don't track
      return;
    }
    
    console.log('\n' + '═'.repeat(80));
    console.log(`🔍 Processing: ${mention.id}`);
    
    // Fetch parent tweet early (needed for fallback logic)
    const parent = fetchParentTweet(includes, mention);
    if (!parent) {
      console.log(`❌ No parent tweet: ${mention.id}`);
      return;
    }
    console.log(`📝 Parent: ${parent.id}`);
    
    const requestedUndername = command.undername;
    console.log(`🏷️ Requested undername: ${requestedUndername}`);

    // Check user quota (test mode - tracking only, not blocking)
    const quotaCheck = checkQuota(authorId, mentionUsername, true);
    console.log(`📊 Quota check for @${mentionUsername}: ${quotaCheck.used}/${quotaCheck.limit} used (${quotaCheck.remaining} remaining) [${quotaCheck.tier} tier]`);
    if (quotaCheck.testMode && !quotaCheck.allowed) {
      console.log(`⚠️  [TEST MODE] User would be blocked, but allowing for testing`);
    }

    // Check if requested undername already exists BEFORE processing media
    let undername = requestedUndername;
    let isFallback = false;
    const availability = await checkUndernameAvailability(ant, undername);
    if (!availability.available) {
      console.log(`❌ Requested name taken: ${undername}`);
      
      // Try parent tweet ID as fallback undername
      const fallbackUndername = parent.id;
      console.log(`🔄 Trying fallback undername: ${fallbackUndername}`);
      const fallbackAvailability = await checkUndernameAvailability(ant, fallbackUndername);
      
      if (!fallbackAvailability.available) {
        console.log(`❌ Fallback name also taken: ${fallbackUndername}`);
        
        // Record failed assignment (name taken)
        processedDetails[mention.id] = {
          mentionUsername: mentionUsername,
          undername: requestedUndername,
          success: false,
          reason: 'undername_taken',
          timestamp: new Date().toISOString()
        };
        
        await handleNameTaken(twitterClient, mention.id, requestedUndername);
        return;
      }
      
      // Use fallback undername
      undername = fallbackUndername;
      isFallback = true;
      console.log(`✅ Using fallback undername: ${undername}`);
    } else {
      console.log(`✅ Requested name available: ${undername}`);
    }
    
    // Check access control
    if (!isUserAllowed(mention, includes, ALLOWED_USERS)) {
      // Record denied access attempt
      processedDetails[mention.id] = {
        mentionUsername: mentionUsername,
        success: false,
        reason: 'access_denied',
        timestamp: new Date().toISOString()
      };
      
      await handleAccessDenied(twitterClient, mention.id, mentionUsername);
      return;
    }

    // Get user data for metadata
    const mentionUser = includes?.users?.find(u => u.id === mention.author_id);
    const parentUser = includes?.users?.find(u => u.id === parent.author_id);
    
    // Determine content type and handle media/links
    let mediaArray = [];
    let isUploadedMedia = false;
    let existingTxId = extractTxIdFromTweetData(parent);
    
    // Handle "name this" command - direct assignment to existing TXID (no archive)
    if (command.type === 'name') {
      if (!existingTxId) {
        console.log(`❌ No Arweave link found for "name this" command: ${mention.id}`);
        const noLinkMsg = renderTemplate('error-no-arweave-link', {
          undername: requestedUndername,
          rootArnsName: ROOT_ARNS_NAME
        });
        await reply(twitterClient, mention.id, noLinkMsg || '❌ No Arweave link found in the parent post. Include a valid ar:// or arweave.net/<txid> link, or use "archive".');
        return;
      }
      
      // Verify existing TXID
      console.log(`🔗 Found existing TXID for naming: ${existingTxId}`);
      const ok = await verifyTxIdExists(existingTxId);
      if (!ok) {
        console.log(`❌ TXID verification failed: ${existingTxId}`);
        await handleTxIdFailed(twitterClient, mention.id, existingTxId);
        return;
      }
      console.log(`✅ TXID verified: ${existingTxId}`);
      
      // Directly assign undername -> existing TXID (no manifest/archive)
      console.log(`🔗 Directly assigning ArNS: ${undername} → ${existingTxId}`);
      const recordResult = await createUndernameRecord(ant, undername, existingTxId, DEFAULT_TTL_SECONDS);
      if (!recordResult.success) {
        if (recordResult.error === 'undername_taken') {
          console.log(`❌ Undername '${undername}' is already taken`);
          
          // Record failed assignment (name taken)
          processedDetails[mention.id] = {
            mentionUsername: mentionUsername,
            undername: requestedUndername,
            success: false,
            reason: 'undername_taken',
            timestamp: new Date().toISOString()
          };
          
          await handleNameTaken(twitterClient, mention.id, requestedUndername);
          return;
        }
        throw new Error(recordResult.message);
      }
      
      const onchainId = recordResult.recordId;
      console.log(`✅ ArNS record created (direct assign): ${onchainId}`);
      
      // Record successful assignment (direct assignment)
      processedDetails[mention.id] = {
        mentionUsername: mentionUsername,
        undername: undername,
        txId: existingTxId,
        onchainId: onchainId,
        isUploadedMedia: false,
        success: true,
        directAssign: true,
        timestamp: new Date().toISOString()
      };
      
      // Reply with success message for direct assignment
      console.log('💬 Sending success reply for direct assignment...');
      const msg = renderTemplate('success-name-only', {
        undername,
        rootArnsName: ROOT_ARNS_NAME,
        txId: existingTxId
      });
      
      // Wait 1 minute before replying (keeps existing pacing)
      console.log('⏳ Waiting 1 minute before replying...');
      await new Promise(resolve => setTimeout(resolve, 60000));

      const replyTweetId = await reply(twitterClient, mention.id, msg || `🎉 ${undername}_${ROOT_ARNS_NAME}.ar.io → ${existingTxId}`);

      if (!replyTweetId) {
        console.error(`❌ Failed to send reply to @${mentionUsername} for ${undername}`);
      } else {
        console.log(`✅ Successfully replied to @${mentionUsername} for ${undername}`);

        // Track usage (test mode - logs only)
        const usage = incrementUsage(authorId, undername);
        if (usage) {
          console.log(`📈 Usage updated: ${usage.used}/${usage.limit} this month, ${usage.lifetime} lifetime`);

          // Check if we should show a quota message
          const quotaMsg = getQuotaMessage(authorId);
          if (quotaMsg) {
            console.log(`💬 [INFO] Would append to reply:${quotaMsg}`);
          }
        }
      }

      // Retweet the success message to promote the assignment
      if (replyTweetId && ENABLE_RETWEETS) {
        console.log('🔄 Retweeting success message...');
        await retweet(twitterClient, replyTweetId, BOT_USER_ID);
      } else if (replyTweetId && !ENABLE_RETWEETS) {
        console.log('📝 Retweets disabled via ENABLE_RETWEETS=false');
      } else if (!replyTweetId) {
        console.log('⚠️ Skipping retweet because reply failed');
      }
      
      return;
    }
    
    if (existingTxId) {
      // Handle existing Arweave link flow (PRIORITY)
      console.log(`🔗 Found existing TXID: ${existingTxId}`);
      
      // Verify existing TXID
      const ok = await verifyTxIdExists(existingTxId);
      if (!ok) {
        console.log(`❌ TXID verification failed: ${existingTxId}`);
        await handleTxIdFailed(twitterClient, mention.id, existingTxId);
        return;
      }
      console.log(`✅ TXID verified: ${existingTxId}`);
      
      // Create metadata entry for existing link (no media upload)
      mediaArray = [{
        type: 'link',
        txId: existingTxId,
        alt_text: 'Existing Arweave content',
        index: 0
      }];
      
    } else if (hasMediaAttachments(parent)) {
      // Handle media upload flow
      console.log(`📱 No Arweave link found, uploading media attachments`);
      
      const mediaResult = await processMediaFromTweet(parent, includes, (buffer, contentType) => 
        uploadToArweave(buffer, contentType, 'NeedsArNS-Bot', jwk)
      );
      
      if (!mediaResult.success) {
        if (mediaResult.error === 'no_media') {
          // Proceed without media
          mediaArray = [];
          isUploadedMedia = false;
        } else if (mediaResult.error === 'upload_failed') {
          // Treat as infrastructure error: record and exit without public reply
          processedDetails[mention.id] = {
            mentionUsername: mentionUsername,
            success: false,
            reason: 'media_upload_failed',
            error: mediaResult.message,
            timestamp: new Date().toISOString(),
            isInfrastructureError: true
          };
          return;
        }
      } else {
        mediaArray = mediaResult.media;
        isUploadedMedia = true;
        console.log(`✅ Uploaded ${mediaArray.length} media file(s)`);
      }
    } else {
      // Proceed with zero media
      mediaArray = [];
      isUploadedMedia = false;
      console.log(`ℹ️ Proceeding without media for parent tweet ${parent.id}`);
    }

    // Build metadata object
    const metadataObj = buildMetadataObject(mention, parent, mentionUser, parentUser, mediaArray, includes);
    metadataObj.metadata.undername = undername;
    
    // Preflight check: estimate total cost for all uploads (metadata + manifest)
    console.log('🔍 Checking Turbo credit balance before uploads...');
    const turboForPreflight = getTurboClient(jwk);
    const balance = await getTurboBalanceWithShared(turboForPreflight);
    
    // Estimate sizes for metadata and manifest
    const metadataBuffer = Buffer.from(JSON.stringify(metadataObj, null, 2));
    const tempManifest = generateManifest('', mediaArray, TEMPLATE_HTML_TXID); // Temp manifest for size estimate
    const manifestBuffer = Buffer.from(JSON.stringify(tempManifest, null, 2));
    const totalUploadBytes = metadataBuffer.length + manifestBuffer.length;
    
    // Estimate cost and validate sufficient balance
    const estimatedWinc = await estimateUploadCostWinc(turboForPreflight, totalUploadBytes);
    assertSufficientCredits(estimatedWinc, balance);
    console.log('✅ Sufficient credits available for archive uploads');
    
    // Upload metadata.json
    console.log('📄 Uploading metadata.json...');
    const metadataTxId = await uploadToArweave(
      Buffer.from(JSON.stringify(metadataObj, null, 2)), 
      'application/json',
      'NeedsArNS-Metadata',
      jwk
    );
    
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

    // Create ArNS record pointing to manifest
    const recordResult = await createUndernameRecord(ant, undername, manifestTxId, DEFAULT_TTL_SECONDS);
    if (!recordResult.success) {
      if (recordResult.error === 'undername_taken') {
        console.log(`❌ Undername '${undername}' is already taken (race condition or fallback also taken)`);
        
        // Record failed assignment (name taken)
        // Use requested name for error message (fallback case already handled earlier)
        processedDetails[mention.id] = {
          mentionUsername: mentionUsername,
          undername: requestedUndername,
          success: false,
          reason: 'undername_taken',
          timestamp: new Date().toISOString()
        };
        
        await handleNameTaken(twitterClient, mention.id, requestedUndername);
        return;
      }
      throw new Error(recordResult.message);
    }
    
    const onchainId = recordResult.recordId;
    console.log(`✅ ArNS record created: ${onchainId}`);
    
    // Update metadata object with final ArNS info
    metadataObj.archive.htmlTxId = htmlTxId;
    metadataObj.archive.manifestTxId = manifestTxId;
    metadataObj.archive.arnsRecordId = onchainId;
    metadataObj.archive.assignedAt = new Date().toISOString();
    
    // Save individual mention archive
    await createMentionArchive(metadataObj);
    
    // Record successful assignment in processed state
    processedDetails[mention.id] = {
      mentionUsername: mentionUsername,
      undername: undername,
      txId: manifestTxId,
      onchainId: onchainId,
      isUploadedMedia: isUploadedMedia,
      success: true,
      timestamp: new Date().toISOString()
    };

    // Send success reply with manifest txId
    console.log('💬 Sending success reply...');
    const templateType = 'success-post-archive';
    const templateVars = {
      undername,
      rootArnsName: ROOT_ARNS_NAME,
      manifestTxId,
      fallbackMessage: isFallback ? `Requested name was taken. Assigned parent post ID '${parent.id}' instead.` : ''
    };
    
    const msg = renderTemplate(templateType, templateVars);
    
    if (!msg) {
      let fallbackMsg = `🎉 ${undername}_${ROOT_ARNS_NAME}.ar.io → ${manifestTxId}`;
      if (isFallback) {
        fallbackMsg = `Requested name was taken. Assigned parent post ID '${parent.id}' instead.\n\n${fallbackMsg}`;
      }
      console.log('⚠️ Template loading failed, using fallback message');
      const replyTweetId = await reply(twitterClient, mention.id, fallbackMsg);

      if (!replyTweetId) {
        console.error(`❌ Failed to send fallback reply to @${mentionUsername} for ${undername}`);
      } else {
        console.log(`✅ Successfully sent fallback reply to @${mentionUsername} for ${undername}`);

        // Track usage (test mode - logs only)
        const usage = incrementUsage(authorId, undername);
        if (usage) {
          console.log(`📈 Usage updated: ${usage.used}/${usage.limit} this month, ${usage.lifetime} lifetime`);

          // Check if we should show a quota message
          const quotaMsg = getQuotaMessage(authorId);
          if (quotaMsg) {
            console.log(`💬 [INFO] Would append to reply:${quotaMsg}`);
          }
        }
      }
      return;
    }

    // Wait 1 minute before replying
    console.log('⏳ Waiting 1 minute before replying...');
    await new Promise(resolve => setTimeout(resolve, 60000));

    const replyTweetId = await reply(twitterClient, mention.id, msg);

    if (!replyTweetId) {
      console.error(`❌ Failed to send archive reply to @${mentionUsername} for ${undername}`);
    } else {
      console.log(`✅ Successfully sent archive reply to @${mentionUsername} for ${undername}`);

      // Track usage (test mode - logs only)
      const usage = incrementUsage(authorId, undername);
      if (usage) {
        console.log(`📈 Usage updated: ${usage.used}/${usage.limit} this month, ${usage.lifetime} lifetime`);
      }
    }

    // Retweet the success message to promote the archived content
    if (replyTweetId && ENABLE_RETWEETS) {
      console.log('🔄 Retweeting success message...');
      await retweet(twitterClient, replyTweetId, BOT_USER_ID);
    } else if (replyTweetId && !ENABLE_RETWEETS) {
      console.log('📝 Retweets disabled via ENABLE_RETWEETS=false');
    } else if (!replyTweetId) {
      console.log('⚠️ Skipping retweet because reply failed');
    }
  } catch (err) {
    console.error('handleMention error:', err?.message || err);
    
    // Categorize error type
    const isInfrastructureError = isInfrastructureErrorType(err);
    
    // Record failed assignment (error)
    processedDetails[mention.id] = {
      mentionUsername: mentionUsername,
      success: false,
      reason: 'error',
      error: err?.message || 'unknown error',
      timestamp: new Date().toISOString(),
      isInfrastructureError: isInfrastructureError
    };
    
    // No public replies on errors (user or infra) in simplified mode
    console.log(isInfrastructureError ? `🔧 Infrastructure error - no public reply` : `ℹ️ User error - no public reply`);
  } finally {
    console.log('═'.repeat(80) + '\n');
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

      // Debug: Log the raw API response (only if VERBOSE_LOGGING is enabled)
      if (VERBOSE_LOGGING) {
        console.log('🔍 Raw API response object:', JSON.stringify(res, null, 2));

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
            let cycleHadSuccess = false;
            for (const m of newMentions) {
              processedMentions.add(m.id);
              await processMentionQueue(twitter, m, includes);
              // Check if this mention was successfully processed AND it created an archive
              // (exclude direct assignments from "name this" commands)
              if (processedDetails[m.id]?.success === true && !processedDetails[m.id]?.directAssign) {
                cycleHadSuccess = true;
              }
              // Save state after each processed mention
              saveProcessedState(processedMentions, sinceId, processedDetails, PROCESSED_MENTIONS_FILE);
            }
            
            // Upload and assign archive index at end of cycle ONLY if there were successful archives
            if (cycleHadSuccess) {
              console.log('📤 Uploading archive index at end of cycle...');
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
            } else {
              console.log('⏭️ Skipping archive index upload - no successful archives this cycle');
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
      const msg = String(e?.message || '').toLowerCase();
      const code = e?.code ?? e?.status ?? e?.statusCode;
      if (code === 429 || msg.includes('rate limit') || msg.includes('too many requests')) {
        console.log(`⏳ Rate limited! Waiting ${POLL_INTERVAL_MINUTES} minutes for Twitter free plan reset...`);
        console.log(`📊 Rate limit details: ${e.message || 'No details'}`);
        backoffMs = POLL_INTERVAL_MS; // Use configured polling interval
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
      rootArnsName: ROOT_ARNS_NAME
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
