#!/usr/bin/env node

/**
 * Interactive script to add a new Twitter account to watch mode
 *
 * Usage: npm run watch:add-account
 *        node tools/add-watch-account.js
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import dotenv from 'dotenv';
import { TwitterApi } from 'twitter-api-v2';
import { TIER_PRESETS } from '../lib/watch-filter.js';

// Load environment variables
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.WATCH_CONFIG_PATH || path.join(__dirname, '..', 'watch-config.json');

// ANSI colors for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  magenta: '\x1b[35m'
};

const c = (color, text) => `${colors[color]}${text}${colors.reset}`;

// Create readline interface
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (prompt) => new Promise((resolve) => rl.question(prompt, resolve));

// Validate Arweave TXID format (43 chars, base64url)
function isValidArweaveTxId(id) {
  return /^[a-zA-Z0-9_-]{43}$/.test(id);
}

// Validate ArNS name format
function isValidArnsName(name) {
  return /^[a-z0-9_-]+$/i.test(name) && name.length >= 1 && name.length <= 51;
}

// Validate ANT process ID format (43 chars, base64url)
function isValidAntProcessId(id) {
  return isValidArweaveTxId(id);
}

// Get Twitter client
function getTwitterClient() {
  const credentials = {
    appKey: process.env.TWITTER_APP_KEY,
    appSecret: process.env.TWITTER_APP_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_SECRET
  };

  if (!credentials.appKey || !credentials.appSecret) {
    return null;
  }

  return new TwitterApi(credentials);
}

// Look up Twitter user by username
async function lookupTwitterUser(twitter, username) {
  try {
    const user = await twitter.v2.userByUsername(username, {
      'user.fields': ['id', 'name', 'username', 'public_metrics', 'verified', 'description']
    });

    if (!user.data) {
      return null;
    }

    return user.data;
  } catch (error) {
    if (error.code === 429) {
      console.log(c('yellow', '   Rate limited. Please try again in a few minutes.'));
    }
    return null;
  }
}

// Load existing config
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    // Create default config if it doesn't exist
    return {
      version: '1.0',
      pollIntervalMinutes: 30,
      accounts: []
    };
  }

  const content = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(content);
}

// Save config
function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

// Check if PM2 is managing the watch process
function checkPm2Status() {
  try {
    const result = execSync('pm2 jlist 2>/dev/null', { encoding: 'utf8' });
    const processes = JSON.parse(result);
    const watchProcess = processes.find(p =>
      p.name === 'needs-arns-watch' ||
      p.name?.includes('watch') ||
      p.pm2_env?.script?.includes('watch.js')
    );

    if (watchProcess) {
      return {
        running: watchProcess.pm2_env?.status === 'online',
        name: watchProcess.name,
        pid: watchProcess.pid
      };
    }
    return null;
  } catch {
    return null;
  }
}

// Restart PM2 process
function restartPm2(processName) {
  try {
    execSync(`pm2 restart ${processName}`, { stdio: 'inherit' });
    return true;
  } catch {
    return false;
  }
}

// Print header
function printHeader() {
  console.log();
  console.log(c('cyan', '═══════════════════════════════════════════════════════════'));
  console.log(c('bright', '   🐦 Add New Twitter Account to Watch Mode'));
  console.log(c('cyan', '═══════════════════════════════════════════════════════════'));
  console.log();
}

// Print tier options
function printTierOptions() {
  console.log();
  console.log(c('bright', '   Filtering Tiers:'));
  console.log();
  console.log(`   ${c('cyan', '1.')} ${c('bright', 'none')}        - Archive ${c('green', 'ALL')} posts (no filtering)`);
  console.log(`   ${c('cyan', '2.')} ${c('bright', 'small')}       - 1K impressions OR 10 likes`);
  console.log(`   ${c('cyan', '3.')} ${c('bright', 'medium')}      - 10K impressions OR 100 likes`);
  console.log(`   ${c('cyan', '4.')} ${c('bright', 'large-whale')} - 100K impressions OR 1K likes`);
  console.log(`   ${c('cyan', '5.')} ${c('bright', 'ultra-whale')} - 500K impressions OR 5K likes`);
  console.log(`   ${c('cyan', '6.')} ${c('bright', 'custom')}      - Set your own thresholds`);
  console.log();
}

// Pre-flight checks for environment
function runPreflightChecks() {
  const issues = [];
  const warnings = [];

  // Check Twitter credentials
  if (!process.env.TWITTER_APP_KEY || !process.env.TWITTER_APP_SECRET) {
    issues.push('Twitter API credentials missing (TWITTER_APP_KEY, TWITTER_APP_SECRET)');
  }
  if (!process.env.TWITTER_ACCESS_TOKEN || !process.env.TWITTER_ACCESS_SECRET) {
    issues.push('Twitter access tokens missing (TWITTER_ACCESS_TOKEN, TWITTER_ACCESS_SECRET)');
  }

  // Check Arweave wallet
  const walletPath = process.env.ARWEAVE_WALLET_PATH;
  const walletJson = process.env.ARWEAVE_JWK_JSON;
  if (!walletPath && !walletJson) {
    issues.push('Arweave wallet not configured (ARWEAVE_WALLET_PATH or ARWEAVE_JWK_JSON)');
  } else if (walletPath && !fs.existsSync(walletPath)) {
    issues.push(`Wallet file not found: ${walletPath}`);
  }

  // Check template TXID
  const templateTxId = process.env.WATCH_POST_TEMPLATE_TXID || process.env.TEMPLATE_HTML_TXID;
  if (!templateTxId) {
    issues.push('Post template not configured (WATCH_POST_TEMPLATE_TXID or TEMPLATE_HTML_TXID)');
  } else if (!isValidArweaveTxId(templateTxId)) {
    issues.push(`Invalid template TXID format: ${templateTxId}`);
  }

  // Check optional but recommended settings
  if (!process.env.WATCH_LANDING_TEMPLATE_TXID) {
    warnings.push('Landing template TXID not set (WATCH_LANDING_TEMPLATE_TXID) - optional but recommended');
  }

  return { issues, warnings, templateTxId };
}

// Main function
async function main() {
  printHeader();

  // Run pre-flight checks
  console.log(c('bright', '── Pre-flight Checks ──'));
  console.log();

  const { issues, warnings, templateTxId } = runPreflightChecks();

  if (issues.length > 0) {
    console.log(c('red', '   ❌ Critical issues found:'));
    issues.forEach(issue => console.log(c('red', `      • ${issue}`)));
    console.log();
    console.log(c('dim', '   Fix these issues in your .env file before continuing.'));
    rl.close();
    process.exit(1);
  }

  console.log(c('green', '   ✅ Twitter credentials configured'));
  console.log(c('green', '   ✅ Arweave wallet configured'));
  console.log(c('green', `   ✅ Post template: ${templateTxId.substring(0, 8)}...`));

  if (warnings.length > 0) {
    console.log();
    warnings.forEach(warn => console.log(c('yellow', `   ⚠️  ${warn}`)));
  }

  console.log();

  // Get Twitter client
  const twitter = getTwitterClient();

  // Load existing config
  const config = loadConfig();
  console.log(c('dim', `   Current accounts: ${config.accounts.length}`));
  if (config.accounts.length > 0) {
    console.log(c('dim', `   Existing: ${config.accounts.map(a => '@' + a.twitterUsername).join(', ')}`));
  }
  console.log();

  // Step 1: Get Twitter username
  console.log(c('bright', '── Step 1: Twitter Account ──'));
  console.log();

  let username = await question('   Twitter username (without @): ');
  username = username.trim().replace(/^@/, '').toLowerCase();

  if (!username) {
    console.log(c('red', '   ❌ Username is required'));
    rl.close();
    process.exit(1);
  }

  // Check if account already exists
  const existingAccount = config.accounts.find(a => a.twitterUsername === username);
  if (existingAccount) {
    console.log(c('yellow', `   ⚠️  Account @${username} already exists in config`));
    const overwrite = await question('   Overwrite? (y/n): ');
    if (overwrite.toLowerCase() !== 'y') {
      console.log(c('dim', '   Cancelled.'));
      rl.close();
      process.exit(0);
    }
    // Remove existing account
    config.accounts = config.accounts.filter(a => a.twitterUsername !== username);
  }

  // Look up user
  console.log(c('dim', `   🔍 Looking up @${username}...`));
  const user = await lookupTwitterUser(twitter, username);

  let userId;
  if (user) {
    userId = user.id;
    console.log(c('green', `   ✅ Found: ${user.name} (@${user.username})`));
    if (user.public_metrics) {
      const followers = user.public_metrics.followers_count?.toLocaleString() || '?';
      const tweets = user.public_metrics.tweet_count?.toLocaleString() || '?';
      console.log(c('dim', `      Followers: ${followers} | Tweets: ${tweets}`));
    }
    if (user.verified) {
      console.log(c('blue', `      ✓ Verified account`));
    }
  } else {
    console.log(c('yellow', '   ⚠️  Could not look up user automatically'));
    userId = await question('   Enter Twitter user ID manually: ');
    userId = userId.trim();
    if (!userId || !/^\d+$/.test(userId)) {
      console.log(c('red', '   ❌ Invalid user ID (must be numeric)'));
      rl.close();
      process.exit(1);
    }
  }

  console.log();

  // Step 2: ArNS configuration
  console.log(c('bright', '── Step 2: ArNS Configuration ──'));
  console.log();

  let arnsName = await question('   ArNS name for this account: ');
  arnsName = arnsName.trim().toLowerCase();

  if (!isValidArnsName(arnsName)) {
    console.log(c('red', '   ❌ Invalid ArNS name (use a-z, 0-9, -, _ only, max 51 chars)'));
    rl.close();
    process.exit(1);
  }

  // Check if ArNS name already used by another account
  const arnsConflict = config.accounts.find(a => a.arnsName === arnsName);
  if (arnsConflict) {
    console.log(c('red', `   ❌ ArNS name "${arnsName}" already used by @${arnsConflict.twitterUsername}`));
    rl.close();
    process.exit(1);
  }

  console.log();
  console.log(c('yellow', '   ℹ️  You need to register this ArNS name if you haven\'t already'));
  console.log(c('dim', '      Register at: https://arns.app'));
  console.log();

  const hasArns = await question('   Have you registered this ArNS name? (y/n): ');
  if (hasArns.toLowerCase() !== 'y') {
    console.log();
    console.log(c('cyan', '   📝 Steps to register:'));
    console.log(c('dim', '      1. Go to https://arns.app'));
    console.log(c('dim', `      2. Search for "${arnsName}"`));
    console.log(c('dim', '      3. Purchase the name (costs AR)'));
    console.log(c('dim', '      4. Note the ANT Process ID from your domain settings'));
    console.log(c('dim', '      5. Run this script again'));
    console.log();
    rl.close();
    process.exit(0);
  }

  let antProcessId = await question('   ANT Process ID: ');
  antProcessId = antProcessId.trim();

  if (!isValidAntProcessId(antProcessId)) {
    console.log(c('red', '   ❌ Invalid ANT Process ID (must be 43 characters, base64url)'));
    rl.close();
    process.exit(1);
  }

  // Check for ANT Process ID conflicts
  const antConflict = config.accounts.find(a => a.antProcessId === antProcessId);
  if (antConflict) {
    console.log(c('yellow', `   ⚠️  This ANT Process ID is already used by @${antConflict.twitterUsername}`));
    console.log(c('yellow', '      Using the same ANT for multiple accounts may cause conflicts.'));
    const continueAnyway = await question('   Continue anyway? (y/n): ');
    if (continueAnyway.toLowerCase() !== 'y') {
      rl.close();
      process.exit(0);
    }
  }

  console.log(c('green', '   ✅ Valid ANT Process ID'));
  console.log();

  // Step 3: Filtering configuration
  console.log(c('bright', '── Step 3: Filtering Configuration ──'));
  printTierOptions();

  const tierChoice = await question('   Select tier (1-6): ');
  const tierMap = {
    '1': 'none',
    '2': 'small',
    '3': 'medium',
    '4': 'large-whale',
    '5': 'ultra-whale',
    '6': 'custom'
  };

  const tier = tierMap[tierChoice] || 'none';
  let filtering = {};

  if (tier === 'none') {
    filtering = { enabled: false };
    console.log(c('green', '   → Will archive ALL posts'));
  } else if (tier === 'custom') {
    console.log();
    console.log(c('dim', '   Enter custom thresholds (0 = disabled):'));

    const minImpressions = parseInt(await question('   Min impressions: ') || '0');
    const minLikes = parseInt(await question('   Min likes: ') || '0');
    const minReplies = parseInt(await question('   Min replies: ') || '0');
    const minRetweets = parseInt(await question('   Min retweets: ') || '0');

    filtering = {
      enabled: true,
      tier: 'custom',
      thresholds: { minImpressions, minLikes, minReplies, minRetweets }
    };
  } else {
    filtering = {
      enabled: true,
      tier,
      thresholds: TIER_PRESETS[tier]
    };
    console.log(c('green', `   → Using ${tier} tier`));
  }

  // Additional filtering options
  console.log();
  const alwaysMedia = await question('   Always archive posts with media? (Y/n): ');
  filtering.alwaysArchiveMedia = alwaysMedia.toLowerCase() !== 'n';

  const selfReplies = await question('   Archive self-reply threads? (Y/n): ');
  filtering.archiveSelfReplies = selfReplies.toLowerCase() !== 'n';

  const pendingHours = await question('   Pending queue max age in hours (default 48): ');
  filtering.pendingMaxAgeHours = parseInt(pendingHours) || 48;

  console.log();

  // Step 4: Reply configuration
  console.log(c('bright', '── Step 4: Reply Configuration ──'));
  console.log();
  const replyToPost = await question('   Reply to posts with archive link? (y/N): ');
  const shouldReply = replyToPost.toLowerCase() === 'y';
  console.log();

  // Build account object
  const newAccount = {
    twitterUsername: username,
    twitterUserId: userId,
    arnsName,
    antProcessId,
    enabled: true,
    replyToPost: shouldReply,
    filtering
  };

  // Show summary
  console.log(c('bright', '── Summary ──'));
  console.log();
  console.log(c('cyan', JSON.stringify(newAccount, null, 2)));
  console.log();

  const confirm = await question('   Add this account? (Y/n): ');
  if (confirm.toLowerCase() === 'n') {
    console.log(c('dim', '   Cancelled.'));
    rl.close();
    process.exit(0);
  }

  // Add to config and save
  config.accounts.push(newAccount);
  saveConfig(config);

  console.log();
  console.log(c('green', `   ✅ Account @${username} added to watch-config.json`));
  console.log(c('dim', `      Total accounts: ${config.accounts.length}`));
  console.log();

  // Important: Root ArNS setup instructions
  console.log(c('bright', '── IMPORTANT: Root ArNS Setup ──'));
  console.log();
  console.log(c('yellow', '   The watch mode will automatically manage:'));
  console.log(c('dim', `      • index_${arnsName}.ar.io → JSON index of posts`));
  console.log();
  console.log(c('yellow', '   You must manually set up the root record:'));
  console.log(c('dim', `      • ${arnsName}.ar.io → Landing page`));
  console.log();
  console.log(c('cyan', '   Options for root ArNS setup:'));
  console.log(c('dim', '      1. Use arns.app dashboard to point root @ to a landing page'));
  console.log(c('dim', '      2. Create a custom landing page that fetches from index_'));
  console.log(c('dim', '      3. Use the provided template in archive-templates/'));
  console.log();
  console.log(c('magenta', '   Landing page must fetch index from:'));
  console.log(c('bright', `      https://index_${arnsName}.ar.io`));
  console.log();

  // Check if watch mode is running via PM2
  const pm2Status = checkPm2Status();

  if (pm2Status) {
    console.log(c('yellow', `   ℹ️  Watch mode is ${pm2Status.running ? 'running' : 'stopped'} via PM2 (${pm2Status.name})`));
    const restart = await question('   Restart to apply changes? (Y/n): ');

    if (restart.toLowerCase() !== 'n') {
      console.log(c('dim', '   Restarting...'));
      if (restartPm2(pm2Status.name)) {
        console.log(c('green', '   ✅ Watch mode restarted'));
      } else {
        console.log(c('red', '   ❌ Failed to restart. Run manually: pm2 restart ' + pm2Status.name));
      }
    }
  } else {
    console.log(c('dim', '   To start watch mode, run: npm run watch'));
  }

  console.log();
  console.log(c('cyan', '═══════════════════════════════════════════════════════════'));
  console.log(c('green', '   Done! 🎉'));
  console.log(c('cyan', '═══════════════════════════════════════════════════════════'));
  console.log();
  console.log(c('dim', '   Next steps:'));
  console.log(c('dim', `      1. Set up root ArNS record for ${arnsName}.ar.io`));
  console.log(c('dim', '      2. Start/restart watch mode'));
  console.log(c('dim', `      3. Verify: https://${arnsName}.ar.io`));
  console.log();

  rl.close();
}

// Run
main().catch(error => {
  console.error(c('red', `\n   ❌ Error: ${error.message}`));
  rl.close();
  process.exit(1);
});
