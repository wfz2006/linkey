# Linkey Full-Data Server Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a one-click Linkey server migration archive that preserves accounts, relationships, chats, images, files, and the admin password while invalidating old admin sessions.

**Architecture:** A new `admin/migration.js` service prepares an allowlisted server staging tree, creates an online SQLite snapshot, validates referenced attachments, rewrites the copied admin configuration with a new session secret, writes a SHA-256 manifest, and invokes a focused PowerShell ZIP helper. Authenticated admin API routes expose export and status; the web dashboard and Windows manager call those routes. The existing clean-server package remains unchanged.

**Tech Stack:** Node.js 24 built-ins (`node:sqlite`, `fs`, `crypto`, `child_process`), Windows PowerShell/.NET `System.IO.Compression`, vanilla browser JavaScript, C# WinForms/.NET Framework 4, Node test runner, Python `unittest`.

**Repository note:** `D:\software` is not a Git repository. The commit checkpoints below are verification checkpoints only; do not initialize Git or modify unrelated files.

---

## File Map

- Create `admin/migration.js`: migration state machine, snapshot, staging, validation, manifest, archive orchestration.
- Create `scripts/create-migration-archive.ps1`: create and verify a ZIP from a prepared staging directory.
- Create `tests/migration.test.js`: isolated migration service tests using temporary databases and attachments.
- Modify `admin/admin.js`: authenticated migration export and status endpoints.
- Modify `admin/public/index.html`: full-data migration panel in the backup tab.
- Modify `admin/public/panel.js`: export confirmation, progress polling, and result rendering.
- Modify `admin/public/panel.css`: migration status and privacy-warning presentation.
- Modify `src_manager/FastQQServerManager.cs`: manager tool card and local API call.
- Modify `scripts/server_package.py`: include the runtime archive helper in clean and full server packages.
- Modify `scripts/check-server-environment.ps1`: validate migrated database and manifest, with optional deep attachment hashing.
- Modify `docs/新电脑服务器部署说明.txt`: document clean versus full-data migration workflows.
- Modify `README.md`: document the new export action and output filename.
- Modify `tests/test_server_package.py`: assert that runtime migration tooling ships in server packages.

---

### Task 1: Define the migration staging contract with failing tests

**Files:**
- Create: `tests/migration.test.js`
- Create: `admin/migration.js`

- [ ] **Step 1: Write a temporary-project fixture and the first failing staging test**

Create a fixture with a real SQLite database, copied server files, an admin config, one image, and one file attachment:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { prepareMigrationStaging } from '../admin/migration.js';

function write(root, relative, data = 'fixture') {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linkey-migration-'));
  for (const relative of [
    'admin/admin.js', 'src/server.js', 'public/index.html', 'package.json',
    'README.md', 'admin-start.cmd', 'admin-stop.cmd', 'start.bat',
    '开启外网联机.cmd', 'scripts/create-migration-archive.ps1',
    'scripts/check-server-environment.ps1', 'docs/新电脑服务器部署说明.txt',
    'Linkey-服务端管理系统.exe'
  ]) write(root, relative);

  write(root, 'uploads/photo.png', Buffer.from('image'));
  write(root, 'uploads/report.txt', Buffer.from('document'));
  write(root, 'admin-config.json', JSON.stringify({
    passwordHash: 'preserved-hash', sessionSecret: 'old-session-secret', adminPort: 3001
  }));
  write(root, 'public-url.json', '{"publicUrl":"temporary"}');
  write(root, 'logs/app.log');
  write(root, 'backups/old.db');
  write(root, 'scripts/apk-signing-key.pem');

  const dbPath = path.join(root, 'qq_chat.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE messages (id INTEGER PRIMARY KEY, type TEXT, content TEXT);
    INSERT INTO messages(type, content) VALUES
      ('text', 'hello'),
      ('image', '/uploads/photo.png'),
      ('file', '/uploads/report.txt');
  `);
  db.close();
  return { root, dbPath };
}

test('prepareMigrationStaging preserves business data and excludes transient data', async t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const result = await prepareMigrationStaging({
    rootDir: fixture.root,
    dbPath: fixture.dbPath,
    now: new Date('2026-09-04T08:09:10Z')
  });
  t.after(() => fs.rmSync(result.tempDir, { recursive: true, force: true }));

  assert.equal(fs.existsSync(path.join(result.packageRoot, 'qq_chat.db')), true);
  assert.equal(fs.existsSync(path.join(result.packageRoot, 'uploads/photo.png')), true);
  assert.equal(fs.existsSync(path.join(result.packageRoot, 'uploads/report.txt')), true);
  assert.equal(fs.existsSync(path.join(result.packageRoot, 'public-url.json')), false);
  assert.equal(fs.existsSync(path.join(result.packageRoot, 'logs/app.log')), false);
  assert.equal(fs.existsSync(path.join(result.packageRoot, 'backups/old.db')), false);
  assert.equal(fs.existsSync(path.join(result.packageRoot, 'scripts/apk-signing-key.pem')), false);
});
```

- [ ] **Step 2: Run the focused test and confirm the missing-module failure**

Run: `node --test tests/migration.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `admin/migration.js`.

- [ ] **Step 3: Add the staging module constants and allowlist copy helpers**

Implement these public contracts in `admin/migration.js`:

```js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_ROOT_DIR = path.resolve(MODULE_DIR, '..');
export const MIGRATION_ROOT_NAME = 'Linkey-完整数据服务器';
export const SOURCE_TREES = ['admin', 'src', 'public'];
export const ROOT_FILES = [
  'package.json', 'README.md', 'admin-start.cmd', 'admin-stop.cmd',
  'start.bat', '开启外网联机.cmd', 'app.ico'
];
export const RUNTIME_FILES = [
  ['scripts/create-migration-archive.ps1', 'scripts/create-migration-archive.ps1'],
  ['scripts/check-server-environment.ps1', '检查服务器环境.ps1'],
  ['docs/新电脑服务器部署说明.txt', '新电脑服务器部署说明.txt']
];
export const SKIPPED_PREFIXES = ['public/downloads/', 'public/uploads/'];
export const SKIPPED_FILES = new Set(['public/public-url.json', 'public-url.json']);
export const SKIPPED_PARTS = new Set([
  '.git', '.superpowers', '__pycache__', 'tests', 'test-logs', 'logs',
  'backups', 'dist'
]);

function copyFile(rootDir, packageRoot, sourceRelative, destinationRelative = sourceRelative) {
  const source = path.join(rootDir, sourceRelative);
  if (!fs.existsSync(source)) return false;
  const destination = path.join(packageRoot, destinationRelative);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  return true;
}

function shouldCopy(relative) {
  const normalized = relative.replaceAll('\\', '/');
  if (SKIPPED_FILES.has(normalized)) return false;
  if (SKIPPED_PREFIXES.some(prefix => normalized.startsWith(prefix))) return false;
  return !normalized.split('/').some(part => SKIPPED_PARTS.has(part));
}

function copyTree(rootDir, packageRoot, treeName) {
  const sourceRoot = path.join(rootDir, treeName);
  if (!fs.existsSync(sourceRoot)) return;
  for (const entry of fs.readdirSync(sourceRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const source = path.join(entry.parentPath, entry.name);
    const relative = path.relative(rootDir, source);
    if (shouldCopy(relative)) copyFile(rootDir, packageRoot, relative);
  }
}
```

`prepareMigrationStaging()` must create an OS temporary directory, copy the allowlisted trees and root files, find the manager executable at either the project root or `dist/Linkey-服务端管理系统.exe`, and create empty `logs/` and `backups/` directories.

- [ ] **Step 4: Run the focused test and confirm that it now reaches snapshot handling**

Run: `node --test tests/migration.test.js`

Expected: FAIL because `qq_chat.db`, `uploads`, configuration rewrite, and manifest creation are not implemented yet.

- [ ] **Step 5: Verification checkpoint**

Record that the test fails for the intended unimplemented behavior. Do not initialize Git.

---

### Task 2: Implement consistent database snapshot and attachment validation

**Files:**
- Modify: `admin/migration.js`
- Modify: `tests/migration.test.js`

- [ ] **Step 1: Add failing assertions for snapshot integrity and missing attachments**

Add tests that open the staged database read-only, verify `PRAGMA integrity_check`, and require a missing referenced attachment to reject without producing a package root:

```js
test('snapshot is valid and production database is not rewritten', async t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const before = fs.statSync(fixture.dbPath).mtimeMs;
  const result = await prepareMigrationStaging({ rootDir: fixture.root, dbPath: fixture.dbPath });
  t.after(() => fs.rmSync(result.tempDir, { recursive: true, force: true }));
  const staged = new DatabaseSync(path.join(result.packageRoot, 'qq_chat.db'), { readOnly: true });
  assert.equal(Object.values(staged.prepare('PRAGMA integrity_check').get())[0], 'ok');
  staged.close();
  assert.equal(fs.statSync(fixture.dbPath).mtimeMs, before);
});

test('missing referenced attachment aborts staging', async t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.rmSync(path.join(fixture.root, 'uploads/photo.png'));
  await assert.rejects(
    prepareMigrationStaging({ rootDir: fixture.root, dbPath: fixture.dbPath }),
    /缺少聊天附件.*photo\.png/
  );
});
```

- [ ] **Step 2: Run the tests and verify both new assertions fail**

Run: `node --test tests/migration.test.js`

Expected: FAIL for absent snapshot and absent missing-attachment validation.

- [ ] **Step 3: Implement snapshot creation and reference extraction**

Use Node 24's online backup API and validate the copied database:

```js
async function createSnapshot(dbPath, destination) {
  if (!fs.existsSync(dbPath)) throw new Error('主数据库文件不存在');
  const source = new DatabaseSync(dbPath, { readOnly: true });
  try {
    await backup(source, destination);
  } finally {
    source.close();
  }
  const snapshot = new DatabaseSync(destination, { readOnly: true });
  try {
    const integrity = Object.values(snapshot.prepare('PRAGMA integrity_check').get())[0];
    if (integrity !== 'ok') throw new Error(`数据库快照完整性检查失败: ${integrity}`);
  } finally {
    snapshot.close();
  }
}

function referencedAttachments(snapshotPath) {
  const db = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    const table = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='messages'"
    ).get();
    if (!table) return [];
    return db.prepare("SELECT content FROM messages WHERE type IN ('image', 'file')")
      .all()
      .map(row => String(row.content || '').split('?')[0])
      .filter(value => value.startsWith('/uploads/'))
      .map(value => decodeURIComponent(value.slice('/uploads/'.length)))
      .filter(value => value && !value.includes('..') && !path.isAbsolute(value));
  } finally {
    db.close();
  }
}
```

Copy the entire root `uploads/` directory after verifying every normalized referenced path exists and resolves inside that directory. Throw `缺少聊天附件: <relative>` on the first missing reference. Always remove the temporary staging directory when preparation throws.

- [ ] **Step 4: Run the focused tests**

Run: `node --test tests/migration.test.js`

Expected: snapshot, isolation, and missing-attachment tests PASS.

- [ ] **Step 5: Verification checkpoint**

Record focused test output. Do not initialize Git.

---

### Task 3: Rewrite admin security state and generate the migration manifest

**Files:**
- Modify: `admin/migration.js`
- Modify: `tests/migration.test.js`

- [ ] **Step 1: Add failing configuration and manifest tests**

```js
test('migration preserves password hash but rotates the session secret', async t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = await prepareMigrationStaging({ rootDir: fixture.root, dbPath: fixture.dbPath });
  t.after(() => fs.rmSync(result.tempDir, { recursive: true, force: true }));
  const config = JSON.parse(fs.readFileSync(path.join(result.packageRoot, 'admin-config.json')));
  assert.equal(config.passwordHash, 'preserved-hash');
  assert.notEqual(config.sessionSecret, 'old-session-secret');
  assert.match(config.sessionSecret, /^[a-f0-9]{64}$/);
});

test('manifest hashes database and every attachment', async t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = await prepareMigrationStaging({ rootDir: fixture.root, dbPath: fixture.dbPath });
  t.after(() => fs.rmSync(result.tempDir, { recursive: true, force: true }));
  const manifest = JSON.parse(fs.readFileSync(path.join(result.packageRoot, '迁移清单.json')));
  assert.equal(manifest.formatVersion, 1);
  assert.match(manifest.database.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(manifest.attachments.map(item => item.path).sort(), [
    'uploads/photo.png', 'uploads/report.txt'
  ]);
  assert.equal(manifest.attachments.every(item => /^[a-f0-9]{64}$/.test(item.sha256)), true);
});
```

- [ ] **Step 2: Run tests and verify the new assertions fail**

Run: `node --test tests/migration.test.js`

Expected: FAIL because copied config still has the old secret and `迁移清单.json` does not exist.

- [ ] **Step 3: Implement configuration rewrite and SHA-256 manifest creation**

```js
function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function copyAdminConfig(rootDir, packageRoot) {
  const source = path.join(rootDir, 'admin-config.json');
  if (!fs.existsSync(source)) return { hasAdminPassword: false };
  const config = JSON.parse(fs.readFileSync(source, 'utf8'));
  config.sessionSecret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(
    path.join(packageRoot, 'admin-config.json'),
    JSON.stringify(config, null, 2),
    'utf8'
  );
  return { hasAdminPassword: Boolean(config.passwordHash) };
}
```

Build a deterministic attachment list sorted by relative POSIX path. Each item contains `path`, `size`, and `sha256`. The manifest also contains `formatVersion: 1`, package version from `package.json`, UTC `exportedAt`, database size/hash, attachment count/total bytes, and `hasAdminPassword`; it must not contain an absolute path, Windows username, source hostname, password hash, or session secret.

- [ ] **Step 4: Run focused tests**

Run: `node --test tests/migration.test.js`

Expected: all configuration and manifest tests PASS.

- [ ] **Step 5: Verification checkpoint**

Record focused test output. Do not initialize Git.

---

### Task 4: Create and atomically publish the ZIP archive

**Files:**
- Create: `scripts/create-migration-archive.ps1`
- Modify: `admin/migration.js`
- Modify: `tests/migration.test.js`

- [ ] **Step 1: Add a failing end-to-end export test**

The test supplies a temporary `distDir`, invokes `exportFullMigration()`, asserts a timestamped ZIP exists, and checks task status returns the same result:

```js
import { exportFullMigration, getMigrationStatus, resetMigrationStateForTests } from '../admin/migration.js';

test('export publishes one verified archive and reports status', async t => {
  resetMigrationStateForTests();
  const fixture = createFixture();
  const distDir = path.join(fixture.root, 'dist-output');
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const result = await exportFullMigration({
    rootDir: fixture.root,
    dbPath: fixture.dbPath,
    distDir,
    now: new Date('2026-09-04T08:09:10Z')
  });
  assert.equal(result.fileName, 'Linkey-完整数据迁移包-20260904-080910.zip');
  assert.equal(fs.existsSync(path.join(distDir, result.fileName)), true);
  assert.equal(result.size > 0, true);
  assert.equal(getMigrationStatus().state, 'completed');
});
```

- [ ] **Step 2: Run the test and verify export is not implemented**

Run: `node --test tests/migration.test.js`

Expected: FAIL for missing `exportFullMigration` or missing archive helper.

- [ ] **Step 3: Implement the PowerShell archive helper**

Create `scripts/create-migration-archive.ps1` with explicit resolved-path checks and .NET ZIP verification:

```powershell
param(
    [Parameter(Mandatory = $true)][string]$SourceDirectory,
    [Parameter(Mandatory = $true)][string]$OutputFile
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$source = [IO.Path]::GetFullPath($SourceDirectory)
$output = [IO.Path]::GetFullPath($OutputFile)
if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw "迁移暂存目录不存在: $source"
}
if ([IO.Path]::GetExtension($output) -ne '.zip') {
    throw '迁移输出必须为 ZIP 文件'
}
$parent = Split-Path -Parent $output
[IO.Directory]::CreateDirectory($parent) | Out-Null
if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }

[IO.Compression.ZipFile]::CreateFromDirectory(
    $source,
    $output,
    [IO.Compression.CompressionLevel]::Optimal,
    $false
)
$archive = [IO.Compression.ZipFile]::OpenRead($output)
try {
    $names = @($archive.Entries | ForEach-Object FullName)
    if (-not ($names -contains 'Linkey-完整数据服务器/qq_chat.db')) {
        throw '迁移 ZIP 缺少 qq_chat.db'
    }
    if (-not ($names -contains 'Linkey-完整数据服务器/迁移清单.json')) {
        throw '迁移 ZIP 缺少迁移清单.json'
    }
    [pscustomobject]@{ entryCount = $names.Count; size = (Get-Item $output).Length } |
        ConvertTo-Json -Compress
} finally {
    $archive.Dispose()
}
```

- [ ] **Step 4: Implement the migration state machine and atomic rename**

`exportFullMigration(options)` must:

1. Reject while `state === 'running'` with error code `MIGRATION_IN_PROGRESS`.
2. Set phases `snapshot`, `attachments`, `manifest`, `archive`, `verify`, then `completed`.
3. Prepare staging with `prepareMigrationStaging()`.
4. Invoke PowerShell using `spawn('powershell.exe', args, { windowsHide: true })` without shell interpolation.
5. Write to `<final>.partial`, verify the helper exits zero and returns JSON, then use `fs.renameSync(partial, final)`.
6. Return `{ fileName, relativePath: 'dist/<name>', size, createdAt, attachmentCount, attachmentBytes }`.
7. On failure, set `state: 'failed'`, delete staging and `.partial`, and preserve existing completed ZIP files.
8. Always delete staging in `finally`.

Expose a test-only `resetMigrationStateForTests()` that resets in-memory status and is never called by production routes.

- [ ] **Step 5: Add and verify the concurrency test**

Inject an `archiveRunner` option that returns a controllable promise. Call `exportFullMigration()` twice before resolving the first promise and assert the second rejects with `MIGRATION_IN_PROGRESS`.

Run: `node --test tests/migration.test.js`

Expected: all staging, archive, cleanup, status, and concurrency tests PASS.

- [ ] **Step 6: Verification checkpoint**

Record focused test output. Do not initialize Git.

---

### Task 5: Expose authenticated migration API endpoints

**Files:**
- Modify: `admin/admin.js`
- Modify: `tests/admin.test.js`

- [ ] **Step 1: Add failing API tests with an injected migration exporter**

Extend `createAdminServer()` to accept optional dependencies without changing the default call sites:

```js
const server = createAdminServer({
  migrationExporter: async () => ({
    fileName: 'Linkey-完整数据迁移包-20260904-080910.zip',
    relativePath: 'dist/Linkey-完整数据迁移包-20260904-080910.zip',
    size: 1234,
    createdAt: '2026-09-04T08:09:10.000Z'
  }),
  migrationStatusReader: () => ({ state: 'completed', phase: 'completed' })
});
```

Assert unauthenticated remote-style requests return 401, authenticated `POST /api/admin/migration/export` returns 200, `GET /api/admin/migration/status` returns status, and `MIGRATION_IN_PROGRESS` maps to HTTP 409.

- [ ] **Step 2: Run the focused admin tests and verify route failures**

Run: `node --test tests/admin.test.js`

Expected: FAIL with 404 for both migration routes.

- [ ] **Step 3: Add imports, dependency defaults, and routes**

```js
import { exportFullMigration, getMigrationStatus } from './migration.js';

export function createAdminServer(dependencies = {}) {
  const migrationExporter = dependencies.migrationExporter || exportFullMigration;
  const migrationStatusReader = dependencies.migrationStatusReader || getMigrationStatus;
  // existing server creation follows
}
```

Inside the existing authenticated `/api/admin/*` block:

```js
if (pathname === '/api/admin/migration/status' && req.method === 'GET') {
  return sendJson(res, 200, migrationStatusReader());
}

if (pathname === '/api/admin/migration/export' && req.method === 'POST') {
  try {
    const migration = await migrationExporter();
    writeLog('admin', `完整数据迁移包已生成: ${migration.fileName}`);
    return sendJson(res, 200, { success: true, migration });
  } catch (error) {
    const status = error.code === 'MIGRATION_IN_PROGRESS' ? 409 : 500;
    writeLog('admin-err', `完整数据迁移导出失败: ${error.message}`, true);
    return sendJson(res, status, { error: error.message, code: error.code || 'MIGRATION_EXPORT_FAILED' });
  }
}
```

- [ ] **Step 4: Run admin and migration tests**

Run: `node --test tests/admin.test.js tests/migration.test.js`

Expected: all tests PASS, including authentication and 409 mapping.

- [ ] **Step 5: Verification checkpoint**

Record focused test output. Do not initialize Git.

---

### Task 6: Add the web dashboard export experience

**Files:**
- Modify: `admin/public/index.html`
- Modify: `admin/public/panel.js`
- Modify: `admin/public/panel.css`
- Modify: `tests/admin-ui.test.js`

- [ ] **Step 1: Add failing DOM-source assertions**

```js
test('full-data migration UI has one export binding and privacy warning', () => {
  const html = fs.readFileSync(path.join(ROOT, '../admin/public/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, '../admin/public/panel.js'), 'utf8');
  assert.match(html, /id="btnExportMigration"/);
  assert.match(html, /账号、聊天记录、图片和文件/);
  assert.equal((js.match(/btnExportMigration.*addEventListener/g) || []).length, 1);
  assert.match(js, /\/api\/admin\/migration\/export/);
  assert.match(js, /\/api\/admin\/migration\/status/);
});
```

- [ ] **Step 2: Run UI test and verify it fails**

Run: `node --test tests/admin-ui.test.js`

Expected: FAIL because the migration controls do not exist.

- [ ] **Step 3: Add the migration card to the backup tab**

Insert before the existing backup table:

```html
<div class="migration-export-card">
  <div>
    <h3>完整数据服务器迁移</h3>
    <p>包含账号、好友、群聊、聊天记录、图片和文件；请妥善保管迁移包。</p>
    <div id="migrationExportStatus" class="migration-export-status">尚未导出</div>
  </div>
  <button id="btnExportMigration" class="btn-primary">
    <span>导出完整迁移包</span>
  </button>
</div>
```

Style the card with the existing glass variables, a violet/cyan accent border, wrapping layout under 720px, and visible `running`, `completed`, and `failed` status classes.

- [ ] **Step 4: Implement confirmation, disabled state, export call, and status polling**

Add these functions to `panel.js`:

```js
function renderMigrationStatus(status) {
  var target = document.getElementById('migrationExportStatus');
  var button = document.getElementById('btnExportMigration');
  if (!target || !button) return;
  var stateName = status.state || 'idle';
  target.className = 'migration-export-status ' + stateName;
  button.disabled = stateName === 'running';
  if (stateName === 'running') target.textContent = '正在生成：' + (status.phaseLabel || status.phase || '准备中');
  else if (stateName === 'completed' && status.result) {
    target.textContent = '已生成 ' + status.result.fileName + ' · ' + formatBytes(status.result.size);
  } else if (stateName === 'failed') target.textContent = '导出失败：' + (status.error || '未知错误');
  else target.textContent = '尚未导出';
}

function refreshMigrationStatus() {
  return fetchApi('/api/admin/migration/status').then(renderMigrationStatus);
}

function handleExportMigration() {
  confirmAction(
    '导出完整数据迁移包',
    '迁移包包含账号、聊天记录、图片和文件等隐私数据。确认生成并保存到服务器 dist 目录吗？',
    function() {
      renderMigrationStatus({ state: 'running', phaseLabel: '准备数据库快照' });
      fetchApi('/api/admin/migration/export', { method: 'POST' })
        .then(function(response) {
          renderMigrationStatus({ state: 'completed', result: response.migration });
          showToast('完整迁移包已生成：' + response.migration.fileName);
        })
        .catch(function(error) {
          renderMigrationStatus({ state: 'failed', error: error.message });
          showToast('迁移导出失败：' + error.message);
        });
    }
  );
}
```

Bind `btnExportMigration` exactly once in `bindEvents()`. Call `refreshMigrationStatus()` when the backups tab becomes active and from the existing periodic refresh while that tab is visible.

- [ ] **Step 5: Run UI and syntax tests**

Run: `node --check admin/public/panel.js`

Run: `node --test tests/admin-ui.test.js`

Expected: syntax check and UI tests PASS.

- [ ] **Step 6: Verification checkpoint**

Record focused test output. Do not initialize Git.

---

### Task 7: Add the Windows manager migration action

**Files:**
- Modify: `src_manager/FastQQServerManager.cs`
- Modify: `build-manager.cmd`
- Modify: `scripts/build_all.py`

- [ ] **Step 1: Add a manager source assertion before implementation**

Add a test in `tests/admin-ui.test.js` that reads the manager source and asserts it contains the tool-card label, the export endpoint, `X-Linkey-Local`, and `/select,` Explorer behavior.

```js
test('Windows manager exposes full-data migration action', () => {
  const source = fs.readFileSync(path.join(ROOT, '../src_manager/FastQQServerManager.cs'), 'utf8');
  assert.match(source, /完整数据迁移/);
  assert.match(source, /\/api\/admin\/migration\/export/);
  assert.match(source, /X-Linkey-Local/);
  assert.match(source, /\/select,/);
});
```

- [ ] **Step 2: Run the assertion and verify it fails**

Run: `node --test tests/admin-ui.test.js`

Expected: FAIL because the manager action is missing.

- [ ] **Step 3: Add the tool card and asynchronous API method**

Add this card in `BuildToolsView()`:

```csharp
grid.Controls.Add(CreateToolCard(
    "完整数据迁移",
    "导出账号、聊天记录、图片和文件，可直接在新电脑启动",
    () => ExportFullMigration()
));
```

Implement `ExportFullMigration()` so it:

- Shows a Yes/No privacy confirmation.
- Uses `ThreadPool.QueueUserWorkItem` to avoid blocking WinForms.
- Sends `POST http://127.0.0.1:3001/api/admin/migration/export` with `X-Linkey-Local: 1`.
- Parses `fileName` and `relativePath` with compiled regexes.
- Calls back to the UI with `BeginInvoke`.
- On success shows the file name and opens Explorer with `/select,"<absolute path>"`.
- On HTTP 409 reports that another export is running.
- On other errors reports the response or exception without changing server state.

Use `ProcessStartInfo` with `FileName = "explorer.exe"`, a quoted `/select,` argument, and `UseShellExecute = true`; never build or execute a shell command.

- [ ] **Step 4: Ensure compiler references remain sufficient**

No new C# assemblies are required because the manager only performs HTTP and UI work. Keep the existing references in `build-manager.cmd` and `scripts/build_all.py` unchanged.

- [ ] **Step 5: Compile to a non-running verification path**

Run:

```powershell
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /target:winexe /win32icon:app.ico /out:test-logs\Linkey-服务端管理系统-迁移验收.exe /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.dll src_manager\FastQQServerManager.cs
```

Expected: exit code 0 and a non-empty EXE. Do not stop or replace a running manager during this check.

- [ ] **Step 6: Run manager source and UI tests**

Run: `node --test tests/admin-ui.test.js`

Expected: all assertions PASS.

- [ ] **Step 7: Verification checkpoint**

Record compile and test output. Do not initialize Git.

---

### Task 8: Ship migration tooling and validate restored packages

**Files:**
- Modify: `scripts/server_package.py`
- Modify: `scripts/check-server-environment.ps1`
- Modify: `tests/test_server_package.py`
- Modify: `docs/新电脑服务器部署说明.txt`
- Modify: `README.md`

- [ ] **Step 1: Add failing package and checker assertions**

In `tests/test_server_package.py`, require `scripts/create-migration-archive.ps1` in server packages and require the environment checker to reference `迁移清单.json`, `qq_chat.db`, and `-DeepMigrationCheck`.

```python
self.assertIn(
    "scripts/create-migration-archive.ps1",
    archive.namelist(),
)
self.assertIn("迁移清单.json", checker)
self.assertIn("-DeepMigrationCheck", checker)
self.assertIn("qq_chat.db", checker)
```

Normalize the archive root prefix in the first assertion using `SERVER_PACKAGE_ROOT`.

- [ ] **Step 2: Run Python tests and verify the new assertions fail**

Run: `python -m unittest tests.test_server_package -v`

Expected: FAIL because the archive helper and migration checks are not packaged.

- [ ] **Step 3: Include the runtime archive helper**

Add this mapping to `MAPPED_FILES` in `scripts/server_package.py`:

```python
("scripts/create-migration-archive.ps1", "scripts/create-migration-archive.ps1"),
```

Add the same relative path to `REQUIRED_PACKAGE_FILES` so a server package cannot silently omit future migration support.

- [ ] **Step 4: Extend the environment checker**

Add a script parameter and manifest verification:

```powershell
param([switch]$DeepMigrationCheck)

$manifestPath = Join-Path $projectRoot '迁移清单.json'
if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $databasePath = Join-Path $projectRoot 'qq_chat.db'
    if (-not (Test-Path -LiteralPath $databasePath -PathType Leaf)) {
        Write-Host '[缺少] 完整迁移包中的 qq_chat.db 不存在。'
        $failed = $true
    } elseif ((Get-FileHash -LiteralPath $databasePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $manifest.database.sha256) {
        Write-Host '[损坏] qq_chat.db 的 SHA-256 与迁移清单不一致。'
        $failed = $true
    } else {
        Write-Host '[通过] 完整迁移数据库校验通过。'
    }

    foreach ($attachment in $manifest.attachments) {
        $attachmentPath = Join-Path $projectRoot $attachment.path
        if (-not (Test-Path -LiteralPath $attachmentPath -PathType Leaf)) {
            Write-Host "[缺少] 迁移附件: $($attachment.path)"
            $failed = $true
        } elseif ($DeepMigrationCheck) {
            $actual = (Get-FileHash -LiteralPath $attachmentPath -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($actual -ne $attachment.sha256) {
                Write-Host "[损坏] 迁移附件: $($attachment.path)"
                $failed = $true
            }
        }
    }
}
```

The checker must resolve each manifest path under `$projectRoot` and reject `..` or an absolute path before reading it.

- [ ] **Step 5: Update operator documentation**

Document both packages explicitly:

- `Linkey-全新服务器迁移包.zip`: empty server, no existing accounts or chats.
- `Linkey-完整数据迁移包-时间.zip`: directly runnable copy of the existing server state.

Document the privacy warning, original admin password behavior, old-session invalidation, default validation, and optional deep check command:

```powershell
powershell -ExecutionPolicy Bypass -File .\检查服务器环境.ps1 -DeepMigrationCheck
```

- [ ] **Step 6: Run package tests**

Run: `python -m unittest tests.test_server_package -v`

Expected: all package and checker tests PASS.

- [ ] **Step 7: Verification checkpoint**

Record Python test output. Do not initialize Git.

---

### Task 9: End-to-end acceptance, build, and artifact verification

**Files:**
- Modify if required by failures: only files listed in Tasks 1-8

- [ ] **Step 1: Run syntax checks**

Run:

```powershell
node --check admin\migration.js
node --check admin\admin.js
node --check admin\public\panel.js
python -m py_compile scripts\server_package.py
```

Expected: all commands exit 0 with no syntax errors.

- [ ] **Step 2: Run all automated tests**

Run: `npm test`

Expected: all Node tests PASS with zero failures.

Run: `python -m unittest discover -s tests -p "test_*.py" -v`

Expected: all Python tests PASS with zero failures.

- [ ] **Step 3: Build all Linkey artifacts**

Run: `python scripts\build_all.py`

Expected: exit code 0 and fresh `Linkey-服务端管理系统.exe`, clients, APK, clean server package, and distribution packages.

- [ ] **Step 4: Run a real full-data export in an isolated fixture directory**

Use `tests/migration.test.js` to create a fixture with a user, friendship, direct conversation, text message, image, file, and admin config. Export the ZIP, extract it to another temporary directory, then assert:

- Database `PRAGMA integrity_check` is `ok`.
- User, friendship, conversation, and all message rows exist.
- Image and file bytes match the source.
- Admin password hash matches and session secret differs.
- Environment checker exits 0 for normal and `-DeepMigrationCheck` modes.

Expected: acceptance test PASS and all temporary files are deleted.

- [ ] **Step 5: Verify the clean package remains clean**

Run:

```powershell
python -c "from scripts.server_package import validate_clean_server_package; validate_clean_server_package('dist/Linkey-全新服务器迁移包.zip'); print('clean package OK')"
```

Expected: `clean package OK`.

- [ ] **Step 6: Verify the production export without modifying production data**

Capture `qq_chat.db` size, modification time, and SHA-256. Trigger one export through the authenticated local API or `exportFullMigration()`. Recompute the production database values and require all three to match. Open the produced archive and verify the manifest, database, attachment count, excluded paths, and new session secret behavior.

Do not delete the user's production migration archive after verification.

- [ ] **Step 7: Compile and deliver the final manager**

If no running process locks `dist\Linkey-服务端管理系统.exe`, replace it through the normal build. If it is locked, keep the verified build at `test-logs\Linkey-服务端管理系统-迁移验收.exe`, report the lock, and do not stop the user's server without authorization.

- [ ] **Step 8: Final verification checkpoint**

Report exact test counts, export filename, archive size, database hash comparison, attachment count, and excluded-data checks. Do not claim completion unless every required check has fresh passing output.
