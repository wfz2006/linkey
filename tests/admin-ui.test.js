import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readAdminAsset(name) {
  return fs.readFileSync(path.join(ROOT_DIR, 'admin', 'public', name), 'utf8');
}

function extractNamedFunction(script, name) {
  const start = script.indexOf(`function ${name}(`);
  assert.notStrictEqual(start, -1, `${name} must be declared as a named function`);
  const next = script.indexOf('\nfunction ', start + 1);
  return script.slice(start, next === -1 ? script.length : next);
}

function createMigrationDom() {
  const elements = {
    btnExportMigration: {
      disabled: false,
      textContent: '导出完整迁移包',
      className: '',
      setAttribute(name, value) { this[name] = String(value); }
    },
    migrationExportStatus: {
      textContent: '尚未开始导出',
      className: 'migration-export-status',
      dataset: {},
      setAttribute(name, value) { this[name] = String(value); }
    }
  };
  return {
    elements,
    document: {
      getElementById(id) { return elements[id] || null; }
    }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushPromises() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

function createMigrationHarness(script) {
  const dom = createMigrationDom();
  const queues = { GET: [], POST: [] };
  const apiCalls = [];
  const toasts = [];
  const timers = new Map();
  const clearedTimers = [];
  const pageHandlers = {};
  let nextTimerId = 0;
  let confirmation = null;
  const sandbox = {
    document: dom.document,
    state: {
      activeTab: 'backups',
      migrationStatusTimer: null,
      migrationStatusPending: false,
      migrationStatusPendingEpoch: null,
      migrationStatusEpoch: 0
    },
    formatBytes(bytes) { return `${bytes} B`; },
    confirmAction(title, message, onConfirm) { confirmation = { title, message, onConfirm }; },
    fetchApi(endpoint, options) {
      const method = options?.method || 'GET';
      apiCalls.push({ endpoint, method, options });
      const next = queues[method].shift();
      if (!next) return Promise.reject(Object.assign(new Error(`unexpected ${method} ${endpoint}`), { status: 500 }));
      return next;
    },
    showToast(message) { toasts.push(message); },
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      clearedTimers.push(id);
      timers.delete(id);
    },
    window: {
      addEventListener(name, callback) { pageHandlers[name] = callback; }
    }
  };
  const names = [
    'renderMigrationStatus',
    'clearMigrationStatusTimer',
    'stopMigrationStatusPolling',
    'scheduleMigrationStatusPoll',
    'refreshMigrationStatus',
    'handleExportMigration'
  ];
  vm.runInNewContext(names.map(name => extractNamedFunction(script, name)).join('\n'), sandbox);
  vm.runInNewContext("window.addEventListener('pagehide', stopMigrationStatusPolling);", sandbox);

  return {
    sandbox,
    elements: dom.elements,
    apiCalls,
    toasts,
    timers,
    clearedTimers,
    pageHandlers,
    enqueue(method, promise) { queues[method].push(promise); },
    confirm() {
      assert.ok(confirmation, 'confirmation must be open');
      confirmation.onConfirm();
    },
    get confirmation() { return confirmation; },
    runOnlyTimer() {
      assert.strictEqual(timers.size, 1, 'exactly one timer must be active');
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      if (sandbox.state.migrationStatusTimer === id) sandbox.state.migrationStatusTimer = null;
      timer.callback();
      return timer;
    }
  };
}

test('admin login and setup actions have exactly one event binding', () => {
  const html = fs.readFileSync(path.join(ROOT_DIR, 'admin', 'public', 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(ROOT_DIR, 'admin', 'public', 'panel.js'), 'utf8');

  assert.doesNotMatch(
    html,
    /id="btn(?:Login|SetupPassword)"[^>]*\sonclick=/,
    'login/setup buttons must not combine inline onclick with panel.js listeners'
  );

  assert.match(script, /btnLogin\.addEventListener\('click', handleLogin\)/);
  assert.match(script, /btnSetupPassword'[\s\S]*addEventListener\('click', handleSetupPassword\)/);
});

test('social relations modal exposes pending friend request actions', () => {
  const script = fs.readFileSync(path.join(ROOT_DIR, 'admin', 'public', 'panel.js'), 'utf8');

  assert.match(script, /btn-social-request-action/);
  assert.match(script, /\/api\/admin\/friend-requests\//);
  assert.match(script, /action:\s*'accept'/);
  assert.match(script, /action:\s*'reject'/);
});

test('admin attachment previews and downloads use authenticated blobs', () => {
  const script = fs.readFileSync(path.join(ROOT_DIR, 'admin', 'public', 'panel.js'), 'utf8');

  assert.match(script, /function fetchAdminBlob/);
  assert.match(script, /responseType\s*=\s*'blob'/);
  assert.match(script, /data-admin-file/);
  assert.match(script, /URL\.createObjectURL/);
  assert.match(script, /URL\.revokeObjectURL/);
  assert.match(script, /\/api\/admin\/files\/content\?file=/);
});

test('backup tab contains one complete migration export card before the backup table', () => {
  const html = readAdminAsset('index.html');

  assert.strictEqual((html.match(/id="btnExportMigration"/g) || []).length, 1);
  assert.strictEqual((html.match(/id="migrationExportStatus"/g) || []).length, 1);
  assert.match(html, /class="[^"]*migration-export-card[^"]*"/);
  assert.match(html, /包含账号、好友、群聊、聊天记录、图片和文件/);
  assert.match(html, /迁移包含私密数据，请妥善保管/);
  assert.match(html, />\s*导出完整迁移包\s*</);
  assert.ok(
    html.indexOf('migration-export-card') < html.indexOf('id="backupsTbody"'),
    'migration card must appear before the database backup table'
  );
});

test('migration export binds once and uses the authenticated status/export endpoints', () => {
  const script = readAdminAsset('panel.js');

  assert.strictEqual(
    (script.match(/btnExportMigration[^\n]*addEventListener\('click', handleExportMigration\)/g) || []).length,
    1,
    'export click handler must be bound exactly once'
  );
  assert.match(script, /fetchApi\('\/api\/admin\/migration\/status'\)/);
  assert.match(script, /fetchApi\('\/api\/admin\/migration\/export',\s*\{\s*method:\s*'POST'\s*\}\)/);
  assert.doesNotMatch(
    extractNamedFunction(script, 'handleExportMigration'),
    /body\s*:/,
    'migration export POST must not send a request body'
  );
});

test('migration export asks for privacy confirmation and starts status polling while POST is pending', async () => {
  const script = readAdminAsset('panel.js');
  const harness = createMigrationHarness(script);
  const pendingExport = deferred();
  harness.enqueue('POST', pendingExport.promise);

  harness.sandbox.handleExportMigration();
  assert.match(harness.confirmation.message, /私密数据/);
  assert.match(harness.confirmation.message, /dist/);
  assert.strictEqual(harness.apiCalls.length, 0, 'no request before confirmation');

  harness.confirm();
  assert.strictEqual(harness.apiCalls.length, 1);
  assert.strictEqual(harness.apiCalls[0].endpoint, '/api/admin/migration/export');
  assert.strictEqual(harness.apiCalls[0].method, 'POST');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(harness.apiCalls[0].options, 'body'), false);
  assert.strictEqual(harness.elements.btnExportMigration.disabled, true);
  assert.strictEqual(harness.timers.size, 1, 'phase polling must start while the export POST is pending');

  pendingExport.resolve({ migration: { fileName: 'Linkey-完整数据迁移包-20260907-010203.zip', size: 2048 } });
  await flushPromises();
  assert.match(harness.elements.migrationExportStatus.textContent, /Linkey-完整数据迁移包-20260907-010203\.zip/);
  assert.strictEqual(harness.elements.btnExportMigration.disabled, false);
  assert.strictEqual(harness.timers.size, 0);
  assert.match(harness.toasts.at(-1), /Linkey-完整数据迁移包-20260907-010203\.zip/);
});

test('stale status responses cannot overwrite a newer export or its completed result', async () => {
  const script = readAdminAsset('panel.js');
  const harness = createMigrationHarness(script);
  const oldIdleGet = deferred();
  const currentGet = deferred();
  const pendingExport = deferred();
  harness.enqueue('GET', oldIdleGet.promise);
  harness.enqueue('GET', currentGet.promise);
  harness.enqueue('POST', pendingExport.promise);

  harness.sandbox.refreshMigrationStatus();
  harness.sandbox.handleExportMigration();
  harness.confirm();
  harness.runOnlyTimer();

  oldIdleGet.resolve({ state: 'idle', phase: null });
  await flushPromises();
  assert.strictEqual(harness.elements.btnExportMigration.disabled, true);
  assert.doesNotMatch(harness.elements.migrationExportStatus.textContent, /尚未开始/);

  pendingExport.resolve({ migration: { fileName: 'finished.zip', size: 10 } });
  await flushPromises();
  assert.match(harness.elements.migrationExportStatus.textContent, /finished\.zip/);

  currentGet.resolve({ state: 'idle', phase: null });
  await flushPromises();
  assert.match(harness.elements.migrationExportStatus.textContent, /finished\.zip/);
  assert.strictEqual(harness.timers.size, 0);
});

test('pagehide invalidates a pending status response without rendering or restarting timers', async () => {
  const script = readAdminAsset('panel.js');
  const harness = createMigrationHarness(script);
  const lateGet = deferred();
  harness.enqueue('GET', lateGet.promise);
  harness.sandbox.refreshMigrationStatus();
  const epochBeforeHide = harness.sandbox.state.migrationStatusEpoch;

  harness.pageHandlers.pagehide();
  assert.ok(harness.sandbox.state.migrationStatusEpoch > epochBeforeHide);
  lateGet.resolve({ state: 'running', phase: 'archive' });
  await flushPromises();

  assert.match(harness.elements.migrationExportStatus.textContent, /尚未开始/);
  assert.strictEqual(harness.timers.size, 0);
});

test('status network errors retry without enabling export, while 401 stops polling', async () => {
  const script = readAdminAsset('panel.js');
  const retryHarness = createMigrationHarness(script);
  const networkGet = deferred();
  retryHarness.enqueue('GET', networkGet.promise);
  retryHarness.sandbox.renderMigrationStatus({ state: 'running', phase: 'archive' });
  retryHarness.sandbox.refreshMigrationStatus();
  const networkError = Object.assign(new Error('offline'), { status: 0, isNetworkError: true });
  networkGet.reject(networkError);
  await flushPromises();

  assert.match(retryHarness.elements.migrationExportStatus.textContent, /连接暂时中断，正在重试/);
  assert.strictEqual(retryHarness.elements.btnExportMigration.disabled, true);
  assert.strictEqual(retryHarness.timers.size, 1);

  const authHarness = createMigrationHarness(script);
  const authGet = deferred();
  authHarness.enqueue('GET', authGet.promise);
  authHarness.sandbox.renderMigrationStatus({ state: 'running', phase: 'verify' });
  authHarness.sandbox.refreshMigrationStatus();
  authGet.reject(Object.assign(new Error('expired'), { status: 401 }));
  await flushPromises();
  assert.strictEqual(authHarness.timers.size, 0);
  assert.strictEqual(authHarness.sandbox.state.migrationStatusPendingEpoch, null);
});

test('status HTTP 503 remains indeterminate and retries with one backoff timer', async () => {
  const script = readAdminAsset('panel.js');
  const harness = createMigrationHarness(script);
  const firstUnavailable = deferred();
  harness.enqueue('GET', firstUnavailable.promise);
  harness.sandbox.renderMigrationStatus({ state: 'running', phase: 'manifest' });
  harness.sandbox.refreshMigrationStatus();
  firstUnavailable.reject(Object.assign(new Error('service unavailable'), { status: 503 }));
  await flushPromises();

  assert.match(harness.elements.migrationExportStatus.textContent, /状态暂不可用，正在重试/);
  assert.strictEqual(harness.elements.btnExportMigration.disabled, true);
  assert.strictEqual(harness.timers.size, 1);
  assert.strictEqual([...harness.timers.values()][0].delay, 5000);

  const secondUnavailable = deferred();
  harness.enqueue('GET', secondUnavailable.promise);
  harness.runOnlyTimer();
  secondUnavailable.reject(Object.assign(new Error('bad gateway'), { status: 502 }));
  await flushPromises();
  assert.strictEqual(harness.timers.size, 1, 'repeated status failures must retain only one backoff timer');
  assert.strictEqual([...harness.timers.values()][0].delay, 5000);
});

test('bfcache pageshow starts a new status epoch and refreshes immediately on backups tab', async () => {
  const script = readAdminAsset('panel.js');
  const harness = createMigrationHarness(script);
  vm.runInNewContext(extractNamedFunction(script, 'handleMigrationPageShow'), harness.sandbox);
  harness.sandbox.window.addEventListener('pageshow', harness.sandbox.handleMigrationPageShow);
  harness.enqueue('GET', Promise.resolve({ state: 'idle', phase: null }));
  const oldEpoch = harness.sandbox.state.migrationStatusEpoch;

  harness.pageHandlers.pageshow({ persisted: true });
  assert.strictEqual(harness.sandbox.state.migrationStatusEpoch, oldEpoch + 1);
  assert.deepStrictEqual(harness.apiCalls.map(call => call.method), ['GET']);
  await flushPromises();
  assert.strictEqual(harness.timers.size, 0);
});

test('POST network loss confirms server status and 409 reads the live server phase', async () => {
  const script = readAdminAsset('panel.js');
  const networkHarness = createMigrationHarness(script);
  const networkPost = deferred();
  networkHarness.enqueue('POST', networkPost.promise);
  networkHarness.sandbox.handleExportMigration();
  networkHarness.confirm();
  networkPost.reject(Object.assign(new Error('response lost'), { status: 0, isNetworkError: true }));
  await flushPromises();
  assert.match(networkHarness.elements.migrationExportStatus.textContent, /正在确认服务器状态/);
  assert.strictEqual(networkHarness.elements.btnExportMigration.disabled, true);
  assert.strictEqual(networkHarness.timers.size, 1);

  const conflictHarness = createMigrationHarness(script);
  const conflictPost = deferred();
  conflictHarness.enqueue('POST', conflictPost.promise);
  conflictHarness.enqueue('GET', Promise.resolve({ state: 'running', phase: 'archive' }));
  conflictHarness.sandbox.handleExportMigration();
  conflictHarness.confirm();
  conflictPost.reject(Object.assign(new Error('busy'), { status: 409, code: 'MIGRATION_IN_PROGRESS' }));
  await flushPromises();
  assert.deepStrictEqual(conflictHarness.apiCalls.map(call => call.method), ['POST', 'GET']);
  assert.match(conflictHarness.elements.migrationExportStatus.textContent, /压缩完整迁移包/);
  assert.strictEqual(conflictHarness.elements.btnExportMigration.disabled, true);
  assert.strictEqual(conflictHarness.timers.size, 1);
});

test('migration polling keeps one timer and navigation or pagehide clears it', () => {
  const script = readAdminAsset('panel.js');
  const cleared = [];
  const scheduled = [];
  const pageHandlers = {};
  let nextTimer = 40;
  const sandbox = {
    state: {
      activeTab: 'backups',
      migrationStatusTimer: null,
      migrationStatusPending: false,
      migrationStatusPendingEpoch: null,
      migrationStatusEpoch: 0
    },
    setTimeout(callback, delay) {
      const id = ++nextTimer;
      scheduled.push({ id, callback, delay });
      return id;
    },
    clearTimeout(id) { cleared.push(id); },
    refreshMigrationStatus() {},
    forEachElement() {},
    document: { getElementById() { return null; } },
    refreshAllData() {},
    loadUsers() {},
    loadConversationsList() {},
    loadMessages() {},
    loadFilesStats() {},
    loadFilesList() {},
    refreshLogsList() {},
    refreshBackupsList() {},
    window: {
      addEventListener(name, callback) { pageHandlers[name] = callback; }
    }
  };

  vm.runInNewContext([
    extractNamedFunction(script, 'clearMigrationStatusTimer'),
    extractNamedFunction(script, 'stopMigrationStatusPolling'),
    extractNamedFunction(script, 'scheduleMigrationStatusPoll'),
    extractNamedFunction(script, 'switchTab'),
    "window.addEventListener('pagehide', stopMigrationStatusPolling);"
  ].join('\n'), sandbox);

  sandbox.scheduleMigrationStatusPoll();
  assert.strictEqual(scheduled.length, 1);
  assert.strictEqual(scheduled[0].delay, 2500);
  assert.strictEqual(sandbox.state.migrationStatusTimer, scheduled[0].id);

  sandbox.scheduleMigrationStatusPoll();
  assert.strictEqual(scheduled.length, 2, 'rescheduling creates the replacement timer');
  assert.deepStrictEqual(cleared, [scheduled[0].id], 'rescheduling clears the previous timer first');
  assert.strictEqual(sandbox.state.migrationStatusTimer, scheduled[1].id);

  sandbox.switchTab('users');
  assert.strictEqual(sandbox.state.migrationStatusTimer, null);
  assert.strictEqual(cleared.at(-1), scheduled[1].id);

  sandbox.state.activeTab = 'backups';
  sandbox.scheduleMigrationStatusPoll();
  const unloadTimer = sandbox.state.migrationStatusTimer;
  pageHandlers.pagehide();
  assert.strictEqual(sandbox.state.migrationStatusTimer, null);
  assert.strictEqual(cleared.at(-1), unloadTimer);
});

test('migration status renderer covers phases, flat and nested completion, failures, and safe cleanup warnings', () => {
  const script = readAdminAsset('panel.js');
  const renderSource = extractNamedFunction(script, 'renderMigrationStatus');
  const phaseLabels = {
    snapshot: '创建数据库快照',
    attachments: '复制聊天附件',
    manifest: '生成迁移清单',
    archive: '压缩完整迁移包',
    verify: '校验迁移包'
  };

  for (const [phase, label] of Object.entries(phaseLabels)) {
    const dom = createMigrationDom();
    const sandbox = { document: dom.document, formatBytes: bytes => `${bytes} B` };
    vm.runInNewContext(renderSource, sandbox);
    sandbox.renderMigrationStatus({ state: 'running', phase });
    assert.match(dom.elements.migrationExportStatus.textContent, new RegExp(label));
    assert.strictEqual(dom.elements.btnExportMigration.disabled, true);
  }

  for (const status of [
    { state: 'completed', fileName: 'flat.zip', size: 1024 },
    { state: 'completed', result: { fileName: 'nested.zip', size: 2048 } }
  ]) {
    const dom = createMigrationDom();
    const sandbox = { document: dom.document, formatBytes: bytes => `${bytes} B` };
    vm.runInNewContext(renderSource, sandbox);
    sandbox.renderMigrationStatus(status);
    const expectedName = status.result ? status.result.fileName : status.fileName;
    assert.match(dom.elements.migrationExportStatus.textContent, new RegExp(expectedName.replace('.', '\\.')));
    assert.strictEqual(dom.elements.btnExportMigration.disabled, false);
  }

  {
    const dom = createMigrationDom();
    const sandbox = { document: dom.document, formatBytes: bytes => `${bytes} B` };
    vm.runInNewContext(renderSource, sandbox);
    sandbox.renderMigrationStatus({
      state: 'failed',
      phase: 'archive',
      message: '压缩失败',
      cleanupWarnings: ['temporary cleanup warning']
    });
    assert.match(dom.elements.migrationExportStatus.textContent, /压缩失败/);
    assert.strictEqual(dom.elements.btnExportMigration.disabled, false);
    assert.strictEqual(dom.elements.migrationExportStatus.dataset.state, 'failed');
    assert.doesNotMatch(dom.elements.migrationExportStatus.className, /has-warning/);
  }

  {
    const dom = createMigrationDom();
    const sandbox = { document: dom.document, formatBytes: bytes => `${bytes} B` };
    vm.runInNewContext(renderSource, sandbox);
    sandbox.renderMigrationStatus({
      state: 'completed',
      fileName: 'safe.zip',
      size: 3,
      cleanupWarnings: ['D:\\Users\\private\\migration.tmp 删除失败']
    });
    assert.match(dom.elements.migrationExportStatus.textContent, /已生成，但有临时文件清理警告/);
    assert.doesNotMatch(dom.elements.migrationExportStatus.textContent, /D:\\Users\\private/);
    assert.match(dom.elements.migrationExportStatus.className, /has-warning/);
  }

  {
    const dom = createMigrationDom();
    const sandbox = { document: dom.document, formatBytes: bytes => `${bytes} B` };
    vm.runInNewContext(renderSource, sandbox);
    sandbox.renderMigrationStatus({
      state: 'failed',
      message: '压缩失败',
      cleanupWarnings: ['temporary cleanup warning']
    });
    assert.match(dom.elements.migrationExportStatus.textContent, /另有临时文件清理警告/);
    assert.doesNotMatch(dom.elements.migrationExportStatus.textContent, /已生成/);
  }

  assert.doesNotMatch(renderSource, /\.innerHTML\s*=/, 'migration status must use textContent, never innerHTML');
});

test('migration polling is scoped to the backups tab and cleaned up on navigation/unload', () => {
  const script = readAdminAsset('panel.js');

  assert.match(script, /migrationStatusTimer/);
  assert.match(script, /state\.activeTab\s*!==\s*'backups'/);
  const scheduleSource = extractNamedFunction(script, 'scheduleMigrationStatusPoll');
  assert.match(scheduleSource, /setTimeout\(function\(\)/);
  assert.match(scheduleSource, /refreshMigrationStatus\(epoch\)/);
  assert.match(scheduleSource, /},\s*delay \|\| 2500\)/);
  assert.match(extractNamedFunction(script, 'switchTab'), /refreshMigrationStatus\(\)/);
  assert.match(extractNamedFunction(script, 'switchTab'), /stopMigrationStatusPolling\(\)/);
  assert.match(script, /(?:beforeunload|pagehide)[\s\S]*stopMigrationStatusPolling/);
});

test('migration card styles expose state, keyboard, responsive, and reduced-motion affordances', () => {
  const css = readAdminAsset('panel.css');

  assert.match(css, /\.migration-export-card/);
  assert.match(css, /\.migration-export-status\[data-state="running"\]/);
  assert.match(css, /\.migration-export-status\[data-state="completed"\]/);
  assert.match(css, /\.migration-export-status\[data-state="failed"\]/);
  assert.match(css, /\.migration-export-warning/);
  assert.match(css, /\.migration-export-status\.has-warning/);
  assert.match(css, /#btnExportMigration:hover/);
  assert.match(css, /#btnExportMigration:disabled/);
  assert.match(css, /#btnExportMigration:focus-visible/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)[\s\S]*#btnExportMigration[\s\S]*width:\s*100%/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*animation:\s*none/);
});
