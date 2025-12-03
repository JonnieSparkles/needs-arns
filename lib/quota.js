// User quota tracking system
import fs from 'fs';
import path from 'path';

// Tier configurations
export const TIERS = {
  free: {
    name: 'Free',
    limit: 5,
    price: 0
  },
  pro: {
    name: 'Pro',
    limit: 100,
    price: 50 // AR tokens
  },
  enterprise: {
    name: 'Enterprise',
    limit: 500,
    price: null // Custom pricing
  }
};

// Data directory
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '.';
const USERS_FILE = path.join(DATA_DIR, 'users.json');

// In-memory cache
let usersCache = null;

// ---------- File Operations ----------

export function loadUsers() {
  if (usersCache) return usersCache;

  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = fs.readFileSync(USERS_FILE, 'utf8');
      usersCache = JSON.parse(data);
      console.log(`📊 Loaded ${Object.keys(usersCache.users || {}).length} users from quota database`);
    } else {
      usersCache = {
        users: {},
        version: '1.0',
        lastUpdated: new Date().toISOString()
      };
      console.log('📊 Created new users quota database');
    }
  } catch (error) {
    console.error('❌ Error loading users file:', error);
    usersCache = {
      users: {},
      version: '1.0',
      lastUpdated: new Date().toISOString()
    };
  }

  return usersCache;
}

export function saveUsers(users) {
  try {
    users.lastUpdated = new Date().toISOString();
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    usersCache = users;
    console.log(`💾 Saved users quota database (${Object.keys(users.users || {}).length} users)`);
  } catch (error) {
    console.error('❌ Error saving users file:', error);
  }
}

// ---------- Date Helpers ----------

function getMonthKey() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function isNewMonth(periodStart) {
  if (!periodStart) return true;
  const startDate = new Date(periodStart);
  const startMonth = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, '0')}`;
  return startMonth !== getMonthKey();
}

// ---------- User Management ----------

export function getUser(twitterUserId, username) {
  const users = loadUsers();
  let user = users.users[twitterUserId];

  if (!user) {
    // Create new user with free tier
    user = {
      twitterUserId,
      username,
      tier: 'free',
      assignments_this_month: 0,
      assignments_lifetime: 0,
      period_start: new Date().toISOString(),
      period_end: getNextMonthDate().toISOString(),
      created_at: new Date().toISOString(),
      subscription: {
        status: 'none', // none, active, expired, cancelled
        payment_tx_id: null,
        expires_at: null,
        auto_renew: false
      }
    };
    users.users[twitterUserId] = user;
    saveUsers(users);
    console.log(`👤 Created new user: @${username} (${twitterUserId}) with free tier`);
  } else {
    // Check if we need to reset monthly counter
    if (isNewMonth(user.period_start)) {
      console.log(`📅 Resetting monthly counter for @${user.username} (was ${user.assignments_this_month})`);
      user.assignments_this_month = 0;
      user.period_start = new Date().toISOString();
      user.period_end = getNextMonthDate().toISOString();
      saveUsers(users);
    }
  }

  return user;
}

function getNextMonthDate() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

// ---------- Quota Checking ----------

export function checkQuota(twitterUserId, username, testMode = true) {
  const user = getUser(twitterUserId, username);
  const tierConfig = TIERS[user.tier] || TIERS.free;
  const limit = tierConfig.limit;
  const used = user.assignments_this_month;
  const remaining = Math.max(0, limit - used);
  const allowed = remaining > 0;

  const result = {
    allowed: testMode ? true : allowed, // In test mode, always allow
    user,
    tier: user.tier,
    tierConfig,
    limit,
    used,
    remaining,
    percentage: Math.round((used / limit) * 100),
    isNewUser: user.assignments_lifetime === 0,
    testMode
  };

  // Log quota check
  if (testMode && !allowed) {
    console.log(`⚠️ [TEST MODE] User @${username} would be blocked (${used}/${limit} used)`);
  }

  return result;
}

// ---------- Usage Tracking ----------

export function incrementUsage(twitterUserId, undername) {
  const users = loadUsers();
  const user = users.users[twitterUserId];

  if (!user) {
    console.error(`❌ Cannot increment usage for unknown user: ${twitterUserId}`);
    return null;
  }

  user.assignments_this_month += 1;
  user.assignments_lifetime += 1;
  user.last_assignment = {
    undername,
    timestamp: new Date().toISOString()
  };

  saveUsers(users);

  const tierConfig = TIERS[user.tier] || TIERS.free;
  const remaining = Math.max(0, tierConfig.limit - user.assignments_this_month);

  console.log(`📊 Usage tracked for @${user.username}: ${user.assignments_this_month}/${tierConfig.limit} this month (${remaining} remaining)`);

  return {
    used: user.assignments_this_month,
    remaining,
    limit: tierConfig.limit,
    lifetime: user.assignments_lifetime
  };
}

// ---------- Tier Management ----------

export function upgradeTier(twitterUserId, newTier, paymentTxId = null) {
  const users = loadUsers();
  const user = users.users[twitterUserId];

  if (!user) {
    console.error(`❌ Cannot upgrade unknown user: ${twitterUserId}`);
    return false;
  }

  if (!TIERS[newTier]) {
    console.error(`❌ Invalid tier: ${newTier}`);
    return false;
  }

  const oldTier = user.tier;
  user.tier = newTier;
  user.subscription.status = 'active';
  user.subscription.payment_tx_id = paymentTxId;
  user.subscription.expires_at = getNextMonthDate().toISOString();

  saveUsers(users);

  console.log(`🎉 Upgraded @${user.username} from ${oldTier} to ${newTier}`);

  return true;
}

// ---------- Usage Stats ----------

export function getUserStats(twitterUserId) {
  const user = loadUsers().users[twitterUserId];
  if (!user) return null;

  const tierConfig = TIERS[user.tier] || TIERS.free;

  return {
    username: user.username,
    tier: user.tier,
    tierName: tierConfig.name,
    limit: tierConfig.limit,
    used: user.assignments_this_month,
    remaining: Math.max(0, tierConfig.limit - user.assignments_this_month),
    lifetime: user.assignments_lifetime,
    periodEnd: user.period_end,
    subscription: user.subscription
  };
}

// ---------- Quota Messages ----------

export function getQuotaMessage(twitterUserId) {
  const user = loadUsers().users[twitterUserId];
  if (!user) return null;

  const tierConfig = TIERS[user.tier] || TIERS.free;
  const used = user.assignments_this_month;
  const remaining = Math.max(0, tierConfig.limit - used);
  const limit = tierConfig.limit;

  // Only show messages for free tier users
  if (user.tier !== 'free') {
    return null;
  }

  // Different messages based on usage
  if (remaining === 0) {
    return `\n\n🔔 You've used all ${limit} free assignments this month! Upgrade to Pro for 100/month.`;
  } else if (remaining === 1) {
    return `\n\n📊 Usage: ${used}/${limit} this month. You have 1 assignment remaining.`;
  } else if (remaining <= 2) {
    return `\n\n📊 Usage: ${used}/${limit} this month. ${remaining} assignments remaining.`;
  } else if (used === 1) {
    return `\n\n💡 FYI: You have ${limit} free assignments per month. Check usage anytime with @NeedsArNS usage`;
  }

  // Don't show message if they have plenty left
  return null;
}

// ---------- Admin Functions ----------

export function getAllUsers() {
  return loadUsers().users;
}

export function getUserCount() {
  return Object.keys(loadUsers().users).length;
}

export function getTierCounts() {
  const users = Object.values(loadUsers().users);
  return {
    free: users.filter(u => u.tier === 'free').length,
    pro: users.filter(u => u.tier === 'pro').length,
    enterprise: users.filter(u => u.tier === 'enterprise').length,
    total: users.length
  };
}
