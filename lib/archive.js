// Archive management utilities

import fs from 'fs';
import { uploadToArweave } from './arweave.js';

// ---------- archive functions ----------
export async function updateArchive(mentionDetails, doUpload = false, ant = null, ownerArnsName = null, defaultTtlSeconds = 60, jwk = null) {
  try {
    console.log('📚 Updating archive...');
    let archive = { 
      metadata: { 
        lastUpdated: '', 
        totalRecords: 0, 
        version: '1.0', 
        description: 'NeedsArNS Bot Archive - All successfully archived content' 
      }, 
      records: [] 
    };
    
    if (fs.existsSync('archive.json')) {
      const archiveData = fs.readFileSync('archive.json', 'utf8');
      archive = JSON.parse(archiveData);
    }
    
    const newRecord = {
      undername: mentionDetails.undername,
      txId: mentionDetails.txId,
      username: mentionDetails.username || 'manual',
      timestamp: mentionDetails.timestamp || new Date().toISOString(),
      isUploadedMedia: mentionDetails.isUploadedMedia || false
    };
    
    const existingIndex = archive.records.findIndex(r => r.undername === mentionDetails.undername);
    if (existingIndex >= 0) {
      archive.records[existingIndex] = newRecord;
      console.log(`📝 Updated: ${mentionDetails.undername}`);
    } else {
      archive.records.push(newRecord);
      console.log(`➕ Added: ${mentionDetails.undername}`);
    }
    
    archive.metadata.lastUpdated = new Date().toISOString();
    archive.metadata.totalRecords = archive.records.length;
    
    fs.writeFileSync('archive.json', JSON.stringify(archive, null, 2));
    console.log(`💾 Archive saved: ${archive.metadata.totalRecords} records`);
    
    if (doUpload && ant && ownerArnsName) {
      // Upload archive to Arweave and assign archive undername
      const archiveContent = JSON.stringify(archive, null, 2);
      const archiveTxId = await uploadToArweave(archiveContent, 'application/json', 'NeedsArNS-Archive', jwk);
      console.log(`📤 Archive uploaded: ${archiveTxId}`);
      
      try {
        console.log(`📝 Assigning archive ArNS record...`);
        const archiveArnsResult = await Promise.race([
          ant.setUndernameRecord({
            undername: 'archive',
            transactionId: archiveTxId,
            ttlSeconds: defaultTtlSeconds
          }),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('ArNS assignment timeout after 60 seconds')), 60000)
          )
        ]);
        console.log(`✅ Archive assigned: archive_${ownerArnsName}.ar.io`);
      } catch (arnsError) {
        console.log(`⚠️ Archive ArNS assignment failed: ${arnsError.message}`);
        console.log(`📋 Archive TXID: ${archiveTxId} (you can manually assign this later)`);
      }
      
      return archiveTxId;
    }
    
    return null;
  } catch (error) {
    console.error('❌ Error updating archive:', error);
    return null;
  }
}
