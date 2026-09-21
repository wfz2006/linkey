# Linkey 服务端管理系统技术规格书

> **版本**：v1.0（实施基线）
> **目标读者**：负责实施的开发人员
> **关联项目**：Linkey v4.2.0（`d:\software`，Node.js 24 + SQLite，主服务端口 3000）
> **部署目标**：一台 Windows 备用电脑（局域网服务器）

---

## 目录

1. [背景与目标](#1-背景与目标)
2. [总体架构](#2-总体架构)
3. [技术约束与原则](#3-技术约束与原则)
4. [目标文件结构](#4-目标文件结构)
5. [模块详细设计](#5-模块详细设计)
6. [Admin REST API 契约](#6-admin-rest-api-契约)
7. [管理面板前端规格](#7-管理面板前端规格)
8. [安全规范（强制）](#8-安全规范强制)
9. [异常场景与预期行为矩阵](#9-异常场景与预期行为矩阵)
10. [备份与恢复手册](#10-备份与恢复手册)
11. [验收标准（Definition of Done）](#11-验收标准definition-of-done)
12. [分期交付计划](#12-分期交付计划)
- [附录 A：部署机环境备忘](#附录-a部署机环境备忘)
- [附录 B：现有代码可复用点](#附录-b现有代码可复用点)

---

## 1. 背景与目标

### 1.1 现状问题

当前主服务通过 `start.bat` 手动启动，存在以下运维缺陷：

| # | 问题 | 后果 |
|---|---|---|
| 1 | 无进程守护 | 主服务崩溃后无人拉起，全群断线直至人工发现 |
| 2 | 无健康检查 | 服务"假死"（进程在、不响应）无法感知 |
| 3 | 日志仅 console | 窗口关闭即丢失，无法事后排查 |
| 4 | 数据库无备份 | `qq_chat.db` 单点，磁盘故障 = 全部数据丢失 |
| 5 | 无任何观测手段 | 不知道在线人数、注册量、消息量，排查靠猜 |

### 1.2 目标

构建一个 **Supervisor 守护进程 + Web 管理面板** 二位一体的管理系统（下称 **Admin**），实现：

- 主服务崩溃自动拉起（指数退避），假死自动重启
- 日志按天落盘、自动轮转清理
- SQLite 每日自动备份 + 保留策略 + 手动备份/下载
- 一个手机/电脑浏览器可访问的管理面板：状态仪表盘、启停控制、日志查看、备份管理
- **保持项目零第三方依赖哲学：全程只用 Node.js 内置模块**

### 1.3 非目标（明确不做）

- 不做用户内容审核后台（属于主应用功能域）
- 不做多机集群管理（单机单实例）
- 不做公网暴露（Admin 面板仅限局域网）

---

## 2. 总体架构

```
手动运行 admin-start.cmd 或 node admin/admin.js
 └─ node admin/admin.js                ← Admin 守护进程（端口 3001）
      │
      ├─ 【进程守护】spawn 子进程运行 src/server.js（端口 3000）
      │     └─ 崩溃 → 指数退避自动重启（5s→10s→30s→60s 封顶）
      │
      ├─ 【健康探测】每 30s GET http://127.0.0.1:3000/healthz
      │     └─ 连续 3 次失败 → 判定假死 → 杀进程重启
      │
      ├─ 【日志采集】子进程 stdout/stderr → logs/app-YYYY-MM-DD.log
      │     └─ 按天滚动，保留 14 天自动清理
      │
      ├─ 【定时备份】每日 03:00 本地时间
      │     └─ VACUUM INTO backups/qq_chat_YYYYMMDD_HHmmss.db，保留 14 份
      │
      ├─ 【只读统计】以 readOnly 模式打开 qq_chat.db 做仪表盘聚合
      │
      └─ 【Web 面板】admin/public/* 静态资源 + /api/admin/* JSON 接口
            └─ 密码登录 → session token → 仪表盘/日志/备份/控制
```

---

## 3. 技术约束与原则

| 约束 | 说明 |
|---|---|
| 运行时 | Node.js ≥ 22（部署机为 v24.14.0），**只用内置模块**：`node:child_process`、`node:http`、`node:fs`、`node:path`、`node:crypto`、`node:sqlite` |
| 禁止 | 任何 `npm install`；任何 `.ps1` 脚本（部署机 PowerShell 执行策略禁用脚本，见附录 A） |
| 脚本格式 | 一切运维脚本用 `.cmd` / `.bat` |
| 前端 | 原生 HTML/CSS/JS 单页，无框架无构建；视觉沿用主应用 Liquid Glass 2.0 风格 |
| 端口 | 主服务 3000（不变）；Admin 3001 |
| 编码 | 所有源码 UTF-8 无 BOM；日志文件 UTF-8 |
| 兼容性 | 不得破坏现有 `node --test tests/*.test.js`（22/22 通过为回归基线） |

---

## 4. 目标文件结构

```
d:\software/
├── admin/                        # 管理系统
│   ├── admin.js                  # 入口：supervisor 状态机 + HTTP 服务 + 调度
│   ├── config.js                 # 配置加载/首次初始化
│   ├── auth.js                   # 密码哈希、session 签发校验、限流锁定
│   ├── logger.js                 # 日志写入与按天滚动、过期清理
│   ├── backup.js                 # 备份调度与执行、保留策略
│   ├── health.js                 # /healthz 探测器
│   ├── processManager.js         # 子进程 spawn/kill/退避重启
│   └── public/                   # 管理面板静态资源
│       ├── index.html            # 单页应用
│       ├── panel.css
│       └── panel.js
├── logs/                         # 自动创建；主服务日志按天落于此
├── backups/                      # 自动创建；数据库备份
├── admin-config.json             # 自动生成；gitignore 之
├── admin-start.cmd               # 启动入口（供人工双击）
├── admin-stop.cmd                # 停止 Admin（会连带停主服务）
├── docs/ADMIN_SYSTEM_SPEC.md     # 本文档
└── src/server.js                 # 改造点：新增 /healthz 路由
```

---

## 5. 模块详细设计

### 5.1 `/healthz` 端点
在 `src/server.js` 头部提供免鉴权、零副作用的健康检查端点。

### 5.2 守护进程与状态机
- 状态机：`STOPPED_MANUAL | STARTING | RUNNING | BACKOFF | KILLING`
- 退避表：第 1 次 5s，第 2 次 10s，第 3 次 30s，第 4+ 次 60s 封顶。
- 10 分钟稳定运行重置退避计数。
- 健康探测：每 30s 探测 `/healthz`，带 60s 启动宽限期，3 连败强杀拉起。

### 5.3 日志管理
- 按天自动滚动 `logs/app-YYYY-MM-DD.log` 与 `logs/admin-YYYY-MM-DD.log`。
- 每天清理超过 14 天的过期日志。
- 严格限制读取路径防穿越。

### 5.4 在线热备份
- `VACUUM INTO` 在线安全备份，保证 WAL 模式无锁冲突。
- 磁盘空间检查（< 1GB 拦截告警）。
- `PRAGMA integrity_check` 完整性校验。
- 默认保留最新 14 份。

### 5.5 鉴权安全
- scrypt 密码加盐哈希（`salt:hex`）。
- HMAC-SHA256 签名 Token，2 小时有效期，`timingSafeEqual` 校验。
- 连续 5 次错误密码锁定 10 分钟。
- 改密自动吊销所有现有 Session。

---

## 6. Admin REST API 契约

| 方法 | 路径 | 说明 | 请求体 / 参数 |
|---|---|---|---|
| POST | `/api/admin/login` | 登录 | `{password}` |
| GET | `/api/admin/status` | 总状态 | — |
| POST | `/api/admin/app/start` | 启动主服务 | — |
| POST | `/api/admin/app/stop` | 停止主服务 | — |
| POST | `/api/admin/app/restart` | 重启主服务 | — |
| GET | `/api/admin/stats` | 业务统计（readOnly） | — |
| GET | `/api/admin/logs/list` | 日志列表 | — |
| GET | `/api/admin/logs/read` | 读日志尾部 | `?file=...&tail=200` |
| GET | `/api/admin/logs/download` | 下载日志 | `?file=...` |
| GET | `/api/admin/backups/list` | 备份列表 | — |
| POST | `/api/admin/backups/create` | 立即备份 | — |
| GET | `/api/admin/backups/download` | 下载备份 | `?file=...` |
| DELETE | `/api/admin/backups` | 删除备份 | `?file=...` |
| POST | `/api/admin/password` | 修改密码 | `{oldPassword, newPassword}` |
| POST | `/api/admin/shutdown` | 关停 Admin 与主服务 | — |
