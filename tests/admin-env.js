// Admin 测试环境隔离（副作用模块）
// 必须在 admin.test.js 的所有其他 import 之前导入：
// ESM 按声明顺序求值，backup.js / logger.js / config.js 在模块加载时读取环境变量。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const ADMIN_TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), `linkey-admin-test-${process.pid}-`));

process.env.ADMIN_TEST_ROOT = ADMIN_TEST_ROOT;
process.env.ADMIN_LOG_DIR = path.join(ADMIN_TEST_ROOT, 'logs');
process.env.ADMIN_DB_PATH = path.join(ADMIN_TEST_ROOT, 'test-admin.db');
process.env.ADMIN_BACKUPS_DIR = path.join(ADMIN_TEST_ROOT, 'backups');
process.env.ADMIN_CONFIG_PATH = path.join(ADMIN_TEST_ROOT, 'test-admin-config.json');
process.env.ADMIN_UPLOADS_DIR = path.join(ADMIN_TEST_ROOT, 'uploads');
