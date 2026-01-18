// Mention bot path-based index management
// Modeled on watch-archive.js but adapted for mention bot architecture

import fs from 'fs';
import path from 'path';
import { uploadToArweave } from './arweave.js';
import { updateUndernameRecord, createUndernameRecord } from './arns.js';

// Base directory for archives
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '.';
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
const INDEX_FILE = path.join(ARCHIVE_DIR, 'metadata', 'mention-index.json');

// In-memory state for the current poll cycle
let indexData = null;
let isDirty = false;

/**
 * Ensure archive directories exist
 */
function ensureDirectories() {
  const metadataDir = path.join(ARCHIVE_DIR, 'metadata');
  fs.mkdirSync(metadataDir, { recursive: true });
}

/**
 * Load the mention index from disk (call once at start of poll cycle)
 * @returns {Object} The index object
 */
export function loadMentionIndex() {
  ensureDirectories();

  if (fs.existsSync(INDEX_FILE)) {
    try {
      indexData = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
      console.log(`📊 Loaded mention index: ${indexData.posts?.length || 0} posts`);
    } catch (error) {
      console.error(`❌ Error loading mention index: ${error.message}`);
      indexData = createEmptyIndex();
    }
  } else {
    indexData = createEmptyIndex();
    console.log('📊 Starting with fresh mention index');
  }

  isDirty = false;
  return indexData;
}

/**
 * Create an empty index structure
 * @returns {Object} Empty index object
 */
function createEmptyIndex() {
  return {
    metadata: {
      lastUpdated: new Date().toISOString(),
      totalPosts: 0,
      indexVersion: '3.0.0',
      description: 'NeedsArNS Archive Index',
      rootArnsName: process.env.ROOT_ARNS_NAME || 'needsarns'
    },
    posts: []
  };
}

/**
 * Reset the in-memory index state (call at start of poll cycle)
 */
export function resetIndexState() {
  indexData = null;
  isDirty = false;
}

/**
 * Check if a path is available (not already used)
 * @param {string} pathName - The path to check
 * @returns {boolean} True if available, false if taken
 */
export function isPathAvailable(pathName) {
  if (!indexData) {
    loadMentionIndex();
  }

  // Check if path exists in current index
  const exists = indexData.posts.some(p => p.path === pathName);
  return !exists;
}

/**
 * Get a text preview for the index
 * @param {string} text - Full tweet text
 * @param {number} maxLength - Maximum length
 * @returns {string} Truncated text
 */
function getTextPreview(text, maxLength = 200) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

/**
 * Add a post to the in-memory index (no disk I/O)
 * @param {Object} archiveData - Archive data with manifestTxId, metadataTxId, etc.
 * @param {Object} parentTweet - The parent tweet object being archived
 * @param {Object} mentionUser - The user who made the mention
 * @param {Object} parentUser - The author of the parent tweet
 */
export function addToMentionIndex(archiveData, parentTweet, mentionUser, parentUser) {
  if (!indexData) {
    loadMentionIndex();
  }

  const entry = {
    path: archiveData.path,
    postId: parentTweet.id,
    mentionId: archiveData.mentionId,
    mentionUsername: mentionUser?.username || 'unknown',
    parentUsername: parentUser?.username || 'unknown',
    text: getTextPreview(parentTweet.text),
    createdAt: parentTweet.created_at,
    processedAt: new Date().toISOString(),
    manifestTxId: archiveData.manifestTxId,
    metadataTxId: archiveData.metadataTxId,
    mediaCount: archiveData.mediaCount || 0,
    hasVideo: archiveData.hasVideo || false,
    isLegacyUndername: archiveData.isLegacyUndername || false
  };

  // Check if entry already exists (by path or postId)
  const existingIdx = indexData.posts.findIndex(
    p => p.path === entry.path || p.postId === entry.postId
  );

  if (existingIdx >= 0) {
    console.log(`   ⚠️ Updating existing entry for path '${entry.path}'`);
    indexData.posts[existingIdx] = entry;
  } else {
    // Add to beginning (newest first)
    indexData.posts.unshift(entry);
  }

  isDirty = true;
  console.log(`   📝 Added to index: path='${entry.path}' postId=${entry.postId}`);
}

/**
 * Check if the index has uncommitted changes
 * @returns {boolean} True if changes exist
 */
export function hasIndexChanges() {
  return isDirty;
}

/**
 * Save the mention index to disk (single write at end of cycle)
 */
export function saveMentionIndex() {
  if (!indexData) {
    console.log('⚠️ No index data to save');
    return;
  }

  ensureDirectories();

  // Update metadata
  indexData.metadata.lastUpdated = new Date().toISOString();
  indexData.metadata.totalPosts = indexData.posts.length;

  fs.writeFileSync(INDEX_FILE, JSON.stringify(indexData, null, 2));
  console.log(`💾 Saved mention index: ${indexData.posts.length} posts`);

  isDirty = false;
}

/**
 * Upload the mention index to Arweave and update ArNS records
 * @param {Object} ant - ANT instance
 * @param {Object} jwk - Arweave wallet JWK
 * @param {string} rootArnsName - Root ArNS name (e.g., 'needsarns')
 * @param {number} ttlSeconds - TTL for ArNS record
 * @returns {Object} Result with success status and txIds
 */
export async function uploadMentionIndex(ant, jwk, rootArnsName, ttlSeconds) {
  console.log(`\n📤 Uploading mention index for ${rootArnsName}...`);

  if (!indexData) {
    loadMentionIndex();
  }

  if (indexData.posts.length === 0) {
    console.log(`   ⚠️ No posts in index, skipping upload`);
    return { success: false, error: 'empty_index' };
  }

  try {
    // Upload index JSON
    const indexBuffer = Buffer.from(JSON.stringify(indexData, null, 2));
    const indexTxId = await uploadToArweave(indexBuffer, 'application/json', 'NeedsArNS-MentionIndex', jwk);
    console.log(`   ✅ Index uploaded: ${indexTxId}`);

    // Update ArNS record for index undername (index_needsarns.ar.io)
    const indexUndername = 'index';
    console.log(`   🔗 Updating ArNS: ${indexUndername}_${rootArnsName} → ${indexTxId}`);

    const updateResult = await updateUndernameRecord(ant, indexUndername, indexTxId, ttlSeconds);

    if (!updateResult.success) {
      // Try creating if update failed (record doesn't exist yet)
      console.log(`   🔗 Creating ArNS record instead...`);
      const createResult = await createUndernameRecord(ant, indexUndername, indexTxId, ttlSeconds);

      if (!createResult.success) {
        console.error(`   ❌ Failed to create/update index ArNS: ${createResult.message}`);
        return { success: false, error: 'arns_failed', txId: indexTxId };
      }
    }

    console.log(`   ✅ Index ArNS updated: ${indexUndername}_${rootArnsName}.ar.io`);

    return {
      success: true,
      txId: indexTxId,
      totalPosts: indexData.posts.length
    };
  } catch (error) {
    console.error(`   ❌ Failed to upload index: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Get the current index data (for reading only)
 * @returns {Object} The index data
 */
export function getMentionIndex() {
  if (!indexData) {
    loadMentionIndex();
  }
  return indexData;
}

/**
 * Find a post by path
 * @param {string} pathName - The path to look up
 * @returns {Object|null} The post entry or null
 */
export function findPostByPath(pathName) {
  if (!indexData) {
    loadMentionIndex();
  }
  return indexData.posts.find(p => p.path === pathName) || null;
}

/**
 * Find a post by postId
 * @param {string} postId - The tweet ID to look up
 * @returns {Object|null} The post entry or null
 */
export function findPostByPostId(postId) {
  if (!indexData) {
    loadMentionIndex();
  }
  return indexData.posts.find(p => p.postId === postId) || null;
}
