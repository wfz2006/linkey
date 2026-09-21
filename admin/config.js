import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT_DIR = path.resolve(__dirname, '..');

export function getConfigFile() {
  return process.env.ADMIN_CONFIG_PATH || path.join(ROOT_DIR, 'admin-config.json');
}

export const CONFIG_FILE = getConfigFile();

const DEFAULT_CONFIG = {
  adminPort: 3001,
  appPort: 3000,
  bindHost: '127.0.0.1', // 运维面板默认只监听本机；如需局域网访问改为 '0.0.0.0'
  logKeepDays: 14,
  backupHour: 3,
  backupKeep: 14,
  passwordHash: null,
  sessionSecret: null
};

let cachedConfig = null;

export function resetCachedConfig() {
  cachedConfig = null;
}

export function loadConfig() {
  if (cachedConfig && cachedConfig.sessionSecret) return cachedConfig;

  const targetFile = getConfigFile();
  let config = { ...DEFAULT_CONFIG };
  if (fs.existsSync(targetFile)) {
    try {
      const content = fs.readFileSync(targetFile, 'utf8');
      const parsed = JSON.parse(content);
      config = { ...DEFAULT_CONFIG, ...parsed };
    } catch (err) {
      console.warn('[ADMIN CONFIG] Error reading config file, using defaults:', err.message);
    }
  }

  // Ensure sessionSecret is always generated and saved
  if (!config.sessionSecret) {
    config.sessionSecret = crypto.randomBytes(32).toString('hex');
  }

  cachedConfig = config;
  try {
    fs.writeFileSync(targetFile, JSON.stringify(cachedConfig, null, 2), 'utf8');
  } catch {}

  return cachedConfig;
}

export function saveConfig(updates = {}) {
  const current = loadConfig();
  const merged = { ...current, ...updates };

  if (!merged.sessionSecret) {
    merged.sessionSecret = crypto.randomBytes(32).toString('hex');
  }

  const targetFile = getConfigFile();
  try {
    fs.writeFileSync(targetFile, JSON.stringify(merged, null, 2), 'utf8');
    cachedConfig = merged;
    return cachedConfig;
  } catch (err) {
    console.error('[ADMIN CONFIG] Failed to save config:', err.message);
    throw err;
  }
}

export function isInitialized() {
  const cfg = loadConfig();
  return !!cfg.passwordHash;
}
