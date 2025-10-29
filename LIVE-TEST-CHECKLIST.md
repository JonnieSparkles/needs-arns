# Live Test Pre-Flight Checklist

## ✅ Code Status

### Recent Fixes Verified:
- ✅ Batch Twitter API calls (single request for multiple tweets)
- ✅ Twitter media links filtered from text display
- ✅ Video content handling improved
- ✅ Entity data cleaned up (only URLs stored)
- ✅ Test script working correctly

## 🔍 Pre-Flight Checks

### 1. Environment Variables
Verify all required variables are set:
```bash
# Required for Twitter
TWITTER_APP_KEY=
TWITTER_APP_SECRET=
TWITTER_ACCESS_TOKEN=
TWITTER_ACCESS_SECRET=

# Required for ArNS
ANT_PROCESS_ID=
OWNER_ARNS_NAME=
DEFAULT_TTL_SECONDS=60

# Required for Arweave
ARWEAVE_JWK_JSON=  # OR ARWEAVE_JWK_B64

# Optional
TEMPLATE_HTML_TXID=  # If using shared template
ALLOWED_USERS=  # Whitelist (comma-separated)
ENABLE_RETWEETS=false
MENTION_MAX_AGE_HOURS=24
```

### 2. ArNS Assignment Verification
**CRITICAL:** Ensure ArNS assignment is ENABLED in `index.js`:
- ✅ Line ~262: `createUndernameRecord` should NOT be commented out
- ✅ Verify error handling for "name taken" scenarios
- ✅ Verify timeout handling (120s timeout exists)

### 3. Archive System
- ✅ `archive/mentions/` directory exists
- ✅ `archive/metadata/` directory exists  
- ✅ Template uses latest version (video fixes, link filtering)

### 4. Error Handling
- ✅ Infrastructure errors (429, network) won't reply to users
- ✅ User errors (name taken, no content) will reply appropriately
- ✅ Rate limiting handled gracefully

### 5. Media Processing
- ✅ Photos handled
- ✅ Videos handled
- ✅ Animated GIFs handled
- ✅ Multiple media items supported
- ✅ Existing Arweave links (txIds) supported

### 6. Twitter API Limits
- ✅ Polling interval set appropriately (16+ min for free tier)
- ✅ Single batch API call per cycle
- ✅ Monthly cap detection enabled

## 🧪 Pre-Flight Testing

### Step 1: Test with Test Script
```bash
# Test with 2-3 different content types
node test-archive-flow.js \
  "https://x.com/user/status/POST_WITH_IMAGE" \
  "https://x.com/user/status/POST_WITH_VIDEO" \
  "https://x.com/user/status/POST_WITH_LINK"
```

**Verify:**
- ✅ All tweets fetched in single API call
- ✅ Media uploads working
- ✅ Archives created correctly
- ✅ Manifest structure correct
- ✅ No t.co media links in text

### Step 2: Check Archive Files
```bash
# Verify archives created
ls archive/mentions/

# Check one archive file
cat archive/mentions/{latest}.json
```

**Verify:**
- ✅ Metadata complete
- ✅ Media types correct
- ✅ Entities cleaned (only URLs)
- ✅ File structure matches schema

### Step 3: Verify Template
- ✅ Load a test archive URL on Arweave
- ✅ Verify media displays correctly
- ✅ Verify no t.co links in text
- ✅ Verify date/time formatting
- ✅ Verify video playback (if applicable)

## 🚀 Live Test Preparation

### Before First Live Run:

1. **Backup Current State**
   ```bash
   # Backup processed_mentions.json
   cp processed_mentions.json processed_mentions.backup.json
   ```

2. **Check Current Last Since ID**
   - Review `processed_mentions.json` → `lastSinceId`
   - Bot will start from this point (or recent mentions)

3. **Verify Access Control** (if using whitelist)
   - Ensure test users are in `ALLOWED_USERS`
   - Or temporarily disable whitelist for testing

4. **Monitor First Mentions**
   - Watch logs carefully
   - Check for any unexpected errors
   - Verify ArNS assignments succeed

5. **Test Scenarios to Try:**
   - ✅ Post with single image
   - ✅ Post with multiple images
   - ✅ Post with video
   - ✅ Post with existing Arweave link
   - ✅ Reply with assign command
   - ✅ Test with taken undername (should fail gracefully)

## ⚠️ Known Issues to Watch For

1. **Twitter Rate Limits (429)**
   - Expected: Bot should handle gracefully
   - Should NOT reply to user
   - Should log and continue

2. **ArNS Assignment Timeouts**
   - 120s timeout exists
   - Will verify if assignment succeeded despite timeout
   - May need to retry manually if fails

3. **Media Upload Failures**
   - Should reply to user with error
   - Should not create ArNS record if upload fails

4. **Large Media Files**
   - Turbo credits need to be sufficient
   - Check balance before testing

## 🔧 Quick Fixes if Needed

### Disable ArNS Assignment (Emergency)
In `index.js` line ~262:
```javascript
// TEMPORARY: Comment out for testing
// const recordResult = await createUndernameRecord(...)
```

### Increase Timeout (if needed)
In `lib/arns.js` line ~30:
```javascript
setTimeout(() => reject(...), 180000)  // Increase to 180s
```

### Disable Whitelist (temporarily)
In `.env`:
```bash
ALLOWED_USERS=  # Leave empty
```

## 📊 Monitoring During Live Test

### What to Watch:
1. **Logs** - Check for errors or warnings
2. **Twitter Replies** - Verify correct responses sent
3. **ArNS Records** - Verify assignments succeed
4. **Archive Files** - Verify archives created
5. **User Feedback** - Watch Twitter for user issues

### Success Indicators:
- ✅ Mentions processed successfully
- ✅ ArNS records created
- ✅ Twitter replies sent
- ✅ Archives saved
- ✅ No infrastructure errors bubbling to users

## 🎯 Ready for Live Test When:

- [ ] All environment variables set
- [ ] Test script passes (2-3 different content types)
- [ ] Archive files verified
- [ ] Template tested and working
- [ ] ArNS assignment code active (not commented)
- [ ] Error handling verified
- [ ] Backup of current state created
- [ ] Monitoring plan in place

## 🚦 Go/No-Go Decision

**GO if:**
- ✅ All checks above pass
- ✅ Test script works correctly
- ✅ Comfortable with error handling
- ✅ Backup created

**NO-GO if:**
- ❌ Test script fails
- ❌ Environment variables missing
- ❌ ArNS assignment commented out
- ❌ Any critical issues found

---

**Last Updated:** Based on current codebase state
**Recommendation:** Run test script first, verify archives, then go live with monitoring

