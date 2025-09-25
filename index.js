import 'dotenv/config';
import { TwitterApi } from 'twitter-api-v2';
import { ANT, ArweaveSigner, AOProcess } from '@ar.io/sdk';
import express from 'express';

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

const DEFAULT_TTL_SECONDS = parseInt(process.env.DEFAULT_TTL_SECONDS || '60', 10); // 60 seconds minimum
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '960000', 10); // 16 minutes for free plan (with buffer)
const RATE_LIMIT_BACKOFF_MS = 960000; // 16 minutes for Twitter free plan (with buffer)

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

// Wallet address is set in .env file

// ---------- helpers ----------
const ARWEAVE_TXID_RE = /https?:\/\/(?:www\.)?(?:[a-z0-9-]+\.)?arweave\.net\/([A-Za-z0-9_-]{43})(?:\b|\/|\?|#)/;
const ASSIGN_CMD_RE = /\bassign\s+([a-z0-9_-]{1,63})\b/i;

async function fetchParentTweet(twitterClient, mention) {
  const replied = mention?.referenced_tweets?.find(t => t.type === 'replied_to');
  if (!replied) return null;
  // include entities so we can get expanded URLs (X often shows t.co)
  const parent = await twitterClient.v2.singleTweet(replied.id, {
    'tweet.fields': ['text', 'entities']
  });
  return parent?.data || null;
}

function extractTxIdFromTweetData(tweetData) {
  const text = tweetData?.text ?? '';
  const urls = tweetData?.entities?.urls ?? [];
  const expanded = urls.map(u => u.expanded_url || u.url).join(' ');
  const haystack = `${text}\n${expanded}`;
  const m = haystack.match(ARWEAVE_TXID_RE);
  return m ? m[1] : null;
}

function extractUndernameFromMention(mentionText) {
  // Replace line breaks with spaces to handle multi-line mentions
  const normalizedText = mentionText.replace(/\s+/g, ' ').trim();
  const m = normalizedText.match(ASSIGN_CMD_RE);
  if (!m) return null;
  
  const undername = m[1].toLowerCase();
  
  // Validate undername according to ArNS rules
  if (!isValidUndername(undername)) {
    return null;
  }
  
  return undername;
}

function isValidUndername(undername) {
  // 1. Valid characters: 0-9, a-z, dashes, underscores
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
async function handleMention(twitterClient, mention) {
  try {
    console.log(`🔍 Processing mention: ${mention.id} - "${mention.text}"`);
    
    // We only act when the mention is in reply to a tweet (the parent should have the link)
    const parent = await fetchParentTweet(twitterClient, mention);
    if (!parent) {
      console.log(`❌ No parent tweet found for mention ${mention.id}`);
      return;
    }
    console.log(`📝 Parent tweet found: ${parent.id} - "${parent.text}"`);

    const txId = extractTxIdFromTweetData(parent);
    if (!txId) {
      console.log(`❌ No Arweave TXID found in parent tweet ${parent.id}`);
      return;
    }
    console.log(`🔗 Extracted TXID: ${txId}`);

    const undername = extractUndernameFromMention(mention.text || '');
    if (!undername) {
      console.log(`❌ No valid undername found in mention ${mention.id}`);
      await reply(twitterClient, mention.id, `❌ Invalid undername format. Use: @NeedsArNS assign <name> (1-51 chars, a-z, 0-9, - or _)`);
      return; // require 'assign <undername>'
    }
    console.log(`🏷️ Extracted undername: ${undername}`);

    // Optional: ensure the txid resolves
    console.log(`🔍 Verifying TXID exists: ${txId}`);
    const ok = await verifyTxIdExists(txId);
    if (!ok) {
      console.log(`❌ TXID verification failed: ${txId}`);
      await reply(twitterClient, mention.id, `❌ That Arweave TXID didn't resolve: ${txId}`);
      return;
    }
    console.log(`✅ TXID verified: ${txId}`);

    // Write undername -> txid on your ArNS name
    console.log(`📝 Creating ArNS record: ${undername} → ${txId}`);
    try {
      console.log(`🔍 Using TTL: ${DEFAULT_TTL_SECONDS} seconds`);
      const { id: onchainId } = await ant.setUndernameRecord({
        undername: undername,
        transactionId: txId,
        ttlSeconds: DEFAULT_TTL_SECONDS
      });
      console.log(`✅ ArNS record created: ${onchainId}`);
    } catch (recordError) {
      if (recordError.message?.includes('already exists') || recordError.message?.includes('taken')) {
        console.log(`❌ Undername '${undername}' is already taken`);
        await reply(twitterClient, mention.id, `❌ Undername '${undername}' is already taken. Try a different name.`);
        return;
      }
      throw recordError; // Re-throw if it's a different error
    }

    const pretty = `${undername}_${OWNER_ARNS_NAME}.ar-io.dev`;
    const msg = [
      `✅ Undername assigned!`,
      `${undername}_${OWNER_ARNS_NAME}.ar-io.dev`,
      `→ ${txId}`,
      `(tx: ${onchainId})`
    ].join(' ');

    // Wait 1 minute before replying to make it feel more natural
    console.log('⏳ Waiting 1 minute before replying...');
    await new Promise(resolve => setTimeout(resolve, 60000));
    
    await reply(twitterClient, mention.id, msg);
  } catch (err) {
    console.error('handleMention error:', err?.message || err);
    await reply(twitterClient, mention.id, `❌ Failed: ${err?.message ?? 'unknown error'}`);
  }
}

// ---------- request queuing ----------
let isProcessing = false;
let isPolling = false;
const processedMentions = new Set();

async function processMentionQueue(twitterClient, mention) {
  // Wait if another mention is being processed
  while (isProcessing) {
    console.log('⏳ Waiting for previous mention to finish processing...');
    await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second
  }
  
  isProcessing = true;
  try {
    await handleMention(twitterClient, mention);
  } finally {
    isProcessing = false;
  }
}

// ---------- polling loop ----------
async function pollMentionsForever() {
  const me = await twitter.v2.me();
  console.log('Bot user id:', me.data.id, 'screen name:', me.data.username);

  let sinceId;
  let backoffMs = POLL_INTERVAL_MS;
  let isFirstPoll = true;
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
      const res = await twitter.v2.userMentionTimeline(me.data.id, {
        since_id: actualSinceId,
        'tweet.fields': ['referenced_tweets', 'created_at', 'entities'],
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
        // newest first from API; remember the newest
        sinceId = batch[0].id;
        isFirstPoll = false;
        
        // Queue mentions for processing (oldest -> newest)
        const newMentions = batch.reverse().filter(m => !processedMentions.has(m.id));
        if (newMentions.length > 0) {
          console.log(`📋 Queuing ${newMentions.length} new mentions for processing`);
          for (const m of newMentions) {
            processedMentions.add(m.id);
            await processMentionQueue(twitter, m);
          }
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
  setTimeout(() => {
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
