import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { writeLog } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const CLOUDFLARED_EXE = path.join(ROOT_DIR, 'cloudflared.exe');

let tunnelProcess = null;
let tunnelState = {
  status: 'offline', // 'offline' | 'starting' | 'online' | 'error'
  publicUrl: null,
  startedAt: null,
  error: null
};

let listeners = [];

export function getTunnelStatus() {
  return { ...tunnelState };
}

export function onTunnelUpdate(fn) {
  listeners.push(fn);
}

function notifyListeners() {
  for (const fn of listeners) {
    try { fn(tunnelState); } catch { }
  }
}

export function startTunnel(targetPort = 3000) {
  if (tunnelProcess && tunnelState.status === 'online') {
    return Promise.resolve(tunnelState);
  }

  if (!fs.existsSync(CLOUDFLARED_EXE)) {
    tunnelState = {
      status: 'error',
      publicUrl: null,
      startedAt: null,
      error: 'cloudflared.exe 未找到'
    };
    notifyListeners();
    return Promise.resolve(tunnelState);
  }

  tunnelState.status = 'starting';
  tunnelState.error = null;
  notifyListeners();

  return new Promise((resolve) => {
    try {
      const args = ['tunnel', '--protocol', 'http2', '--url', `http://127.0.0.1:${targetPort}`];
      tunnelProcess = spawn(CLOUDFLARED_EXE, args, {
        cwd: ROOT_DIR,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let resolved = false;

      const handleOutput = (data) => {
        const text = data.toString('utf8');
        writeLog('tunnel', text);

        const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
        if (match && match[0]) {
          tunnelState.status = 'online';
          tunnelState.publicUrl = match[0];
          tunnelState.startedAt = Date.now();
          tunnelState.error = null;
          writeLog('admin-info', `[外网穿透成功] 公网访问地址: ${tunnelState.publicUrl}`);

          // Save public-url.json for client discovery
          try {
            fs.writeFileSync(path.join(ROOT_DIR, 'public-url.json'), JSON.stringify({ publicUrl: tunnelState.publicUrl, updatedAt: Date.now() }, null, 2));
            fs.writeFileSync(path.join(ROOT_DIR, 'public', 'public-url.json'), JSON.stringify({ publicUrl: tunnelState.publicUrl, updatedAt: Date.now() }, null, 2));
          } catch { }

          notifyListeners();

          if (!resolved) {
            resolved = true;
            resolve(tunnelState);
          }
        }
      };

      tunnelProcess.stdout.on('data', handleOutput);
      tunnelProcess.stderr.on('data', handleOutput);

      tunnelProcess.on('exit', (code) => {
        tunnelState.status = 'offline';
        tunnelState.publicUrl = null;
        tunnelProcess = null;
        notifyListeners();
        if (!resolved) {
          resolved = true;
          resolve(tunnelState);
        }
      });

      tunnelProcess.on('error', (err) => {
        tunnelState.status = 'error';
        tunnelState.error = err.message;
        notifyListeners();
        if (!resolved) {
          resolved = true;
          resolve(tunnelState);
        }
      });

      // Timeout fallback
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(tunnelState);
        }
      }, 15000);

    } catch (err) {
      tunnelState.status = 'error';
      tunnelState.error = err.message;
      notifyListeners();
      resolve(tunnelState);
    }
  });
}

export function stopTunnel() {
  if (tunnelProcess) {
    try {
      tunnelProcess.kill('SIGTERM');
      setTimeout(() => {
        try { if (tunnelProcess) tunnelProcess.kill('SIGKILL'); } catch { }
      }, 1000);
    } catch { }
  }
  tunnelState = {
    status: 'offline',
    publicUrl: null,
    startedAt: null,
    error: null
  };
  try {
    if (fs.existsSync(path.join(ROOT_DIR, 'public-url.json'))) fs.unlinkSync(path.join(ROOT_DIR, 'public-url.json'));
    if (fs.existsSync(path.join(ROOT_DIR, 'public', 'public-url.json'))) fs.unlinkSync(path.join(ROOT_DIR, 'public', 'public-url.json'));
  } catch { }
  notifyListeners();
  return { success: true };
}
