import fs from 'node:fs';
import path from 'node:path';
import { ROOT_DIR, loadConfig } from './config.js';

// 日志目录：默认 <root>/logs；测试可通过 ADMIN_LOG_DIR 环境变量隔离，避免污染生产日志。
// 必须在调用时动态解析：ESM import 先于测试模块体执行，导入期固化会绕过测试隔离。
export function getLogsDir() {
  return process.env.ADMIN_LOG_DIR || path.join(ROOT_DIR, 'logs');
}

// 兼容旧引用（模块导入时的默认目录）
export const LOGS_DIR = path.join(ROOT_DIR, 'logs');

function ensureLogsDir() {
  const dir = getLogsDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// Active streams cache by key: { app: { date, stream }, admin: { date, stream } }
const streams = {
  app: null,
  admin: null
};

function getLocalDateString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getLocalTimeString() {
  const d = new Date();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hours}:${minutes}:${seconds}.${ms}`;
}

function getLogFilePath(category) {
  const today = getLocalDateString();
  const targetCategory = category.startsWith('app') ? 'app' : 'admin';
  return path.join(ensureLogsDir(), `${targetCategory}-${today}.log`);
}

export function writeLog(category, data, isError = false) {
  const logFile = getLogFilePath(category);
  const text = typeof data === 'string' ? data : data.toString('utf8');
  const lines = text.split(/\r?\n/);
  const time = getLocalTimeString();
  const errPrefix = isError || category.includes('err') ? '[ERR] ' : '';

  let buffer = '';
  for (const line of lines) {
    if (!line && lines.length > 1 && line === lines[lines.length - 1]) continue;
    buffer += `[${time}] ${errPrefix}${line}\n`;
  }

  if (buffer) {
    try {
      fs.appendFileSync(logFile, buffer, 'utf8');
    } catch {}
  }
}

export function validateLogFileName(fileName) {
  if (!fileName || typeof fileName !== 'string') return null;
  const base = path.basename(fileName);
  if (!/^[A-Za-z0-9._-]+\.log$/.test(base)) return null;

  const dir = getLogsDir();
  const resolved = path.resolve(dir, base);
  if (!resolved.startsWith(path.resolve(dir))) return null;
  if (!fs.existsSync(resolved)) return null;

  return resolved;
}

export function listLogFiles() {
  const dir = getLogsDir();
  if (!fs.existsSync(dir)) return [];

  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.log'))
    .map(f => {
      const fullPath = path.join(dir, f);
      const stat = fs.statSync(fullPath);
      return {
        name: f,
        size: stat.size,
        mtime: stat.mtimeMs
      };
    })
    .sort((a, b) => b.mtime - a.mtime);

  return files;
}

export function readLogTail(fileName, maxLines = 200) {
  const filePath = validateLogFileName(fileName);
  if (!filePath) {
    throw new Error('无效或不存在的日志文件');
  }

  const stat = fs.statSync(filePath);
  const bufferSize = Math.min(stat.size, maxLines * 1024); // read last chunk
  const buffer = Buffer.alloc(bufferSize);

  const fd = fs.openSync(filePath, 'r');
  fs.readSync(fd, buffer, 0, bufferSize, Math.max(0, stat.size - bufferSize));
  fs.closeSync(fd);

  const content = buffer.toString('utf8');
  const allLines = content.split(/\r?\n/).filter(l => l.length > 0);
  const tailLines = allLines.slice(-maxLines);

  return {
    file: path.basename(filePath),
    totalLines: allLines.length,
    lines: tailLines
  };
}

export function cleanupOldLogs(keepDays = null) {
  const days = keepDays || loadConfig().logKeepDays || 14;
  const now = Date.now();
  const maxAgeMs = days * 24 * 3600 * 1000;
  const dir = getLogsDir();

  if (!fs.existsSync(dir)) return 0;

  let deletedCount = 0;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.log'));
  for (const f of files) {
    const fullPath = path.join(dir, f);
    try {
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(fullPath);
        deletedCount++;
      }
    } catch {}
  }

  return deletedCount;
}

// Scheduled cleanup check every 6 hours
const loggerCleanupInterval = setInterval(() => {
  cleanupOldLogs();
}, 6 * 3600 * 1000);
if (loggerCleanupInterval && typeof loggerCleanupInterval.unref === 'function') {
  loggerCleanupInterval.unref();
}
