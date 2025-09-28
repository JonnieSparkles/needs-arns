# needs-arns

🤖 **Production-ready Twitter bot** for ArNS (Arweave Name Service) that automatically assigns subdomains to Arweave content.

Built with enterprise-grade optimization, access control, monitoring, and **Turbo-powered media uploads**.

## How it works

**Two modes of operation:**

### Mode 1: Existing Arweave Links (Priority)
1. 📝 **User posts** an Arweave transaction ID (works with any gateway: arweave.net, ar.io, arweave.live, etc.)
2. 💬 **User replies** with `@yourbot assign <subdomain>` (if whitelisted)
3. 🤖 **Bot creates** `subdomain.yourname.ar.io` → existing transaction ID mapping
4. 🎉 **Bot replies** with `🔗 Link assigned!` confirmation

### Mode 2: Media Upload (Fallback)
1. 📸 **User posts** image or video (no Arweave link)
2. 💬 **User replies** with `@yourbot assign <subdomain>` (if whitelisted)  
3. 🤖 **Bot downloads** media → **uploads to Arweave via Turbo** → **creates mapping**
4. 🎉 **Bot replies** with `📸 Media uploaded & assigned!` confirmation

**Note:** For posts with multiple images/videos, the bot processes only the **first media attachment** to keep the experience simple and predictable.

### Archive System
After each successful assignment, the bot automatically:
1. 📚 **Updates Archive** - Adds the new record to `archive.json`
2. 📤 **Uploads to Arweave** - Uploads the archive via Turbo SDK
3. 🏷️ **Assigns ArNS** - Creates `archive_yourname.ar.io` pointing to the archive
4. 🎨 **Public Gallery** - Homepage displays all archived content with rich metadata

### Example Flows

**Existing Link:**
```
Original Tweet: "Check out my NFT! https://arweave.net/abc123..."
Reply: "@NeedsArNS assign cool-nft"

Bot Response:
🎉 Undername assigned!
🔗 Link assigned!
ar://cool-nft_yourname
cool-nft_yourname.ar.io
→ abc123...

Powered by @ArNSdomains
```

**Media Upload:**
```
Original Tweet: "My latest artwork! [IMAGE ATTACHED]"
Reply: "@NeedsArNS assign my-art"

Bot Response:  
🎉 Undername assigned!
📸 Media uploaded & assigned!
ar://my-art_yourname
my-art_yourname.ar.io
→ xyz789...

Powered by @ArNSdomains
```

## Setup

### Environment Variables

```bash
# Twitter API
TWITTER_APP_KEY=your_app_key
TWITTER_APP_SECRET=your_app_secret
TWITTER_ACCESS_TOKEN=your_access_token
TWITTER_ACCESS_SECRET=your_access_secret

# ArNS (configured for mainnet)
OWNER_ARNS_NAME=your_arns_name
ANT_PROCESS_ID=your_process_id
WALLET_ADDRESS=your_wallet_address  # For reference/transparency

# Arweave Wallet (choose one)
ARWEAVE_JWK_JSON={"kty":"RSA",...}
# OR
ARWEAVE_JWK_B64=base64_encoded_wallet

# Optional
DEFAULT_TTL_SECONDS=60  # ArNS allows 60-86400 seconds (1 min - 24 hours)
POLL_INTERVAL_MS=960000  # 16 minutes for Twitter free plan (1 request/15min with buffer)
PORT=3000

# Access Control (optional - leave empty for open access)
ALLOWED_USERS=username1,username2,username3  # Comma-separated list (without @)

# Time-based filtering (optional)
MENTION_MAX_AGE_HOURS=24  # Only process mentions from last 24 hours
```

### Install & Run

```bash
npm install
npm start
```

### Turbo Credits (for Media Uploads)

The bot uses [Turbo SDK](https://github.com/ardriveapp/turbo-sdk) for fast, reliable media uploads to Arweave.

**Setup:**
1. **Fund your wallet** with Turbo credits at [ardrive.io/turbo](https://ardrive.io/turbo/)
2. **Check balance:** The bot logs your credit balance on startup
3. **Monitor usage:** Each upload shows the cost in winc

**Cost:** Small images are often free, larger files cost minimal credits.

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

### Twitter API Test
```bash
cd hello-bot
npm install
# Set Twitter env vars
node index.js
```

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
- 🛡️ **Error Handling**: Immediate error responses, graceful rate limit handling
- 🚫 **Deduplication**: Each mention processed exactly once across restarts
- 📊 **Detailed Tracking**: Logs username, undername, TXID, and success status for every mention
- 🔍 **Smart Validation**: Only processes mentions starting with @NeedsArNS
- 📈 **Audit Trail**: Complete history of all processed mentions with timestamps

## Technical Stack

- **ArNS Integration**: `@ar.io/sdk` v3.20.0+ for mainnet ArNS operations
- **Arweave Uploads**: `@ardrive/turbo-sdk` for fast, reliable media uploads with credits
- **Twitter API**: `twitter-api-v2` with optimized v2 endpoint usage and media expansion
- **Server**: `express` for health monitoring and debug endpoints
- **Configuration**: `dotenv` for environment management
- **Platform**: Node.js ES modules with async/await patterns

## Features

### Core Functionality
- ✅ **Dual Mode Operation** - Handles both existing Arweave links and media uploads
- ✅ **Media Upload** - Downloads Twitter images/videos and uploads to Arweave via Turbo SDK
- ✅ **Smart Prioritization** - Prefers existing Arweave links over media uploads (faster, cheaper)
- ✅ **Gateway-Agnostic** - Works with any Arweave gateway (arweave.net, ar-io.dev, arweave.live, custom domains)
- ✅ **Mainnet Ready** - Configured for ArNS mainnet (ar.io)
- ✅ **Sandbox Support** - Recognizes sandbox Arweave domains
- ✅ **TTL Compliance** - Respects ArNS TTL limits (60-86400 seconds)

### Performance Optimizations  
- ✅ **Single API Call** - Optimized to 1 Twitter API call per polling cycle using expansions
- ✅ **Rate Limit Handling** - Respects Twitter free plan limits (16min intervals with buffer)
- ✅ **Request Queuing** - Processes mentions sequentially to prevent race conditions
- ✅ **Deduplication** - Prevents processing the same mention multiple times

### User Experience
- ✅ **Access Control** - Optional whitelist system for controlling who can assign names
- ✅ **Time-based Filtering** - Configurable time window for processing mentions (default: 24h)
- ✅ **Persistent Storage** - Remembers processed mentions across restarts via JSON file
- ✅ **Natural Response Timing** - 1-minute delay before replying to feel more human
- ✅ **Error Handling** - Graceful error handling with user feedback
- ✅ **Taken Undername Detection** - Handles already-taken undernames gracefully
- ✅ **Multi-line Mention Support** - Handles mentions that span multiple lines
- ✅ **Undername Validation** - Enforces ArNS naming rules (1-51 chars, a-z, 0-9, -, _)
- ✅ **Friendly Denial Messages** - Polite responses for unauthorized users

### Archive System
- ✅ **Live Archive** - Automatically maintains a public archive of all successfully assigned content
- ✅ **Auto-Upload** - Archive gets uploaded to Arweave and assigned to `archive_yourname.ar.io`
- ✅ **Rich Metadata** - Includes username, timestamp, media type, and ArNS URLs
- ✅ **Public Gallery** - Homepage displays all archived content with image previews
- ✅ **Real-time Updates** - Archive updates automatically with every successful assignment

### Development & Monitoring
- ✅ **Enhanced Logging** - Detailed console output with emojis for easy debugging
- ✅ **Health Monitoring** - Built-in health check and debug endpoints with bot status
- ✅ **Twitter API v2 Compatibility** - Properly handles twitter-api-v2 response format and expansions
- ✅ **Railway Ready** - Optimized for Railway deployment with environment configuration
- ✅ **Error Recovery** - Graceful handling of rate limits, network issues, and API changes
- ✅ **Production Monitoring** - Comprehensive logging for production debugging

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

### Archive File
The bot automatically creates and maintains `archive.json` with public gallery data:

```json
{
  "metadata": {
    "lastUpdated": "2025-09-28T03:51:36.330Z",
    "totalRecords": 8,
    "version": "1.0",
    "description": "NeedsArNS Bot Archive - All successfully archived content"
  },
  "records": [
    {
      "undername": "sparkles",
      "txId": "JT8Am2siXDVuaaAsLiHz8mVraEN7OSHxHkhvf6dJrpc",
      "username": "JonnieSparkles",
      "timestamp": "2025-09-28T03:33:28.649Z",
      "isUploadedMedia": true,
      "arnsUrl": "https://sparkles_needsarns.ar.io"
    }
  ]
}
```

### Archive Benefits
- 🎨 **Public Gallery**: Clean, organized display of all archived content
- 📤 **Auto-Upload**: Automatically uploaded to Arweave and assigned to `archive_yourname.ar.io`
- 🔗 **Rich Links**: Includes both Arweave and ArNS URLs for each record
- 👤 **User Attribution**: Shows which user created each archive entry
- 📸 **Media Type**: Distinguishes between uploaded media and existing links
- ⏰ **Chronological**: Maintains timestamp order for easy browsing
