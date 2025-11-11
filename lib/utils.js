// Shared utilities for both bot and manual scripts
import fs from 'fs';
import path from 'path';

// ---------- environment ----------
export function requireEnv(name) {
  const v = process.env[name];
  if (!v || !String(v).trim()) throw new Error(`Missing env: ${name}`);
  return v;
}

// ---------- wallet ----------
export function getJwkFromEnv() {
  if (process.env.ARWEAVE_WALLET_PATH) {
    const walletPath = process.env.ARWEAVE_WALLET_PATH;
    try {
      const walletData = fs.readFileSync(walletPath, 'utf8');
      return JSON.parse(walletData);
    } catch (error) {
      throw new Error(`Failed to read wallet file at ${walletPath}: ${error.message}`);
    }
  }
  if (process.env.ARWEAVE_JWK_JSON) {
    return JSON.parse(process.env.ARWEAVE_JWK_JSON);
  }
  throw new Error('Provide ARWEAVE_WALLET_PATH or ARWEAVE_JWK_JSON');
}

// ---------- validation ----------
export function isValidUndername(undername) {
  // 1. Valid characters: 0-9, a-z, dashes, underscores (lowercase only)
  if (!/^[a-z0-9_-]+$/.test(undername)) {
    return false;
  }
  
  // 2. Dashes and underscores cannot be leading or trailing
  if (undername.startsWith('-') || undername.startsWith('_') || 
      undername.endsWith('-') || undername.endsWith('_')) {
    return false;
  }
  
  // 3. Dashes and underscores cannot be used in single character domains
  if (undername.length === 1 && (undername.includes('-') || undername.includes('_'))) {
    return false;
  }
  
  // 4. 1 character minimum, 51 characters maximum
  if (undername.length < 1 || undername.length > 51) {
    return false;
  }
  
  return true;
}

// ---------- error handling ----------
export function isInfrastructureErrorType(err) {
  const errorMessage = (err?.message || '').toLowerCase();
  const errorCode = err?.code ?? err?.status ?? err?.statusCode;

  // HTTP 429 / rate limit
  if (errorCode === 429) return true;
  if (errorMessage.includes('rate limit') || errorMessage.includes('too many requests')) {
    return true;
  }

  // Messages that begin with an HTTP 5xx status (e.g., "500: {...}")
  if (/^\s*5\d{2}\s*:/.test(err?.message || '')) {
    return true;
  }

  // Network/connectivity issues
  if (errorMessage.includes('timeout') || 
      errorMessage.includes('network') || 
      errorMessage.includes('connection') ||
      errorMessage.includes('econnreset') ||
      errorMessage.includes('enotfound') ||
      errorMessage.includes('econnrefused')) {
    return true;
  }
  
  // API service issues
  if (errorMessage.includes('service unavailable') ||
      errorMessage.includes('internal server error') ||
      errorMessage.includes('bad gateway') ||
      errorMessage.includes('gateway timeout') ||
      (typeof errorCode === 'number' && errorCode >= 500)) {
    return true;
  }
  
  // Arweave/Turbo specific infrastructure issues
  if (errorMessage.includes('turbo') && 
      (errorMessage.includes('unavailable') || errorMessage.includes('timeout'))) {
    return true;
  }
  
  // File system issues (state file problems)
  if (errorMessage.includes('eacces') ||
      errorMessage.includes('enoent') ||
      errorMessage.includes('emfile') ||
      errorMessage.includes('enospc')) {
    return true;
  }
  
  // Memory/resource issues
  if (errorMessage.includes('out of memory') ||
      errorMessage.includes('max file size') ||
      errorMessage.includes('too many open files')) {
    return true;
  }
  
  // Default to user error if we can't categorize it
  return false;
}

// ---------- arweave ----------
export async function verifyTxIdExists(txid) {
  try {
    const res = await fetch(`https://arweave.net/${txid}`, { method: 'HEAD' });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------- content type detection ----------
export function guessContentType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.json') return 'application/json';
  return 'application/octet-stream';
}

// ---------- tweet parsing ----------
export function parseTweetId(input) {
  if (!input) return null;
  const m = String(input).match(/status\/(\d+)/);
  if (m) return m[1];
  if (/^\d+$/.test(String(input))) return String(input);
  return null;
}

export function extractUsernameFromUrl(url) {
  const match = String(url).match(/x\.com\/([^\/]+)\/status/);
  return match ? match[1] : null;
}

// ---------- regex patterns ----------
export const ARWEAVE_TXID_RE = /https?:\/\/[^\s\/]+\/([A-Za-z0-9_-]{43})(?:\b|\/|\?|#)|\bar:\/\/([A-Za-z0-9_-]{43})\b/;
// Note: This regex is kept for backward compatibility but extractCommandFromMention uses a stricter pattern
export const ASSIGN_CMD_RE = /\b(assign|archive|name\s+this)\s+([a-z0-9_-]{1,63})\b/i;
