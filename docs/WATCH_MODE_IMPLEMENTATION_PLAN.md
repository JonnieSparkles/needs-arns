# Watch Mode Implementation Plan

This document outlines the step-by-step implementation plan for Watch Mode.

## Prerequisites

Before starting implementation:
- [x] Requirements documented (`docs/WATCH_MODE_REQUIREMENTS.md`)
- [ ] Understand existing codebase patterns (done via analysis)

---

## Phase 1: Configuration & State Management

### 1.1 Create Watch Config Module (`lib/watch-config.js`)

**Purpose:** Load, validate, and manage watch configuration.

**Functions to implement:**
```javascript
export function loadWatchConfig(configPath)
export function validateWatchConfig(config)
export function getEnabledAccounts(config)
```

**Validation rules:**
- `version` must be "1.0"
- `pollIntervalMinutes` must be positive integer (default: 30)
- Each account must have: `twitterUsername`, `twitterUserId`, `arnsName`, `antProcessId`
- `enabled` defaults to true
- `replyToPost` defaults to true

### 1.2 Create Watch State Module (`lib/watch-state.js`)

**Purpose:** Persist and load watch mode state.

**Functions to implement:**
```javascript
export function loadWatchState(statePath)
export function saveWatchState(state, statePath)
export function getAccountState(state, twitterUsername)
export function updateAccountState(state, twitterUsername, updates)
```

**State structure:**
```json
{
  "version": "1.0",
  "lastUpdated": "ISO timestamp",
  "accounts": {
    "username": {
      "lastProcessedTweetId": "string or null",
      "lastCheckedAt": "ISO timestamp",
      "totalArchived": 0,
      "lastError": "string or null"
    }
  }
}
```

### 1.3 Create Example Config (`watch-config.example.json`)

Provide a template for users to copy and customize.

---

## Phase 2: Twitter Timeline Integration

### 2.1 Add Timeline Polling to Twitter Module (`lib/twitter.js`)

**New function:**
```javascript
export async function getUserTweets(twitterClient, userId, sinceId, options)
```

**Implementation details:**
- Use `users/:id/tweets` endpoint
- Request expansions: `author_id`, `attachments.media_keys`
- Tweet fields: `created_at`, `author_id`, `text`, `entities`, `attachments`, `public_metrics`, `conversation_id`, `in_reply_to_user_id`
- Filter out replies (where `in_reply_to_user_id` is set)
- Filter out retweets (where `referenced_tweets` contains type `retweeted`)
- Return newest-first, but we'll process oldest-first

### 2.2 Create Watch Timeline Module (`lib/watch-timeline.js`)

**Purpose:** Orchestrate timeline polling for watched accounts.

**Functions:**
```javascript
export async function pollAccountTimeline(twitterClient, account, lastTweetId)
export function filterOriginalPosts(tweets)
export function sortOldestFirst(tweets)
```

---

## Phase 3: Archive System for Watch Mode

### 3.1 Create Watch Archive Module (`lib/watch-archive.js`)

**Purpose:** Handle archival logic specific to watch mode.

**Functions:**
```javascript
export async function archiveWatchedPost(post, account, includes, jwk)
export function buildWatchMetadataObject(post, account, includes, mediaArray)
export async function createWatchPostArchive(metadataObj, arnsName)
export async function updateWatchIndex(arnsName, newPost)
export async function uploadWatchIndex(ant, arnsName, jwk, ttlSeconds)
export function getWatchArchivePath(arnsName)
```

**Local storage structure:**
```
watch-archive/
├── {arnsName}/
│   ├── metadata/
│   │   └── index.json
│   └── posts/
│       └── {postId}.json
```

### 3.2 Create Watch Landing Page Index Structure

**Index schema (`index.json`):**
```json
{
  "metadata": {
    "watchedAccount": "username",
    "twitterUserId": "12345",
    "arnsName": "account-said",
    "lastUpdated": "ISO timestamp",
    "totalPosts": 0,
    "indexVersion": "1.0"
  },
  "posts": [
    {
      "postId": "tweet_id",
      "text": "Preview text (truncated)...",
      "createdAt": "ISO timestamp",
      "processedAt": "ISO timestamp",
      "manifestTxId": "arweave_txid",
      "metadataTxId": "arweave_txid",
      "mediaCount": 0,
      "hasVideo": false
    }
  ]
}
```

---

## Phase 4: Landing Page Template

### 4.1 Create Watch Landing Template (`archive-templates/watch-landing-template.html`)

**Features:**
- Display watched account info (username, maybe avatar)
- List all archived posts (from index.json)
- Hash-based routing (`/#/postId`)
- When hash present: fetch and render specific post
- When no hash: show post list
- Responsive design matching existing post template style
- Dark theme consistent with post-archive-template.html

**Key JavaScript functions:**
```javascript
function detectGateway()           // Reuse from post template
function loadIndex()               // Fetch index.json
function renderPostList(posts)     // Show all posts
function handleHashRoute()         // Parse /#/postId
function loadAndRenderPost(postId) // Fetch specific post manifest/metadata
```

### 4.2 Manifest with Fallback for Hash Routing

**Critical:** The landing page manifest must use `fallback` to handle all paths:

```json
{
  "manifest": "arweave/paths",
  "version": "0.2.0",
  "index": { "path": "index.html" },
  "fallback": { "id": "landing-template-txid" },
  "paths": {
    "index.html": { "id": "landing-template-txid" },
    "index.json": { "id": "index-json-txid" }
  }
}
```

The `fallback` ensures any unmatched path (like `/#/1234567890`) still serves the landing page HTML.

---

## Phase 5: Reply System

### 5.1 Create Watch Reply Function

**Location:** Can be in `lib/watch-archive.js` or reuse `lib/twitter.js`

**Reply template:**
```
📸 Archived permanently on Arweave!

🔗 https://{arnsName}.ar.io/#/{postId}

✨ Powered by @ArNSdomains
```

**Behavior:**
- Check `replyToPost` config before attempting
- Rate limit: minimum 60 seconds between replies
- On failure: log warning, continue (don't fail the archive)
- Track reply status in post metadata

---

## Phase 6: Main Entry Point

### 6.1 Create `watch.js`

**Structure:**
```javascript
// 1. Load environment
import 'dotenv/config';

// 2. Load configuration
const config = loadWatchConfig(WATCH_CONFIG_PATH);

// 3. Initialize clients
const twitter = getTwitterClient({...});
const turbo = getTurboClient(jwk);

// 4. Load state
let state = loadWatchState(WATCH_STATE_PATH);

// 5. Main polling loop
async function pollAllAccounts() {
  for (const account of getEnabledAccounts(config)) {
    await processAccount(account);
  }
  // Schedule next poll
}

// 6. Process single account
async function processAccount(account) {
  // Initialize ANT for this account
  // Poll timeline
  // Filter to original posts
  // Process each new post
  // Update index
  // Save state
}

// 7. Health server (optional, same pattern as index.js)

// 8. Start polling
```

### 6.2 Add npm Script

**In `package.json`:**
```json
{
  "scripts": {
    "watch": "node watch.js"
  }
}
```

---

## Phase 7: Documentation & Testing

### 7.1 Update CLAUDE.md

Add watch mode section covering:
- New commands (`npm run watch`)
- Configuration file format
- Environment variables
- Architecture overview

### 7.2 Update README.md (optional)

Add watch mode documentation for end users.

### 7.3 Manual Testing Checklist

- [ ] Config loads and validates correctly
- [ ] State persists across restarts
- [ ] Timeline polling returns correct tweets
- [ ] Original posts filtered correctly (no replies/RTs)
- [ ] Media uploads succeed
- [ ] Manifests created correctly
- [ ] Landing page index updates
- [ ] ArNS records update (root + index undername)
- [ ] Replies sent successfully
- [ ] Hash routing works on landing page
- [ ] Error handling doesn't crash the loop

---

## File Summary

### New Files (9 files)

| File | Purpose |
|------|---------|
| `watch.js` | Main entry point for watch mode |
| `lib/watch-config.js` | Configuration loading and validation |
| `lib/watch-state.js` | State persistence |
| `lib/watch-archive.js` | Archive creation and index management |
| `lib/watch-timeline.js` | Twitter timeline polling |
| `archive-templates/watch-landing-template.html` | Landing page template |
| `watch-config.example.json` | Example configuration |
| `docs/WATCH_MODE_REQUIREMENTS.md` | Requirements (already created) |
| `docs/WATCH_MODE_IMPLEMENTATION_PLAN.md` | This file |

### Modified Files (3 files)

| File | Changes |
|------|---------|
| `lib/twitter.js` | Add `getUserTweets()` function |
| `package.json` | Add `watch` script |
| `CLAUDE.md` | Document watch mode |

---

## Implementation Order

Recommended order to minimize dependencies and enable incremental testing:

1. **Config & State** (can test independently)
   - `lib/watch-config.js`
   - `lib/watch-state.js`
   - `watch-config.example.json`

2. **Twitter Integration** (can test with real API)
   - `lib/twitter.js` (add `getUserTweets`)
   - `lib/watch-timeline.js`

3. **Archive System** (can test with mock data)
   - `lib/watch-archive.js`

4. **Landing Page** (can test in browser)
   - `archive-templates/watch-landing-template.html`

5. **Main Entry Point** (integration)
   - `watch.js`
   - `package.json`

6. **Documentation**
   - `CLAUDE.md`

---

## Estimated Effort

| Phase | Complexity | Notes |
|-------|------------|-------|
| Phase 1: Config & State | Low | Similar to existing patterns |
| Phase 2: Twitter Timeline | Medium | New API endpoint, filtering logic |
| Phase 3: Archive System | Medium | Adapts existing patterns |
| Phase 4: Landing Page | Medium-High | New HTML template with JS routing |
| Phase 5: Reply System | Low | Reuses existing reply function |
| Phase 6: Entry Point | Medium | Orchestration logic |
| Phase 7: Documentation | Low | Updates to existing docs |

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Twitter API rate limits | Implement backoff, respect limits |
| ArNS update failures | Retry with backoff, log failures |
| Turbo credit exhaustion | Preflight balance check, warnings |
| Blocked by watched account | Archive succeeds, reply fails gracefully |
| Landing page JS errors | Thorough testing, error boundaries |
| State corruption | Atomic writes, backup before modify |
