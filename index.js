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

const DEFAULT_TTL_SECONDS = parseInt(process.env.DEFAULT_TTL_SECONDS || '31536000', 10);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '900000', 10); // 15 minutes for free plan

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

// ---------- helpers ----------
const ARWEAVE_TXID_RE = /https?:\/\/(?:www\.)?(?:[a-z0-9-]+\.)?arweave\.net\/([A-Za-z0-9_-]{43})(?:\b|\/|\?|#)/;
const ASSIGN_CMD_RE = /\bassign\s+([a-z0-9_]{1,63})\b/i;

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
  const m = mentionText.match(ASSIGN_CMD_RE);
  return m ? m[1].toLowerCase() : null;
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
      console.log(`❌ No undername found in mention ${mention.id}`);
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

  async function pollOnce() {
    try {
      console.log(`🔍 Fetching mentions since_id: ${sinceId || 'none'}`);
      const res = await twitter.v2.userMentionTimeline(me.data.id, {
        since_id: sinceId,
        'tweet.fields': ['referenced_tweets', 'created_at', 'entities'],
        max_results: 20
      });
      console.log(`📊 API Response: ${res.data?.length || 0} mentions found`);

      const batch = res.data ?? [];
      if (batch.length) {
        console.log(`📨 Found ${batch.length} new mentions`);
        // newest first from API; remember the newest
        sinceId = batch[0].id;
        
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
        console.log(`⏳ Rate limited! Backing off for ${backoffMs/1000}s`);
        console.log(`📊 Rate limit details: ${e.message || 'No details'}`);
        backoffMs = Math.min(backoffMs * 2, 300000); // Max 5 minutes
      } else {
        console.error('poll error:', e?.message || e);
        console.error('poll error code:', e?.code);
        console.error('poll error details:', e);
      }
    }
    
    // Schedule next poll
    setTimeout(pollOnce, backoffMs);
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
