# needs-arns

🤖 **Production-ready Twitter bot** for ArNS (Arweave Name Service) that automatically assigns subdomains to Arweave content.

Built with enterprise-grade optimization, access control, monitoring, and **Turbo-powered media uploads**.

## How it works

**Three command types:**

### Mode 1: Direct Naming (Original Intent)
**Command:** `@NeedsArNS name this <subdomain>`

1. 📝 **User posts** an Arweave transaction ID (works with any gateway: arweave.net, ar.io, arweave.live, etc.)
2. 💬 **User replies** with `@NeedsArNS name this <subdomain>` (if whitelisted)
3. 🤖 **Bot directly assigns** `undername_rootname.ar.io` → existing transaction ID mapping
4. 🎉 **Bot replies** with confirmation (no archive created)

**Use this when:** You want to give an existing Arweave transaction a name without creating an archive replica.

### Mode 2: Archive & Assign (Archive Platform)
**Command:** `@NeedsArNS assign <subdomain>` or `@NeedsArNS archive <subdomain>`

**For existing Arweave links:**
1. 📝 **User posts** an Arweave transaction ID (works with any gateway: arweave.net, ar.io, arweave.live, etc.)
2. 💬 **User replies** with `@NeedsArNS assign <subdomain>` or `@NeedsArNS archive <subdomain>` (if whitelisted)
3. 🤖 **Bot creates** complete tweet replica archive → assigns `undername_rootname.ar.io` → manifest
4. 🎉 **Bot replies** with archive confirmation

**For media uploads (fallback):**
1. 📸 **User posts** image, video, or animated GIF (no Arweave link)
2. 💬 **User replies** with `@NeedsArNS assign <subdomain>` or `@NeedsArNS archive <subdomain>` (if whitelisted)  
3. 🤖 **Bot downloads** media → **uploads to Arweave via Turbo** → **creates archive** → **assigns name**
4. 🎉 **Bot replies** with archive confirmation

**Use this when:** You want to create a permanent archive replica of the tweet/post with all metadata, media, and context preserved.

**Note:** For posts with multiple images/videos, the bot processes only the **first media attachment** to keep the experience simple and predictable.

### Archive System v2.0

When using `assign` or `archive` commands, the bot automatically creates a complete tweet replica archive on Arweave:

1. 📤 **Upload Media** - Uploads all media files from the parent tweet to Arweave
2. 📄 **Create Metadata** - Generates `metadata.json` with complete Twitter context
3. 🎨 **Generate HTML** - Creates or uses shared HTML template for tweet replica display
4. 📦 **Create Manifest** - Bundles everything with an Arweave manifest
5. 🏷️ **Assign ArNS** - Points `undername_yourname.ar.io` to the manifest
6. 💾 **Save Archive** - Creates individual mention file in `archive/mentions/{mentionId}.json`

When someone visits `undername_yourname.ar.io`, Arweave serves the manifest which automatically loads the tweet replica with all media, text, and metadata preserved.

**Archive Structure:**
```
archive/
├── metadata/
│   └── archive-index.json  # Master index of all mentions
└── mentions/
    ├── {mentionId}.json    # Individual mention metadata files
    └── ...
```

Each mention gets its own JSON file with complete Twitter data, and the master index provides quick lookups across all archived mentions.

**Arweave Manifest:**
Each tweet replica uses an Arweave manifest (arweave/paths v0.2.0) that bundles all content:
- `index.html` - The tweet replica HTML (shared template or individual)
- `metadata.json` - Complete Twitter context and archive metadata
- `media/{index}.{ext}` - All media files from the tweet

**Template System:**
The archive supports a shared HTML template for efficiency:
- **With template** (`TEMPLATE_HTML_TXID`): Uploads only `metadata.json` + `manifest.json` (2 files, ~3KB)
- **Without template**: Uploads `metadata.json` + `index.html` + `manifest.json` (3 files, ~8KB)

The template fetches `metadata.json` and dynamically renders the tweet replica, providing 62% data reduction and easier global styling updates.

**Backfill Existing Mentions:**
```bash
node backfill-archive.js 5
```

The backfill script efficiently processes existing mentions by:
- Using Twitter's batch API to fetch all mentions in one call
- Reusing existing media txIds (no re-upload)
- Creating complete post archive with manifests
- Skipping already-processed mentions

### Example Flows

**Direct Naming (no archive):**
```
Original Tweet: "Check out my NFT! https://arweave.net/abc123..."
Reply: "@NeedsArNS name this cool-nft"

Bot Response:
🎉 cool-nft_yourname.ar.io → abc123...

✨ Powered by @ArNSdomains
```
*Note: Creates direct ArNS mapping only, no archive replica.*

**Archive & Assign (with existing link):**
```
Original Tweet: "Check out my NFT! https://arweave.net/abc123..."
Reply: "@NeedsArNS assign cool-nft" or "@NeedsArNS archive cool-nft"

Bot Response:
🎉 Success! Your tweet is now permanently archived!

📱 Tweet replica created: cool-nft

🌐 https://cool-nft_yourname.ar.io
🔗 ar://cool-nft_yourname
📋 manifest-txid...

✨ Powered by @ArNSdomains
```
*Note: Creates complete tweet replica archive with manifest.*

**Archive & Assign (media upload):**
```
Original Tweet: "My latest artwork! [IMAGE ATTACHED]"
Reply: "@NeedsArNS assign my-art" or "@NeedsArNS archive my-art"

Bot Response:  
🎉 Success! Your tweet is now permanently archived!

📱 Tweet replica created: my-art

🌐 https://my-art_yourname.ar.io
🔗 ar://my-art_yourname
📋 manifest-txid...

✨ Powered by @ArNSdomains
```
*Note: Downloads media, uploads to Arweave, creates archive replica.*

## Setup

### Environment Variables

Copy `env.example` to `.env` and fill in your values. See [`env.example`](env.example) for all available configuration options.

**Required:**
- Twitter API credentials (`TWITTER_APP_KEY`, `TWITTER_APP_SECRET`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_SECRET`)
- ArNS configuration (`ROOT_ARNS_NAME`, `ANT_PROCESS_ID`)
- Arweave wallet (`ARWEAVE_JWK_JSON` or `ARWEAVE_JWK_B64`)
- Template system (`TEMPLATE_HTML_TXID` - upload `archive-templates/post-archive-template.html` first to get the txId)

**Recommended:** `POLL_INTERVAL_MINUTES=16` for Twitter free plan (1 request/15min with buffer)

**Optional:** Access control, time-based filtering, retweet behavior, and other settings.

### Install & Run

```bash
npm install
npm start
```

### Manual Mode

For manual ArNS assignments and Twitter replies (bypasses bot polling):

```bash
npm run manual
```

**Interactive features:**
- 📁 **Local file upload** - Upload files from your computer to create post archives
- 🌐 **URL download** - Download and upload from any URL to create post archive
- 📱 **Tweet extraction** - Extract media from tweet URLs (uses read quota) for post archive
- 👤 **Username detection** - Auto-extract usernames from tweet URLs
- 📝 **Reply preview** - Preview messages before sending
- 🔄 **Full archive mode** - Always creates complete tweet replica archives (requires `TEMPLATE_HTML_TXID`)
- 📊 **Processed mentions** - Updates bot state to prevent reprocessing
- 🔧 **Shared utilities** - Uses same codebase as main bot for consistency

**Note:** Manual mode always creates full tweet replica archives (manifest + metadata + HTML template). The `TEMPLATE_HTML_TXID` environment variable is required.

### Turbo Credits (for Media Uploads)

The bot uses [Turbo SDK](https://github.com/ardriveapp/turbo-sdk) for fast, reliable media uploads to Arweave.

**Setup:**
1. **Fund your wallet** with Turbo credits at [ardrive.io/turbo](https://ardrive.io/turbo/)
2. **Check balance:** The bot logs your credit balance on startup
3. **Monitor usage:** Each upload shows the cost in winc

**Cost:** Small images are often free, larger files cost minimal credits.

## Template System

The bot uses a centralized template system for all responses:

### Template Files
Located in `response-templates/` directory:
- `success-post-archive.json` - Full success message for post archives (used for all assignments)
- `success-post-archive-truncated.json` - Shorter version if message exceeds 280 characters
- `success-minimal.json` - Minimal fallback message
- `error-*.json` - Various error messages
- `help.json` - Help command response
- `loader.js` - Template loading and rendering system

### Features
- ✅ **Automatic Truncation** - Falls back to shorter versions when messages exceed 280 characters
- ✅ **Variable Substitution** - Dynamic content with `{variable}` placeholders
- ✅ **Fallback Chain** - Multiple fallback levels for character limits
- ✅ **Consistent Branding** - Centralized @ArNSdomains attribution
- ✅ **Easy Maintenance** - Update messages in one place for both bot and manual modes

## Infrastructure Error Handling

The bot intelligently categorizes errors and only replies to users for actionable issues:

### Infrastructure Errors (No Reply to User)
- 🚫 **Rate Limiting** - 429 errors from Twitter API
- 🌐 **Network Issues** - Timeouts, connection failures, DNS issues
- 🔧 **API Outages** - 5xx server errors, service unavailable
- ⚡ **Arweave Issues** - Turbo service unavailable, Arweave network problems
- 💾 **File System** - Permission issues, disk space, file access problems
- 🧠 **Resource Issues** - Memory limits, file size limits

### User Errors (Reply to User)
- ❌ **Invalid Undername** - Format violations, length issues
- 📝 **No Content** - Missing Arweave links or media
- 🔒 **Access Denied** - User not in whitelist
- 📋 **Name Taken** - Undername already assigned
- ✅ **Other User-Actionable** - Errors users can fix or need to know about

## Deployment

### Railway (Recommended)
Ready for one-click deployment to Railway:

1. **Connect Repository**: Link your GitHub repo to Railway
2. **Set Environment Variables**: Configure all required variables in Railway dashboard
3. **Deploy**: Railway automatically builds and deploys
4. **Monitor**: Use Railway logs + built-in debug endpoints for monitoring

### Other Platforms
Also compatible with: Heroku, Vercel, DigitalOcean App Platform, AWS, GCP, Azure

## Testing

### ArNS Functionality Test
The bot has been tested and confirmed working with:
- ✅ Real Arweave transaction IDs
- ✅ Gateway-agnostic URL support (arweave.net, ar-io.dev, arweave.live, custom gateways)
- ✅ Sandbox domain support
- ✅ ArNS mainnet integration
- ✅ Rate limiting for Twitter free plan (16min intervals)
- ✅ Single API call optimization (no extra calls for parent tweets)

### Debug Endpoints
- `http://localhost:3000/` - Health check (returns "ok")
- `http://localhost:3000/debug` - Bot status, configuration, and wallet info

### Bot Behavior
- 🕐 **Polling**: Every 16 minutes (Twitter free plan optimized)
- ⚡ **API Efficiency**: Single optimized call per cycle using expansions
- 🔒 **Access Control**: Optional whitelist system for authorized users
- ⏰ **Time Filtering**: Configurable time window for processing mentions (default: 24h)
- 💾 **Persistent Storage**: Auto-saves processed mentions to `processed_mentions.json`
- ⏱️ **Natural Timing**: 1-minute delay before success replies
- 🛡️ **Smart Error Handling**: Only replies to user-actionable errors, skips infrastructure issues
- 🚫 **Deduplication**: Each mention processed exactly once across restarts
- 📊 **Detailed Tracking**: Logs username, undername, TXID, and success status for every mention
- 🔍 **Smart Validation**: Only processes mentions starting with @NeedsArNS
- 📈 **Audit Trail**: Complete history of all processed mentions with timestamps
- 🔧 **Infrastructure Error Detection**: Automatically categorizes and handles rate limits, network issues, API outages

## Technical Stack & SDK References

### Primary SDKs (AI Reference)
- **ArNS SDK**: [`@ar.io/sdk`](https://github.com/ar-io/ar-io-sdk) v3.20.0+
  - **Purpose**: ArNS subdomain management and record operations
  - **Key Methods**: `ANT.init()`, `setUndernameRecord()`, `getRecords()`, `getRecord()`
  - **Critical Notes**: Always include `owner` field when updating records, TTL limits 60-86400 seconds
  - **Documentation**: https://github.com/ar-io/ar-io-sdk

- **Turbo SDK**: [`@ardrive/turbo-sdk`](https://github.com/ardriveapp/turbo-sdk) v1.31.1
  - **Purpose**: Fast Arweave media uploads with credit system
  - **Key Methods**: `TurboFactory.authenticated()`, `uploadFile()`, `getBalance()`
  - **Critical Notes**: Requires Turbo credits from ardrive.io/turbo, use `fileStreamFactory` and `fileSizeFactory`
  - **Documentation**: https://github.com/ardriveapp/turbo-sdk

### Supporting Libraries
- **Twitter API**: [`twitter-api-v2`](https://github.com/PLhery/node-twitter-api-v2) v1.16.0
- **Server**: [`express`](https://expressjs.com/) v4.19.2
- **Configuration**: [`dotenv`](https://github.com/motdotla/dotenv) v17.2.2
- **Platform**: Node.js ES modules with async/await patterns

## Modular Architecture

The codebase uses a clean, modular architecture with shared utilities:

### Core Modules (`lib/`)
- **`utils.js`** - Common utilities (validation, parsing, error handling, regex patterns)
- **`arweave.js`** - Arweave/Turbo upload functions with client factory
- **`archive.js`** - Archive management with ArNS integration
- **`twitter.js`** - Twitter API functions with client factory and rate limiting
- **`arns.js`** - ArNS-specific functions (availability checking, record creation)
- **`media.js`** - Media processing and extraction from tweets
- **`mentions.js`** - Twitter mention processing and response handlers
- **`state.js`** - State management and persistence functions

### Benefits
- ✅ **Zero Code Duplication** - ~400+ lines of duplicate code eliminated
- ✅ **Single Source of Truth** - All shared functionality centralized
- ✅ **Easy Testing** - Individual modules can be tested independently
- ✅ **Future-Proof** - New scripts can instantly use shared utilities
- ✅ **Consistent Behavior** - Both bot and manual modes use identical logic
- ✅ **Maintainable** - Bug fixes and features added in one place

## Features

### Core Functionality
- ✅ **Dual Mode Operation** - Handles both existing Arweave links and media uploads
- ✅ **Media Upload** - Downloads Twitter images/videos and uploads to Arweave via Turbo SDK
- ✅ **Smart Prioritization** - Prefers existing Arweave links over media uploads (faster, cheaper)
- ✅ **Gateway-Agnostic** - Works with any Arweave gateway (arweave.net, ar-io.dev, arweave.live, custom domains)
- ✅ **Mainnet Ready** - Configured for ArNS mainnet (ar.io)
- ✅ **Sandbox Support** - Recognizes sandbox Arweave domains
- ✅ **TTL Compliance** - Respects ArNS TTL limits (60-86400 seconds)
- ✅ **Manual Mode** - Interactive script for manual ArNS assignments and Twitter replies
- ✅ **Template System** - Centralized response templates with automatic truncation and fallbacks

### Performance Optimizations  
- ✅ **Single API Call** - Optimized to 1 Twitter API call per polling cycle using expansions
- ✅ **Rate Limit Handling** - Respects Twitter free plan limits (configurable intervals)
- ✅ **Automatic Backoff** - Handles rate limit errors (429) with appropriate delays
- ✅ **Request Queuing** - Processes mentions sequentially to prevent race conditions
- ✅ **Deduplication** - Prevents processing the same mention multiple times
- ✅ **Infrastructure Error Handling** - Skips replying to users for infrastructure issues

### User Experience
- ✅ **Access Control** - Optional whitelist system for controlling who can assign names
- ✅ **Time-based Filtering** - Configurable time window for processing mentions (default: 24h)
- ✅ **Persistent Storage** - Remembers processed mentions across restarts via JSON file
- ✅ **Natural Response Timing** - 1-minute delay before replying to feel more human
- ✅ **Content Promotion** - Automatically retweets success messages to promote archived content (configurable via ENABLE_RETWEETS)
- ✅ **Error Handling** - Graceful error handling with user feedback
- ✅ **Taken Undername Detection** - Handles already-taken undernames gracefully
- ✅ **Multi-line Mention Support** - Handles mentions that span multiple lines
- ✅ **Undername Validation** - Enforces ArNS naming rules (1-51 chars, a-z, 0-9, -, _)
- ✅ **Friendly Denial Messages** - Polite responses for unauthorized users

### Archive System v2.0
- ✅ **post archive** - Creates complete, self-contained post archive on Arweave with all media
- ✅ **Individual Files** - Each mention gets its own JSON file in `archive/mentions/` for scalability
- ✅ **Master Index** - Centralized index in `archive/metadata/archive-index.json` for quick lookups
- ✅ **Arweave Manifests** - Uses arweave/paths v0.2.0 manifest format for proper bundling
- ✅ **Template System** - Shared HTML template reduces data by 62% when configured
- ✅ **Complete Preservation** - Full tweet text, media with alt text, timestamps, and metadata
- ✅ **Multi-Media Support** - Handles 1-4 images/videos per tweet with responsive grid layouts
- ✅ **Backfill Support** - Script to migrate existing mentions to new archive structure

### Development & Monitoring
- ✅ **Enhanced Logging** - Detailed console output with emojis for easy debugging
- ✅ **Health Monitoring** - Built-in health check and debug endpoints with bot status
- ✅ **Twitter API v2 Compatibility** - Properly handles twitter-api-v2 response format and expansions
- ✅ **Railway Ready** - Optimized for Railway deployment with environment configuration
- ✅ **Error Recovery** - Graceful handling of rate limits, network issues, and API changes
- ✅ **Production Monitoring** - Comprehensive logging for production debugging
- ✅ **Manual Operations** - Interactive script for bypassing bot limitations and manual assignments
- ✅ **Template Management** - Centralized response system with automatic character limit handling
- ✅ **Modular Architecture** - Clean separation of concerns with shared utility modules
- ✅ **Zero Duplication** - Single source of truth for all shared functionality

## Production Features

### Security & Access Control
- 🔐 **Whitelist System**: Control who can assign names via `ALLOWED_USERS`
- 🛡️ **Input Validation**: Comprehensive validation of undernames and transaction IDs
- 🚫 **Spam Protection**: Rate limiting and deduplication prevent abuse
- 👥 **User Authentication**: Twitter username verification with friendly denial messages

### Reliability & Performance
- ⚡ **Optimized API Usage**: Single call per cycle with Twitter API expansions
- 🔄 **Automatic Recovery**: Handles rate limits and network issues gracefully
- 💾 **Persistent State**: Survives restarts, crashes, and deployments without reprocessing
- ⏰ **Time-based Safety**: Configurable time window prevents processing very old mentions
- 📊 **Real-time Monitoring**: Debug endpoints for live system status
- 🎯 **Enterprise Ready**: Production-tested with comprehensive error handling
- 📈 **Complete Audit Trail**: JSON file tracks every mention with full details
- 🔧 **Infrastructure Error Handling**: Automatically detects and handles infrastructure issues without bothering users

### User Experience
- 🎉 **Celebratory Responses**: Fun, engaging replies with emojis
- 📱 **Mobile Friendly**: Multi-line responses that display well on all devices
- 🔗 **Multiple Formats**: Provides both `ar://` and `.ar.io` URLs for flexibility
- 💬 **Professional Branding**: Consistent @ArNSdomains attribution

## Enhanced Tracking & Persistence

### Processed Mentions File
The bot automatically creates and maintains `processed_mentions.json` with detailed tracking:

```json
{
  "processedMentions": ["1971422102348759442"],
  "processedDetails": {
    "1971422102348759442": {
      "username": "jonniesparkles",
      "undername": "cool-nft", 
      "txId": "4136-HHYif93aC7tlpMRmEpWEAKPcbUZ_O-UbmSKMqw",
      "onchainId": "992D5VGmbBTKddwtC6yOtLJSdKnF52B3gPmf2B6rGC4",
      "success": true,
      "timestamp": "2025-09-26T04:15:30.123Z"
    }
  },
  "lastSinceId": "1971422102348759442",
  "lastUpdated": "2025-09-26T04:15:30.123Z",
  "version": "1.1"
}
```

### Benefits
- 📊 **Complete Audit Trail**: Every mention tracked with full context
- 🔄 **Restart Safe**: No reprocessing after bot restarts or deployments  
- 🎯 **Easy Debugging**: Track down issues by mention ID or username
- 📈 **Usage Analytics**: See who's using the bot and what names they're claiming
- 🛡️ **Security Monitoring**: Track access denial attempts and errors
- ⏰ **Time Filtering**: Automatically ignores mentions older than configured threshold

### Archive Index
The bot automatically creates and maintains `archive/metadata/archive-index.json` with a master index of all archived mentions. See the archive structure section above for details.