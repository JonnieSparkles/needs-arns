// Twitter API utilities

import { TwitterApi } from 'twitter-api-v2';

// ---------- twitter functions ----------
export async function reply(twitterClient, inReplyTo, body) {
  try {
    console.log(`📤 Attempting to send reply to tweet ${inReplyTo}...`);
    console.log(`📝 Reply message (${body.length} chars): ${body.substring(0, 200)}${body.length > 200 ? '...' : ''}`);

    const replyResult = await twitterClient.v2.reply(body, inReplyTo);
    const replyId = replyResult.data?.id;

    if (replyId) {
      console.log(`✅ Reply sent successfully! Reply tweet ID: ${replyId}`);
      console.log(`🔗 https://twitter.com/i/web/status/${replyId}`);
    } else {
      console.log(`⚠️ Reply appeared to succeed but no reply ID returned`);
      console.log(`📋 Full result:`, JSON.stringify(replyResult, null, 2));
    }

    return replyId; // Return the reply tweet ID
  } catch (e) {
    console.error(`❌ Reply failed to tweet ${inReplyTo}`);
    console.error(`❌ Error message: ${e?.message || e}`);
    console.error(`❌ Error code: ${e?.code}`);
    console.error(`❌ Error data:`, JSON.stringify(e?.data || {}, null, 2));
    return null;
  }
}

// Retweet rate limiting
let lastRetweetTime = 0;
const RETWEET_COOLDOWN_MS = 60000; // 1 minute between retweets

export async function retweet(twitterClient, tweetId, botUserId) {
  try {
    // Check if we need to wait due to rate limiting
    const now = Date.now();
    const timeSinceLastRetweet = now - lastRetweetTime;
    
    if (timeSinceLastRetweet < RETWEET_COOLDOWN_MS) {
      const waitTime = RETWEET_COOLDOWN_MS - timeSinceLastRetweet;
      console.log(`⏳ Waiting ${Math.ceil(waitTime/1000)}s before retweet to avoid rate limits...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    await twitterClient.v2.retweet(botUserId, tweetId);
    lastRetweetTime = Date.now();
    console.log(`🔄 Retweeted: ${tweetId}`);
  } catch (e) {
    if (e?.code === 429) {
      console.log(`⏳ Retweet rate limited! Will skip retweets for 5 minutes...`);
      // Set a longer cooldown to avoid repeated 429s
      lastRetweetTime = Date.now() + 300000; // 5 minutes
    } else {
      console.error('retweet error:', e?.message || e);
    }
  }
}

// ---------- twitter client factory ----------
let twitterClient = null;

export function getTwitterClient(credentials) {
  if (!twitterClient) {
    twitterClient = new TwitterApi(credentials);
  }
  return twitterClient;
}
