// Archive management utilities

import fs from 'fs';
import path from 'path';

// ---------- archive functions ----------
export async function createMentionArchive(mentionData) {
  try {
    console.log('📚 Creating individual mention archive...');
    
    // Ensure directories exist
    const mentionsDir = 'archive/mentions';
    const metadataDir = 'archive/metadata';
    
    fs.mkdirSync(mentionsDir, { recursive: true });
    fs.mkdirSync(metadataDir, { recursive: true });
    
    // Create individual mention file
    const mentionFile = path.join(mentionsDir, `${mentionData.metadata.mentionId}.json`);
    fs.writeFileSync(mentionFile, JSON.stringify(mentionData, null, 2));
    
    console.log(`✅ Mention archived: ${mentionFile}`);
    
    // Update master index
    await updateMasterIndex(mentionData);
    
    return mentionFile;
  } catch (error) {
    console.error('❌ Error creating mention archive:', error);
    return null;
  }
}

export async function updateMentionArchive(mentionId, updates) {
  try {
    const mentionFile = `archive/mentions/${mentionId}.json`;
    
    if (!fs.existsSync(mentionFile)) {
      console.error(`❌ Mention file not found: ${mentionFile}`);
      return false;
    }
    
    const data = JSON.parse(fs.readFileSync(mentionFile, 'utf8'));
    
    // Merge updates into existing data
    if (updates.archive) {
      data.archive = { ...data.archive, ...updates.archive };
    }
    
    fs.writeFileSync(mentionFile, JSON.stringify(data, null, 2));
    console.log(`✅ Updated mention archive: ${mentionFile}`);
    
    // Update master index
    await updateMasterIndex(data);
    
    return true;
  } catch (error) {
    console.error('❌ Error updating mention archive:', error);
    return false;
  }
}

async function updateMasterIndex(mentionData) {
  try {
    const indexFile = 'archive/metadata/index.json';
    
    let index = {
      metadata: { 
        lastUpdated: new Date().toISOString(),
        totalMentions: 0,
        version: '2.2',
        description: 'NeedsArNS Bot Archive Index'
      },
      mentions: []
    };
    
    // Load existing index if it exists
    if (fs.existsSync(indexFile)) {
      index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    }
    
    // Extract fields from raw API response
    const rawApiResponse = mentionData.rawApiResponse;
    const mentionTweet = rawApiResponse.mentionTweet;
    const includes = rawApiResponse.includes || {};
    
    // Use helper functions to extract data
    // For manual entries, try to get username from includes first
    let username = 'unknown';
    if (mentionData.metadata.archiveType === 'manual' && includes.users && includes.users.length > 0) {
      // For manual entries, username might be in includes.users array
      const user = includes.users.find(u => u.username);
      if (user?.username) {
        username = user.username;
      }
    } else {
      username = getTweetUsername(mentionTweet, includes);
    }
    // Use archived media count (what we actually archived)
    const mediaCount = mentionData.archive?.media?.length || 0;
    
    // Create index entry
    const indexEntry = {
      mentionId: mentionData.metadata.mentionId,
      undername: mentionData.metadata.undername,
      username: username,
      processedAt: mentionData.metadata.processedAt,
      archiveType: mentionData.metadata.archiveType || 'tweet_replica',
      mediaCount: mediaCount,
      manifestTxId: mentionData.archive?.manifestTxId,
      filePath: `mentions/${mentionData.metadata.mentionId}.json`
    };
    
    // Update or add entry
    const existingIndex = index.mentions.findIndex(m => m.mentionId === indexEntry.mentionId);
    if (existingIndex >= 0) {
      index.mentions[existingIndex] = indexEntry;
    } else {
      index.mentions.push(indexEntry);
    }
    
    // Update metadata
    index.metadata.lastUpdated = new Date().toISOString();
    index.metadata.totalMentions = index.mentions.length;
    
    // Save index
    fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
    console.log(`📊 Master index updated: ${index.metadata.totalMentions} mentions`);
    
    return true;
  } catch (error) {
    console.error('❌ Error updating master index:', error);
    return false;
  }
}

// ---------- helper functions to extract data from raw API responses ----------

export function getTweetUsername(rawTweet, includes) {
  if (!rawTweet?.author_id) return 'unknown';
  const user = includes?.users?.find(u => u.id === rawTweet.author_id);
  return user?.username || 'unknown';
}

export function getTweetText(rawTweet) {
  return rawTweet?.text || '';
}

export function getTweetEntities(rawTweet) {
  return rawTweet?.entities || null;
}

export function getMediaCount(rawTweet, includes) {
  if (!rawTweet?.attachments?.media_keys) return 0;
  return rawTweet.attachments.media_keys.length;
}

// Extract only URL entities needed for expanding t.co links in templates
export function extractUrlEntities(entities) {
  if (!entities?.urls || entities.urls.length === 0) {
    return { urls: [] };
  }
  
  // Only store what the template needs: url and expanded_url
  return {
    urls: entities.urls.map(urlEntity => ({
      url: urlEntity.url,
      expanded_url: urlEntity.expanded_url
    }))
  };
}

// ---------- metadata builder ----------

export function buildMetadataObject(mention, parent, mentionUser, parentUser, mediaArray = [], includes = {}) {
  return {
    metadata: {
      mentionId: mention.id,
      undername: null, // Will be filled in later
      processedAt: new Date().toISOString(),
      archiveType: 'tweet_replica',
      success: true,
      archiveVersion: '2.2'
    },
    rawApiResponse: {
      fetchedAt: new Date().toISOString(),
      mentionTweet: mention,  // Full raw tweet object
      parentTweet: parent,    // Full raw parent tweet
      includes: {
        users: includes?.users || [],
        media: includes?.media || [],
        tweets: includes?.tweets || []
      }
    },
    archive: {
      htmlTxId: null, // Will be filled in later
      assignedAt: null, // Will be filled in later
      media: mediaArray.map((media, index) => ({
        index,
        type: media.type,
        txId: media.txId,
        alt_text: media.alt_text || ''
      }))
    }
  };
}
