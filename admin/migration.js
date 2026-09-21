import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync, backup } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_ROOT_DIR = path.resolve(MODULE_DIR, '..');
export const MIGRATION_ROOT_NAME = 'Linkey-完整数据服务器';
export const SOURCE_TREES = ['admin', 'src', 'public'];
export const ROOT_FILES = [
  'package.json',
  'README.md',
  'admin-start.cmd',
  'admin-stop.cmd',
  'start.bat',
  '开启外网联机.cmd',
  'app.ico'
];
export const RUNTIME_FILES = [
  ['scripts/tunnel-start.mjs', 'scripts/tunnel-start.mjs'],
  ['scripts/create-migration-archive.ps1', 'scripts/create-migration-archive.ps1'],
  ['scripts/check-server-environment.ps1', '检查服务器环境.ps1'],
  ['docs/新电脑服务器部署说明.txt', '新电脑服务器部署说明.txt']
];
export const SKIPPED_PREFIXES = ['public/downloads/', 'public/uploads/'];
export const SKIPPED_FILES = new Set(['public/public-url.json', 'public-url.json']);
export const SKIPPED_PARTS = new Set([
  '.git',
  '.superpowers',
  '__pycache__',
  'tests',
  'test-logs',
  'logs',
  'backups',
  'dist'
]);
const SECRET_FILE_EXTENSIONS = new Set([
  '.pem',
  '.key',
  '.pfx',
  '.p12',
  '.jks',
  '.keystore'
]);
const ADMIN_CONFIG_FIELDS = [
  'adminPort',
  'appPort',
  'bindHost',
  'logKeepDays',
  'backupHour',
  'backupKeep',
  'passwordHash'
];

function shouldCopy(relative) {
  const normalized = relative.replaceAll('\\', '/').toLowerCase();
  const basename = path.posix.basename(normalized);
  if (SKIPPED_FILES.has(normalized)) return false;
  if (SKIPPED_PREFIXES.some(prefix => normalized.startsWith(prefix.toLowerCase()))) return false;
  if (basename === '.env' || basename.startsWith('.env.')) return false;
  if (SECRET_FILE_EXTENSIONS.has(path.posix.extname(basename))) return false;
  if (
    /sign(?:ing)?[^/]*key/.test(basename)
    || /key[^/]*sign(?:ing)?/.test(basename)
  ) return false;
  return !normalized.split('/').some(part => SKIPPED_PARTS.has(part));
}

function unsafeSource(source) {
  throw new Error(`不允许迁移符号链接或重解析点: ${source}`);
}

function inspectSafeSource(rootDir, source) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedSource = path.resolve(source);
  if (!isSameOrDescendant(resolvedRoot, resolvedSource)) {
    throw new Error(`迁移源路径越界: ${source}`);
  }

  const relative = path.relative(resolvedRoot, resolvedSource);
  const components = relative ? relative.split(path.sep) : [];
  let current = resolvedRoot;
  for (const component of ['', ...components]) {
    if (component) current = path.join(current, component);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return null;
    if (stat.isSymbolicLink()) unsafeSource(current);
  }
  return fs.lstatSync(resolvedSource);
}

function copyOpenedRegularFile(rootDir, source, destination) {
  const before = inspectSafeSource(rootDir, source);
  if (!before) return false;
  if (!before.isFile()) {
    throw new Error(`迁移源不是普通文件: ${source}`);
  }

  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let sourceHandle;
  let destinationHandle;
  let destinationCreated = false;
  let failure = null;
  try {
    sourceHandle = fs.openSync(source, flags);
    const opened = fs.fstatSync(sourceHandle);
    const openedPrecise = fs.fstatSync(sourceHandle, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`迁移源在复制期间发生变化: ${source}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    destinationHandle = fs.openSync(
      destination,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      before.mode
    );
    destinationCreated = true;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    while (true) {
      const bytesRead = fs.readSync(sourceHandle, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const bytesWritten = fs.writeSync(
          destinationHandle,
          buffer,
          written,
          bytesRead - written,
          null
        );
        if (bytesWritten === 0) throw new Error(`迁移目标写入中断: ${destination}`);
        written += bytesWritten;
      }
    }
    const after = fs.fstatSync(sourceHandle, { bigint: true });
    const current = inspectSafeSource(rootDir, source);
    const currentPrecise = fs.lstatSync(source, { bigint: true });
    if (
      !current?.isFile()
      || !currentPrecise.isFile()
      || after.dev !== openedPrecise.dev
      || after.ino !== openedPrecise.ino
      || after.size !== openedPrecise.size
      || after.mtimeNs !== openedPrecise.mtimeNs
      || currentPrecise.dev !== openedPrecise.dev
      || currentPrecise.ino !== openedPrecise.ino
      || currentPrecise.size !== openedPrecise.size
      || currentPrecise.mtimeNs !== openedPrecise.mtimeNs
    ) {
      throw new Error(`迁移源在复制期间发生变化: ${source}`);
    }
  } catch (error) {
    failure = error;
  }
  for (const handle of [destinationHandle, sourceHandle]) {
    if (handle === undefined) continue;
    try {
      fs.closeSync(handle);
    } catch (error) {
      if (!failure) failure = error;
    }
  }
  if (failure) {
    if (destinationCreated) {
      try { fs.rmSync(destination, { force: true }); } catch {}
    }
    throw failure;
  }
  return true;
}

function hashOpenedRegularFile(rootDir, source) {
  const before = inspectSafeSource(rootDir, source);
  if (!before || !before.isFile()) {
    throw new Error(`迁移源不是普通文件: ${source}`);
  }

  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let sourceHandle;
  try {
    sourceHandle = fs.openSync(source, flags);
    const opened = fs.fstatSync(sourceHandle);
    const openedPrecise = fs.fstatSync(sourceHandle, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`迁移源在读取期间发生变化: ${source}`);
    }
    const digest = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let size = 0;
    while (true) {
      const bytesRead = fs.readSync(sourceHandle, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
      size += bytesRead;
    }
    const after = fs.fstatSync(sourceHandle, { bigint: true });
    const current = inspectSafeSource(rootDir, source);
    const currentPrecise = fs.lstatSync(source, { bigint: true });
    if (
      !current?.isFile()
      || !currentPrecise.isFile()
      || after.dev !== openedPrecise.dev
      || after.ino !== openedPrecise.ino
      || after.size !== openedPrecise.size
      || after.mtimeNs !== openedPrecise.mtimeNs
      || currentPrecise.dev !== openedPrecise.dev
      || currentPrecise.ino !== openedPrecise.ino
      || currentPrecise.size !== openedPrecise.size
      || currentPrecise.mtimeNs !== openedPrecise.mtimeNs
      || BigInt(size) !== openedPrecise.size
    ) {
      throw new Error(`迁移源在读取期间发生变化: ${source}`);
    }
    return { size, sha256: digest.digest('hex') };
  } finally {
    if (sourceHandle !== undefined) fs.closeSync(sourceHandle);
  }
}

function readOpenedRegularFile(rootDir, source) {
  const before = inspectSafeSource(rootDir, source);
  if (!before || !before.isFile()) {
    throw new Error(`迁移源不是普通文件: ${source}`);
  }

  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  let sourceHandle;
  try {
    sourceHandle = fs.openSync(source, flags);
    const opened = fs.fstatSync(sourceHandle);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`迁移源在读取期间发生变化: ${source}`);
    }
    return fs.readFileSync(sourceHandle);
  } finally {
    if (sourceHandle !== undefined) fs.closeSync(sourceHandle);
  }
}

function copyFile(rootDir, packageRoot, sourceRelative, destinationRelative = sourceRelative) {
  return copyOpenedRegularFile(
    rootDir,
    path.join(rootDir, sourceRelative),
    path.join(packageRoot, destinationRelative)
  );
}

function copyTree(rootDir, packageRoot, treeName) {
  const sourceRoot = path.join(rootDir, treeName);
  const rootStat = inspectSafeSource(rootDir, sourceRoot);
  if (!rootStat) throw new Error(`缺少迁移必需目录: ${treeName}`);
  if (!rootStat.isDirectory()) throw new Error(`迁移源不是目录: ${sourceRoot}`);

  function visit(directory) {
    inspectSafeSource(rootDir, directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const source = path.join(directory, entry.name);
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink()) unsafeSource(source);

      const relative = path.relative(rootDir, source);
      if (!shouldCopy(relative)) continue;
      if (stat.isDirectory()) {
        visit(source);
      } else if (stat.isFile()) {
        if (!copyFile(rootDir, packageRoot, relative)) {
          throw new Error(`迁移源文件在复制期间消失: ${relative}`);
        }
      } else {
        throw new Error(`不允许迁移特殊文件: ${source}`);
      }
    }
  }
  visit(sourceRoot);
}

function normalizedRealPath(source) {
  const resolved = path.resolve(fs.realpathSync.native(source));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function captureDatabasePathIdentity(rootDir, sourcePath) {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedSource = path.resolve(sourcePath);
  const sourceStat = inspectSafeSource(resolvedRoot, resolvedSource);
  if (!sourceStat || !sourceStat.isFile()) {
    throw new Error(`找不到聊天数据库: ${resolvedSource}`);
  }

  const relative = path.relative(resolvedRoot, resolvedSource);
  const components = relative ? relative.split(path.sep) : [];
  const identities = [];
  let current = resolvedRoot;
  for (const component of ['', ...components]) {
    if (component) current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) unsafeSource(current);
    identities.push({
      path: current,
      dev: stat.dev,
      ino: stat.ino,
      realPath: normalizedRealPath(current)
    });
  }
  return identities;
}

function assertDatabasePathIdentity(identities) {
  for (const identity of identities) {
    const stat = fs.lstatSync(identity.path, { throwIfNoEntry: false });
    let realPath;
    try {
      realPath = stat ? normalizedRealPath(identity.path) : null;
    } catch {
      realPath = null;
    }
    if (
      !stat
      || stat.isSymbolicLink()
      || stat.dev !== identity.dev
      || stat.ino !== identity.ino
      || realPath !== identity.realPath
    ) {
      throw new Error(`数据库文件路径发生变化或被替换: ${identity.path}`);
    }
  }
}

function assertDatabaseSidecarsSafe(rootDir, sourcePath) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const sidecar = `${sourcePath}${suffix}`;
    const sidecarStat = inspectSafeSource(rootDir, sidecar);
    if (sidecarStat && !sidecarStat.isFile()) {
      throw new Error(`数据库源不是普通文件: ${sidecar}`);
    }
  }
}

async function snapshotDatabase(rootDir, sourcePath, destinationPath, testHooks = {}) {
  const pathIdentities = captureDatabasePathIdentity(rootDir, sourcePath);
  assertDatabaseSidecarsSafe(rootDir, sourcePath);

  let source;
  try {
    testHooks.beforeDatabaseOpen?.({ sourcePath, destinationPath });
    source = new DatabaseSync(sourcePath, { readOnly: true });
    assertDatabasePathIdentity(pathIdentities);
    assertDatabaseSidecarsSafe(rootDir, sourcePath);
    await backup(source, destinationPath);
    assertDatabasePathIdentity(pathIdentities);
    assertDatabaseSidecarsSafe(rootDir, sourcePath);
  } finally {
    source?.close();
  }

  let snapshot;
  try {
    snapshot = new DatabaseSync(destinationPath, { readOnly: true });
    const results = snapshot.prepare('PRAGMA integrity_check').all();
    const isValid = results.length === 1
      && Object.values(results[0])[0] === 'ok';
    if (!isValid) {
      const details = results.map(result => Object.values(result)[0]).join('; ');
      throw new Error(`数据库快照完整性检查失败: ${details || '无结果'}`);
    }
  } finally {
    snapshot?.close();
  }
}

function unsafeAttachment(content) {
  throw new Error(`不安全的聊天附件路径: ${String(content)}`);
}

function validateDecodedUploadPath(decoded, content) {
  if (decoded.includes('\\')) unsafeAttachment(content);
  const prefix = '/uploads/';
  if (!decoded.startsWith(prefix)) return null;

  const relative = decoded.slice(prefix.length);
  const parts = relative.split('/');
  if (
    !relative
    || relative.includes('\0')
    || path.posix.isAbsolute(relative)
    || path.win32.isAbsolute(relative.replaceAll('/', '\\'))
    || /^[A-Za-z]:/.test(relative)
    || parts.some(part => part.includes(':'))
    || parts.includes('..')
    || parts.includes('.')
  ) {
    unsafeAttachment(content);
  }

  const normalized = path.posix.normalize(relative);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    unsafeAttachment(content);
  }
  return normalized;
}

function safeAttachmentRelative(content) {
  if (typeof content !== 'string') return null;

  const suffixIndexes = [content.indexOf('?'), content.indexOf('#')]
    .filter(index => index !== -1);
  const suffixIndex = suffixIndexes.length ? Math.min(...suffixIndexes) : content.length;
  const urlPath = content.slice(0, suffixIndex);
  const uploadIntent = urlPath.startsWith('/uploads/')
    || urlPath.startsWith('/uploads\\')
    || /^\/uploads%(?:2f|5c)/i.test(urlPath);
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    if (uploadIntent) unsafeAttachment(content);
    return null;
  }

  const normalizedDecoded = decoded.replaceAll('\\', '/');
  if (!normalizedDecoded.startsWith('/uploads/')) {
    let probe = decoded;
    for (let depth = 0; depth < 3 && /%[0-9a-f]{2}/i.test(probe); depth += 1) {
      try {
        probe = decodeURIComponent(probe);
      } catch {
        return null;
      }
      if (probe.replaceAll('\\', '/').startsWith('/uploads/')) {
        unsafeAttachment(content);
      }
    }
    return null;
  }
  if (/%(?:2f|5c)/i.test(urlPath)) unsafeAttachment(content);
  const relative = validateDecodedUploadPath(decoded, content);

  let probe = decoded;
  for (let depth = 0; depth < 4 && /%[0-9a-f]{2}/i.test(probe); depth += 1) {
    if (/%(?:2f|5c)/i.test(probe)) unsafeAttachment(content);
    let next;
    try {
      next = decodeURIComponent(probe);
    } catch {
      unsafeAttachment(content);
    }
    if (next === probe) break;
    validateDecodedUploadPath(next, content);
    probe = next;
  }
  return relative;
}

export function referencedAttachments(snapshotPath) {
  const snapshot = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    const messagesTable = snapshot.prepare(`
      SELECT 1
      FROM sqlite_master
      WHERE type = 'table' AND name = 'messages'
    `).get();
    if (!messagesTable) return [];

    const referenced = new Set();
    const rows = snapshot.prepare(`
      SELECT content
      FROM messages
      WHERE type IN ('image', 'file')
    `).all();
    for (const { content } of rows) {
      const relative = safeAttachmentRelative(content);
      if (relative) referenced.add(relative);
    }
    return [...referenced];
  } finally {
    snapshot.close();
  }
}

function isSameOrDescendant(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function copyUploads(rootDir, packageRoot, references, testHooks = {}) {
  const uploadsRoot = path.join(rootDir, 'uploads');
  const uploadsStat = inspectSafeSource(rootDir, uploadsRoot);
  if (uploadsStat && !uploadsStat.isDirectory()) {
    throw new Error(`迁移源不是目录: ${uploadsRoot}`);
  }

  if (uploadsStat) {
    copyDirectory(
      rootDir,
      uploadsRoot,
      path.join(packageRoot, 'uploads'),
      testHooks
    );
  }

  const stagedUploadsRoot = path.join(packageRoot, 'uploads');
  for (const relative of references) {
    const staged = path.resolve(stagedUploadsRoot, ...relative.split('/'));
    const stat = inspectSafeSource(packageRoot, staged);
    if (!isSameOrDescendant(stagedUploadsRoot, staged) || !stat || !stat.isFile()) {
      throw new Error(`缺少聊天附件: ${relative}`);
    }
    try {
      readOpenedRegularFile(packageRoot, staged);
    } catch (error) {
      throw new Error(`缺少聊天附件: ${relative} (${error.message})`, { cause: error });
    }
  }
}

function copyDirectory(rootDir, sourceRoot, destinationRoot, testHooks = {}) {
  const stat = inspectSafeSource(rootDir, sourceRoot);
  if (!stat?.isDirectory()) throw new Error(`迁移源不是目录: ${sourceRoot}`);
  fs.mkdirSync(destinationRoot, { recursive: true });
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    const source = path.join(sourceRoot, entry.name);
    const destination = path.join(destinationRoot, entry.name);
    const entryStat = fs.lstatSync(source);
    if (entryStat.isSymbolicLink()) unsafeSource(source);
    if (entryStat.isDirectory()) {
      copyDirectory(rootDir, source, destination, testHooks);
    } else if (entryStat.isFile()) {
      testHooks.beforeCopyUploadFile?.({ source, destination });
      if (!copyOpenedRegularFile(rootDir, source, destination)) {
        throw new Error(`上传文件在复制期间消失: ${source}`);
      }
    } else {
      throw new Error(`不允许迁移特殊文件: ${source}`);
    }
  }
}

function invalidAdminConfig(source, detail) {
  throw new Error(`admin-config.json 配置无效 (${source}): ${detail}`);
}

function validateAdminConfigField(source, name, value) {
  if (name === 'adminPort' || name === 'appPort') {
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      invalidAdminConfig(source, `${name} 必须是 1-65535 的整数`);
    }
  } else if (name === 'bindHost') {
    if (typeof value !== 'string' || !value.trim()) {
      invalidAdminConfig(source, 'bindHost 必须是非空字符串');
    }
  } else if (name === 'logKeepDays' || name === 'backupKeep') {
    if (!Number.isInteger(value) || value < 0) {
      invalidAdminConfig(source, `${name} 必须是非负整数`);
    }
  } else if (name === 'backupHour') {
    if (!Number.isInteger(value) || value < 0 || value > 23) {
      invalidAdminConfig(source, 'backupHour 必须是 0-23 的整数');
    }
  } else if (name === 'passwordHash') {
    if (value !== null && typeof value !== 'string') {
      invalidAdminConfig(source, 'passwordHash 只允许字符串或 null');
    }
  }
}

function copyAdminConfig(rootDir, packageRoot) {
  const source = path.join(rootDir, 'admin-config.json');
  const sourceStat = inspectSafeSource(rootDir, source);
  if (!sourceStat) return { hasAdminPassword: false };
  if (!sourceStat.isFile()) throw new Error(`迁移源不是普通文件: ${source}`);

  let parsed;
  try {
    parsed = JSON.parse(readOpenedRegularFile(rootDir, source).toString('utf8'));
  } catch (error) {
    invalidAdminConfig(source, `JSON 解析失败: ${error.message}`);
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    invalidAdminConfig(source, '根值必须是普通 JSON 对象');
  }

  const config = {};
  for (const name of ADMIN_CONFIG_FIELDS) {
    if (!Object.hasOwn(parsed, name)) continue;
    validateAdminConfigField(source, name, parsed[name]);
    config[name] = parsed[name];
  }
  config.sessionSecret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(
    path.join(packageRoot, 'admin-config.json'),
    `${JSON.stringify(config, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' }
  );
  return { hasAdminPassword: Boolean(config.passwordHash) };
}

function fileManifestEntry(rootDir, source, relativePath) {
  const file = hashOpenedRegularFile(rootDir, source);
  return {
    path: relativePath.replaceAll('\\', '/'),
    size: file.size,
    sha256: file.sha256
  };
}

function comparePaths(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function attachmentManifest(packageRoot) {
  const uploadsRoot = path.join(packageRoot, 'uploads');
  const uploadsStat = inspectSafeSource(packageRoot, uploadsRoot);
  if (!uploadsStat) return [];
  if (!uploadsStat.isDirectory()) throw new Error(`迁移附件不是目录: ${uploadsRoot}`);

  const attachments = [];
  function visit(directory) {
    inspectSafeSource(packageRoot, directory);
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => comparePaths(left.name, right.name));
    for (const entry of entries) {
      const source = path.join(directory, entry.name);
      const stat = fs.lstatSync(source);
      if (stat.isSymbolicLink()) unsafeSource(source);
      if (stat.isDirectory()) {
        visit(source);
      } else if (stat.isFile()) {
        const relative = path.relative(packageRoot, source).replaceAll('\\', '/');
        attachments.push(fileManifestEntry(packageRoot, source, relative));
      } else {
        throw new Error(`不允许迁移特殊文件: ${source}`);
      }
    }
  }
  visit(uploadsRoot);
  return attachments.sort((left, right) => comparePaths(left.path, right.path));
}

function writeMigrationManifest(packageRoot, { hasAdminPassword, now }) {
  const packageJsonPath = path.join(packageRoot, 'package.json');
  const packageInfo = JSON.parse(
    readOpenedRegularFile(packageRoot, packageJsonPath).toString('utf8')
  );
  if (typeof packageInfo.version !== 'string' || !packageInfo.version) {
    throw new Error('package.json 缺少有效版本号');
  }

  const exportedAt = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (Number.isNaN(exportedAt.getTime())) throw new Error('迁移导出时间无效');

  const database = fileManifestEntry(
    packageRoot,
    path.join(packageRoot, 'qq_chat.db'),
    'qq_chat.db'
  );
  const attachments = attachmentManifest(packageRoot);
  const manifest = {
    formatVersion: 1,
    linkeyVersion: packageInfo.version,
    exportedAt: exportedAt.toISOString(),
    database,
    attachmentCount: attachments.length,
    attachmentBytes: attachments.reduce((total, item) => total + item.size, 0),
    attachments,
    hasAdminPassword
  };
  fs.writeFileSync(
    path.join(packageRoot, '迁移清单.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { encoding: 'utf8', flag: 'wx' }
  );
}

function notifyPhaseObserver(onPhase, phase) {
  if (typeof onPhase !== 'function') return;
  try {
    Promise.resolve(onPhase(phase)).catch(error => {
      console.error(`Linkey 迁移阶段观察器异常 (${phase}):`, error?.message || error);
    });
  } catch (error) {
    console.error(`Linkey 迁移阶段观察器异常 (${phase}):`, error?.message || error);
  }
}

export async function prepareMigrationStaging({
  rootDir = DEFAULT_ROOT_DIR,
  dbPath = path.join(rootDir, 'qq_chat.db'),
  now = new Date(),
  testHooks = {},
  onPhase = () => {}
} = {}) {
  const resolvedRoot = path.resolve(rootDir);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'linkey-migration-staging-'));
  const packageRoot = path.join(tempDir, MIGRATION_ROOT_NAME);

  try {
    fs.mkdirSync(packageRoot, { recursive: true });

    for (const treeName of SOURCE_TREES) {
      copyTree(resolvedRoot, packageRoot, treeName);
    }
    for (const relative of ROOT_FILES) {
      if (!copyFile(resolvedRoot, packageRoot, relative)) {
        throw new Error(`缺少迁移必需文件: ${relative}`);
      }
    }
    for (const [sourceRelative, destinationRelative] of RUNTIME_FILES) {
      if (!copyFile(resolvedRoot, packageRoot, sourceRelative, destinationRelative)) {
        throw new Error(`缺少迁移必需文件: ${sourceRelative}`);
      }
    }

    const managerName = 'Linkey-服务端管理系统.exe';
    const managerCopied = copyFile(resolvedRoot, packageRoot, managerName)
      || copyFile(resolvedRoot, packageRoot, path.join('dist', managerName), managerName);
    if (!managerCopied) {
      throw new Error(`找不到${managerName}`);
    }

    fs.mkdirSync(path.join(packageRoot, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, 'backups'), { recursive: true });

    const snapshotPath = path.join(packageRoot, 'qq_chat.db');
    notifyPhaseObserver(onPhase, 'snapshot');
    await snapshotDatabase(resolvedRoot, path.resolve(dbPath), snapshotPath, testHooks);
    const attachments = referencedAttachments(snapshotPath);
    notifyPhaseObserver(onPhase, 'attachments');
    copyUploads(resolvedRoot, packageRoot, attachments, testHooks);
    const adminConfig = copyAdminConfig(resolvedRoot, packageRoot);
    notifyPhaseObserver(onPhase, 'manifest');
    writeMigrationManifest(packageRoot, { ...adminConfig, now });

    return { tempDir, packageRoot };
  } catch (error) {
    const warning = cleanupPath(tempDir, {
      recursive: true,
      label: '迁移临时目录清理失败'
    });
    if (warning) {
      error.cleanupWarnings = [...(error.cleanupWarnings || []), warning];
    }
    throw error;
  }
}

const REQUIRED_ARCHIVE_ENTRY_COUNT = 6;
const ARCHIVE_SCRIPT_PATH = path.join(
  DEFAULT_ROOT_DIR,
  'scripts',
  'create-migration-archive.ps1'
);

function idleMigrationState() {
  return { state: 'idle', phase: null };
}

let migrationState = idleMigrationState();

function cloneMigrationValue(value) {
  return structuredClone(value);
}

function replaceMigrationState(nextState) {
  migrationState = cloneMigrationValue(nextState);
}

export function getMigrationStatus() {
  return cloneMigrationValue(migrationState);
}

export function resetMigrationStateForTests() {
  replaceMigrationState(idleMigrationState());
}

function migrationInProgressError() {
  const error = new Error('完整数据迁移正在进行中');
  error.code = 'MIGRATION_IN_PROGRESS';
  return error;
}

function exportTimestamp(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('迁移导出时间无效');
  const timestamp = date.toISOString()
    .replace(/[-:]/g, '')
    .replace('T', '-')
    .slice(0, 15);
  return { date, timestamp };
}

function validateOutputDirectory(distDir) {
  fs.mkdirSync(distDir, { recursive: true });
  const stat = fs.lstatSync(distDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('迁移包输出路径不是安全目录');
  }
}

function refuseCompletedArchive(finalPath) {
  if (fs.lstatSync(finalPath, { throwIfNoEntry: false })) {
    const error = new Error(`迁移包已存在，拒绝覆盖: ${path.basename(finalPath)}`);
    error.code = 'MIGRATION_ARCHIVE_EXISTS';
    throw error;
  }
}

const CLEANUP_ATTEMPTS = 4;
const CLEANUP_RETRY_DELAY_MS = 50;
const CLEANUP_SLEEP_BUFFER = new Int32Array(new SharedArrayBuffer(4));

function cleanupPath(target, { recursive, label }) {
  let lastError;
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      fs.rmSync(target, { recursive, force: true });
      return null;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < CLEANUP_ATTEMPTS) {
        Atomics.wait(CLEANUP_SLEEP_BUFFER, 0, 0, CLEANUP_RETRY_DELAY_MS);
      }
    }
  }
  const code = typeof lastError?.code === 'string' ? lastError.code : 'UNKNOWN';
  const warning = `${label} (${code})`;
  console.error(`Linkey ${warning}:`, target, lastError?.message || lastError);
  return warning;
}

function refuseOwnedPartialCollision(partialPath) {
  if (fs.lstatSync(partialPath, { throwIfNoEntry: false })) {
    const error = new Error('迁移包唯一临时路径已存在，拒绝覆盖');
    error.code = 'MIGRATION_PARTIAL_EXISTS';
    throw error;
  }
}

function defaultArchiveRunner({
  sourceDirectory,
  outputFile,
  scriptPath,
  timeoutMs = 2 * 60 * 60 * 1000,
  maxOutputBytes = 1024 * 1024
}) {
  return new Promise((resolve, reject) => {
    const args = [
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
    ];
    const child = spawn('powershell.exe', args, {
      windowsHide: true,
      shell: false
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let forcedError = null;
    let spawnError = null;
    const stopWith = error => {
      if (forcedError) return;
      forcedError = error;
      child.kill();
    };
    const appendOutput = (kind, chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maxOutputBytes) {
        const error = new Error('迁移归档进程输出超过安全限制');
        error.code = 'ARCHIVE_OUTPUT_LIMIT';
        stopWith(error);
        return;
      }
      if (kind === 'stdout') stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => appendOutput('stdout', chunk));
    child.stderr.on('data', chunk => appendOutput('stderr', chunk));
    child.stdout.once('error', error => stopWith(error));
    child.stderr.once('error', error => stopWith(error));
    child.once('error', error => { spawnError = error; });
    const timer = setTimeout(() => {
      const error = new Error(`迁移归档进程超时 (${timeoutMs}ms)`);
      error.code = 'ARCHIVE_TIMEOUT';
      stopWith(error);
    }, timeoutMs);
    child.once('close', code => {
      clearTimeout(timer);
      if (spawnError) {
        reject(spawnError);
        return;
      }
      if (forcedError) {
        reject(forcedError);
        return;
      }
      if (code !== 0) {
        const error = new Error(stderr.trim() || `迁移包归档失败 (退出码 ${code})`);
        error.code = 'ARCHIVE_FAILED';
        reject(error);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function parseArchiveResult(raw) {
  if (typeof raw !== 'string' || !raw.trim()) {
    const error = new Error('迁移包归档输出缺少有效 JSON');
    error.code = 'ARCHIVE_INVALID_OUTPUT';
    throw error;
  }
  let result;
  try {
    result = JSON.parse(raw);
  } catch (cause) {
    const error = new Error('迁移包归档输出不是有效 JSON', { cause });
    error.code = 'ARCHIVE_INVALID_OUTPUT';
    throw error;
  }
  if (
    !result
    || !Number.isInteger(result.entryCount)
    || result.entryCount < REQUIRED_ARCHIVE_ENTRY_COUNT
    || !Number.isSafeInteger(result.size)
    || result.size <= 0
  ) {
    const error = new Error('迁移包归档输出结果不合理');
    error.code = 'ARCHIVE_INVALID_OUTPUT';
    throw error;
  }
  return result;
}

function readManifestSummary(packageRoot) {
  const manifestPath = path.join(packageRoot, '迁移清单.json');
  let manifest;
  try {
    manifest = JSON.parse(readOpenedRegularFile(packageRoot, manifestPath).toString('utf8'));
  } catch (cause) {
    const error = new Error('迁移清单无效', { cause });
    error.code = 'MIGRATION_MANIFEST_INVALID';
    throw error;
  }
  if (
    !Number.isSafeInteger(manifest.attachmentCount)
    || manifest.attachmentCount < 0
    || !Number.isSafeInteger(manifest.attachmentBytes)
    || manifest.attachmentBytes < 0
  ) {
    const error = new Error('迁移清单的附件统计无效');
    error.code = 'MIGRATION_MANIFEST_INVALID';
    throw error;
  }
  return {
    attachmentCount: manifest.attachmentCount,
    attachmentBytes: manifest.attachmentBytes
  };
}

function assertPartialArchive(partialPath, archiveResult) {
  const stat = fs.lstatSync(partialPath, { bigint: true, throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    const error = new Error('迁移包临时输出不是普通文件');
    error.code = 'ARCHIVE_INVALID_OUTPUT';
    throw error;
  }
  if (stat.size !== BigInt(archiveResult.size)) {
    const error = new Error('迁移包临时文件大小与归档结果不一致');
    error.code = 'ARCHIVE_SIZE_MISMATCH';
    throw error;
  }
  return { identity: stat, size: archiveResult.size };
}

function archiveIdentity(target, description) {
  const stat = fs.lstatSync(target, { bigint: true, throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) {
    const error = new Error(`${description}不是普通文件`);
    error.code = 'ARCHIVE_IDENTITY_MISMATCH';
    throw error;
  }
  return stat;
}

function sameArchiveIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size;
}

function assertArchiveIdentity(actual, expected, description) {
  if (!sameArchiveIdentity(actual, expected)) {
    const error = new Error(`${description}的文件身份或大小发生变化`);
    error.code = 'ARCHIVE_IDENTITY_MISMATCH';
    throw error;
  }
}

function assertOpenedArchiveIdentity(actual, expected, description) {
  if (!actual.isFile()) {
    const error = new Error(`${description}不是普通文件`);
    error.code = 'ARCHIVE_IDENTITY_MISMATCH';
    throw error;
  }
  assertArchiveIdentity(actual, expected, description);
}

function publishPartialArchive({
  partialPath,
  candidatePath,
  finalPath,
  expectedIdentity,
  cleanupTargets,
  testHooks = {}
}) {
  const outputDirectory = path.dirname(path.resolve(finalPath));
  if (
    path.dirname(path.resolve(partialPath)) !== outputDirectory
    || path.dirname(path.resolve(candidatePath)) !== outputDirectory
  ) {
    const error = new Error('迁移包临时文件与正式文件必须位于同一目录');
    error.code = 'ARCHIVE_PUBLISH_PATH_INVALID';
    throw error;
  }

  if (fs.lstatSync(candidatePath, { throwIfNoEntry: false })) {
    const error = new Error('迁移包发布候选路径已存在，拒绝覆盖');
    error.code = 'MIGRATION_PUBLISH_CANDIDATE_EXISTS';
    throw error;
  }

  testHooks.beforeArchivePublish?.({ partialPath, candidatePath, finalPath });
  try {
    fs.linkSync(partialPath, candidatePath);
  } catch (cause) {
    if (cause?.code === 'EEXIST') {
      const error = new Error('迁移包发布候选路径已存在，拒绝覆盖', { cause });
      error.code = 'MIGRATION_PUBLISH_CANDIDATE_EXISTS';
      throw error;
    }
    throw cause;
  }
  cleanupTargets.push(candidatePath);

  const warnings = [];
  let candidateHandle;
  let publishFailure = null;
  try {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
    candidateHandle = fs.openSync(candidatePath, flags);
    assertOpenedArchiveIdentity(
      fs.fstatSync(candidateHandle, { bigint: true }),
      expectedIdentity,
      '迁移包发布候选句柄'
    );
    assertArchiveIdentity(
      archiveIdentity(candidatePath, '迁移包发布候选输出'),
      expectedIdentity,
      '迁移包发布候选输出'
    );
    assertArchiveIdentity(
      archiveIdentity(partialPath, '迁移包临时输出'),
      expectedIdentity,
      '迁移包临时输出'
    );

    try {
      fs.linkSync(candidatePath, finalPath);
    } catch (cause) {
      if (cause?.code === 'EEXIST') {
        const error = new Error(`迁移包已存在，拒绝覆盖: ${path.basename(finalPath)}`, { cause });
        error.code = 'MIGRATION_ARCHIVE_EXISTS';
        throw error;
      }
      throw cause;
    }

    assertOpenedArchiveIdentity(
      fs.fstatSync(candidateHandle, { bigint: true }),
      expectedIdentity,
      '迁移包发布候选句柄'
    );
    assertArchiveIdentity(
      archiveIdentity(candidatePath, '迁移包发布候选输出'),
      expectedIdentity,
      '迁移包发布候选输出'
    );
    assertArchiveIdentity(
      archiveIdentity(finalPath, '迁移包正式输出'),
      expectedIdentity,
      '迁移包正式输出'
    );
    testHooks.afterArchiveLink?.({ partialPath, candidatePath, finalPath });
  } catch (error) {
    publishFailure = error;
  }

  if (candidateHandle !== undefined) {
    try {
      fs.closeSync(candidateHandle);
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'UNKNOWN';
      const warning = `迁移包发布候选句柄关闭失败 (${code})`;
      console.error(`Linkey ${warning}:`, candidatePath, error?.message || error);
      if (publishFailure) {
        publishFailure.cleanupWarnings = [
          ...(publishFailure.cleanupWarnings || []),
          warning
        ];
      } else {
        warnings.push(warning);
      }
    }
  }
  if (publishFailure) throw publishFailure;

  const candidateWarning = cleanupPath(candidatePath, {
    recursive: false,
    label: '迁移包发布候选文件清理失败'
  });
  if (candidateWarning) warnings.push(candidateWarning);
  const partialWarning = cleanupPath(partialPath, {
    recursive: false,
    label: '迁移包临时文件清理失败'
  });
  if (partialWarning) warnings.push(partialWarning);
  const publishedFinal = archiveIdentity(finalPath, '迁移包正式输出');
  assertArchiveIdentity(publishedFinal, expectedIdentity, '迁移包正式输出');
  return warnings;
}

function setRunningPhase(phase, onPhase) {
  replaceMigrationState({ state: 'running', phase });
  notifyPhaseObserver(onPhase, phase);
}

function safeFailureState(error, phase) {
  return {
    state: 'failed',
    phase,
    message: '迁移导出失败，请查看服务端日志',
    code: typeof error?.code === 'string' ? error.code : 'MIGRATION_EXPORT_FAILED'
  };
}

/**
 * archiveRunner receives { sourceDirectory, outputFile, scriptPath } and must
 * resolve to the helper's single-line JSON string: { entryCount, size }.
 */
export async function exportFullMigration({
  rootDir = DEFAULT_ROOT_DIR,
  dbPath = path.join(rootDir, 'qq_chat.db'),
  distDir = path.join(rootDir, 'dist'),
  now = new Date(),
  archiveRunner = defaultArchiveRunner,
  archiveScriptPath = ARCHIVE_SCRIPT_PATH,
  archiveTimeoutMs = 2 * 60 * 60 * 1000,
  archiveMaxOutputBytes = 1024 * 1024,
  onPhase = () => {},
  testHooks = {}
} = {}) {
  if (migrationState.state === 'running') throw migrationInProgressError();

  let staging;
  let partialPath;
  let candidatePath;
  let cleanupTargets = [];
  let completedResult;
  let exportError;
  const cleanupWarnings = [];
  let currentPhase = null;
  replaceMigrationState({ state: 'running', phase: currentPhase });

  try {
    const { date, timestamp } = exportTimestamp(now);
    const resolvedDist = path.resolve(distDir);
    validateOutputDirectory(resolvedDist);
    const fileName = `Linkey-完整数据迁移包-${timestamp}.zip`;
    const finalPath = path.join(resolvedDist, fileName);
    const partialId = `${process.pid}-${crypto.randomBytes(12).toString('hex')}`;
    partialPath = `${finalPath}.${partialId}.partial`;
    const candidateId = `${process.pid}-${crypto.randomBytes(12).toString('hex')}`;
    candidatePath = `${finalPath}.publish-${candidateId}`;
    cleanupTargets = [partialPath, `${partialPath}.normalize`];
    refuseCompletedArchive(finalPath);
    refuseOwnedPartialCollision(partialPath);

    const advance = phase => {
      currentPhase = phase;
      setRunningPhase(phase, onPhase);
    };
    staging = await prepareMigrationStaging({
      rootDir,
      dbPath,
      now: date,
      testHooks,
      onPhase: advance
    });
    const manifest = readManifestSummary(staging.packageRoot);

    advance('archive');
    const rawArchiveResult = await archiveRunner({
      sourceDirectory: staging.tempDir,
      outputFile: partialPath,
      scriptPath: path.resolve(archiveScriptPath),
      timeoutMs: archiveTimeoutMs,
      maxOutputBytes: archiveMaxOutputBytes
    });
    const archiveResult = parseArchiveResult(rawArchiveResult);

    advance('verify');
    const partialStat = assertPartialArchive(partialPath, archiveResult);
    refuseCompletedArchive(finalPath);
    cleanupWarnings.push(...publishPartialArchive({
      partialPath,
      candidatePath,
      finalPath,
      expectedIdentity: partialStat.identity,
      cleanupTargets,
      testHooks
    }));
    partialPath = null;
    cleanupTargets = [];

    completedResult = {
      fileName,
      relativePath: `dist/${fileName}`,
      size: partialStat.size,
      createdAt: date.toISOString(),
      attachmentCount: manifest.attachmentCount,
      attachmentBytes: manifest.attachmentBytes
    };
    currentPhase = 'completed';
    replaceMigrationState({ state: 'completed', phase: 'completed', ...completedResult });
    notifyPhaseObserver(onPhase, 'completed');
  } catch (error) {
    exportError = error;
    cleanupWarnings.push(...(error.cleanupWarnings || []));
    replaceMigrationState(safeFailureState(error, currentPhase));
    for (const cleanupTarget of cleanupTargets) {
      const warning = cleanupPath(cleanupTarget, {
        recursive: false,
        label: cleanupTarget.endsWith('.normalize')
          ? '迁移包规范化临时文件清理失败'
          : cleanupTarget.includes('.publish-')
            ? '迁移包发布候选文件清理失败'
          : '迁移包临时文件清理失败'
      });
      if (warning) cleanupWarnings.push(warning);
    }
    throw error;
  } finally {
    if (staging) {
      const warning = cleanupPath(staging.tempDir, {
        recursive: true,
        label: '迁移临时目录清理失败'
      });
      if (warning) cleanupWarnings.push(warning);
    }
    if (cleanupWarnings.length) {
      const visibleWarnings = [...new Set(cleanupWarnings)];
      if (exportError) {
        exportError.cleanupWarnings = [...visibleWarnings];
        replaceMigrationState({ ...migrationState, cleanupWarnings: [...visibleWarnings] });
      } else if (completedResult) {
        completedResult.cleanupWarnings = [...visibleWarnings];
        replaceMigrationState({ ...migrationState, cleanupWarnings: [...visibleWarnings] });
      }
    }
  }
  return cloneMigrationValue(completedResult);
}
