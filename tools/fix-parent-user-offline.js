// Offline one-off fixer: injects parent username into archived mention and refreshes index

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { updateMentionArchive } from '../lib/archive.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const mentionId = process.argv[2];
  const parentUsername = process.argv[3];

  if (!mentionId || !parentUsername) {
    console.error('Usage: node tools/fix-parent-user-offline.js <mentionId> <parentUsername>');
    process.exit(1);
  }

  const mentionFile = path.join(__dirname, '..', 'archive', 'mentions', `${mentionId}.json`);
  if (!fs.existsSync(mentionFile)) {
    console.error(`❌ Mention file not found: ${mentionFile}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(mentionFile, 'utf8'));
  const raw = data?.rawApiResponse || {};
  const parent = raw?.parentTweet || null;
  const includes = raw?.includes || {};

  if (!parent?.author_id) {
    console.error('❌ No parentTweet.author_id present in archive; cannot link username.');
    process.exit(1);
  }

  const users = Array.isArray(includes.users) ? includes.users : [];
  const existing = users.find(u => u?.id === parent.author_id);

  if (existing) {
    existing.username = parentUsername;
  } else {
    users.push({ id: parent.author_id, username: parentUsername });
  }

  data.rawApiResponse = {
    ...raw,
    includes: {
      ...includes,
      users
    }
  };

  fs.writeFileSync(mentionFile, JSON.stringify(data, null, 2));
  console.log(`✅ Updated ${mentionFile} with parent username: ${parentUsername}`);

  // Refresh the master index to compute parentUsername from archive (no network needed)
  const ok = await updateMentionArchive(mentionId, {});
  if (!ok) {
    console.error('❌ Failed to update master index');
    process.exit(1);
  }
  console.log('✅ Master index refreshed.');
}

main().catch(err => {
  console.error('❌ Unexpected error:', err);
  process.exit(1);
});


