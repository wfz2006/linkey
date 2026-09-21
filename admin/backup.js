import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT_DIR, loadConfig } from './config.js';
import { writeLog } from './logger.js';

export const BACKUPS_DIR = process.env.ADMIN_BACKUPS_DIR || path.join(ROOT_DIR, 'backups');
// 数据库路径：默认 <root>/qq_chat.db；测试可通过 ADMIN_DB_PATH 环境变量隔离，
// 避免 admin 测试套件读写生产数据库（曾发生测试改写真实用户资料的故障）。
export const DB_PATH = process.env.ADMIN_DB_PATH || path.join(ROOT_DIR, 'qq_chat.db');

if (!fs.existsSync(BACKUPS_DIR)) {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

let lastBackupDate = null;

function formatBackupTimestamp(d = new Date()) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  return `${year}${month}${day}_${hours}${minutes}${seconds}`;
}

export function validateBackupFileName(fileName) {
  if (!fileName || typeof fileName !== 'string') return null;
  const base = path.basename(fileName);
  if (!/^[A-Za-z0-9._-]+\.db$/.test(base)) return null;

  const resolved = path.resolve(BACKUPS_DIR, base);
  if (!resolved.startsWith(path.resolve(BACKUPS_DIR))) return null;
  if (!fs.existsSync(resolved)) return null;

  return resolved;
}

export function checkDiskSpace() {
  try {
    if (typeof fs.statfsSync === 'function') {
      const stats = fs.statfsSync(BACKUPS_DIR);
      const freeBytes = stats.bavail * stats.bsize;
      return { ok: freeBytes >= 1024 * 1024 * 1024, freeBytes }; // 1GB threshold
    }
  } catch (err) {
    // If statfs is not supported on some platforms
  }
  return { ok: true, freeBytes: null };
}

export function createBackup() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error('主数据库文件不存在，无法执行备份');
  }

  // Check disk space
  const disk = checkDiskSpace();
  if (!disk.ok) {
    const msg = '磁盘剩余可用空间不足 1GB，已跳过本次数据库备份';
    writeLog('admin-err', msg, true);
    throw new Error(msg);
  }

  const timestamp = formatBackupTimestamp();
  const fileName = `qq_chat_${timestamp}.db`;
  const backupPath = path.join(BACKUPS_DIR, fileName);

  try {
    // Online Hot Backup via VACUUM INTO
    const srcDb = new DatabaseSync(DB_PATH);
    srcDb.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    srcDb.close();

    // Verify Integrity
    let integrityOk = false;
    try {
      const backupDb = new DatabaseSync(backupPath, { readOnly: true });
      const check = backupDb.prepare('PRAGMA integrity_check').get();
      backupDb.close();
      integrityOk = check && (check.integrity_check === 'ok' || Object.values(check)[0] === 'ok');
    } catch (err) {
      writeLog('admin-err', `备份完整性校验异常: ${err.message}`, true);
    }

    const stat = fs.statSync(backupPath);
    writeLog('admin', `✅ 数据库备份成功: ${fileName} (${(stat.size / 1024).toFixed(1)} KB, 完整性=${integrityOk ? 'OK' : 'FAIL'})`);

    // Rotate and clean old backups
    cleanupOldBackups();

    return {
      fileName,
      path: backupPath,
      size: stat.size,
      mtime: stat.mtimeMs,
      integrityOk
    };
  } catch (err) {
    writeLog('admin-err', `❌ 数据库备份失败: ${err.message}`, true);
    throw err;
  }
}

export function listBackups() {
  if (!fs.existsSync(BACKUPS_DIR)) return [];

  const files = fs.readdirSync(BACKUPS_DIR)
    .filter(f => f.endsWith('.db'))
    .map(f => {
      const fullPath = path.join(BACKUPS_DIR, f);
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

export function deleteBackup(fileName) {
  const filePath = validateBackupFileName(fileName);
  if (!filePath) {
    throw new Error('无效或不存在的备份文件');
  }

  fs.unlinkSync(filePath);
  writeLog('admin', `🗑️ 已删除备份文件: ${path.basename(filePath)}`);
  return true;
}

export function cleanupOldBackups(keepCount = null) {
  const keep = keepCount || loadConfig().backupKeep || 14;
  const backups = listBackups();

  if (backups.length <= keep) return 0;

  const toDelete = backups.slice(keep);
  for (const b of toDelete) {
    const p = path.join(BACKUPS_DIR, b.name);
    try {
      fs.unlinkSync(p);
      writeLog('admin', `轮转清理旧备份: ${b.name}`);
    } catch {}
  }

  return toDelete.length;
}

export function getNextBackupTime() {
  const cfg = loadConfig();
  const targetHour = cfg.backupHour ?? 3;
  const now = new Date();

  const next = new Date(now);
  next.setHours(targetHour, 0, 0, 0);

  if (now.getHours() >= targetHour) {
    next.setDate(next.getDate() + 1);
  }

  return next.getTime();
}

let schedulerTimer = null;

export function startBackupScheduler() {
  if (schedulerTimer) clearInterval(schedulerTimer);

  // Check once every minute
  schedulerTimer = setInterval(() => {
    const cfg = loadConfig();
    const targetHour = cfg.backupHour ?? 3;
    const now = new Date();
    const todayStr = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

    if (now.getHours() === targetHour && lastBackupDate !== todayStr) {
      lastBackupDate = todayStr;
      try {
        createBackup();
      } catch (err) {
        console.error('[ADMIN BACKUP] Auto-backup failed:', err.message);
      }
    }
  }, 60000);
  if (schedulerTimer && typeof schedulerTimer.unref === 'function') {
    schedulerTimer.unref();
  }
}
