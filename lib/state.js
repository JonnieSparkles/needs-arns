// State management utilities

import fs from 'fs';

// ---------- state functions ----------
export function saveProcessedState(processedMentions, sinceId, processedDetails = {}, filePath = 'processed_mentions.json') {
  try {
    const state = {
      processedMentions: Array.from(processedMentions),
      processedDetails: processedDetails, // { mentionId: { undername, txId, success, timestamp, username } }
      lastSinceId: sinceId,
      lastUpdated: new Date().toISOString(),
      version: '1.1'
    };
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
    console.log(`💾 Saved: ${state.processedMentions.length} mentions, since_id: ${sinceId || 'none'}`);
  } catch (err) {
    console.error('❌ Failed to save processed state:', err.message);
  }
}

export function loadProcessedState(filePath = 'processed_mentions.json') {
  try {
    if (!fs.existsSync(filePath)) {
      console.log('📂 Starting fresh');
      return { processedMentions: new Set(), sinceId: undefined, processedDetails: {} };
    }
    
    const data = fs.readFileSync(filePath, 'utf8');
    const state = JSON.parse(data);
    
    const processedMentions = new Set(state.processedMentions || []);
    const sinceId = state.lastSinceId;
    const processedDetails = state.processedDetails || {};
    
    console.log(`📂 Loaded: ${processedMentions.size} mentions, since_id: ${sinceId || 'none'}`);
    
    return { processedMentions, sinceId, processedDetails };
  } catch (err) {
    console.error('❌ Failed to load processed state:', err.message);
    console.log('📂 Starting fresh');
    return { processedMentions: new Set(), sinceId: undefined, processedDetails: {} };
  }
}

export async function updateProcessedMentions(replyTweetId, mentionDetails, filePath = 'processed_mentions.json') {
  try {
    let state = {
      processedMentions: [],
      processedDetails: {},
      lastSinceId: undefined,
      lastUpdated: new Date().toISOString(),
      version: '1.1'
    };
    
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf8');
      state = JSON.parse(data);
    }
    
    // Add the reply tweet ID to processed mentions (so bot doesn't reprocess it)
    if (replyTweetId && !state.processedMentions.includes(replyTweetId)) {
      state.processedMentions.push(replyTweetId);
    }
    
    // Update lastSinceId if this tweet is newer
    if (replyTweetId && (!state.lastSinceId || replyTweetId > state.lastSinceId)) {
      state.lastSinceId = replyTweetId;
    }
    
    // Add to processed details
    if (replyTweetId) {
      state.processedDetails[replyTweetId] = {
        username: mentionDetails.username || 'manual',
        undername: mentionDetails.undername,
        txId: mentionDetails.txId,
        isUploadedMedia: mentionDetails.isUploadedMedia || false,
        success: true,
        timestamp: mentionDetails.timestamp || new Date().toISOString(),
        source: mentionDetails.source || 'manual'
      };
    }
    
    state.lastUpdated = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
    console.log(`📝 Updated processed_mentions.json (${state.processedMentions.length} total mentions)`);
  } catch (e) {
    console.log('processed_mentions update skipped:', e?.message || e);
  }
}
