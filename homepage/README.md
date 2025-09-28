# NeedsArNS Bot Homepage

A clean, modern homepage for the NeedsArNS Twitter bot, designed to be hosted on Arweave.

## Features

- **Live Archive Gallery**: Displays all content archived by the bot with image previews
- **Modern Design**: Clean, responsive layout with gradient backgrounds
- **Credit System Integration**: Links to Turbo credit sharing functionality
- **Bot Information**: Commands, features, and technical details
- **Mobile Responsive**: Works on all device sizes
- **Arweave Ready**: Static HTML perfect for permanent hosting

## Files

- `index.html` - Main homepage with live archive gallery
- `deploy.js` - Deployment script for Arweave
- `gallery.html` - Standalone gallery page (legacy)
- `directory.html` - ArNS viewer example (legacy)
- `README.md` - This file

## Deployment

1. **Install dependencies** (if not already installed):
   ```bash
   npm install @ardrive/turbo-sdk dotenv
   ```

2. **Set environment variables** in your `.env` file:
   ```env
   ARWEAVE_WALLET_JSON={"kty":"RSA",...}
   WALLET_ADDRESS=your-bot-wallet-address
   ```

3. **Deploy to Arweave**:
   ```bash
   cd homepage
   node deploy.js
   ```

4. **Configure ArNS domain** (optional):
   - Set up `needsarns.ar.io` to point to the uploaded TXID
   - Update bot replies to include the homepage URL

## Customization

The homepage includes several customizable elements:

- **Bot Handle**: Update `@NeedsArNS` links
- **Bot Address**: Automatically replaced with `WALLET_ADDRESS` from env
- **Status**: Currently shows "Private Beta" - update when going public
- **Features**: Add/remove technical features as needed
- **Colors**: Modify CSS gradient and color scheme

## Archive System

The homepage automatically displays all content archived by the bot:

- **Live Gallery**: Fetches data from `https://archive_needsarns.ar.io`
- **Rich Metadata**: Shows username, media type, timestamps, and ArNS URLs
- **Image Previews**: Displays thumbnails for media content
- **Direct Links**: Click to view content on Arweave or ArNS domains
- **Auto-Updates**: Gallery updates automatically as bot processes new content

## Integration with Bot

The bot's help command now includes:
- Link to homepage: `needsarns.ar.io`
- Link to credit sharing: `turbo.ar.io/share`
- Bot wallet address for credit sharing

## Credit System

Users can:
1. Visit `turbo.ar.io/share`
2. Enter the bot's wallet address
3. Share credits for media uploads
4. Track usage on the homepage

This creates a self-sustaining system where users fund their own uploads!
