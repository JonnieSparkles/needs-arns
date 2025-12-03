// Watch mode timeline polling and filtering

import { getUserTweets } from './twitter.js';

/**
 * Poll a watched account's timeline for new posts
 * @param {Object} twitterClient - Twitter API client
 * @param {Object} account - Account configuration
 * @param {string|null} lastTweetId - Last processed tweet ID
 * @returns {Object} { posts: Array, includes: Object, newestId: string|null }
 */
export async function pollAccountTimeline(twitterClient, account, lastTweetId = null) {
  console.log(`\n📡 Polling @${account.twitterUsername}...`);

  try {
    const result = await getUserTweets(
      twitterClient,
      account.twitterUserId,
      lastTweetId,
      { maxResults: 10 }
    );

    if (result.tweets.length === 0) {
      console.log(`   No new tweets found`);
      return {
        posts: [],
        includes: result.includes,
        newestId: lastTweetId // Keep the same since_id
      };
    }

    // Filter to only original posts and self-replies (not replies to others, not retweets)
    const originalPosts = filterOriginalPosts(result.tweets, account.twitterUserId);

    console.log(`   Found ${result.tweets.length} tweet(s), ${originalPosts.length} original post(s)`);

    // Sort oldest first for processing (API returns newest first)
    const sortedPosts = sortOldestFirst(originalPosts);

    return {
      posts: sortedPosts,
      includes: result.includes,
      newestId: result.newestId
    };
  } catch (error) {
    console.error(`❌ Error polling @${account.twitterUsername}: ${error.message}`);
    throw error;
  }
}

/**
 * Filter tweets to only include original posts and self-replies
 * Excludes: replies to others, retweets, quote tweets
 * Includes: original posts, self-replies (for thread detection)
 * @param {Array} tweets - Array of tweet objects
 * @param {string} accountUserId - The watched account's user ID (for self-reply detection)
 * @returns {Array} Filtered array of original posts and self-replies
 */
export function filterOriginalPosts(tweets, accountUserId = null) {
  return tweets.filter(tweet => {
    // Exclude retweets and quote tweets first
    if (tweet.referenced_tweets && tweet.referenced_tweets.length > 0) {
      const hasRetweet = tweet.referenced_tweets.some(ref => ref.type === 'retweeted');
      const hasQuote = tweet.referenced_tweets.some(ref => ref.type === 'quoted');

      if (hasRetweet) {
        return false;
      }

      // For v1, also exclude quote tweets
      // Future versions may include quote tweets with meaningful content
      if (hasQuote) {
        return false;
      }
    }

    // Check if this is a reply
    if (tweet.in_reply_to_user_id) {
      // If we have the account user ID, allow self-replies (threads)
      if (accountUserId && tweet.in_reply_to_user_id === accountUserId) {
        return true; // Keep self-replies for thread detection
      }
      // Exclude replies to others
      return false;
    }

    return true;
  });
}

/**
 * Sort tweets from oldest to newest (for chronological processing)
 * @param {Array} tweets - Array of tweet objects (newest first from API)
 * @returns {Array} Same tweets sorted oldest first
 */
export function sortOldestFirst(tweets) {
  return [...tweets].sort((a, b) => {
    // Compare by ID (Twitter IDs are sortable as strings for same-length IDs)
    // Or use created_at for more reliability
    const dateA = new Date(a.created_at);
    const dateB = new Date(b.created_at);
    return dateA - dateB;
  });
}

/**
 * Check if a tweet has media attachments
 * @param {Object} tweet - Tweet object
 * @returns {boolean} True if tweet has media
 */
export function tweetHasMedia(tweet) {
  return !!(tweet.attachments && tweet.attachments.media_keys && tweet.attachments.media_keys.length > 0);
}

/**
 * Get media objects for a tweet from includes
 * @param {Object} tweet - Tweet object
 * @param {Object} includes - Includes object from API response
 * @returns {Array} Array of media objects
 */
export function getTweetMedia(tweet, includes) {
  if (!tweetHasMedia(tweet) || !includes.media) {
    return [];
  }

  const mediaKeys = tweet.attachments.media_keys;
  return mediaKeys
    .map(key => includes.media.find(m => m.media_key === key))
    .filter(Boolean);
}

/**
 * Get author info for a tweet from includes
 * @param {Object} tweet - Tweet object
 * @param {Object} includes - Includes object from API response
 * @returns {Object|null} User object or null
 */
export function getTweetAuthor(tweet, includes) {
  if (!tweet.author_id || !includes.users) {
    return null;
  }

  return includes.users.find(u => u.id === tweet.author_id) || null;
}

/**
 * Extract text preview from tweet (truncated for index)
 * @param {string} text - Full tweet text
 * @param {number} maxLength - Maximum length for preview
 * @returns {string} Truncated text with ellipsis if needed
 */
export function getTextPreview(text, maxLength = 100) {
  if (!text) return '';

  // Remove t.co URLs for cleaner preview
  const cleanedText = text.replace(/https?:\/\/t\.co\/\w+/g, '').trim();

  if (cleanedText.length <= maxLength) {
    return cleanedText;
  }

  return cleanedText.substring(0, maxLength - 3) + '...';
}

/**
 * Format tweet data for logging
 * @param {Object} tweet - Tweet object
 * @param {Object} includes - Includes object
 * @returns {string} Formatted string for logging
 */
export function formatTweetForLog(tweet, includes) {
  const author = getTweetAuthor(tweet, includes);
  const username = author?.username || 'unknown';
  const preview = getTextPreview(tweet.text, 50);
  const hasMedia = tweetHasMedia(tweet) ? '📸' : '';

  return `[${tweet.id}] @${username}: "${preview}" ${hasMedia}`;
}
