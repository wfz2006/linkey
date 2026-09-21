import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import { ROOT_DIR, loadConfig, saveConfig, isInitialized } from './config.js';
import { verifyPassword, checkRateLimit, recordFailedAttempt, clearFailedAttempts, createSessionToken, verifySessionToken, setAdminPassword, revokeAllSessions } from './auth.js';
import { writeLog, listLogFiles, readLogTail, validateLogFileName } from './logger.js';
import { createBackup, listBackups, deleteBackup, validateBackupFileName, startBackupScheduler, getNextBackupTime, DB_PATH } from './backup.js';
import { healthChecker } from './health.js';
import { processManager } from './processManager.js';
import { startTunnel, stopTunnel, getTunnelStatus } from './tunnelManager.js';
import { exportFullMigration, getMigrationStatus } from './migration.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = process.env.ADMIN_UPLOADS_DIR || path.join(ROOT_DIR, 'uploads');
const ADMIN_STARTED_AT = Date.now();

// 确保 uploads 目录存在
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

function hashUserPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return `${salt}:${derivedKey.toString('hex')}`;
}

process.on('uncaughtException', (err) => {
  if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
    writeLog('admin-err', `未捕获异常: ${err.message}\n${err.stack}`, true);
  }
});

process.on('unhandledRejection', (reason) => {
  writeLog('admin-err', `未处理 Promise 拒绝: ${reason}`, true);
});

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.zip': 'application/zip'
};

function resolveUploadFile(fileName) {
  if (!fileName || typeof fileName !== 'string') {
    return { error: '未指定文件名' };
  }

  const safeName = path.basename(fileName);
  if (safeName !== fileName || safeName === '.' || safeName === '..') {
    return { error: '无效文件名' };
  }

  const uploadsRoot = path.resolve(UPLOADS_DIR);
  const fullPath = path.resolve(uploadsRoot, safeName);
  const prefix = uploadsRoot.endsWith(path.sep) ? uploadsRoot : uploadsRoot + path.sep;
  if (!fullPath.startsWith(prefix)) {
    return { error: '无效文件路径' };
  }

  return { safeName, fullPath };
}

function applyCors(req, res) {
  // CORS 收紧：仅允许本机回环来源的面板跨域调用，其余一律不携带跨域头
  const origin = req.headers['origin'];
  if (origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  if (body === undefined) {
    throw new TypeError('响应数据无法序列化为 JSON');
  }
  const contentLength = Buffer.byteLength(body, 'utf8');
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': contentLength
  });
  res.end(body);
}

function normalizeThrown(error, fallbackMessage = '未知错误') {
  let message = '';
  let code = '';

  if (typeof error === 'string') {
    message = error;
  } else if (error && (typeof error === 'object' || typeof error === 'function')) {
    try {
      if (typeof error.message === 'string') message = error.message;
    } catch {}
    try {
      if (typeof error.code === 'string') code = error.code;
    } catch {}
  }

  return {
    message: message.trim() || fallbackMessage,
    code
  };
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clonePlainObject(value, context) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${context}必须是普通对象`);
  }
  try {
    return structuredClone(value);
  } catch (error) {
    throw new TypeError(`${context}无法安全复制: ${normalizeThrown(error).message}`);
  }
}

function assertNonNegativeSafeInteger(value, field, context) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${context}.${field}必须是非负安全整数`);
  }
}

function assertStringArray(value, field, context) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new TypeError(`${context}.${field}必须是字符串数组`);
  }
}

function isValidUtcIsoString(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12
    && day >= 1 && day <= daysInMonth[month - 1]
    && hour <= 23
    && minute <= 59
    && second <= 59;
}

function validateMigrationResultFields(result, context) {
  if (typeof result.fileName !== 'string'
      || path.posix.basename(result.fileName) !== result.fileName
      || path.win32.basename(result.fileName) !== result.fileName
      || !/^Linkey-完整数据迁移包-\d{8}-\d{6}\.zip$/.test(result.fileName)) {
    throw new TypeError(`${context}.fileName必须是安全的 Linkey 完整数据迁移 ZIP 文件名`);
  }
  if (result.relativePath !== `dist/${result.fileName}`) {
    throw new TypeError(`${context}.relativePath必须精确为 dist/${result.fileName}`);
  }
  assertNonNegativeSafeInteger(result.size, 'size', context);
  if (!isValidUtcIsoString(result.createdAt)) {
    throw new TypeError(`${context}.createdAt必须是有效的 ISO UTC 时间`);
  }
  assertNonNegativeSafeInteger(result.attachmentCount, 'attachmentCount', context);
  assertNonNegativeSafeInteger(result.attachmentBytes, 'attachmentBytes', context);
  if (result.cleanupWarnings !== undefined) {
    assertStringArray(result.cleanupWarnings, 'cleanupWarnings', context);
  }
}

function validateMigrationResult(value, context = '迁移导出结果') {
  const result = clonePlainObject(value, context);
  validateMigrationResultFields(result, context);
  return result;
}

function validateMigrationStatus(value) {
  const context = '迁移状态';
  const status = clonePlainObject(value, context);
  const allowedStates = new Set(['idle', 'running', 'completed', 'failed']);
  const allowedPhases = new Set(['snapshot', 'attachments', 'manifest', 'archive', 'verify', 'completed']);
  if (!allowedStates.has(status.state)) {
    throw new TypeError(`${context}.state 无效`);
  }
  if (status.phase !== null && status.phase !== undefined && !allowedPhases.has(status.phase)) {
    throw new TypeError(`${context}.phase 无效`);
  }
  if (status.message !== undefined && typeof status.message !== 'string') {
    throw new TypeError(`${context}.message 必须是字符串`);
  }
  if (status.code !== undefined && typeof status.code !== 'string') {
    throw new TypeError(`${context}.code 必须是字符串`);
  }
  if (status.cleanupWarnings !== undefined) {
    assertStringArray(status.cleanupWarnings, 'cleanupWarnings', context);
  }
  if (status.result !== undefined) {
    status.result = validateMigrationResult(status.result, `${context}.result`);
  }
  if (status.state === 'completed') {
    validateMigrationResultFields(status, `${context}.completed`);
  }
  if (status.state === 'failed') {
    if (typeof status.message !== 'string' || !status.message.trim()) {
      throw new TypeError(`${context}.failed.message 必须是非空字符串`);
    }
    if (typeof status.code !== 'string' || !status.code.trim()) {
      throw new TypeError(`${context}.failed.code 必须是非空字符串`);
    }
  }
  return status;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function authenticateAdmin(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  return verifySessionToken(token);
}

function hasProxyEvidence(headers) {
  const explicitProxyHeaders = new Set([
    'forwarded',
    'via',
    'x-real-ip',
    'cf-connecting-ip',
    'true-client-ip'
  ]);
  return Object.keys(headers).some(name =>
    explicitProxyHeaders.has(name) || name.startsWith('x-forwarded-')
  );
}

function isTrustedLocalRequest(req, clientIp) {
  const isLoopback = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '::ffff:127.0.0.1';
  const host = typeof req.headers.host === 'string' ? req.headers.host.trim() : '';
  const hasDirectLocalHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host);
  const hasLocalHeader = req.headers['x-linkey-local'] === '1' || req.headers['x-fastqq-local'] === '1';
  return isLoopback && hasDirectLocalHost && hasLocalHeader && !hasProxyEvidence(req.headers);
}

function serveStaticFile(req, res, targetPath) {
  const resolved = path.resolve(PUBLIC_DIR, targetPath);
  if (!resolved.startsWith(path.resolve(PUBLIC_DIR))) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('403 Forbidden');
  }

  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('404 Not Found');
  }

  const ext = path.extname(resolved).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(resolved).pipe(res);
}

export function createAdminServer(dependencies = {}) {
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw new TypeError('createAdminServer dependencies must be an object');
  }

  const migrationExporter = dependencies.migrationExporter === undefined
    ? exportFullMigration
    : dependencies.migrationExporter;
  const migrationStatusReader = dependencies.migrationStatusReader === undefined
    ? getMigrationStatus
    : dependencies.migrationStatusReader;
  if (typeof migrationExporter !== 'function') {
    throw new TypeError('migrationExporter must be a function');
  }
  if (typeof migrationStatusReader !== 'function') {
    throw new TypeError('migrationStatusReader must be a function');
  }

  const server = http.createServer(async (req, res) => {
    // CORS (loopback origins only)
    applyCors(req, res);
    if (req.method === 'OPTIONS') {
      return res.end();
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    const clientIp = req.socket.remoteAddress || '127.0.0.1';

    try {
      // === REST API ROUTES ===
      if (pathname === '/api/admin/login' && req.method === 'POST') {
        const raw = await readBody(req);
        let body = {};
        try { body = JSON.parse(raw.toString('utf8') || '{}'); } catch {}

        const config = loadConfig();
        if (!config.passwordHash) {
          return sendJson(res, 403, { error: '管理员密码尚未设置，请先完成初始化 (needsSetup)' });
        }

        const limit = checkRateLimit(clientIp);
        if (!limit.allowed) {
          writeLog('admin-err', `⛔ 登录限流触发 (IP: ${clientIp}, ${limit.retryAfterSeconds}s 后重试)`, true);
          return sendJson(res, 429, { error: `尝试次数过多，账号已临时锁定，请 ${Math.ceil(limit.retryAfterSeconds / 60)} 分钟后再试` });
        }

        if (!body.password || !verifyPassword(body.password, config.passwordHash)) {
          const attempt = recordFailedAttempt(clientIp);
          writeLog('admin-err', `⛔ 管理员登录失败 (IP: ${clientIp}, 第 ${attempt.count} 次错误)`, true);
          return sendJson(res, 401, { error: `密码不匹配（剩余尝试次数 ${Math.max(0, 5 - attempt.count)} 次）` });
        }

        clearFailedAttempts(clientIp);
        const session = createSessionToken();
        writeLog('admin', `🔑 管理员从 ${clientIp} 登录成功`);
        return sendJson(res, 200, { success: true, ...session });
      }

      if (pathname === '/api/admin/setup-password' && req.method === 'POST') {
        if (isInitialized()) {
          return sendJson(res, 403, { error: '管理员密码已初始化，无法重复配置' });
        }
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        if (!body.password || body.password.length < 4) {
          return sendJson(res, 400, { error: '密码长度不能少于 4 位' });
        }
        setAdminPassword(body.password);
        writeLog('admin', `✅ 首次管理员密码初始化成功 (IP: ${clientIp})`);
        const session = createSessionToken();
        return sendJson(res, 200, { success: true, ...session });
      }

      // Check Authentication for all other /api/admin/* endpoints
      if (pathname.startsWith('/api/admin/')) {
        const auth = authenticateAdmin(req);
        // 本机进程豁免只适用于直连回环 Host，且请求不得带任何代理转发证据。旧头仅作同规则兼容。
        // 反向代理不得暴露此豁免；若代理刻意剔除所有转发头并伪造 Host，TCP 层无法与真正本机进程区分。
        const trustedLocalCall = isTrustedLocalRequest(req, clientIp);
        if (!auth && !trustedLocalCall) {
          return sendJson(res, 401, { error: '未登录或 Session Token 已过期' });
        }

        // GET /api/admin/migration/status
        if (pathname === '/api/admin/migration/status' && req.method === 'GET') {
          const migrationStatus = validateMigrationStatus(await migrationStatusReader());
          return sendJson(res, 200, migrationStatus);
        }

        // POST /api/admin/migration/export
        if (pathname === '/api/admin/migration/export' && req.method === 'POST') {
          try {
            const migration = validateMigrationResult(await migrationExporter());
            sendJson(res, 200, { success: true, migration });
            writeLog('admin', `完整数据迁移包已生成: ${migration.fileName}`);
            return;
          } catch (error) {
            const normalized = normalizeThrown(error, '完整数据迁移导出失败');
            const code = normalized.code === 'MIGRATION_IN_PROGRESS' || normalized.code === 'MIGRATION_ARCHIVE_EXISTS'
              ? normalized.code
              : 'MIGRATION_EXPORT_FAILED';
            const statusCode = code === 'MIGRATION_IN_PROGRESS' || code === 'MIGRATION_ARCHIVE_EXISTS'
              ? 409
              : 500;
            writeLog('admin-err', `完整数据迁移导出失败 (${code}): ${normalized.message}`, true);
            return sendJson(res, statusCode, { error: normalized.message, code });
          }
        }

        // GET /api/admin/status
        if (pathname === '/api/admin/status' && req.method === 'GET') {
          const appStatus = processManager.getStatus();
          const healthStatus = healthChecker.getStatus();
          const backups = listBackups();

          return sendJson(res, 200, {
            app: appStatus,
            health: healthStatus,
            backup: {
              nextBackupAt: getNextBackupTime(),
              backupCount: backups.length
            },
            admin: {
              version: '1.0.0',
              startedAt: ADMIN_STARTED_AT,
              uptime: Math.floor((Date.now() - ADMIN_STARTED_AT) / 1000)
            },
            serverTime: Date.now()
          });
        }

        // POST /api/admin/app/start
        if (pathname === '/api/admin/app/start' && req.method === 'POST') {
          await processManager.start();
          return sendJson(res, 200, { success: true, app: processManager.getStatus() });
        }

        // POST /api/admin/app/stop
        if (pathname === '/api/admin/app/stop' && req.method === 'POST') {
          await processManager.stop(true);
          return sendJson(res, 200, { success: true, app: processManager.getStatus() });
        }

        // POST /api/admin/app/restart
        if (pathname === '/api/admin/app/restart' && req.method === 'POST') {
          await processManager.restart('admin_panel_request');
          return sendJson(res, 200, { success: true, app: processManager.getStatus() });
        }

        // === PUBLIC TUNNEL MANAGEMENT ===
        // GET /api/admin/tunnel/status
        if (pathname === '/api/admin/tunnel/status' && req.method === 'GET') {
          return sendJson(res, 200, { success: true, tunnel: getTunnelStatus() });
        }

        // POST /api/admin/tunnel/start
        if (pathname === '/api/admin/tunnel/start' && req.method === 'POST') {
          const cfg = loadConfig();
          const tunnel = await startTunnel(cfg.appPort || 3000);
          return sendJson(res, 200, { success: true, tunnel });
        }

        // POST /api/admin/tunnel/stop
        if (pathname === '/api/admin/tunnel/stop' && req.method === 'POST') {
          stopTunnel();
          return sendJson(res, 200, { success: true, tunnel: getTunnelStatus() });
        }

        // GET /api/admin/stats
        if (pathname === '/api/admin/stats' && req.method === 'GET') {
          if (!fs.existsSync(DB_PATH)) {
            return sendJson(res, 200, { users: 0, totalUsersToday: 0, messagesToday: 0, conversations: 0, topConversations: [] });
          }
          try {
            const db = new DatabaseSync(DB_PATH, { readOnly: true });
            const users = db.prepare('SELECT COUNT(*) as c FROM users').get()?.c || 0;
            const totalUsersToday = db.prepare("SELECT COUNT(*) as c FROM users WHERE date(created_at) = date('now')").get()?.c || 0;
            const messagesToday = db.prepare("SELECT COUNT(*) as c FROM messages WHERE date(created_at) = date('now')").get()?.c || 0;
            const conversations = db.prepare('SELECT COUNT(*) as c FROM conversations').get()?.c || 0;
            const topConversations = db.prepare(`
              SELECT c.id, c.name, c.type, COUNT(m.id) as msgCount
              FROM messages m
              JOIN conversations c ON m.conversation_id = c.id
              WHERE date(m.created_at) = date('now')
              GROUP BY m.conversation_id
              ORDER BY msgCount DESC
              LIMIT 5
            `).all();
            db.close();

            return sendJson(res, 200, {
              users,
              totalUsersToday,
              messagesToday,
              conversations,
              topConversations
            });
          } catch (err) {
            return sendJson(res, 500, { error: `统计查询失败: ${err.message}` });
          }
        }

        // GET /api/admin/logs/list
        if (pathname === '/api/admin/logs/list' && req.method === 'GET') {
          const files = listLogFiles();
          return sendJson(res, 200, { files });
        }

        // GET /api/admin/logs/read
        if (pathname === '/api/admin/logs/read' && req.method === 'GET') {
          const file = url.searchParams.get('file');
          const tail = parseInt(url.searchParams.get('tail') || '200', 10);
          try {
            const result = readLogTail(file, tail);
            return sendJson(res, 200, result);
          } catch (err) {
            return sendJson(res, 400, { error: err.message });
          }
        }

        // GET /api/admin/logs/download
        if (pathname === '/api/admin/logs/download' && req.method === 'GET') {
          const file = url.searchParams.get('file');
          const fullPath = validateLogFileName(file);
          if (!fullPath) return sendJson(res, 400, { error: '无效日志文件' });

          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': `attachment; filename="${path.basename(fullPath)}"`
          });
          return fs.createReadStream(fullPath).pipe(res);
        }

        // GET /api/admin/backups/list
        if (pathname === '/api/admin/backups/list' && req.method === 'GET') {
          const files = listBackups();
          return sendJson(res, 200, { files });
        }

        // POST /api/admin/backups/create
        if (pathname === '/api/admin/backups/create' && req.method === 'POST') {
          try {
            const backup = createBackup();
            return sendJson(res, 200, { success: true, backup });
          } catch (err) {
            return sendJson(res, 500, { error: err.message });
          }
        }

        // GET /api/admin/backups/download
        if (pathname === '/api/admin/backups/download' && req.method === 'GET') {
          const file = url.searchParams.get('file');
          const fullPath = validateBackupFileName(file);
          if (!fullPath) return sendJson(res, 400, { error: '无效备份文件' });

          res.writeHead(200, {
            'Content-Type': 'application/x-sqlite3',
            'Content-Disposition': `attachment; filename="${path.basename(fullPath)}"`
          });
          return fs.createReadStream(fullPath).pipe(res);
        }

        // DELETE /api/admin/backups
        if (pathname === '/api/admin/backups' && req.method === 'DELETE') {
          const file = url.searchParams.get('file');
          try {
            deleteBackup(file);
            return sendJson(res, 200, { success: true });
          } catch (err) {
            return sendJson(res, 400, { error: err.message });
          }
        }

        // ====================================================================
        // 👥 USER MANAGEMENT ENDPOINTS
        // ====================================================================

        // GET /api/admin/users
        if (pathname === '/api/admin/users' && req.method === 'GET') {
          const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
          const pageSize = Math.max(1, Math.min(100, parseInt(url.searchParams.get('pageSize') || '20', 10)));
          const search = (url.searchParams.get('search') || '').trim();
          const statusFilter = url.searchParams.get('status') || 'all';

          const db = new DatabaseSync(DB_PATH);
          let whereClauses = [];
          let params = [];

          if (search) {
            whereClauses.push('(u.username LIKE ? OR u.nickname LIKE ? OR u.qq_number LIKE ? OR u.id LIKE ?)');
            const p = `%${search}%`;
            params.push(p, p, p, p);
          }

          if (statusFilter && statusFilter !== 'all') {
            whereClauses.push('u.status = ?');
            params.push(statusFilter);
          }

          const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
          const total = db.prepare(`SELECT COUNT(*) as c FROM users u ${whereSql}`).get(...params)?.c || 0;

          const offset = (page - 1) * pageSize;
          const users = db.prepare(`
            SELECT 
              u.id, u.username, u.nickname, u.avatar, u.bio, u.qq_number, u.qq_level, u.status, u.last_seen, u.created_at,
              (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id) AS messageCount,
              (SELECT COUNT(*) FROM conversation_members cm WHERE cm.user_id = u.id) AS conversationCount,
              (SELECT COUNT(*) FROM friends f WHERE f.user_id = u.id) AS friendCount
            FROM users u
            ${whereSql}
            ORDER BY u.created_at DESC
            LIMIT ? OFFSET ?
          `).all(...params, pageSize, offset);
          db.close();

          return sendJson(res, 200, {
            users,
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize) || 1
          });
        }

        // GET /api/admin/users/:id
        if (pathname.startsWith('/api/admin/users/') && req.method === 'GET' && !pathname.endsWith('/toggle-ban') && !pathname.endsWith('/reset-password')) {
          const targetId = pathname.split('/')[4];
          const db = new DatabaseSync(DB_PATH);
          const user = db.prepare(`
            SELECT id, username, nickname, avatar, bio, qq_number, qq_level, status, last_seen, created_at, cover_theme, tags, qzone_visitors, qzone_yellow_diamond
            FROM users WHERE id = ?
          `).get(targetId);

          if (!user) {
            db.close();
            return sendJson(res, 404, { error: '用户不存在' });
          }

          const friends = db.prepare(`
            SELECT f.friend_id, f.remark, f.group_name, u.username, u.nickname, u.avatar, u.status, u.qq_number
            FROM friends f
            JOIN users u ON f.friend_id = u.id
            WHERE f.user_id = ?
          `).all(targetId);

          const groups = db.prepare(`
            SELECT c.id, c.name, c.type, c.avatar, cm.role, cm.joined_at,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS messageCount,
              (SELECT u.id FROM conversation_members cm2 JOIN users u ON cm2.user_id = u.id
               WHERE cm2.conversation_id = c.id AND cm2.user_id != ? LIMIT 1) AS peerId,
              (SELECT u.nickname FROM conversation_members cm2 JOIN users u ON cm2.user_id = u.id
               WHERE cm2.conversation_id = c.id AND cm2.user_id != ? LIMIT 1) AS peerName
            FROM conversation_members cm
            JOIN conversations c ON cm.conversation_id = c.id
            WHERE cm.user_id = ?
            ORDER BY c.last_message_at DESC
          `).all(targetId, targetId, targetId);

          const recentMessages = db.prepare(`
            SELECT m.id, m.conversation_id, m.type, m.content, m.created_at, c.name as conversation_name, c.type as conversation_type
            FROM messages m
            JOIN conversations c ON m.conversation_id = c.id
            WHERE m.sender_id = ?
            ORDER BY m.created_at DESC
            LIMIT 10
          `).all(targetId);

          // 好友申请记录（收到 / 发出）
          const incomingRequests = db.prepare(`
            SELECT fr.id, fr.message, fr.status, fr.created_at,
                   u.id as from_user_id, u.username as from_username, u.nickname as from_nickname, u.avatar as from_avatar
            FROM friend_requests fr
            JOIN users u ON fr.from_user_id = u.id
            WHERE fr.to_user_id = ?
            ORDER BY fr.created_at DESC
          `).all(targetId);

          const outgoingRequests = db.prepare(`
            SELECT fr.id, fr.message, fr.status, fr.created_at,
                   u.id as to_user_id, u.username as to_username, u.nickname as to_nickname, u.avatar as to_avatar
            FROM friend_requests fr
            JOIN users u ON fr.to_user_id = u.id
            WHERE fr.from_user_id = ?
            ORDER BY fr.created_at DESC
          `).all(targetId);

          db.close();
          return sendJson(res, 200, { user, friends, groups, recentMessages, incomingRequests, outgoingRequests });
        }

        // DELETE /api/admin/users/:id/friends/:friendId —— 删除一对好友关系（双向移除）
        if (pathname.startsWith('/api/admin/users/') && pathname.includes('/friends/') && req.method === 'DELETE') {
          const parts = pathname.split('/');
          const targetId = parts[4];
          const friendId = parts[6];
          const db = new DatabaseSync(DB_PATH);
          const resDel = db.prepare('DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)').run(targetId, friendId, friendId, targetId);
          db.close();
          if (resDel.changes === 0) {
            return sendJson(res, 404, { error: '好友关系不存在' });
          }
          writeLog('admin', `👥 管理员解除了用户 [${targetId}] 与 [${friendId}] 的好友关系`);
          return sendJson(res, 200, { success: true });
        }

        // POST /api/admin/friend-requests/:id/respond —— 管理员同意或拒绝好友申请
        if (pathname.startsWith('/api/admin/friend-requests/') && pathname.endsWith('/respond') && req.method === 'POST') {
          const requestId = pathname.split('/')[4];
          const raw = await readBody(req);
          const body = JSON.parse(raw.toString('utf8') || '{}');
          const action = body.action;

          if (!['accept', 'reject'].includes(action)) {
            return sendJson(res, 400, { error: '操作必须是 accept 或 reject' });
          }

          const db = new DatabaseSync(DB_PATH);
          db.exec('PRAGMA foreign_keys = ON;');

          try {
            db.exec('BEGIN IMMEDIATE;');
            const friendRequest = db.prepare('SELECT * FROM friend_requests WHERE id = ?').get(requestId);

            if (!friendRequest) {
              db.exec('ROLLBACK;');
              db.close();
              return sendJson(res, 404, { error: '好友申请不存在' });
            }
            if (friendRequest.status !== 'pending') {
              db.exec('ROLLBACK;');
              db.close();
              return sendJson(res, 409, { error: '该好友申请已被处理' });
            }

            if (action === 'reject') {
              db.prepare("UPDATE friend_requests SET status = 'rejected', updated_at = datetime('now') WHERE id = ?").run(requestId);
              db.exec('COMMIT;');
              db.close();
              writeLog('admin', `👥 管理员拒绝了好友申请 [${requestId}]`);
              return sendJson(res, 200, { success: true, action: 'rejected', requestId });
            }

            db.prepare("UPDATE friend_requests SET status = 'accepted', updated_at = datetime('now') WHERE id = ?").run(requestId);
            db.prepare("INSERT OR IGNORE INTO friends (user_id, friend_id, group_name) VALUES (?, ?, '我的好友')")
              .run(friendRequest.to_user_id, friendRequest.from_user_id);
            db.prepare("INSERT OR IGNORE INTO friends (user_id, friend_id, group_name) VALUES (?, ?, '我的好友')")
              .run(friendRequest.from_user_id, friendRequest.to_user_id);

            let conversation = db.prepare(`
              SELECT c.id
              FROM conversations c
              JOIN conversation_members first_member
                ON first_member.conversation_id = c.id AND first_member.user_id = ?
              JOIN conversation_members second_member
                ON second_member.conversation_id = c.id AND second_member.user_id = ?
              WHERE c.type = 'direct'
              LIMIT 1
            `).get(friendRequest.to_user_id, friendRequest.from_user_id);

            if (!conversation) {
              const conversationId = 'dm_' + crypto.randomUUID().replace(/-/g, '');
              db.prepare('INSERT INTO conversations (id, type, name, creator_id) VALUES (?, ?, ?, ?)')
                .run(conversationId, 'direct', null, friendRequest.to_user_id);
              db.prepare('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)')
                .run(conversationId, friendRequest.to_user_id, 'owner');
              db.prepare('INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)')
                .run(conversationId, friendRequest.from_user_id, 'member');
              conversation = { id: conversationId };
            }

            db.prepare('INSERT INTO messages (conversation_id, sender_id, type, content) VALUES (?, ?, ?, ?)')
              .run(conversation.id, friendRequest.to_user_id, 'system', '你们已成为好友，现在可以开始聊天啦！');
            db.prepare("UPDATE conversations SET last_message_preview = ?, last_message_at = datetime('now') WHERE id = ?")
              .run('你们已成为好友，现在可以开始聊天啦！', conversation.id);

            db.exec('COMMIT;');
            db.close();
            writeLog('admin', `👥 管理员同意了好友申请 [${requestId}]`);
            return sendJson(res, 200, {
              success: true,
              action: 'accepted',
              requestId,
              fromUserId: friendRequest.from_user_id,
              toUserId: friendRequest.to_user_id,
              conversationId: conversation.id
            });
          } catch (err) {
            try { db.exec('ROLLBACK;'); } catch {}
            try { db.close(); } catch {}
            return sendJson(res, 400, { error: `处理好友申请失败: ${err.message}` });
          }
        }

        // PUT /api/admin/users/:id
        if (pathname.startsWith('/api/admin/users/') && req.method === 'PUT') {
          const targetId = pathname.split('/')[4];
          const raw = await readBody(req);
          const body = JSON.parse(raw.toString('utf8') || '{}');
          const db = new DatabaseSync(DB_PATH);
          const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(targetId);
          if (!existing) {
            db.close();
            return sendJson(res, 404, { error: '用户不存在' });
          }

          const fields = [];
          const params = [];
          if (body.nickname !== undefined) { fields.push('nickname = ?'); params.push(body.nickname); }
          if (body.bio !== undefined) { fields.push('bio = ?'); params.push(body.bio); }
          if (body.qq_number !== undefined) { fields.push('qq_number = ?'); params.push(body.qq_number); }
          if (body.qq_level !== undefined) { fields.push('qq_level = ?'); params.push(parseInt(body.qq_level, 10) || 1); }
          if (body.status !== undefined) { fields.push('status = ?'); params.push(body.status); }
          if (body.avatar !== undefined) { fields.push('avatar = ?'); params.push(body.avatar); }

          if (fields.length > 0) {
            params.push(targetId);
            db.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...params);
          }

          const updated = db.prepare('SELECT id, username, nickname, avatar, bio, qq_number, qq_level, status, created_at FROM users WHERE id = ?').get(targetId);
          db.close();
          writeLog('admin', `👤 管理员修改了用户 [${targetId}] 的资料`);
          return sendJson(res, 200, { success: true, user: updated });
        }

        // POST /api/admin/users/:id/reset-password
        if (pathname.startsWith('/api/admin/users/') && pathname.endsWith('/reset-password') && req.method === 'POST') {
          const targetId = pathname.split('/')[4];
          const raw = await readBody(req);
          const body = JSON.parse(raw.toString('utf8') || '{}');
          if (!body.newPassword || body.newPassword.length < 4) {
            return sendJson(res, 400, { error: '新密码不能少于 4 位' });
          }
          const db = new DatabaseSync(DB_PATH);
          const hash = hashUserPassword(body.newPassword);
          const resUpdate = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, targetId);
          db.close();
          if (resUpdate.changes === 0) {
            return sendJson(res, 404, { error: '用户不存在' });
          }
          writeLog('admin', `🔑 管理员重置了用户 [${targetId}] 的登录密码`);
          return sendJson(res, 200, { success: true });
        }

        // POST /api/admin/users/:id/toggle-ban
        if (pathname.startsWith('/api/admin/users/') && pathname.endsWith('/toggle-ban') && req.method === 'POST') {
          const targetId = pathname.split('/')[4];
          const raw = await readBody(req);
          const body = JSON.parse(raw.toString('utf8') || '{}');
          const isBanned = !!body.isBanned;
          const db = new DatabaseSync(DB_PATH);
          const newStatus = isBanned ? 'banned' : 'offline';
          const resUpdate = db.prepare('UPDATE users SET status = ? WHERE id = ?').run(newStatus, targetId);
          db.close();
          if (resUpdate.changes === 0) {
            return sendJson(res, 404, { error: '用户不存在' });
          }
          writeLog('admin', `🚫 管理员${isBanned ? '封禁' : '解封'}了用户 [${targetId}]`);
          return sendJson(res, 200, { success: true, status: newStatus });
        }

        // DELETE /api/admin/users/:id
        if (pathname.startsWith('/api/admin/users/') && req.method === 'DELETE') {
          const targetId = pathname.split('/')[4];
          const db = new DatabaseSync(DB_PATH);
          db.exec('PRAGMA foreign_keys = ON;');
          const resDelete = db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
          db.close();
          if (resDelete.changes === 0) {
            return sendJson(res, 404, { error: '用户不存在' });
          }
          writeLog('admin', `🗑️ 管理员注销/删除了用户 [${targetId}] 及其全部关联数据`);
          return sendJson(res, 200, { success: true });
        }

        // ====================================================================
        // 💬 CHAT & CONVERSATIONS AUDIT ENDPOINTS
        // ====================================================================

        // GET /api/admin/conversations
        if (pathname === '/api/admin/conversations' && req.method === 'GET') {
          const search = (url.searchParams.get('search') || '').trim();
          const typeFilter = url.searchParams.get('type') || 'all';
          const db = new DatabaseSync(DB_PATH);
          let whereClauses = [];
          let params = [];

          if (search) {
            whereClauses.push('(c.name LIKE ? OR c.id LIKE ?)');
            params.push(`%${search}%`, `%${search}%`);
          }
          if (typeFilter && typeFilter !== 'all') {
            whereClauses.push('c.type = ?');
            params.push(typeFilter);
          }
          const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
          const convs = db.prepare(`
            SELECT 
              c.id, c.type, c.name, c.avatar, c.creator_id, c.notice, c.last_message_preview, c.last_message_at, c.created_at,
              u.nickname AS creator_name,
              (SELECT COUNT(*) FROM conversation_members cm WHERE cm.conversation_id = c.id) AS memberCount,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS messageCount
            FROM conversations c
            LEFT JOIN users u ON c.creator_id = u.id
            ${whereSql}
            ORDER BY c.last_message_at DESC
          `).all(...params);
          db.close();
          return sendJson(res, 200, { conversations: convs });
        }

        // GET /api/admin/conversations/:id/messages
        if (pathname.startsWith('/api/admin/conversations/') && pathname.endsWith('/messages') && req.method === 'GET') {
          const convId = pathname.split('/')[4];
          const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
          const pageSize = Math.max(1, Math.min(100, parseInt(url.searchParams.get('pageSize') || '30', 10)));
          const query = (url.searchParams.get('query') || '').trim();
          const type = url.searchParams.get('type') || 'all';
          const senderId = url.searchParams.get('senderId') || '';

          const db = new DatabaseSync(DB_PATH);
          let whereClauses = ['m.conversation_id = ?'];
          let params = [convId];

          if (query) {
            whereClauses.push('(m.content LIKE ? OR m.file_name LIKE ?)');
            params.push(`%${query}%`, `%${query}%`);
          }
          if (type && type !== 'all') {
            whereClauses.push('m.type = ?');
            params.push(type);
          }
          if (senderId) {
            whereClauses.push('m.sender_id = ?');
            params.push(senderId);
          }

          const whereSql = `WHERE ${whereClauses.join(' AND ')}`;
          const total = db.prepare(`SELECT COUNT(*) as c FROM messages m ${whereSql}`).get(...params)?.c || 0;
          const offset = (page - 1) * pageSize;
          const messages = db.prepare(`
            SELECT 
              m.id, m.conversation_id, m.sender_id, m.type, m.content, m.file_name, m.file_size,
              m.is_recalled, m.reply_to_id, m.created_at,
              u.username, u.nickname, u.avatar
            FROM messages m
            LEFT JOIN users u ON m.sender_id = u.id
            ${whereSql}
            ORDER BY m.created_at DESC
            LIMIT ? OFFSET ?
          `).all(...params, pageSize, offset);
          db.close();

          return sendJson(res, 200, {
            messages,
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize) || 1
          });
        }

        // DELETE /api/admin/messages/:id
        if (pathname.startsWith('/api/admin/messages/') && req.method === 'DELETE') {
          const msgId = parseInt(pathname.split('/')[4], 10);
          const db = new DatabaseSync(DB_PATH);
          const resDel = db.prepare('DELETE FROM messages WHERE id = ?').run(msgId);
          db.close();
          if (resDel.changes === 0) return sendJson(res, 404, { error: '消息不存在' });
          writeLog('admin', `🗑️ 管理员删除了消息 ID: ${msgId}`);
          return sendJson(res, 200, { success: true });
        }

        // POST /api/admin/messages/batch-delete
        if (pathname === '/api/admin/messages/batch-delete' && req.method === 'POST') {
          const raw = await readBody(req);
          const body = JSON.parse(raw.toString('utf8') || '{}');
          const ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(Boolean) : [];
          if (ids.length === 0) return sendJson(res, 400, { error: '未指定要删除的消息 ID 列表' });
          const db = new DatabaseSync(DB_PATH);
          const placeholders = ids.map(() => '?').join(',');
          const resDel = db.prepare(`DELETE FROM messages WHERE id IN (${placeholders})`).run(...ids);
          db.close();
          writeLog('admin', `🗑️ 管理员批量删除了 ${resDel.changes} 条消息`);
          return sendJson(res, 200, { success: true, deletedCount: resDel.changes });
        }

        // POST /api/admin/conversations/:id/clear
        if (pathname.startsWith('/api/admin/conversations/') && pathname.endsWith('/clear') && req.method === 'POST') {
          const convId = pathname.split('/')[4];
          const db = new DatabaseSync(DB_PATH);
          const resDel = db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(convId);
          db.prepare("UPDATE conversations SET last_message_preview = '', last_message_at = datetime('now') WHERE id = ?").run(convId);
          db.close();
          writeLog('admin', `🧹 管理员清空了会话 [${convId}] 的全部聊天记录 (${resDel.changes} 条)`);
          return sendJson(res, 200, { success: true, deletedCount: resDel.changes });
        }

        // DELETE /api/admin/conversations/:id
        if (pathname.startsWith('/api/admin/conversations/') && req.method === 'DELETE') {
          const convId = pathname.split('/')[4];
          const db = new DatabaseSync(DB_PATH);
          db.exec('PRAGMA foreign_keys = ON;');
          const resDel = db.prepare('DELETE FROM conversations WHERE id = ?').run(convId);
          db.close();
          if (resDel.changes === 0) return sendJson(res, 404, { error: '会话不存在' });
          writeLog('admin', `🗑️ 管理员解散/删除了会话 [${convId}]`);
          return sendJson(res, 200, { success: true });
        }

        // ====================================================================
        // 📁 FILE & ASSET MANAGEMENT ENDPOINTS
        // ====================================================================

        // GET /api/admin/files/stats
        if (pathname === '/api/admin/files/stats' && req.method === 'GET') {
          let totalFiles = 0;
          let totalBytes = 0;
          let imagesCount = 0;
          let imagesBytes = 0;
          let docsCount = 0;
          let docsBytes = 0;
          let othersCount = 0;
          let othersBytes = 0;

          const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
          const docExts = new Set(['.pdf', '.doc', '.docx', '.txt', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.rar', '.7z', '.tar', '.gz', '.json', '.md']);

          if (fs.existsSync(UPLOADS_DIR)) {
            const files = fs.readdirSync(UPLOADS_DIR);
            for (const file of files) {
              const fullPath = path.join(UPLOADS_DIR, file);
              try {
                const stat = fs.statSync(fullPath);
                if (stat.isFile()) {
                  totalFiles++;
                  totalBytes += stat.size;
                  const ext = path.extname(file).toLowerCase();
                  if (imageExts.has(ext)) {
                    imagesCount++;
                    imagesBytes += stat.size;
                  } else if (docExts.has(ext)) {
                    docsCount++;
                    docsBytes += stat.size;
                  } else {
                    othersCount++;
                    othersBytes += stat.size;
                  }
                }
              } catch {}
            }
          }

          return sendJson(res, 200, {
            totalFiles,
            totalBytes,
            images: { count: imagesCount, bytes: imagesBytes },
            docs: { count: docsCount, bytes: docsBytes },
            others: { count: othersCount, bytes: othersBytes }
          });
        }

        // GET /api/admin/files/content —— 经后台鉴权读取真实上传附件
        if (pathname === '/api/admin/files/content' && req.method === 'GET') {
          const resolvedFile = resolveUploadFile(url.searchParams.get('file'));
          if (resolvedFile.error) {
            return sendJson(res, 400, { error: resolvedFile.error });
          }
          if (!fs.existsSync(resolvedFile.fullPath) || fs.statSync(resolvedFile.fullPath).isDirectory()) {
            return sendJson(res, 404, { error: '文件不存在' });
          }

          const stat = fs.statSync(resolvedFile.fullPath);
          const ext = path.extname(resolvedFile.safeName).toLowerCase();
          const contentType = MIME_TYPES[ext] || 'application/octet-stream';
          const disposition = url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': stat.size,
            'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(resolvedFile.safeName)}`,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'private, max-age=300'
          });
          return fs.createReadStream(resolvedFile.fullPath).pipe(res);
        }

        // GET /api/admin/files
        if (pathname === '/api/admin/files' && req.method === 'GET') {
          const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
          const pageSize = Math.max(1, Math.min(100, parseInt(url.searchParams.get('pageSize') || '24', 10)));
          const search = (url.searchParams.get('search') || '').trim().toLowerCase();
          const category = url.searchParams.get('category') || 'all';

          const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico']);
          const docExts = new Set(['.pdf', '.doc', '.docx', '.txt', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.rar', '.7z', '.tar', '.gz', '.json', '.md']);

          let allFileList = [];
          if (fs.existsSync(UPLOADS_DIR)) {
            const fileNames = fs.readdirSync(UPLOADS_DIR);
            for (const name of fileNames) {
              const fullPath = path.join(UPLOADS_DIR, name);
              try {
                const stat = fs.statSync(fullPath);
                if (stat.isFile()) {
                  const ext = path.extname(name).toLowerCase();
                  let type = 'other';
                  if (imageExts.has(ext)) type = 'image';
                  else if (docExts.has(ext)) type = 'doc';

                  if (category !== 'all' && type !== category) continue;
                  if (search && !name.toLowerCase().includes(search)) continue;

                  allFileList.push({
                    name,
                    url: `/uploads/${name}`,
                    size: stat.size,
                    ext,
                    type,
                    mtime: stat.mtimeMs
                  });
                }
              } catch {}
            }
          }

          allFileList.sort((a, b) => b.mtime - a.mtime);
          const total = allFileList.length;
          const offset = (page - 1) * pageSize;
          const pagedFiles = allFileList.slice(offset, offset + pageSize);

          return sendJson(res, 200, {
            files: pagedFiles,
            total,
            page,
            pageSize,
            totalPages: Math.ceil(total / pageSize) || 1
          });
        }

        // DELETE /api/admin/files
        if (pathname === '/api/admin/files' && req.method === 'DELETE') {
          const file = url.searchParams.get('file');
          if (!file) return sendJson(res, 400, { error: '未指定文件名' });
          const safeName = path.basename(file);
          const targetPath = path.join(UPLOADS_DIR, safeName);

          if (fs.existsSync(targetPath)) {
            fs.unlinkSync(targetPath);
            writeLog('admin', `🗑️ 管理员删除了上传文件: ${safeName}`);
            return sendJson(res, 200, { success: true });
          } else {
            return sendJson(res, 404, { error: '文件不存在' });
          }
        }

        // POST /api/admin/files/batch-delete
        if (pathname === '/api/admin/files/batch-delete' && req.method === 'POST') {
          const raw = await readBody(req);
          const body = JSON.parse(raw.toString('utf8') || '{}');
          const files = Array.isArray(body.files) ? body.files : [];
          let deletedCount = 0;

          for (const file of files) {
            const safeName = path.basename(file);
            const targetPath = path.join(UPLOADS_DIR, safeName);
            if (fs.existsSync(targetPath)) {
              try {
                fs.unlinkSync(targetPath);
                deletedCount++;
              } catch {}
            }
          }

          writeLog('admin', `🗑️ 管理员批量删除了 ${deletedCount} 个文件`);
          return sendJson(res, 200, { success: true, deletedCount });
        }

        // POST /api/admin/files/cleanup-orphaned
        if (pathname === '/api/admin/files/cleanup-orphaned' && req.method === 'POST') {
          const db = new DatabaseSync(DB_PATH);
          const msgContents = db.prepare('SELECT content FROM messages WHERE type IN (\'image\', \'file\')').all().map(r => r.content);
          const userAvatars = db.prepare('SELECT avatar FROM users WHERE avatar LIKE \'/uploads/%\'').all().map(r => r.avatar);
          const userPhotos = db.prepare('SELECT url FROM user_photos WHERE url LIKE \'/uploads/%\'').all().map(r => r.url);
          db.close();

          const referencedFiles = new Set();
          for (const item of [...msgContents, ...userAvatars, ...userPhotos]) {
            if (item && typeof item === 'string' && item.includes('/uploads/')) {
              referencedFiles.add(path.basename(item));
            }
          }

          let deletedCount = 0;
          let freedBytes = 0;

          if (fs.existsSync(UPLOADS_DIR)) {
            const diskFiles = fs.readdirSync(UPLOADS_DIR);
            for (const file of diskFiles) {
              if (!referencedFiles.has(file)) {
                const fullPath = path.join(UPLOADS_DIR, file);
                try {
                  const stat = fs.statSync(fullPath);
                  freedBytes += stat.size;
                  fs.unlinkSync(fullPath);
                  deletedCount++;
                } catch {}
              }
            }
          }

          writeLog('admin', `🧹 管理员清理了 ${deletedCount} 个孤立文件 (释放 ${Math.round(freedBytes / 1024)} KB)`);
          return sendJson(res, 200, { success: true, deletedCount, freedBytes });
        }

        // POST /api/admin/password
        if (pathname === '/api/admin/password' && req.method === 'POST') {
          const raw = await readBody(req);
          const body = JSON.parse(raw.toString('utf8') || '{}');
          const config = loadConfig();

          if (!verifyPassword(body.oldPassword, config.passwordHash)) {
            return sendJson(res, 400, { error: '原密码不正确' });
          }
          if (!body.newPassword || body.newPassword.length < 4) {
            return sendJson(res, 400, { error: '新密码不能少于 4 位' });
          }

          setAdminPassword(body.newPassword);
          writeLog('admin', '🔒 管理员已修改登录密码，全量 Session 已注销');
          return sendJson(res, 200, { success: true });
        }

        // POST /api/admin/shutdown
        if (pathname === '/api/admin/shutdown' && req.method === 'POST') {
          writeLog('admin', '⚠️ 收到管理员关停指令，正在退出 Admin 与主服务...');
          sendJson(res, 200, { success: true });
          setTimeout(async () => {
            await processManager.stop(true);
            server.close();
            process.exit(0);
          }, 500);
          return;
        }

        return sendJson(res, 404, { error: 'API 端点不存在' });
      }

      // === STATIC ASSETS ===
      if (pathname === '/' || pathname === '/index.html') {
        return serveStaticFile(req, res, 'index.html');
      }
      if (pathname === '/panel.css') {
        return serveStaticFile(req, res, 'panel.css');
      }
      if (pathname === '/panel.js') {
        return serveStaticFile(req, res, 'panel.js');
      }
      if (pathname === '/app-icon.png') {
        return serveStaticFile(req, res, 'app-icon.png');
      }

      return serveStaticFile(req, res, pathname.slice(1));
    } catch (error) {
      const normalized = normalizeThrown(error);
      writeLog('admin-err', `HTTP 处理异常: ${normalized.message}`, true);
      if (res.headersSent || res.writableEnded) {
        if (!res.destroyed) res.destroy();
        return;
      }
      return sendJson(res, 500, { error: `服务器内部异常: ${normalized.message}` });
    }
  });

  server.on('error', (err) => {
    writeLog('admin-err', `HTTP Server 异常: ${err.message}`, true);
  });

  return server;
}

// === CLI ENTRY / SUBCOMMAND DISPATCH ===
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === 'set-password') {
    let pwd = null;
    const pwdArg = args.find(a => a.startsWith('--password='));
    if (pwdArg) {
      pwd = pwdArg.split('=')[1];
    } else if (args[1] && !args[1].startsWith('-')) {
      pwd = args[1];
    }

    if (!pwd) {
      console.log('用法: node admin/admin.js set-password --password=您的密码');
      process.exit(1);
    }

    try {
      setAdminPassword(pwd);
      console.log('[SUCCESS] 管理员密码设置成功！');
      process.exit(0);
    } catch (err) {
      console.error('[ERROR]', err.message);
      process.exit(1);
    }
  }

  if (command === 'backup') {
    try {
      const res = createBackup();
      console.log(`[SUCCESS] 备份创建成功: ${res.fileName} (${(res.size / 1024).toFixed(1)} KB)`);
      process.exit(0);
    } catch (err) {
      console.error('[ERROR] 备份失败:', err.message);
      process.exit(1);
    }
  }

  if (command === 'status') {
    const config = loadConfig();
    console.log('=== Linkey Admin 状态 ===');
    console.log(`- 管理端口: ${config.adminPort}`);
    console.log(`- 主服务端口: ${config.appPort}`);
    console.log(`- 密码已设置: ${isInitialized() ? '是' : '否 (请运行 set-password)'}`);
    const probe = await healthChecker.probe();
    console.log(`- 主服务运行状态: ${probe.ok ? '🟢 RUNNING' : '🔴 OFFLINE'}`);
    if (probe.ok) {
      console.log(`  └─ PID: ${probe.data.pid}, Uptime: ${probe.data.uptime}s, WS 连接: ${probe.data.ws?.connections}`);
    }
    process.exit(0);
  }

  // Default: Start Admin Supervisor Server
  const config = loadConfig();
  const server = createAdminServer();

  const bindHost = process.env.ADMIN_BIND || config.bindHost || '127.0.0.1';

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const msg = `端口 ${config.adminPort} 已被占用：检测到另一个 Admin 实例正在运行，本实例退出 (避免多实例互踩)。`;
      writeLog('admin-err', msg, true);
      console.warn(`[ADMIN] ${msg}`);
      process.exit(0);
    }
    writeLog('admin-err', `HTTP Server 异常: ${err.message}`, true);
    process.exit(1);
  });

  server.listen(config.adminPort, bindHost, async () => {
    writeLog('admin', `=======================================================`);
    writeLog('admin', `[LINKEY ADMIN] 管理系统守护进程已启动!`);
    writeLog('admin', `> 监听地址: ${bindHost}:${config.adminPort} (默认仅本机可访问，如需局域网访问请在 admin-config.json 配置 bindHost)`);
    writeLog('admin', `> 管理面板地址 : http://localhost:${config.adminPort}`);
    writeLog('admin', `> 密码初始化状态: ${isInitialized() ? '已配置' : '未设置 (访问面板可引导设置)'}`);
    writeLog('admin', `=======================================================`);

    // Start auto-backup scheduler
    startBackupScheduler();

    // Start child process or adopt existing instance
    await processManager.initAndStart();

    // Auto-start public tunnel if cloudflared is available
    if (fs.existsSync(path.join(ROOT_DIR, 'cloudflared.exe'))) {
      startTunnel(config.appPort || 3000).catch(err => {
        writeLog('admin-err', `Auto tunnel start error: ${err.message}`);
      });
    }
  });
}

// Auto-run when invoked directly
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(err => {
    console.error('[FATAL ADMIN ERROR]', err);
    process.exit(1);
  });
}
