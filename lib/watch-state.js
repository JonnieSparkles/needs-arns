// Watch mode state persistence

import fs from 'fs';
import path from 'path';

// Data directory (respects Railway volume mount)
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || '.';

/**
 * Get the default state file path
 * @returns {string} Path to watch-state.json
 */
export function getDefaultStatePath() {
  return path.join(DATA_DIR, 'watch-state.json');
}

/**
 * Create an empty state object
 * @returns {Object} Empty state structure
 */
function createEmptyState() {
  return {
    version: '1.0',
    lastUpdated: new Date().toISOString(),
    accounts: {}
  };
}

/**
 * Create an empty account state object
 * @returns {Object} Empty account state structure
 */
function createEmptyAccountState() {
  return {
    lastProcessedTweetId: null,
    lastCheckedAt: null,
    totalArchived: 0,
    lastError: null
  };
}

/**
 * Load watch state from JSON file
 * @param {string} statePath - Path to watch-state.json (optional, uses default if not provided)
 * @returns {Object} State object
 */
export function loadWatchState(statePath) {
  const resolvedPath = path.resolve(statePath || getDefaultStatePath());

  if (!fs.existsSync(resolvedPath)) {
    console.log('📋 No existing watch state found, starting fresh');
    return createEmptyState();
  }

  try {
    const stateData = fs.readFileSync(resolvedPath, 'utf8');
    const state = JSON.parse(stateData);

    // Validate basic structure
    if (!state.accounts || typeof state.accounts !== 'object') {
      console.warn('⚠️ Invalid watch state structure, starting fresh');
      return createEmptyState();
    }

    const accountCount = Object.keys(state.accounts).length;
    console.log(`📋 Loaded watch state: ${accountCount} account(s) tracked`);

    return state;
  } catch (error) {
    console.error(`❌ Error loading watch state: ${error.message}`);
    console.log('📋 Starting with fresh state');
    return createEmptyState();
  }
}

/**
 * Save watch state to JSON file
 * @param {Object} state - State object to save
 * @param {string} statePath - Path to watch-state.json (optional, uses default if not provided)
 */
export function saveWatchState(state, statePath) {
  const resolvedPath = path.resolve(statePath || getDefaultStatePath());

  try {
    // Update timestamp
    state.lastUpdated = new Date().toISOString();

    // Ensure directory exists
    const dir = path.dirname(resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Write atomically (write to temp file, then rename)
    const tempPath = `${resolvedPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2));
    fs.renameSync(tempPath, resolvedPath);

    console.log(`💾 Watch state saved`);
  } catch (error) {
    console.error(`❌ Error saving watch state: ${error.message}`);
    throw error;
  }
}

/**
 * Get state for a specific account
 * @param {Object} state - Full state object
 * @param {string} twitterUsername - Twitter username (without @)
 * @returns {Object} Account state (creates empty one if not exists)
 */
export function getAccountState(state, twitterUsername) {
  const username = twitterUsername.toLowerCase().replace(/^@/, '');

  if (!state.accounts[username]) {
    state.accounts[username] = createEmptyAccountState();
  }

  return state.accounts[username];
}

/**
 * Update state for a specific account
 * @param {Object} state - Full state object (modified in place)
 * @param {string} twitterUsername - Twitter username (without @)
 * @param {Object} updates - Fields to update
 * @returns {Object} Updated account state
 */
export function updateAccountState(state, twitterUsername, updates) {
  const username = twitterUsername.toLowerCase().replace(/^@/, '');

  if (!state.accounts[username]) {
    state.accounts[username] = createEmptyAccountState();
  }

  // Merge updates
  Object.assign(state.accounts[username], updates);

  return state.accounts[username];
}

/**
 * Increment the archived count for an account
 * @param {Object} state - Full state object (modified in place)
 * @param {string} twitterUsername - Twitter username (without @)
 * @returns {number} New total archived count
 */
export function incrementArchivedCount(state, twitterUsername) {
  const accountState = getAccountState(state, twitterUsername);
  accountState.totalArchived += 1;
  return accountState.totalArchived;
}

/**
 * Record an error for an account
 * @param {Object} state - Full state object (modified in place)
 * @param {string} twitterUsername - Twitter username (without @)
 * @param {string} errorMessage - Error message to record
 */
export function recordAccountError(state, twitterUsername, errorMessage) {
  updateAccountState(state, twitterUsername, {
    lastError: errorMessage,
    lastCheckedAt: new Date().toISOString()
  });
}

/**
 * Clear error for an account (call after successful processing)
 * @param {Object} state - Full state object (modified in place)
 * @param {string} twitterUsername - Twitter username (without @)
 */
export function clearAccountError(state, twitterUsername) {
  updateAccountState(state, twitterUsername, {
    lastError: null
  });
}

/**
 * Get summary of all account states
 * @param {Object} state - Full state object
 * @returns {Object} Summary with counts
 */
export function getStateSummary(state) {
  const accounts = Object.entries(state.accounts);
  const totalArchived = accounts.reduce((sum, [_, s]) => sum + (s.totalArchived || 0), 0);
  const accountsWithErrors = accounts.filter(([_, s]) => s.lastError !== null).length;

  return {
    totalAccounts: accounts.length,
    totalArchived,
    accountsWithErrors,
    lastUpdated: state.lastUpdated
  };
}
