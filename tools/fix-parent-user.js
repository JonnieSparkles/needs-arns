// One-off fixer: ensures parent user exists in archived mention and refreshes index

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { getTwitterClient } from '../lib/twitter.js';
import { updateMentionArchive } from '../lib/archive.js';

dotenv.config();

async function main() {
  const mentionId = process.argv[2] || process.env.MENTION_ID;
  if (!mentionId) {
    console.error('Usage: node tools/fix-parent-user.js <mentionId>');
    process.exit(1);
  }

  const mentionFile = path.join('archive', 'mentions', `${mentionId}.json`);
  if (!fs.existsSync(mentionFile)) {
    console.error(`❌ Mention file not found: ${mentionFile}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(mentionFile, 'utf8'));
  const raw = data?.rawApiResponse || {};
  const parent = raw.parentTweet;
  const includes = raw.includes || {};

  if (!parent?.author_id) {
    console.log('ℹ️ No parent tweet author_id found; refreshing index only.');
    await updateMentionArchive(mentionId, {});
    return;
  }

  const users = Array.isArray(includes.users) ? includes.users : [];
  const hasParentUser = users.some(u => u?.id === parent.author_id);

  if (!hasParentUser) {
    // Build Twitter client
    const twitterClient = getTwitterClient({
      appKey: process.env.TWITTER_APP_KEY,
      appSecret: process.env.TWITTER_APP_SECRET,
      accessToken: process.env.TWITTER_ACCESS_TOKEN,
      accessSecret: process.env.TWITTER_ACCESS_SECRET
    });

    console.log(`🔎 Fetching parent user ${parent.author_id} from Twitter...`);
    try {
      const resp = await twitterClient.v2.user(parent.author_id, {
        'user.fields': ['username', 'name', 'created_at', 'description', 'public_metrics', 'verified']
      });
      const parentUser = resp?.data;
      if (!parentUser) {
        console.warn('⚠️ Could not fetch parent user; refreshing index without change.');
      } else {
        includes.users = users.concat(parentUser);
        data.rawApiResponse.includes = includes;
        fs.writeFileSync(mentionFile, JSON.stringify(data, null, 2));
        console.log(`✅ Added parent user ${parentUser.username} to ${mentionFile}`);
      }
    } catch (e) {
      console.warn(`⚠️ Twitter API error: ${e?.message || e}. Proceeding to refresh index.`);
    }
  } else {
    console.log('ℹ️ Parent user already present in archive; no file changes needed.');
  }

  // Refresh the master index entry to compute parentUsername properly
  const ok = await updateMentionArchive(mentionId, {});
  if (ok) {
    console.log('✅ Master index updated.');
  } else {
    console.error('❌ Failed to update master index.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('❌ Unexpected error:', err);
  process.exit(1);
});


