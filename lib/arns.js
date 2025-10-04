// ArNS (Arweave Name Service) utilities

// ---------- ArNS functions ----------
export async function checkUndernameAvailability(ant, undername) {
  try {
    const existingRecords = await ant.getRecords();
    if (existingRecords && existingRecords[undername]) {
      return { available: false, existing: existingRecords[undername] };
    }
    return { available: true, existing: null };
  } catch (error) {
    console.error(`❌ Error checking undername availability:`, error);
    // Return available=true to allow attempt (better to try and fail than block on API issues)
    return { available: true, existing: null, error: error.message };
  }
}

export async function createUndernameRecord(ant, undername, txId, ttlSeconds) {
  try {
    console.log(`📝 Creating ArNS record: ${undername} → ${txId}`);
    console.log(`🔍 Using TTL: ${ttlSeconds} seconds`);
    
    const result = await Promise.race([
      ant.setUndernameRecord({
        undername: undername,
        transactionId: txId,
        ttlSeconds: ttlSeconds
      }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('ArNS assignment timeout after 60 seconds')), 60000)
      )
    ]);
    
    console.log(`✅ ArNS record created: ${result.id}`);
    return { success: true, recordId: result.id, result };
  } catch (error) {
    console.error(`❌ ArNS record creation failed:`, error);
    
    // Check if it's a "name taken" error
    if (error.message?.includes('already exists') || error.message?.includes('taken')) {
      return { success: false, error: 'undername_taken', message: error.message };
    }
    
    // Check if it's a timeout error
    if (error.message?.includes('timeout')) {
      return { success: false, error: 'timeout', message: error.message };
    }
    
    return { success: false, error: 'creation_failed', message: error.message };
  }
}

export async function updateUndernameRecord(ant, undername, txId, ttlSeconds) {
  try {
    console.log(`📝 Updating ArNS record: ${undername} → ${txId}`);
    console.log(`🔍 Using TTL: ${ttlSeconds} seconds`);
    
    const result = await Promise.race([
      ant.setUndernameRecord({
        undername: undername,
        transactionId: txId,
        ttlSeconds: ttlSeconds
      }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('ArNS assignment timeout after 60 seconds')), 60000)
      )
    ]);
    
    console.log(`✅ ArNS record updated: ${result.id}`);
    return { success: true, recordId: result.id, result };
  } catch (error) {
    console.error(`❌ ArNS record update failed:`, error);
    
    // Check if it's a timeout error
    if (error.message?.includes('timeout')) {
      return { success: false, error: 'timeout', message: error.message };
    }
    
    return { success: false, error: 'update_failed', message: error.message };
  }
}

export async function getUndernameRecord(ant, undername) {
  try {
    const records = await ant.getRecords();
    return records?.[undername] || null;
  } catch (error) {
    console.error(`❌ Error getting undername record:`, error);
    return null;
  }
}
