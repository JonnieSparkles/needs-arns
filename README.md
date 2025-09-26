# needs-arns

🤖 **Production-ready Twitter bot** for ArNS (Arweave Name Service) that automatically assigns subdomains to Arweave transaction IDs.

Built with enterprise-grade optimization, access control, and monitoring features.

## How it works

1. 📝 **User posts** an Arweave transaction ID (works with any gateway: arweave.net, ar.io, arweave.live, etc.)
2. 💬 **User replies** with `@yourbot assign <subdomain>` (if whitelisted)
3. 🤖 **Bot creates** `subdomain.yourname.ar.io` → transaction ID mapping on ArNS mainnet
4. 🎉 **Bot replies** with celebratory confirmation including both `ar://` and `.ar.io` formats

### Example Flow
```
Original Tweet: "Check out my NFT! https://arweave.net/abc123..."
Reply: "@NeedsArNS assign cool-nft"

Bot Response:
🎉 Undername assigned!
ar://cool-nft_yourname
cool-nft_yourname.ar.io
→ abc123...

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
```

### Install & Run

```bash
npm install
npm start
```

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
- ⏱️ **Natural Timing**: 1-minute delay before success replies
- 🛡️ **Error Handling**: Immediate error responses, graceful rate limit handling
- 🚫 **Deduplication**: Each mention processed exactly once
- 📊 **Monitoring**: Comprehensive logging and debug information

## Technical Stack

- **ArNS Integration**: `@ar.io/sdk` v3.20.0+ for mainnet ArNS operations
- **Twitter API**: `twitter-api-v2` with optimized v2 endpoint usage
- **Server**: `express` for health monitoring and debug endpoints
- **Configuration**: `dotenv` for environment management
- **Platform**: Node.js ES modules with async/await patterns

## Features

### Core Functionality
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
- ✅ **Natural Response Timing** - 1-minute delay before replying to feel more human
- ✅ **Error Handling** - Graceful error handling with user feedback
- ✅ **Taken Undername Detection** - Handles already-taken undernames gracefully
- ✅ **Multi-line Mention Support** - Handles mentions that span multiple lines
- ✅ **Undername Validation** - Enforces ArNS naming rules (1-51 chars, a-z, 0-9, -, _)
- ✅ **Friendly Denial Messages** - Polite responses for unauthorized users

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
- 📊 **Real-time Monitoring**: Debug endpoints for live system status
- 🎯 **Enterprise Ready**: Production-tested with comprehensive error handling

### User Experience
- 🎉 **Celebratory Responses**: Fun, engaging replies with emojis
- 📱 **Mobile Friendly**: Multi-line responses that display well on all devices
- 🔗 **Multiple Formats**: Provides both `ar://` and `.ar.io` URLs for flexibility
- 💬 **Professional Branding**: Consistent @ArNSdomains attribution
