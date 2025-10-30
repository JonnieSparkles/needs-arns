import 'dotenv/config';
import { ANT, ArweaveSigner } from '@ar.io/sdk';
import { updateUndernameRecord } from '../lib/arns.js';
import { requireEnv, getJwkFromEnv } from '../lib/utils.js';

// Configure env
const ANT_PROCESS_ID = requireEnv('ANT_PROCESS_ID');
const DEFAULT_TTL_SECONDS = parseInt(process.env.DEFAULT_TTL_SECONDS || '60', 10);

// Failed updates from last run (undername -> txId)
const FAILED_UPDATES = [
  { undername: '6529networkstate', txId: 'OpJeje3kkcdPhJk_dF43ub8OBax1J_oiywrCg1Mh_zg' },
  { undername: 'follow-the-money', txId: 'yFbN5iAfDlYJpehBq8csOvniOtl2WNpnl82BlI4JXH4' },
  { undername: 'preserve-our-wisdom', txId: '1jZr0px_EFOA42GrT8734krYGBWbGX78QSwuJ5_HKuU' },
  { undername: 'versus', txId: '9A02q11hawpCsC4AhHh6jMrYCC0YAV3dGI10rzG7GX8' },
  { undername: 'thoughtcrimes', txId: 'IvYqOLy6Xar7V--VCcH6aAsBYUVVcmOALscpAcBzvWg' },
  { undername: 'your-future-self-loves-you', txId: 'hIFiZdSZpv14rvOsEHv8tLaPvlFSL-0M-B559Giv4-k' },
  { undername: 'runtime', txId: 'O6BS_HVmZvaI9jatQGU3mXsCew3OeultShhkdtzSZWo' },
  { undername: 'archive', txId: 'zfN4e-L_V15r4l2Vzcd4I0yJW_Ocy39kXZsRvQIoCmM' }
];

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryWithBackoff(fn, { retries = 5, baseMs = 2000, factor = 2 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt > retries) throw err;
      const delay = baseMs * Math.pow(factor, attempt - 1);
      console.log(`⏳ Retry ${attempt}/${retries} in ${Math.round(delay)}ms... (${err?.message || err})`);
      await sleep(delay);
    }
  }
}

async function main() {
  const jwk = getJwkFromEnv();
  const ant = ANT.init({ signer: new ArweaveSigner(jwk), processId: ANT_PROCESS_ID });

  let success = 0;
  let failed = 0;

  for (const { undername, txId } of FAILED_UPDATES) {
    console.log(`\n🔁 Retrying ArNS update: ${undername} → ${txId}`);
    try {
      const result = await retryWithBackoff(
        async () => {
          const res = await updateUndernameRecord(ant, undername, txId, DEFAULT_TTL_SECONDS);
          if (!res.success) {
            throw new Error(res.message || 'update_failed');
          }
          return res;
        },
        { retries: 6, baseMs: 2000, factor: 2 }
      );
      console.log(`✅ Updated: ${undername} (recordId: ${result.recordId})`);
      success++;
      // Small delay between successful updates to avoid bursts
      await sleep(1000);
    } catch (err) {
      console.error(`❌ Failed: ${undername} → ${txId} :: ${err?.message || err}`);
      failed++;
    }
  }

  console.log(`\n📊 Retry summary: ${success} succeeded, ${failed} failed`);
}

main().catch((e) => {
  console.error('Fatal error running retries:', e);
  process.exit(1);
});


