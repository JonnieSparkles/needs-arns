// Refresh a single archived mention: reupload metadata, recreate manifest, update ArNS

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { ANT, ArweaveSigner } from '@ar.io/sdk';
import { requireEnv, getJwkFromEnv } from '../lib/utils.js';
import { uploadToArweave, uploadManifest } from '../lib/arweave.js';
import { updateMentionArchive } from '../lib/archive.js';
import { updateUndernameRecord } from '../lib/arns.js';
import { generateManifest } from '../lib/manifest.js';

async function main() {
  const mentionId = process.argv[2] || process.env.MENTION_ID;
  if (!mentionId) {
    console.error('Usage: node tools/refresh-single-mention.js <mentionId>');
    process.exit(1);
  }

  const ANT_PROCESS_ID = requireEnv('ANT_PROCESS_ID');
  const DEFAULT_TTL_SECONDS = parseInt(process.env.DEFAULT_TTL_SECONDS || '60', 10);
  const TEMPLATE_HTML_TXID = requireEnv('TEMPLATE_HTML_TXID');

  // Load existing archived mention
  const mentionFile = path.join('archive', 'mentions', `${mentionId}.json`);
  if (!fs.existsSync(mentionFile)) {
    console.error(`❌ Mention file not found: ${mentionFile}`);
    process.exit(1);
  }
  const mentionData = JSON.parse(fs.readFileSync(mentionFile, 'utf8'));

  const undername = mentionData?.metadata?.undername;
  if (!undername) {
    console.error('❌ Undername missing in archived mention.');
    process.exit(1);
  }

  // Optional override for parent username (3rd arg)
  const parentUsernameOverride = process.argv[3];

  // Auto-detect and inject missing parent user from mention tweet entities
  const raw = mentionData?.rawApiResponse || {};
  const parent = raw?.parentTweet || null;
  const mention = raw?.mentionTweet || null;
  
  if (parent?.author_id) {
    const includes = raw.includes || {};
    const users = Array.isArray(includes.users) ? includes.users : [];
    const hasParentUser = users.some(u => u?.id === parent.author_id);
    
    if (!hasParentUser) {
      // Try to find parent username from mention tweet entities
      let parentUsername = parentUsernameOverride;
      
      if (!parentUsername && mention?.entities?.mentions) {
        const mentionEntity = mention.entities.mentions.find(m => m.id === parent.author_id);
        if (mentionEntity?.username) {
          parentUsername = mentionEntity.username;
          console.log(`🔍 Auto-detected parent username from mention entities: ${parentUsername}`);
        }
      }
      
      if (parentUsername) {
        users.push({ id: parent.author_id, username: parentUsername });
        mentionData.rawApiResponse = {
          ...raw,
          includes: { ...includes, users }
        };
        console.log(`✅ Injected parent user: ${parentUsername} (${parent.author_id})`);
      } else if (parentUsernameOverride) {
        users.push({ id: parent.author_id, username: parentUsernameOverride });
        mentionData.rawApiResponse = {
          ...raw,
          includes: { ...includes, users }
        };
        console.log(`✅ Injected parent username override: ${parentUsernameOverride}`);
      } else {
        console.warn(`⚠️ Parent user missing and could not be auto-detected. Parent author_id: ${parent.author_id}`);
      }
    } else if (parentUsernameOverride) {
      // Update existing parent user if override provided
      const existing = users.find(u => u?.id === parent.author_id);
      if (existing) {
        existing.username = parentUsernameOverride;
        mentionData.rawApiResponse = {
          ...raw,
          includes: { ...includes, users }
        };
        console.log(`🔧 Updated parent username to: ${parentUsernameOverride}`);
      }
    }
  }

  // Update processedAt to reflect refresh
  mentionData.metadata.processedAt = new Date().toISOString();

  // Prepare Arweave/ANT clients
  const jwk = getJwkFromEnv();
  const ant = ANT.init({ signer: new ArweaveSigner(jwk), processId: ANT_PROCESS_ID });

  // Upload fresh metadata.json (based on current archived data)
  console.log('📄 Uploading refreshed metadata.json...');
  const metadataTxId = await uploadToArweave(
    Buffer.from(JSON.stringify(mentionData, null, 2)),
    'application/json',
    'NeedsArNS-Metadata-Refresh',
    jwk
  );
  console.log(`✅ Metadata uploaded: ${metadataTxId}`);

  // Use shared HTML template
  const htmlTxId = TEMPLATE_HTML_TXID;

  // Extract media array from archived data
  const mediaArray = Array.isArray(mentionData?.archive?.media) ? mentionData.archive.media : [];

  // Create and upload new manifest
  console.log('📦 Creating new manifest...');
  const manifest = generateManifest(metadataTxId, mediaArray, htmlTxId);
  const manifestTxId = await uploadManifest(Buffer.from(JSON.stringify(manifest, null, 2)), jwk);
  console.log(`✅ Manifest uploaded: ${manifestTxId}`);

  // Update ArNS record to point to new manifest
  console.log(`🔗 Updating ArNS: ${undername} → ${manifestTxId}`);
  const updateResult = await updateUndernameRecord(ant, undername, manifestTxId, DEFAULT_TTL_SECONDS);
  if (!updateResult.success) {
    console.error(`❌ Failed to update ArNS: ${updateResult.message || updateResult.error}`);
    process.exit(1);
  }
  const onchainId = updateResult.recordId;

  // Persist new TXIDs back into the mention archive
  mentionData.archive = {
    ...mentionData.archive,
    htmlTxId,
    manifestTxId,
    arnsRecordId: onchainId,
    assignedAt: new Date().toISOString()
  };
  fs.writeFileSync(mentionFile, JSON.stringify(mentionData, null, 2));
  console.log(`✅ Updated ${mentionFile}`);

  // Refresh master index entry
  const ok = await updateMentionArchive(mentionId, {});
  if (!ok) {
    console.error('❌ Failed to refresh archive index');
    process.exit(1);
  }
  console.log('✅ Archive index refreshed');
}

main().catch(err => {
  console.error('❌ Unexpected error:', err);
  process.exit(1);
});


