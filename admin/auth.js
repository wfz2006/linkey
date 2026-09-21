import crypto from 'node:crypto';
import { loadConfig, saveConfig } from './config.js';

// In-memory active session tracking: jti -> exp
const activeSessions = new Map();

// In-memory brute force tracker: clientKey -> { count, lockedUntil }
const failedAttempts = new Map();

// Periodic cleanup of expired sessions and locks
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [jti, exp] of activeSessions.entries()) {
    if (exp <= now) activeSessions.delete(jti);
  }
  for (const [key, record] of failedAttempts.entries()) {
    if (record.lockedUntil && record.lockedUntil <= now) failedAttempts.delete(key);
  }
}, 60000);
if (cleanupInterval && typeof cleanupInterval.unref === 'function') {
  cleanupInterval.unref();
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const [salt, hash] = storedHash.split(':');
  if (!salt || !hash) return false;

  try {
    const derived = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    if (derived.length !== expected.length) return false;
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// Brute force policy: 5 failed attempts -> lock 15 minutes
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;
const FAILED_WINDOW_MS = 15 * 60 * 1000;

export function checkRateLimit(clientKey) {
  const record = failedAttempts.get(clientKey);
  if (!record) return { allowed: true, remainingAttempts: MAX_FAILED_ATTEMPTS };
  if (record.lockedUntil && record.lockedUntil > Date.now()) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((record.lockedUntil - Date.now()) / 1000),
      remainingAttempts: 0
    };
  }
  return { allowed: true, remainingAttempts: Math.max(0, MAX_FAILED_ATTEMPTS - record.count) };
}

export function recordFailedAttempt(clientKey) {
  const now = Date.now();
  const record = failedAttempts.get(clientKey);
  if (!record || (record.windowStart && now - record.windowStart > FAILED_WINDOW_MS)) {
    const next = { count: 1, windowStart: now, lockedUntil: null };
    failedAttempts.set(clientKey, next);
    return { count: next.count, lockedUntil: null };
  }
  record.count += 1;
  if (record.count >= MAX_FAILED_ATTEMPTS) {
    record.lockedUntil = now + LOCK_DURATION_MS;
  }
  return { count: record.count, lockedUntil: record.lockedUntil };
}

export function clearFailedAttempts(clientKey) {
  failedAttempts.delete(clientKey);
}

export function createSessionToken() {
  const config = loadConfig();
  const jti = crypto.randomBytes(16).toString('hex');
  const exp = Date.now() + 12 * 3600 * 1000; // 12h admin session
  const payload = { jti, exp };

  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = crypto.createHmac('sha256', config.sessionSecret);
  hmac.update(payloadB64);
  const sig = hmac.digest('base64url');

  activeSessions.set(jti, exp);
  return {
    token: `${payloadB64}.${sig}`,
    expiresIn: 12 * 3600
  };
}

export function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadB64, sig] = parts;
  const config = loadConfig();

  try {
    const hmac = crypto.createHmac('sha256', config.sessionSecret);
    hmac.update(payloadB64);
    const expectedSig = hmac.digest('base64url');

    const sigBuf = Buffer.from(sig, 'utf8');
    const expSigBuf = Buffer.from(expectedSig, 'utf8');
    if (sigBuf.length !== expSigBuf.length) {
      return null;
    }

    if (!crypto.timingSafeEqual(sigBuf, expSigBuf)) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    if (!payload || !payload.jti || !payload.exp) return null;
    if (payload.exp <= Date.now()) return null;

    if (!activeSessions.has(payload.jti)) return null;

    return payload;
  } catch {
    return null;
  }
}

export function revokeAllSessions() {
  activeSessions.clear();
}

export function setAdminPassword(newPassword) {
  if (!newPassword || newPassword.length < 4) {
    throw new Error('密码长度不能少于 4 位');
  }
  const passwordHash = hashPassword(newPassword);
  saveConfig({ passwordHash });
  revokeAllSessions();
  return true;
}
