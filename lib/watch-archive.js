// Watch mode archive management

import fs from 'fs';
import path from 'path';
import { uploadToArweave, uploadManifest } from './arweave.js';
import { createUndernameRecord, updateUndernameRecord } from './arns.js';
import { getTweetMedia, getTweetAuthor, getTextPreview, tweetHasMedia } from './watch-timeline.js';
import { generateManifest } from './manifest.js';
import { extractQuotedTweetId, getTweetsByIds } from './twitter.js';
import { renderTemplate } from '../response-templates/loader.js';

// Base directory for watch archives
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '.';
const WATCH_ARCHIVE_DIR = path.join(DATA_DIR, 'watch-archive');

/**
 * Get the archive directory path for a watched account
 * @param {string} arnsName - ArNS name for the account
 * @returns {string} Path to account's archive directory
 */
export function getWatchArchivePath(arnsName) {
  return path.join(WATCH_ARCHIVE_DIR, arnsName);
}

/**
 * Ensure archive directories exist for an account
 * @param {string} arnsName - ArNS name for the account
 */
function ensureArchiveDirectories(arnsName) {
  const basePath = getWatchArchivePath(arnsName);
  const metadataPath = path.join(basePath, 'metadata');
  const postsPath = path.join(basePath, 'posts');

  fs.mkdirSync(metadataPath, { recursive: true });
  fs.mkdirSync(postsPath, { recursive: true });
}

/**
 * Build metadata object for a watched post
 * @param {Object} tweet - Tweet object from API
 * @param {Object} account - Account configuration
 * @param {Object} includes - Includes object from API
 * @param {Array} mediaArray - Array of uploaded media info
 * @param {Object} quotedTweetData - Optional quoted tweet data { tweet, author, media }
 * @param {Array} quotedMediaArray - Optional array of uploaded quoted tweet media
 * @returns {Object} Metadata object for the post
 */
export function buildWatchMetadataObject(tweet, account, includes, mediaArray = [], quotedTweetData = null, quotedMediaArray = [], invokingUser = null) {
  const author = getTweetAuthor(tweet, includes);

  const metadataObj = {
    metadata: {
      postId: tweet.id,
      watchedAccount: account.twitterUsername,
      twitterUserId: account.twitterUserId,
      arnsName: account.arnsName,
      processedAt: new Date().toISOString(),
      archiveType: account.sourceType === 'search' ? 'search_triggered' : 'watch_mode',
      archiveVersion: '2.2.0', // Bumped for invoking user support
      sourceType: account.sourceType || 'timeline',
      // For search-based archives, track who triggered the archive
      invokingUser: invokingUser ? {
        id: invokingUser.id,
        username: invokingUser.username,
        name: invokingUser.name
      } : null
    },
    rawApiResponse: {
      fetchedAt: new Date().toISOString(),
      tweet: tweet,
      includes: {
        users: includes.users || [],
        media: includes.media || []
      }
    },
    archive: {
      htmlTxId: null,
      metadataTxId: null,
      manifestTxId: null,
      media: mediaArray.map((media, index) => ({
        index,
        type: media.type,
        txId: media.txId,
        alt_text: media.alt_text || ''
      }))
    },
    display: {
      username: author?.username || account.twitterUsername,
      displayName: author?.name || account.twitterUsername,
      profileImageUrl: author?.profile_image_url || null,
      text: tweet.text || '',
      createdAt: tweet.created_at,
      publicMetrics: tweet.public_metrics || null,
      // For search-based archives, include invoking user in display
      invokingUsername: invokingUser?.username || null,
      invokingDisplayName: invokingUser?.name || null
    }
  };

  // Add quoted tweet data if present
  if (quotedTweetData) {
    metadataObj.quotedTweet = {
      tweet: quotedTweetData.tweet,
      author: quotedTweetData.author,
      // Store both original Twitter media info and uploaded Arweave txIds
      media: quotedMediaArray.map((uploadedMedia, index) => ({
        index,
        type: uploadedMedia.type,
        txId: uploadedMedia.txId,
        alt_text: uploadedMedia.alt_text || ''
      }))
    };
  }

  return metadataObj;
}

/**
 * Process and upload media from a tweet
 * @param {Object} tweet - Tweet object
 * @param {Object} includes - Includes object from API
 * @param {Object} jwk - Arweave wallet JWK
 * @returns {Array} Array of uploaded media objects with txIds
 */
export async function processWatchMedia(tweet, includes, jwk) {
  if (!tweetHasMedia(tweet)) {
    return [];
  }

  const mediaObjects = getTweetMedia(tweet, includes);
  const uploadedMedia = [];

  for (let i = 0; i < mediaObjects.length; i++) {
    const media = mediaObjects[i];
    console.log(`   📸 Processing media ${i + 1}/${mediaObjects.length}: ${media.type}`);

    try {
      // Get the best URL for the media
      let mediaUrl = null;
      let contentType = 'application/octet-stream';

      if (media.type === 'photo') {
        mediaUrl = media.url;
        contentType = 'image/jpeg';
      } else if (media.type === 'video' || media.type === 'animated_gif') {
        // Get highest quality video variant
        if (media.variants && media.variants.length > 0) {
          const mp4Variants = media.variants
            .filter(v => v.content_type === 'video/mp4')
            .sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));

          if (mp4Variants.length > 0) {
            mediaUrl = mp4Variants[0].url;
            contentType = 'video/mp4';
          }
        }

        // Fallback to preview image if no video URL
        if (!mediaUrl && media.preview_image_url) {
          mediaUrl = media.preview_image_url;
          contentType = 'image/jpeg';
        }
      }

      if (!mediaUrl) {
        console.warn(`   ⚠️ No URL found for media ${i + 1}, skipping`);
        continue;
      }

      // Download media
      console.log(`   📥 Downloading: ${mediaUrl.split('?')[0].split('/').pop()}`);
      const response = await fetch(mediaUrl);
      if (!response.ok) {
        throw new Error(`Download failed: ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());

      // Upload to Arweave
      const txId = await uploadToArweave(buffer, contentType, 'NeedsArNS-Watch', jwk);

      uploadedMedia.push({
        type: media.type,
        txId,
        alt_text: media.alt_text || '',
        index: i
      });

      console.log(`   ✅ Uploaded media ${i + 1}: ${txId}`);
    } catch (error) {
      console.error(`   ❌ Failed to process media ${i + 1}: ${error.message}`);
      // Continue with other media instead of failing completely
    }
  }

  return uploadedMedia;
}

/**
 * Fetch quoted tweet data if present
 * @param {Object} tweet - The main tweet object
 * @param {Object} twitterClient - Twitter API client
 * @returns {Object|null} Quoted tweet data or null
 */
async function fetchQuotedTweetData(tweet, twitterClient) {
  const quotedTweetId = extractQuotedTweetId(tweet);
  if (!quotedTweetId) {
    return null;
  }

  console.log(`   🔗 Fetching quoted tweet ${quotedTweetId}...`);

  try {
    const result = await getTweetsByIds(twitterClient, [quotedTweetId]);
    const quotedTweet = result.tweets.get(quotedTweetId);

    if (!quotedTweet) {
      console.warn(`   ⚠️ Quoted tweet ${quotedTweetId} not found (may be deleted or protected)`);
      return null;
    }

    // Find the author
    const author = result.includes.users?.find(u => u.id === quotedTweet.author_id);

    // Find media if any
    const media = [];
    if (quotedTweet.attachments?.media_keys) {
      for (const key of quotedTweet.attachments.media_keys) {
        const mediaItem = result.includes.media?.find(m => m.media_key === key);
        if (mediaItem) {
          media.push(mediaItem);
        }
      }
    }

    console.log(`   ✅ Found quoted tweet from @${author?.username || 'unknown'}${media.length > 0 ? ` (${media.length} media)` : ''}`);

    return {
      tweet: quotedTweet,
      author: author || null,
      media: media,
      includes: result.includes
    };
  } catch (error) {
    console.error(`   ❌ Failed to fetch quoted tweet: ${error.message}`);
    return null;
  }
}

/**
 * Process and upload media from quoted tweet
 * @param {Object} quotedTweetData - Data from fetchQuotedTweetData
 * @param {Object} jwk - Arweave wallet JWK
 * @returns {Array} Array of uploaded media objects with txIds
 */
async function processQuotedTweetMedia(quotedTweetData, jwk) {
  if (!quotedTweetData || !quotedTweetData.media || quotedTweetData.media.length === 0) {
    return [];
  }

  console.log(`   📸 Processing ${quotedTweetData.media.length} quoted tweet media...`);
  const uploadedMedia = [];

  for (let i = 0; i < quotedTweetData.media.length; i++) {
    const media = quotedTweetData.media[i];
    console.log(`   📸 Processing quoted media ${i + 1}/${quotedTweetData.media.length}: ${media.type}`);

    try {
      let mediaUrl = null;
      let contentType = 'application/octet-stream';

      if (media.type === 'photo') {
        mediaUrl = media.url;
        contentType = 'image/jpeg';
      } else if (media.type === 'video' || media.type === 'animated_gif') {
        // Get highest quality video variant
        if (media.variants && media.variants.length > 0) {
          const mp4Variants = media.variants
            .filter(v => v.content_type === 'video/mp4')
            .sort((a, b) => (b.bit_rate || 0) - (a.bit_rate || 0));

          if (mp4Variants.length > 0) {
            mediaUrl = mp4Variants[0].url;
            contentType = 'video/mp4';
          }
        }

        // Fallback to preview image if no video URL
        if (!mediaUrl && media.preview_image_url) {
          mediaUrl = media.preview_image_url;
          contentType = 'image/jpeg';
        }
      }

      if (!mediaUrl) {
        console.warn(`   ⚠️ No URL found for quoted media ${i + 1}, skipping`);
        continue;
      }

      // Download media
      console.log(`   📥 Downloading quoted: ${mediaUrl.split('?')[0].split('/').pop()}`);
      const response = await fetch(mediaUrl);
      if (!response.ok) {
        throw new Error(`Download failed: ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());

      // Upload to Arweave
      const txId = await uploadToArweave(buffer, contentType, 'NeedsArNS-Watch-QuotedMedia', jwk);

      uploadedMedia.push({
        type: media.type,
        txId,
        alt_text: media.alt_text || '',
        index: i
      });

      console.log(`   ✅ Uploaded quoted media ${i + 1}: ${txId}`);
    } catch (error) {
      console.error(`   ❌ Failed to process quoted media ${i + 1}: ${error.message}`);
      // Continue with other media instead of failing completely
    }
  }

  return uploadedMedia;
}

/**
 * Archive a single watched post
 * @param {Object} tweet - Tweet object
 * @param {Object} account - Account configuration
 * @param {Object} includes - Includes object from API
 * @param {Object} jwk - Arweave wallet JWK
 * @param {string} templateTxId - TXID of the post template HTML
 * @param {Object} twitterClient - Optional Twitter client for fetching quoted tweets
 * @param {Object} invokingUser - Optional user who triggered the archive (for search-based accounts)
 * @returns {Object} Result with success status and archive info
 */
export async function archiveWatchedPost(tweet, account, includes, jwk, templateTxId, twitterClient = null, invokingUser = null) {
  const postId = tweet.id;
  const author = getTweetAuthor(tweet, includes);
  const logUser = invokingUser ? `invoked by @${invokingUser.username}` : `from @${account.twitterUsername}`;
  console.log(`\n📦 Archiving post ${postId} ${logUser}`);

  try {
    // 1. Process and upload media
    const mediaArray = await processWatchMedia(tweet, includes, jwk);

    // 2. Fetch quoted tweet if present (and we have a twitter client)
    let quotedTweetData = null;
    let quotedMediaArray = [];
    if (twitterClient) {
      quotedTweetData = await fetchQuotedTweetData(tweet, twitterClient);

      // 2b. Upload quoted tweet media to Arweave
      if (quotedTweetData) {
        quotedMediaArray = await processQuotedTweetMedia(quotedTweetData, jwk);
      }
    }

    // 3. Build metadata object (with uploaded quoted media and invoking user)
    const metadataObj = buildWatchMetadataObject(tweet, account, includes, mediaArray, quotedTweetData, quotedMediaArray, invokingUser);

    // 4. Upload metadata.json
    console.log(`   📄 Uploading metadata.json...`);
    const metadataBuffer = Buffer.from(JSON.stringify(metadataObj, null, 2));
    const metadataTxId = await uploadToArweave(metadataBuffer, 'application/json', 'NeedsArNS-Watch-Metadata', jwk);
    metadataObj.archive.metadataTxId = metadataTxId;

    // 5. Generate and upload manifest
    console.log(`   📦 Creating manifest...`);
    const manifest = generateManifest(metadataTxId, mediaArray, templateTxId);
    const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2));
    const manifestTxId = await uploadManifest(manifestBuffer, jwk);
    metadataObj.archive.manifestTxId = manifestTxId;
    metadataObj.archive.htmlTxId = templateTxId;

    // 6. Save local archive copy
    saveWatchPostArchive(metadataObj, account.arnsName);

    console.log(`   ✅ Post archived: manifest ${manifestTxId}${quotedTweetData ? ' (with quoted tweet)' : ''}`);

    return {
      success: true,
      postId,
      manifestTxId,
      metadataTxId,
      mediaCount: mediaArray.length,
      hasQuotedTweet: !!quotedTweetData,
      metadata: metadataObj
    };
  } catch (error) {
    console.error(`   ❌ Failed to archive post ${postId}: ${error.message}`);
    return {
      success: false,
      postId,
      error: error.message
    };
  }
}

/**
 * Save post archive to local filesystem
 * @param {Object} metadataObj - Complete metadata object
 * @param {string} arnsName - ArNS name for the account
 */
function saveWatchPostArchive(metadataObj, arnsName) {
  ensureArchiveDirectories(arnsName);

  const postId = metadataObj.metadata.postId;
  const postPath = path.join(getWatchArchivePath(arnsName), 'posts', `${postId}.json`);

  fs.writeFileSync(postPath, JSON.stringify(metadataObj, null, 2));
  console.log(`   💾 Saved local archive: ${postPath}`);
}

/**
 * Load the watch index for an account
 * @param {string} arnsName - ArNS name for the account
 * @returns {Object} Index object
 */
export function loadWatchIndex(arnsName) {
  ensureArchiveDirectories(arnsName);

  const indexPath = path.join(getWatchArchivePath(arnsName), 'metadata', 'index.json');

  if (!fs.existsSync(indexPath)) {
    return {
      metadata: {
        watchedAccount: null,
        twitterUserId: null,
        arnsName: arnsName,
        lastUpdated: new Date().toISOString(),
        totalPosts: 0,
        indexVersion: '1.0'
      },
      posts: []
    };
  }

  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch (error) {
    console.error(`❌ Error loading watch index for ${arnsName}: ${error.message}`);
    console.log(`📋 Starting with fresh index`);
    return {
      metadata: {
        watchedAccount: null,
        twitterUserId: null,
        arnsName: arnsName,
        lastUpdated: new Date().toISOString(),
        totalPosts: 0,
        indexVersion: '1.0'
      },
      posts: []
    };
  }
}

/**
 * Save the watch index for an account
 * @param {string} arnsName - ArNS name for the account
 * @param {Object} index - Index object to save
 */
export function saveWatchIndex(arnsName, index) {
  ensureArchiveDirectories(arnsName);

  const indexPath = path.join(getWatchArchivePath(arnsName), 'metadata', 'index.json');

  index.metadata.lastUpdated = new Date().toISOString();
  index.metadata.totalPosts = index.posts.length;

  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  console.log(`   💾 Saved local index: ${index.posts.length} posts`);
}

/**
 * Add a post to the watch index (loads and saves - use for single post updates)
 * @param {string} arnsName - ArNS name for the account
 * @param {Object} account - Account configuration
 * @param {Object} archiveResult - Result from archiveWatchedPost
 * @param {Object} tweet - Original tweet object
 */
export function addPostToIndex(arnsName, account, archiveResult, tweet) {
  const index = loadWatchIndex(arnsName);
  addPostToIndexInMemory(index, account, archiveResult, tweet);
  saveWatchIndex(arnsName, index);
}

/**
 * Add a post to an in-memory index object (no disk I/O)
 * Use this for batching multiple posts, then call saveWatchIndex once at the end
 * @param {Object} index - In-memory index object
 * @param {Object} account - Account configuration
 * @param {Object} archiveResult - Result from archiveWatchedPost
 * @param {Object} tweet - Original tweet object
 */
export function addPostToIndexInMemory(index, account, archiveResult, tweet, invokingUser = null) {
  // Update metadata if not set (for timeline-based accounts)
  // For search-based accounts, these may be null
  if (!index.metadata.watchedAccount && account.twitterUsername) {
    index.metadata.watchedAccount = account.twitterUsername;
    index.metadata.twitterUserId = account.twitterUserId;
  }

  // Track source type in index metadata
  if (!index.metadata.sourceType) {
    index.metadata.sourceType = account.sourceType || 'timeline';
  }

  // Check if post already exists (shouldn't happen, but safety check)
  const existingIdx = index.posts.findIndex(p => p.postId === archiveResult.postId);
  if (existingIdx >= 0) {
    console.log(`   ⚠️ Post ${archiveResult.postId} already in index, updating`);
    index.posts[existingIdx] = createIndexEntry(archiveResult, tweet, invokingUser);
  } else {
    // Add to beginning (newest first)
    index.posts.unshift(createIndexEntry(archiveResult, tweet, invokingUser));
  }
}

/**
 * Create an index entry for a post
 * @param {Object} archiveResult - Result from archiveWatchedPost
 * @param {Object} tweet - Original tweet object
 * @param {Object} invokingUser - Optional user who triggered the archive
 * @returns {Object} Index entry
 */
function createIndexEntry(archiveResult, tweet, invokingUser = null) {
  const entry = {
    postId: archiveResult.postId,
    text: getTextPreview(tweet.text, 200),
    createdAt: tweet.created_at,
    processedAt: new Date().toISOString(),
    manifestTxId: archiveResult.manifestTxId,
    metadataTxId: archiveResult.metadataTxId,
    mediaCount: archiveResult.mediaCount || 0,
    hasVideo: archiveResult.metadata?.archive?.media?.some(m => m.type === 'video' || m.type === 'animated_gif') || false,
    hasQuotedTweet: archiveResult.hasQuotedTweet || false,
    // Author of the tweet being archived
    authorUsername: archiveResult.metadata?.display?.username || null
  };

  // For search-based archives, include who triggered the archive
  if (invokingUser) {
    entry.invokingUsername = invokingUser.username;
    entry.invokingDisplayName = invokingUser.name;
  }

  return entry;
}

/**
 * Upload the watch index to Arweave and update ArNS
 * @param {Object} ant - ANT instance for the account
 * @param {string} arnsName - ArNS name for the account
 * @param {Object} jwk - Arweave wallet JWK
 * @param {number} ttlSeconds - TTL for ArNS record
 * @returns {Object} Result with txId
 */
export async function uploadWatchIndex(ant, arnsName, jwk, ttlSeconds) {
  console.log(`\n📤 Uploading index for ${arnsName}...`);

  try {
    const index = loadWatchIndex(arnsName);

    if (index.posts.length === 0) {
      console.log(`   ⚠️ No posts in index, skipping upload`);
      return { success: false, error: 'empty_index' };
    }

    // Upload index JSON
    const indexBuffer = Buffer.from(JSON.stringify(index, null, 2));
    const indexTxId = await uploadToArweave(indexBuffer, 'application/json', 'NeedsArNS-Watch-Index', jwk);
    console.log(`   ✅ Index uploaded: ${indexTxId}`);

    // Update ArNS record for index undername
    const indexUndername = 'index';
    console.log(`   🔗 Updating ArNS: ${indexUndername}_${arnsName} → ${indexTxId}`);

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

    console.log(`   ✅ Index ArNS updated: index_${arnsName}.ar.io`);

    return {
      success: true,
      txId: indexTxId,
      totalPosts: index.posts.length
    };
  } catch (error) {
    console.error(`   ❌ Failed to upload index: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Upload landing page manifest and update root ArNS
 * @param {Object} ant - ANT instance for the account
 * @param {string} arnsName - ArNS name for the account
 * @param {Object} jwk - Arweave wallet JWK
 * @param {string} landingTemplateTxId - TXID of the landing page template
 * @param {string} indexTxId - TXID of the index.json
 * @param {number} ttlSeconds - TTL for ArNS record
 * @returns {Object} Result with txId
 */
export async function uploadLandingPageManifest(ant, arnsName, jwk, landingTemplateTxId, indexTxId, ttlSeconds) {
  console.log(`\n📤 Uploading landing page manifest for ${arnsName}...`);

  try {
    // Create manifest with fallback for hash routing
    const manifest = {
      manifest: 'arweave/paths',
      version: '0.2.0',
      index: { path: 'index.html' },
      fallback: { id: landingTemplateTxId },
      paths: {
        'index.html': { id: landingTemplateTxId },
        'index.json': { id: indexTxId }
      }
    };

    const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2));
    const manifestTxId = await uploadManifest(manifestBuffer, jwk);
    console.log(`   ✅ Landing manifest uploaded: ${manifestTxId}`);

    // Update root ArNS record using '@' as the undername (ArNS convention for root)
    // This sets the primary record that resolves when visiting arnsName.ar.io directly
    console.log(`   🔗 Updating root ArNS: ${arnsName}.ar.io → ${manifestTxId}`);

    try {
      // Try using '@' as undername first (ArNS SDK v3.20+ convention for root record)
      const updateResult = await updateUndernameRecord(ant, '@', manifestTxId, ttlSeconds);

      if (updateResult.success) {
        console.log(`   ✅ Root ArNS updated: ${arnsName}.ar.io`);
        return { success: true, manifestTxId, indexTxId };
      }

      // If update failed, try creating
      console.log(`   🔗 Creating root ArNS record...`);
      const createResult = await createUndernameRecord(ant, '@', manifestTxId, ttlSeconds);

      if (createResult.success) {
        console.log(`   ✅ Root ArNS created: ${arnsName}.ar.io`);
        return { success: true, manifestTxId, indexTxId };
      }

      // If '@' doesn't work, the landing page might need manual setup
      console.warn(`   ⚠️ Could not update root record automatically.`);
      console.warn(`   ⚠️ You may need to manually set ${arnsName}.ar.io → ${manifestTxId}`);
      console.warn(`   ⚠️ The index is still accessible at index_${arnsName}.ar.io`);

      return {
        success: true, // Partial success - index was updated
        manifestTxId,
        indexTxId,
        rootUpdateFailed: true
      };
    } catch (rootError) {
      console.warn(`   ⚠️ Root record update error: ${rootError.message}`);
      console.warn(`   ⚠️ Index still accessible at index_${arnsName}.ar.io`);
      return {
        success: true, // Partial success
        manifestTxId,
        indexTxId,
        rootUpdateFailed: true
      };
    }
  } catch (error) {
    console.error(`   ❌ Failed to upload landing manifest: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/**
 * Generate the reply message for an archived post
 * @param {string} postId - Tweet ID
 * @param {string} arnsName - ArNS name for the account
 * @param {Object} account - Optional account configuration (for template selection)
 * @returns {string} Reply message
 */
export function generateWatchReplyMessage(postId, arnsName, account = null) {
  // Use success-baseposting template for the baseposting account
  if (account?.arnsName === 'baseposting' || arnsName === 'baseposting') {
    const message = renderTemplate('success-baseposting', { postId });
    if (message) {
      return message;
    }
  }

  // Default watch mode reply
  return `📸 Archived permanently on Arweave!

🔗 https://${arnsName}.ar.io/#/${postId}

✨ Powered by @ArNSdomains`;
}
