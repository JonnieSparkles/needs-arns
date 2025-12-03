# Watch Mode Requirements

This document defines the complete requirements for the "Watch Mode" feature of NeedsArNS.

## Overview

Watch Mode is an automated archival system that monitors specific Twitter/X accounts and permanently archives their posts to Arweave. Each watched account gets a dedicated ArNS name with a landing page that aggregates all archived posts.

## Core Concept

```
Watch @elonmusk → elon-musk-said.ar.io
  ├── Root (elon-musk-said.ar.io) → Landing page HTML (lists all posts)
  ├── index_elon-musk-said.ar.io → JSON index of all posts
  └── {postId}_elon-musk-said.ar.io → Individual post archives
```

**Alternative URL scheme (hash-based routing):**
- `elon-musk-said.ar.io` → Landing page
- `elon-musk-said.ar.io/#/1234567890` → Deep link to specific post (rendered by landing page JS)

This approach requires only ONE ArNS record update per cycle (the landing page/index) rather than one per post, significantly reducing ArNS update overhead.

---

## Functional Requirements

### FR-1: Account Configuration

**FR-1.1:** System shall support configuring multiple Twitter accounts to watch.

**FR-1.2:** Each watched account configuration shall include:
- `twitterUsername` (string, required) - Twitter handle without @
- `twitterUserId` (string, required) - Twitter numeric user ID
- `arnsName` (string, required) - ArNS name for this account (e.g., "elon-musk-said")
- `antProcessId` (string, required) - ANT process ID for this ArNS name
- `enabled` (boolean, default: true) - Whether watching is active
- `replyToPost` (boolean, default: true) - Whether to reply to archived posts
- `filtering` (object, optional) - Engagement-based filtering configuration (see FR-8)

**FR-1.3:** Configuration shall be stored in a JSON file at path specified by `WATCH_CONFIG_PATH` environment variable (default: `./watch-config.json`).

**FR-1.4:** Example configuration structure:
```json
{
  "version": "1.0",
  "pollIntervalMinutes": 30,
  "accounts": [
    {
      "twitterUsername": "elonmusk",
      "twitterUserId": "44196397",
      "arnsName": "elon-musk-said",
      "antProcessId": "abc123...",
      "enabled": true,
      "replyToPost": true,
      "filtering": {
        "enabled": true,
        "tier": "ultra-whale",
        "thresholds": {
          "minImpressions": 500000,
          "minLikes": 50000,
          "minReplies": 5000,
          "minRetweets": 5000
        },
        "alwaysArchiveMedia": true,
        "archiveSelfReplies": true,
        "pendingMaxAgeHours": 24
      }
    },
    {
      "twitterUsername": "small_creator",
      "twitterUserId": "987654321",
      "arnsName": "small-creator-said",
      "antProcessId": "def456...",
      "enabled": true,
      "replyToPost": true,
      "filtering": {
        "enabled": false
      }
    }
  ]
}
```

### FR-2: Timeline Polling

**FR-2.1:** System shall poll each enabled watched account's timeline every 30 minutes (configurable via `pollIntervalMinutes`).

**FR-2.2:** System shall use Twitter API v2 `users/:id/tweets` endpoint with expansions for:
- `author_id`
- `attachments.media_keys`
- Tweet fields: `created_at`, `author_id`, `text`, `entities`, `attachments`, `public_metrics`, `conversation_id`
- User fields: `username`, `name`, `verified`, `profile_image_url`
- Media fields: `type`, `url`, `preview_image_url`, `width`, `height`, `variants`, `alt_text`

**FR-2.3:** System shall only process original posts (not replies, retweets, or quote tweets) in v1.0. Future versions may extend to replies and quote tweets with content.

**FR-2.4:** System shall track `lastProcessedTweetId` per account to avoid reprocessing.

**FR-2.5:** System shall process posts from oldest to newest within each polling cycle.

### FR-3: Post Archival

**FR-3.1:** For each new post detected, system shall:
1. Download all media attachments (images, videos, GIFs)
2. Upload media to Arweave via Turbo SDK
3. Build metadata object with complete tweet data
4. Upload metadata.json to Arweave
5. Generate and upload Arweave manifest
6. Update account's landing page (see FR-4)
7. Reply to the post (if `replyToPost` is enabled)

**FR-3.2:** Archive metadata structure shall include:
```json
{
  "metadata": {
    "postId": "1234567890",
    "watchedAccount": "elonmusk",
    "arnsName": "elon-musk-said",
    "processedAt": "2025-12-03T...",
    "archiveType": "watch_mode",
    "archiveVersion": "2.0.0"
  },
  "rawApiResponse": {
    "fetchedAt": "...",
    "tweet": { /* full raw tweet object */ },
    "includes": { /* users, media */ }
  },
  "archive": {
    "htmlTxId": "...",
    "metadataTxId": "...",
    "manifestTxId": "...",
    "media": [
      { "index": 0, "type": "photo", "txId": "...", "alt_text": "..." }
    ]
  }
}
```

**FR-3.3:** System shall use the existing `post-archive-template.html` for individual post rendering, with modifications for watch mode context (different footer attribution).

**FR-3.4:** Manifest structure shall follow existing arweave/paths v0.2.0 format:
```json
{
  "manifest": "arweave/paths",
  "version": "0.2.0",
  "index": { "path": "index.html" },
  "paths": {
    "index.html": { "id": "template-txid" },
    "metadata.json": { "id": "metadata-txid" },
    "media/0.jpg": { "id": "media-txid" }
  }
}
```

### FR-4: Landing Page

**FR-4.1:** Each watched account shall have a dedicated landing page at the root of its ArNS name (e.g., `elon-musk-said.ar.io`).

**FR-4.2:** Landing page shall:
- Display account information (username, profile image if available)
- List all archived posts in reverse chronological order (newest first)
- Support hash-based routing for deep links (e.g., `#/1234567890`)
- Load individual post content dynamically when deep linked
- Fetch post data from the JSON index

**FR-4.3:** Landing page index shall be stored at `index_<arnsName>.ar.io` containing:
```json
{
  "metadata": {
    "watchedAccount": "elonmusk",
    "arnsName": "elon-musk-said",
    "lastUpdated": "2025-12-03T...",
    "totalPosts": 42,
    "indexVersion": "1.0"
  },
  "posts": [
    {
      "postId": "1234567890",
      "text": "Tweet text preview...",
      "createdAt": "2025-12-03T...",
      "processedAt": "2025-12-03T...",
      "manifestTxId": "abc123...",
      "mediaCount": 2,
      "hasVideo": false
    }
  ]
}
```

**FR-4.4:** Landing page HTML template shall be a new file: `archive-templates/watch-landing-template.html`.

**FR-4.5:** On each polling cycle with new posts, system shall:
1. Update the JSON index with new posts
2. Upload new index to Arweave
3. Update `index_<arnsName>` ArNS record to point to new index
4. Landing page at root ArNS name points to static template that fetches index dynamically

### FR-5: Twitter Replies

**FR-5.1:** When `replyToPost` is enabled for an account, system shall reply to each archived post.

**FR-5.2:** Reply message format:
```
📸 Archived permanently on Arweave!

🔗 https://{postId}_{arnsName}.ar.io

✨ Powered by @ArNSdomains
```

**FR-5.3:** If reply fails (e.g., account blocked the bot), system shall:
- Log warning with details
- Continue with archival (archive succeeds even if reply fails)
- Not retry the reply

**FR-5.4:** System shall implement reply rate limiting (1 reply per minute minimum between replies).

### FR-6: State Persistence

**FR-6.1:** Watch state shall be stored in `watch-state.json` (single file for all accounts).

**FR-6.2:** State structure:
```json
{
  "version": "1.0",
  "lastUpdated": "2025-12-03T...",
  "accounts": {
    "elonmusk": {
      "lastProcessedTweetId": "1234567890",
      "lastCheckedAt": "2025-12-03T...",
      "totalArchived": 42,
      "lastError": null
    }
  }
}
```

**FR-6.3:** State shall be saved after each post is processed (not batched).

**FR-6.4:** State file location shall respect `RAILWAY_VOLUME_MOUNT_PATH` for persistent storage.

### FR-7: Local Archive Storage

**FR-7.1:** System shall store local copies of archived post data in:
```
watch-archive/
├── {arnsName}/
│   ├── metadata/
│   │   └── index.json           # Local copy of the landing page index
│   └── posts/
│       └── {postId}.json        # Individual post metadata files
```

**FR-7.2:** Local archive serves as backup and enables offline tools/debugging.

### FR-8: Engagement-Based Filtering (Two-Phase Archival)

For high-volume accounts (mega-posters), the system supports engagement-based filtering to archive only significant posts while avoiding noise.

#### FR-8.1: Filtering Configuration

Each account may have a `filtering` configuration object:

```json
{
  "filtering": {
    "enabled": true,
    "tier": "ultra-whale",
    "thresholds": {
      "minImpressions": 500000,
      "minLikes": 50000,
      "minReplies": 5000,
      "minRetweets": 5000
    },
    "alwaysArchiveMedia": true,
    "archiveSelfReplies": true,
    "pendingMaxAgeHours": 24
  }
}
```

**Fields:**
- `enabled` (boolean, default: false) - Whether filtering is active. If false, all posts are archived immediately.
- `tier` (string, optional) - Descriptive tier name for documentation (e.g., "ultra-whale", "mid-whale")
- `thresholds` (object) - Engagement thresholds; post is archived if ANY threshold is met
  - `minImpressions` (number) - Minimum impression count
  - `minLikes` (number) - Minimum like count
  - `minReplies` (number) - Minimum reply count
  - `minRetweets` (number) - Minimum retweet count
- `alwaysArchiveMedia` (boolean, default: true) - Always archive posts containing media regardless of engagement
- `archiveSelfReplies` (boolean, default: true) - Retroactively archive posts that the account later replies to
- `pendingMaxAgeHours` (number, default: 24) - Hours to keep post in pending queue before discarding

#### FR-8.2: Tier Presets (Reference)

| Tier | Followers | Impressions | Likes | Replies | Retweets |
|------|-----------|-------------|-------|---------|----------|
| `ultra-whale` | >50M | 500,000 | 50,000 | 5,000 | 5,000 |
| `large-whale` | 10-50M | 200,000 | 20,000 | 2,000 | 2,000 |
| `mid-whale` | 1-10M | 50,000 | 5,000 | 500 | 500 |
| `small-whale` | 100K-1M | 10,000 | 1,000 | 100 | 100 |
| `disabled` | <100K | Archive all (filtering disabled) | - | - | - |

#### FR-8.3: Two-Phase Archival Flow

**Phase 1 - Detection (every poll cycle):**
1. Fetch new posts from timeline
2. For each new post, evaluate:
   - If `filtering.enabled = false` → Archive immediately
   - If post has media AND `alwaysArchiveMedia = true` → Archive immediately
   - If post meets any threshold → Archive immediately
   - Otherwise → Add to pending queue

**Phase 2 - Re-evaluation (every poll cycle):**
1. For all posts in pending queue:
   - Re-fetch current metrics from Twitter API (batched)
   - If post now meets any threshold → Archive and remove from pending
   - If post age > `pendingMaxAgeHours` → Discard (didn't make the cut)
   - Otherwise → Keep in pending for next cycle

**Self-Reply Detection:**
- When processing new posts, detect if any are self-replies (account replying to own post)
- If self-reply detected AND parent post not archived → Retroactively archive parent post
- This catches important posts that initially had low engagement but the account later engaged with

#### FR-8.4: Pending State Structure

Pending posts are stored in `watch-pending-state.json`:

```json
{
  "version": "1.0",
  "lastUpdated": "2025-12-03T...",
  "pending": {
    "elonmusk": [
      {
        "postId": "1234567890",
        "detectedAt": "2025-12-03T10:00:00Z",
        "lastCheckedAt": "2025-12-03T10:30:00Z",
        "checkCount": 1,
        "initialMetrics": {
          "impressions": 50000,
          "likes": 5000,
          "replies": 200,
          "retweets": 100
        },
        "latestMetrics": {
          "impressions": 150000,
          "likes": 15000,
          "replies": 800,
          "retweets": 400
        },
        "hasMedia": false,
        "text": "Preview text for logging..."
      }
    ]
  }
}
```

#### FR-8.5: Immediate Archive Conditions

A post is archived immediately (bypasses pending queue) if ANY of these conditions are true:
1. `filtering.enabled = false` for the account
2. Post contains media (photo, video, GIF) AND `alwaysArchiveMedia = true`
3. Post meets ANY engagement threshold at detection time
4. Post is a self-reply (account replying to own older post) - parent post archived retroactively

#### FR-8.6: API Efficiency

- Re-fetching metrics uses batched Twitter API call: `GET /2/tweets?ids=id1,id2,...`
- Up to 100 tweet IDs per request
- Minimizes API calls when many posts are pending

#### FR-8.7: Deleted Post Handling

If a pending post is deleted before archival:
- Twitter API returns 404 or excludes from batch response
- Log warning: "Post {id} deleted before archival"
- Remove from pending queue
- Do not count as error (this is expected for controversial posts)

---

## Non-Functional Requirements

### NFR-1: Performance

**NFR-1.1:** Polling cycle shall complete within 5 minutes for up to 10 watched accounts.

**NFR-1.2:** System shall process accounts sequentially to avoid rate limit issues.

**NFR-1.3:** System shall implement 2-second delay between processing individual posts.

### NFR-2: Reliability

**NFR-2.1:** System shall continue processing remaining accounts if one account fails.

**NFR-2.2:** System shall retry failed uploads up to 3 times with exponential backoff.

**NFR-2.3:** System shall handle Twitter API rate limits gracefully (backoff and retry).

### NFR-3: Observability

**NFR-3.1:** System shall log:
- Start/end of each polling cycle
- Each account being checked
- Each post being processed
- Upload successes/failures
- Reply successes/failures
- State save operations

**NFR-3.2:** Log format shall match existing bot log style with emoji prefixes.

### NFR-4: Cost Management

**NFR-4.1:** System shall check Turbo credit balance before starting each cycle.

**NFR-4.2:** System shall log estimated cost per post and running total.

**NFR-4.3:** System shall warn when credits fall below configurable threshold.

---

## URL Scheme Decision

### Option A: Undername per Post (Original Proposal)
```
elon-musk-said.ar.io → Landing page
1234567890_elon-musk-said.ar.io → Post archive
index_elon-musk-said.ar.io → JSON index
```

**Pros:**
- Direct, permanent URLs for each post
- Standard ArNS pattern
- SEO-friendly

**Cons:**
- Requires ArNS record update for EVERY post (slow, AO message per post)
- More complex ArNS management
- Higher operational overhead

### Option B: Hash-Based Routing (Recommended)
```
elon-musk-said.ar.io → Landing page (handles all routing)
elon-musk-said.ar.io/#/1234567890 → Deep link to post
index_elon-musk-said.ar.io → JSON index with all post manifest TXIDs
```

**Pros:**
- Only 2 ArNS records total (root + index)
- Landing page fetches post data from index
- Simpler, faster updates
- Still provides permanent, shareable links

**Cons:**
- URLs slightly less clean (hash fragment)
- Requires JavaScript for deep linking
- Less SEO-friendly (but archives are for permanence, not SEO)

### Decision: **Option B (Hash-Based Routing)**

The landing page at root will handle routing. When someone visits `elon-musk-said.ar.io/#/1234567890`:
1. Landing page loads
2. JavaScript parses hash fragment
3. Fetches post manifest from index
4. Renders post content inline OR redirects to manifest URL

This significantly reduces ArNS update overhead from O(n) to O(1) per cycle.

---

## Architecture

### New Files to Create

1. **`watch.js`** - Main entry point for watch mode
2. **`lib/watch-config.js`** - Configuration loading and validation (including filtering config)
3. **`lib/watch-state.js`** - State persistence for watch mode
4. **`lib/watch-archive.js`** - Archive management for watched accounts
5. **`lib/watch-timeline.js`** - Twitter timeline polling logic
6. **`lib/watch-filter.js`** - Engagement threshold evaluation logic
7. **`lib/watch-pending.js`** - Pending queue management for two-phase archival
8. **`archive-templates/watch-landing-template.html`** - Landing page template
9. **`watch-config.example.json`** - Example configuration file

### Files to Modify

1. **`lib/twitter.js`** - Add `getUserTweets()` and `getTweetsByIds()` functions
2. **`lib/arweave.js`** - No changes needed (reuse existing upload functions)
3. **`lib/manifest.js`** - Minor updates for watch mode metadata
4. **`package.json`** - Add `npm run watch` script
5. **`CLAUDE.md`** - Document watch mode

### Data Flow

```
┌─────────────────┐
│   watch.js      │  Entry point, orchestrates polling loop
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ watch-config.js │  Load & validate watch-config.json
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│watch-timeline.js│  Poll Twitter API for each account
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ watch-filter.js │  Evaluate engagement thresholds
└────────┬────────┘
         │
         ├──► Meets threshold OR has media? ──► Archive immediately
         │
         └──► Below threshold? ──► Add to pending queue
                                          │
                                          ▼
                                   ┌──────────────┐
                                   │watch-pending │  Manage pending queue
                                   │     .js      │  Re-evaluate each cycle
                                   └──────────────┘
         │
         ▼
┌─────────────────┐
│watch-archive.js │  Create archives, upload to Arweave
└────────┬────────┘
         │
         ├──► lib/arweave.js (upload media, metadata, manifest)
         ├──► lib/arns.js (update ArNS records)
         └──► lib/twitter.js (send replies)
         │
         ▼
┌─────────────────┐
│ watch-state.js  │  Persist state to watch-state.json
└─────────────────┘
```

### Filtering Data Flow (Detailed)

```
Poll Cycle Start
       │
       ▼
┌──────────────────────────────────────────────────────────────────┐
│  PHASE 1: Process New Posts                                       │
├──────────────────────────────────────────────────────────────────┤
│  For each new post from timeline:                                 │
│                                                                   │
│  ┌─ filtering.enabled = false? ────────────────► ARCHIVE NOW     │
│  │                                                                │
│  ├─ Has media + alwaysArchiveMedia? ───────────► ARCHIVE NOW     │
│  │                                                                │
│  ├─ Meets any threshold (likes/impressions/etc)? ► ARCHIVE NOW   │
│  │                                                                │
│  └─ None of the above ─────────────────────────► ADD TO PENDING  │
└──────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────┐
│  PHASE 2: Re-evaluate Pending Queue                               │
├──────────────────────────────────────────────────────────────────┤
│  1. Batch fetch metrics for all pending posts (GET /2/tweets)     │
│                                                                   │
│  For each pending post:                                           │
│  ┌─ Post deleted (404)? ───────────────────────► REMOVE (missed) │
│  │                                                                │
│  ├─ Now meets threshold? ──────────────────────► ARCHIVE + REMOVE│
│  │                                                                │
│  ├─ Age > pendingMaxAgeHours? ─────────────────► DISCARD (noise) │
│  │                                                                │
│  └─ Still below threshold ─────────────────────► KEEP IN PENDING │
└──────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────────┐
│  PHASE 3: Self-Reply Detection                                    │
├──────────────────────────────────────────────────────────────────┤
│  For each new post that is a reply:                               │
│  ┌─ Is reply to self (same author)? ──────────► Check parent     │
│  │                                                │               │
│  │                                    ┌───────────┘               │
│  │                                    ▼                           │
│  │                           Parent not archived?                 │
│  │                                    │                           │
│  │                                    ▼                           │
│  │                           ARCHIVE PARENT (retroactive)         │
│  │                                                                │
│  └─ Not a self-reply ──────────────────────────► Skip             │
└──────────────────────────────────────────────────────────────────┘
       │
       ▼
   Save State
```

---

## Environment Variables

### New Variables for Watch Mode

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `WATCH_CONFIG_PATH` | No | `./watch-config.json` | Path to watch configuration file |
| `WATCH_TEMPLATE_HTML_TXID` | Yes | - | TXID of uploaded watch-landing-template.html |
| `WATCH_POST_TEMPLATE_HTML_TXID` | No | Uses `TEMPLATE_HTML_TXID` | TXID of post template for watch mode |

### Existing Variables (Reused)

- `ARWEAVE_WALLET_PATH` or `ARWEAVE_JWK_JSON`
- `TURBO_USE_SHARED_CREDITS`
- `TURBO_SHARED_CREDITS_PAID_BY`
- Twitter API credentials (same as main bot)

---

## Reply Configuration

The main bot has `ENABLE_RETWEETS` as a global setting. Watch mode uses per-account `replyToPost` configuration, allowing:
- Some accounts: archive + reply
- Other accounts: archive only (silent)

This mirrors the flexibility requested.

---

## Blocked Account Behavior

If a watched account blocks the bot:

1. **Timeline Access:** Still works - public tweets are visible regardless of block status
2. **Reply Ability:** Blocked - Twitter API will return error when attempting to reply
3. **System Behavior:**
   - Archive proceeds normally (upload to Arweave succeeds)
   - Reply attempt fails, logged as warning
   - Post marked as archived in state (reply_status: "blocked" or "failed")
   - No retry of reply
   - Continue to next post

---

## Future Extensions (Out of Scope for v1)

1. **Replies & Quote Tweets:** Archive replies and quote tweets with meaningful content
2. **Thread Detection:** Detect and archive entire threads as single units
3. **Backfill:** Historical archival of past posts
4. **Webhook Mode:** Real-time archival via Twitter webhooks (requires elevated API access)
5. **Multi-wallet Support:** Different wallets for different watched accounts
6. **Analytics Dashboard:** Web interface for monitoring archive status

---

## Open Questions (Resolved)

| Question | Resolution |
|----------|------------|
| Who owns ANT processes? | Centralized (we own all) |
| Twitter API tier? | Paid (supports multiple accounts) |
| Reply to every post? | Configurable per account via `replyToPost` |
| What to archive? | Original posts only (v1), full content (text + media) |
| Backfill historical? | Not in v1 |
| Landing page location? | Root of ArNS name (e.g., `elon-musk-said.ar.io`) |
| Index location? | `index_<arnsName>.ar.io` |
| Polling frequency? | 30 minutes (configurable) |
| State storage? | Single `watch-state.json` file |
| Quota system? | Does not apply to watch mode |

---

## Acceptance Criteria

### Minimum Viable Watch Mode

1. ✅ Can configure one or more Twitter accounts to watch
2. ✅ Polls configured accounts every 30 minutes
3. ✅ Detects new original posts (not replies/retweets)
4. ✅ Downloads and uploads media to Arweave
5. ✅ Creates metadata.json and manifest for each post
6. ✅ Updates landing page index after each cycle
7. ✅ Replies to posts (when enabled)
8. ✅ Persists state across restarts
9. ✅ Handles errors gracefully (continues processing)
10. ✅ Runs independently from main mention bot

### Success Metrics

- Posts are archived within 35 minutes of posting (30 min poll + 5 min processing)
- Landing page always reflects current archive state
- Zero data loss (all detected posts are archived)
- Replies sent within 1 minute of archive completion
