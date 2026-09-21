// 公网隧道启动器：拉起 cloudflared 临时隧道，解析公网地址并写入 public-url.json
// 供前台 /api/server/public-url 与手机扫码自动发现。Ctrl+C 退出时清理记录。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLOUDFLARED = path.join(ROOT, 'cloudflared.exe');
const URL_TIMEOUT_MS = 30000;

const targetPort = process.env.LINKEY_PORT || process.env.FASTQQ_PORT || '3000';

if (!fs.existsSync(CLOUDFLARED)) {
  console.error('[错误] 未找到 cloudflared.exe（项目根目录）');
  process.exit(1);
}

const child = spawn(CLOUDFLARED, [
  'tunnel', '--protocol', 'http2',
  '--url', `http://127.0.0.1:${targetPort}`,
  '--no-autoupdate'
], { cwd: ROOT, windowsHide: false });

function writeUrlFiles(url) {
  const payload = JSON.stringify({ publicUrl: url, updatedAt: Date.now() }, null, 2);
  try { fs.writeFileSync(path.join(ROOT, 'public-url.json'), payload); } catch {}
  try { fs.writeFileSync(path.join(ROOT, 'public', 'public-url.json'), payload); } catch {}
}

function cleanupUrlFiles() {
  try { if (fs.existsSync(path.join(ROOT, 'public-url.json'))) fs.unlinkSync(path.join(ROOT, 'public-url.json')); } catch {}
  try { if (fs.existsSync(path.join(ROOT, 'public', 'public-url.json'))) fs.unlinkSync(path.join(ROOT, 'public', 'public-url.json')); } catch {}
}

const urlPromise = new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), URL_TIMEOUT_MS);
  const handle = (data) => {
    const text = data.toString('utf8');
    process.stdout.write(text);
    const m = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (m && m[0]) { clearTimeout(timer); resolve(m[0]); }
  };
  child.stdout.on('data', handle);
  child.stderr.on('data', handle);
  child.on('exit', () => { clearTimeout(timer); resolve(null); });
});

const url = await urlPromise;
if (!url) {
  console.error('[错误] 30 秒内未获取到公网地址，请检查网络后重试');
  try { child.kill(); } catch {}
  process.exit(1);
}

writeUrlFiles(url);
console.log('\n===============================================================');
console.log('[SUCCESS] 公网访问地址已就绪:');
console.log('  ' + url);
console.log('已写入 public-url.json —— 前台分享二维码将自动使用此地址。');
console.log('注意: 每次重启隧道地址都会变化，请重新分享。');
console.log('按 Ctrl+C 停止隧道。');
console.log('===============================================================\n');

child.on('exit', () => {
  cleanupUrlFiles();
  console.log('[INFO] 隧道已停止，已清理公网地址记录');
  process.exit(0);
});

process.on('SIGINT', () => {
  try { child.kill('SIGTERM'); } catch {}
  setTimeout(() => { try { child.kill('SIGKILL'); } catch {}; }, 1500);
});
