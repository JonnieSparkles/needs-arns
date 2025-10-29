// Twitter mention processing utilities

import { isValidUndername, isInfrastructureErrorType, ASSIGN_CMD_RE } from './utils.js';
import { renderTemplate } from '../response-templates/loader.js';

// ---------- mention processing functions ----------
export function fetchParentTweet(includes, mention) {
  const replied = mention?.referenced_tweets?.find(t => t.type === 'replied_to');
  if (!replied) return null;
  // Find the parent tweet in the includes data (no API call needed!)
  const parent = includes?.tweets?.find(t => t.id === replied.id);
  return parent || null;
}

export function fetchParentUser(includes, parentTweet) {
  if (!parentTweet?.author_id) return null;
  // Find the parent user in the includes data
  const parentUser = includes?.users?.find(u => u.id === parentTweet.author_id);
  return parentUser || null;
}

export function isUserAllowed(mention, includes, allowedUsers = []) {
  // If no access control is configured, allow all users
  if (allowedUsers.length === 0) {
    return true;
  }
  
  // Find the author info from the includes.users data
  const authorId = mention.author_id;
  const author = includes?.users?.find(u => u.id === authorId);
  
  if (!author || !author.username) {
    console.log(`⚠️ Could not determine username for mention ${mention.id}`);
    return false; // Deny if we can't identify the user
  }
  
  const username = author.username.toLowerCase();
  const isAllowed = allowedUsers.includes(username);
  
  console.log(`🔐 Access check: @${username} ${isAllowed ? '✅ ALLOWED' : '❌ DENIED'}`);
  return isAllowed;
}

export function extractCommandFromMention(mentionText) {
  // Replace line breaks with spaces to handle multi-line mentions
  const normalizedText = mentionText.replace(/\s+/g, ' ').trim();
  
  // Check if this is a valid command format: contains @NeedsArNS anywhere (handles Twitter auto-mentions)
  const containsBot = /@NeedsArNS\b/i.test(normalizedText);
  if (!containsBot) {
    console.log(`🚫 Not a bot command: "${normalizedText}"`);
    return null; // Not a command to our bot
  }
  
  // Check for help command
  if (/\bhelp\b/i.test(normalizedText)) {
    console.log(`✅ Help command detected`);
    return { type: 'help' };
  }
  
  const m = normalizedText.match(ASSIGN_CMD_RE);
  if (!m) return null;
  
  const undername = m[1].toLowerCase();
  
  // Validate undername according to ArNS rules (after converting to lowercase)
  if (!isValidUndername(undername)) {
    return null;
  }
  
  return { type: 'assign', undername };
}

export async function handleHelpCommand(twitterClient, mentionId) {
  const helpMsg = renderTemplate('help');
  if (helpMsg) {
    await reply(twitterClient, mentionId, helpMsg);
  } else {
    // Fallback if template loading fails
    await reply(twitterClient, mentionId, '🤖 @NeedsArNS Bot - Use @NeedsArNS assign <name> to name content!');
  }
}

export async function handleAccessDenied(twitterClient, mentionId, username) {
  const denialMsg = renderTemplate('error-access-denied');
  await reply(twitterClient, mentionId, denialMsg || '👋 Thanks for your interest! ArNS assignment is currently in private beta.');
}

export async function handleNameTaken(twitterClient, mentionId, undername) {
  const nameTakenMsg = renderTemplate('error-name-taken', { undername });
  await reply(twitterClient, mentionId, nameTakenMsg || `❌ Undername '${undername}' is already taken. Try a different name.`);
}

export async function handleTxIdFailed(twitterClient, mentionId, txId) {
  const txidErrorMsg = renderTemplate('error-txid-failed', { txId });
  await reply(twitterClient, mentionId, txidErrorMsg || `❌ That Arweave TXID didn't resolve: ${txId}`);
}

export async function handleNoMedia(twitterClient, mentionId) {
  const noMediaMsg = renderTemplate('error-no-media');
  await reply(twitterClient, mentionId, noMediaMsg || '❌ Could not access media in the parent tweet. Please try again.');
}

export async function handleUploadFailed(twitterClient, mentionId, errorMessage) {
  const uploadErrorMsg = renderTemplate('error-upload-failed', { errorMessage });
  await reply(twitterClient, mentionId, uploadErrorMsg || `❌ Failed to upload media to Arweave: ${errorMessage}`);
}

export async function handleNoContent(twitterClient, mentionId) {
  const noContentMsg = renderTemplate('error-no-content');
  await reply(twitterClient, mentionId, noContentMsg || '❌ Parent tweet must contain either an Arweave link or media attachment.');
}

export async function handleGeneralError(twitterClient, mentionId, errorMessage) {
  const generalErrorMsg = renderTemplate('error-general', { errorMessage });
  await reply(twitterClient, mentionId, generalErrorMsg || `❌ Failed: ${errorMessage}`);
}

export async function handleSuccess(twitterClient, mentionId, undername, rootArnsName, txId, isUploadedMedia) {
  const templateType = isUploadedMedia ? 'success-uploaded' : 'success-assigned';
  const msg = renderTemplate(templateType, {
    undername,
    rootArnsName,
    txId
  });
  
  // Template system handles character limits and fallbacks automatically
  if (!msg) {
    // Fallback if template loading fails
    const fallbackMsg = `🎉 ${undername}_${rootArnsName}.ar.io → ${txId}`;
    console.log('⚠️ Template loading failed, using fallback message');
    return await reply(twitterClient, mentionId, fallbackMsg);
  }

  // Wait 1 minute before replying to make it feel more natural
  console.log('⏳ Waiting 1 minute before replying...');
  await new Promise(resolve => setTimeout(resolve, 60000));

  return await reply(twitterClient, mentionId, msg);
}

// Import reply function to avoid circular dependency
async function reply(twitterClient, inReplyTo, body) {
  try {
    const replyResult = await twitterClient.v2.reply(body, inReplyTo);
    return replyResult.data?.id; // Return the reply tweet ID
  } catch (e) {
    console.error('reply error:', e?.message || e);
    return null;
  }
}
