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

// ---------- watch mode: get user tweets ----------

// Reply rate limiting for watch mode
let lastWatchReplyTime = 0;
const WATCH_REPLY_COOLDOWN_MS = 60000; // 1 minute between replies

/**
 * Get tweets from a user's timeline (for watch mode)
 * @param {Object} twitterClient - Twitter API client
 * @param {string} userId - Twitter user ID to fetch tweets from
 * @param {string|null} sinceId - Only return tweets newer than this ID
 * @param {Object} options - Additional options
 * @returns {Object} { tweets: Array, includes: Object, newestId: string|null }
 */
export async function getUserTweets(twitterClient, userId, sinceId = null, options = {}) {
  try {
    const maxResults = options.maxResults || 10; // Default to 10 tweets per poll

    const params = {
      max_results: maxResults,
      'tweet.fields': [
        'created_at',
        'author_id',
        'text',
        'entities',
        'attachments',
        'public_metrics',
        'conversation_id',
        'in_reply_to_user_id',
        'referenced_tweets'
      ].join(','),
      expansions: [
        'author_id',
        'attachments.media_keys',
        'referenced_tweets.id'
      ].join(','),
      'user.fields': [
        'username',
        'name',
        'verified',
        'profile_image_url',
        'public_metrics'
      ].join(','),
      'media.fields': [
        'type',
        'url',
        'preview_image_url',
        'width',
        'height',
        'variants',
        'alt_text'
      ].join(',')
    };

    // Only add since_id if provided
    if (sinceId) {
      params.since_id = sinceId;
    }

    console.log(`🔍 Fetching tweets for user ${userId}${sinceId ? ` since ${sinceId}` : ''}`);

    const response = await twitterClient.v2.userTimeline(userId, params);

    const tweets = response._realData?.data || [];
    const includes = response._realData?.includes || {};
    const meta = response._realData?.meta || {};

    console.log(`📊 Fetched ${tweets.length} tweet(s) from user timeline`);

    // Return newest ID for pagination
    const newestId = meta.newest_id || (tweets.length > 0 ? tweets[0].id : null);

    return {
      tweets,
      includes,
      newestId,
      meta
    };
  } catch (error) {
    console.error(`❌ Error fetching user tweets: ${error.message}`);
    throw error;
  }
}

/**
 * Send a reply in watch mode with rate limiting
 * @param {Object} twitterClient - Twitter API client
 * @param {string} tweetId - Tweet ID to reply to
 * @param {string} message - Reply message
 * @returns {string|null} Reply tweet ID or null if failed
 */
export async function sendWatchReply(twitterClient, tweetId, message) {
  try {
    // Check if we need to wait due to rate limiting
    const now = Date.now();
    const timeSinceLastReply = now - lastWatchReplyTime;

    if (timeSinceLastReply < WATCH_REPLY_COOLDOWN_MS) {
      const waitTime = WATCH_REPLY_COOLDOWN_MS - timeSinceLastReply;
      console.log(`⏳ Waiting ${Math.ceil(waitTime / 1000)}s before reply to avoid rate limits...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }

    console.log(`📤 Sending watch mode reply to tweet ${tweetId}...`);

    const replyResult = await twitterClient.v2.reply(message, tweetId);
    const replyId = replyResult.data?.id;

    lastWatchReplyTime = Date.now();

    if (replyId) {
      console.log(`✅ Watch reply sent! Reply ID: ${replyId}`);
      return replyId;
    } else {
      console.log(`⚠️ Reply appeared to succeed but no reply ID returned`);
      return null;
    }
  } catch (error) {
    // Check if we're blocked or rate limited
    if (error?.code === 403 || error?.message?.includes('blocked')) {
      console.warn(`⚠️ Cannot reply to tweet ${tweetId} - possibly blocked by user`);
    } else if (error?.code === 429) {
      console.warn(`⏳ Reply rate limited! Skipping reply...`);
      lastWatchReplyTime = Date.now() + 300000; // 5 minute cooldown
    } else {
      console.error(`❌ Watch reply failed: ${error.message}`);
    }
    return null;
  }
}

// ---------- batch fetch tweets by IDs (for pending queue re-evaluation) ----------

/**
 * Batch fetch tweets by IDs (up to 100 per request)
 * Used for re-evaluating pending posts to check updated metrics
 * @param {Object} twitterClient - Twitter API client
 * @param {string[]} tweetIds - Array of tweet IDs to fetch
 * @param {Object} options - Additional options
 * @returns {Object} { tweets: Map<id, tweet>, notFound: string[], includes: Object }
 */
export async function getTweetsByIds(twitterClient, tweetIds, options = {}) {
  if (!tweetIds || tweetIds.length === 0) {
    return { tweets: new Map(), notFound: [], includes: {} };
  }

  // Twitter API allows max 100 IDs per request
  const MAX_IDS_PER_REQUEST = 100;
  const allTweets = new Map();
  const allNotFound = [];
  let combinedIncludes = { users: [], media: [] };

  // Process in batches of 100
  for (let i = 0; i < tweetIds.length; i += MAX_IDS_PER_REQUEST) {
    const batchIds = tweetIds.slice(i, i + MAX_IDS_PER_REQUEST);

    try {
      console.log(`🔍 Batch fetching ${batchIds.length} tweet(s) by ID...`);

      const response = await twitterClient.v2.tweets(batchIds, {
        'tweet.fields': [
          'created_at',
          'author_id',
          'text',
          'entities',
          'attachments',
          'public_metrics',
          'conversation_id',
          'in_reply_to_user_id',
          'referenced_tweets'
        ].join(','),
        expansions: [
          'author_id',
          'attachments.media_keys'
        ].join(','),
        'user.fields': [
          'username',
          'name',
          'verified',
          'profile_image_url',
          'public_metrics'
        ].join(','),
        'media.fields': [
          'type',
          'url',
          'preview_image_url',
          'width',
          'height',
          'variants',
          'alt_text'
        ].join(',')
      });

      const tweets = response.data || [];
      const includes = response.includes || {};
      const errors = response.errors || [];

      // Add tweets to map
      for (const tweet of tweets) {
        allTweets.set(tweet.id, tweet);
      }

      // Track not found tweets (deleted or protected)
      for (const error of errors) {
        if (error.resource_id) {
          allNotFound.push(error.resource_id);
        }
      }

      // Merge includes
      if (includes.users) {
        combinedIncludes.users.push(...includes.users);
      }
      if (includes.media) {
        combinedIncludes.media.push(...includes.media);
      }

      console.log(`📊 Batch result: ${tweets.length} found, ${errors.length} not found`);

    } catch (error) {
      console.error(`❌ Error batch fetching tweets: ${error.message}`);

      // Check if it's a rate limit error
      if (error?.code === 429) {
        console.warn(`⏳ Rate limited on batch fetch, will retry next cycle`);
        throw error; // Re-throw to let caller handle
      }

      // For other errors, mark all IDs in this batch as not found
      allNotFound.push(...batchIds);
    }
  }

  // Deduplicate includes
  const seenUserIds = new Set();
  combinedIncludes.users = combinedIncludes.users.filter(user => {
    if (seenUserIds.has(user.id)) return false;
    seenUserIds.add(user.id);
    return true;
  });

  const seenMediaKeys = new Set();
  combinedIncludes.media = combinedIncludes.media.filter(media => {
    if (seenMediaKeys.has(media.media_key)) return false;
    seenMediaKeys.add(media.media_key);
    return true;
  });

  return {
    tweets: allTweets,
    notFound: allNotFound,
    includes: combinedIncludes
  };
}

// ---------- twitter client factory ----------
let twitterClient = null;

export function getTwitterClient(credentials) {
  if (!twitterClient) {
    twitterClient = new TwitterApi(credentials);
  }
  return twitterClient;
}
