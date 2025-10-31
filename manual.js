import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { TwitterApi } from 'twitter-api-v2';
import { ANT, ArweaveSigner } from '@ar.io/sdk';
import { requireEnv, getJwkFromEnv, isValidUndername, isInfrastructureErrorType, verifyTxIdExists, guessContentType, parseTweetId, extractUsernameFromUrl, ARWEAVE_TXID_RE } from './lib/utils.js';
import { uploadToArweave, uploadManifest, downloadBuffer, getTurboClient } from './lib/arweave.js';
import { createMentionArchive, buildMetadataObject, uploadAndAssignArchiveIndex } from './lib/archive.js';
import { reply, retweet, getTwitterClient } from './lib/twitter.js';
import { generateManifest } from './lib/manifest.js';
import { checkUndernameAvailability, createUndernameRecord } from './lib/arns.js';
import { updateProcessedMentions } from './lib/state.js';
import { renderTemplate } from './response-templates/loader.js';

// ---------- config & env ----------

const {
  TWITTER_APP_KEY,
  TWITTER_APP_SECRET,
  TWITTER_ACCESS_TOKEN,
  TWITTER_ACCESS_SECRET,
  ROOT_ARNS_NAME,
  ANT_PROCESS_ID
} = {
  TWITTER_APP_KEY: requireEnv('TWITTER_APP_KEY'),
  TWITTER_APP_SECRET: requireEnv('TWITTER_APP_SECRET'),
  TWITTER_ACCESS_TOKEN: requireEnv('TWITTER_ACCESS_TOKEN'),
  TWITTER_ACCESS_SECRET: requireEnv('TWITTER_ACCESS_SECRET'),
  ROOT_ARNS_NAME: requireEnv('ROOT_ARNS_NAME'),
  ANT_PROCESS_ID: requireEnv('ANT_PROCESS_ID')
};

const DEFAULT_TTL_SECONDS = parseInt(process.env.DEFAULT_TTL_SECONDS || '60', 10);
const MANUAL_RETWEET = String(process.env.MANUAL_RETWEET || 'true').toLowerCase() !== 'false';
const BOT_USER_ID = process.env.BOT_USER_ID || null; // optional; if missing, we'll call /me once
const TEMPLATE_HTML_TXID = requireEnv('TEMPLATE_HTML_TXID'); // Required for tweet replica mode

// ---------- wallet ----------

// ---------- clients ----------
const twitter = getTwitterClient({
  appKey: TWITTER_APP_KEY,
  appSecret: TWITTER_APP_SECRET,
  accessToken: TWITTER_ACCESS_TOKEN,
  accessSecret: TWITTER_ACCESS_SECRET,
});
const jwk = getJwkFromEnv();
const ant = ANT.init({
  signer: new ArweaveSigner(jwk),
  processId: ANT_PROCESS_ID
});
const turbo = getTurboClient(jwk);

// ---------- utils ----------

// ---------- interactive prompts ----------
function createPrompt() {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
}

function askQuestion(rl, question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

function askYesNo(rl, question) {
  return new Promise((resolve) => {
    rl.question(`${question} (y/n): `, (answer) => {
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });
}

function askChoice(rl, question, choices) {
  return new Promise((resolve) => {
    console.log(`\n${question}`);
    choices.forEach((choice, i) => {
      console.log(`  ${i + 1}. ${choice}`);
    });
    rl.question('Enter choice (number): ', (answer) => {
      const num = parseInt(answer) - 1;
      if (num >= 0 && num < choices.length) {
        resolve(choices[num]);
      } else {
        console.log('Invalid choice, please try again.');
        askChoice(rl, question, choices).then(resolve);
      }
    });
  });
}


let cachedUserId = null;
async function getBotUserId() {
  if (BOT_USER_ID) return BOT_USER_ID;
  if (cachedUserId) return cachedUserId;
  try {
    const me = await twitter.v2.me();
    cachedUserId = me?.data?.id || null;
    return cachedUserId;
  } catch {
    return null;
  }
}




// ---------- main ----------
async function main() {
  const rl = createPrompt();
  
  try {
    console.log('🤖 NeedsArNS Manual Bot - Interactive Mode');
    console.log('==========================================\n');

    // Step 1: Get undername
    let undername = '';
    while (!undername || !isValidUndername(undername.toLowerCase())) {
      undername = await askQuestion(rl, 'Enter the ArNS undername (a-z, 0-9, -, _): ');
      if (!isValidUndername(undername.toLowerCase())) {
        console.log('❌ Invalid undername. Must be 1-51 chars, a-z, 0-9, -, _ (no leading/trailing dashes/underscores)');
      }
    }
    undername = undername.toLowerCase();

    // Step 2: Check undername availability
    console.log(`\n🔍 Checking if '${undername}' is available...`);
    let force = false;
    const availability = await checkUndernameAvailability(ant, undername);
    if (!availability.available) {
      console.log(`⚠️  Undername '${undername}' is already taken.`);
      force = await askYesNo(rl, 'Do you want to update/overwrite it?');
      if (!force) {
        console.log('❌ Operation cancelled.');
        rl.close();
        return;
      }
    } else {
      console.log(`✅ Undername '${undername}' is available!`);
    }

    // Step 3: Choose content source (all sources go into tweet replica archive)
    const sourceChoice = await askChoice(rl, 'How do you want to provide the content for the tweet replica?', [
      'Local file on my computer',
      'URL (direct link to file)',
      'Extract from a tweet (requires read quota)'
    ]);

    let txId = null;
    let uploaded = false;

    if (sourceChoice.includes('Local file')) {
      // Local file
      let filePath = '';
      while (!filePath) {
        filePath = await askQuestion(rl, 'Enter the full path to your file: ');
        if (!fs.existsSync(filePath)) {
          console.log('❌ File not found. Please check the path.');
          filePath = '';
        }
      }
      
      const abs = path.resolve(filePath);
      const data = fs.readFileSync(abs);
      const buffer = Buffer.from(data);
      const contentType = guessContentType(abs);
      console.log(`📁 Read local file: ${abs} (${(buffer.length/1024).toFixed(1)}KB) CT=${contentType}`);
      
      txId = await uploadToArweave(buffer, contentType, 'NeedsArNS-Manual', jwk);
      uploaded = true;
      console.log(`☁️  Uploaded to Arweave: ${txId}`);

    } else if (sourceChoice.includes('URL')) {
      // URL
      let url = '';
      while (!url) {
        url = await askQuestion(rl, 'Enter the URL to download: ');
        if (!url.startsWith('http')) {
          console.log('❌ Please enter a valid URL starting with http:// or https://');
          url = '';
        }
      }

      // Check if it's an Arweave URL
      const m = url.match(ARWEAVE_TXID_RE);
      if (m) {
        txId = m[1] || m[2];
        console.log(`🔗 Using existing Arweave TXID from URL: ${txId}`);
      } else {
        const dl = await downloadBuffer(url);
        const buffer = dl.buffer;
        const contentType = dl.contentType || 'application/octet-stream';
        console.log(`📥 Downloaded URL: ${url} (${(buffer.length/1024).toFixed(1)}KB) CT=${contentType}`);
        
        txId = await uploadToArweave(buffer, contentType, 'NeedsArNS-Manual', jwk);
        uploaded = true;
        console.log(`☁️  Uploaded to Arweave: ${txId}`);
      }

    } else if (sourceChoice.includes('Extract from tweet')) {
      // Tweet extraction
      let tweetUrl = '';
      while (!tweetUrl) {
        tweetUrl = await askQuestion(rl, 'Enter the tweet URL: ');
        const tweetId = parseTweetId(tweetUrl);
        if (!tweetId) {
          console.log('❌ Invalid tweet URL. Please enter a valid X/Twitter status URL.');
          tweetUrl = '';
        }
      }

      console.log('📱 Fetching tweet media (this uses read quota)...');
      const tweetId = parseTweetId(tweetUrl);
      const r = await twitter.v2.tweets(tweetId, {
        expansions: ['attachments.media_keys'],
        'media.fields': ['type','url','variants','width','height']
      });
      const media = r?.includes?.media || [];
      if (!media.length) {
        throw new Error('Tweet has no downloadable media');
      }
      
      const m0 = media[0];
      let mediaUrl = m0.url || null;
      if (m0.type === 'video' && Array.isArray(m0.variants)) {
        const vids = m0.variants.filter(v => v.content_type?.startsWith('video/'));
        vids.sort((a,b)=>(b.bit_rate||0)-(a.bit_rate||0));
        mediaUrl = vids[0]?.url || mediaUrl;
      }
      if (!mediaUrl) {
        throw new Error('No direct media URL found on tweet');
      }
      
      const dl = await downloadBuffer(mediaUrl);
      const buffer = dl.buffer;
      const contentType = dl.contentType || 'application/octet-stream';
      console.log(`📱 Fetched tweet media: ${mediaUrl} (${(buffer.length/1024).toFixed(1)}KB)`);
      
      txId = await uploadToArweave(buffer, contentType, 'NeedsArNS-Manual', jwk);
      uploaded = true;
      console.log(`☁️  Uploaded to Arweave: ${txId}`);
    }

    // Step 4: Verify TXID
    console.log(`\n🔍 Verifying TXID...`);
    const ok = await verifyTxIdExists(txId);
    if (!ok) {
      console.log(`⚠️  TXID ${txId} did not resolve via HEAD. Continuing anyway...`);
    } else {
      console.log(`✅ TXID verified!`);
    }

    // Step 5: Create full tweet replica (always in manual mode)
    console.log('\n📦 Creating full tweet replica archive...');
    
    let finalTxId = txId;
    let manifestTxId = null;
    let metadataTxId = null;
    let onchainId = null;
    let mediaArray = [];
    let mentionTweet = null;
    let parentTweet = null;
    let mentionUser = null;
    let parentUser = null;
    let includes = { users: [], media: [], tweets: [] };

    // Build media array
    if (uploaded) {
      mediaArray = [{
        type: 'photo', // Default for uploaded content
        txId: txId,
        alt_text: `Manual upload for ${undername}`,
        index: 0
      }];
    } else {
      // URL that contained Arweave TXID or extracted media
      mediaArray = [{
        type: 'link',
        txId: txId,
        alt_text: 'Content from URL',
        index: 0
      }];
    }

    // Step 6a: Get tweet data for replica (optional but recommended)
    let fetchTweetData = await askYesNo(rl, 'Do you want to fetch tweet data for the replica? (y/n, uses API quota)');
    if (fetchTweetData) {
      let tweetUrl = '';
      while (!tweetUrl) {
        tweetUrl = await askQuestion(rl, 'Enter the tweet URL to replicate: ');
        const tweetId = parseTweetId(tweetUrl);
        if (!tweetId) {
          console.log('❌ Invalid tweet URL. Please enter a valid X/Twitter status URL.');
          tweetUrl = '';
        } else {
          try {
            console.log('📱 Fetching tweet data...');
            const tweetResponse = await twitter.v2.tweets(tweetId, {
              expansions: ['author_id', 'attachments.media_keys', 'referenced_tweets.id'],
              'tweet.fields': ['text', 'created_at', 'entities', 'attachments'],
              'media.fields': ['type', 'url', 'width', 'height', 'alt_text'],
              'user.fields': ['username', 'name']
            });
            
            mentionTweet = tweetResponse.data;
            includes = tweetResponse.includes || {};
            
            // Find referenced tweet (parent)
            const referenced = mentionTweet?.referenced_tweets?.find(t => t.type === 'replied_to');
            if (referenced && includes.tweets) {
              parentTweet = includes.tweets.find(t => t.id === referenced.id);
            }
            
            // Get users
            if (includes.users) {
              if (mentionTweet?.author_id) {
                mentionUser = includes.users.find(u => u.id === mentionTweet.author_id);
              }
              if (parentTweet?.author_id) {
                parentUser = includes.users.find(u => u.id === parentTweet.author_id);
              }
            }
            
            console.log(`✅ Fetched tweet data: ${mentionTweet?.text?.substring(0, 50)}...`);
            fetchTweetData = true;
          } catch (e) {
            console.log(`⚠️  Could not fetch tweet data: ${e.message}`);
            fetchTweetData = false;
          }
        }
      }
    }
    
    // Create minimal tweet data if not fetched
    if (!mentionTweet) {
      mentionTweet = {
        id: 'manual',
        text: `Manual assignment for ${undername}`,
        author_id: null,
        created_at: new Date().toISOString()
      };
    }
    if (!parentTweet) {
      parentTweet = null;
    }

    // Build metadata object
    const metadataObj = buildMetadataObject(mentionTweet, parentTweet, mentionUser, parentUser, mediaArray, includes);
    metadataObj.metadata.undername = undername;
    
    // Upload metadata.json
    console.log('📄 Uploading metadata.json...');
    metadataTxId = await uploadToArweave(
      Buffer.from(JSON.stringify(metadataObj, null, 2)),
      'application/json',
      'NeedsArNS-Metadata',
      jwk
    );
    console.log(`✅ Metadata uploaded: ${metadataTxId}`);
    
    // Use shared HTML template
    const htmlTxId = TEMPLATE_HTML_TXID;
    console.log(`📄 Using shared HTML template: ${htmlTxId}`);
    
    // Create and upload manifest
    console.log('📦 Creating Arweave manifest...');
    const manifest = generateManifest(metadataTxId, mediaArray, htmlTxId);
    manifestTxId = await uploadManifest(
      Buffer.from(JSON.stringify(manifest, null, 2)),
      jwk
    );
    console.log(`✅ Manifest uploaded: ${manifestTxId}`);
    
    finalTxId = manifestTxId; // Use manifest as final target

    // Step 5b: Assign ArNS
    console.log(`\n📝 Assigning ArNS: ${undername} -> ${finalTxId}`);
    const recordResult = await createUndernameRecord(ant, undername, finalTxId, DEFAULT_TTL_SECONDS);
    if (!recordResult.success) {
      throw new Error(`ArNS assignment failed: ${recordResult.message}`);
    }
    onchainId = recordResult.recordId;
    console.log(`✅ ArNS record set: ${onchainId}`);

    // Update metadata object with final ArNS info
    metadataObj.archive.htmlTxId = htmlTxId;
    metadataObj.archive.manifestTxId = manifestTxId;
    metadataObj.archive.arnsRecordId = onchainId;
    metadataObj.archive.assignedAt = new Date().toISOString();

    // Save individual mention archive
    const archiveFile = await createMentionArchive(metadataObj);
    if (archiveFile) {
      console.log(`✅ Archive entry created: ${archiveFile}`);
      
      // Upload and assign archive index
      console.log('📤 Uploading archive index...');
      try {
        const indexResult = await uploadAndAssignArchiveIndex(ant, jwk, ROOT_ARNS_NAME, DEFAULT_TTL_SECONDS);
        if (indexResult.success) {
          console.log(`✅ Archive index updated: ${indexResult.txId}`);
        } else {
          console.warn(`⚠️ Archive index update failed (non-critical): ${indexResult.message || indexResult.error}`);
        }
      } catch (error) {
        console.warn(`⚠️ Archive index update error (non-critical): ${error.message}`);
      }
    } else {
      console.log('⚠️ Archive entry creation failed, but assignment succeeded');
    }

    // Step 6: Get reply target
    let replyTo = '';
    while (!replyTo) {
      replyTo = await askQuestion(rl, '\nEnter the tweet URL or ID to reply to: ');
      const replyId = parseTweetId(replyTo);
      if (!replyId) {
        console.log('❌ Invalid tweet URL/ID. Please enter a valid X/Twitter status URL or numeric ID.');
        replyTo = '';
      }
    }
    const replyId = parseTweetId(replyTo);

    // Get username - try to extract from URL first, then ask for API or manual entry
    let username = 'manual';
    
    // Try to extract username from URL first (no API call needed)
    const extractedUsername = extractUsernameFromUrl(replyTo);
    if (extractedUsername) {
      username = extractedUsername;
      console.log(`👤 Extracted username from URL: @${username}`);
    } else {
      // If no username in URL, ask what to do
      const usernameChoice = await askChoice(rl, 'How do you want to get the username?', [
        'Enter manually',
        'Fetch from API (uses read quota)',
        'Use "manual" as username'
      ]);
      
      if (usernameChoice.includes('Enter manually')) {
        username = await askQuestion(rl, 'Enter the username: ') || 'manual';
      } else if (usernameChoice.includes('Fetch from API')) {
        try {
          console.log('📱 Fetching tweet details...');
          const tweetData = await twitter.v2.tweets(replyId, {
            'tweet.fields': ['author_id'],
            expansions: ['author_id'],
            'user.fields': ['username']
          });
          const author = tweetData?.includes?.users?.[0];
          if (author?.username) {
            username = author.username;
            console.log(`👤 Found username: @${username}`);
          } else {
            console.log('⚠️  Could not fetch username, using "manual"');
            username = 'manual';
          }
        } catch (e) {
          console.log('⚠️  Could not fetch username (API error), using "manual"');
          username = 'manual';
        }
      }
      // If "Use manual", username stays as 'manual'
    }

    // Step 7: Compose and send reply
    const templateType = 'success-post-archive';
    const body = renderTemplate(templateType, {
      undername,
      rootArnsName: ROOT_ARNS_NAME,
      manifestTxId
    }) || `🎉 ${undername}_${ROOT_ARNS_NAME}.ar.io → ${manifestTxId}`;

    console.log(`\n📝 Reply message:`);
    console.log('─'.repeat(50));
    console.log(body);
    console.log('─'.repeat(50));

    const sendReply = await askYesNo(rl, 'Send this reply?');
    if (!sendReply) {
      console.log('❌ Reply cancelled.');
      rl.close();
      return;
    }

    const replyTweetId = await reply(twitter, replyId, body);
    console.log(`✅ Replied to ${replyId}: ${replyTweetId || 'unknown id'}`);

    // Step 8: Retweet option
    if (replyTweetId && MANUAL_RETWEET) {
      const doRetweet = await askYesNo(rl, 'Retweet the reply?');
      if (doRetweet) {
        const uid = await getBotUserId();
        if (uid) {
          await retweet(twitter, replyTweetId, uid);
          console.log(`🔄 Retweeted reply: ${replyTweetId}`);
        } else {
          console.log('⚠️ Could not get bot user ID for retweet');
        }
      }
    }

    // Step 9: Update processed mentions (so bot doesn't reprocess this tweet)
    if (replyTweetId) {
      await updateProcessedMentions(replyTweetId, {
        username,
        undername,
        txId: finalTxId, // Use finalTxId (manifest or direct)
        isUploadedMedia: uploaded,
        timestamp: new Date().toISOString()
      });
    }

    console.log('\n🎉 Done! Your content is now permanently stored and named on Arweave!');
    console.log(`🌐 View at: https://${undername}_${ROOT_ARNS_NAME}.ar.io`);
    console.log(`📦 Full tweet replica created with manifest: ${manifestTxId}`);

  } catch (error) {
    console.error('\n❌ Error:', error?.message || error);
    
    // Check if this is an infrastructure error
    const isInfraError = isInfrastructureErrorType(error);
    
    if (isInfraError) {
      console.log('🔧 Infrastructure error detected - this is likely a temporary issue');
      console.log('💡 Try again in a few minutes');
    } else {
      console.log('💡 This appears to be a user-related error - please check your inputs');
    }
  } finally {
    rl.close();
  }
}

// Only run main() if this script is executed directly
if (import.meta.url.endsWith(process.argv[1]) || import.meta.url.includes('manual.js')) {
  main().catch(err => {
    console.error('manual error:', err?.message || err);
    process.exit(1);
  });
}


