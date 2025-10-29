# Tweet Replica Archive - Implementation Summary

## ✅ Completed Implementation

All core functionality has been implemented for the tweet replica archive system. The bot now creates complete, self-contained tweet replicas on Arweave with Arweave manifests.

**Note:** `TEMPLATE_HTML_TXID` is now required - the bot will throw an error if not set. Upload `templates/tweet-replica-template.html` to Arweave first and set the transaction ID in your environment.

## 📁 Files Created

### Core Modules
- **`lib/manifest.js`** - Generates Arweave manifests using `arweave/paths` v0.2.0 schema
- **`lib/archive.js`** - Completely rewritten for individual file-based archives
- **`backfill-archive.js`** - Script to backfill existing mentions (no re-uploads or re-assignments)

### Templates
- **`response-templates/success-tweet-replica.json`** - Success message for tweet replicas
- **`response-templates/success-tweet-replica-truncated.json`** - Truncated fallback

### Documentation
- **`archive/README.md`** - Complete documentation of the new archive system

### Directories
- **`archive/mentions/`** - Individual mention metadata files
- **`archive/metadata/`** - Master index location

## 🔧 Files Modified

### `lib/media.js`
- Updated `processMediaFromTweet()` to handle ALL media attachments (not just first)
- Returns array of media with txIds, types, alt_text
- Includes backward compatibility (still returns first txId)

### `index.js`
- Complete rewrite of media upload and ArNS assignment flow
- New flow: upload media → create metadata → generate HTML → create manifest → assign ArNS
- Handles both existing links and media uploads as tweet replicas
- Uses new template system for replies

### Imports
- Added `generateManifest` from `lib/manifest.js`
- Updated archive imports to use new functions

## 🎯 How It Works Now

### For New Mentions:

1. **Upload all media** - Every image/video in the parent tweet is uploaded to Arweave
2. **Create metadata.json** - Complete Twitter context preserved
3. **Use HTML template** - Shared template for consistent tweet replica display
4. **Create Arweave manifest** - Bundles everything together
5. **Assign ArNS** - Points to the manifest (not individual files)
6. **Save individual archive** - Creates `archive/mentions/{mentionId}.json`
7. **Reply with manifest txId** - User gets the manifest transaction ID

### Arweave Manifest Structure:

```json
{
  "manifest": "arweave/paths",
  "version": "0.2.0",
  "index": { "path": "index.html" },
  "paths": {
    "index.html": { "id": "html_txid" },
    "metadata.json": { "id": "metadata_txid" },
    "media/0.jpg": { "id": "media_txid_1" },
    "media/1.jpg": { "id": "media_txid_2" }
  }
}
```

### User Experience:

When someone visits `undername_yourname.ar.io`:
1. Arweave serves the manifest
2. Manifest automatically loads `index.html`
3. User sees complete tweet replica with all media
4. All media loads from Arweave via gateway URLs

## 📊 Metadata Schema

Each mention gets its own JSON file with:

```json
{
  "metadata": {
    "mentionId": "...",
    "undername": "...",
    "processedAt": "...",
    "archiveType": "tweet_replica",
    "success": true,
    "archiveVersion": "2.1"
  },
  "mentionTweet": { "id", "text", "user_name", "created_at" },
  "parentTweet": { "id", "text", "user_name", "created_at", "mediaCount" },
  "archive": {
    "htmlTxId": "...",
    "manifestTxId": "...",
    "arnsRecordId": "...",
    "assignedAt": "...",
    "media": [{ "index", "type", "txId", "alt_text" }]
  }
}
```

## 🔄 Backfill Script Usage

**IMPORTANT: Be mindful of Twitter rate limits (1 request per 15 minutes for free tier)**

```bash
# Backfill 3 mentions (safe for testing)
node backfill-archive.js 3

# Backfill 5 mentions
node backfill-archive.js 5

# Default is 5 if no number provided
node backfill-archive.js
```

The backfill script:
- Reads `processed_mentions.json` for successful mentions
- Fetches tweet data from Twitter API
- Uses existing media txIds (no media re-upload, since already on Arweave)
- Creates metadata.json and uploads to Arweave
- Generates index.html and uploads to Arweave
- Creates Arweave manifest and uploads
- Updates ArNS to point to new manifest
- Creates individual archive files
- Skips mentions that are already backfilled
- Includes 1 second delay between API calls

## 🎨 Features

### Multi-Media Support
- Handles 1-4 images/videos per tweet
- Responsive grid layout (1, 2x1, 2x2 grids)
- Videos with controls, GIFs with autoplay

### Complete Preservation
- Full tweet text with proper formatting
- Original author attribution
- Media with alt text for accessibility
- Timestamps and metadata
- Archive attribution footer

### Self-Contained
- All content on Arweave (permanent)
- No external dependencies
- Works in any browser
- Mobile-responsive design

## 📝 Next Steps

1. **Run backfill script** - Test on 3-5 mentions: `node backfill-archive.js 3`
2. **Test new mention flow** - Have someone mention the bot to test end-to-end
3. **Monitor Turbo credits** - Multiple uploads per mention will use more credits
4. **Update homepage** - Consider updating archive display to use new structure

## 🔍 Backward Compatibility

- `processed_mentions.json` unchanged (bot state management continues as before)
- Old `archive.json` renamed to `OLD-archive.json` for reference
- New mentions will use tweet replica flow
- Existing ArNS assignments remain unchanged

## ⚠️ Important Notes

- **Rate Limits**: Twitter free tier = 1 request per 15 minutes for backfill
- **Turbo Credits**: Each mention now uploads 3+ files (metadata, HTML, manifest, + media)
- **Cost**: More uploads = more Turbo credits used, but creates richer archives
- **Testing**: Run backfill on small batches first to verify everything works

## 🎉 Benefits

1. **Complete Context** - Full tweet preservation, not just media
2. **Better UX** - Users see complete tweet experience, not just raw files
3. **Scalable** - Individual files instead of monolithic archive
4. **Queryable** - Easy to search and filter mentions
5. **Permanent** - Everything on Arweave forever
6. **Standard** - Uses Arweave manifest conventions

