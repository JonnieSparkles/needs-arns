# Watch Mode Filtering - Implementation Plan

This document outlines the implementation plan for the two-phase engagement-based filtering system.

## Overview

The filtering system allows high-volume accounts (mega-posters) to only archive significant posts based on engagement metrics, while smaller accounts can archive everything.

## Implementation Order

### Phase 1: Core Infrastructure

#### 1.1 Update `lib/watch-config.js` - Add Filtering Validation

**Purpose:** Validate the new `filtering` configuration object for each account.

**Changes:**
- Add `validateFilteringConfig(filtering, accountIndex)` function
- Apply defaults for missing fields
- Validate threshold values are positive numbers

**Default values:**
```javascript
const FILTERING_DEFAULTS = {
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
```

#### 1.2 Create `lib/watch-filter.js` - Threshold Evaluation

**Purpose:** Evaluate whether a post meets archival thresholds.

**Functions:**
```javascript
// Check if post should be archived immediately
export function shouldArchiveImmediately(tweet, account, includes)
// Returns: { archive: boolean, reason: string }
// Reasons: 'filtering_disabled', 'has_media', 'meets_threshold', 'pending'

// Check if post meets engagement thresholds
export function meetsEngagementThresholds(metrics, thresholds)
// Returns: { meets: boolean, reasons: string[] }

// Extract metrics from tweet object
export function extractMetrics(tweet)
// Returns: { impressions, likes, replies, retweets }

// Check if post has media
export function hasMedia(tweet)
// Returns: boolean

// Check if post is a self-reply
export function isSelfReply(tweet, accountUserId)
// Returns: { isSelfReply: boolean, parentPostId: string | null }
```

#### 1.3 Create `lib/watch-pending.js` - Pending Queue Management

**Purpose:** Manage the pending posts queue with persistence.

**Functions:**
```javascript
// Load pending state from disk
export function loadPendingState(statePath)

// Save pending state to disk
export function savePendingState(state, statePath)

// Add a post to pending queue
export function addToPending(state, username, pendingPost)

// Remove a post from pending queue
export function removeFromPending(state, username, postId)

// Get all pending posts for an account
export function getPendingPosts(state, username)

// Get all pending post IDs across all accounts (for batch fetch)
export function getAllPendingPostIds(state)

// Update metrics for a pending post
export function updatePendingMetrics(state, username, postId, newMetrics)

// Get expired pending posts (age > maxHours)
export function getExpiredPendingPosts(state, username, maxAgeHours)

// Create pending post entry
export function createPendingEntry(tweet, metrics)
```

**State structure:**
```javascript
{
  version: '1.0',
  lastUpdated: 'ISO timestamp',
  pending: {
    username: [
      {
        postId: 'string',
        detectedAt: 'ISO timestamp',
        lastCheckedAt: 'ISO timestamp',
        checkCount: number,
        initialMetrics: { impressions, likes, replies, retweets },
        latestMetrics: { impressions, likes, replies, retweets },
        hasMedia: boolean,
        text: 'preview...'
      }
    ]
  }
}
```

#### 1.4 Add `getTweetsByIds()` to `lib/twitter.js`

**Purpose:** Batch fetch tweets by ID for re-evaluating pending posts.

**Function:**
```javascript
// Batch fetch tweets by IDs (up to 100 per request)
export async function getTweetsByIds(twitterClient, tweetIds, options = {})
// Returns: { tweets: Map<id, tweet>, notFound: string[] }
```

**API call:**
```
GET /2/tweets?ids=id1,id2,id3...
  &tweet.fields=public_metrics,created_at,author_id,text,attachments
  &expansions=attachments.media_keys
  &media.fields=type
```

---

### Phase 2: Integration

#### 2.1 Update `watch.js` - Main Loop Integration

**Changes to `processAccount()`:**

```javascript
async function processAccount(account) {
  // ... existing setup ...

  // Load pending state
  const pendingState = loadPendingState(PENDING_STATE_PATH);

  // PHASE 1: Process new posts
  for (const tweet of posts) {
    const decision = shouldArchiveImmediately(tweet, account, includes);

    if (decision.archive) {
      // Archive immediately
      await archivePost(tweet, ...);
    } else {
      // Add to pending queue
      addToPending(pendingState, account.twitterUsername, createPendingEntry(tweet));
    }
  }

  // PHASE 2: Re-evaluate pending queue
  await reevaluatePendingPosts(account, pendingState, ...);

  // PHASE 3: Self-reply detection
  await checkSelfReplies(posts, account, ...);

  // Save pending state
  savePendingState(pendingState, PENDING_STATE_PATH);

  // ... rest of existing logic ...
}
```

**New function `reevaluatePendingPosts()`:**
```javascript
async function reevaluatePendingPosts(account, pendingState, ant, jwk, index) {
  const pending = getPendingPosts(pendingState, account.twitterUsername);
  if (pending.length === 0) return;

  // Batch fetch current metrics
  const postIds = pending.map(p => p.postId);
  const { tweets, notFound } = await getTweetsByIds(twitter, postIds);

  // Remove deleted posts
  for (const deletedId of notFound) {
    console.log(`   ⚠️ Pending post ${deletedId} was deleted`);
    removeFromPending(pendingState, account.twitterUsername, deletedId);
  }

  // Evaluate each pending post
  for (const pendingPost of pending) {
    if (notFound.includes(pendingPost.postId)) continue;

    const tweet = tweets.get(pendingPost.postId);
    const metrics = extractMetrics(tweet);
    updatePendingMetrics(pendingState, account.twitterUsername, pendingPost.postId, metrics);

    // Check if now meets thresholds
    if (meetsEngagementThresholds(metrics, account.filtering.thresholds).meets) {
      console.log(`   📈 Pending post ${pendingPost.postId} now meets thresholds`);
      await archivePost(tweet, ...);
      removeFromPending(pendingState, account.twitterUsername, pendingPost.postId);
      continue;
    }

    // Check if expired
    const ageHours = (Date.now() - new Date(pendingPost.detectedAt)) / (1000 * 60 * 60);
    if (ageHours > account.filtering.pendingMaxAgeHours) {
      console.log(`   🗑️ Pending post ${pendingPost.postId} expired after ${ageHours.toFixed(1)}h`);
      removeFromPending(pendingState, account.twitterUsername, pendingPost.postId);
    }
  }
}
```

**New function `checkSelfReplies()`:**
```javascript
async function checkSelfReplies(posts, account, archivedPostIds, ant, jwk) {
  if (!account.filtering?.archiveSelfReplies) return;

  for (const tweet of posts) {
    const selfReply = isSelfReply(tweet, account.twitterUserId);
    if (!selfReply.isSelfReply) continue;

    const parentId = selfReply.parentPostId;
    if (archivedPostIds.has(parentId)) continue;

    console.log(`   🔄 Self-reply detected, archiving parent ${parentId}`);

    // Fetch parent tweet
    const { tweets } = await getTweetsByIds(twitter, [parentId]);
    if (tweets.has(parentId)) {
      await archivePost(tweets.get(parentId), ...);
    }
  }
}
```

#### 2.2 Update `watch-config.example.json`

Add filtering examples for different tier accounts.

---

### Phase 3: Testing & Documentation

#### 3.1 Update CLAUDE.md

Add filtering documentation to the Watch Mode section.

#### 3.2 Manual Testing Checklist

- [ ] Account with `filtering.enabled = false` archives everything
- [ ] Account with filtering archives posts with media immediately
- [ ] Account with filtering adds low-engagement posts to pending
- [ ] Pending posts get re-evaluated each cycle
- [ ] Pending posts that meet thresholds get archived
- [ ] Expired pending posts get discarded
- [ ] Deleted pending posts get removed cleanly
- [ ] Self-replies trigger parent post archival
- [ ] State persists across restarts

---

## File Changes Summary

| File | Type | Description |
|------|------|-------------|
| `lib/watch-filter.js` | New | Threshold evaluation logic |
| `lib/watch-pending.js` | New | Pending queue management |
| `lib/watch-config.js` | Modify | Add filtering config validation |
| `lib/twitter.js` | Modify | Add `getTweetsByIds()` function |
| `watch.js` | Modify | Integrate filtering and pending queue |
| `watch-config.example.json` | Modify | Add filtering examples |
| `CLAUDE.md` | Modify | Document filtering feature |

---

## API Rate Limiting Considerations

**Twitter API v2 Basic tier:**
- `GET /2/tweets` (batch): 300 requests / 15 min
- Up to 100 tweet IDs per request

**Worst case scenario:**
- 10 accounts × 50 pending posts each = 500 pending posts
- 500 / 100 = 5 batch requests per cycle
- Well within rate limits

**Optimization:**
- Batch all pending posts across all accounts into single API calls
- Only re-check posts that are < pendingMaxAgeHours old

---

## Rollback Plan

If issues arise:
1. Set `filtering.enabled = false` for all accounts in config
2. System reverts to archiving all posts immediately
3. No code changes required for rollback

---

## Implementation Effort Estimate

| Task | Complexity | Notes |
|------|------------|-------|
| `lib/watch-filter.js` | Low | Pure functions, no I/O |
| `lib/watch-pending.js` | Low | Similar to existing state management |
| `lib/twitter.js` update | Low | Single new function |
| `lib/watch-config.js` update | Low | Validation logic |
| `watch.js` integration | Medium | Core flow changes |
| Testing | Medium | Multiple scenarios |

---

## Success Criteria

1. ✅ Ultra-whale accounts (Elon) archive ~20-40 posts/day instead of 100+
2. ✅ All viral posts (>500K impressions) are captured
3. ✅ Posts with media are always captured
4. ✅ Self-replies trigger retroactive archival
5. ✅ No data loss for significant posts
6. ✅ Noise posts (low engagement) are filtered out
7. ✅ System handles deleted posts gracefully
