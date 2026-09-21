import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  MIGRATION_ROOT_NAME,
  exportFullMigration,
  getMigrationStatus,
  prepareMigrationStaging,
  resetMigrationStateForTests
} from '../admin/migration.js';

function write(root, relative, data = 'fixture') {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
}

function fileEvidence(target) {
  const stat = fs.statSync(target);
  return {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')
  };
}

function addMessage(dbPath, type, content) {
  const db = new DatabaseSync(dbPath);
  try {
    db.prepare('INSERT INTO messages(type, content) VALUES (?, ?)').run(type, content);
  } finally {
    db.close();
  }
}

async function capturePreparation(options) {
  try {
    return { result: await prepareMigrationStaging(options) };
  } catch (error) {
    return { error };
  }
}

function createFixture({ managerAtRoot = true, excludedTreeCase = 'lower' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linkey-migration-'));
  for (const relative of [
    'admin/admin.js',
    'src/server.js',
    'public/index.html',
    'README.md',
    'admin-start.cmd',
    'admin-stop.cmd',
    'start.bat',
    '开启外网联机.cmd',
    'app.ico',
    'scripts/create-migration-archive.ps1',
    'scripts/tunnel-start.mjs',
    'scripts/check-server-environment.ps1',
    'docs/新电脑服务器部署说明.txt'
  ]) {
    write(root, relative);
  }
  write(root, 'package.json', JSON.stringify({
    name: 'linkey',
    version: '9.8.7'
  }));
  write(
    root,
    managerAtRoot
      ? 'Linkey-服务端管理系统.exe'
      : 'dist/Linkey-服务端管理系统.exe'
  );

  if (excludedTreeCase === 'lower') {
    write(root, 'public/uploads/should-not-copy.png');
    write(root, 'public/downloads/should-not-copy.zip');
    write(root, 'public/public-url.json');
    write(root, 'admin/logs/should-not-copy.log');
  } else if (excludedTreeCase === 'upper') {
    write(root, 'public/Uploads/should-not-copy.png');
    write(root, 'public/Downloads/should-not-copy.zip');
    write(root, 'public/Public-Url.json');
    write(root, 'admin/LOGS/should-not-copy.log');
    write(root, 'admin/Dist/should-not-copy.exe');
  }

  write(root, 'uploads/photo.png', Buffer.from('image'));
  write(root, 'uploads/report.txt', Buffer.from('document'));
  write(root, 'uploads/compatibility.bin', Buffer.from('unreferenced'));
  write(root, 'admin-config.json', JSON.stringify({
    passwordHash: 'preserved-hash',
    sessionSecret: 'old-session-secret',
    adminPort: 3001
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

function migrationFileName(now) {
  const stamp = now.toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15);
  return `Linkey-完整数据迁移包-${stamp}.zip`;
}

function readZipEntries(zipPath) {
  const script = [
    '$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '$archive = [IO.Compression.ZipFile]::OpenRead($env:LINKEY_TEST_ZIP)',
    'try { @($archive.Entries | ForEach-Object FullName) | ConvertTo-Json -Compress } finally { $archive.Dispose() }'
  ].join('; ');
  const completed = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, LINKEY_TEST_ZIP: zipPath }
    }
  );
  assert.equal(completed.status, 0, completed.stderr);
  const parsed = JSON.parse(completed.stdout.trim());
  return Array.isArray(parsed) ? parsed : [parsed];
}

function injectedArchive(contents = Buffer.from('synthetic-archive')) {
  return async ({ outputFile }) => {
    fs.writeFileSync(outputFile, contents, { flag: 'wx' });
    return JSON.stringify({ entryCount: 7, size: contents.length });
  };
}

const ARCHIVE_HELPER_PATH = path.resolve('scripts/create-migration-archive.ps1');

function runArchiveHelper(sourceDirectory, outputFile, cwd) {
  return spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      ARCHIVE_HELPER_PATH,
      '-SourceDirectory',
      sourceDirectory,
      '-OutputFile',
      outputFile
    ],
    { cwd, encoding: 'utf8', windowsHide: true }
  );
}

function createMinimalArchiveSource(root) {
  const source = path.join(root, 'source');
  for (const relative of [
    'qq_chat.db',
    '迁移清单.json',
    'package.json',
    'start.bat',
    '检查服务器环境.ps1',
    'scripts/create-migration-archive.ps1'
  ]) {
    write(source, `${MIGRATION_ROOT_NAME}/${relative}`, relative);
  }
  return source;
}

async function prepareFixture(t, options) {
  const fixture = createFixture(options);
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const result = await prepareMigrationStaging({
    rootDir: fixture.root,
    dbPath: fixture.dbPath,
    now: new Date('2026-09-04T08:09:10Z')
  });
  t.after(() => fs.rmSync(result.tempDir, { recursive: true, force: true }));
  return { fixture, result };
}

test('prepareMigrationStaging copies the staging skeleton and remaps runtime files', async t => {
  const { result } = await prepareFixture(t, { managerAtRoot: false });

  for (const relative of [
    'admin/admin.js',
    'src/server.js',
    'public/index.html',
    'package.json',
    'README.md',
    'admin-start.cmd',
    'app.ico',
    'scripts/create-migration-archive.ps1',
    '检查服务器环境.ps1',
    '新电脑服务器部署说明.txt',
    'Linkey-服务端管理系统.exe'
  ]) {
    assert.equal(fs.existsSync(path.join(result.packageRoot, relative)), true, relative);
  }

  for (const relative of [
    'public/uploads/should-not-copy.png',
    'public/downloads/should-not-copy.zip',
    'public/public-url.json',
    'admin/logs/should-not-copy.log'
  ]) {
    assert.equal(fs.existsSync(path.join(result.packageRoot, relative)), false, relative);
  }

  for (const relative of ['logs', 'backups']) {
    const target = path.join(result.packageRoot, relative);
    assert.equal(fs.statSync(target).isDirectory(), true, relative);
    assert.deepEqual(fs.readdirSync(target), [], relative);
  }
});

test('prepareMigrationStaging excludes case-variant transient tree paths', async t => {
  const { result } = await prepareFixture(t, { excludedTreeCase: 'upper' });

  for (const relative of [
    'public/Uploads/should-not-copy.png',
    'public/Downloads/should-not-copy.zip',
    'public/Public-Url.json',
    'admin/LOGS/should-not-copy.log',
    'admin/Dist/should-not-copy.exe'
  ]) {
    assert.equal(fs.existsSync(path.join(result.packageRoot, relative)), false, relative);
  }
});

test('prepareMigrationStaging preserves business data and excludes transient data', async t => {
  const { result } = await prepareFixture(t);

  assert.equal(fs.existsSync(path.join(result.packageRoot, 'qq_chat.db')), true);
  assert.equal(fs.existsSync(path.join(result.packageRoot, 'uploads/photo.png')), true);
  assert.equal(fs.existsSync(path.join(result.packageRoot, 'uploads/report.txt')), true);
  assert.equal(fs.existsSync(path.join(result.packageRoot, 'uploads/compatibility.bin')), true);
  assert.equal(fs.existsSync(path.join(result.packageRoot, 'public-url.json')), false);
  assert.equal(fs.existsSync(path.join(result.packageRoot, 'logs/app.log')), false);
  assert.equal(fs.existsSync(path.join(result.packageRoot, 'backups/old.db')), false);
  assert.equal(fs.existsSync(path.join(result.packageRoot, 'scripts/apk-signing-key.pem')), false);
});

test('prepareMigrationStaging excludes development secrets inside source trees', async t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  for (const relative of [
    'admin/.env',
    'admin/.ENV.production',
    'admin/certificate.PEM',
    'src/server.KEY',
    'src/client.pfx',
    'src/client.P12',
    'src/release.jks',
    'src/release.keystore',
    'src/release-signing-key.txt'
  ]) {
    write(fixture.root, relative, `secret:${relative}`);
  }
  write(fixture.root, 'src/keyboard-handler.js', 'export const keyboard = true;');

  const result = await prepareMigrationStaging({ rootDir: fixture.root, dbPath: fixture.dbPath });
  t.after(() => fs.rmSync(result.tempDir, { recursive: true, force: true }));

  for (const relative of [
    'admin/.env',
    'admin/.ENV.production',
    'admin/certificate.PEM',
    'src/server.KEY',
    'src/client.pfx',
    'src/client.P12',
    'src/release.jks',
    'src/release.keystore',
    'src/release-signing-key.txt'
  ]) {
    assert.equal(fs.existsSync(path.join(result.packageRoot, relative)), false, relative);
  }
  assert.equal(fs.existsSync(path.join(result.packageRoot, 'src/keyboard-handler.js')), true);
});

test('prepareMigrationStaging fails and cleans staging when an enumerated upload disappears', async t => {
  const fixture = createFixture();
  const markerName = `copy-race-${crypto.randomUUID()}.marker`;
  write(fixture.root, path.join('admin', markerName));
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  let removed = false;

  await assert.rejects(
    prepareMigrationStaging({
      rootDir: fixture.root,
      dbPath: fixture.dbPath,
      testHooks: {
        beforeCopyUploadFile({ source }) {
          if (!removed && path.basename(source) === 'compatibility.bin') {
            removed = true;
            fs.rmSync(source);
          }
        }
      }
    }),
    /uploads.*compatibility\.bin|compatibility\.bin.*(?:不存在|变化|复制)/i
  );
  assert.equal(removed, true, 'test hook must exercise the copy race');

  const leaked = fs.readdirSync(os.tmpdir(), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('linkey-migration-staging-'))
    .map(entry => path.join(os.tmpdir(), entry.name))
    .filter(stagingDir => fs.existsSync(path.join(
      stagingDir,
      MIGRATION_ROOT_NAME,
      'admin',
      markerName
    )));
  assert.deepEqual(leaked, [], 'failed upload copy staging must be cleaned');
});

test('upload copy preserves the first business error while independently closing both handles', async t => {
  const fixture = createFixture();
  const originalWriteSync = fs.writeSync;
  const originalCloseSync = fs.closeSync;
  const primaryError = new Error('synthetic primary copy failure');
  let injected = false;
  let closeAttempts = 0;
  t.after(() => {
    fs.writeSync = originalWriteSync;
    fs.closeSync = originalCloseSync;
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  await assert.rejects(
    prepareMigrationStaging({
      rootDir: fixture.root,
      dbPath: fixture.dbPath,
      testHooks: {
        beforeCopyUploadFile({ source }) {
          if (injected || path.basename(source) !== 'compatibility.bin') return;
          injected = true;
          fs.writeSync = () => { throw primaryError; };
          fs.closeSync = handle => {
            closeAttempts += 1;
            originalCloseSync(handle);
            throw new Error(`synthetic close failure ${closeAttempts}`);
          };
        }
      }
    }),
    error => error === primaryError
  );

  assert.equal(injected, true, 'test hook must reach the upload streaming copy');
  assert.equal(closeAttempts, 2, 'source and destination handles must both be closed');
});

test('prepareMigrationStaging rotates admin sessions and writes a deterministic safe manifest', async t => {
  const fixture = createFixture();
  let result;
  t.after(() => {
    if (result) fs.rmSync(result.tempDir, { recursive: true, force: true });
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const exportedAt = new Date('2026-09-04T08:09:10Z');
  const sourceConfigPath = path.join(fixture.root, 'admin-config.json');
  const sourceConfigText = fs.readFileSync(sourceConfigPath, 'utf8');
  const sourceConfigEvidence = fileEvidence(sourceConfigPath);
  result = await prepareMigrationStaging({
    rootDir: fixture.root,
    dbPath: fixture.dbPath,
    now: exportedAt
  });

  const stagedConfig = JSON.parse(fs.readFileSync(
    path.join(result.packageRoot, 'admin-config.json'),
    'utf8'
  ));
  assert.equal(stagedConfig.passwordHash, 'preserved-hash');
  assert.equal(stagedConfig.adminPort, 3001);
  assert.match(stagedConfig.sessionSecret, /^[0-9a-f]{64}$/);
  assert.notEqual(stagedConfig.sessionSecret, 'old-session-secret');
  assert.equal(fs.readFileSync(sourceConfigPath, 'utf8'), sourceConfigText);
  assert.deepEqual(fileEvidence(sourceConfigPath), sourceConfigEvidence);

  const manifestPath = path.join(result.packageRoot, '迁移清单.json');
  const manifestText = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.linkeyVersion, '9.8.7');
  assert.equal(manifest.exportedAt, exportedAt.toISOString());
  assert.equal(manifest.hasAdminPassword, true);

  const stagedDatabasePath = path.join(result.packageRoot, 'qq_chat.db');
  assert.deepEqual(manifest.database, {
    path: 'qq_chat.db',
    size: fs.statSync(stagedDatabasePath).size,
    sha256: fileEvidence(stagedDatabasePath).sha256
  });

  const expectedAttachmentPaths = [
    'uploads/compatibility.bin',
    'uploads/photo.png',
    'uploads/report.txt'
  ];
  assert.deepEqual(manifest.attachments.map(item => item.path), expectedAttachmentPaths);
  const expectedAttachments = expectedAttachmentPaths.map(relative => {
    const target = path.join(result.packageRoot, ...relative.split('/'));
    return {
      path: relative,
      size: fs.statSync(target).size,
      sha256: fileEvidence(target).sha256
    };
  });
  assert.deepEqual(manifest.attachments, expectedAttachments);
  assert.equal(manifest.attachmentCount, expectedAttachments.length);
  assert.equal(
    manifest.attachmentBytes,
    expectedAttachments.reduce((total, item) => total + item.size, 0)
  );

  for (const sensitive of [
    fixture.root,
    os.userInfo().username,
    os.hostname(),
    'old-session-secret',
    'preserved-hash',
    stagedConfig.sessionSecret
  ]) {
    assert.equal(manifestText.includes(sensitive), false, `manifest leaked ${sensitive}`);
  }
});

test('prepareMigrationStaging records an empty password hash as no admin password', async t => {
  const fixture = createFixture();
  let result;
  t.after(() => {
    if (result) fs.rmSync(result.tempDir, { recursive: true, force: true });
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const configPath = path.join(fixture.root, 'admin-config.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  config.passwordHash = '';
  fs.writeFileSync(configPath, JSON.stringify(config));
  result = await prepareMigrationStaging({
    rootDir: fixture.root,
    dbPath: fixture.dbPath,
    now: new Date('2026-09-04T08:09:10Z')
  });

  const manifest = JSON.parse(fs.readFileSync(
    path.join(result.packageRoot, '迁移清单.json'),
    'utf8'
  ));
  assert.equal(manifest.hasAdminPassword, false);
});

test('prepareMigrationStaging keeps only validated admin config fields', async t => {
  const fixture = createFixture();
  const configPath = path.join(fixture.root, 'admin-config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    adminPort: 3101,
    appPort: 3100,
    bindHost: '0.0.0.0',
    logKeepDays: 21,
    backupHour: 4,
    backupKeep: 30,
    passwordHash: 'preserved-hash',
    sessionSecret: 'old-session-secret',
    token: 'must-not-migrate',
    plainPassword: 'must-not-migrate',
    localPath: fixture.root
  }));
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const result = await prepareMigrationStaging({ rootDir: fixture.root, dbPath: fixture.dbPath });
  t.after(() => fs.rmSync(result.tempDir, { recursive: true, force: true }));
  const staged = JSON.parse(fs.readFileSync(
    path.join(result.packageRoot, 'admin-config.json'),
    'utf8'
  ));

  assert.deepEqual(Object.keys(staged).sort(), [
    'adminPort',
    'appPort',
    'backupHour',
    'backupKeep',
    'bindHost',
    'logKeepDays',
    'passwordHash',
    'sessionSecret'
  ].sort());
  assert.deepEqual(
    {
      adminPort: staged.adminPort,
      appPort: staged.appPort,
      bindHost: staged.bindHost,
      logKeepDays: staged.logKeepDays,
      backupHour: staged.backupHour,
      backupKeep: staged.backupKeep,
      passwordHash: staged.passwordHash
    },
    {
      adminPort: 3101,
      appPort: 3100,
      bindHost: '0.0.0.0',
      logKeepDays: 21,
      backupHour: 4,
      backupKeep: 30,
      passwordHash: 'preserved-hash'
    }
  );
  assert.match(staged.sessionSecret, /^[0-9a-f]{64}$/);
});

for (const [label, config, expected] of [
  ['null config', null, /admin-config\.json.*(?:对象|object)/i],
  ['array config', [], /admin-config\.json.*(?:对象|object)/i],
  ['invalid admin port', { adminPort: '3001' }, /admin-config\.json.*adminPort/i],
  ['invalid password hash', { passwordHash: 42 }, /admin-config\.json.*passwordHash/i],
  ['invalid backup hour', { backupHour: 24 }, /admin-config\.json.*backupHour/i]
]) {
  test(`prepareMigrationStaging rejects ${label} with config file context`, async t => {
    const fixture = createFixture();
    fs.writeFileSync(path.join(fixture.root, 'admin-config.json'), JSON.stringify(config));
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

    await assert.rejects(
      prepareMigrationStaging({ rootDir: fixture.root, dbPath: fixture.dbPath }),
      expected
    );
  });
}

test('prepareMigrationStaging reports malformed admin config with file context', async t => {
  const fixture = createFixture();
  fs.writeFileSync(path.join(fixture.root, 'admin-config.json'), '{');
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  await assert.rejects(
    prepareMigrationStaging({ rootDir: fixture.root, dbPath: fixture.dbPath }),
    /admin-config\.json.*JSON.*(?:解析|parse)/i
  );
});

test('prepareMigrationStaging succeeds without admin config and records no admin password', async t => {
  const fixture = createFixture();
  let result;
  t.after(() => {
    if (result) fs.rmSync(result.tempDir, { recursive: true, force: true });
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  fs.rmSync(path.join(fixture.root, 'admin-config.json'));
  result = await prepareMigrationStaging({
    rootDir: fixture.root,
    dbPath: fixture.dbPath,
    now: new Date('2026-09-04T08:09:10Z')
  });

  assert.equal(fs.existsSync(path.join(result.packageRoot, 'admin-config.json')), false);
  const manifest = JSON.parse(fs.readFileSync(
    path.join(result.packageRoot, '迁移清单.json'),
    'utf8'
  ));
  assert.equal(manifest.hasAdminPassword, false);
});

for (const [label, relative, removeOptions] of [
  ['source tree', 'public', { recursive: true }],
  ['root startup file', 'admin-start.cmd', {}],
  ['runtime helper', 'scripts/check-server-environment.ps1', {}]
]) {
  test(`prepareMigrationStaging rejects a missing required ${label}`, async t => {
    const fixture = createFixture();
    const markerName = `required-${crypto.randomUUID()}.marker`;
    write(fixture.root, path.join('admin', markerName));
    fs.rmSync(path.join(fixture.root, relative), { ...removeOptions, force: true });
    t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

    await assert.rejects(
      prepareMigrationStaging({ rootDir: fixture.root, dbPath: fixture.dbPath }),
      new RegExp(relative.replaceAll('\\', '\\\\').replaceAll('/', '[\\\\/]'))
    );
    const leaked = fs.readdirSync(os.tmpdir(), { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('linkey-migration-staging-'))
      .map(entry => path.join(os.tmpdir(), entry.name))
      .filter(stagingDir => fs.existsSync(path.join(
        stagingDir,
        MIGRATION_ROOT_NAME,
        'admin',
        markerName
      )));
    assert.deepEqual(leaked, [], 'missing required input staging must be cleaned');
  });
}

test('prepareMigrationStaging rejects a database path exchanged before open', async t => {
  const fixture = createFixture();
  const originalPath = `${fixture.dbPath}.original`;
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  let exchanged = false;

  await assert.rejects(
    prepareMigrationStaging({
      rootDir: fixture.root,
      dbPath: fixture.dbPath,
      testHooks: {
        beforeDatabaseOpen() {
          fs.renameSync(fixture.dbPath, originalPath);
          const replacement = new DatabaseSync(fixture.dbPath);
          try {
            replacement.exec('CREATE TABLE replacement (id INTEGER PRIMARY KEY)');
          } finally {
            replacement.close();
          }
          exchanged = true;
        }
      }
    }),
    /数据库.*(?:路径|文件).*(?:变化|替换)/
  );
  assert.equal(exchanged, true, 'test hook must exchange the database path');
});

test('prepareMigrationStaging rejects a special database sidecar appearing after initial check', async t => {
  const fixture = createFixture();
  const sidecar = `${fixture.dbPath}-wal`;
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  let created = false;

  await assert.rejects(
    prepareMigrationStaging({
      rootDir: fixture.root,
      dbPath: fixture.dbPath,
      testHooks: {
        beforeDatabaseOpen() {
          fs.mkdirSync(sidecar);
          created = true;
        }
      }
    }),
    /数据库源不是普通文件.*-wal/
  );
  assert.equal(created, true, 'test hook must create the special sidecar');
});

test('fixed export time keeps manifest structure deterministic across staging runs', async t => {
  const fixture = createFixture();
  const now = new Date('2026-09-04T08:09:10Z');
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const first = await prepareMigrationStaging({ rootDir: fixture.root, dbPath: fixture.dbPath, now });
  t.after(() => fs.rmSync(first.tempDir, { recursive: true, force: true }));
  const second = await prepareMigrationStaging({ rootDir: fixture.root, dbPath: fixture.dbPath, now });
  t.after(() => fs.rmSync(second.tempDir, { recursive: true, force: true }));

  const readManifest = result => JSON.parse(fs.readFileSync(
    path.join(result.packageRoot, '迁移清单.json'),
    'utf8'
  ));
  const firstManifest = readManifest(first);
  const secondManifest = readManifest(second);
  assert.deepEqual(
    { ...firstManifest, database: { path: firstManifest.database.path } },
    { ...secondManifest, database: { path: secondManifest.database.path } }
  );
  assert.equal(firstManifest.exportedAt, now.toISOString());
});

test('WAL snapshot includes committed data and does not rewrite production database files', async t => {
  const fixture = createFixture();
  write(fixture.root, 'uploads/wal.png', Buffer.from('wal-image'));
  let writer = new DatabaseSync(fixture.dbPath);
  let result;
  t.after(() => {
    if (result) fs.rmSync(result.tempDir, { recursive: true, force: true });
    writer?.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
  writer.prepare('INSERT INTO messages(type, content) VALUES (?, ?)')
    .run('image', '/uploads/wal.png?committed=1');

  const primer = new DatabaseSync(fixture.dbPath, { readOnly: true });
  try {
    primer.prepare('SELECT COUNT(*) AS count FROM messages').get();
  } finally {
    primer.close();
  }

  const productionFiles = [
    fixture.dbPath,
    `${fixture.dbPath}-wal`,
    `${fixture.dbPath}-shm`
  ].filter(target => fs.existsSync(target));
  assert.equal(productionFiles.includes(`${fixture.dbPath}-wal`), true, 'WAL file must exist');
  const sourceEvidence = new Map(productionFiles.map(target => [target, fileEvidence(target)]));

  result = await prepareMigrationStaging({
    rootDir: fixture.root,
    dbPath: fixture.dbPath,
    now: new Date('2026-09-04T08:09:10Z')
  });

  const snapshot = new DatabaseSync(path.join(result.packageRoot, 'qq_chat.db'), {
    readOnly: true
  });
  try {
    const integrity = snapshot.prepare('PRAGMA integrity_check').get();
    assert.equal(integrity.integrity_check, 'ok');
    const committed = snapshot.prepare(`
      SELECT content FROM messages WHERE content = '/uploads/wal.png?committed=1'
    `).get();
    assert.equal(committed.content, '/uploads/wal.png?committed=1');
  } finally {
    snapshot.close();
  }

  for (const [target, evidence] of sourceEvidence) {
    assert.deepEqual(fileEvidence(target), evidence, path.basename(target));
  }

  writer.close();
  writer = null;
  fs.rmSync(fixture.root, { recursive: true, force: true });
  assert.equal(fs.existsSync(fixture.root), false, 'fixture should be removable after snapshot');
});

test('DELETE journal snapshot excludes an active uncommitted transaction', async t => {
  const fixture = createFixture();
  let writer = new DatabaseSync(fixture.dbPath);
  let result;
  t.after(() => {
    if (result) fs.rmSync(result.tempDir, { recursive: true, force: true });
    if (writer) {
      try { writer.exec('ROLLBACK'); } catch {}
      writer.close();
    }
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  writer.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE migration_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO migration_state(id, value) VALUES (1, 'committed');
    BEGIN IMMEDIATE;
    UPDATE migration_state SET value = 'uncommitted' WHERE id = 1;
  `);
  assert.equal(fs.existsSync(`${fixture.dbPath}-journal`), true, 'rollback journal must exist');
  assert.equal(
    writer.prepare('SELECT value FROM migration_state WHERE id = 1').get().value,
    'uncommitted'
  );

  result = await prepareMigrationStaging({ rootDir: fixture.root, dbPath: fixture.dbPath });
  const snapshot = new DatabaseSync(path.join(result.packageRoot, 'qq_chat.db'), { readOnly: true });
  try {
    assert.equal(
      snapshot.prepare('SELECT value FROM migration_state WHERE id = 1').get().value,
      'committed'
    );
  } finally {
    snapshot.close();
  }

  assert.equal(
    writer.prepare('SELECT value FROM migration_state WHERE id = 1').get().value,
    'uncommitted',
    'source transaction must remain active until after snapshot assertions'
  );
  writer.exec('ROLLBACK');
  writer.close();
  writer = null;
});

test('query and fragment are stripped while non-upload URLs are ignored', async t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  write(fixture.root, 'uploads/percent%.txt', Buffer.from('literal-percent'));
  const db = new DatabaseSync(fixture.dbPath);
  try {
    db.exec("DELETE FROM messages WHERE type IN ('image', 'file')");
    const insert = db.prepare('INSERT INTO messages(type, content) VALUES (?, ?)');
    insert.run('image', '/uploads/photo.png?download=1#fragment');
    insert.run('file', '/uploads/report.txt#preview');
    insert.run('file', '/uploads/percent%25.txt');
    insert.run('image', 'https://example.com/uploads/remote.png');
  } finally {
    db.close();
  }

  const result = await prepareMigrationStaging({ rootDir: fixture.root, dbPath: fixture.dbPath });
  t.after(() => fs.rmSync(result.tempDir, { recursive: true, force: true }));
  assert.equal(fs.existsSync(path.join(result.packageRoot, 'uploads/photo.png')), true);
  assert.equal(fs.existsSync(path.join(result.packageRoot, 'uploads/report.txt')), true);
  assert.equal(fs.existsSync(path.join(result.packageRoot, 'uploads/percent%.txt')), true);
});

test('unsafe upload references abort staging instead of being ignored', async t => {
  const cases = [
    ['backslash traversal', '/uploads/sub\\..\\secret.txt'],
    ['absolute path', '/uploads//absolute.txt'],
    ['UNC path', '/uploads/\\\\server\\share\\secret.txt'],
    ['drive path', '/uploads/C:/secret.txt'],
    ['drive-relative path', '/uploads/C:secret.txt'],
    ['alternate data stream', '/uploads/photo.png:secret'],
    ['dot segment', '/uploads/../secret.txt'],
    ['encoded separator', '/uploads/sub%2Fphoto.png'],
    ['encoded dot segment', '/uploads/%2e%2e%2fsecret.txt'],
    ['double encoded traversal', '/uploads/%252e%252e%252fsecret.txt'],
    ['double encoded prefix traversal', '/uploads%252f%252e%252e%252fsecret.txt'],
    ['NUL', '/uploads/photo.png%00'],
    ['invalid encoding', '/uploads/%E0%A4%A']
  ];

  for (const [label, content] of cases) {
    await t.test(label, async t => {
      const fixture = createFixture();
      t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
      addMessage(fixture.dbPath, 'image', content);

      const outcome = await capturePreparation({ rootDir: fixture.root, dbPath: fixture.dbPath });
      if (outcome.result) {
        fs.rmSync(outcome.result.tempDir, { recursive: true, force: true });
        assert.fail(`unsafe reference was accepted: ${content}`);
      }
      assert.match(outcome.error.message, /不安全的聊天附件路径/);
    });
  }
});

for (const linkCase of [
  { label: 'source tree junction', relative: 'admin/linked-external' },
  { label: 'uploads junction', relative: 'uploads/linked-external' },
  { label: 'runtime parent junction', relative: 'scripts', replaceDirectory: true },
  { label: 'manager file symlink', relative: 'Linkey-服务端管理系统.exe', fileLink: true }
]) {
  test(`${linkCase.label} aborts staging`, async t => {
    const fixture = createFixture();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'linkey-outside-'));
    const linkPath = path.join(fixture.root, linkCase.relative);
    const externalMarkerName = `external-${crypto.randomUUID()}.txt`;
    write(outside, externalMarkerName, Buffer.from('must-not-copy'));
    if (linkCase.replaceDirectory) {
      fs.rmSync(linkPath, { recursive: true, force: true });
      write(outside, 'create-migration-archive.ps1');
      write(outside, 'check-server-environment.ps1');
    } else if (linkCase.fileLink) {
      fs.rmSync(linkPath, { force: true });
    }

    try {
      fs.symlinkSync(
        linkCase.fileLink ? path.join(outside, externalMarkerName) : outside,
        linkPath,
        linkCase.fileLink ? 'file' : 'junction'
      );
    } catch (error) {
      fs.rmSync(fixture.root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        t.skip(`link type unsupported: ${error.code}`);
        return;
      }
      throw error;
    }

    t.after(() => {
      const linkStat = fs.lstatSync(linkPath, { throwIfNoEntry: false });
      if (linkStat?.isSymbolicLink()) fs.unlinkSync(linkPath);
      fs.rmSync(fixture.root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    });

    const outcome = await capturePreparation({ rootDir: fixture.root, dbPath: fixture.dbPath });
    if (outcome.result) {
      fs.rmSync(outcome.result.tempDir, { recursive: true, force: true });
      assert.fail(`junction was accepted: ${linkCase.relative}`);
    }
    assert.match(outcome.error.message, /不允许迁移.*(?:链接|重解析点)/);
    assert.equal(fs.readFileSync(path.join(outside, externalMarkerName), 'utf8'), 'must-not-copy');

    if (linkCase.label === 'uploads junction') {
      const leakedStagingDirectories = fs.readdirSync(os.tmpdir(), { withFileTypes: true })
        .filter(entry => entry.isDirectory() && entry.name.startsWith('linkey-migration-staging-'))
        .map(entry => path.join(os.tmpdir(), entry.name))
        .filter(stagingDir => fs.existsSync(path.join(
          stagingDir,
          MIGRATION_ROOT_NAME,
          'uploads',
          'linked-external',
          externalMarkerName
        )));
      assert.deepEqual(
        leakedStagingDirectories,
        [],
        'junction contents must never reach staging or manifest enumeration'
      );
    }
  });
}

test('staging cleanup failure does not mask the original error', async t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.rmSync(path.join(fixture.root, 'uploads', 'photo.png'));

  const originalRmSync = fs.rmSync;
  const originalConsoleError = console.error;
  const logged = [];
  let failedCleanupTarget;
  fs.rmSync = (target, options) => {
    if (path.basename(String(target)).startsWith('linkey-migration-staging-')) {
      failedCleanupTarget = target;
      throw new Error('synthetic cleanup failure');
    }
    return originalRmSync(target, options);
  };
  console.error = (...args) => logged.push(args.join(' '));

  try {
    let error;
    try {
      await prepareMigrationStaging({ rootDir: fixture.root, dbPath: fixture.dbPath });
    } catch (caught) {
      error = caught;
    }
    assert.match(error.message, /缺少聊天附件.*photo\.png/);
    assert.equal(error.cleanupWarnings.length > 0, true);
    assert.equal(logged.length > 0, true);
  } finally {
    fs.rmSync = originalRmSync;
    console.error = originalConsoleError;
    if (failedCleanupTarget) {
      originalRmSync(failedCleanupTarget, { recursive: true, force: true });
    }
  }
});

test('missing referenced attachment aborts staging', async t => {
  const fixture = createFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const markerName = `cleanup-${crypto.randomUUID()}.marker`;
  write(fixture.root, path.join('admin', markerName));
  fs.rmSync(path.join(fixture.root, 'uploads', 'photo.png'));

  await assert.rejects(
    prepareMigrationStaging({
      rootDir: fixture.root,
      dbPath: fixture.dbPath,
      now: new Date('2026-09-04T08:09:10Z')
    }),
    /缺少聊天附件.*photo\.png/
  );

  const matchingStagingDirectories = fs.readdirSync(os.tmpdir(), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('linkey-migration-staging-'))
    .map(entry => path.join(os.tmpdir(), entry.name))
    .filter(stagingDir => fs.existsSync(path.join(
      stagingDir,
      MIGRATION_ROOT_NAME,
      'admin',
      markerName
    )));
  assert.deepEqual(
    matchingStagingDirectories,
    [],
    'failed staging directory containing this fixture marker must be removed'
  );
});

test('prepareMigrationStaging reports snapshot, attachments, and manifest before each phase', async t => {
  const fixture = createFixture();
  const phases = [];
  let result;
  t.after(() => {
    if (result) fs.rmSync(result.tempDir, { recursive: true, force: true });
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  result = await prepareMigrationStaging({
    rootDir: fixture.root,
    dbPath: fixture.dbPath,
    onPhase: phase => phases.push(phase)
  });

  assert.deepEqual(phases, ['snapshot', 'attachments', 'manifest']);
});

test('real archive helper rejects relative source and output paths before archiving', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linkey-helper-paths-'));
  const source = path.join(root, 'source');
  const absoluteOutput = path.join(root, 'relative-source.zip.partial');
  fs.mkdirSync(source);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const relativeSource = runArchiveHelper('source', absoluteOutput, root);
  assert.notEqual(relativeSource.status, 0);
  assert.match(relativeSource.stderr, /SourceDirectory.*(?:absolute|fully qualified)/i);
  assert.equal(fs.existsSync(absoluteOutput), false);

  const relativeOutput = runArchiveHelper(source, 'relative-output.zip.partial', root);
  assert.notEqual(relativeOutput.status, 0);
  assert.match(relativeOutput.stderr, /OutputFile.*(?:absolute|fully qualified)/i);
  assert.equal(fs.existsSync(path.join(root, 'relative-output.zip.partial')), false);
});

test('real archive helper removes its partial when post-create validation fails', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linkey-helper-cleanup-'));
  const source = path.join(root, 'source');
  const partial = path.join(root, 'invalid.zip.partial');
  write(source, `${MIGRATION_ROOT_NAME}/package.json`, '{}');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const completed = runArchiveHelper(source, partial, root);

  assert.notEqual(completed.status, 0);
  assert.match(completed.stderr, /missing required entry/i);
  assert.equal(fs.existsSync(partial), false);
});

test('real archive helper rejects a staging junction without archiving external content', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linkey-helper-junction-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'linkey-helper-outside-'));
  const source = createMinimalArchiveSource(root);
  const linkPath = path.join(source, MIGRATION_ROOT_NAME, 'uploads', 'linked');
  const partial = path.join(root, 'junction.zip.partial');
  write(outside, 'external-marker.txt', 'must-stay-outside');
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    fs.symlinkSync(outside, linkPath, 'junction');
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`junction unsupported: ${error.code}`);
      return;
    }
    throw error;
  }
  t.after(() => {
    const stat = fs.lstatSync(linkPath, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) fs.unlinkSync(linkPath);
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  const completed = runArchiveHelper(source, partial, root);

  assert.notEqual(completed.status, 0);
  assert.match(completed.stderr, /reparse|symbolic|junction/i);
  assert.equal(fs.existsSync(partial), false);
  assert.deepEqual(
    fs.readdirSync(root).filter(name => name.startsWith('junction.zip.partial.work-')),
    []
  );
  assert.equal(fs.readFileSync(path.join(outside, 'external-marker.txt'), 'utf8'), 'must-stay-outside');
});

test('real archive helper never deletes an externally owned unique requested partial', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linkey-helper-owned-'));
  const source = createMinimalArchiveSource(root);
  const requested = path.join(root, 'owned.zip.external-owner.partial');
  fs.writeFileSync(requested, 'external-owned-content');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const completed = runArchiveHelper(source, requested, root);

  assert.notEqual(completed.status, 0);
  assert.match(completed.stderr, /already exists|will not be overwritten/i);
  assert.equal(fs.readFileSync(requested, 'utf8'), 'external-owned-content');
});

test('real archive helper uses fixed direct-ZIP intermediates and never removes owned collisions', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'linkey-helper-final-'));
  const source = createMinimalArchiveSource(root);
  const finalPath = path.join(root, 'direct.zip');
  const helperSource = fs.readFileSync(ARCHIVE_HELPER_PATH, 'utf8');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.doesNotMatch(helperSource, /\.work-\$PID-|NewGuid/);
  assert.match(helperSource, /\$workOutput\s*=\s*"\$resolvedOutput\.partial"/);
  assert.match(helperSource, /\$workOutput\s*=\s*\$resolvedOutput/);
  assert.match(helperSource, /\$normalizationPath\s*=\s*"\$workOutput\.normalize"/);
  assert.match(
    helperSource,
    /\[System\.IO\.File\]::Move\(\$workOutput,\s*\$resolvedOutput\)/
  );
  assert.doesNotMatch(helperSource, /Delete\(\$resolvedOutput\)/);

  const first = runArchiveHelper(source, finalPath, root);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(fs.statSync(finalPath).isFile(), true);
  assert.equal(fs.existsSync(`${finalPath}.partial`), false);

  const evidence = fileEvidence(finalPath);
  const second = runArchiveHelper(source, finalPath, root);
  assert.notEqual(second.status, 0);
  assert.deepEqual(fileEvidence(finalPath), evidence);
  assert.equal(fs.existsSync(`${finalPath}.partial`), false);

  fs.rmSync(finalPath);
  fs.writeFileSync(`${finalPath}.partial`, 'externally-owned-work');
  fs.writeFileSync(`${finalPath}.partial.normalize`, 'externally-owned-normalize');
  const collided = runArchiveHelper(source, finalPath, root);
  assert.notEqual(collided.status, 0);
  assert.match(collided.stderr, /already exists|will not be overwritten/i);
  assert.equal(fs.readFileSync(`${finalPath}.partial`, 'utf8'), 'externally-owned-work');
  assert.equal(
    fs.readFileSync(`${finalPath}.partial.normalize`, 'utf8'),
    'externally-owned-normalize'
  );

  fs.rmSync(`${finalPath}.partial`);
  const normalizeOnlyCollision = runArchiveHelper(source, finalPath, root);
  assert.notEqual(normalizeOnlyCollision.status, 0);
  assert.match(normalizeOnlyCollision.stderr, /already exists|will not be overwritten/i);
  assert.equal(
    fs.readFileSync(`${finalPath}.partial.normalize`, 'utf8'),
    'externally-owned-normalize'
  );
});

test('exportFullMigration creates and publishes a real PowerShell ZIP with safe status metadata', async t => {
  resetMigrationStateForTests();
  const fixture = createFixture();
  const now = new Date('2026-09-05T01:02:03Z');
  const distDir = path.join(fixture.root, 'dist');
  t.after(() => {
    resetMigrationStateForTests();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  const result = await exportFullMigration({
    rootDir: fixture.root,
    dbPath: fixture.dbPath,
    distDir,
    now
  });

  const expectedName = migrationFileName(now);
  const archivePath = path.join(distDir, expectedName);
  assert.deepEqual(result, {
    fileName: expectedName,
    relativePath: `dist/${expectedName}`,
    size: fs.statSync(archivePath).size,
    createdAt: now.toISOString(),
    attachmentCount: 3,
    attachmentBytes: Buffer.byteLength('image')
      + Buffer.byteLength('document')
      + Buffer.byteLength('unreferenced')
  });
  assert.equal(fs.existsSync(`${archivePath}.partial`), false);
  assert.deepEqual(fs.readdirSync(distDir).filter(name => name.endsWith('.partial')), []);
  const entries = readZipEntries(archivePath);
  for (const required of [
    `${MIGRATION_ROOT_NAME}/qq_chat.db`,
    `${MIGRATION_ROOT_NAME}/迁移清单.json`,
    `${MIGRATION_ROOT_NAME}/package.json`,
    `${MIGRATION_ROOT_NAME}/start.bat`,
    `${MIGRATION_ROOT_NAME}/检查服务器环境.ps1`,
    `${MIGRATION_ROOT_NAME}/scripts/create-migration-archive.ps1`
  ]) {
    assert.equal(entries.includes(required), true, required);
  }
  assert.deepEqual(getMigrationStatus(), { state: 'completed', phase: 'completed', ...result });
  assert.equal(JSON.stringify(getMigrationStatus()).includes(fixture.root), false);
});

test('archive publication atomically refuses a final ZIP created in the publish window', async t => {
  resetMigrationStateForTests();
  const fixture = createFixture();
  const now = new Date('2026-09-05T01:02:04Z');
  const distDir = path.join(fixture.root, 'dist');
  const finalPath = path.join(distDir, migrationFileName(now));
  let stagingDir;
  let partialPath;
  let publishHookCalled = false;
  t.after(() => {
    resetMigrationStateForTests();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  await assert.rejects(
    exportFullMigration({
      rootDir: fixture.root,
      dbPath: fixture.dbPath,
      distDir,
      now,
      archiveRunner: async args => {
        stagingDir = args.sourceDirectory;
        partialPath = args.outputFile;
        return injectedArchive()(args);
      },
      testHooks: {
        beforeArchivePublish(paths) {
          publishHookCalled = true;
          assert.equal(path.resolve(paths.partialPath), path.resolve(partialPath));
          assert.equal(path.resolve(paths.finalPath), path.resolve(finalPath));
          fs.writeFileSync(finalPath, 'external-completed-archive', { flag: 'wx' });
        }
      }
    }),
    error => error.code === 'MIGRATION_ARCHIVE_EXISTS'
  );

  assert.equal(publishHookCalled, true);
  assert.equal(fs.readFileSync(finalPath, 'utf8'), 'external-completed-archive');
  assert.equal(fs.existsSync(partialPath), false);
  assert.equal(fs.existsSync(`${partialPath}.normalize`), false);
  assert.equal(fs.existsSync(stagingDir), false);
  assert.equal(getMigrationStatus().state, 'failed');
  assert.equal(getMigrationStatus().code, 'MIGRATION_ARCHIVE_EXISTS');
});

test('archive publication rejects a partial replaced after verification without creating final output', async t => {
  resetMigrationStateForTests();
  const fixture = createFixture();
  const now = new Date('2026-09-05T01:02:07Z');
  const distDir = path.join(fixture.root, 'dist');
  const finalPath = path.join(distDir, migrationFileName(now));
  let stagingDir;
  let partialPath;
  let candidatePath;
  t.after(() => {
    resetMigrationStateForTests();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  await assert.rejects(
    exportFullMigration({
      rootDir: fixture.root,
      dbPath: fixture.dbPath,
      distDir,
      now,
      archiveRunner: async args => {
        stagingDir = args.sourceDirectory;
        partialPath = args.outputFile;
        return injectedArchive()(args);
      },
      testHooks: {
        beforeArchivePublish(paths) {
          candidatePath = paths.candidatePath;
          fs.rmSync(paths.partialPath);
          fs.writeFileSync(paths.partialPath, 'unverified-replacement', { flag: 'wx' });
        }
      }
    }),
    error => error.code === 'ARCHIVE_IDENTITY_MISMATCH'
  );

  assert.equal(fs.existsSync(finalPath), false);
  assert.match(candidatePath, /\.publish-[0-9]+-[0-9a-f]+$/);
  assert.equal(fs.existsSync(candidatePath), false);
  assert.equal(fs.existsSync(partialPath), false);
  assert.equal(fs.existsSync(`${partialPath}.normalize`), false);
  assert.equal(fs.existsSync(stagingDir), false);
  assert.equal(getMigrationStatus().state, 'failed');
  assert.equal(getMigrationStatus().code, 'ARCHIVE_IDENTITY_MISMATCH');
});

test('normal archive publication links the verified partial atomically then removes only the partial', async t => {
  resetMigrationStateForTests();
  const fixture = createFixture();
  const now = new Date('2026-09-05T01:02:05Z');
  const distDir = path.join(fixture.root, 'dist');
  const finalPath = path.join(distDir, migrationFileName(now));
  let partialPath;
  let candidatePath;
  let observedHardLink = false;
  t.after(() => {
    resetMigrationStateForTests();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  await exportFullMigration({
    rootDir: fixture.root,
    dbPath: fixture.dbPath,
    distDir,
    now,
    archiveRunner: async args => {
      partialPath = args.outputFile;
      return injectedArchive()(args);
    },
    testHooks: {
      afterArchiveLink(paths) {
        candidatePath = paths.candidatePath;
        assert.equal(path.resolve(paths.partialPath), path.resolve(partialPath));
        assert.equal(path.resolve(paths.finalPath), path.resolve(finalPath));
        const partial = fs.statSync(partialPath, { bigint: true });
        const candidate = fs.statSync(candidatePath, { bigint: true });
        const final = fs.statSync(finalPath, { bigint: true });
        assert.equal(final.dev, partial.dev);
        assert.equal(final.ino, partial.ino);
        assert.equal(final.size, partial.size);
        assert.equal(candidate.dev, partial.dev);
        assert.equal(candidate.ino, partial.ino);
        assert.equal(candidate.size, partial.size);
        observedHardLink = true;
      }
    }
  });

  assert.equal(observedHardLink, true);
  assert.equal(fs.existsSync(finalPath), true);
  assert.equal(fs.existsSync(partialPath), false);
  assert.equal(fs.existsSync(candidatePath), false);
  assert.deepEqual(fs.readdirSync(distDir), [path.basename(finalPath)]);
});

test('a partial unlink failure keeps the completed final and is reported as a cleanup warning', async t => {
  resetMigrationStateForTests();
  const fixture = createFixture();
  const now = new Date('2026-09-05T01:02:06Z');
  const distDir = path.join(fixture.root, 'dist');
  const finalPath = path.join(distDir, migrationFileName(now));
  const originalRmSync = fs.rmSync;
  const originalConsoleError = console.error;
  let partialPath;
  let cleanupAttempts = 0;
  const logged = [];
  t.after(() => {
    fs.rmSync = originalRmSync;
    console.error = originalConsoleError;
    if (partialPath) originalRmSync(partialPath, { force: true });
    resetMigrationStateForTests();
    originalRmSync(fixture.root, { recursive: true, force: true });
  });

  fs.rmSync = (target, options) => {
    if (partialPath && path.resolve(String(target)) === path.resolve(partialPath)) {
      cleanupAttempts += 1;
      throw Object.assign(new Error('synthetic partial unlink failure'), { code: 'EACCES' });
    }
    return originalRmSync(target, options);
  };
  console.error = (...args) => logged.push(args.join(' '));

  let result;
  try {
    result = await exportFullMigration({
      rootDir: fixture.root,
      dbPath: fixture.dbPath,
      distDir,
      now,
      archiveRunner: async args => {
        partialPath = args.outputFile;
        return injectedArchive()(args);
      }
    });
  } finally {
    fs.rmSync = originalRmSync;
    console.error = originalConsoleError;
  }

  assert.equal(cleanupAttempts, 4);
  assert.equal(fs.existsSync(finalPath), true);
  assert.equal(fs.readFileSync(finalPath, 'utf8'), 'synthetic-archive');
  assert.equal(fs.existsSync(partialPath), true);
  assert.equal(result.cleanupWarnings.some(item => /临时文件清理失败/.test(item)), true);
  assert.deepEqual(getMigrationStatus().cleanupWarnings, result.cleanupWarnings);
  assert.notEqual(getMigrationStatus().cleanupWarnings, result.cleanupWarnings);
  assert.equal(logged.some(item => item.includes('EACCES')), true);
});

test('a candidate unlink failure keeps the completed final and reports the exact candidate cleanup', async t => {
  resetMigrationStateForTests();
  const fixture = createFixture();
  const now = new Date('2026-09-05T01:02:08Z');
  const distDir = path.join(fixture.root, 'dist');
  const finalPath = path.join(distDir, migrationFileName(now));
  const originalRmSync = fs.rmSync;
  const originalConsoleError = console.error;
  let partialPath;
  let candidatePath;
  let cleanupAttempts = 0;
  const logged = [];
  t.after(() => {
    fs.rmSync = originalRmSync;
    console.error = originalConsoleError;
    if (candidatePath) originalRmSync(candidatePath, { force: true });
    resetMigrationStateForTests();
    originalRmSync(fixture.root, { recursive: true, force: true });
  });

  fs.rmSync = (target, options) => {
    if (candidatePath && path.resolve(String(target)) === path.resolve(candidatePath)) {
      cleanupAttempts += 1;
      throw Object.assign(new Error('synthetic candidate unlink failure'), { code: 'EACCES' });
    }
    return originalRmSync(target, options);
  };
  console.error = (...args) => logged.push(args.join(' '));

  let result;
  try {
    result = await exportFullMigration({
      rootDir: fixture.root,
      dbPath: fixture.dbPath,
      distDir,
      now,
      archiveRunner: async args => {
        partialPath = args.outputFile;
        return injectedArchive()(args);
      },
      testHooks: {
        afterArchiveLink(paths) {
          candidatePath = paths.candidatePath;
        }
      }
    });
  } finally {
    fs.rmSync = originalRmSync;
    console.error = originalConsoleError;
  }

  assert.equal(cleanupAttempts, 4);
  assert.equal(fs.existsSync(finalPath), true);
  assert.equal(fs.readFileSync(finalPath, 'utf8'), 'synthetic-archive');
  assert.equal(fs.existsSync(partialPath), false);
  assert.equal(fs.existsSync(candidatePath), true);
  assert.equal(result.cleanupWarnings.some(item => /候选文件清理失败/.test(item)), true);
  assert.equal(logged.some(item => item.includes(candidatePath)), true);
});

test('prepareMigrationStaging streams a large attachment for copy and manifest hashing', async t => {
  const fixture = createFixture();
  const largePath = path.join(fixture.root, 'uploads', 'large-sparse.bin');
  const largeSize = 32 * 1024 * 1024;
  const handle = fs.openSync(largePath, 'w');
  fs.ftruncateSync(handle, largeSize);
  fs.closeSync(handle);
  let result;
  const originalReadFileSync = fs.readFileSync;
  t.after(() => {
    fs.readFileSync = originalReadFileSync;
    if (result) fs.rmSync(result.tempDir, { recursive: true, force: true });
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  fs.readFileSync = (target, ...args) => {
    if (typeof target === 'number' && fs.fstatSync(target).size >= largeSize) {
      throw new Error('large files must not be loaded with readFileSync');
    }
    if (typeof target === 'string' && path.resolve(target) === path.resolve(largePath)) {
      throw new Error('large files must not be loaded with readFileSync');
    }
    return originalReadFileSync(target, ...args);
  };

  result = await prepareMigrationStaging({ rootDir: fixture.root, dbPath: fixture.dbPath });
  fs.readFileSync = originalReadFileSync;
  const manifest = JSON.parse(fs.readFileSync(path.join(result.packageRoot, '迁移清单.json'), 'utf8'));
  const entry = manifest.attachments.find(item => item.path === 'uploads/large-sparse.bin');
  const expectedHash = crypto.createHash('sha256');
  const zeroChunk = Buffer.alloc(1024 * 1024);
  for (let offset = 0; offset < largeSize; offset += zeroChunk.length) expectedHash.update(zeroChunk);
  assert.equal(entry.size, largeSize);
  assert.equal(entry.sha256, expectedHash.digest('hex'));
  assert.equal(fs.statSync(path.join(result.packageRoot, entry.path)).size, largeSize);
});

test('phase observers cannot fail a committed migration synchronously or asynchronously', async t => {
  resetMigrationStateForTests();
  const fixture = createFixture();
  const distDir = path.join(fixture.root, 'dist');
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  t.after(() => {
    console.error = originalConsoleError;
    resetMigrationStateForTests();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  const result = await exportFullMigration({
    rootDir: fixture.root,
    dbPath: fixture.dbPath,
    distDir,
    now: new Date('2026-09-05T01:22:33Z'),
    archiveRunner: injectedArchive(),
    onPhase(phase) {
      if (phase === 'snapshot') throw new Error('sync observer failure');
      if (phase === 'completed') return Promise.reject(new Error('async observer failure'));
      return undefined;
    }
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(getMigrationStatus().state, 'completed');
  assert.equal(fs.existsSync(path.join(distDir, result.fileName)), true);
  assert.equal(logged.some(line => line.includes('sync observer failure')), true);
  assert.equal(logged.some(line => line.includes('async observer failure')), true);
});

test('exportFullMigration rejects a concurrent export with MIGRATION_IN_PROGRESS and preserves phase order', async t => {
  resetMigrationStateForTests();
  const fixture = createFixture();
  const now = new Date('2026-09-05T02:03:04Z');
  const phases = [];
  let enterRunner;
  let releaseRunner;
  const runnerEntered = new Promise(resolve => { enterRunner = resolve; });
  const runnerGate = new Promise(resolve => { releaseRunner = resolve; });
  let runnerSourceDirectory;
  let runnerOutputFile;
  const archiveRunner = async ({ sourceDirectory, outputFile, scriptPath }) => {
    runnerSourceDirectory = sourceDirectory;
    runnerOutputFile = outputFile;
    assert.equal(fs.statSync(sourceDirectory).isDirectory(), true);
    assert.equal(fs.statSync(path.join(sourceDirectory, MIGRATION_ROOT_NAME)).isDirectory(), true);
    assert.match(outputFile, /\.zip\.\d+-[0-9a-f]+\.partial$/);
    assert.equal(path.basename(scriptPath), 'create-migration-archive.ps1');
    enterRunner();
    await runnerGate;
    const contents = Buffer.from('concurrent-archive');
    fs.writeFileSync(outputFile, contents, { flag: 'wx' });
    return JSON.stringify({ entryCount: 7, size: contents.length });
  };
  t.after(() => {
    releaseRunner?.();
    resetMigrationStateForTests();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  const first = exportFullMigration({
    rootDir: fixture.root,
    dbPath: fixture.dbPath,
    distDir: path.join(fixture.root, 'dist'),
    now,
    archiveRunner,
    onPhase: phase => phases.push(phase)
  });
  await runnerEntered;
  assert.equal(getMigrationStatus().state, 'running');
  assert.equal(getMigrationStatus().phase, 'archive');
  await assert.rejects(
    exportFullMigration({ rootDir: fixture.root, archiveRunner }),
    error => error.code === 'MIGRATION_IN_PROGRESS'
  );
  releaseRunner();
  await first;
  assert.equal(fs.existsSync(runnerSourceDirectory), false, 'successful export must clean staging');
  assert.equal(fs.existsSync(runnerOutputFile), false, 'published export must not leave its unique partial');

  assert.deepEqual(phases, [
    'snapshot',
    'attachments',
    'manifest',
    'archive',
    'verify',
    'completed'
  ]);
});

test('exportFullMigration cleans staging and partial output for runner protocol failures', async t => {
  const cases = [
    {
      label: 'runner failure',
      runner: async ({ sourceDirectory, outputFile }) => {
        write(path.dirname(outputFile), path.basename(outputFile), 'partial');
        throw Object.assign(new Error('synthetic runner failure'), { code: 'ARCHIVE_FAILED' });
      },
      expected: /synthetic runner failure/
    },
    {
      label: 'invalid runner JSON',
      runner: async ({ outputFile }) => {
        fs.writeFileSync(outputFile, 'partial', { flag: 'wx' });
        return 'not-json';
      },
      expected: /JSON|归档.*输出/i
    },
    {
      label: 'reported size mismatch',
      runner: async ({ outputFile }) => {
        fs.writeFileSync(outputFile, 'partial', { flag: 'wx' });
        return JSON.stringify({ entryCount: 7, size: 999 });
      },
      expected: /大小|size/i
    },
    {
      label: 'helper derived intermediates',
      runner: async ({ outputFile }) => {
        fs.writeFileSync(outputFile, 'partial', { flag: 'wx' });
        fs.writeFileSync(`${outputFile}.normalize`, 'normalizing', { flag: 'wx' });
        throw Object.assign(new Error('helper interrupted'), { code: 'ARCHIVE_INTERRUPTED' });
      },
      expected: /helper interrupted/
    }
  ];

  for (const item of cases) {
    await t.test(item.label, async t => {
      resetMigrationStateForTests();
      const fixture = createFixture();
      const distDir = path.join(fixture.root, 'dist');
      let stagedSource;
      let ownedPartial;
      const runner = async args => {
        stagedSource = args.sourceDirectory;
        ownedPartial = args.outputFile;
        return item.runner(args);
      };
      t.after(() => {
        resetMigrationStateForTests();
        fs.rmSync(fixture.root, { recursive: true, force: true });
      });

      await assert.rejects(
        exportFullMigration({
          rootDir: fixture.root,
          dbPath: fixture.dbPath,
          distDir,
          now: new Date('2026-09-05T03:04:05Z'),
          archiveRunner: runner
        }),
        item.expected
      );
      const name = migrationFileName(new Date('2026-09-05T03:04:05Z'));
      assert.equal(fs.existsSync(path.join(distDir, name)), false);
      assert.equal(fs.existsSync(path.join(distDir, `${name}.partial`)), false);
      assert.equal(fs.existsSync(ownedPartial), false, 'failed export must clean its unique partial');
      assert.equal(
        fs.existsSync(`${ownedPartial}.normalize`),
        false,
        'failed export must clean the helper normalization path'
      );
      assert.equal(fs.existsSync(stagedSource), false, 'staging temp dir must be removed');
      const status = getMigrationStatus();
      assert.equal(status.state, 'failed');
      assert.equal(typeof status.phase, 'string');
      assert.equal(typeof status.message, 'string');
      assert.equal(JSON.stringify(status).includes(fixture.root), false);
    });
  }
});

test('default PowerShell runner limits output and enforces a timeout', async t => {
  for (const item of [
    {
      label: 'output limit',
      script: "[Console]::Out.Write(('x' * 8192)); Start-Sleep -Seconds 5",
      options: { archiveMaxOutputBytes: 1024, archiveTimeoutMs: 5000 },
      code: 'ARCHIVE_OUTPUT_LIMIT'
    },
    {
      label: 'timeout',
      script: 'Start-Sleep -Seconds 5',
      options: { archiveMaxOutputBytes: 1024, archiveTimeoutMs: 100 },
      code: 'ARCHIVE_TIMEOUT'
    }
  ]) {
    await t.test(item.label, async t => {
      resetMigrationStateForTests();
      const fixture = createFixture();
      const runnerScript = path.join(fixture.root, `runner-${item.label.replace(' ', '-')}.ps1`);
      fs.writeFileSync(runnerScript, item.script);
      t.after(() => {
        resetMigrationStateForTests();
        fs.rmSync(fixture.root, { recursive: true, force: true });
      });

      await assert.rejects(
        exportFullMigration({
          rootDir: fixture.root,
          dbPath: fixture.dbPath,
          distDir: path.join(fixture.root, 'dist'),
          now: new Date('2026-09-05T03:45:00Z'),
          archiveScriptPath: runnerScript,
          ...item.options
        }),
        error => error.code === item.code
      );
      assert.equal(getMigrationStatus().code, item.code);
      assert.deepEqual(
        fs.readdirSync(path.join(fixture.root, 'dist')).filter(name => name.includes('.partial')),
        []
      );
    });
  }
});

test('exportFullMigration passes a two-hour default timeout to the archive runner', async t => {
  resetMigrationStateForTests();
  const fixture = createFixture();
  let receivedTimeout;
  t.after(() => {
    resetMigrationStateForTests();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  await exportFullMigration({
    rootDir: fixture.root,
    dbPath: fixture.dbPath,
    distDir: path.join(fixture.root, 'dist'),
    now: new Date('2026-09-05T03:45:30Z'),
    archiveRunner: async args => {
      receivedTimeout = args.timeoutMs;
      return injectedArchive()(args);
    }
  });

  assert.equal(receivedTimeout, 7_200_000);
});

test('Node removes every predictable helper intermediate after killing a real large archive', async t => {
  resetMigrationStateForTests();
  const fixture = createFixture();
  const largePath = path.join(fixture.root, 'uploads', 'kill-test-large.bin');
  const largeHandle = fs.openSync(largePath, 'w');
  try {
    for (let index = 0; index < 32; index += 1) {
      fs.writeSync(largeHandle, crypto.randomBytes(1024 * 1024));
    }
  } finally {
    fs.closeSync(largeHandle);
  }
  let requestedOutput;
  let normalizeOutput;
  let detectedIntermediate;
  const observedIntermediates = [];
  t.after(() => {
    resetMigrationStateForTests();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  const killingRunner = ({ sourceDirectory, outputFile, scriptPath }) => new Promise((resolve, reject) => {
    requestedOutput = outputFile;
    normalizeOutput = `${outputFile}.normalize`;
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      scriptPath,
      '-SourceDirectory',
      sourceDirectory,
      '-OutputFile',
      outputFile
    ], { windowsHide: true, shell: false });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    const deadline = Date.now() + 10000;
    const poll = setInterval(() => {
      const outputDirectory = path.dirname(requestedOutput);
      const outputPrefix = path.basename(requestedOutput);
      const foundName = fs.readdirSync(outputDirectory)
        .find(name => name.startsWith(outputPrefix));
      const found = foundName ? path.join(outputDirectory, foundName) : null;
      if (found) {
        detectedIntermediate = found;
        observedIntermediates.push(found);
        clearInterval(poll);
        child.kill();
      } else if (Date.now() >= deadline) {
        clearInterval(poll);
        child.kill();
      }
    }, 5);
    child.once('error', error => {
      clearInterval(poll);
      reject(error);
    });
    child.once('close', () => {
      clearInterval(poll);
      const error = new Error(
        detectedIntermediate
          ? 'helper killed after intermediate appeared'
          : `helper intermediate was not predictable: ${stderr}`
      );
      error.code = detectedIntermediate ? 'HELPER_KILLED_FOR_TEST' : 'HELPER_INTERMEDIATE_NOT_FOUND';
      reject(error);
    });
  });

  await assert.rejects(
    exportFullMigration({
      rootDir: fixture.root,
      dbPath: fixture.dbPath,
      distDir: path.join(fixture.root, 'dist'),
      now: new Date('2026-09-05T03:46:00Z'),
      archiveRunner: killingRunner
    }),
    error => error.code === 'HELPER_KILLED_FOR_TEST'
  );
  assert.equal(Boolean(detectedIntermediate), true);
  assert.equal(fs.existsSync(requestedOutput), false);
  assert.equal(fs.existsSync(normalizeOutput), false);
  for (const intermediate of observedIntermediates) {
    assert.equal(fs.existsSync(intermediate), false, intermediate);
  }
});

test('exportFullMigration never overwrites an existing completed ZIP', async t => {
  resetMigrationStateForTests();
  const fixture = createFixture();
  const now = new Date('2026-09-05T04:05:06Z');
  const distDir = path.join(fixture.root, 'dist');
  const finalPath = path.join(distDir, migrationFileName(now));
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(finalPath, 'existing-completed-archive');
  let runnerCalled = false;
  t.after(() => {
    resetMigrationStateForTests();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  await assert.rejects(
    exportFullMigration({
      rootDir: fixture.root,
      dbPath: fixture.dbPath,
      distDir,
      now,
      archiveRunner: async args => {
        runnerCalled = true;
        return injectedArchive()(args);
      }
    }),
    /已存在|覆盖|exists/i
  );
  assert.equal(runnerCalled, false);
  assert.equal(fs.readFileSync(finalPath, 'utf8'), 'existing-completed-archive');
  assert.equal(fs.existsSync(`${finalPath}.partial`), false);
});

test('resetMigrationStateForTests restores idle state after a completed export', async t => {
  resetMigrationStateForTests();
  const fixture = createFixture();
  t.after(() => {
    resetMigrationStateForTests();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  await exportFullMigration({
    rootDir: fixture.root,
    dbPath: fixture.dbPath,
    distDir: path.join(fixture.root, 'dist'),
    now: new Date('2026-09-05T05:06:07Z'),
    archiveRunner: injectedArchive()
  });
  assert.equal(getMigrationStatus().state, 'completed');

  resetMigrationStateForTests();
  assert.deepEqual(getMigrationStatus(), { state: 'idle', phase: null });
});

test('export cleanup warnings are visible without masking success or the original failure', async t => {
  await t.test('completed export reports staging cleanup failure', async t => {
    resetMigrationStateForTests();
    const fixture = createFixture();
    const originalRmSync = fs.rmSync;
    const originalConsoleError = console.error;
    const logged = [];
    let stagingDir;
    fs.rmSync = (target, options) => {
      if (stagingDir && path.resolve(String(target)) === path.resolve(stagingDir)) {
        throw Object.assign(new Error('synthetic staging cleanup failure'), { code: 'EACCES' });
      }
      return originalRmSync(target, options);
    };
    console.error = (...args) => logged.push(args.join(' '));
    t.after(() => {
      fs.rmSync = originalRmSync;
      console.error = originalConsoleError;
      if (stagingDir) originalRmSync(stagingDir, { recursive: true, force: true });
      originalRmSync(fixture.root, { recursive: true, force: true });
      resetMigrationStateForTests();
    });

    let result;
    try {
      result = await exportFullMigration({
        rootDir: fixture.root,
        dbPath: fixture.dbPath,
        distDir: path.join(fixture.root, 'dist'),
        now: new Date('2026-09-05T06:07:08Z'),
        archiveRunner: async args => {
          stagingDir = args.sourceDirectory;
          return injectedArchive()(args);
        }
      });
    } finally {
      fs.rmSync = originalRmSync;
      console.error = originalConsoleError;
    }
    assert.equal(getMigrationStatus().state, 'completed');
    assert.equal(Array.isArray(result.cleanupWarnings), true);
    assert.equal(result.cleanupWarnings.length > 0, true);
    const firstStatus = getMigrationStatus();
    assert.equal(firstStatus.cleanupWarnings.length > 0, true);
    assert.notEqual(firstStatus.cleanupWarnings, result.cleanupWarnings);
    const originalWarnings = [...firstStatus.cleanupWarnings];
    firstStatus.cleanupWarnings.push('mutated-status-copy');
    assert.deepEqual(result.cleanupWarnings, originalWarnings);
    const secondStatus = getMigrationStatus();
    assert.deepEqual(secondStatus.cleanupWarnings, originalWarnings);
    assert.notEqual(secondStatus.cleanupWarnings, firstStatus.cleanupWarnings);
    result.cleanupWarnings.push('mutated-result-copy');
    assert.deepEqual(getMigrationStatus().cleanupWarnings, originalWarnings);
    assert.deepEqual(secondStatus.cleanupWarnings, originalWarnings);
    secondStatus.cleanupWarnings.push('mutated-second-status-copy');
    assert.deepEqual(result.cleanupWarnings, [...originalWarnings, 'mutated-result-copy']);
    assert.deepEqual(getMigrationStatus().cleanupWarnings, originalWarnings);
    assert.equal(logged.length > 0, true);
  });

  await t.test('failed export preserves original error and reports cleanup failures', async t => {
    resetMigrationStateForTests();
    const fixture = createFixture();
    const originalRmSync = fs.rmSync;
    const originalConsoleError = console.error;
    const logged = [];
    let stagingDir;
    let partialPath;
    fs.rmSync = (target, options) => {
      if ([stagingDir, partialPath].filter(Boolean).some(item => path.resolve(String(target)) === path.resolve(item))) {
        throw Object.assign(new Error('synthetic cleanup failure'), { code: 'EACCES' });
      }
      return originalRmSync(target, options);
    };
    console.error = (...args) => logged.push(args.join(' '));
    t.after(() => {
      fs.rmSync = originalRmSync;
      console.error = originalConsoleError;
      if (partialPath) originalRmSync(partialPath, { force: true });
      if (stagingDir) originalRmSync(stagingDir, { recursive: true, force: true });
      originalRmSync(fixture.root, { recursive: true, force: true });
      resetMigrationStateForTests();
    });

    let caught;
    try {
      await exportFullMigration({
        rootDir: fixture.root,
        dbPath: fixture.dbPath,
        distDir: path.join(fixture.root, 'dist'),
        now: new Date('2026-09-05T07:08:09Z'),
        archiveRunner: async args => {
          stagingDir = args.sourceDirectory;
          partialPath = args.outputFile;
          fs.writeFileSync(partialPath, 'owned-partial', { flag: 'wx' });
          throw Object.assign(new Error('original archive failure'), { code: 'ORIGINAL_FAILURE' });
        }
      });
    } catch (error) {
      caught = error;
    } finally {
      fs.rmSync = originalRmSync;
      console.error = originalConsoleError;
    }
    assert.equal(caught.message, 'original archive failure');
    assert.equal(caught.code, 'ORIGINAL_FAILURE');
    assert.equal(caught.cleanupWarnings.length >= 2, true);
    assert.equal(getMigrationStatus().code, 'ORIGINAL_FAILURE');
    assert.equal(getMigrationStatus().cleanupWarnings.length >= 2, true);
    assert.equal(logged.length >= 2, true);
  });
});
