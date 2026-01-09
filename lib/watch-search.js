// Watch mode search-based polling for hashtag/mention triggered archives
// Used for community collections like #baseposting where any user can trigger an archive

import { sortOldestFirst, getTextPreview, getTweetAuthor, tweetHasMedia } from './watch-timeline.js';

/**
 * Poll for tweets matching a search query (e.g., "@NeedsArNS #baseposting")
 * Returns parent tweets (content to archive) with invoking user info
 * @param {Object} twitterClient - Twitter API client
 * @param {Object} account - Account configuration (with searchQuery)
 * @param {string|null} sinceId - Last processed tweet ID for pagination
 * @returns {Object} { posts: Array, includes: Object, newestId: string|null }
 */
export async function pollSearchResults(twitterClient, account, sinceId = null) {
  console.log(`\n🔍 Searching: ${account.searchQuery}...`);

  try {
    const searchParams = {
      'tweet.fields': ['referenced_tweets', 'created_at', 'entities', 'text', 'author_id', 'attachments', 'public_metrics', 'in_reply_to_user_id'],
      expansions: ['referenced_tweets.id', 'author_id', 'attachments.media_keys', 'referenced_tweets.id.attachments.media_keys'],
      'user.fields': ['username', 'name', 'profile_image_url', 'verified'],
      'media.fields': ['type', 'url', 'preview_image_url', 'width', 'height', 'variants', 'alt_text'],
      max_results: 100
    };

    if (sinceId) {
      searchParams.since_id = sinceId;
    }

    const res = await twitterClient.v2.search(account.searchQuery, searchParams);
    const mentionTweets = res._realData?.data ?? [];
    const includes = res._realData?.includes || {};

    if (mentionTweets.length === 0) {
      console.log(`   No new search results found`);
      return {
        posts: [],
        includes: {},
        newestId: sinceId
      };
    }

    console.log(`   Found ${mentionTweets.length} mention(s) matching query`);

    // Extract target tweets and invoking users
    const archiveTargets = [];
    const seenTargetIds = new Set(); // Dedupe by target tweet ID

    for (const mentionTweet of mentionTweets) {
      const extracted = extractParentAndInvoker(mentionTweet, includes);
      const { targetTweet, invokingUser, mentionTweetId, targetIncludes, archiveType } = extracted;

      // Dedupe: if multiple users archive the same tweet, only archive once
      if (seenTargetIds.has(targetTweet.id)) {
        console.log(`   ⏭️ Skipping duplicate - ${targetTweet.id} already queued`);
        continue;
      }
      seenTargetIds.add(targetTweet.id);

      const typeLabel = archiveType === 'reply' ? 'reply→parent' :
                        archiveType === 'quote' ? 'quote→target' : 'original';
      console.log(`   📝 [${typeLabel}] @${invokingUser.username} → tweet ${targetTweet.id}`);

      archiveTargets.push({
        tweet: targetTweet,
        invokingUser,
        mentionTweetId, // Keep reference for replying
        includes: mergeIncludes(includes, targetIncludes),
        archiveType
      });
    }

    console.log(`   📋 ${archiveTargets.length} unique tweet(s) to archive`);

    // Sort oldest first for chronological processing
    const sortedTargets = archiveTargets.sort((a, b) => {
      const dateA = new Date(a.tweet.created_at);
      const dateB = new Date(b.tweet.created_at);
      return dateA - dateB;
    });

    // Newest mention ID for pagination (from original search results, not parents)
    const newestId = mentionTweets.length > 0 ? mentionTweets[0].id : sinceId;

    return {
      posts: sortedTargets,
      includes,
      newestId
    };
  } catch (error) {
    console.error(`❌ Error searching ${account.searchQuery}: ${error.message}`);
    throw error;
  }
}

/**
 * Extract target tweet and invoking user from a mention tweet
 * Supports three modes:
 * 1. Reply → archive the parent tweet being replied to
 * 2. Quote tweet → archive the quoted tweet
 * 3. Original tweet → archive the mention tweet itself (author = invoker)
 *
 * @param {Object} mentionTweet - The tweet containing the hashtag/mention trigger
 * @param {Object} includes - Includes object from API response
 * @returns {Object} { targetTweet, invokingUser, mentionTweetId, targetIncludes, archiveType }
 */
export function extractParentAndInvoker(mentionTweet, includes) {
  // Get the invoking user (author of the mention tweet)
  const invokingUser = includes.users?.find(u => u.id === mentionTweet.author_id)
    || { id: mentionTweet.author_id, username: 'unknown', name: 'Unknown' };

  // Priority 1: Check if this is a reply
  const repliedTo = mentionTweet.referenced_tweets?.find(ref => ref.type === 'replied_to');
  if (repliedTo) {
    const parentTweet = includes.tweets?.find(t => t.id === repliedTo.id);
    if (parentTweet) {
      const targetIncludes = buildTargetIncludes(parentTweet, includes);
      return {
        targetTweet: parentTweet,
        invokingUser,
        mentionTweetId: mentionTweet.id,
        targetIncludes,
        archiveType: 'reply'
      };
    }
    console.log(`   ⚠️ Parent tweet ${repliedTo.id} not found in includes (may be deleted/protected)`);
  }

  // Priority 2: Check if this is a quote tweet
  const quoted = mentionTweet.referenced_tweets?.find(ref => ref.type === 'quoted');
  if (quoted) {
    const quotedTweet = includes.tweets?.find(t => t.id === quoted.id);
    if (quotedTweet) {
      const targetIncludes = buildTargetIncludes(quotedTweet, includes);
      return {
        targetTweet: quotedTweet,
        invokingUser,
        mentionTweetId: mentionTweet.id,
        targetIncludes,
        archiveType: 'quote'
      };
    }
    console.log(`   ⚠️ Quoted tweet ${quoted.id} not found in includes (may be deleted/protected)`);
  }

  // Priority 3: Original tweet (not a reply, not a quote) - archive the tweet itself
  // In this case, the invoking user is also the author
  const targetIncludes = buildTargetIncludes(mentionTweet, includes);
  return {
    targetTweet: mentionTweet,
    invokingUser,
    mentionTweetId: mentionTweet.id,
    targetIncludes,
    archiveType: 'original'
  };
}

/**
 * Build includes object for a target tweet
 * @param {Object} targetTweet - The tweet to build includes for
 * @param {Object} includes - Full includes object from API
 * @returns {Object} Includes specific to the target tweet
 */
function buildTargetIncludes(targetTweet, includes) {
  const author = includes.users?.find(u => u.id === targetTweet.author_id);

  const targetIncludes = {
    users: author ? [author] : [],
    media: [],
    tweets: []
  };

  // Find media for target tweet
  if (targetTweet.attachments?.media_keys) {
    for (const key of targetTweet.attachments.media_keys) {
      const media = includes.media?.find(m => m.media_key === key);
      if (media) {
        targetIncludes.media.push(media);
      }
    }
  }

  return targetIncludes;
}

/**
 * Merge includes objects (for combining parent tweet includes with main includes)
 * @param {Object} base - Base includes object
 * @param {Object} additional - Additional includes to merge
 * @returns {Object} Merged includes
 */
function mergeIncludes(base, additional) {
  if (!additional) return base;

  const merged = {
    users: [...(base.users || [])],
    media: [...(base.media || [])],
    tweets: [...(base.tweets || [])]
  };

  // Add any users not already present
  for (const user of (additional.users || [])) {
    if (!merged.users.some(u => u.id === user.id)) {
      merged.users.push(user);
    }
  }

  // Add any media not already present
  for (const media of (additional.media || [])) {
    if (!merged.media.some(m => m.media_key === media.media_key)) {
      merged.media.push(media);
    }
  }

  // Add any tweets not already present
  for (const tweet of (additional.tweets || [])) {
    if (!merged.tweets.some(t => t.id === tweet.id)) {
      merged.tweets.push(tweet);
    }
  }

  return merged;
}

/**
 * Format search result for logging
 * @param {Object} target - Archive target object { tweet, invokingUser, mentionTweetId }
 * @returns {string} Formatted string for logging
 */
export function formatSearchResultForLog(target) {
  const { tweet, invokingUser } = target;
  const preview = getTextPreview(tweet.text, 50);
  const hasMedia = tweetHasMedia(tweet) ? '📸' : '';

  return `[${tweet.id}] invoked by @${invokingUser.username}: "${preview}" ${hasMedia}`;
}
