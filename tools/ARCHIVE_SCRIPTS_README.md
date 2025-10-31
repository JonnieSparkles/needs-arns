# Archive Management Scripts

These scripts allow you to recreate and update post manifests using only your archived data, without re-polling Twitter. This is much more efficient and preserves all your existing data.

## Scripts Overview

### 1. `update-template-from-archive.js`
Updates existing manifests to use a new template version.

**Use case**: When you want to update the HTML template across all existing archives.

**What it does**:
- Uploads new template to Arweave
- Creates new manifests pointing to the new template
- Reuses existing metadata and media files
- Updates ArNS records to point to new manifests

**Usage**:
```bash
# Update 5 mentions with new template
node update-template-from-archive.js 5

# Dry run to see what would happen
node update-template-from-archive.js 5 --dry-run

# Update all mentions
node update-template-from-archive.js 999
```

### 2. `recreate-manifests-from-archive.js`
Recreates manifests from scratch using archived data.

**Use case**: When you want to completely recreate manifests (e.g., after fixing bugs, changing manifest structure, etc.).

**What it does**:
- Uploads fresh metadata.json files using archived data
- Creates new manifests with current template
- Reuses existing media files (no re-upload)
- Updates ArNS records to point to new manifests

**Usage**:
```bash
# Recreate 5 manifests
node recreate-manifests-from-archive.js 5

# Dry run to see what would happen
node recreate-manifests-from-archive.js 5 --dry-run

# Force recreate even if manifest exists
node recreate-manifests-from-archive.js 5 --force

# Recreate all manifests
node recreate-manifests-from-archive.js 999
```

## Key Advantages

### ✅ Efficiency
- **No Twitter API calls** - Uses your existing archive data
- **No rate limits** - No need to worry about API throttling
- **Faster execution** - Only uploads what's necessary

### ✅ Data Preservation
- **Complete Twitter context** - Preserves all original tweet data
- **Media reuse** - No need to re-upload media files
- **Metadata preservation** - Keeps all user information and timestamps

### ✅ Flexibility
- **Template updates** - Easy to update HTML template across all archives
- **Manifest recreation** - Can recreate manifests with new structure
- **Selective processing** - Process only what you need

## How It Works

### Archive Data Structure
Your archive contains everything needed:
```
archive/
├── metadata/
│   └── archive-index.json  # Master index of all mentions
└── mentions/
    ├── {mentionId}.json    # Individual mention data
    └── ...
```

Each mention file contains:
- **Complete Twitter API response** (`rawApiResponse`)
- **Mention tweet data** (`mentionTweet`)
- **Parent tweet data** (`parentTweet`)
- **User information** (`includes.users`)
- **Media information** (`includes.media`)
- **Archive metadata** (`archive`)

### Process Flow

1. **Load archive index** - Get list of all mentions
2. **Load mention data** - Read individual mention files
3. **Extract data** - Get media array, metadata, etc.
4. **Upload new content** - Upload metadata/manifests as needed
5. **Update ArNS** - Point undernames to new manifests
6. **Update archive** - Save new transaction IDs

## Environment Variables Required

Make sure your `.env` file has:
```bash
ANT_PROCESS_ID=your_ant_process_id
ROOT_ARNS_NAME=your_root_arns_name
DEFAULT_TTL_SECONDS=60
TEMPLATE_HTML_TXID=your_template_txid
# ... other Arweave/ArNS credentials
```

## Safety Features

### Dry Run Mode
Both scripts support `--dry-run` to see what would happen without making changes:
```bash
node update-template-from-archive.js 5 --dry-run
```

### Error Handling
- Continues processing even if individual mentions fail
- Provides detailed error reporting
- Updates archive index only after successful processing

### Rate Limiting
- Built-in delays between operations
- Processes mentions in batches
- Respects Arweave network limits

## Use Cases

### Template Updates
When you improve the HTML template:
```bash
# 1. Update your archive-templates/post-archive-template.html
# 2. Run the update script
node update-template-from-archive.js 999
```

### Bug Fixes
When you fix issues in manifest generation:
```bash
# Recreate all manifests with fixed code
node recreate-manifests-from-archive.js 999 --force
```

### Data Migration
When you need to change data structures:
```bash
# Recreate manifests with new metadata format
node recreate-manifests-from-archive.js 999
```

## Monitoring Progress

Both scripts provide detailed output:
- Progress indicators for each mention
- Success/failure counts
- Transaction IDs for verification
- ArNS update confirmations

## Backup Recommendations

Before running these scripts:
1. **Backup your archive** - Copy the `archive/` directory
2. **Test with dry run** - Use `--dry-run` first
3. **Start small** - Test with a few mentions first
4. **Monitor results** - Check a few URLs after processing

## Troubleshooting

### Common Issues

**"Mention file not found"**
- Check that `archive/mentions/{mentionId}.json` exists
- Verify archive index is up to date

**"ArNS update failed"**
- Check ArNS credentials and permissions
- Verify undername exists and is accessible

**"No raw API response found"**
- Some old mentions might not have complete data
- Use `--force` to skip validation

### Recovery

If something goes wrong:
1. **Restore from backup** - Copy back your archive directory
2. **Check ArNS records** - Verify they point to correct manifests
3. **Re-run script** - Use `--force` to overwrite existing manifests

## Performance Notes

- **Processing time**: ~2-3 seconds per mention (including delays)
- **Network usage**: Only uploads new manifests/metadata, reuses media
- **Storage**: Minimal additional storage (just new transaction IDs)
- **Cost**: Only Arweave upload costs for new transactions

These scripts give you complete control over your archive without depending on external APIs or losing any data.
