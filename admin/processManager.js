import { spawn } from 'node:child_process';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ROOT_DIR } from './config.js';
import { writeLog } from './logger.js';
import { healthChecker } from './health.js';

export const ProcessState = {
  STOPPED_MANUAL: 'STOPPED_MANUAL',
  STARTING: 'STARTING',
  RUNNING: 'RUNNING',
  BACKOFF: 'BACKOFF',
  KILLING: 'KILLING'
};

const BACKOFF_DELAYS = [5000, 10000, 30000, 60000];

export class ProcessManager extends EventEmitter {
  constructor() {
    super();
    this.state = ProcessState.STOPPED_MANUAL;
    this.child = null;
    this.pid = null;
    this.isAdopted = false; // whether adopted from pre-existing instance
    this.consecutiveCrashes = 0;
    this.backoffTimer = null;
    this.stableTimer = null;
    this.startedAt = null;
    this.lastExitCode = null;

    // Listen for zombie / unhealthy detection from healthChecker
    healthChecker.on('unhealthy', async () => {
      if (this.state === ProcessState.RUNNING) {
        writeLog('admin-err', '健康探测判定假死，正在强制重启主服务...', true);
        await this.restart('zombie_health_failure');
      }
    });
  }

  buildChildEnv() {
    const env = { ...process.env };
    if (!/node/i.test(path.basename(process.execPath))) {
      env.ELECTRON_RUN_AS_NODE = '1';
    }
    return env;
  }

  async initAndStart() {
    // 1. Check if port 3000 is already running a healthy instance (Takeover Strategy)
    try {
      const probe = await healthChecker.probe();
      if (probe.ok && probe.data && probe.data.pid) {
        this.pid = probe.data.pid;
        this.isAdopted = true;
        this.state = ProcessState.RUNNING;
        this.startedAt = Date.now() - (probe.data.uptime || 0) * 1000;
        writeLog('admin', `🔍 检测到主服务已在运行中 (PID: ${this.pid})，成功接管监控`);
        healthChecker.start();
        this.emit('state', this.getStatus());
        return;
      }
    } catch {}

    // 2. Otherwise start normally
    await this.start();
  }

  async start() {
    if (this.state === ProcessState.RUNNING || this.state === ProcessState.STARTING) {
      return this.getStatus();
    }

    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }

    this.state = ProcessState.STARTING;
    this.emit('state', this.getStatus());

    const serverScript = path.join(ROOT_DIR, 'src', 'server.js');
    writeLog('admin', `🚀 正在启动主服务: ${serverScript} (执行器: ${process.execPath})`);

    try {
      this.child = spawn(process.execPath, [serverScript], {
        cwd: ROOT_DIR,
        env: this.buildChildEnv(),
        stdio: ['ignore', 'pipe', 'pipe']
      });

      this.pid = this.child.pid;
      this.isAdopted = false;
      this.startedAt = Date.now();

      this.child.stdout.on('data', (data) => {
        writeLog('app', data);
      });

      this.child.stderr.on('data', (data) => {
        writeLog('app-err', data, true);
      });

      this.child.on('error', (err) => {
        writeLog('admin-err', `子进程产生错误: ${err.message}`, true);
      });

      this.child.on('exit', (code, signal) => {
        this._handleChildExit(code, signal);
      });

      this.state = ProcessState.RUNNING;
      healthChecker.resetGracePeriod(60);
      healthChecker.start();

      // Reset crash count after 10 minutes of continuous stable running
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.stableTimer = setTimeout(() => {
        if (this.state === ProcessState.RUNNING) {
          this.consecutiveCrashes = 0;
          writeLog('admin', '主服务已持续稳定运行 10 分钟，重置异常退避计数器');
        }
      }, 10 * 60 * 1000);

      this.emit('state', this.getStatus());
      return this.getStatus();
    } catch (err) {
      this.state = ProcessState.STOPPED_MANUAL;
      writeLog('admin-err', `启动子进程失败: ${err.message}`, true);
      this.emit('state', this.getStatus());
      throw err;
    }
  }

  async stop(manual = true) {
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer);
      this.backoffTimer = null;
    }
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }

    healthChecker.stop();
    this.state = ProcessState.KILLING;
    this.emit('state', this.getStatus());

    if (this.child && !this.child.killed) {
      writeLog('admin', `正在停止主服务进程 (PID: ${this.pid})...`);
      try {
        this.child.kill('SIGKILL');
      } catch (err) {
        writeLog('admin-err', `终止子进程异常: ${err.message}`, true);
      }
    } else if (this.isAdopted && this.pid) {
      // Terminate adopted process by PID
      try {
        process.kill(this.pid, 'SIGKILL');
      } catch {}
    }

    this.child = null;
    this.pid = null;
    this.isAdopted = false;

    if (manual) {
      this.state = ProcessState.STOPPED_MANUAL;
      writeLog('admin', '⏹️ 主服务已被管理员手动停止');
    }

    this.emit('state', this.getStatus());
    return this.getStatus();
  }

  async restart(reason = 'manual_restart') {
    writeLog('admin', `🔄 正在执行主服务重启 (原因: ${reason})...`);
    await this.stop(false);
    await new Promise(r => setTimeout(r, 1000));
    return this.start();
  }

  _handleChildExit(code, signal) {
    const wasManual = this.state === ProcessState.STOPPED_MANUAL || this.state === ProcessState.KILLING;
    this.lastExitCode = code;
    this.child = null;
    this.pid = null;
    this.isAdopted = false;
    healthChecker.stop();

    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }

    writeLog('admin-err', `主服务进程退出 (code: ${code}, signal: ${signal})`, code !== 0);

    if (wasManual) {
      this.state = ProcessState.STOPPED_MANUAL;
      this.emit('state', this.getStatus());
      return;
    }

    // Process crashed unexpectedly -> Exponential backoff restart
    this.consecutiveCrashes += 1;
    const delayIndex = Math.min(this.consecutiveCrashes - 1, BACKOFF_DELAYS.length - 1);
    const delayMs = BACKOFF_DELAYS[delayIndex];

    this.state = ProcessState.BACKOFF;
    writeLog('admin-err', `⚠️ 主服务异常退出！将在 ${delayMs / 1000}s 后尝试第 ${this.consecutiveCrashes} 次拉起重启...`, true);
    this.emit('state', this.getStatus());

    this.backoffTimer = setTimeout(() => {
      this.start().catch((err) => {
        writeLog('admin-err', `退避拉起失败: ${err.message}`, true);
      });
    }, delayMs);
  }

  getStatus() {
    return {
      state: this.state,
      pid: this.pid,
      isAdopted: this.isAdopted,
      consecutiveCrashes: this.consecutiveCrashes,
      startedAt: this.startedAt,
      lastExitCode: this.lastExitCode,
      uptime: this.startedAt && this.state === ProcessState.RUNNING ? Math.floor((Date.now() - this.startedAt) / 1000) : 0
    };
  }
}

export const processManager = new ProcessManager();
