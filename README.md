# Linkey v4.2.0 - 全自适应流光社交即时通讯与高可用运维系统

一款采用现代 Liquid Glass 2.0 流光拟态风格设计、专为电脑桌面端与移动端打造的高性能全自适应即时通讯（IM）、空间社交与自动化高可用运维系统。

---

## 🌟 核心架构与功能特性

### 1. 跨端全自适应极致体验
- **桌面工作台（$\ge 768\text{px}$）**：专业级三栏桌面布局（流光侧边栏 / 智能分组会话列表 / 沉浸式对话与空间主面板）。
- **移动端沉浸体验（$< 768\text{px}$）**：原生 App 级页面栈切换，支持 `100dvh` 软键盘动态避让与底部导航栏。
- **PWA 即开即用**：支持在各大现代浏览器中一键“添加到主屏幕”，无须安装包即可化身独立全屏应用。
- **原生安卓 APK 直编**：内置纯 Python 编译引擎，输出签名安装包（`Linkey-Android.apk`）。

### 2. 毫秒级实时全双工通信 (WebSocket RFC 6455)
- 基于原生 Node.js 实现的 WebSocket 协议层，零外部运行时依赖。
- 在线状态感知（🟢 在线 / 🟡 离开 / ⚪ 隐身）、实时正在输入提示、未读消息红点。
- **消息送达确认 (Delivery Ack)**：服务端秒级落库回执，消息气泡支持单勾/双勾状态转换。
- **消息撤回与引用回复**：支持 2 分钟内消息撤回与右键引用回复。
- **经典互动**：支持**戳一戳**双向震屏动画特效与 Web Audio 经典 QQ 提示音合成。

### 3. 好友关系链与群组管理控制台
- **好友申请与验证**：支持带申请留言的好友申请、同意、拒绝、删除与好友自定义备注名。
- **群聊高级管理**：群主/管理员支持修改群名、发布置顶群公告、踢出违规成员与主动退群。

### 4. 正式版全功能 QQ 空间（Qzone）
- **说说动态**：图文混排动态发表、点赞 ❤️ 与**多级即时互动评论 💬**。
- **相册照片墙**：现代玻璃瀑布流网格，支持全屏高清灯箱（Lightbox）放大浏览。
- **空间留言板**：好友专属温情寄语互动板。

### 5. 100% 真实数据驱动计算引擎
- **真实 QQ 等级**：基于实际注册天数、发言数、说说发表与互动经验值计算，自动换算 👑/☀️/🌙/⭐️ 经典图标。
- **真实亲密度与勋章**：根据双方实际聊天频次与空间互动计算亲密度（如 `99°C 亲密挚友`），自动点亮 🔥 巨轮好友与 💎 空间黄钻。
- **真实访客日志**：记录并去重统计今日访客与历史总访客数。

### 6. 高可用守护与自动化运维系统 (Admin Daemon :3001)
- **崩溃毫秒级自愈**：主服务异常退出时，守护进程自动触发指数退避并在 5 秒内拉起新实例。
- **在线无锁热备**：基于 SQLite 原生 `VACUUM INTO` 机制，业务不停机秒级生成只读物理备份，并自动校验完整性（`integrity_check`）。
- **安全加固**：HMAC-SHA256 会话鉴权、防爆破密码限流器（5 次错误锁定 15 分钟）、严格防路径穿越审计。

---

## 🏛️ 项目目录结构

```
d:\software/
├── admin/                           # Linkey 独立运维管理系统与高可用守护进程
│   ├── admin.js                     # Admin HTTP 控制台服务 (Port 3001, REST API)
│   ├── supervisor.js                # 守护进程核心 (崩溃自愈、心跳探活、指数退避)
│   ├── logger.js                    # 运维日志引擎 (循环写入、安全轮转、防路径穿越)
│   ├── backup.js                    # 在线无锁热备与完整性校验引擎
│   ├── security.js                  # HMAC-SHA256 签名鉴权、防爆破限流与安全中间件
│   └── views/                       # 运维监控大屏前端资源
├── backups/                         # 数据库自动化热备归档目录 (VACUUM INTO)
├── dist/                            # ★ 全部构建产物（由 scripts/build_all.py 生成）
│   ├── Linkey-服务端管理系统.exe      # 后台管理软件（托盘常驻，管理服务端+运维面板）
│   ├── Linkey.exe                   # 电脑版客户端（浏览器 App 壳，绿色免安装）
│   ├── Linkey-安装程序.exe            # 电脑版一键安装向导
│   ├── Linkey-Android.apk           # 安卓安装包（v1+v2 双签名，可直接覆盖升级）
│   ├── Linkey-全平台安装包.zip        # 电脑+手机单文件合集（发给朋友用这个）
│   └── Linkey-全新服务器迁移包.zip     # 不含旧数据的换机服务器部署包
├── docs/                            # 架构设计与工程规格文档
│   ├── ADMIN_SYSTEM_SPEC.md         # 运维管理系统工程规格书
│   └── TECHNICAL_REPORT.md          # 完整技术架构报告与白皮书
├── logs/                            # 运行日志与运维审计留痕
├── public/                          # Linkey 客户端前台静态资源
│   ├── css/
│   │   └── style.css                # Liquid Glass 2.0 全自适应响应式设计系统
│   ├── js/
│   │   ├── api.js                   # 前端 REST API 通信模块
│   │   ├── socket.js                # 前端 WebSocket 客户端
│   │   ├── audio.js                 # Web Audio API 提示音合成引擎
│   │   ├── qr.js                    # 本地零依赖二维码生成引擎
│   │   └── app.js                   # 前端主应用视图控制器
│   ├── downloads/                   # 客户端发布文件下载目录（Linkey-Android.apk 等）
│   ├── index.html                   # Linkey 客户端单页主应用 (SPA)
│   ├── manifest.json                # PWA 渐进式 Web 应用配置
│   └── sw.js                        # Service Worker 离线缓存
├── scripts/                         # 工程构建与跨端编译脚本
│   ├── build_all.py                 # ★ 一键全量构建总入口（exe + APK + 分发包）
│   ├── build_android_apk.py         # 纯原生无依赖 Python 安卓 APK 编译器 (v1+v2 签名)
│   ├── verify_apk.py                # APK 结构与签名校验工具
│   ├── package_dist.py              # 分发包打包器 (输出至 dist/)
│   ├── apk-signing-key.pem          # APK 持久化签名密钥（丢失将无法覆盖升级）
│   └── windows-launcher/            # Windows 原生极速启动器与托盘服务源码 (C#)
├── src/                             # Linkey 后端业务核心
│   ├── db/
│   │   └── database.js              # SQLite 原生引擎层 (DatabaseSync, WAL 模式)
│   ├── services/
│   │   ├── authService.js           # 用户认证、权限、关系链与空间数据驱动引擎
│   │   └── chatService.js           # 即时消息、会话路由、群组管理与撤回/引用回复
│   ├── socket/
│   │   └── wsServer.js              # 原生 WebSocket 服务端 (RFC 6455 协议实现)
│   └── server.js                    # HTTP/WS 统一接入网关服务 (Port 3000)
├── src_client/                      # 电脑版客户端源码 (C#)
├── src_manager/                     # 后台管理系统桌面软件源码 (C#, WinForms 托盘)
├── tests/                           # 自动化质量保障测试套件 (Node.js Test Runner)
├── uploads/                         # 用户上传的多媒体附件与图片存储仓库
├── admin-start.cmd                  # 运维守护与主服务一体化一键启动脚本
├── admin-stop.cmd                   # 运维守护与主服务安全停止脚本
├── start.bat                        # Windows 直连调试启动脚本
├── 开启外网联机.cmd                  # Cloudflare 公网隧道一键启动（自动写入公网地址）
├── package.json                     # 项目描述与 NPM 脚本定义
├── README.md                        # 项目快速开始与概览说明
└── qq_chat.db                       # SQLite 核心业务生产数据库
```

> 💡 **重新生成全部软件**：运行 `python scripts/build_all.py`（或 `build-all.cmd`），所有产物输出至 `dist/`。

> 🧳 **换电脑部署新服务器**：使用 `dist/Linkey-全新服务器迁移包.zip`。它不包含当前账号、聊天、附件、日志、备份或后台密码；新电脑安装 Node.js 24 LTS 或更高版本后按包内说明启动即可。

> **保留数据换电脑**：在后台备份管理或桌面管理器导出“完整数据迁移包”，包含账号、好友、群组、聊天及图片文件，保留后台密码并更新登录会话密钥。最终导出前停止聊天主服务，保留后台；新电脑手工安装 Node.js 24，解压到新目录，首次启动前执行 `powershell -NoProfile -ExecutionPolicy Bypass -File .\检查服务器环境.ps1 -DeepMigrationCheck`。运行后数据库与原清单不一致属正常。迁移成功后保留旧机和 ZIP 备份。导出磁盘需支持硬链接（建议 NTFS）。详见包内《新电脑服务器部署说明》。

> 后台端口 3001 不得通过允许外部伪造 `X-Linkey-Local` / `X-FastQQ-Local` 请求头的本机代理暴露。

---

## 🚀 快速启动与操作指南

### 1. 一键启动系统（推荐生产方式）
双击或命令行执行：
```cmd
admin-start.cmd
```
*自动在后台拉起主服务（Port 3000）并开启守护进程与管理大屏（Port 3001）。*

### 2. 开发者直连调试
```bash
# 启动主服务
npm start

# 或启动热更新监听模式
npm run dev
```

### 3. 执行自动化测试套件
```bash
npm test
```
*全部 29 项单元与端到端测试均 100% 通过（耗时 $\approx 1.1\text{s}$）。*

---

## 🌐 核心访问地址

| 服务模块 | 访问地址 | 默认账号 / 备注 |
| :--- | :--- | :--- |
| **Linkey 前台主站** | `http://localhost:3000` | 支持预置快捷登录或自主注册 |
| **运维监控管理大屏** | `http://localhost:3001` | 账号 `admin` / 密码 `admin888` |
| **WebSocket 实时网关** | `ws://localhost:3000/ws` | 支持 Token 握手认证 |
| **手机版 APK 下载** | `http://localhost:3000/downloads/Linkey-Android.apk` | 纯原生编译独立安装包 |
| **局域网跨设备访问** | `http://<本机局域网IP>:3000` | 如 `http://192.168.1.8:3000` |
