/**
 * Watch Mode - Engagement Filtering
 *
 * Evaluates whether posts meet engagement thresholds for archival.
 * Part of the two-phase filtering system for high-volume accounts.
 */

/**
 * Default filtering configuration
 */
export const FILTERING_DEFAULTS = {
  enabled: false,
  tier: 'none',
  thresholds: {
    minImpressions: 0,
    minLikes: 0,
    minReplies: 0,
    minRetweets: 0
  },
  alwaysArchiveMedia: true,
  archiveSelfReplies: true,
  pendingMaxAgeHours: 24
};

/**
 * Tier presets for common account sizes
 */
export const TIER_PRESETS = {
  'ultra-whale': {
    minImpressions: 500000,
    minLikes: 5000,
    minReplies: 500,
    minRetweets: 500
  },
  'large-whale': {
    minImpressions: 100000,
    minLikes: 1000,
    minReplies: 100,
    minRetweets: 100
  },
  'medium': {
    minImpressions: 10000,
    minLikes: 100,
    minReplies: 10,
    minRetweets: 10
  },
  'small': {
    minImpressions: 1000,
    minLikes: 10,
    minReplies: 5,
    minRetweets: 5
  },
  'none': {
    minImpressions: 0,
    minLikes: 0,
    minReplies: 0,
    minRetweets: 0
  }
};

/**
 * Extract engagement metrics from a tweet object
 * @param {Object} tweet - Tweet object from Twitter API
 * @returns {Object} Extracted metrics
 */
export function extractMetrics(tweet) {
  const pm = tweet.public_metrics || {};
  return {
    impressions: pm.impression_count || 0,
    likes: pm.like_count || 0,
    replies: pm.reply_count || 0,
    retweets: pm.retweet_count || 0
  };
}

/**
 * Check if a tweet has media attachments
 * @param {Object} tweet - Tweet object
 * @param {Object} includes - Twitter API includes object
 * @returns {boolean}
 */
export function hasMedia(tweet, includes) {
  if (!tweet.attachments?.media_keys?.length) {
    return false;
  }

  // Verify media exists in includes
  if (!includes?.media?.length) {
    return false;
  }

  const mediaKeys = new Set(tweet.attachments.media_keys);
  return includes.media.some(m => mediaKeys.has(m.media_key));
}

/**
 * Check if a tweet is a self-reply (reply to own tweet)
 * @param {Object} tweet - Tweet object
 * @param {string} accountUserId - The watched account's user ID
 * @returns {Object} { isSelfReply: boolean, parentPostId: string | null }
 */
export function isSelfReply(tweet, accountUserId) {
  // Check if this is a reply
  if (!tweet.in_reply_to_user_id) {
    return { isSelfReply: false, parentPostId: null };
  }

  // Check if replying to self
  if (tweet.in_reply_to_user_id !== accountUserId) {
    return { isSelfReply: false, parentPostId: null };
  }

  // Find the parent tweet ID from referenced_tweets
  const replyRef = tweet.referenced_tweets?.find(ref => ref.type === 'replied_to');
  const parentPostId = replyRef?.id || null;

  return {
    isSelfReply: true,
    parentPostId
  };
}

/**
 * Check if metrics meet engagement thresholds
 * @param {Object} metrics - { impressions, likes, replies, retweets }
 * @param {Object} thresholds - { minImpressions, minLikes, minReplies, minRetweets }
 * @returns {Object} { meets: boolean, reasons: string[] }
 */
export function meetsEngagementThresholds(metrics, thresholds) {
  const reasons = [];

  if (thresholds.minImpressions > 0 && metrics.impressions >= thresholds.minImpressions) {
    reasons.push(`impressions: ${metrics.impressions.toLocaleString()}`);
  }

  if (thresholds.minLikes > 0 && metrics.likes >= thresholds.minLikes) {
    reasons.push(`likes: ${metrics.likes.toLocaleString()}`);
  }

  if (thresholds.minReplies > 0 && metrics.replies >= thresholds.minReplies) {
    reasons.push(`replies: ${metrics.replies.toLocaleString()}`);
  }

  if (thresholds.minRetweets > 0 && metrics.retweets >= thresholds.minRetweets) {
    reasons.push(`retweets: ${metrics.retweets.toLocaleString()}`);
  }

  // If all thresholds are 0, everything meets criteria
  const allZero = thresholds.minImpressions === 0 &&
                  thresholds.minLikes === 0 &&
                  thresholds.minReplies === 0 &&
                  thresholds.minRetweets === 0;

  return {
    meets: allZero || reasons.length > 0,
    reasons
  };
}

/**
 * Determine if a post should be archived immediately
 * @param {Object} tweet - Tweet object from Twitter API
 * @param {Object} account - Account configuration with filtering settings
 * @param {Object} includes - Twitter API includes object
 * @returns {Object} { archive: boolean, reason: string, pending: boolean }
 */
export function shouldArchiveImmediately(tweet, account, includes) {
  const filtering = account.filtering || FILTERING_DEFAULTS;

  // If filtering is disabled, archive everything
  if (!filtering.enabled) {
    return {
      archive: true,
      reason: 'filtering_disabled',
      pending: false
    };
  }

  // Always archive posts with media if configured
  if (filtering.alwaysArchiveMedia && hasMedia(tweet, includes)) {
    return {
      archive: true,
      reason: 'has_media',
      pending: false
    };
  }

  // Check engagement thresholds
  const metrics = extractMetrics(tweet);
  const thresholds = filtering.thresholds || FILTERING_DEFAULTS.thresholds;
  const thresholdResult = meetsEngagementThresholds(metrics, thresholds);

  if (thresholdResult.meets) {
    return {
      archive: true,
      reason: `meets_threshold: ${thresholdResult.reasons.join(', ')}`,
      pending: false
    };
  }

  // Doesn't meet criteria - add to pending queue
  return {
    archive: false,
    reason: 'below_threshold',
    pending: true,
    metrics
  };
}

/**
 * Format metrics for logging
 * @param {Object} metrics - Engagement metrics
 * @returns {string} Formatted string
 */
export function formatMetricsForLog(metrics) {
  const parts = [];
  if (metrics.impressions > 0) parts.push(`${metrics.impressions.toLocaleString()} views`);
  if (metrics.likes > 0) parts.push(`${metrics.likes.toLocaleString()} likes`);
  if (metrics.replies > 0) parts.push(`${metrics.replies.toLocaleString()} replies`);
  if (metrics.retweets > 0) parts.push(`${metrics.retweets.toLocaleString()} RTs`);
  return parts.length > 0 ? parts.join(', ') : 'no engagement';
}
