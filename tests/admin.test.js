import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ★ 副作用模块，必须最先导入：为全部 admin 模块设置隔离的 日志/数据库/备份/配置 路径
import { ADMIN_TEST_ROOT } from './admin-env.js';

import { loadConfig, saveConfig, resetCachedConfig, ROOT_DIR } from '../admin/config.js';
import { hashPassword, verifyPassword, createSessionToken, verifySessionToken, setAdminPassword, checkRateLimit, recordFailedAttempt, clearFailedAttempts } from '../admin/auth.js';
import { writeLog, listLogFiles, readLogTail, validateLogFileName, cleanupOldLogs, LOGS_DIR } from '../admin/logger.js';
import { createBackup, listBackups, deleteBackup, validateBackupFileName, BACKUPS_DIR, DB_PATH } from '../admin/backup.js';
import { createAdminServer } from '../admin/admin.js';
import { closeDb, initDatabase, run as dbRun } from '../src/db/database.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function requestStatus(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, options, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end();
  });
}

function validMigrationFixture(timestamp = '20260905-120000', overrides = {}) {
  const fileName = `Linkey-完整数据迁移包-${timestamp}.zip`;
  return {
    fileName,
    relativePath: `dist/${fileName}`,
    size: 98765,
    createdAt: '2026-09-05T04:00:00.000Z',
    attachmentCount: 3,
    attachmentBytes: 4567,
    cleanupWarnings: [],
    ...overrides
  };
}

test('Linkey Admin Management System Comprehensive Test Suite', async (t) => {
  resetCachedConfig();
  assert.strictEqual(DB_PATH, process.env.ADMIN_DB_PATH, 'admin tests must never point at the production database');
  assert.strictEqual(process.env.ADMIN_TEST_ROOT, ADMIN_TEST_ROOT);
  for (const isolatedPath of [
    process.env.ADMIN_LOG_DIR,
    process.env.ADMIN_DB_PATH,
    process.env.ADMIN_BACKUPS_DIR,
    process.env.ADMIN_CONFIG_PATH,
    process.env.ADMIN_UPLOADS_DIR
  ]) {
    assert.ok(path.resolve(isolatedPath).startsWith(`${path.resolve(ADMIN_TEST_ROOT)}${path.sep}`));
  }
  // Every run must start from an empty isolated database. A persistent fixture database
  // accumulates system messages and makes the recent-message LIMIT 10 assertions flaky.
  for (const suffix of ['', '-shm', '-wal']) {
    const databaseFile = process.env.ADMIN_DB_PATH + suffix;
    if (fs.existsSync(databaseFile)) fs.unlinkSync(databaseFile);
  }
  // 为备份/用户管理测试准备隔离的测试数据库，并植入一个测试用户
  initDatabase(process.env.ADMIN_DB_PATH);
  dbRun(
    `INSERT OR IGNORE INTO users (id, username, password_hash, nickname, avatar, bio, qq_number, qq_level, status)
     VALUES ('u_test_admin_user', 'test_admin_user', 'x', '测试用户', '', '', '10086', 10, 'offline')`
  );
  dbRun(
    `INSERT OR IGNORE INTO users (id, username, password_hash, nickname, avatar, bio, qq_number, qq_level, status)
     VALUES ('u_test_admin_friend', 'test_admin_friend', 'x', '测试好友', '', '', '10087', 11, 'offline')`
  );
  dbRun(
    `INSERT OR IGNORE INTO users (id, username, password_hash, nickname, avatar, bio, qq_number, qq_level, status)
     VALUES ('u_test_admin_newfriend', 'test_admin_newfriend', 'x', '新测试好友', '', '', '10088', 12, 'offline')`
  );
  dbRun(`INSERT OR IGNORE INTO friends (user_id, friend_id, group_name) VALUES ('u_test_admin_user', 'u_test_admin_friend', '我的好友')`);
  dbRun(`INSERT OR IGNORE INTO friends (user_id, friend_id, group_name) VALUES ('u_test_admin_friend', 'u_test_admin_user', '我的好友')`);
  dbRun(
    `INSERT OR REPLACE INTO friend_requests (id, from_user_id, to_user_id, message, status)
     VALUES ('freq_test_admin', 'u_test_admin_user', 'u_test_admin_friend', '后台社交关系测试', 'accepted')`
  );
  dbRun(
    `INSERT OR REPLACE INTO friend_requests (id, from_user_id, to_user_id, message, status)
     VALUES ('freq_test_admin_pending', 'u_test_admin_newfriend', 'u_test_admin_user', '等待管理员处理', 'pending')`
  );
  dbRun(
    `INSERT OR REPLACE INTO friend_requests (id, from_user_id, to_user_id, message, status)
     VALUES ('freq_test_admin_reject', 'u_test_admin_user', 'u_test_admin_friend', '等待管理员拒绝', 'pending')`
  );
  dbRun(
    `INSERT OR IGNORE INTO conversations (id, type, creator_id, last_message_preview)
     VALUES ('dm_test_admin_social', 'direct', 'u_test_admin_user', '后台聊天记录测试')`
  );
  dbRun(`INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role) VALUES ('dm_test_admin_social', 'u_test_admin_user', 'owner')`);
  dbRun(`INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role) VALUES ('dm_test_admin_social', 'u_test_admin_friend', 'member')`);
  dbRun(
    `INSERT INTO messages (conversation_id, sender_id, type, content)
     SELECT 'dm_test_admin_social', 'u_test_admin_user', 'text', '后台聊天记录测试'
     WHERE NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = 'dm_test_admin_social')`
  );

  t.after(() => {
    closeDb();
    fs.rmSync(ADMIN_TEST_ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    delete process.env.ADMIN_TEST_ROOT;
    delete process.env.ADMIN_CONFIG_PATH;
    delete process.env.ADMIN_LOG_DIR;
    delete process.env.ADMIN_DB_PATH;
    delete process.env.ADMIN_BACKUPS_DIR;
    delete process.env.ADMIN_UPLOADS_DIR;
    resetCachedConfig();
  });

  // 1. Password Security and Hashing Tests
  await t.test('Password Hashing and Verification', () => {
    const raw = 'adminSuperSecret888';
    const hashed = hashPassword(raw);

    assert.ok(hashed.includes(':'), 'Hash format should be salt:hex');
    assert.strictEqual(verifyPassword(raw, hashed), true);
    assert.strictEqual(verifyPassword('wrongPassword', hashed), false);
    assert.strictEqual(verifyPassword('', hashed), false);
  });

  // 2. Session Token & HMAC Security Tests
  await t.test('Session Token Generation, HMAC Verification and Revocation', () => {
    setAdminPassword('adminTest123');
    const session = createSessionToken();
    assert.ok(session.token);
    assert.strictEqual(typeof session.token, 'string');

    // Valid verification
    const verified = verifySessionToken(session.token);
    assert.ok(verified);
    assert.ok(verified.jti);
    assert.ok(verified.exp > Date.now());

    // Tampered token verification
    const parts = session.token.split('.');
    const tampered = `${parts[0]}.invalidSignature`;
    assert.strictEqual(verifySessionToken(tampered), null);

    // Random invalid string
    assert.strictEqual(verifySessionToken('random-garbage'), null);
  });

  // 3. Brute Force Rate Limiting Policy Tests (5 failures -> 15 min lock)
  await t.test('Rate Limiting: Lockout After Repeated Failures', () => {
    const testIp = `192.168.100.${Math.floor(Math.random() * 200 + 1)}`;
    clearFailedAttempts(testIp);

    assert.strictEqual(checkRateLimit(testIp).allowed, true);

    for (let i = 0; i < 4; i++) {
      recordFailedAttempt(testIp);
      assert.strictEqual(checkRateLimit(testIp).allowed, true, `Attempt ${i + 1} should still be allowed`);
    }

    recordFailedAttempt(testIp);
    const locked = checkRateLimit(testIp);
    assert.strictEqual(locked.allowed, false, '5th failure must trigger lockout');
    assert.ok(locked.retryAfterSeconds > 0);

    clearFailedAttempts(testIp);
    assert.strictEqual(checkRateLimit(testIp).allowed, true, 'Clearing attempts must reset the limiter');
  });

  // 4. Logger and Safe Path Traversal Tests
  await t.test('Logger Write, Tail Read and Path Traversal Safety', () => {
    writeLog('admin', 'Test admin log message line 1');
    writeLog('admin', 'Test admin log message line 2');
    writeLog('admin-err', 'Test admin error message line 3', true);

    const logFiles = listLogFiles();
    assert.ok(logFiles.length > 0);

    const todayLog = logFiles.find(f => f.name.startsWith('admin-'));
    assert.ok(todayLog, 'Should find admin log file');

    const tail = readLogTail(todayLog.name, 10);
    assert.ok(tail.lines.length >= 3);
    assert.ok(tail.lines.some(l => l.includes('Test admin log message line 1')));

    // Path traversal attacks must return null
    assert.strictEqual(validateLogFileName('../package.json'), null);
    assert.strictEqual(validateLogFileName('../../etc/passwd'), null);
    assert.strictEqual(validateLogFileName('C:\\Windows\\win.ini'), null);
  });

  // 5. Online Backup & Integrity Tests
  await t.test('Online Database Backup, Listing, and Integrity Check', () => {
    const backupRes = createBackup();
    assert.ok(backupRes.fileName);
    assert.strictEqual(backupRes.integrityOk, true);

    const backups = listBackups();
    assert.ok(backups.length > 0);
    assert.ok(backups.some(b => b.name === backupRes.fileName));

    // Path traversal attacks on backup filename must be blocked
    assert.strictEqual(validateBackupFileName('../../../secret.db'), null);
    assert.strictEqual(validateBackupFileName('..\\qq_chat.db'), null);

    // Clean test backup
    deleteBackup(backupRes.fileName);
  });

  // 6. Admin HTTP Server REST API Endpoints Tests
  await t.test('Admin HTTP Server Endpoints via Local Socket', async () => {
    const server = createAdminServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Login with correct password
      const loginRes = await fetch(`${baseUrl}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'adminTest123' })
      });
      assert.strictEqual(loginRes.status, 200);
      const loginData = await loginRes.json();
      assert.ok(loginData.token);

      const token = loginData.token;

      // 2. GET /api/admin/status (Authenticated)
      const statusRes = await fetch(`${baseUrl}/api/admin/status`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.strictEqual(statusRes.status, 200);
      const statusData = await statusRes.json();
      assert.ok(statusData.app);
      assert.ok(statusData.health);
      assert.ok(statusData.admin);

      // 3. GET /api/admin/stats (Authenticated)
      const statsRes = await fetch(`${baseUrl}/api/admin/stats`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.strictEqual(statsRes.status, 200);
      const statsData = await statsRes.json();
      assert.ok(statsData.users !== undefined);
      assert.ok(statsData.messagesToday !== undefined);

      // 4. GET /api/admin/logs/list
      const logsRes = await fetch(`${baseUrl}/api/admin/logs/list`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.strictEqual(logsRes.status, 200);

      // 5. GET /api/admin/backups/list
      const backupsRes = await fetch(`${baseUrl}/api/admin/backups/list`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.strictEqual(backupsRes.status, 200);

      // 6. User Management: GET /api/admin/users
      const usersRes = await fetch(`${baseUrl}/api/admin/users?page=1&pageSize=10`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.strictEqual(usersRes.status, 200);
      const usersData = await usersRes.json();
      assert.ok(Array.isArray(usersData.users));
      assert.ok(usersData.total !== undefined);

      if (usersData.users.length > 0) {
        const testUser = usersData.users[0];

        // 7. GET /api/admin/users/:id
        const userDetailRes = await fetch(`${baseUrl}/api/admin/users/${testUser.id}`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        assert.strictEqual(userDetailRes.status, 200);
        const userDetailData = await userDetailRes.json();
        assert.ok(userDetailData.user);
        assert.ok(Array.isArray(userDetailData.friends));
        assert.ok(Array.isArray(userDetailData.incomingRequests));
        assert.ok(Array.isArray(userDetailData.outgoingRequests));
        assert.ok(Array.isArray(userDetailData.groups));
        assert.ok(Array.isArray(userDetailData.recentMessages));

        // 8. PUT /api/admin/users/:id
        const updateRes = await fetch(`${baseUrl}/api/admin/users/${testUser.id}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ nickname: 'AdminUpdatedNick', qq_level: 25 })
        });
        assert.strictEqual(updateRes.status, 200);
        const updateData = await updateRes.json();
        assert.strictEqual(updateData.user.nickname, 'AdminUpdatedNick');
        assert.strictEqual(updateData.user.qq_level, 25);

        // 9. POST /api/admin/users/:id/reset-password
        const resetPwdRes = await fetch(`${baseUrl}/api/admin/users/${testUser.id}/reset-password`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ newPassword: 'NewUserPass666' })
        });
        assert.strictEqual(resetPwdRes.status, 200);

        // 10. POST /api/admin/users/:id/toggle-ban
        const banRes = await fetch(`${baseUrl}/api/admin/users/${testUser.id}/toggle-ban`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ isBanned: true })
        });
        assert.strictEqual(banRes.status, 200);
        const banData = await banRes.json();
        assert.strictEqual(banData.status, 'banned');

        // Unban
        const unbanRes = await fetch(`${baseUrl}/api/admin/users/${testUser.id}/toggle-ban`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ isBanned: false })
        });
        assert.strictEqual(unbanRes.status, 200);
      }

      // 10.5 Social relationship detail and bilateral friend removal
      const socialDetailRes = await fetch(`${baseUrl}/api/admin/users/u_test_admin_user`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.strictEqual(socialDetailRes.status, 200);
      const socialDetail = await socialDetailRes.json();
      assert.ok(socialDetail.friends.some(f => f.friend_id === 'u_test_admin_friend'));
      assert.ok(socialDetail.outgoingRequests.some(r => r.id === 'freq_test_admin'));
      assert.ok(socialDetail.groups.some(c => c.id === 'dm_test_admin_social'));
      assert.ok(socialDetail.recentMessages.some(m => m.content === '后台聊天记录测试'));

      const removeFriendRes = await fetch(`${baseUrl}/api/admin/users/u_test_admin_user/friends/u_test_admin_friend`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.strictEqual(removeFriendRes.status, 200);

      const firstDetailAfterRemove = await fetch(`${baseUrl}/api/admin/users/u_test_admin_user`, {
        headers: { Authorization: `Bearer ${token}` }
      }).then(r => r.json());
      const secondDetailAfterRemove = await fetch(`${baseUrl}/api/admin/users/u_test_admin_friend`, {
        headers: { Authorization: `Bearer ${token}` }
      }).then(r => r.json());
      assert.ok(!firstDetailAfterRemove.friends.some(f => f.friend_id === 'u_test_admin_friend'));
      assert.ok(!secondDetailAfterRemove.friends.some(f => f.friend_id === 'u_test_admin_user'));

      const acceptRequestRes = await fetch(`${baseUrl}/api/admin/friend-requests/freq_test_admin_pending/respond`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ action: 'accept' })
      });
      assert.strictEqual(acceptRequestRes.status, 200);
      const acceptRequestData = await acceptRequestRes.json();
      assert.strictEqual(acceptRequestData.action, 'accepted');

      const firstDetailAfterAccept = await fetch(`${baseUrl}/api/admin/users/u_test_admin_user`, {
        headers: { Authorization: `Bearer ${token}` }
      }).then(r => r.json());
      const secondDetailAfterAccept = await fetch(`${baseUrl}/api/admin/users/u_test_admin_newfriend`, {
        headers: { Authorization: `Bearer ${token}` }
      }).then(r => r.json());
      assert.ok(firstDetailAfterAccept.friends.some(f => f.friend_id === 'u_test_admin_newfriend'));
      assert.ok(secondDetailAfterAccept.friends.some(f => f.friend_id === 'u_test_admin_user'));
      assert.match(acceptRequestData.conversationId, /^dm_/);
      assert.ok(firstDetailAfterAccept.groups.some(c => c.id === acceptRequestData.conversationId && c.peerId === 'u_test_admin_newfriend'));
      assert.ok(firstDetailAfterAccept.recentMessages.some(m => m.conversation_id === acceptRequestData.conversationId && m.type === 'system'));

      const rejectRequestRes = await fetch(`${baseUrl}/api/admin/friend-requests/freq_test_admin_reject/respond`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ action: 'reject' })
      });
      assert.strictEqual(rejectRequestRes.status, 200);
      const rejectRequestData = await rejectRequestRes.json();
      assert.strictEqual(rejectRequestData.action, 'rejected');

      // 11. Conversations & Messages: GET /api/admin/conversations
      const convsRes = await fetch(`${baseUrl}/api/admin/conversations`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.strictEqual(convsRes.status, 200);
      const convsData = await convsRes.json();
      assert.ok(Array.isArray(convsData.conversations));

      if (convsData.conversations.length > 0) {
        const testConv = convsData.conversations[0];

        // 12. GET /api/admin/conversations/:id/messages
        const msgsRes = await fetch(`${baseUrl}/api/admin/conversations/${testConv.id}/messages`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        assert.strictEqual(msgsRes.status, 200);
        const msgsData = await msgsRes.json();
        assert.ok(Array.isArray(msgsData.messages));
      }

      // 13. Files Management: GET /api/admin/files/stats and /api/admin/files
      fs.mkdirSync(process.env.ADMIN_UPLOADS_DIR, { recursive: true });
      const attachmentName = 'admin-attachment-fixture.png';
      const attachmentBytes = Buffer.from('fastqq-admin-attachment-fixture');
      const attachmentPath = path.join(process.env.ADMIN_UPLOADS_DIR, attachmentName);
      fs.writeFileSync(attachmentPath, attachmentBytes);

      const fileStatsRes = await fetch(`${baseUrl}/api/admin/files/stats`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.strictEqual(fileStatsRes.status, 200);
      const fileStats = await fileStatsRes.json();
      assert.ok(fileStats.totalFiles !== undefined);

      const filesRes = await fetch(`${baseUrl}/api/admin/files?page=1&pageSize=10`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.strictEqual(filesRes.status, 200);
      const filesData = await filesRes.json();
      assert.ok(Array.isArray(filesData.files));
      assert.ok(filesData.files.some(file => file.name === attachmentName), 'admin must list files from the real uploads directory');

      const attachmentRes = await fetch(`${baseUrl}/api/admin/files/content?file=${encodeURIComponent(attachmentName)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.strictEqual(attachmentRes.status, 200);
      assert.strictEqual(attachmentRes.headers.get('content-type'), 'image/png');
      assert.deepStrictEqual(Buffer.from(await attachmentRes.arrayBuffer()), attachmentBytes);

      const attachmentUnauthRes = await fetch(`${baseUrl}/api/admin/files/content?file=${encodeURIComponent(attachmentName)}`);
      assert.strictEqual(attachmentUnauthRes.status, 401);

      const traversalRes = await fetch(`${baseUrl}/api/admin/files/content?file=${encodeURIComponent('../qq_chat.db')}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.strictEqual(traversalRes.status, 400);

      const missingAttachmentRes = await fetch(`${baseUrl}/api/admin/files/content?file=missing-file.png`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.strictEqual(missingAttachmentRes.status, 404);

      fs.unlinkSync(attachmentPath);

      // 14. POST /api/admin/files/cleanup-orphaned
      const cleanOrphanRes = await fetch(`${baseUrl}/api/admin/files/cleanup-orphaned`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      assert.strictEqual(cleanOrphanRes.status, 200);

      // 15. Test Unauthenticated rejection
      const unauthRes = await fetch(`${baseUrl}/api/admin/status`);
      assert.strictEqual(unauthRes.status, 401);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });

  await t.test('Migration API validates injected dependencies', () => {
    assert.throws(
      () => createAdminServer({ migrationExporter: 'not-a-function' }),
      /migrationExporter.*function/i
    );
    assert.throws(
      () => createAdminServer({ migrationStatusReader: null }),
      /migrationStatusReader.*function/i
    );
  });

  await t.test('Migration API enforces auth and maps export results without client parameters', async () => {
    const calls = [];
    const statusCalls = [];
    let statusBehavior = () => ({ state: 'idle', phase: null });
    let exportBehavior = async () => validMigrationFixture('20260905-120000', {
      cleanupWarnings: ['测试清理警告'],
      futureMetadata: { safe: true }
    });
    const migrationExporter = (...args) => {
      calls.push(args);
      return exportBehavior();
    };
    const migrationStatusReader = (...args) => {
      statusCalls.push(args);
      return statusBehavior();
    };
    const server = createAdminServer({
      migrationExporter,
      migrationStatusReader,
      ignoredDependency: () => assert.fail('unexpected dependency access')
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const token = createSessionToken().token;
    const authHeaders = { Authorization: `Bearer ${token}` };

    try {
      const unauthenticatedStatus = await fetch(`${baseUrl}/api/admin/migration/status`);
      assert.strictEqual(unauthenticatedStatus.status, 401);
      const unauthenticatedExport = await fetch(`${baseUrl}/api/admin/migration/export`, { method: 'POST' });
      assert.strictEqual(unauthenticatedExport.status, 401);
      assert.strictEqual(calls.length, 0, 'unauthenticated requests must not start an export');
      assert.strictEqual(statusCalls.length, 0, 'unauthenticated requests must not read status');

      const wrongStatusMethod = await fetch(`${baseUrl}/api/admin/migration/status`, {
        method: 'POST',
        headers: authHeaders
      });
      assert.strictEqual(wrongStatusMethod.status, 404);
      const wrongExportMethod = await fetch(`${baseUrl}/api/admin/migration/export`, {
        headers: authHeaders
      });
      assert.strictEqual(wrongExportMethod.status, 404);
      assert.strictEqual(calls.length, 0, 'wrong methods must not start an export');

      const statusResponse = await fetch(`${baseUrl}/api/admin/migration/status`, {
        headers: authHeaders
      });
      assert.strictEqual(statusResponse.status, 200);
      assert.deepStrictEqual(await statusResponse.json(), { state: 'idle', phase: null });
      assert.deepStrictEqual(statusCalls, [[]], 'status reader must receive no client-controlled parameters');
      assert.strictEqual(calls.length, 0, 'reading status must not start an export');

      const successResponse = await fetch(`${baseUrl}/api/admin/migration/export`, {
        method: 'POST',
        headers: {
          ...authHeaders,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          rootDir: 'C:\\Windows',
          dbPath: 'C:\\sensitive.db',
          distDir: 'C:\\Temp',
          now: '1999-01-01',
          password: 'must-not-be-logged'
        })
      });
      assert.strictEqual(successResponse.status, 200);
      const successJson = await successResponse.json();
      assert.strictEqual(successJson.success, true);
      assert.strictEqual(successJson.migration.attachmentCount, 3);
      assert.strictEqual(successJson.migration.attachmentBytes, 4567);
      assert.deepStrictEqual(successJson.migration.cleanupWarnings, ['测试清理警告']);
      assert.deepStrictEqual(successJson.migration.futureMetadata, { safe: true }, 'safe future fields should be preserved');
      assert.deepStrictEqual(calls, [[]], 'exporter must be called exactly once and without client parameters');

      const localStatusResponse = await fetch(`${baseUrl}/api/admin/migration/status`, {
        headers: { 'X-Linkey-Local': '1' }
      });
      assert.strictEqual(localStatusResponse.status, 200, 'trusted loopback manager header should pass authentication');

      const localMigration = validMigrationFixture('20260905-120001', {
        attachmentCount: 1,
        attachmentBytes: 2
      });
      exportBehavior = async () => localMigration;
      const localExportResponse = await fetch(`${baseUrl}/api/admin/migration/export`, {
        method: 'POST',
        headers: { 'X-Linkey-Local': '1' }
      });
      assert.strictEqual(localExportResponse.status, 200, 'trusted loopback manager should be able to export');
      assert.deepStrictEqual(calls.at(-1), []);

      const legacyLocalStatusResponse = await fetch(`${baseUrl}/api/admin/migration/status`, {
        headers: { 'X-FastQQ-Local': '1' }
      });
      assert.strictEqual(legacyLocalStatusResponse.status, 200, 'legacy manager header remains compatible on direct loopback');

      const publicHostStatus = await requestStatus(`${baseUrl}/api/admin/migration/status`, {
        headers: { 'X-Linkey-Local': '1', Host: 'linkey.example.com' }
      });
      assert.strictEqual(publicHostStatus, 401, 'local trust must reject a public Host');

      for (const untrustedHeaders of [
        { Forwarded: 'for=203.0.113.10' },
        { 'X-Forwarded-For': '203.0.113.10' },
        { 'X-Forwarded-Host': 'linkey.example.com' },
        { 'X-Forwarded-Proto': 'https' },
        { 'X-Real-IP': '203.0.113.10' },
        { Via: '1.1 reverse-proxy' }
      ]) {
        const proxiedResponse = await fetch(`${baseUrl}/api/admin/migration/status`, {
          headers: { 'X-Linkey-Local': '1', ...untrustedHeaders }
        });
        assert.strictEqual(proxiedResponse.status, 401, `local trust must reject proxy/public-host evidence: ${JSON.stringify(untrustedHeaders)}`);
      }

      const bearerThroughProxyResponse = await fetch(`${baseUrl}/api/admin/migration/status`, {
        headers: {
          ...authHeaders,
          'X-Linkey-Local': '1',
          'X-Forwarded-For': '203.0.113.10'
        }
      });
      assert.strictEqual(bearerThroughProxyResponse.status, 200, 'proxy evidence should require Bearer auth, not block valid sessions');

      exportBehavior = async () => {
        const error = new Error('已有迁移任务在进行');
        error.code = 'MIGRATION_IN_PROGRESS';
        throw error;
      };
      const busyResponse = await fetch(`${baseUrl}/api/admin/migration/export`, {
        method: 'POST',
        headers: authHeaders
      });
      assert.strictEqual(busyResponse.status, 409);
      assert.deepStrictEqual(await busyResponse.json(), {
        error: '已有迁移任务在进行',
        code: 'MIGRATION_IN_PROGRESS'
      });

      exportBehavior = async () => {
        const error = new Error('目标迁移包已存在');
        error.code = 'MIGRATION_ARCHIVE_EXISTS';
        throw error;
      };
      const archiveExistsResponse = await fetch(`${baseUrl}/api/admin/migration/export`, {
        method: 'POST',
        headers: authHeaders
      });
      assert.strictEqual(archiveExistsResponse.status, 409);
      assert.deepStrictEqual(await archiveExistsResponse.json(), {
        error: '目标迁移包已存在',
        code: 'MIGRATION_ARCHIVE_EXISTS'
      });

      exportBehavior = async () => {
        const error = new Error('unexpected exporter code');
        error.code = 'UNTRUSTED_EXPORTER_CODE';
        throw error;
      };
      const unknownCodeResponse = await fetch(`${baseUrl}/api/admin/migration/export`, {
        method: 'POST',
        headers: authHeaders
      });
      assert.strictEqual(unknownCodeResponse.status, 500);
      assert.deepStrictEqual(await unknownCodeResponse.json(), {
        error: 'unexpected exporter code',
        code: 'MIGRATION_EXPORT_FAILED'
      });

      exportBehavior = async () => {
        throw new Error('migration failed marker');
      };
      const failedResponse = await fetch(`${baseUrl}/api/admin/migration/export`, {
        method: 'POST',
        headers: authHeaders
      });
      assert.strictEqual(failedResponse.status, 500);
      assert.deepStrictEqual(await failedResponse.json(), {
        error: 'migration failed marker',
        code: 'MIGRATION_EXPORT_FAILED'
      });

      const adminLog = listLogFiles().find(file => file.name.startsWith('admin-'));
      assert.ok(readLogTail(adminLog.name, 200).lines.some(line => line.includes(`完整数据迁移包已生成: ${localMigration.fileName}`)));
      const errorLogLines = readLogTail(adminLog.name, 200).lines;
      assert.ok(errorLogLines.some(line => line.includes('migration failed marker')));
      assert.ok(!errorLogLines.some(line => line.includes('must-not-be-logged')));
      assert.ok(!errorLogLines.some(line => line.includes(token)), 'session tokens must never be written to logs');

      const circularExport = { fileName: 'Linkey-circular-export.zip' };
      circularExport.self = circularExport;
      exportBehavior = async () => circularExport;
      const circularExportResponse = await fetch(`${baseUrl}/api/admin/migration/export`, {
        method: 'POST',
        headers: authHeaders,
        signal: AbortSignal.timeout(1000)
      });
      assert.strictEqual(circularExportResponse.status, 500);
      assert.strictEqual((await circularExportResponse.json()).code, 'MIGRATION_EXPORT_FAILED');

      exportBehavior = async () => ({ fileName: 'Linkey-bigint-export.zip', size: 1n });
      const bigintExportResponse = await fetch(`${baseUrl}/api/admin/migration/export`, {
        method: 'POST',
        headers: authHeaders,
        signal: AbortSignal.timeout(1000)
      });
      assert.strictEqual(bigintExportResponse.status, 500);
      assert.strictEqual((await bigintExportResponse.json()).code, 'MIGRATION_EXPORT_FAILED');

      exportBehavior = async () => undefined;
      const undefinedExportResponse = await fetch(`${baseUrl}/api/admin/migration/export`, {
        method: 'POST',
        headers: authHeaders,
        signal: AbortSignal.timeout(1000)
      });
      assert.strictEqual(undefinedExportResponse.status, 500);
      assert.strictEqual((await undefinedExportResponse.json()).code, 'MIGRATION_EXPORT_FAILED');

      exportBehavior = async () => { throw null; };
      const nullExportResponse = await fetch(`${baseUrl}/api/admin/migration/export`, {
        method: 'POST',
        headers: authHeaders,
        signal: AbortSignal.timeout(1000)
      });
      assert.strictEqual(nullExportResponse.status, 500);
      assert.deepStrictEqual(await nullExportResponse.json(), {
        error: '完整数据迁移导出失败',
        code: 'MIGRATION_EXPORT_FAILED'
      });

      exportBehavior = async () => { throw 'string export failure'; };
      const stringExportResponse = await fetch(`${baseUrl}/api/admin/migration/export`, {
        method: 'POST',
        headers: authHeaders
      });
      assert.strictEqual(stringExportResponse.status, 500);
      assert.deepStrictEqual(await stringExportResponse.json(), {
        error: 'string export failure',
        code: 'MIGRATION_EXPORT_FAILED'
      });

      const requiredExportFields = [
        'fileName',
        'relativePath',
        'size',
        'createdAt',
        'attachmentCount',
        'attachmentBytes'
      ];
      const invalidExportResults = [
        ['empty object', {}],
        ['non-plain object', new Date('2026-09-05T04:00:00.000Z')],
        ...requiredExportFields.map(field => {
          const value = validMigrationFixture('20260905-120010');
          delete value[field];
          return [`missing ${field}`, value];
        }),
        ['filename traversal', validMigrationFixture('20260905-120011', {
          fileName: '../Linkey-完整数据迁移包-20260905-120011.zip'
        })],
        ['wrong filename', validMigrationFixture('20260905-120012', {
          fileName: 'other.zip',
          relativePath: 'dist/other.zip'
        })],
        ['relative path traversal', validMigrationFixture('20260905-120013', {
          relativePath: 'dist/../outside.zip'
        })],
        ['negative size', validMigrationFixture('20260905-120014', { size: -1 })],
        ['unsafe integer size', validMigrationFixture('20260905-120015', { size: Number.MAX_SAFE_INTEGER + 1 })],
        ['invalid createdAt', validMigrationFixture('20260905-120016', { createdAt: 'not-an-iso-date' })],
        ['fractional attachment count', validMigrationFixture('20260905-120017', { attachmentCount: 1.5 })],
        ['negative attachment bytes', validMigrationFixture('20260905-120018', { attachmentBytes: -1 })],
        ['invalid cleanup warning', validMigrationFixture('20260905-120019', { cleanupWarnings: [null] })]
      ];
      for (const [label, invalidResult] of invalidExportResults) {
        exportBehavior = async () => invalidResult;
        const invalidExportResponse = await fetch(`${baseUrl}/api/admin/migration/export`, {
          method: 'POST',
          headers: authHeaders
        });
        assert.strictEqual(invalidExportResponse.status, 500, `${label} export should fail`);
        const invalidExportJson = await invalidExportResponse.json();
        assert.strictEqual(invalidExportJson.code, 'MIGRATION_EXPORT_FAILED', `${label} should use the safe error code`);
        assert.match(invalidExportJson.error, /迁移导出结果/);
      }

      const completedStatus = {
        state: 'completed',
        phase: 'completed',
        ...validMigrationFixture('20260905-120020'),
        futureStatusMetadata: { safe: true }
      };
      statusBehavior = () => completedStatus;
      const completedStatusResponse = await fetch(`${baseUrl}/api/admin/migration/status`, { headers: authHeaders });
      assert.strictEqual(completedStatusResponse.status, 200);
      assert.deepStrictEqual(await completedStatusResponse.json(), completedStatus);

      const failedStatus = {
        state: 'failed',
        phase: 'archive',
        message: '迁移导出失败，请查看服务端日志',
        code: 'MIGRATION_EXPORT_FAILED',
        cleanupWarnings: ['temporary cleanup warning']
      };
      statusBehavior = () => failedStatus;
      const failedStatusResponse = await fetch(`${baseUrl}/api/admin/migration/status`, { headers: authHeaders });
      assert.strictEqual(failedStatusResponse.status, 200);
      assert.deepStrictEqual(await failedStatusResponse.json(), failedStatus);

      const invalidStatusResults = [
        ['null', null],
        ['number', 42],
        ['string', 'idle'],
        ['array', []],
        ['empty object', {}],
        ['invalid state', { state: 'unknown', phase: null }],
        ['invalid phase', { state: 'running', phase: 'compressing' }],
        ['completed without result', { state: 'completed', phase: 'completed' }],
        ['completed with malformed result', { state: 'completed', phase: 'completed', ...validMigrationFixture('20260905-120021', { size: -1 }) }],
        ['failed without message', { state: 'failed', phase: 'archive', code: 'MIGRATION_EXPORT_FAILED' }],
        ['failed without code', { state: 'failed', phase: 'archive', message: 'failed' }],
        ['non-string message', { state: 'failed', phase: 'archive', message: 3, code: 'MIGRATION_EXPORT_FAILED' }],
        ['non-string code', { state: 'failed', phase: 'archive', message: 'failed', code: 3 }],
        ['invalid cleanup warnings', { state: 'running', phase: 'snapshot', cleanupWarnings: [false] }],
        ['invalid nested result', { state: 'running', phase: 'snapshot', result: {} }]
      ];
      for (const [label, invalidStatus] of invalidStatusResults) {
        statusBehavior = () => invalidStatus;
        const invalidStatusResponse = await fetch(`${baseUrl}/api/admin/migration/status`, { headers: authHeaders });
        assert.strictEqual(invalidStatusResponse.status, 500, `${label} status should fail`);
        assert.match((await invalidStatusResponse.json()).error, /迁移状态/);
      }

      for (const [label, behavior, expectedMessage] of [
        ['circular', () => { const value = { state: 'running' }; value.self = value; return value; }, null],
        ['bigint', () => ({ state: 'running', progress: 1n }), null],
        ['undefined', () => undefined, null],
        ['null throw', () => { throw null; }, '服务器内部异常: 未知错误'],
        ['string throw', () => { throw 'string status failure'; }, '服务器内部异常: string status failure']
      ]) {
        statusBehavior = behavior;
        const invalidStatusResponse = await fetch(`${baseUrl}/api/admin/migration/status`, {
          headers: authHeaders,
          signal: AbortSignal.timeout(1000)
        });
        assert.strictEqual(invalidStatusResponse.status, 500, `${label} status should fail safely`);
        const invalidStatusJson = await invalidStatusResponse.json();
        if (expectedMessage) assert.strictEqual(invalidStatusJson.error, expectedMessage);
      }

      const finalLogLines = readLogTail(adminLog.name, 500).lines;
      assert.ok(!finalLogLines.some(line => line.includes('完整数据迁移包已生成: Linkey-circular-export.zip')));
      assert.ok(!finalLogLines.some(line => line.includes('完整数据迁移包已生成: Linkey-bigint-export.zip')));
      assert.ok(!finalLogLines.some(line => line.includes('完整数据迁移包已生成: undefined')));
    } finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

  await t.test('Migration API preserves a pending export response while a concurrent request gets 409', async () => {
    let firstResolve;
    let callCount = 0;
    const firstResult = validMigrationFixture('20260905-120030', {
      attachmentCount: 8,
      attachmentBytes: 9000,
      cleanupWarnings: ['late cleanup warning']
    });
    const migrationExporter = () => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise(resolve => {
          firstResolve = resolve;
        });
      }
      const error = new Error('迁移导出正在进行');
      error.code = 'MIGRATION_IN_PROGRESS';
      throw error;
    };
    const server = createAdminServer({
      migrationExporter,
      migrationStatusReader: () => ({ state: 'running', phase: 'snapshot' })
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: `Bearer ${createSessionToken().token}` };

    try {
      const firstRequest = fetch(`${baseUrl}/api/admin/migration/export`, { method: 'POST', headers });
      for (let attempt = 0; callCount === 0 && attempt < 100; attempt += 1) {
        await new Promise(resolve => setImmediate(resolve));
      }
      assert.strictEqual(callCount, 1, 'first export request should reach the injected exporter');

      const secondResponse = await fetch(`${baseUrl}/api/admin/migration/export`, { method: 'POST', headers });
      assert.strictEqual(secondResponse.status, 409);
      assert.strictEqual((await secondResponse.json()).code, 'MIGRATION_IN_PROGRESS');

      firstResolve(firstResult);
      const firstResponse = await firstRequest;
      assert.strictEqual(firstResponse.status, 200);
      const firstJson = await firstResponse.json();
      assert.strictEqual(firstJson.migration.attachmentCount, 8);
      assert.strictEqual(firstJson.migration.attachmentBytes, 9000);
      assert.deepStrictEqual(firstJson.migration.cleanupWarnings, ['late cleanup warning']);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
