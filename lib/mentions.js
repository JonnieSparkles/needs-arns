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
  if (!mentionText || typeof mentionText !== 'string') {
    return null;
  }

  // Normalize whitespace: collapse all whitespace sequences to single spaces
  const normalizedText = mentionText.replace(/\s+/g, ' ').trim();

  // First check for the simple "please" command (auto-path using postId)
  // Pattern: @NeedsArNS please (with optional trailing text)
  const pleasePattern = /@NeedsArNS\b\s+please\b/i;
  if (pleasePattern.test(normalizedText)) {
    return { type: 'auto', undername: null };
  }

  // Strict pattern: @NeedsArNS [optional whitespace] (assign|archive) [whitespace] path
  // This ensures the command appears immediately after @NeedsArNS
  // Pattern breakdown:
  // - @NeedsArNS\b - Bot mention with word boundary
  // - \s* - Optional whitespace (0 or more spaces)
  // - (assign|archive) - Command verbs
  // - \s+ - Required whitespace
  // - ([a-z0-9_-]{1,63}) - Path (1-63 chars, lowercase alphanumeric, dash, underscore)
  // - \b - Word boundary to ensure complete match
  const strictPattern = /@NeedsArNS\b\s*(assign|archive)\s+([a-z0-9_-]{1,63})\b/i;

  const m = normalizedText.match(strictPattern);
  if (!m) {
    // Only log if @NeedsArNS was mentioned but no valid command found
    if (/@NeedsArNS\b/i.test(normalizedText)) {
      console.log(`🚫 Invalid command format: "${normalizedText}"`);
    }
    return null;
  }

  const verb = m[1].toLowerCase();
  const path = m[2].toLowerCase();

  // Validate path according to ArNS rules (reusing undername validation)
  if (!isValidUndername(path)) {
    console.log(`🚫 Invalid path format: "${path}"`);
    return null;
  }

  // Both 'assign' and 'archive' now do the same thing (path-based archive)
  return { type: 'archive', undername: path };
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
