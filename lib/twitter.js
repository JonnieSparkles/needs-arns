// Twitter API utilities

import { TwitterApi } from 'twitter-api-v2';

// ---------- twitter functions ----------
export async function reply(twitterClient, inReplyTo, body) {
  try {
    const replyResult = await twitterClient.v2.reply(body, inReplyTo);
    return replyResult.data?.id; // Return the reply tweet ID
  } catch (e) {
    console.error('reply error:', e?.message || e);
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
