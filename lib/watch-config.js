// Watch mode configuration loading and validation

import fs from 'fs';
import path from 'path';
import { FILTERING_DEFAULTS, TIER_PRESETS } from './watch-filter.js';

// Default configuration values
const DEFAULTS = {
  pollIntervalMinutes: 30,
  enabled: true,
  replyToPost: true
};

/**
 * Load watch configuration from JSON file
 * @param {string} configPath - Path to watch-config.json
 * @returns {Object} Validated configuration object
 */
export function loadWatchConfig(configPath) {
  const resolvedPath = path.resolve(configPath);

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Watch config file not found: ${resolvedPath}`);
  }

  try {
    const configData = fs.readFileSync(resolvedPath, 'utf8');
    const config = JSON.parse(configData);

    // Validate and apply defaults
    const validatedConfig = validateWatchConfig(config);

    console.log(`📋 Loaded watch config: ${validatedConfig.accounts.length} account(s) configured`);

    return validatedConfig;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in watch config file: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Validate watch configuration and apply defaults
 * @param {Object} config - Raw configuration object
 * @returns {Object} Validated configuration with defaults applied
 */
export function validateWatchConfig(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('Watch config must be an object');
  }

  // Validate version
  if (config.version && config.version !== '1.0') {
    console.warn(`⚠️ Unknown watch config version: ${config.version}, expected 1.0`);
  }

  // Validate and apply pollIntervalMinutes default
  const pollIntervalMinutes = config.pollIntervalMinutes ?? DEFAULTS.pollIntervalMinutes;
  if (typeof pollIntervalMinutes !== 'number' || pollIntervalMinutes < 1) {
    throw new Error('pollIntervalMinutes must be a positive number');
  }

  // Validate accounts array
  if (!Array.isArray(config.accounts)) {
    throw new Error('Watch config must have an "accounts" array');
  }

  if (config.accounts.length === 0) {
    console.warn('⚠️ No accounts configured in watch config');
  }

  // Validate each account
  const validatedAccounts = config.accounts.map((account, index) => {
    return validateAccount(account, index);
  });

  return {
    version: config.version || '1.0',
    pollIntervalMinutes,
    accounts: validatedAccounts
  };
}

/**
 * Validate a single account configuration
 * @param {Object} account - Account configuration object
 * @param {number} index - Account index for error messages
 * @returns {Object} Validated account with defaults applied
 */
function validateAccount(account, index) {
  const prefix = `Account[${index}]`;

  if (!account || typeof account !== 'object') {
    throw new Error(`${prefix}: must be an object`);
  }

  // Required fields
  if (!account.twitterUsername || typeof account.twitterUsername !== 'string') {
    throw new Error(`${prefix}: twitterUsername is required and must be a string`);
  }

  if (!account.twitterUserId || typeof account.twitterUserId !== 'string') {
    throw new Error(`${prefix}: twitterUserId is required and must be a string`);
  }

  if (!account.arnsName || typeof account.arnsName !== 'string') {
    throw new Error(`${prefix}: arnsName is required and must be a string`);
  }

  if (!account.antProcessId || typeof account.antProcessId !== 'string') {
    throw new Error(`${prefix}: antProcessId is required and must be a string`);
  }

  // Validate arnsName format (similar to undername validation)
  if (!/^[a-z0-9_-]+$/i.test(account.arnsName)) {
    throw new Error(`${prefix}: arnsName contains invalid characters (use a-z, 0-9, -, _)`);
  }

  // Validate and apply filtering config
  const filtering = validateFilteringConfig(account.filtering, index);

  // Apply defaults for optional fields
  return {
    twitterUsername: account.twitterUsername.toLowerCase().replace(/^@/, ''),
    twitterUserId: account.twitterUserId,
    arnsName: account.arnsName.toLowerCase(),
    antProcessId: account.antProcessId,
    enabled: account.enabled ?? DEFAULTS.enabled,
    replyToPost: account.replyToPost ?? DEFAULTS.replyToPost,
    filtering
  };
}

/**
 * Validate filtering configuration for an account
 * @param {Object} filtering - Filtering configuration object
 * @param {number} accountIndex - Account index for error messages
 * @returns {Object} Validated filtering config with defaults applied
 */
function validateFilteringConfig(filtering, accountIndex) {
  const prefix = `Account[${accountIndex}].filtering`;

  // If filtering is not specified or explicitly disabled, return defaults
  if (!filtering || filtering.enabled === false) {
    return { ...FILTERING_DEFAULTS };
  }

  // Validate tier if specified
  if (filtering.tier && !TIER_PRESETS[filtering.tier]) {
    const validTiers = Object.keys(TIER_PRESETS).join(', ');
    throw new Error(`${prefix}.tier: invalid tier "${filtering.tier}". Valid tiers: ${validTiers}`);
  }

  // Get base thresholds from tier preset or defaults
  const tierThresholds = filtering.tier ? TIER_PRESETS[filtering.tier] : FILTERING_DEFAULTS.thresholds;

  // Merge custom thresholds with tier preset (custom overrides preset)
  const thresholds = {
    ...tierThresholds,
    ...filtering.thresholds
  };

  // Validate threshold values
  for (const [key, value] of Object.entries(thresholds)) {
    if (typeof value !== 'number' || value < 0) {
      throw new Error(`${prefix}.thresholds.${key}: must be a non-negative number`);
    }
  }

  // Validate pendingMaxAgeHours
  const pendingMaxAgeHours = filtering.pendingMaxAgeHours ?? FILTERING_DEFAULTS.pendingMaxAgeHours;
  if (typeof pendingMaxAgeHours !== 'number' || pendingMaxAgeHours < 1) {
    throw new Error(`${prefix}.pendingMaxAgeHours: must be a positive number (hours)`);
  }

  return {
    enabled: filtering.enabled ?? true, // If filtering object exists, default to enabled
    tier: filtering.tier || 'none',
    thresholds,
    alwaysArchiveMedia: filtering.alwaysArchiveMedia ?? FILTERING_DEFAULTS.alwaysArchiveMedia,
    archiveSelfReplies: filtering.archiveSelfReplies ?? FILTERING_DEFAULTS.archiveSelfReplies,
    pendingMaxAgeHours
  };
}

/**
 * Get list of enabled accounts from config
 * @param {Object} config - Validated configuration object
 * @returns {Array} Array of enabled account configurations
 */
export function getEnabledAccounts(config) {
  return config.accounts.filter(account => account.enabled);
}

/**
 * Get a specific account by username
 * @param {Object} config - Validated configuration object
 * @param {string} username - Twitter username to find
 * @returns {Object|null} Account configuration or null if not found
 */
export function getAccountByUsername(config, username) {
  const normalizedUsername = username.toLowerCase().replace(/^@/, '');
  return config.accounts.find(a => a.twitterUsername === normalizedUsername) || null;
}

/**
 * Get a specific account by ArNS name
 * @param {Object} config - Validated configuration object
 * @param {string} arnsName - ArNS name to find
 * @returns {Object|null} Account configuration or null if not found
 */
export function getAccountByArnsName(config, arnsName) {
  const normalizedName = arnsName.toLowerCase();
  return config.accounts.find(a => a.arnsName === normalizedName) || null;
}
