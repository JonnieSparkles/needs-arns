/**
 * Watch Mode - Pending Queue Management
 *
 * Manages the pending posts queue for two-phase engagement filtering.
 * Posts that don't meet initial thresholds are held in pending state
 * and re-evaluated periodically until they meet thresholds or expire.
 */

import fs from 'fs';
import path from 'path';

const PENDING_STATE_VERSION = '1.0';

/**
 * Get default pending state path
 * @returns {string} Path to pending state file
 */
export function getDefaultPendingStatePath() {
  const baseDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || '.';
  return path.join(baseDir, 'watch-pending-state.json');
}

/**
 * Create empty pending state
 * @returns {Object} Empty state object
 */
function createEmptyState() {
  return {
    version: PENDING_STATE_VERSION,
    lastUpdated: new Date().toISOString(),
    pending: {}
  };
}

/**
 * Load pending state from disk
 * @param {string} statePath - Path to state file
 * @returns {Object} Pending state object
 */
export function loadPendingState(statePath) {
  try {
    if (!fs.existsSync(statePath)) {
      return createEmptyState();
    }
    const data = fs.readFileSync(statePath, 'utf8');
    const state = JSON.parse(data);

    // Ensure pending object exists
    if (!state.pending) {
      state.pending = {};
    }

    return state;
  } catch (error) {
    console.warn(`⚠️ Could not load pending state: ${error.message}`);
    return createEmptyState();
  }
}

/**
 * Save pending state to disk (atomic write)
 * @param {Object} state - Pending state object
 * @param {string} statePath - Path to state file
 */
export function savePendingState(state, statePath) {
  state.lastUpdated = new Date().toISOString();

  const tempPath = statePath + '.tmp';
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2));
  fs.renameSync(tempPath, statePath);
}

/**
 * Create a pending post entry
 * @param {Object} tweet - Tweet object from Twitter API
 * @param {Object} metrics - Extracted metrics { impressions, likes, replies, retweets }
 * @param {boolean} hasMedia - Whether the post has media
 * @returns {Object} Pending post entry
 */
export function createPendingEntry(tweet, metrics, hasMedia = false) {
  const now = new Date().toISOString();
  return {
    postId: tweet.id,
    detectedAt: now,
    lastCheckedAt: now,
    checkCount: 1,
    initialMetrics: { ...metrics },
    latestMetrics: { ...metrics },
    hasMedia,
    text: (tweet.text || '').substring(0, 100) + (tweet.text?.length > 100 ? '...' : '')
  };
}

/**
 * Add a post to the pending queue
 * @param {Object} state - Pending state object
 * @param {string} username - Twitter username
 * @param {Object} pendingPost - Pending post entry from createPendingEntry
 */
export function addToPending(state, username, pendingPost) {
  if (!state.pending[username]) {
    state.pending[username] = [];
  }

  // Check if already exists
  const existingIdx = state.pending[username].findIndex(p => p.postId === pendingPost.postId);
  if (existingIdx >= 0) {
    // Update existing entry
    state.pending[username][existingIdx] = pendingPost;
  } else {
    // Add new entry
    state.pending[username].push(pendingPost);
  }
}

/**
 * Remove a post from the pending queue
 * @param {Object} state - Pending state object
 * @param {string} username - Twitter username
 * @param {string} postId - Post ID to remove
 * @returns {boolean} True if removed, false if not found
 */
export function removeFromPending(state, username, postId) {
  if (!state.pending[username]) {
    return false;
  }

  const initialLength = state.pending[username].length;
  state.pending[username] = state.pending[username].filter(p => p.postId !== postId);
  const newLength = state.pending[username].length;

  // Clean up empty arrays
  if (newLength === 0) {
    delete state.pending[username];
  }

  // Return true if we actually removed something
  return newLength < initialLength;
}

/**
 * Get all pending posts for an account
 * @param {Object} state - Pending state object
 * @param {string} username - Twitter username
 * @returns {Array} Array of pending posts
 */
export function getPendingPosts(state, username) {
  return state.pending[username] || [];
}

/**
 * Update metrics for a pending post
 * @param {Object} state - Pending state object
 * @param {string} username - Twitter username
 * @param {string} postId - Post ID
 * @param {Object} newMetrics - Updated metrics
 */
export function updatePendingMetrics(state, username, postId, newMetrics) {
  if (!state.pending[username]) {
    return;
  }

  const post = state.pending[username].find(p => p.postId === postId);
  if (post) {
    post.latestMetrics = { ...newMetrics };
    post.lastCheckedAt = new Date().toISOString();
    post.checkCount++;
  }
}

/**
 * Get expired pending posts (age > maxHours)
 * @param {Object} state - Pending state object
 * @param {string} username - Twitter username
 * @param {number} maxAgeHours - Maximum age in hours
 * @returns {Array} Array of expired pending posts
 */
export function getExpiredPendingPosts(state, username, maxAgeHours) {
  const posts = state.pending[username] || [];
  const now = Date.now();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;

  return posts.filter(post => {
    const detectedAt = new Date(post.detectedAt).getTime();
    return (now - detectedAt) > maxAgeMs;
  });
}

/**
 * Get pending post count summary
 * @param {Object} state - Pending state object
 * @returns {Object} { totalPending, byAccount: { username: count } }
 */
export function getPendingSummary(state) {
  const byAccount = {};
  let totalPending = 0;

  for (const [username, posts] of Object.entries(state.pending)) {
    byAccount[username] = posts.length;
    totalPending += posts.length;
  }

  return { totalPending, byAccount };
}

/**
 * Get a pending post by ID
 * @param {Object} state - Pending state object
 * @param {string} username - Twitter username
 * @param {string} postId - Post ID
 * @returns {Object|null} Pending post or null if not found
 */
export function getPendingPost(state, username, postId) {
  if (!state.pending[username]) {
    return null;
  }
  return state.pending[username].find(p => p.postId === postId) || null;
}

/**
 * Calculate age of a pending post in hours
 * @param {Object} pendingPost - Pending post entry
 * @returns {number} Age in hours
 */
export function getPendingPostAgeHours(pendingPost) {
  const detectedAt = new Date(pendingPost.detectedAt).getTime();
  return (Date.now() - detectedAt) / (1000 * 60 * 60);
}
