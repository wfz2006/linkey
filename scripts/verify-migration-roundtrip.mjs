import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { exportFullMigration, SOURCE_TREES, ROOT_FILES, RUNTIME_FILES, MIGRATION_ROOT_NAME } from '../admin/migration.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'linkey-roundtrip-'));
const root = path.join(temporary, 'source');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function copy(relative) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(project, relative), target);
}
function copyProgramTree(relative) {
  for (const item of fs.readdirSync(path.join(project, relative), { withFileTypes: true })) {
    const next = `${relative}/${item.name}`;
    if (item.isSymbolicLink()) throw new Error(`Unexpected program link: ${next}`);
    if (item.isDirectory()) {
      if (!['downloads', 'uploads', 'logs', 'backups', '.git', '.superpowers'].includes(item.name)) copyProgramTree(next);
    } else if (/\.(?:js|mjs|html|css|svg|ico|png|jpg|woff2?|json)$/i.test(item.name)
      && !['admin-config.json', 'public-url.json'].includes(item.name)) copy(next);
  }
}
function powershell(args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
      windowsHide: true, shell: false, env: { ...process.env, ...env }
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, output }));
  });
}

try {
  fs.mkdirSync(root);
  for (const tree of SOURCE_TREES) copyProgramTree(tree);
  for (const relative of ROOT_FILES) copy(relative);
  for (const [relative] of RUNTIME_FILES) copy(relative);
  copy('scripts/tunnel-start.mjs');
  copy('dist/Linkey-服务端管理系统.exe');
  const uploads = new Map([
    ['photo.png', Buffer.from('isolated image fixture')],
    ['说明.txt', Buffer.from('迁移文件内容')],
    ['unreferenced.bin', Buffer.from([0, 1, 2, 255])]
  ]);
  fs.mkdirSync(path.join(root, 'uploads'));
  for (const [name, bytes] of uploads) fs.writeFileSync(path.join(root, 'uploads', name), bytes);
  const secret = 'a'.repeat(64);
  const passwordHash = crypto.createHash('sha256').update('isolated-password').digest('hex');
  fs.writeFileSync(path.join(root, 'admin-config.json'), JSON.stringify({ passwordHash, sessionSecret: secret }));
  const sourceDb = path.join(root, 'qq_chat.db');
  const db = new DatabaseSync(sourceDb);
  try {
    db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, username TEXT);
      CREATE TABLE friends(user_id INTEGER, friend_id INTEGER);
      CREATE TABLE messages(id INTEGER PRIMARY KEY, sender_id INTEGER, receiver_id INTEGER, type TEXT, content TEXT);
      INSERT INTO users VALUES(1,'alice'),(2,'bob');
      INSERT INTO friends VALUES(1,2),(2,1);
      INSERT INTO messages VALUES(1,1,2,'text','hello migration'),(2,2,1,'image','/uploads/photo.png'),(3,1,2,'file','/uploads/说明.txt');`);
  } finally { db.close(); }
  const sourceBefore = { hash: sha(sourceDb), mtime: fs.statSync(sourceDb).mtimeMs };
  const phases = [];
  const result = await exportFullMigration({ rootDir: root, onPhase: phase => phases.push(phase) });
  assert.deepEqual({ hash: sha(sourceDb), mtime: fs.statSync(sourceDb).mtimeMs }, sourceBefore);
  const extracted = path.join(temporary, 'extracted');
  const unzip = await powershell(['-Command', 'Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:LINKEY_VERIFY_ZIP, $env:LINKEY_VERIFY_DEST)'], {
    LINKEY_VERIFY_ZIP: path.join(root, result.relativePath), LINKEY_VERIFY_DEST: extracted
  });
  assert.equal(unzip.code, 0, unzip.output);
  const migrated = path.join(extracted, MIGRATION_ROOT_NAME);
  const restored = new DatabaseSync(path.join(migrated, 'qq_chat.db'), { readOnly: true });
  try {
    assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(restored.prepare('SELECT count(*) AS n FROM users').get().n, 2);
    assert.equal(restored.prepare('SELECT count(*) AS n FROM friends f JOIN users u ON u.id=f.user_id JOIN users v ON v.id=f.friend_id').get().n, 2);
    assert.deepEqual(restored.prepare('SELECT content FROM messages ORDER BY id').all().map(row => row.content), ['hello migration', '/uploads/photo.png', '/uploads/说明.txt']);
  } finally { restored.close(); }
  const config = JSON.parse(fs.readFileSync(path.join(migrated, 'admin-config.json')));
  assert.equal(config.passwordHash, passwordHash);
  assert.match(config.sessionSecret, /^[a-f0-9]{64}$/);
  assert.notEqual(config.sessionSecret, secret);
  const manifest = JSON.parse(fs.readFileSync(path.join(migrated, '迁移清单.json')));
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.hasAdminPassword, true);
  assert.equal(manifest.attachmentCount, uploads.size);
  assert.equal(manifest.attachmentBytes, [...uploads.values()].reduce((sum, bytes) => sum + bytes.length, 0));
  for (const entry of [manifest.database, ...manifest.attachments]) {
    assert.equal(sha(path.join(migrated, entry.path)), entry.sha256);
    assert.equal(fs.statSync(path.join(migrated, entry.path)).size, entry.size);
  }
  for (const [name, bytes] of uploads) assert.deepEqual(fs.readFileSync(path.join(migrated, 'uploads', name)), bytes);
  const checker = path.join(migrated, '检查服务器环境.ps1');
  const good = await powershell(['-File', checker, '-DeepMigrationCheck']);
  assert.equal(good.code, 0, good.output);
  const image = path.join(migrated, 'uploads', 'photo.png');
  fs.writeFileSync(image, Buffer.alloc(uploads.get('photo.png').length, 88));
  const corrupt = await powershell(['-File', checker, '-DeepMigrationCheck']);
  assert.notEqual(corrupt.code, 0, 'Corrupt attachment must fail deep verification');
  fs.unlinkSync(image);
  const missing = await powershell(['-File', checker]);
  assert.notEqual(missing.code, 0, 'Missing attachment must fail verification');
  console.log(JSON.stringify({ passed: true, users: 2, friendships: 2, messages: 3, attachments: uploads.size, sourceUnchanged: true, adminPasswordPreserved: true, sessionRotated: true, archiveBytes: result.size, phases, checker: { valid: good.code, corrupt: corrupt.code, missing: missing.code } }));
} finally {
  const resolved = path.resolve(temporary);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('linkey-roundtrip-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
