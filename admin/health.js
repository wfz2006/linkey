import { EventEmitter } from 'node:events';
import { loadConfig } from './config.js';
import { writeLog } from './logger.js';

export class HealthChecker extends EventEmitter {
  constructor() {
    super();
    this.timer = null;
    this.lastCheckAt = null;
    this.lastLatencyMs = null;
    this.consecutiveFailures = 0;
    this.lastData = null;
    this.isAlive = false;
    this.startedAt = null;
    this.gracePeriodUntil = 0;
  }

  start(intervalMs = 30000) {
    this.stop();
    this.resetGracePeriod();
    this.probe(); // initial probe
    this.timer = setInterval(() => this.probe(), intervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  resetGracePeriod(graceSeconds = 60) {
    this.gracePeriodUntil = Date.now() + graceSeconds * 1000;
    this.consecutiveFailures = 0;
  }

  async probe() {
    const config = loadConfig();
    const port = config.appPort || 3000;
    const url = `http://127.0.0.1:${port}/healthz`;
    const startMs = Date.now();

    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(5000)
      });

      const latency = Date.now() - startMs;
      this.lastLatencyMs = latency;
      this.lastCheckAt = Date.now();

      if (res.ok) {
        const data = await res.json();
        this.lastData = data;
        this.consecutiveFailures = 0;
        this.isAlive = true;
        this.emit('health', { ok: true, latency, data });
        return { ok: true, latency, data };
      } else {
        throw new Error(`HTTP 状态码异常: ${res.status}`);
      }
    } catch (err) {
      const latency = Date.now() - startMs;
      this.lastLatencyMs = latency;
      this.lastCheckAt = Date.now();
      this.isAlive = false;

      const isInGracePeriod = Date.now() < this.gracePeriodUntil;
      if (!isInGracePeriod) {
        this.consecutiveFailures += 1;
      }

      writeLog('admin-err', `健康探测失败 (${this.consecutiveFailures}/3): ${err.message}${isInGracePeriod ? ' [启动宽限期内]' : ''}`, true);

      this.emit('health', { ok: false, error: err.message, consecutiveFailures: this.consecutiveFailures });

      if (this.consecutiveFailures >= 3) {
        writeLog('admin-err', '🚨 主服务连续 3 次健康探测失败，判定为假死，触发自愈重启！', true);
        this.emit('unhealthy', { consecutiveFailures: this.consecutiveFailures, error: err.message });
      }

      return { ok: false, error: err.message, consecutiveFailures: this.consecutiveFailures };
    }
  }

  getStatus() {
    return {
      lastCheckAt: this.lastCheckAt,
      lastLatencyMs: this.lastLatencyMs,
      consecutiveFailures: this.consecutiveFailures,
      isAlive: this.isAlive,
      uptime: this.lastData?.uptime || null,
      memory: this.lastData?.memory || null,
      ws: this.lastData?.ws || null,
      pid: this.lastData?.pid || null
    };
  }
}

export const healthChecker = new HealthChecker();
