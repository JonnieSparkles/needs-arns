import 'dotenv/config';
import express from 'express';
import { ANT, ArweaveSigner } from '@ar.io/sdk';

import { requireEnv, getJwkFromEnv } from './lib/utils.js';
import { getTwitterClient, sendWatchReply, getTweetsByIds } from './lib/twitter.js';
import { getTurboClient, getTurboBalanceWithShared } from './lib/arweave.js';
import { loadWatchConfig, getEnabledAccounts } from './lib/watch-config.js';
import {
  loadWatchState,
  saveWatchState,
  getAccountState,
  updateAccountState,
  incrementArchivedCount,
  recordAccountError,
  clearAccountError,
  getStateSummary,
  getDefaultStatePath
} from './lib/watch-state.js';
import { pollAccountTimeline, formatTweetForLog } from './lib/watch-timeline.js';
import { pollSearchResults, formatSearchResultForLog } from './lib/watch-search.js';
import {
  archiveWatchedPost,
  loadWatchIndex,
  saveWatchIndex,
  addPostToIndexInMemory,
  uploadWatchIndex,
  generateWatchReplyMessage
} from './lib/watch-archive.js';
import {
  shouldArchiveImmediately,
  meetsEngagementThresholds,
  extractMetrics,
  hasMedia,
  isSelfReply,
  formatMetricsForLog
} from './lib/watch-filter.js';
import {
  loadPendingState,
  savePendingState,
  createPendingEntry,
  addToPending,
  removeFromPending,
  getPendingPosts,
  updatePendingMetrics,
  getPendingPostAgeHours,
  getPendingSummary,
  getDefaultPendingStatePath
} from './lib/watch-pending.js';

// ---------- config & env ----------

const {
  TWITTER_APP_KEY,
  TWITTER_APP_SECRET,
  TWITTER_ACCESS_TOKEN,
  TWITTER_ACCESS_SECRET
} = {
  TWITTER_APP_KEY: requireEnv('TWITTER_APP_KEY'),
  TWITTER_APP_SECRET: requireEnv('TWITTER_APP_SECRET'),
  TWITTER_ACCESS_TOKEN: requireEnv('TWITTER_ACCESS_TOKEN'),
  TWITTER_ACCESS_SECRET: requireEnv('TWITTER_ACCESS_SECRET')
};

// Watch mode specific config
const WATCH_CONFIG_PATH = process.env.WATCH_CONFIG_PATH || './watch-config.json';
const WATCH_STATE_PATH = process.env.WATCH_STATE_PATH || getDefaultStatePath();
const PENDING_STATE_PATH = process.env.PENDING_STATE_PATH || getDefaultPendingStatePath();

// Template TXIDs
// Landing template is set once per account (root ArNS), then fetches index dynamically from index_ undername
const WATCH_LANDING_TEMPLATE_TXID = process.env.WATCH_LANDING_TEMPLATE_TXID || '(not configured)';
const WATCH_POST_TEMPLATE_TXID = process.env.WATCH_POST_TEMPLATE_TXID || process.env.TEMPLATE_HTML_TXID;

if (!WATCH_POST_TEMPLATE_TXID) {
  throw new Error('WATCH_POST_TEMPLATE_TXID or TEMPLATE_HTML_TXID required');
}

// ArNS TTL
const DEFAULT_TTL_SECONDS = parseInt(process.env.DEFAULT_TTL_SECONDS || '60', 10);

// Delay between processing posts (ms)
const POST_PROCESSING_DELAY_MS = 2000;

// ---------- clients ----------

const twitter = getTwitterClient({
  appKey: TWITTER_APP_KEY,
  appSecret: TWITTER_APP_SECRET,
  accessToken: TWITTER_ACCESS_TOKEN,
  accessSecret: TWITTER_ACCESS_SECRET
});

const jwk = getJwkFromEnv();
const turbo = getTurboClient(jwk);

// ---------- load config & state ----------

let watchConfig;
try {
  watchConfig = loadWatchConfig(WATCH_CONFIG_PATH);
} catch (error) {
  console.error(`❌ Failed to load watch config: ${error.message}`);
  process.exit(1);
}

let watchState = loadWatchState(WATCH_STATE_PATH);
let pendingState = loadPendingState(PENDING_STATE_PATH);

const POLL_INTERVAL_MS = watchConfig.pollIntervalMinutes * 60 * 1000;

console.log(`\n🔭 Watch Mode Starting`);
console.log(`   Accounts: ${getEnabledAccounts(watchConfig).length} enabled`);
console.log(`   Poll interval: ${watchConfig.pollIntervalMinutes} minutes`);
console.log(`   Landing template: ${WATCH_LANDING_TEMPLATE_TXID}`);
console.log(`   Post template: ${WATCH_POST_TEMPLATE_TXID}`);

// Show filtering status
const accountsWithFiltering = getEnabledAccounts(watchConfig).filter(a => a.filtering?.enabled);
if (accountsWithFiltering.length > 0) {
  console.log(`   Filtering: ${accountsWithFiltering.length} account(s) with engagement filtering`);
}

// ---------- ANT instances cache ----------

const antInstances = new Map();

function getAntInstance(account) {
  if (!antInstances.has(account.antProcessId)) {
    const ant = ANT.init({
      signer: new ArweaveSigner(jwk),
      processId: account.antProcessId
    });
    antInstances.set(account.antProcessId, ant);
  }
  return antInstances.get(account.antProcessId);
}

// ---------- archive a single post ----------

/**
 * Archive a single post
 * @param {Object} tweet - Tweet object to archive
 * @param {Object} account - Account configuration
 * @param {Object} includes - API includes (users, media, tweets)
 * @param {Object} ant - ANT instance
 * @param {Object} index - In-memory index
 * @param {Object} options - Optional parameters
 * @param {Object} options.invokingUser - User who triggered the archive (for search-based accounts)
 * @param {string} options.replyToTweetId - Tweet ID to reply to (defaults to tweet.id)
 */
async function archivePost(tweet, account, includes, ant, index, options = {}) {
  const { invokingUser = null, replyToTweetId = tweet.id } = options;

  const archiveResult = await archiveWatchedPost(
    tweet,
    account,
    includes,
    jwk,
    WATCH_POST_TEMPLATE_TXID,
    twitter, // Pass Twitter client for fetching quoted tweets
    invokingUser // Pass invoking user for search-based accounts
  );

  if (archiveResult.success) {
    // Add to in-memory index (no disk I/O)
    addPostToIndexInMemory(index, account, archiveResult, tweet, invokingUser);

    // Send reply if enabled
    if (account.replyToPost) {
      const replyMessage = generateWatchReplyMessage(tweet.id, account.arnsName, account);
      const replyId = await sendWatchReply(twitter, replyToTweetId, replyMessage);

      if (replyId) {
        console.log(`   💬 Reply sent: ${replyId}`);
      } else {
        console.log(`   ⚠️ Reply failed (archive still succeeded)`);
      }
    }

    incrementArchivedCount(watchState, account.twitterUsername);
  }

  return archiveResult;
}

// ---------- re-evaluate pending posts ----------

async function reevaluatePendingPosts(account, ant, index) {
  const { twitterUsername, filtering } = account;
  const pending = getPendingPosts(pendingState, twitterUsername);

  if (pending.length === 0) {
    return { archived: 0, expired: 0, deleted: 0 };
  }

  console.log(`\n   🔄 Re-evaluating ${pending.length} pending post(s)...`);

  // Batch fetch current metrics for all pending posts
  const postIds = pending.map(p => p.postId);
  let tweets, notFound, includes;

  try {
    const result = await getTweetsByIds(twitter, postIds);
    tweets = result.tweets;
    notFound = result.notFound;
    includes = result.includes;
  } catch (error) {
    // Rate limited or API error - skip re-evaluation this cycle
    console.warn(`   ⚠️ Could not fetch pending posts: ${error.message}`);
    return { archived: 0, expired: 0, deleted: 0 };
  }

  let archived = 0;
  let expired = 0;
  let deleted = 0;

  // Remove deleted posts
  for (const deletedId of notFound) {
    console.log(`   🗑️ Pending post ${deletedId} was deleted`);
    removeFromPending(pendingState, twitterUsername, deletedId);
    deleted++;
  }

  // Evaluate each pending post
  for (const pendingPost of pending) {
    if (notFound.includes(pendingPost.postId)) continue;

    const tweet = tweets.get(pendingPost.postId);
    if (!tweet) continue;

    const metrics = extractMetrics(tweet);
    updatePendingMetrics(pendingState, twitterUsername, pendingPost.postId, metrics);

    // Check if now meets thresholds
    const thresholds = filtering.thresholds;
    const thresholdResult = meetsEngagementThresholds(metrics, thresholds);

    if (thresholdResult.meets) {
      console.log(`   📈 Pending post ${pendingPost.postId} now meets thresholds (${formatMetricsForLog(metrics)})`);

      // For search-based accounts, retrieve stored invoking user info from pending entry
      const archiveOptions = {};
      if (pendingPost.invokingUser) {
        archiveOptions.invokingUser = pendingPost.invokingUser;
        archiveOptions.replyToTweetId = pendingPost.mentionTweetId || tweet.id;
      }

      const archiveResult = await archivePost(tweet, account, includes, ant, index, archiveOptions);

      if (archiveResult.success) {
        removeFromPending(pendingState, twitterUsername, pendingPost.postId);
        archived++;
      }

      // Delay between archives
      await new Promise(resolve => setTimeout(resolve, POST_PROCESSING_DELAY_MS));
      continue;
    }

    // Check if expired
    const ageHours = getPendingPostAgeHours(pendingPost);
    if (ageHours > filtering.pendingMaxAgeHours) {
      console.log(`   ⏰ Pending post ${pendingPost.postId} expired after ${ageHours.toFixed(1)}h (${formatMetricsForLog(metrics)})`);
      removeFromPending(pendingState, twitterUsername, pendingPost.postId);
      expired++;
    }
  }

  return { archived, expired, deleted };
}

// ---------- check for self-replies ----------

async function checkSelfReplies(posts, account, archivedPostIds, ant, index) {
  if (!account.filtering?.archiveSelfReplies) return 0;

  let archived = 0;

  for (const tweet of posts) {
    const selfReply = isSelfReply(tweet, account.twitterUserId);
    if (!selfReply.isSelfReply || !selfReply.parentPostId) continue;

    const parentId = selfReply.parentPostId;

    // Skip if parent was already archived this cycle
    if (archivedPostIds.has(parentId)) continue;

    // Skip if parent was already archived in a previous cycle (check index)
    const alreadyInIndex = index.posts.some(p => p.postId === parentId);
    if (alreadyInIndex) {
      console.log(`   🔗 Self-reply to ${parentId} - parent already archived`);
      continue;
    }

    console.log(`   🔗 Self-reply detected, archiving parent post ${parentId}...`);

    // Fetch parent tweet
    try {
      const { tweets: parentTweets, includes: parentIncludes } = await getTweetsByIds(twitter, [parentId]);

      if (parentTweets.has(parentId)) {
        const parentTweet = parentTweets.get(parentId);
        console.log(`   📥 Archiving parent: ${parentTweet.text?.substring(0, 50)}...`);

        const archiveResult = await archivePost(parentTweet, account, parentIncludes, ant, index);

        if (archiveResult.success) {
          archivedPostIds.add(parentId);
          archived++;
        }

        await new Promise(resolve => setTimeout(resolve, POST_PROCESSING_DELAY_MS));
      }
    } catch (error) {
      console.warn(`   ⚠️ Could not fetch parent post ${parentId}: ${error.message}`);
    }
  }

  return archived;
}

// ---------- process single account ----------

async function processAccount(account) {
  // Branch based on sourceType
  if (account.sourceType === 'search') {
    return processSearchBasedAccount(account);
  }
  return processTimelineBasedAccount(account);
}

// ---------- process search-based account (e.g., #baseposting) ----------

async function processSearchBasedAccount(account) {
  const { twitterUsername, arnsName, filtering } = account;
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🔍 Processing search: ${account.searchQuery} → ${arnsName}.ar.io`);

  if (filtering?.enabled) {
    console.log(`   🔍 Filtering: ${filtering.tier} tier (${filtering.pendingMaxAgeHours}h pending window)`);
  }

  const accountState = getAccountState(watchState, twitterUsername);
  const lastTweetId = accountState.lastProcessedTweetId;

  try {
    // Get ANT instance for this account
    const ant = getAntInstance(account);

    // Load index once for batched updates
    const index = loadWatchIndex(arnsName);

    let archivedCount = 0;
    let pendingCount = 0;
    let lastProcessedId = lastTweetId;

    // ========== PHASE 1: Search and process new posts ==========
    const { posts, includes, newestId } = await pollSearchResults(
      twitter,
      account,
      lastTweetId
    );

    if (posts.length === 0) {
      console.log(`   ✅ No new posts matching query`);
    } else {
      console.log(`   📋 ${posts.length} new post(s) to archive`);

      // Process each archive target (posts array contains { tweet, invokingUser, mentionTweetId, includes })
      for (const target of posts) {
        const { tweet, invokingUser, mentionTweetId, includes: targetIncludes } = target;

        console.log(`\n   ${formatSearchResultForLog(target)}`);

        // Check if already in index (deduplication)
        const alreadyArchived = index.posts.some(p => p.postId === tweet.id);
        if (alreadyArchived) {
          console.log(`   ⏭️ Already archived, skipping`);
          lastProcessedId = mentionTweetId; // Still update since_id
          continue;
        }

        // Check if post should be archived (apply engagement filtering to parent tweet)
        const decision = shouldArchiveImmediately(tweet, account, targetIncludes);

        if (decision.archive) {
          console.log(`   ✓ Archive: ${decision.reason}`);

          const archiveResult = await archivePost(tweet, account, targetIncludes, ant, index, {
            invokingUser,
            replyToTweetId: mentionTweetId // Reply to the mention, not the parent
          });

          if (archiveResult.success) {
            archivedCount++;
            lastProcessedId = mentionTweetId;
            updateAccountState(watchState, twitterUsername, {
              lastProcessedTweetId: lastProcessedId
            });
          } else {
            console.log(`   ⚠️ Will retry next cycle`);
          }
        } else if (decision.pending) {
          // Add to pending queue (using parent tweet ID)
          console.log(`   ⏳ Pending: ${formatMetricsForLog(decision.metrics)}`);

          const pendingEntry = createPendingEntry(
            tweet,
            decision.metrics,
            hasMedia(tweet, targetIncludes)
          );
          // Store invokingUser info in pending entry for later
          pendingEntry.invokingUser = invokingUser;
          pendingEntry.mentionTweetId = mentionTweetId;
          addToPending(pendingState, twitterUsername, pendingEntry);
          pendingCount++;

          lastProcessedId = mentionTweetId;
          updateAccountState(watchState, twitterUsername, {
            lastProcessedTweetId: lastProcessedId
          });
        }

        // Delay between posts
        if (posts.indexOf(target) < posts.length - 1) {
          await new Promise(resolve => setTimeout(resolve, POST_PROCESSING_DELAY_MS));
        }
      }

      // Save state after processing all new posts
      saveWatchState(watchState, WATCH_STATE_PATH);
      savePendingState(pendingState, PENDING_STATE_PATH);
    }

    // ========== PHASE 2: Re-evaluate pending queue ==========
    // Note: For search-based accounts, pending posts include invokingUser info
    if (filtering?.enabled) {
      const pendingResult = await reevaluatePendingPosts(account, ant, index);
      archivedCount += pendingResult.archived;

      if (pendingResult.archived > 0 || pendingResult.expired > 0 || pendingResult.deleted > 0) {
        console.log(`   📊 Pending: ${pendingResult.archived} promoted, ${pendingResult.expired} expired, ${pendingResult.deleted} deleted`);
      }
    }

    // ========== Save index and update ArNS ==========
    if (archivedCount > 0) {
      saveWatchIndex(arnsName, index);

      console.log(`\n   📤 Updating ArNS records...`);

      const indexResult = await uploadWatchIndex(ant, arnsName, jwk, DEFAULT_TTL_SECONDS);

      if (!indexResult.success) {
        console.error(`   ❌ Index upload failed: ${indexResult.error}`);
      }
    }

    // Update state
    const allPostsProcessed = posts.length === 0 ||
      (archivedCount + pendingCount === posts.length);

    updateAccountState(watchState, twitterUsername, {
      lastProcessedTweetId: allPostsProcessed ? (newestId || lastProcessedId) : lastProcessedId,
      lastCheckedAt: new Date().toISOString()
    });
    clearAccountError(watchState, twitterUsername);
    saveWatchState(watchState, WATCH_STATE_PATH);
    savePendingState(pendingState, PENDING_STATE_PATH);

    // Summary
    const pendingSummary = getPendingSummary(pendingState);
    const accountPending = pendingSummary.byAccount[twitterUsername] || 0;

    let summaryParts = [`${archivedCount} archived`];
    if (pendingCount > 0) summaryParts.push(`${pendingCount} added to pending`);
    if (accountPending > 0) summaryParts.push(`${accountPending} in pending queue`);

    console.log(`   ✅ Completed: ${summaryParts.join(', ')}`);

    return { success: true, newPosts: archivedCount, pending: accountPending };

  } catch (error) {
    console.error(`   ❌ Error: ${error.message}`);
    recordAccountError(watchState, twitterUsername, error.message);
    saveWatchState(watchState, WATCH_STATE_PATH);
    return { success: false, error: error.message };
  }
}

// ---------- process timeline-based account (original watch mode) ----------

async function processTimelineBasedAccount(account) {
  const { twitterUsername, arnsName, filtering } = account;
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📡 Processing @${twitterUsername} → ${arnsName}.ar.io`);

  if (filtering?.enabled) {
    console.log(`   🔍 Filtering: ${filtering.tier} tier (${filtering.pendingMaxAgeHours}h pending window)`);
  }

  const accountState = getAccountState(watchState, twitterUsername);
  const lastTweetId = accountState.lastProcessedTweetId;

  try {
    // Get ANT instance for this account
    const ant = getAntInstance(account);

    // Load index once for batched updates
    const index = loadWatchIndex(arnsName);

    // Track archived post IDs for self-reply detection
    const archivedPostIds = new Set();

    let archivedCount = 0;
    let pendingCount = 0;
    let lastProcessedId = lastTweetId;

    // ========== PHASE 1: Process new posts ==========
    const { posts, includes, newestId } = await pollAccountTimeline(
      twitter,
      account,
      lastTweetId
    );

    if (posts.length === 0) {
      console.log(`   ✅ No new posts`);
    } else {
      console.log(`   📋 ${posts.length} new post(s) detected`);

      // Process each post
      for (const tweet of posts) {
        console.log(`\n   ${formatTweetForLog(tweet, includes)}`);

        // Check if post should be archived immediately
        const decision = shouldArchiveImmediately(tweet, account, includes);

        if (decision.archive) {
          console.log(`   ✓ Archive: ${decision.reason}`);

          const archiveResult = await archivePost(tweet, account, includes, ant, index);

          if (archiveResult.success) {
            archivedPostIds.add(tweet.id);
            archivedCount++;

            // Only update last processed ID on success
            lastProcessedId = tweet.id;
            updateAccountState(watchState, twitterUsername, {
              lastProcessedTweetId: lastProcessedId
            });
          } else {
            console.log(`   ⚠️ Will retry post ${tweet.id} next cycle`);
          }
        } else if (decision.pending) {
          // Add to pending queue
          console.log(`   ⏳ Pending: ${formatMetricsForLog(decision.metrics)}`);

          const pendingEntry = createPendingEntry(
            tweet,
            decision.metrics,
            hasMedia(tweet, includes)
          );
          addToPending(pendingState, twitterUsername, pendingEntry);
          pendingCount++;

          // Update lastProcessedId even for pending (we've seen it)
          lastProcessedId = tweet.id;
          updateAccountState(watchState, twitterUsername, {
            lastProcessedTweetId: lastProcessedId
          });
        }

        // Delay between posts
        if (posts.indexOf(tweet) < posts.length - 1) {
          await new Promise(resolve => setTimeout(resolve, POST_PROCESSING_DELAY_MS));
        }
      }

      // Save state after processing all new posts (batched instead of per-post)
      saveWatchState(watchState, WATCH_STATE_PATH);
      savePendingState(pendingState, PENDING_STATE_PATH);
    }

    // ========== PHASE 2: Re-evaluate pending queue ==========
    if (filtering?.enabled) {
      const pendingResult = await reevaluatePendingPosts(account, ant, index);
      archivedCount += pendingResult.archived;

      if (pendingResult.archived > 0 || pendingResult.expired > 0 || pendingResult.deleted > 0) {
        console.log(`   📊 Pending: ${pendingResult.archived} promoted, ${pendingResult.expired} expired, ${pendingResult.deleted} deleted`);
      }
    }

    // ========== PHASE 3: Self-reply detection ==========
    if (filtering?.archiveSelfReplies && posts.length > 0) {
      const selfReplyArchived = await checkSelfReplies(posts, account, archivedPostIds, ant, index);
      if (selfReplyArchived > 0) {
        archivedCount += selfReplyArchived;
        console.log(`   🔗 Self-replies: ${selfReplyArchived} parent post(s) archived`);
      }
    }

    // ========== Save index and update ArNS ==========
    if (archivedCount > 0) {
      // Save batched index updates to disk (single write)
      saveWatchIndex(arnsName, index);

      console.log(`\n   📤 Updating ArNS records...`);

      // Upload index to Arweave and update index_ undername
      // Landing page template fetches from index_ dynamically, so no need to update root manifest
      const indexResult = await uploadWatchIndex(ant, arnsName, jwk, DEFAULT_TTL_SECONDS);

      if (!indexResult.success) {
        console.error(`   ❌ Index upload failed: ${indexResult.error}`);
        console.error(`   ⚠️ Posts were archived but index not updated - will retry next cycle`);
      }
    }

    // Update state - use lastProcessedId to ensure failed posts are retried
    // Only use newestId if we successfully processed all posts (lastProcessedId matches newest post)
    // Otherwise, stick with lastProcessedId to retry failed ones
    const allPostsProcessed = posts.length === 0 ||
      (archivedCount + pendingCount === posts.length);

    updateAccountState(watchState, twitterUsername, {
      lastProcessedTweetId: allPostsProcessed ? (newestId || lastProcessedId) : lastProcessedId,
      lastCheckedAt: new Date().toISOString()
    });
    clearAccountError(watchState, twitterUsername);
    saveWatchState(watchState, WATCH_STATE_PATH);
    savePendingState(pendingState, PENDING_STATE_PATH);

    // Summary
    const pendingSummary = getPendingSummary(pendingState);
    const accountPending = pendingSummary.byAccount[twitterUsername] || 0;

    let summaryParts = [`${archivedCount} archived`];
    if (pendingCount > 0) summaryParts.push(`${pendingCount} added to pending`);
    if (accountPending > 0) summaryParts.push(`${accountPending} in pending queue`);

    console.log(`   ✅ Completed: ${summaryParts.join(', ')}`);

    return { success: true, newPosts: archivedCount, pending: accountPending };

  } catch (error) {
    console.error(`   ❌ Error: ${error.message}`);
    recordAccountError(watchState, twitterUsername, error.message);
    saveWatchState(watchState, WATCH_STATE_PATH);
    return { success: false, error: error.message };
  }
}

// ---------- main polling loop ----------

let isPolling = false;

async function pollAllAccounts() {
  if (isPolling) {
    console.log('⏳ Previous poll still running, skipping...');
    return;
  }

  isPolling = true;
  const startTime = Date.now();

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🔭 Watch Mode Poll - ${new Date().toISOString()}`);
  console.log(`${'═'.repeat(60)}`);

  // Check Turbo balance
  try {
    const balance = await getTurboBalanceWithShared(turbo);
    const totalCredits = Number(balance.totalWinc) / 1e12;
    console.log(`💳 Turbo credits: ${totalCredits.toFixed(4)} AR`);

    if (totalCredits < 0.001) {
      console.warn(`⚠️ Low Turbo credits! Consider adding more.`);
    }
  } catch (error) {
    console.warn(`⚠️ Could not check Turbo balance: ${error.message}`);
  }

  const enabledAccounts = getEnabledAccounts(watchConfig);
  let totalArchived = 0;
  let successfulAccounts = 0;
  let failedAccounts = 0;

  for (const account of enabledAccounts) {
    try {
      const result = await processAccount(account);

      if (result.success) {
        successfulAccounts++;
        totalArchived += result.newPosts || 0;
      } else {
        failedAccounts++;
      }
    } catch (error) {
      console.error(`❌ Unexpected error processing @${account.twitterUsername}: ${error.message}`);
      failedAccounts++;
    }

    // Small delay between accounts
    if (enabledAccounts.indexOf(account) < enabledAccounts.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  const summary = getStateSummary(watchState);
  const pendingSummary = getPendingSummary(pendingState);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📊 Poll Complete (${duration}s)`);
  console.log(`   Accounts: ${successfulAccounts} ok, ${failedAccounts} failed`);
  console.log(`   This cycle: ${totalArchived} new post(s)`);
  console.log(`   Total archived: ${summary.totalArchived} post(s)`);
  if (pendingSummary.totalPending > 0) {
    console.log(`   Pending queue: ${pendingSummary.totalPending} post(s)`);
  }
  console.log(`   Next poll: ${watchConfig.pollIntervalMinutes} minutes`);
  console.log(`${'═'.repeat(60)}\n`);

  isPolling = false;
}

async function startPollingLoop() {
  // Initial poll
  await pollAllAccounts();

  // Schedule subsequent polls
  setInterval(pollAllAccounts, POLL_INTERVAL_MS);
}

// ---------- health server ----------

const app = express();

app.get('/', (_req, res) => res.send('watch ok'));

app.get('/debug', (_req, res) => {
  const enabledAccounts = getEnabledAccounts(watchConfig);
  const summary = getStateSummary(watchState);
  const pendingSummary = getPendingSummary(pendingState);

  res.json({
    status: 'running',
    mode: 'watch',
    config: {
      pollIntervalMinutes: watchConfig.pollIntervalMinutes,
      totalAccounts: watchConfig.accounts.length,
      enabledAccounts: enabledAccounts.length,
      accounts: enabledAccounts.map(a => ({
        username: a.twitterUsername,
        arnsName: a.arnsName,
        replyEnabled: a.replyToPost,
        filtering: a.filtering?.enabled ? {
          tier: a.filtering.tier,
          pendingMaxAgeHours: a.filtering.pendingMaxAgeHours,
          thresholds: a.filtering.thresholds
        } : null
      }))
    },
    state: summary,
    pending: pendingSummary,
    templates: {
      landing: WATCH_LANDING_TEMPLATE_TXID,
      post: WATCH_POST_TEMPLATE_TXID
    },
    timestamp: new Date().toISOString()
  });
});

const port = parseInt(process.env.WATCH_PORT || process.env.PORT || '3001', 10);
app.listen(port, () => console.log(`🌐 Watch health server on :${port}`));

// ---------- boot ----------

startPollingLoop().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
