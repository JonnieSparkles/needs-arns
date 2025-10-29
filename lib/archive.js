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
        version: '2.1',
        description: 'NeedsArNS Bot Archive Index'
      },
      mentions: []
    };
    
    // Load existing index if it exists
    if (fs.existsSync(indexFile)) {
      index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    }
    
    // Create index entry
    const indexEntry = {
      mentionId: mentionData.metadata.mentionId,
      undername: mentionData.metadata.undername,
      username: mentionData.mentionTweet.user_name,
      processedAt: mentionData.metadata.processedAt,
      archiveType: mentionData.metadata.archiveType || 'tweet_replica',
      mediaCount: mentionData.parentTweet?.mediaCount || 0,
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

export function buildMetadataObject(mention, parent, mentionUser, parentUser, mediaArray = []) {
  return {
    metadata: {
      mentionId: mention.id,
      undername: null, // Will be filled in later
      processedAt: new Date().toISOString(),
      archiveType: 'tweet_replica',
      success: true,
      archiveVersion: '2.1'
    },
    mentionTweet: {
      id: mention.id,
      text: mention.text || '',
      user_name: mentionUser?.username || 'unknown',
      created_at: mention.created_at || new Date().toISOString()
    },
    parentTweet: {
      id: parent.id,
      text: parent.text || '',
      user_name: parentUser?.username || 'unknown',
      created_at: parent.created_at || new Date().toISOString(),
      mediaCount: mediaArray.length
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
