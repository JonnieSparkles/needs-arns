# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**needs-arns** is a production-ready Twitter bot that assigns ArNS (Arweave Name Service) subdomains to Arweave content. It supports three command modes:

1. **`name this <subdomain>`** - Direct ArNS mapping without archival
2. **`assign <subdomain>`** or **`archive <subdomain>`** - Creates complete tweet replica archive with manifest on Arweave

The bot uses Turbo SDK for fast Arweave uploads and supports shared credits configuration.

## Development Commands

### Running the Bot
```bash
npm install              # Install dependencies
npm start               # Start mention bot (polls Twitter mentions)
npm run manual          # Interactive manual mode (bypass polling)
npm run watch           # Watch mode (monitors specific accounts)
```

### Tools & Utilities
```bash
node tools/backfill-archive.js 5                    # Backfill existing mentions
node tools/recreate-manifests-from-archive.js 5     # Recreate manifests from archive
node tools/update-template-from-archive.js 5        # Update template across archives
node tools/refresh-single-mention.js               # Refresh single mention
node tools/retry-arns-updates.js                   # Retry failed ArNS updates
node tools/test-turbo-credits.js                   # Check Turbo credit balance
```

All archive tools support `--dry-run` and `--force` flags. See `tools/ARCHIVE_SCRIPTS_README.md` for details.

## Architecture & Code Structure

### Module Organization (`lib/`)

The codebase follows a clean modular architecture with **zero code duplication** between bot and manual modes:

- **`utils.js`** - Core utilities: validation (`isValidUndername`), environment (`requireEnv`, `getJwkFromEnv`), error categorization (`isInfrastructureErrorType`), regex patterns (`ARWEAVE_TXID_RE`, `ASSIGN_CMD_RE`)
- **`arweave.js`** - Arweave/Turbo client factory, upload functions, shared credits support, balance checking, cost estimation
- **`archive.js`** - Archive management with ArNS integration: `createMentionArchive`, `updateMentionArchive`, `buildMetadataObject`, `uploadAndAssignArchiveIndex`
- **`twitter.js`** - Twitter API client factory (`getTwitterClient`), reply/retweet functions, rate limiting
- **`arns.js`** - ArNS operations: `checkUndernameAvailability`, `createUndernameRecord` (includes timeout handling and verification)
- **`media.js`** - Media processing: `hasMediaAttachments`, `extractTxIdFromTweetData`, `getMediaUrls`, `processMediaFromTweet`
- **`mentions.js`** - Mention processing: `fetchParentTweet`, `fetchParentUser`, `isUserAllowed`, `extractCommandFromMention`, error handlers
- **`state.js`** - State persistence: `saveProcessedState`, `loadProcessedState`
- **`manifest.js`** - Arweave manifest generation (`generateManifest`)
- **`quota.js`** - User quota tracking: tier management (free/pro/enterprise), monthly usage limits, `checkQuota`, `incrementUsage`

### Watch Mode Modules (`lib/watch-*.js`)

- **`watch-config.js`** - Configuration loading/validation for watched accounts
- **`watch-state.js`** - State persistence (last processed tweet ID per account)
- **`watch-timeline.js`** - Timeline polling, filtering original posts
- **`watch-archive.js`** - Archive creation, index management, landing page updates
- **`watch-filter.js`** - Engagement filtering with tier presets (ultra-whale, large-whale, medium, small)

### Template System (`response-templates/`)

Centralized response templates with automatic truncation and variable substitution:
- `loader.js` - Template rendering engine
- `success-post-archive.json` - Full success message (falls back to truncated version if >280 chars)
- `error-*.json` - Various error templates
- All templates support `{variable}` placeholders

### Archive Structure

```
archive/
├── metadata/
│   └── archive-index.json     # Master index of all mentions
└── mentions/
    └── {mentionId}.json       # Individual mention files with complete Twitter data
```

Each mention file contains:
- `rawApiResponse` - Complete Twitter API response
- `mentionTweet` / `parentTweet` - Tweet objects
- `includes` - Users and media from Twitter API
- `archive` - Archive metadata (txIds, manifest, undername, timestamps)

### Entry Points

- **`index.js`** - Main mention bot: polls Twitter mentions, processes commands
- **`manual.js`** - Interactive mode: manual uploads, tweet extraction, reply preview
- **`watch.js`** - Watch mode: monitors specific accounts, archives their posts automatically

## Key Technical Patterns

### ArNS Record Updates

When updating ArNS records via `@ar.io/sdk`:
- **TTL limits**: 60-86400 seconds (enforced by ArNS)
- **Timeout handling**: `createUndernameRecord` uses 120s timeout with verification fallback
- If timeout occurs, the code verifies whether the record was actually created via `ant.getRecords()`

### Error Categorization

The bot distinguishes between:
- **Infrastructure errors** (no user reply): 429 rate limits, 5xx errors, network issues, timeouts, Arweave/Turbo outages
- **User errors** (reply to user): invalid undername, no content, access denied, name taken

Use `isInfrastructureErrorType(err)` to determine if error should skip user notification.

### Turbo Uploads & Shared Credits

```javascript
// Get Turbo client (singleton)
const turbo = getTurboClient(jwk);

// Check balance including shared credits
const balance = await getTurboBalanceWithShared(turbo);
// Returns: { nativeWinc, sharedWinc, totalWinc, receivedApprovals }

// Estimate cost and validate before upload
const estimatedWinc = await estimateUploadCostWinc(turbo, byteCount);
assertSufficientCredits(estimatedWinc, balance);

// Upload (jwk required, handles shared credits internally)
const txId = await uploadToArweave(buffer, contentType, 'App-Name', jwk);
```

**Shared credits configuration** in `.env`:
- `TURBO_USE_SHARED_CREDITS=true` - Enable auto-discovery
- `TURBO_SHARED_CREDITS_PAID_BY=addr1,addr2` - Optional explicit payer addresses

### Twitter API Efficiency

The bot uses **single optimized API call per cycle** with expansions:
```javascript
const mentions = await twitter.v2.get('users/:id/mentions', {
  expansions: 'author_id,referenced_tweets.id,attachments.media_keys',
  'tweet.fields': 'created_at,author_id,text,referenced_tweets,attachments',
  'user.fields': 'username',
  'media.fields': 'url,preview_image_url,type,variants,alt_text',
});
```

### Manifest Structure

Archives use **arweave/paths v0.2.0** manifest format:
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

**Template system** (when `TEMPLATE_HTML_TXID` is set):
- Manifest points `index.html` to shared template
- Template fetches `metadata.json` and renders dynamically
- Results in 62% data reduction (2 files vs 3)

## Important Environment Variables

**Required:**
- Twitter API: `TWITTER_APP_KEY`, `TWITTER_APP_SECRET`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_SECRET`
- ArNS: `ROOT_ARNS_NAME`, `ANT_PROCESS_ID`
- Wallet: `ARWEAVE_WALLET_PATH` or `ARWEAVE_JWK_JSON`
- Template: `TEMPLATE_HTML_TXID` (upload `archive-templates/post-archive-template.html` first)

**Optional but important:**
- `TURBO_USE_SHARED_CREDITS=true` - Enable shared credits
- `POLL_INTERVAL_MINUTES=16` - Twitter free plan (1 req/15min with buffer)
- `ALLOWED_USERS=user1,user2` - Whitelist (empty = open access)
- `MENTION_MAX_AGE_HOURS=24` - Time window for processing
- `ENABLE_RETWEETS=true` - Retweet success messages

## Common Development Tasks

### Adding New Command Types

1. Update command regex in `lib/utils.js` (e.g., `ASSIGN_CMD_RE`)
2. Modify `extractCommandFromMention` in `lib/mentions.js`
3. Add handler logic in `handleMention` function (`index.js`)
4. Create response template in `response-templates/`

### Modifying Archive Structure

1. Update `buildMetadataObject` in `lib/archive.js`
2. Update manifest generation in `lib/manifest.js`
3. Test with manual mode first: `npm run manual`
4. Use `tools/recreate-manifests-from-archive.js` to migrate existing archives

### Adding New Error Types

1. Add template in `response-templates/error-*.json`
2. Add handler in `lib/mentions.js` (e.g., `handleNameTaken`)
3. Categorize in `isInfrastructureErrorType` if infrastructure-related

### Testing Turbo Uploads

```bash
node tools/test-turbo-credits.js  # Check balance and shared credits
```

## SDK Documentation

- **ArNS SDK**: https://github.com/ar-io/ar-io-sdk (v3.20.0+)
  - Methods: `ANT.init()`, `setUndernameRecord()`, `getRecords()`, `getRecord()`
  - TTL limits: 60-86400 seconds

- **Turbo SDK**: https://github.com/ardriveapp/turbo-sdk (v1.31.1)
  - Methods: `TurboFactory.authenticated()`, `uploadFile()`, `getBalance()`, `getUploadCosts()`
  - Requires credits from ardrive.io/turbo
  - Use `fileStreamFactory` and `fileSizeFactory` for `uploadFile()`

- **Twitter API**: https://github.com/PLhery/node-twitter-api-v2 (v1.16.0)
  - Methods: `v2.userMentionTimeline()`, `v2.reply()`, `v2.retweet()`

## Deployment

The bot is **Railway-ready** with volume mount support:
- Persistent storage path: `RAILWAY_VOLUME_MOUNT_PATH` (fallback: `.`)
- Health check: `GET /` returns "ok"
- Debug endpoint: `GET /debug` shows bot status, config, wallet info

Also compatible with: Heroku, Vercel, DigitalOcean, AWS, GCP, Azure

## Monitoring & Debugging

**Debug endpoints:**
- `http://localhost:3000/` - Health check
- `http://localhost:3000/debug` - Bot status, config, balance

**Logs to watch:**
- `📊 Polling Twitter for mentions...` - Bot is running
- `✅ ArNS record created: {id}` - Successful assignment
- `❌ Infrastructure error detected` - Rate limit/network issue (no user reply)
- `💾 State saved` - Processed mentions persisted

**State files:**
- `processed_mentions.json` - Deduplication and audit trail
- `archive/metadata/archive-index.json` - Master archive index
- `archive/mentions/{id}.json` - Individual mention data
- `users.json` - Quota tracking per user (tier, monthly usage, lifetime stats)

## User Quota System

The bot includes a tiered quota system (`lib/quota.js`):

**Tiers:**
- `free`: 5 assignments/month
- `pro`: 100 assignments/month
- `enterprise`: 500 assignments/month

**Commands:**
- `@NeedsArNS usage` - Users can check their usage stats

**Currently in test mode** - quota is tracked but not enforced (`testMode = true` in `checkQuota`).

## Watch Mode

Watch mode (`npm run watch`) monitors specific Twitter accounts and automatically archives their posts to Arweave.

### How It Works

1. Configure accounts in `watch-config.json`
2. Bot polls each account's timeline every 30 minutes
3. New original posts (not replies/retweets) are archived
4. Each account gets a dedicated ArNS name with landing page
5. Bot replies to posts with archive link (configurable)

### URL Structure

Uses hash-based routing for efficiency:
```
account-said.ar.io          → Landing page (lists all posts)
account-said.ar.io/#/123    → Deep link to specific post
index_account-said.ar.io    → JSON index of all posts
```

### Configuration (`watch-config.json`)

```json
{
  "version": "1.0",
  "pollIntervalMinutes": 30,
  "accounts": [
    {
      "twitterUsername": "elonmusk",
      "twitterUserId": "44196397",
      "arnsName": "elon-musk-said",
      "antProcessId": "YOUR_ANT_PROCESS_ID",
      "enabled": true,
      "replyToPost": true,
      "filtering": {
        "enabled": true,
        "tier": "large-whale",
        "alwaysArchiveMedia": true,
        "archiveSelfReplies": true
      }
    }
  ]
}
```

### Engagement Filtering Tiers

When `filtering.enabled: true`, posts must meet engagement thresholds:
- **ultra-whale**: 500K impressions, 5K likes, 500 replies/retweets
- **large-whale**: 100K impressions, 1K likes, 100 replies/retweets
- **medium**: 10K impressions, 100 likes, 10 replies/retweets
- **small**: 1K impressions, 10 likes, 5 replies/retweets
- **none**: Archive all posts (default)

### Environment Variables (Watch Mode)

**Required:**
- `WATCH_LANDING_TEMPLATE_TXID` - TXID of uploaded `watch-landing-template.html`
- `WATCH_POST_TEMPLATE_TXID` or `TEMPLATE_HTML_TXID` - TXID of post template

**Optional:**
- `WATCH_CONFIG_PATH` - Path to config file (default: `./watch-config.json`)
- `WATCH_PORT` - Health server port (default: 3001)

### Watch Mode Archive Structure

```
watch-archive/
├── {arnsName}/
│   ├── metadata/
│   │   └── index.json        # Landing page index
│   └── posts/
│       └── {postId}.json     # Individual post archives
```

### State Files

- `watch-state.json` - Tracks `lastProcessedTweetId` per account

### Adding a New Watched Account

1. Get Twitter user ID (use Twitter API or lookup tool)
2. Create ArNS name and get ANT process ID
3. Add account to `watch-config.json`
4. Restart watch mode: `npm run watch`

### Debug Endpoint

`GET http://localhost:3001/debug` shows:
- Configured accounts
- Archive statistics
- Template TXIDs
