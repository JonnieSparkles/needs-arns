# needs-arns

Twitter bot for ArNS (Arweave Name Service) that automatically assigns subdomains to Arweave transaction IDs.

## How it works

1. User tweets an Arweave transaction ID (gateway-agnostic - works with any Arweave gateway)
2. Someone replies with `@yourbot assign <subdomain>`
3. Bot creates `subdomain.yourname.ar-io.dev` → transaction ID mapping (testnet)
4. Bot replies with confirmation and the new subdomain URL

## Setup

### Environment Variables

```bash
# Twitter API
TWITTER_APP_KEY=your_app_key
TWITTER_APP_SECRET=your_app_secret
TWITTER_ACCESS_TOKEN=your_access_token
TWITTER_ACCESS_SECRET=your_access_secret

# ArNS (configured for testnet)
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
```

### Install & Run

```bash
npm install
npm start
```

## Deployment

Ready for Railway. Set environment variables in Railway dashboard.

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
- ✅ ArNS testnet integration
- ✅ Rate limiting for Twitter free plan (16min intervals)
- ✅ Single API call optimization (no extra calls for parent tweets)

### Debug Endpoints
- `http://localhost:3000/` - Health check
- `http://localhost:3000/debug` - Bot status and configuration

### Bot Behavior
- **Polling**: Checks for mentions every 16 minutes (Twitter free plan limit with buffer)
- **Processing**: Mentions processed sequentially to prevent race conditions
- **Response Time**: 1-minute delay before replying (makes it feel more natural)
- **Error Handling**: Immediate response for errors, delayed response for success
- **Deduplication**: Each mention processed exactly once

## Dependencies

- `@ar.io/sdk` - Arweave/ArNS integration
- `twitter-api-v2` - Twitter API client
- `express` - Health check server
- `dotenv` - Environment variable loading

## Features

### Core Functionality
- ✅ **Gateway-Agnostic** - Works with any Arweave gateway (arweave.net, ar-io.dev, arweave.live, custom domains)
- ✅ **Testnet Ready** - Configured for ArNS testnet (ar-io.dev)
- ✅ **Sandbox Support** - Recognizes sandbox Arweave domains
- ✅ **TTL Compliance** - Respects ArNS TTL limits (60-86400 seconds)

### Performance Optimizations  
- ✅ **Single API Call** - Optimized to 1 Twitter API call per polling cycle using expansions
- ✅ **Rate Limit Handling** - Respects Twitter free plan limits (16min intervals with buffer)
- ✅ **Request Queuing** - Processes mentions sequentially to prevent race conditions
- ✅ **Deduplication** - Prevents processing the same mention multiple times

### User Experience
- ✅ **Natural Response Timing** - 1-minute delay before replying to feel more human
- ✅ **Error Handling** - Graceful error handling with user feedback
- ✅ **Taken Undername Detection** - Handles already-taken undernames gracefully
- ✅ **Multi-line Mention Support** - Handles mentions that span multiple lines
- ✅ **Undername Validation** - Enforces ArNS naming rules (1-51 chars, a-z, 0-9, -, _)

### Development & Monitoring
- ✅ **Enhanced Logging** - Detailed console output for debugging
- ✅ **Health Monitoring** - Built-in health check and debug endpoints
- ✅ **Twitter API v2 Compatibility** - Properly handles twitter-api-v2 response format
- ✅ **Railway Ready** - Configured for easy deployment
