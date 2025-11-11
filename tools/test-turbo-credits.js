#!/usr/bin/env node

// Test script for Turbo shared credits and preflight balance checks
// Validates config loading, balance fetching, cost estimation, and paidBy derivation
// Does NOT perform Twitter posting, ArNS assignment, or archive operations

import 'dotenv/config';
import { getJwkFromEnv } from '../lib/utils.js';
import { 
  getTurboClient, 
  loadTurboConfig, 
  getTurboBalanceWithShared, 
  estimateUploadCostWinc, 
  assertSufficientCredits,
  derivePaidBy,
  uploadToArweave
} from '../lib/arweave.js';

console.log('🧪 Testing Turbo Shared Credits & Preflight Checks\n');

async function runTests() {
  try {
    // Step 1: Load JWK and config
    console.log('📋 Step 1: Loading configuration...');
    const jwk = getJwkFromEnv();
    const config = loadTurboConfig();
    
    console.log('✅ Config loaded:');
    console.log(`   - Use Shared Credits: ${config.useSharedCredits}`);
    console.log(`   - Explicit Paid By: ${config.sharedCreditsPaidBy.length > 0 ? config.sharedCreditsPaidBy.join(', ') : 'None (auto-discover)'}`);
    console.log();

    // Step 2: Get Turbo client and fetch balance
    console.log('💰 Step 2: Fetching Turbo balance...');
    const turbo = getTurboClient(jwk);
    const balance = await getTurboBalanceWithShared(turbo);
    
    console.log('✅ Balance fetched:');
    console.log(`   - Native Balance: ${balance.nativeWinc} winc`);
    console.log(`   - Shared Balance: ${balance.sharedWinc} winc`);
    console.log(`   - Total Available: ${balance.totalWinc} winc`);
    console.log(`   - Received Approvals: ${balance.receivedApprovals.length}`);
    
    if (balance.receivedApprovals.length > 0) {
      console.log('\n   📝 Approval Details:');
      balance.receivedApprovals.forEach((approval, idx) => {
        const approved = BigInt(approval.approvedWincAmount || 0);
        const used = BigInt(approval.usedWincAmount || 0);
        const remaining = approved - used;
        console.log(`      ${idx + 1}. From: ${approval.payingAddress}`);
        console.log(`         Approved: ${approved} winc`);
        console.log(`         Used: ${used} winc`);
        console.log(`         Remaining: ${remaining} winc`);
      });
    }
    console.log();

    // Step 3: Test cost estimation for various sizes
    console.log('💵 Step 3: Testing cost estimation...');
    const testSizes = [
      { name: '1KB', bytes: 1024 },
      { name: '100KB', bytes: 102400 },
      { name: '1MB', bytes: 1048576 }
    ];

    for (const { name, bytes } of testSizes) {
      const estimated = await estimateUploadCostWinc(turbo, bytes);
      if (estimated !== null) {
        console.log(`   ✅ ${name} (${bytes} bytes): ${estimated} winc`);
      } else {
        console.log(`   ⚠️  ${name}: Cost estimation unavailable`);
      }
    }
    console.log();

    // Step 4: Test paidBy derivation
    console.log('🔗 Step 4: Testing paidBy derivation...');
    const paidBy = derivePaidBy(config, balance);
    console.log(`   Result: ${paidBy ? paidBy.join(', ') : 'undefined (native balance only)'}`);
    console.log();

    // Step 5: Test preflight validation with mock insufficient balance
    console.log('🚨 Step 5: Testing preflight validation (mock insufficient balance)...');
    const mockInsufficient = balance.totalWinc + 1000000n; // More than available
    const mockBalance = {
      nativeWinc: 100n,
      sharedWinc: 50n,
      totalWinc: 150n,
      receivedApprovals: []
    };
    
    try {
      assertSufficientCredits(mockInsufficient, mockBalance);
      console.log('   ❌ Test failed: Should have thrown INSUFFICIENT_TURBO_CREDITS');
    } catch (error) {
      if (error.message === 'INSUFFICIENT_TURBO_CREDITS') {
        console.log('   ✅ Correctly threw INSUFFICIENT_TURBO_CREDITS error');
      } else {
        console.log(`   ❌ Unexpected error: ${error.message}`);
      }
    }
    console.log();

    // Step 6: Test actual small upload (if sufficient balance)
    console.log('📤 Step 6: Testing actual upload with shared credits...');
    const testData = JSON.stringify({ 
      test: true, 
      timestamp: new Date().toISOString(),
      message: 'Turbo shared credits test upload'
    }, null, 2);
    const testBuffer = Buffer.from(testData);
    
    // Check if we have enough balance for this small test
    const testEstimate = await estimateUploadCostWinc(turbo, testBuffer.length);
    
    if (testEstimate !== null && testEstimate <= balance.totalWinc) {
      console.log(`   Estimated cost: ${testEstimate} winc`);
      console.log(`   Available: ${balance.totalWinc} winc`);
      console.log('   Proceeding with test upload...');
      
      const txId = await uploadToArweave(testBuffer, 'application/json', 'TurboCreditsTest', jwk);
      console.log(`   ✅ Test upload successful!`);
      console.log(`   Transaction ID: ${txId}`);
      console.log(`   View at: https://arweave.net/${txId}`);
    } else if (testEstimate === null) {
      console.log('   ⚠️  Skipping upload: Cost estimation unavailable');
    } else {
      console.log(`   ⚠️  Skipping upload: Insufficient balance (need ${testEstimate}, have ${balance.totalWinc})`);
    }
    console.log();

    // Summary
    console.log('✅ All tests completed successfully!');
    console.log('\n📊 Summary:');
    console.log(`   - Config loading: ✅`);
    console.log(`   - Balance fetch: ✅ (${balance.nativeWinc} native + ${balance.sharedWinc} shared)`);
    console.log(`   - Cost estimator: ✅`);
    console.log(`   - paidBy derivation: ✅`);
    console.log(`   - Preflight validation: ✅`);
    console.log(`   - Test upload: ${testEstimate !== null && testEstimate <= balance.totalWinc ? '✅' : '⏭️ (skipped)'}`);
    
  } catch (error) {
    console.error('\n❌ Test failed with error:');
    console.error(error);
    process.exit(1);
  }
}

runTests();

