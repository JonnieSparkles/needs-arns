import 'dotenv/config';
import { TwitterApi } from 'twitter-api-v2';
import { ANT, ArweaveSigner, AOProcess } from '@ar.io/sdk';
import { TurboFactory, ArweaveSigner as TurboArweaveSigner } from '@ardrive/turbo-sdk';
import express from 'express';
import fs from 'fs';

// ---------- config & env ----------
function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env: ${name}`);
  return v;
}

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

console.log('🔍 DEBUG: process.env.DEFAULT_TTL_SECONDS =', process.env.DEFAULT_TTL_SECONDS);
const DEFAULT_TTL_SECONDS = parseInt(process.env.DEFAULT_TTL_SECONDS || '60', 10); // 60 seconds minimum
console.log('🔍 DEBUG: DEFAULT_TTL_SECONDS =', DEFAULT_TTL_SECONDS);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '960000', 10); // 16 minutes for free plan (with buffer)
const RATE_LIMIT_BACKOFF_MS = 960000; // 16 minutes for Twitter free plan (with buffer)

// Bot user ID (known from previous runs)
const BOT_USER_ID = '1971034918240256000';
console.log('Bot user id:', BOT_USER_ID, 'screen name: NeedsArNS');

// Access control - comma-separated list of allowed usernames (without @)
const ALLOWED_USERS = process.env.ALLOWED_USERS ? process.env.ALLOWED_USERS.split(',').map(u => u.trim().toLowerCase()) : [];
console.log('🔐 Access control enabled for users:', ALLOWED_USERS.length > 0 ? ALLOWED_USERS : 'ALL USERS (no restrictions)');

// Time-based filtering - ignore mentions older than X hours
const MENTION_MAX_AGE_HOURS = parseInt(process.env.MENTION_MAX_AGE_HOURS || '24', 10);
console.log(`⏰ Time filter: ignoring mentions older than ${MENTION_MAX_AGE_HOURS} hours`);

// Persistent storage
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '.';
const PROCESSED_MENTIONS_FILE = `${DATA_DIR}/processed_mentions.json`;

function saveProcessedState(processedMentions, sinceId, processedDetails = {}) {
  try {
    const state = {
      processedMentions: Array.from(processedMentions),
      processedDetails: processedDetails, // { mentionId: { undername, txId, success, timestamp, username } }
      lastSinceId: sinceId,
      lastUpdated: new Date().toISOString(),
      version: '1.1'
    };
    fs.writeFileSync(PROCESSED_MENTIONS_FILE, JSON.stringify(state, null, 2));
    console.log(`💾 Saved state: ${state.processedMentions.length} processed mentions, since_id: ${sinceId || 'none'}`);
  } catch (err) {
    console.error('❌ Failed to save processed state:', err.message);
  }
}

function loadProcessedState() {
  try {
    if (!fs.existsSync(PROCESSED_MENTIONS_FILE)) {
      console.log('📂 No existing state file found, starting fresh');
      return { processedMentions: new Set(), sinceId: undefined, processedDetails: {} };
    }
    
    const data = fs.readFileSync(PROCESSED_MENTIONS_FILE, 'utf8');
    const state = JSON.parse(data);
    
    const processedMentions = new Set(state.processedMentions || []);
    const sinceId = state.lastSinceId;
    const processedDetails = state.processedDetails || {};
    
    console.log(`📂 Loaded state: ${processedMentions.size} processed mentions, since_id: ${sinceId || 'none'}`);
    console.log(`📅 Last updated: ${state.lastUpdated || 'unknown'}`);
    
    return { processedMentions, sinceId, processedDetails };
  } catch (err) {
    console.error('❌ Failed to load processed state:', err.message);
    console.log('📂 Starting fresh due to load error');
    return { processedMentions: new Set(), sinceId: undefined, processedDetails: {} };
  }
}

// ---------- wallet ----------
function getJwkFromEnv() {
  if (process.env.ARWEAVE_JWK_JSON) {
    return JSON.parse(process.env.ARWEAVE_JWK_JSON);
  }
  if (process.env.ARWEAVE_JWK_B64) {
    const json = Buffer.from(process.env.ARWEAVE_JWK_B64, 'base64').toString('utf8');
    return JSON.parse(json);
  }
  throw new Error('Provide ARWEAVE_JWK_JSON or ARWEAVE_JWK_B64');
}

// ---------- clients ----------
const twitter = new TwitterApi({
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
const turbo = TurboFactory.authenticated({ 
  signer: new TurboArweaveSigner(jwk) 
});

// Wallet address is set in .env file

// ---------- helpers ----------
const ARWEAVE_TXID_RE = /https?:\/\/[^\s\/]+\/([A-Za-z0-9_-]{43})(?:\b|\/|\?|#)/;
const ASSIGN_CMD_RE = /\bassign\s+([a-z0-9_-]{1,63})\b/i;

function fetchParentTweet(includes, mention) {
  const replied = mention?.referenced_tweets?.find(t => t.type === 'replied_to');
  if (!replied) return null;
  // Find the parent tweet in the includes data (no API call needed!)
  const parent = includes?.tweets?.find(t => t.id === replied.id);
  return parent || null;
}

function extractTxIdFromTweetData(tweetData) {
  const text = tweetData?.text ?? '';
  const urls = tweetData?.entities?.urls ?? [];
  const expanded = urls.map(u => u.expanded_url || u.url).join(' ');
  const haystack = `${text}\n${expanded}`;
  const m = haystack.match(ARWEAVE_TXID_RE);
  return m ? m[1] : null;
}

function hasMediaAttachments(tweetData) {
  return tweetData.attachments?.media_keys?.length > 0;
}

function getMediaUrls(tweetData, includes) {
  if (!hasMediaAttachments(tweetData)) return [];
  
  const mediaKeys = tweetData.attachments.media_keys;
  const mediaObjects = includes?.media || [];
  
  console.log(`🔍 DEBUG: Media keys in tweet: ${JSON.stringify(mediaKeys)}`);
  console.log(`🔍 DEBUG: Media objects in includes: ${JSON.stringify(mediaObjects)}`);
  
  return mediaKeys.map(key => {
    const mediaObj = mediaObjects.find(m => m.media_key === key);
    if (!mediaObj) {
      console.log(`❌ DEBUG: No media object found for key: ${key}`);
      return null;
    }
    
    console.log(`✅ DEBUG: Found media object: ${JSON.stringify(mediaObj)}`);
    
    // Return the highest quality URL available
    return {
      url: mediaObj.url || mediaObj.preview_image_url,
      type: mediaObj.type,
      width: mediaObj.width,
      height: mediaObj.height,
      media_key: key
    };
  }).filter(Boolean);
}

async function downloadMedia(mediaUrl) {
  try {
    console.log(`📥 Downloading media from: ${mediaUrl}`);
    const response = await fetch(mediaUrl);
    
    if (!response.ok) {
      throw new Error(`Failed to download media: ${response.status} ${response.statusText}`);
    }
    
    const buffer = await response.arrayBuffer();
    console.log(`✅ Downloaded ${buffer.byteLength} bytes`);
    return Buffer.from(buffer);
  } catch (error) {
    console.error(`❌ Media download failed:`, error);
    throw error;
  }
}

async function uploadToArweave(mediaBuffer, contentType = 'application/octet-stream') {
  try {
    console.log(`☁️ Uploading ${mediaBuffer.length} bytes to Arweave via Turbo...`);
    
    // Check Turbo balance first
    const balance = await turbo.getBalance();
    console.log(`💰 Turbo balance: ${balance.winc} winc`);
    
    // Upload file
    const uploadResult = await turbo.uploadFile({
      fileStreamFactory: () => Buffer.from(mediaBuffer),
      fileSizeFactory: () => mediaBuffer.length,
      dataItemOpts: {
        tags: [
          { name: 'Content-Type', value: contentType },
          { name: 'App-Name', value: 'NeedsArNS-Bot' },
          { name: 'App-Version', value: '1.0.0' }
        ]
      }
    });
    
    console.log(`✅ Uploaded to Arweave: ${uploadResult.id}`);
    console.log(`💸 Cost: ${uploadResult.winc} winc`);
    
    return uploadResult.id;
  } catch (error) {
    console.error(`❌ Arweave upload failed:`, error);
    throw error;
  }
}

function isUserAllowed(mention, includes) {
  // If no access control is configured, allow all users
  if (ALLOWED_USERS.length === 0) {
    return true;
  }
  
  // Find the author info from the includes.users data
  const authorId = mention.author_id;
  const author = includes?.users?.find(u => u.id === authorId);
  
  if (!author || !author.username) {
    console.log(`⚠️ Could not determine username for mention ${mention.id}`);
    return false; // Deny if we can't identify the user
  }
  
  const username = author.username.toLowerCase();
  const isAllowed = ALLOWED_USERS.includes(username);
  
  console.log(`🔐 Access check: @${username} ${isAllowed ? '✅ ALLOWED' : '❌ DENIED'}`);
  return isAllowed;
}

function extractCommandFromMention(mentionText) {
  // Replace line breaks with spaces to handle multi-line mentions
  const normalizedText = mentionText.replace(/\s+/g, ' ').trim();
  
  // Check if this is a valid command format: contains @NeedsArNS anywhere (handles Twitter auto-mentions)
  const containsBot = /@NeedsArNS\b/i.test(normalizedText);
  if (!containsBot) {
    console.log(`🚫 Not a bot command: "${normalizedText}"`);
    return null; // Not a command to our bot
  }
  
  // Check for help command
  if (/\bhelp\b/i.test(normalizedText)) {
    console.log(`✅ Help command detected`);
    return { type: 'help' };
  }
  
  const m = normalizedText.match(ASSIGN_CMD_RE);
  if (!m) return null;
  
  const undername = m[1].toLowerCase();
  
  // Validate undername according to ArNS rules (after converting to lowercase)
  if (!isValidUndername(undername)) {
    return null;
  }
  
  return { type: 'assign', undername };
}

function isValidUndername(undername) {
  // 1. Valid characters: 0-9, a-z, dashes, underscores (lowercase only)
  if (!/^[a-z0-9_-]+$/.test(undername)) {
    return false;
  }
  
  // 2. Dashes and underscores cannot be leading or trailing
  if (undername.startsWith('-') || undername.startsWith('_') || 
      undername.endsWith('-') || undername.endsWith('_')) {
    return false;
  }
  
  // 3. Dashes and underscores cannot be used in single character domains
  if (undername.length === 1 && (undername.includes('-') || undername.includes('_'))) {
    return false;
  }
  
  // 4. 1 character minimum, 51 characters maximum
  if (undername.length < 1 || undername.length > 51) {
    return false;
  }
  
  return true;
}

async function reply(twitterClient, inReplyTo, body) {
  try {
    await twitterClient.v2.reply(body, inReplyTo);
  } catch (e) {
    console.error('reply error:', e?.message || e);
  }
}

async function verifyTxIdExists(txid) {
  // lightweight check via a HEAD request to a public gateway (optional)
  // To keep deps minimal we use fetch; Node 18+ has global fetch.
  try {
    const res = await fetch(`https://arweave.net/${txid}`, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false; // network hiccup → don’t hard fail; you can choose to skip this.
  }
}

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
    
    console.log(`🔍 Processing mention: ${mention.id} - "${mention.text}"`);
    
    // Handle help command
    if (command.type === 'help') {
      const helpMsg = [
        `🤖 @NeedsArNS Bot Commands:`,
        ``,
        `📸 @NeedsArNS assign <name> (reply to media)`,
        `🔗 @NeedsArNS assign <name> (reply to Arweave link)`,
        ``,
        `💳 Credit sharing: Coming soon!`,
        `🏠 Homepage: needsarns.ar.io`,
        ``,
        `Powered by @ArNSdomains`
      ].join('\n');
      
      await reply(twitterClient, mention.id, helpMsg);
      return;
    }
    
    const undername = command.undername;
    console.log(`🏷️ Extracted undername: ${undername}`);
    
    // Check access control
    if (!isUserAllowed(mention, includes)) {
      // Record denied access attempt
      processedDetails[mention.id] = {
        username: username,
        success: false,
        reason: 'access_denied',
        timestamp: new Date().toISOString()
      };
      
      const denialMsg = [
        `👋 Thanks for your interest!`,
        `🚧 ArNS assignment is currently in private beta.`,
        ``,
        `Stay tuned for updates! 🔔`,
        ``,
        `Powered by @ArNSdomains`
      ].join('\n');
      
      await reply(twitterClient, mention.id, denialMsg);
      return;
    }
    
    // We only act when the mention is in reply to a tweet (the parent should have the link)
    const parent = fetchParentTweet(includes, mention);
    if (!parent) {
      console.log(`❌ No parent tweet found for mention ${mention.id}`);
      return;
    }
    console.log(`📝 Parent tweet found: ${parent.id} - "${parent.text}"`);

    // Check for existing Arweave links first (faster, cheaper)
    let txId = extractTxIdFromTweetData(parent);
    let isUploadedMedia = false;
    
    if (txId) {
      // Handle existing Arweave link flow (PRIORITY)
      console.log(`🔗 Found existing Arweave TXID: ${txId}`);
      
      // Verify existing TXID
      console.log(`🔍 Verifying TXID exists: ${txId}`);
      const ok = await verifyTxIdExists(txId);
      if (!ok) {
        console.log(`❌ TXID verification failed: ${txId}`);
        await reply(twitterClient, mention.id, `❌ That Arweave TXID didn't resolve: ${txId}`);
        return;
      }
      console.log(`✅ TXID verified: ${txId}`);
      
    } else if (hasMediaAttachments(parent)) {
      // Fallback: Handle media upload flow
      console.log(`📱 No Arweave link found, checking for media attachments`);
      const mediaUrls = getMediaUrls(parent, includes);
      
      if (mediaUrls.length === 0) {
        console.log(`❌ No accessible media URLs found in parent tweet ${parent.id}`);
        await reply(twitterClient, mention.id, `❌ Could not access media in the parent tweet. Please try again.`);
        return;
      }
      
      // Use the first media attachment
      const media = mediaUrls[0];
      console.log(`📸 Processing ${media.type} media: ${media.url}`);
      
      try {
        // Download and upload media
        const mediaBuffer = await downloadMedia(media.url);
        const contentType = media.type === 'photo' ? 'image/jpeg' : 
                           media.type === 'video' ? 'video/mp4' : 
                           'application/octet-stream';
        
        txId = await uploadToArweave(mediaBuffer, contentType);
        isUploadedMedia = true;
        console.log(`✅ Media uploaded to Arweave: ${txId}`);
        
      } catch (uploadError) {
        console.error(`❌ Failed to upload media:`, uploadError);
        await reply(twitterClient, mention.id, `❌ Failed to upload media to Arweave: ${uploadError.message}`);
        return;
      }
      
    } else {
      // No Arweave link AND no media found
      console.log(`❌ No Arweave TXID or media found in parent tweet ${parent.id}`);
      await reply(twitterClient, mention.id, `❌ Parent tweet must contain either an Arweave link or media attachment.`);
      return;
    }

    // Check if undername already exists first
    console.log(`🔍 Checking if undername already exists: ${undername}`);
    try {
      const existingRecords = await ant.getRecords();
      if (existingRecords && existingRecords[undername]) {
        console.log(`❌ Undername '${undername}' already exists, pointing to: ${existingRecords[undername].transactionId}`);
        
        // Record failed assignment (name taken)
        processedDetails[mention.id] = {
          username: username,
          undername: undername,
          txId: txId,
          success: false,
          reason: 'undername_taken',
          timestamp: new Date().toISOString()
        };
        
        await reply(twitterClient, mention.id, `❌ Undername '${undername}' is already taken. Try a different name.`);
        return;
      }
      console.log(`✅ Undername '${undername}' is available`);
    } catch (checkError) {
      console.log(`⚠️ Could not check existing records, proceeding with creation: ${checkError.message}`);
      // If we can't check, proceed with creation and let the original error handling catch duplicates
    }

    // Write undername -> txid on your ArNS name
    console.log(`📝 Creating ArNS record: ${undername} → ${txId}`);
    let onchainId;
    try {
      console.log(`🔍 Using TTL: ${DEFAULT_TTL_SECONDS} seconds`);
      const result = await ant.setUndernameRecord({
        undername: undername,
        transactionId: txId,
        ttlSeconds: DEFAULT_TTL_SECONDS
      });
      onchainId = result.id;
      console.log(`✅ ArNS record created: ${onchainId}`);
      
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
      
    } catch (recordError) {
      if (recordError.message?.includes('already exists') || recordError.message?.includes('taken')) {
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
        
        await reply(twitterClient, mention.id, `❌ Undername '${undername}' is already taken. Try a different name.`);
        return;
      }
      throw recordError; // Re-throw if it's a different error
    }

    const msg = [
      isUploadedMedia ? `🎉 Success! Your content is now permanently stored on Arweave!` : `🎉 Success! Your content is now permanently named!`,
      ``,
      isUploadedMedia ? `📸 Media uploaded & named: ${undername}` : `🔗 Link assigned: ${undername}`,
      ``,
      `🌐 https://${undername}_${OWNER_ARNS_NAME}.ar.io`,
      `🔗 ar://${undername}_${OWNER_ARNS_NAME}`,
      `📋 ${txId}`,
      ``,
      `✨ Powered by @ArNSdomains`
    ].join('\n');
    
    // Check Twitter character limit (280 characters)
    if (msg.length > 280) {
      console.log(`⚠️ Message too long (${msg.length} chars), truncating...`);
      const truncatedMsg = [
        isUploadedMedia ? `🎉 Media uploaded & named: ${undername}` : `🎉 Link assigned: ${undername}`,
        ``,
        `🌐 https://${undername}_${OWNER_ARNS_NAME}.ar.io`,
        `📋 ${txId}`,
        ``,
        `✨ Powered by @ArNSdomains`
      ].join('\n');
      
      if (truncatedMsg.length > 280) {
        // If still too long, use minimal message
        const minimalMsg = `🎉 ${undername}_${OWNER_ARNS_NAME}.ar.io → ${txId}`;
        console.log(`⚠️ Using minimal message (${minimalMsg.length} chars)`);
        await reply(twitterClient, mention.id, minimalMsg);
        return;
      }
      
      console.log(`✅ Using truncated message (${truncatedMsg.length} chars)`);
      await reply(twitterClient, mention.id, truncatedMsg);
      return;
    }

    // Wait 1 minute before replying to make it feel more natural
    console.log('⏳ Waiting 1 minute before replying...');
    await new Promise(resolve => setTimeout(resolve, 60000));

    await reply(twitterClient, mention.id, msg);
  } catch (err) {
    console.error('handleMention error:', err?.message || err);
    
    // Record failed assignment (error)
    processedDetails[mention.id] = {
      username: username,
      success: false,
      reason: 'error',
      error: err?.message || 'unknown error',
      timestamp: new Date().toISOString()
    };
    
    await reply(twitterClient, mention.id, `❌ Failed: ${err?.message ?? 'unknown error'}`);
  }
}

// ---------- request queuing ----------
let isProcessing = false;
let isPolling = false;

// Load persistent state on startup
const { processedMentions, sinceId: initialSinceId, processedDetails } = loadProcessedState();

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
      'tweet.fields': ['referenced_tweets', 'created_at', 'entities', 'text', 'author_id', 'attachments'],
      expansions: ['referenced_tweets.id', 'author_id', 'attachments.media_keys', 'referenced_tweets.id.attachments.media_keys'],
      'user.fields': ['username'],
      'media.fields': ['type', 'url', 'preview_image_url', 'width', 'height'],
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
          saveProcessedState(processedMentions, sinceId, processedDetails);
          
          // Queue mentions for processing (oldest -> newest)
          const newMentions = recentMentions.reverse().filter(m => !processedMentions.has(m.id));
          if (newMentions.length > 0) {
            console.log(`📋 Queuing ${newMentions.length} new mentions for processing`);
            const includes = res._realData?.includes || {};
            for (const m of newMentions) {
              processedMentions.add(m.id);
              await processMentionQueue(twitter, m, includes);
            // Save state after each processed mention
            saveProcessedState(processedMentions, sinceId, processedDetails);
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
