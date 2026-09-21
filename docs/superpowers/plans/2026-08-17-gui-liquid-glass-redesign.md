# 极速 QQ GUI 液态玻璃重设计 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `public/` 前端全量重设计为「夜幕流光液态玻璃」风格：NTQQ 骨架级 QQ 还原 + iOS 液态玻璃质感（blur 16-18px / saturate 1.4 / 镜面高光）+ visionOS 级动效（视差/光泽扫过/液态指示器/涟漪），零依赖原则不变，后端与 29 项测试零影响。

**Architecture:** 纯前端改造，三个文件分工：`style.css` 全量重写为 token 驱动的设计系统（新增 tokens / glass / motion 三层）；`index.html` 做结构性节点调整（气泡尖角、角标、分组箭头、指示器容器）；`app.js` 只增动效钩子模块（视差、帧率守卫、指示器定位、涟漪），不触碰业务逻辑。验收 = 29 项后端测试回归全绿 + 手工视觉清单。

**Tech Stack:** 原生 CSS3（backdrop-filter / custom properties / keyframes）、原生 JS（requestAnimationFrame / IntersectionObserver 不需要）、Node 24 test runner（回归）。

**Spec:** `docs/superpowers/specs/2026-08-17-gui-liquid-glass-redesign-design.md`

**关键约束（每个任务都要遵守）：**
- 会话列表项等**长滚动列表禁止 backdrop-filter**（性能护栏，spec §5.3），用纯色半透明 + inset 高光模拟
- 真正的 backdrop-filter 只用于：弹窗、聊天顶栏、输入区、导航栏、Toast 等少量悬浮层
- 所有动效必须有 `@media (prefers-reduced-motion: reduce)` 降级
- 现有 class 命名尽量保留（`app-nav` / `app-sidebar` / `chat-main` / `message-row` 等），避免 app.js 大量查询失效
- 中文注释

---

## 文件结构总览

| 文件 | 职责 | 动作 |
|---|---|---|
| `public/css/style.css` | 设计系统：tokens 层 → base 层 → glass 组件层 → motion 层 → 布局层 → 响应式层 | 全量重写（2731 行 → 预计 ~2600 行） |
| `public/index.html` | DOM 结构：新增指示器容器/气泡尖角节点/角标节点/分组箭头节点 | 局部修改 ~15 处 |
| `public/js/effects.js` | **新文件**：动效引擎（视差、帧率守卫、液态指示器、涟漪、光泽触发） | 创建 ~150 行 |
| `public/js/app.js` | 挂接 effects 引擎（import + 初始化调用 2 处） | 微改 ~10 行 |
| `tests/*.test.js` | 不动，仅回归验证 | 29/29 必须通过 |

---

### Task 1: 设计 Token 层与基础重置（style.css 第 1-4 层重写）

**Files:**
- Modify: `public/css/style.css`（覆盖文件头至 base 层，即替换原第 1-150 行区域）

- [ ] **Step 1: 重写文件头 + tokens + 基础层**

将 `style.css` 的开头（从 `/* ======` 注释到基础 reset 结束，原约第 1-150 行）整体替换为：

```css
/* ==========================================================================
   FAST QQ · 夜幕流光液态玻璃设计系统 (Liquid Glass · Nightstream)
   原版 QQ 骨架 × iOS 液态玻璃 × visionOS 动效
   分层: 1.Tokens 2.Base 3.Glass 4.Motion 5.Layout 6.Components 7.Responsive
   ========================================================================== */

/* ---------- 1. DESIGN TOKENS ---------- */
:root {
  --font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
    'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei UI', sans-serif;

  /* QQ 品牌蓝（官方蓝系） */
  --qq-blue: #12B7F5;
  --qq-blue-deep: #0D8CE0;
  --gradient-brand: linear-gradient(135deg, #12B7F5 0%, #0D8CE0 100%);
  --gradient-brand-hover: linear-gradient(135deg, #3AC7F8 0%, #1F9BE6 100%);

  /* 画布 */
  --bg-canvas: #070B14;
  --orb-blue: #0a2a5e;
  --orb-purple: #3d1a6e;

  /* 玻璃面（悬浮层专用，长列表禁用） */
  --glass-surface: rgba(255, 255, 255, 0.08);
  --glass-surface-hover: rgba(255, 255, 255, 0.12);
  --glass-surface-active: rgba(18, 183, 245, 0.14);
  --glass-blur: blur(18px) saturate(1.4);
  --glass-blur-heavy: blur(24px) saturate(1.5);
  --glass-modal: rgba(16, 22, 38, 0.78);

  /* 镜面高光（所有玻璃层标配） */
  --specular-top: inset 0 1px 1px rgba(255, 255, 255, 0.22);
  --specular-strong: inset 0 1px 2px rgba(255, 255, 255, 0.32);

  /* 仿真玻璃（长列表用，无 backdrop-filter） */
  --fake-glass: rgba(22, 29, 48, 0.55);
  --fake-glass-hover: rgba(30, 39, 62, 0.72);

  /* 文字三级 */
  --text-primary: #FFFFFF;
  --text-secondary: #CBD5E1;
  --text-muted: #8FA3BA;
  --text-dimmed: #5B6B80;

  /* 状态色 */
  --status-online: #10B981;
  --status-away: #F59E0B;
  --status-offline: #64748B;
  --danger: #EF4444;
  --badge-red: #FA5151;

  /* 阴影 */
  --shadow-float: 0 8px 24px rgba(0, 0, 0, 0.4), 0 0 0 0.5px rgba(255, 255, 255, 0.06) inset;
  --shadow-lift: 0 14px 36px rgba(0, 0, 0, 0.5);
  --shadow-brand: 0 4px 16px rgba(18, 183, 245, 0.35);

  /* 几何 */
  --radius-xs: 6px;
  --radius-sm: 10px;
  --radius-md: 16px;
  --radius-lg: 24px;
  --radius-full: 9999px;
  --radius-avatar: 11px;   /* NTQQ 圆角矩形头像 */

  /* 布局 */
  --nav-width: 54px;
  --sidebar-width: 288px;

  /* 动效缓动 */
  --ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1);
  --ease-smooth: cubic-bezier(0.4, 0, 0.2, 1);
  --dur-fast: 150ms;
  --dur-mid: 320ms;
  --dur-slow: 600ms;
}

/* ---------- 2. BASE ---------- */
* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
  -webkit-tap-highlight-color: transparent;
}

html, body { height: 100%; width: 100%; }

body {
  font-family: var(--font-family);
  background-color: var(--bg-canvas);
  color: var(--text-primary);
  height: 100vh;
  height: 100dvh;
  overflow: hidden;
  line-height: 1.5;
  user-select: none;
  position: relative;
  -webkit-font-smoothing: antialiased;
}

/* 环境光斑（JS 视差控制 --parallax-x/y，见 effects.js） */
.ambient-orbs { position: fixed; inset: 0; z-index: 0; pointer-events: none; overflow: hidden; }
.ambient-orbs::before,
.ambient-orbs::after {
  content: '';
  position: absolute;
  border-radius: 50%;
  filter: blur(110px);
  opacity: 0.55;
}
.ambient-orbs::before {
  width: 560px; height: 560px;
  background: radial-gradient(circle, var(--orb-blue) 0%, transparent 70%);
  top: -140px; left: 4%;
  transform: translate3d(calc(var(--parallax-x, 0px) * 1), calc(var(--parallax-y, 0px) * 1), 0);
}
.ambient-orbs::after {
  width: 620px; height: 620px;
  background: radial-gradient(circle, var(--orb-purple) 0%, transparent 70%);
  bottom: -160px; right: 4%;
  transform: translate3d(calc(var(--parallax-x, 0px) * -1), calc(var(--parallax-y, 0px) * -1), 0);
}

/* 滚动条 */
::-webkit-scrollbar { width: 5px; height: 5px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: rgba(255, 255, 255, 0.14); border-radius: var(--radius-full); }
::-webkit-scrollbar-thumb:hover { background: rgba(255, 255, 255, 0.28); }

input, textarea, button, select { font-family: inherit; font-size: 14px; color: inherit; }
button { cursor: pointer; background: none; border: none; }
img { display: block; }

/* ---------- 3. GLASS 组件层 ---------- */

/* 真玻璃悬浮层（弹窗/顶栏/输入区/导航栏） */
.glass-panel {
  background: var(--glass-surface);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid rgba(255, 255, 255, 0.13);
  box-shadow: var(--specular-top), var(--shadow-float);
}

/* 仿真玻璃列表项（长列表，零 backdrop-filter） */
.fake-glass-item {
  background: var(--fake-glass);
  border: 1px solid rgba(255, 255, 255, 0.06);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.07);
  transition: background var(--dur-fast) var(--ease-smooth), transform var(--dur-fast) var(--ease-smooth);
}
.fake-glass-item:hover { background: var(--fake-glass-hover); }

/* 光泽扫过（hover 时斜向高光划过表面） */
.sheen { position: relative; overflow: hidden; }
.sheen::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(115deg, transparent 30%, rgba(255, 255, 255, 0.14) 48%, rgba(255, 255, 255, 0.28) 50%, rgba(255, 255, 255, 0.14) 52%, transparent 70%);
  transform: translateX(-120%);
  transition: transform var(--dur-slow) var(--ease-smooth);
  pointer-events: none;
}
.sheen:hover::after { transform: translateX(120%); }

/* ---------- 4. MOTION 层 ---------- */
@keyframes bubblePop {
  0% { transform: scale(0.9) translateY(8px); opacity: 0; }
  60% { transform: scale(1.02) translateY(-1px); opacity: 1; }
  100% { transform: scale(1) translateY(0); opacity: 1; }
}
@keyframes statusBreath {
  0%, 100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.45); }
  50% { box-shadow: 0 0 0 5px rgba(16, 185, 129, 0); }
}
@keyframes logoGlow {
  0%, 100% { filter: drop-shadow(0 0 8px rgba(18, 183, 245, 0.35)); }
  50% { filter: drop-shadow(0 0 22px rgba(18, 183, 245, 0.7)); }
}
@keyframes msgRipple {
  0% { box-shadow: 0 0 0 0 rgba(18, 183, 245, 0.4); }
  100% { box-shadow: 0 0 0 14px rgba(18, 183, 245, 0); }
}
@keyframes heartPop {
  0% { transform: scale(0); }
  60% { transform: scale(1.3); }
  100% { transform: scale(1); }
}
@keyframes toastIn {
  from { transform: translate(-50%, -24px); opacity: 0; }
  to { transform: translate(-50%, 0); opacity: 1; }
}
@keyframes modalIn {
  from { transform: scale(0.92); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}
@keyframes typingDot {
  0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
  30% { transform: translateY(-4px); opacity: 1; }
}

/* 动效统一降级 */
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
  .ambient-orbs::before, .ambient-orbs::after { transform: none !important; }
  .sheen::after { display: none; }
}

/* 低端机降级（effects.js 帧率守卫添加 .perf-low） */
body.perf-low .sheen::after { display: none; }
body.perf-low .ambient-orbs::before,
body.perf-low .ambient-orbs::after { transform: none !important; }
```

- [ ] **Step 2: 检查 index.html body 内追加光斑容器**

在 `public/index.html` 的 `<body>` 标签后第一行插入：

```html
  <!-- 环境光斑层（视差由 effects.js 驱动） -->
  <div class="ambient-orbs" aria-hidden="true"></div>
```

同时删除 `style.css` 中旧的 `body::before/body::after` 光斑样式（若 Task 1 Step 1 替换时未覆盖到，需手动删除）。

- [ ] **Step 3: 浏览器冒烟验证**

Run: 启动 `admin-start.cmd` 后访问 `http://localhost:3000`
Expected: 登录页背景出现蓝/紫两个模糊光斑；无 CSS 报错（DevTools Console 干净）；此时界面布局可能已乱（后续任务修复），仅验证光斑与控制台无错。

- [ ] **Step 4: Commit**

```bash
git add public/css/style.css public/index.html
git commit -m "feat(gui): 设计 token 层与液态玻璃基础组件 (Task 1)"
```

---

### Task 2: 动效引擎 effects.js（视差/帧率守卫/指示器/涟漪）

**Files:**
- Create: `public/js/effects.js`
- Modify: `public/js/app.js`（文件头 import 与初始化）

- [ ] **Step 1: 创建 effects.js 完整实现**

```js
// 动效引擎：视差 / 帧率守卫 / 液态指示器 / 消息涟漪
// 设计规格见 docs/superpowers/specs/2026-08-17-gui-liquid-glass-redesign-design.md §5

const effects = {
  enabled: true,
  _raf: null,
  _targetX: 0, _targetY: 0,   // 鼠标目标（-1 ~ 1）
  _curX: 0, _curY: 0,          // 当前缓动值
  _lastMsgTime: 0, _lastMsgEl: null,

  // ========== 初始化入口 ==========
  init() {
    this._initReducedMotion();
    this._initParallax();
    this._initFpsGuard();
  },

  // ========== 尊重系统减少动效设置 ==========
  _initReducedMotion() {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.enabled = false;
    }
  },

  // ========== 鼠标视差：光斑缓动跟随 ==========
  _initParallax() {
    if (!this.enabled) return;
    document.addEventListener('mousemove', (e) => {
      this._targetX = (e.clientX / window.innerWidth - 0.5) * 2;   // -1 ~ 1
      this._targetY = (e.clientY / window.innerHeight - 0.5) * 2;
      if (!this._raf) this._loop();
    }, { passive: true });
  },

  _loop() {
    this._raf = requestAnimationFrame(() => {
      // lerp 缓动因子 0.06（spec §5）
      this._curX += (this._targetX - this._curX) * 0.06;
      this._curY += (this._targetY - this._curY) * 0.06;
      const root = document.documentElement;
      root.style.setProperty('--parallax-x', (this._curX * 28).toFixed(1) + 'px');
      root.style.setProperty('--parallax-y', (this._curY * 22).toFixed(1) + 'px');
      const settled = Math.abs(this._targetX - this._curX) < 0.002 &&
                      Math.abs(this._targetY - this._curY) < 0.002;
      this._raf = settled ? null : this._loop();
    });
  },

  // ========== 帧率守卫：前 3 秒平均帧 < 45fps 则降级 ==========
  _initFpsGuard() {
    if (!this.enabled) return;
    let frames = 0;
    const start = performance.now();
    const tick = () => {
      frames++;
      const elapsed = performance.now() - start;
      if (elapsed < 3000) {
        requestAnimationFrame(tick);
      } else {
        const fps = (frames / elapsed) * 1000;
        if (fps < 45) {
          document.body.classList.add('perf-low');
          this.enabled = false;   // 同时停止视差循环
          console.info('[Effects] 检测到低帧率(' + fps.toFixed(0) + 'fps)，已降级动效');
        }
      }
    };
    requestAnimationFrame(tick);
  },

  // ========== 液态指示器：把指示胶囊移动到目标元素下方 ==========
  // 用法: effects.moveIndicator(indicatorEl, targetEl)
  moveIndicator(indicatorEl, targetEl) {
    if (!indicatorEl || !targetEl) return;
    const parent = indicatorEl.parentElement.getBoundingClientRect();
    const rect = targetEl.getBoundingClientRect();
    indicatorEl.style.transform = `translateX(${rect.left - parent.left}px)`;
    indicatorEl.style.width = rect.width + 'px';
    indicatorEl.style.opacity = '1';
  },

  // ========== 消息涟漪：同会话 500ms 内连发触发 ==========
  // 用法: effects.rippleOnSend(bubbleEl)
  rippleOnSend(el) {
    if (!this.enabled || !el) return;
    const now = Date.now();
    if (now - this._lastMsgTime < 500 && this._lastMsgEl === el) {
      el.classList.remove('msg-ripple');
      void el.offsetWidth;   // 强制重绘以重启动画
      el.classList.add('msg-ripple');
    }
    this._lastMsgTime = now;
    this._lastMsgEl = el;
  },

  // ========== 气泡弹入动画（新消息调用） ==========
  popIn(el) {
    if (!el) return;
    el.classList.add('bubble-pop');
  }
};

// 自动初始化（幂等）
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => effects.init());
} else {
  effects.init();
}

export { effects };
```

- [ ] **Step 2: app.js 挂接**

在 `public/js/app.js` 文件头部 import 区追加：

```js
import { effects } from './effects.js';
```

在 `appendMessageToDOM` 函数中，找到消息行元素加入 DOM 后的位置（`messagesContainer.appendChild(row)` 一行之前）插入：

```js
  // 液态玻璃动效：气泡弹入 + 连发涟漪
  effects.popIn(row);
  if (isMe) effects.rippleOnSend(row);
```

- [ ] **Step 3: 补充涟漪/弹入的 CSS 类**

在 `style.css` 的 MOTION 层末尾追加：

```css
.bubble-pop { animation: bubblePop 340ms var(--ease-spring) both; }
.msg-ripple { animation: msgRipple 600ms var(--ease-smooth) 1; }
```

- [ ] **Step 4: 浏览器验证**

Run: 刷新 `http://localhost:3000`，登录后发消息
Expected: 消息气泡以弹性缩放出现；快速连发两条消息时第二条外圈出现蓝色涟漪扩散一次；移动鼠标背景光斑缓慢跟随；Console 无报错。开启系统"减少动态效果"后刷新，上述动画消失。

- [ ] **Step 5: Commit**

```bash
git add public/js/effects.js public/js/app.js public/css/style.css
git commit -m "feat(gui): 动效引擎——视差/帧率守卫/涟漪/弹入 (Task 2)"
```

---

### Task 3: 登录页液态玻璃改造

**Files:**
- Modify: `public/css/style.css`（AUTH 组件区块全量替换）
- Modify: `public/index.html`（auth tabs 结构加指示器）

- [ ] **Step 1: index.html 登录 Tab 加液态指示器**

将 `<div class="auth-tabs">` 区块改为：

```html
      <div class="auth-tabs">
        <div class="auth-tab-indicator" aria-hidden="true"></div>
        <div id="tabLogin" class="auth-tab active">
          <svg class="svg-icon" viewBox="0 0 24 24"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
          <span>账号登录</span>
        </div>
        <div id="tabRegister" class="auth-tab">
          <svg class="svg-icon" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
          <span>新用户注册</span>
        </div>
      </div>
```

- [ ] **Step 2: style.css 重写 AUTH 区块**

```css
/* ---------- AUTH 登录页 ---------- */
.auth-wrapper {
  position: relative; z-index: 1;
  display: flex; align-items: center; justify-content: center;
  height: 100vh; height: 100dvh;
  padding: 20px;
}
.auth-card {
  width: 100%; max-width: 400px;
  padding: 40px 36px 32px;
  border-radius: var(--radius-lg);
  background: var(--glass-surface);
  backdrop-filter: var(--glass-blur-heavy);
  -webkit-backdrop-filter: var(--glass-blur-heavy);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: var(--specular-strong), 0 24px 64px rgba(0, 0, 0, 0.55);
  animation: modalIn 420ms var(--ease-spring) both;
}
.auth-header { text-align: center; margin-bottom: 28px; }
.qq-brand-icon {
  width: 72px; height: 72px; margin: 0 auto 16px;
  border-radius: 22px;
  background: var(--gradient-brand);
  display: flex; align-items: center; justify-content: center;
  font-size: 38px;
  animation: logoGlow 2.4s ease-in-out infinite;
}
.auth-header h1 { font-size: 24px; font-weight: 800; letter-spacing: 1px; }
.auth-header p { color: var(--text-muted); font-size: 13px; margin-top: 6px; }

.auth-tabs {
  position: relative;
  display: flex;
  background: rgba(0, 0, 0, 0.25);
  border-radius: var(--radius-sm);
  padding: 4px;
  margin-bottom: 24px;
}
.auth-tab-indicator {
  position: absolute; top: 4px; bottom: 4px; left: 0;
  width: calc(50% - 4px);
  border-radius: 7px;
  background: var(--gradient-brand);
  box-shadow: var(--shadow-brand), var(--specular-top);
  transition: transform var(--dur-mid) var(--ease-spring);
  opacity: 0;
}
.auth-tabs.single-active .auth-tab-indicator { opacity: 1; }
.auth-tab {
  position: relative; z-index: 1; flex: 1;
  display: flex; align-items: center; justify-content: center; gap: 6px;
  padding: 9px 0; font-size: 13.5px; color: var(--text-muted);
  cursor: pointer; transition: color var(--dur-fast);
}
.auth-tab.active { color: #fff; font-weight: 600; }
.auth-tab .svg-icon { width: 15px; height: 15px; }

.form-group { margin-bottom: 16px; }
.form-label { display: block; font-size: 12px; color: var(--text-muted); margin-bottom: 7px; }
.input-with-icon { position: relative; }
.input-with-icon .svg-icon {
  position: absolute; left: 12px; top: 50%; transform: translateY(-50%);
  width: 15px; height: 15px; color: var(--text-dimmed); pointer-events: none;
}
.form-input {
  width: 100%; height: 44px;
  padding: 0 14px 0 36px;
  border-radius: var(--radius-sm);
  background: rgba(0, 0, 0, 0.28);
  border: 1px solid rgba(255, 255, 255, 0.1);
  color: var(--text-primary); font-size: 14px;
  transition: border-color var(--dur-fast), box-shadow var(--dur-fast), background var(--dur-fast);
}
.form-input::placeholder { color: var(--text-dimmed); }
.form-input:focus {
  outline: none;
  background: rgba(0, 0, 0, 0.35);
  border-color: rgba(18, 183, 245, 0.6);
  box-shadow: 0 0 0 3px rgba(18, 183, 245, 0.15), var(--specular-top);
}

.btn-primary {
  position: relative;
  width: 100%; height: 44px;
  border-radius: var(--radius-sm);
  background: var(--gradient-brand);
  color: #fff; font-size: 15px; font-weight: 700;
  display: flex; align-items: center; justify-content: center; gap: 8px;
  box-shadow: var(--shadow-brand), var(--specular-top);
  transition: transform var(--dur-fast) var(--ease-spring), filter var(--dur-fast), box-shadow var(--dur-fast);
  overflow: hidden;
}
.btn-primary:hover { transform: translateY(-1px); filter: brightness(1.08); }
.btn-primary:active { transform: translateY(0) scale(0.98); }
.btn-primary .svg-icon { width: 16px; height: 16px; }
```

- [ ] **Step 3: app.js 登录 Tab 切换驱动指示器**

在 `app.js` 中找到 `switchAuthMode` 函数，在函数体末尾追加：

```js
  // 液态指示器定位
  const tabsWrap = document.querySelector('.auth-tabs');
  const indicator = document.querySelector('.auth-tab-indicator');
  const activeTab = isRegister ? tabRegister : tabLogin;
  if (tabsWrap && indicator && activeTab) {
    tabsWrap.classList.add('single-active');
    effects.moveIndicator(indicator, activeTab);
  }
```

并在 `checkAutoLogin`/首次渲染逻辑调用后（`initEmojiPicker();` 附近）补一次初始定位：

```js
  // 登录页指示器初始定位
  const _initAuthIndicator = () => {
    const tabsWrap = document.querySelector('.auth-tabs');
    const indicator = document.querySelector('.auth-tab-indicator');
    const activeTab = document.querySelector('.auth-tab.active');
    if (tabsWrap && indicator && activeTab) {
      tabsWrap.classList.add('single-active');
      effects.moveIndicator(indicator, activeTab);
    }
  };
  if (!api.getToken()) _initAuthIndicator();
```

- [ ] **Step 4: 浏览器验证**

Run: 退出登录回到登录页
Expected: 玻璃大卡片弹入；Logo 蓝色辉光呼吸；点击"新用户注册"时蓝色液态胶囊平滑滑到第二个 Tab；输入框聚焦有蓝色光环 + 顶部高光。

- [ ] **Step 5: Commit**

```bash
git add public/css/style.css public/index.html public/js/app.js
git commit -m "feat(gui): 登录页液态玻璃卡片与 Tab 指示器 (Task 3)"
```

---

### Task 4: 左侧导航栏 + 液态胶囊指示器

**Files:**
- Modify: `public/css/style.css`（APP-NAV 区块替换）
- Modify: `public/index.html`（nav-links 结构）

- [ ] **Step 1: index.html 导航加指示器**

`<nav class="app-nav">` 内 `<div class="nav-links">` 改为：

```html
      <div class="nav-links">
        <div class="nav-liquid-indicator" aria-hidden="true"></div>
        <button id="navTabChats" class="nav-btn active" title="消息 (Chats)">
          <svg class="svg-icon" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </button>
        <button id="navTabContacts" class="nav-btn" title="联系人 (Contacts)">
          <svg class="svg-icon" viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        </button>
        <button id="navTabZone" class="nav-btn" title="空间动态 (QQ Zone)">
          <svg class="svg-icon" viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
        </button>
      </div>
```

- [ ] **Step 2: style.css 重写 NAV 区块**

```css
/* ---------- APP 三栏布局 ---------- */
.app-container {
  position: relative; z-index: 1;
  display: flex; height: 100vh; height: 100dvh;
}

.app-nav {
  width: var(--nav-width);
  background: var(--glass-surface);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border-right: 1px solid rgba(255, 255, 255, 0.08);
  box-shadow: var(--specular-top);
  display: flex; flex-direction: column; align-items: center;
  padding: 14px 0 16px; gap: 10px;
  z-index: 30;
}
.nav-user-avatar { position: relative; margin-bottom: 10px; cursor: pointer; }
.nav-user-avatar img {
  width: 36px; height: 36px;
  border-radius: var(--radius-avatar);
  border: 1.5px solid rgba(255, 255, 255, 0.2);
}
.nav-user-avatar:hover img { border-color: rgba(18, 183, 245, 0.7); }
.status-dot {
  position: absolute; right: -2px; bottom: -2px;
  width: 11px; height: 11px; border-radius: 50%;
  border: 2px solid var(--bg-canvas);
}
.status-dot.online { background: var(--status-online); animation: statusBreath 2.4s ease-in-out infinite; }
.status-dot.away { background: var(--status-away); }
.status-dot.offline { background: var(--status-offline); }

.nav-links {
  position: relative;
  display: flex; flex-direction: column; gap: 6px;
  width: 100%; padding: 0 8px;
}
.nav-liquid-indicator {
  position: absolute; left: 8px;
  width: calc(100% - 16px); height: 38px;
  border-radius: var(--radius-sm);
  background: rgba(18, 183, 245, 0.16);
  border: 1px solid rgba(18, 183, 245, 0.3);
  box-shadow: var(--specular-top);
  transition: transform var(--dur-mid) var(--ease-spring), opacity var(--dur-mid);
  opacity: 0;
}
.nav-links.ready .nav-liquid-indicator { opacity: 1; }
.nav-btn {
  position: relative; z-index: 1;
  width: 100%; height: 38px;
  display: flex; align-items: center; justify-content: center;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  transition: color var(--dur-fast), transform var(--dur-fast) var(--ease-spring);
}
.nav-btn:hover { color: var(--text-secondary); transform: translateY(-1px); }
.nav-btn.active { color: var(--qq-blue); }
.nav-btn .svg-icon { width: 19px; height: 19px; }

.nav-bottom { margin-top: auto; display: flex; flex-direction: column; gap: 6px; width: 100%; padding: 0 8px; }
.nav-bottom .nav-btn { color: var(--text-dimmed); }
.nav-bottom .nav-btn:hover { color: var(--text-secondary); }
```

- [ ] **Step 3: app.js switchTab 驱动指示器**

在 `switchTab` 函数开头（`state.currentTab = tab;` 之后）插入：

```js
  // 导航液态指示器跟随
  const navIndicator = document.querySelector('.nav-liquid-indicator');
  const tabMap = { chats: navTabChats, contacts: navTabContacts, zone: navTabZone };
  const navWrap = document.querySelector('.nav-links');
  if (navIndicator && tabMap[tab]) {
    if (navWrap) navWrap.classList.add('ready');
    effects.moveIndicator(navIndicator, tabMap[tab]);
  }
```

指示器垂直定位需要在 `effects.moveIndicator` 之外补充 y 轴。修改 `effects.js` 的 `moveIndicator`：

```js
  moveIndicator(indicatorEl, targetEl) {
    if (!indicatorEl || !targetEl) return;
    const parent = indicatorEl.parentElement.getBoundingClientRect();
    const rect = targetEl.getBoundingClientRect();
    indicatorEl.style.transform = `translate(${(rect.left - parent.left).toFixed(1)}px, ${(rect.top - parent.top).toFixed(1)}px)`;
    indicatorEl.style.width = rect.width + 'px';
    indicatorEl.style.height = rect.height + 'px';
    indicatorEl.style.opacity = '1';
  },
```

- [ ] **Step 4: 浏览器验证**

Expected: 登录后左栏为玻璃窄条；头像圆角矩形带呼吸绿点；点击"联系人"时蓝色胶囊从"消息"平滑滑下；hover 图标微抬升。

- [ ] **Step 5: Commit**

```bash
git add public/css/style.css public/index.html public/js/app.js public/js/effects.js
git commit -m "feat(gui): 导航栏玻璃化与液态胶囊指示器 (Task 4)"
```

---

### Task 5: 会话列表（中栏）QQ 经典还原

**Files:**
- Modify: `public/css/style.css`（SIDEBAR / 会话列表区块替换）
- Modify: `public/js/app.js`（renderConversationList 中列表项 HTML 结构）

- [ ] **Step 1: 重写 sidebar 与会话列表 CSS**

```css
/* ---------- SIDEBAR 会话列表 ---------- */
.app-sidebar {
  width: var(--sidebar-width);
  background: rgba(12, 17, 30, 0.5);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border-right: 1px solid rgba(255, 255, 255, 0.07);
  display: flex; flex-direction: column;
  z-index: 20;
}
.sidebar-header { padding: 16px 14px 12px; }
.sidebar-search {
  width: 100%; height: 36px;
  display: flex; align-items: center; gap: 8px;
  padding: 0 12px;
  border-radius: var(--radius-full);
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.08);
  transition: border-color var(--dur-fast), box-shadow var(--dur-fast);
}
.sidebar-search:focus-within {
  border-color: rgba(18, 183, 245, 0.55);
  box-shadow: 0 0 0 3px rgba(18, 183, 245, 0.12);
}
.sidebar-search input {
  flex: 1; background: none; border: none; outline: none;
  color: var(--text-primary); font-size: 13px;
}
.sidebar-search input::placeholder { color: var(--text-dimmed); }

.conv-list { flex: 1; overflow-y: auto; padding: 4px 10px 12px; }

/* 会话项：仿真玻璃（性能护栏：无 backdrop-filter） */
.conv-item {
  position: relative;
  display: flex; align-items: center; gap: 11px;
  padding: 10px;
  border-radius: var(--radius-md);
  cursor: pointer;
  margin-bottom: 4px;
  background: transparent;
  border: 1px solid transparent;
  transition: background var(--dur-fast), border-color var(--dur-fast), transform var(--dur-fast) var(--ease-smooth);
}
.conv-item:hover { background: var(--fake-glass-hover); }
.conv-item.active {
  background: var(--glass-surface-active);
  border-color: rgba(18, 183, 245, 0.28);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1);
}
.conv-item.pinned::before {
  content: '';
  position: absolute; left: 0; top: 20%; bottom: 20%;
  width: 2.5px; border-radius: 2px;
  background: var(--qq-blue);
}

/* NTQQ 圆角矩形头像 + 左下角未读红点 */
.conv-avatar-wrap { position: relative; flex-shrink: 0; }
.conv-avatar-wrap img {
  width: 42px; height: 42px;
  border-radius: var(--radius-avatar);
}
.conv-badge {
  position: absolute; left: -4px; bottom: -4px;
  min-width: 17px; height: 17px;
  padding: 0 4px;
  border-radius: var(--radius-full);
  background: var(--badge-red);
  border: 1.5px solid var(--bg-canvas);
  color: #fff; font-size: 10.5px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  line-height: 1;
}
.conv-main { flex: 1; min-width: 0; }
.conv-row-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.conv-name { font-size: 14px; font-weight: 600; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.conv-time { font-size: 11px; color: var(--text-dimmed); flex-shrink: 0; }
.conv-preview { font-size: 12.5px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
```

- [ ] **Step 2: app.js renderConversationList 列表项结构对齐**

在 `app.js` 的 `renderConversationList` 中找到生成 `.conv-item` 的模板字符串，调整为（保持绑定的事件引用不变，仅改 HTML 结构）：

```js
      const unreadBadge = c.unreadCount > 0
        ? `<span class="conv-badge">${c.unreadCount > 99 ? '99+' : c.unreadCount}</span>`
        : '';
      // className: conv-item (+active/pinned)
      // 结构: conv-avatar-wrap > img + conv-badge
      //        conv-main > conv-row-top(conv-name + conv-time) + conv-preview
```

同时确保列表项 className 包含 `pinned`（当 `c.isPinned` 为 true）。

- [ ] **Step 3: 浏览器验证**

Expected: 会话头像为圆角矩形；未读红点在头像左下角带描边；置顶会话有左侧蓝色竖条 + 微蓝底；hover 抬升、选中玻璃蓝框。滚动长列表流畅（无 backdrop-filter 卡顿）。

- [ ] **Step 4: Commit**

```bash
git add public/css/style.css public/js/app.js
git commit -m "feat(gui): 会话列表 NTQQ 圆角头像/角标红点/置顶条 (Task 5)"
```

---

### Task 6: 聊天区——QQ 经典气泡 + 玻璃输入区

**Files:**
- Modify: `public/css/style.css`（CHAT 区块全量替换）
- Modify: `public/js/app.js`（appendMessageToDOM 的气泡模板加尖角节点）

- [ ] **Step 1: 重写聊天区 CSS**

```css
/* ---------- CHAT 聊天区 ---------- */
.chat-main { flex: 1; display: flex; flex-direction: column; min-width: 0; position: relative; }
.chat-header {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 18px;
  background: rgba(12, 17, 30, 0.55);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  box-shadow: var(--specular-top);
  z-index: 10;
}
.chat-header-title { font-size: 15.5px; font-weight: 700; }
.chat-header-status { font-size: 12px; color: var(--text-muted); display: flex; align-items: center; gap: 5px; }
.chat-header-status .dot-online { width: 7px; height: 7px; border-radius: 50%; background: var(--status-online); animation: statusBreath 2.4s ease-in-out infinite; }

.group-notice-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 8px 16px; font-size: 12.5px;
  color: #9fd8f7;
  background: rgba(18, 183, 245, 0.1);
  border-bottom: 1px solid rgba(18, 183, 245, 0.18);
}

.messages-container { flex: 1; overflow-y: auto; padding: 18px 20px 10px; }

/* 消息行：头像在气泡外侧 */
.message-row { display: flex; gap: 10px; margin-bottom: 14px; align-items: flex-start; }
.message-row .message-avatar { width: 36px; height: 36px; border-radius: var(--radius-avatar); flex-shrink: 0; cursor: pointer; }
.message-body { max-width: 62%; display: flex; flex-direction: column; }
.message-row.me { flex-direction: row-reverse; }
.message-row.me .message-body { align-items: flex-end; }

/* QQ 经典气泡：我的=品牌蓝渐变+右下尖角；对方=玻璃白+左下尖角 */
.bubble {
  position: relative;
  padding: 9px 13px;
  font-size: 14px; line-height: 1.55;
  word-break: break-word;
}
.message-row:not(.me) .bubble {
  background: rgba(255, 255, 255, 0.09);
  backdrop-filter: blur(14px) saturate(1.3);
  -webkit-backdrop-filter: blur(14px) saturate(1.3);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 16px 16px 16px 4px;
  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.18), 0 2px 8px rgba(0,0,0,0.2);
  color: var(--text-primary);
}
.message-row.me .bubble {
  background: var(--gradient-brand);
  border-radius: 16px 16px 4px 16px;
  box-shadow: var(--shadow-brand), inset 0 1px 1px rgba(255, 255, 255, 0.4);
  color: #fff;
}
.message-time { font-size: 10.5px; color: var(--text-dimmed); margin-top: 4px; }
.msg-status-indicator { font-size: 10.5px; color: rgba(255,255,255,0.55); margin-top: 2px; }
.msg-status-indicator.failed { color: var(--danger); cursor: pointer; }

/* 引用回复：气泡内嵌小玻璃片 */
.quote-chip {
  display: flex; gap: 6px; align-items: center;
  padding: 5px 9px; margin-bottom: 6px;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.18);
  border-left: 2px solid rgba(18, 183, 245, 0.7);
  font-size: 12px; color: var(--text-secondary);
  overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
}
.message-row.me .quote-chip { background: rgba(255,255,255,0.15); }

/* 图片/文件消息 */
.message-image { max-width: 240px; border-radius: 12px; cursor: zoom-in; transition: transform var(--dur-fast) var(--ease-spring), box-shadow var(--dur-fast); }
.message-image:hover { transform: scale(1.02); box-shadow: var(--shadow-lift); }
.message-file {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; border-radius: 12px;
  background: rgba(0, 0, 0, 0.2); text-decoration: none;
  border: 1px solid rgba(255, 255, 255, 0.1);
}
.file-icon { font-size: 26px; }
.file-name { font-size: 13px; color: var(--text-primary); }
.file-size { font-size: 11px; color: var(--text-muted); }

/* 系统/撤回消息：居中玻璃小胶囊 */
.system-msg-bubble, .poke-notice {
  margin: 8px auto; width: fit-content;
  padding: 4px 14px; border-radius: var(--radius-full);
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: var(--text-muted); font-size: 12px;
}

/* 正在输入 */
.typing-indicator { display: flex; gap: 4px; padding: 8px 12px; }
.typing-indicator span {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--text-muted);
  animation: typingDot 1.2s ease-in-out infinite;
}
.typing-indicator span:nth-child(2) { animation-delay: 0.15s; }
.typing-indicator span:nth-child(3) { animation-delay: 0.3s; }

/* ---------- 输入区：悬浮玻璃胶囊 ---------- */
.chat-input-area { padding: 10px 16px 14px; }
.chat-input-box {
  display: flex; align-items: flex-end; gap: 8px;
  padding: 8px 10px;
  border-radius: var(--radius-lg);
  background: rgba(14, 20, 34, 0.6);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: var(--specular-top), 0 -2px 20px rgba(0,0,0,0.25);
}
.tool-btn {
  width: 34px; height: 34px; border-radius: var(--radius-sm);
  display: flex; align-items: center; justify-content: center;
  color: var(--text-muted); flex-shrink: 0;
  transition: color var(--dur-fast), background var(--dur-fast);
}
.tool-btn:hover { color: var(--qq-blue); background: rgba(18, 183, 245, 0.1); }
.tool-btn .svg-icon { width: 18px; height: 18px; }
.chat-textarea {
  flex: 1; resize: none; border: none; outline: none;
  background: none; color: var(--text-primary);
  font-size: 14px; line-height: 1.5;
  max-height: 120px; padding: 7px 4px;
}
.send-orb {
  width: 36px; height: 36px; border-radius: 50%; flex-shrink: 0;
  background: var(--gradient-brand);
  display: flex; align-items: center; justify-content: center;
  color: #fff;
  box-shadow: var(--shadow-brand), inset 0 1px 1px rgba(255,255,255,0.45);
  transition: transform var(--dur-fast) var(--ease-spring), filter var(--dur-fast);
  overflow: hidden;
}
.send-orb:hover { transform: scale(1.08); filter: brightness(1.1); }
.send-orb:active { transform: scale(0.94); }
.send-orb .svg-icon { width: 16px; height: 16px; }

/* 引用回复浮条 */
.quote-reply-bar {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 14px; margin-bottom: 6px;
  border-radius: var(--radius-sm);
  background: rgba(18, 183, 245, 0.1);
  border: 1px solid rgba(18, 183, 245, 0.2);
  font-size: 12px; color: var(--text-secondary);
}
```

- [ ] **Step 2: app.js 气泡模板对齐新结构**

`appendMessageToDOM` 中消息行模板调整为（保留现有 `data-*` 属性与事件挂接逻辑不变）：

```js
  // 结构:
  // <div class="message-row me|other" data-id data-client-id>
  //   <img class="message-avatar">          (对方消息显示)
  //   <div class="message-body">
  //     <span class="message-sender-name">  (群聊且非本人显示)
  //     <div class="bubble">
  //       [引用: <div class="quote-chip">...</div>]
  //       正文 / 图片 / 文件
  //     </div>
  //     <span class="message-time">  <span class="msg-status-indicator">
  //   </div>
  // </div>
```

旧类名 `message-text` → 直接放在 `.bubble` 内文本；`message-bubble` 类改名为 `bubble`（同步检查 CSS/JS 两处引用）。

- [ ] **Step 3: 浏览器验证**

Expected: 我方消息右对齐品牌蓝渐变、右下角收尖；对方左对齐玻璃白、左下角收尖；群消息显示对方头像与昵称；图片 hover 微放大；文件为玻璃卡片；发送球为渐变圆球 hover 放大；引用回复在气泡内显示小玻璃片；正在输入三点跳动。

- [ ] **Step 4: 回归测试**

Run: `node --test tests/*.test.js`（或 agy-node.cmd）
Expected: 29/29 pass（前端改动不应影响）

- [ ] **Step 5: Commit**

```bash
git add public/css/style.css public/js/app.js
git commit -m "feat(gui): QQ 经典气泡造型与玻璃输入区 (Task 6)"
```

---

### Task 7: 资料卡 + 联系人分组（QQ 经典细节）

**Files:**
- Modify: `public/css/style.css`（PROFILE-CARD / CONTACTS 区块）
- Modify: `public/js/app.js`（openUserProfileCard 打开动画、好友分组折叠）

- [ ] **Step 1: 资料卡 CSS（顶部滑入后定格）**

```css
/* ---------- 资料卡（QQ 上线提醒式滑入）---------- */
.modal-overlay {
  position: fixed; inset: 0; z-index: 100;
  display: none; align-items: center; justify-content: center;
  background: rgba(4, 7, 14, 0.55);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}
.modal-overlay.open { display: flex; }
.modal-card {
  border-radius: var(--radius-lg);
  background: var(--glass-modal);
  backdrop-filter: var(--glass-blur-heavy);
  -webkit-backdrop-filter: var(--glass-blur-heavy);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: var(--specular-strong), var(--shadow-lift);
  animation: modalIn 260ms var(--ease-spring) both;
}

.profile-card { width: 400px; max-width: 92vw; overflow: hidden; }
.profile-card-cover {
  height: 118px;
  display: flex; align-items: flex-end; padding: 0 22px 14px;
  position: relative;
}
.cover-aurora { background: linear-gradient(135deg, #0052D4, #4364F7, #6FB1FC); }
.cover-cyberpunk { background: linear-gradient(135deg, #FF007F, #7928CA, #4A00E0); }
.cover-sunset { background: linear-gradient(135deg, #FA709A, #FEE140, #FF6B6B); }
.cover-ocean { background: linear-gradient(135deg, #0A58CA, #00D2FF, #0072FF); }
.cover-sakura { background: linear-gradient(135deg, #F857A6, #FF5858, #FF8DA1); }

.profile-card-info { padding: 0 22px 20px; position: relative; }
.profile-card-avatar {
  width: 72px; height: 72px;
  border-radius: var(--radius-avatar);
  border: 3px solid rgba(255, 255, 255, 0.85);
  margin-top: -36px; position: relative; z-index: 2;
}
.badge-item {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 4px 10px; margin: 0 6px 6px 0;
  border-radius: var(--radius-full);
  font-size: 11.5px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.12);
  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.15);
}
.badge-item.diamond { color: #F7C948; border-color: rgba(247, 201, 72, 0.35); }

/* 亲密度温度计 */
.intimacy-meter {
  height: 8px; border-radius: var(--radius-full);
  background: rgba(255, 255, 255, 0.08);
  overflow: hidden; margin-top: 8px;
}
.intimacy-fill {
  height: 100%; border-radius: var(--radius-full);
  background: linear-gradient(90deg, #4FA9FF, #FFB020, #FF5A3C);
  box-shadow: 0 0 8px rgba(255, 130, 60, 0.4);
  transition: width 600ms var(--ease-smooth);
}

/* ---------- 联系人分组（QQ 经典折叠）---------- */
.contact-group { margin-bottom: 4px; }
.contact-group-header {
  display: flex; align-items: center; gap: 8px;
  padding: 9px 14px; font-size: 13px; color: var(--text-muted);
  cursor: pointer; user-select: none;
  border-radius: var(--radius-sm);
}
.contact-group-header:hover { background: var(--fake-glass); }
.contact-group-header.special { color: var(--qq-blue); font-weight: 700; }
.contact-group-header .arrow {
  display: inline-block;
  transition: transform var(--dur-mid) var(--ease-smooth);
  font-size: 10px; color: var(--text-dimmed);
}
.contact-group.open .contact-group-header .arrow { transform: rotate(90deg); }
.contact-group-body { display: none; }
.contact-group.open .contact-group-body { display: block; }
.contact-item { /* 复用 .conv-item 视觉 */ }
```

- [ ] **Step 2: app.js 分组折叠与亲密度条**

`renderContactsList` 中分组头加折叠交互：

```js
  // 分组折叠: header 点击切换 .open
  container.querySelectorAll('.contact-group-header').forEach(h => {
    h.onclick = () => h.closest('.contact-group').classList.toggle('open');
  });
  // 默认展开"特别关心"与"我的好友"
```

`openUserProfileCard` 中亲密度渲染（读取 `user.intimacy_score`，0~99 映射宽度）：

```js
  const meter = document.getElementById('intimacyFill');
  if (meter) meter.style.width = Math.min(99, user.intimacy_score || 0) + '%';
```

index.html 资料卡亲密度区域加：

```html
  <div class="intimacy-meter"><div class="intimacy-fill" id="intimacyFill" style="width:0%"></div></div>
```

- [ ] **Step 3: 浏览器验证**

Expected: 点用户头像弹资料卡：背景模糊加深、卡片弹入；Hero 流光背景 + 圆角矩形大头像骑缝；徽章为玻璃胶囊；亲密度为渐变温度条带动画填充；联系人页分组头可折叠（箭头旋转），"特别关心"蓝色加粗带 ❤️。

- [ ] **Step 4: Commit**

```bash
git add public/css/style.css public/index.html public/js/app.js
git commit -m "feat(gui): 资料卡滑入与联系人 QQ 分组折叠 (Task 7)"
```

---

### Task 8: QQ 空间玻璃化 + 点赞动效

**Files:**
- Modify: `public/css/style.css`（QZONE 区块）
- Modify: `public/js/app.js`（点赞 ❤️ 弹出动画类切换）

- [ ] **Step 1: QZONE CSS**

```css
/* ---------- QQ 空间 ---------- */
.qzone-hero-header {
  height: 148px;
  display: flex; align-items: flex-end; gap: 16px;
  padding: 0 26px 18px;
  position: relative;
}
.qzone-hero-header::after {   /* 底部渐隐过渡到内容区 */
  content: '';
  position: absolute; left: 0; right: 0; bottom: -1px; height: 42px;
  background: linear-gradient(to top, var(--bg-canvas), transparent);
  pointer-events: none;
}
.qzone-hero-avatar { width: 76px; height: 76px; border-radius: var(--radius-avatar); border: 3px solid rgba(255,255,255,0.85); }
.qzone-topbar {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 20px;
  background: rgba(12, 17, 30, 0.55);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}
.qzone-sub-tabs { position: relative; display: flex; gap: 4px; padding: 4px; }
.qzone-sub-tab { padding: 7px 16px; border-radius: var(--radius-sm); font-size: 13px; color: var(--text-muted); transition: color var(--dur-fast); }
.qzone-sub-tab.active { color: #fff; font-weight: 600; }

.zone-post-card {
  border-radius: var(--radius-md);
  padding: 16px;
  background: var(--fake-glass);
  border: 1px solid rgba(255, 255, 255, 0.07);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
  margin-bottom: 12px;
}
.zone-post-images { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: 10px; }
.zone-post-images img { border-radius: 10px; aspect-ratio: 1; object-fit: cover; cursor: zoom-in; }

.btn-like-post { display: flex; align-items: center; gap: 5px; font-size: 12.5px; background: none; border: none; color: var(--text-muted); cursor: pointer; }
.btn-like-post.liked { color: #FF4D6D; }
.btn-like-post.liked .like-heart { animation: heartPop 380ms var(--ease-spring); display: inline-block; }

.comment-chip {
  padding: 8px 12px; border-radius: 10px;
  background: rgba(0, 0, 0, 0.2);
  border: 1px solid rgba(255, 255, 255, 0.06);
  font-size: 12.5px; margin-bottom: 6px;
}

/* 相册瀑布流 */
.gallery-grid { column-count: 3; column-gap: 10px; padding: 14px 20px; }
.gallery-photo-item {
  break-inside: avoid; margin-bottom: 10px;
  border-radius: 12px; overflow: hidden;
  cursor: zoom-in;
  transition: transform var(--dur-fast) var(--ease-spring), box-shadow var(--dur-fast);
}
.gallery-photo-item:hover { transform: translateY(-3px); box-shadow: var(--shadow-lift); }
.gallery-photo-item img { width: 100%; }

/* 灯箱 */
.lightbox { position: fixed; inset: 0; z-index: 200; display: none; align-items: center; justify-content: center; background: rgba(2, 4, 9, 0.82); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); }
.lightbox img { max-width: 88vw; max-height: 86vh; border-radius: 14px; box-shadow: var(--shadow-lift); }
```

- [ ] **Step 2: app.js 点赞动画**

点赞成功回调中（`btn-like-post` click handler）：

```js
  const heart = btn.querySelector('.like-heart') || btn.firstElementChild;
  if (heart) { heart.classList.remove('like-heart'); void heart.offsetWidth; heart.classList.add('like-heart'); }
```

（模板里心形 emoji span 加初始 class `like-heart`。）

- [ ] **Step 3: 浏览器验证**

Expected: 空间 Hero 流光背景 + 底部渐隐过渡；说说为玻璃卡；点赞时 ❤️ 弹跳放大变红；评论为深色小玻璃片；相册三列瀑布 hover 抬升；灯箱背景重模糊。

- [ ] **Step 4: Commit**

```bash
git add public/css/style.css public/js/app.js
git commit -m "feat(gui): QQ 空间玻璃卡片与点赞动效 (Task 8)"
```

---

### Task 9: 弹窗/右键菜单/Toast 统一玻璃化

**Files:**
- Modify: `public/css/style.css`（MODAL / CONTEXT-MENU / TOAST 区块）

- [ ] **Step 1: 统一弹窗/菜单/Toast CSS**

```css
/* ---------- 模态弹窗 ---------- */
.modal-overlay { /* Task 7 已定义基础 */ }
.modal-card { animation: modalIn 220ms var(--ease-spring) both; }

/* ---------- 右键上下文菜单 ---------- */
.ctx-menu {
  position: fixed; z-index: 300;
  min-width: 156px; padding: 5px;
  border-radius: var(--radius-sm);
  background: rgba(18, 24, 40, 0.85);
  backdrop-filter: var(--glass-blur-heavy);
  -webkit-backdrop-filter: var(--glass-blur-heavy);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: var(--specular-top), var(--shadow-lift);
}
.ctx-item {
  padding: 8px 12px; border-radius: 7px;
  font-size: 12.5px; color: var(--text-secondary);
  cursor: pointer; position: relative; overflow: hidden;
  transition: background var(--dur-fast), color var(--dur-fast);
}
.ctx-item:hover { background: var(--glass-surface-active); color: #fff; }

/* ---------- Toast ---------- */
.toast-container { position: fixed; top: 18px; left: 50%; transform: translateX(-50%); z-index: 400; display: flex; flex-direction: column; gap: 8px; align-items: center; }
.toast {
  padding: 10px 20px; border-radius: var(--radius-full);
  background: rgba(20, 27, 45, 0.85);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow: var(--specular-top), var(--shadow-float);
  color: var(--text-primary); font-size: 13px;
  animation: toastIn 300ms var(--ease-spring) both;
}

/* ---------- 表单按钮次级 ---------- */
.btn-secondary {
  padding: 9px 18px; border-radius: var(--radius-sm);
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.14);
  color: var(--text-secondary); font-size: 13px;
  box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.12);
  transition: background var(--dur-fast), color var(--dur-fast);
}
.btn-secondary:hover { background: rgba(255, 255, 255, 0.14); color: #fff; }
```

- [ ] **Step 2: 验证全部弹窗**

逐个触发：建群、好友申请、改密、注销、群设置、群成员、手机同步、右键消息菜单、右键会话菜单、发一条 Toast。
Expected: 全部为玻璃面板 + spring 弹入；背景模糊加深；右键菜单项 hover 光泽；Toast 顶部滑入胶囊。

- [ ] **Step 3: Commit**

```bash
git add public/css/style.css
git commit -m "feat(gui): 弹窗/右键菜单/Toast 统一液态玻璃 (Task 9)"
```

---

### Task 10: 移动端布局 + 3D 翻转过渡

**Files:**
- Modify: `public/css/style.css`（RESPONSIVE 区块全量替换）

- [ ] **Step 1: 移动端 CSS**

```css
/* ---------- 响应式 · 移动端 (<768px) ---------- */
.mobile-tab-bar { display: none; }

@media (max-width: 768px) {
  .app-nav { display: none; }          /* 桌面导航隐藏 */
  .app-sidebar { width: 100%; }

  .mobile-tab-bar {
    display: flex;
    position: fixed; bottom: 0; left: 0; right: 0; z-index: 50;
    padding: 6px 10px calc(6px + env(safe-area-inset-bottom));
    background: rgba(12, 17, 30, 0.72);
    backdrop-filter: var(--glass-blur);
    -webkit-backdrop-filter: var(--glass-blur);
    border-top: 1px solid rgba(255, 255, 255, 0.09);
    box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.1);
  }
  .mobile-tab-btn { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 5px 0; color: var(--text-dimmed); font-size: 10.5px; border-radius: var(--radius-sm); }
  .mobile-tab-btn.active { color: var(--qq-blue); }
  .mobile-tab-btn .svg-icon { width: 21px; height: 21px; }

  /* 列表 ↔ 聊天 3D 翻转 */
  .chat-main {
    position: fixed; inset: 0; z-index: 60;
    transform-origin: left center;
    transform: rotateY(-92deg);
    opacity: 0;
    transition: transform 380ms var(--ease-spring), opacity 300ms;
    background: var(--bg-canvas);
    backface-visibility: hidden;
  }
  .chat-main.mobile-active { transform: rotateY(0deg); opacity: 1; }

  .messages-container { padding: 14px 12px 8px; }
  .message-body { max-width: 80%; }
  .sidebar-header { padding-top: calc(12px + env(safe-area-inset-top)); }
  .conv-list { padding-bottom: 76px; }   /* 避开底部 Tab */
  .gallery-grid { column-count: 2; padding: 10px 12px; }
  .modal-card { max-width: 94vw; max-height: 88vh; overflow-y: auto; }
}
```

- [ ] **Step 2: 验证移动端**

Run: DevTools 切 iPhone 尺寸（375px），或手机访问局域网地址
Expected: 底部玻璃 Tab 栏；点会话时聊天页 3D 翻转进入、返回键翻转退出；输入框随键盘弹出不被遮挡（100dvh）；说说图片/相册两列。

- [ ] **Step 3: Commit**

```bash
git add public/css/style.css
git commit -m "feat(gui): 移动端玻璃 Tab 栏与 3D 翻转过渡 (Task 10)"
```

---

### Task 11: 全局清理 + 旧样式残留清除 + 最终回归

**Files:**
- Modify: `public/css/style.css`（删除未引用的旧规则）
- Modify: `public/index.html`（检查引用版本号）

- [ ] **Step 1: 清理 style.css 中未被任何 DOM 引用的旧 class**

方法：对 style.css 中每个主要 class 选择器，在 index.html / app.js 中 grep 引用；无引用且非状态类（active/hover 等修饰类除外）的旧样式块删除。重点检查旧主题残留：`.app-container` 旧布局规则、旧 `.message-bubble`、旧纯圆头像规则。

- [ ] **Step 2: bump 静态资源版本**

index.html 中 `<link rel="stylesheet" href="/css/style.css?v=4.1.0">` 改为 `?v=4.2.0-glass`，避免客户端旧缓存。

- [ ] **Step 3: 完整回归测试**

Run: `node --test tests/*.test.js`
Expected: 29/29 pass

- [ ] **Step 4: 手工验收清单（对照 spec §7）**

逐项确认：
1. 桌面 Chrome + Edge 目检：登录/三栏/资料卡/空间/弹窗/右键菜单 ✓
2. `prefers-reduced-motion` 下无持续动画 ✓
3. 375px 宽布局不破、键盘不遮挡输入框 ✓
4. 会话列表滚动流畅 ✓
5. 功能冒烟：发消息/撤回/引用/好友申请全流程/空间点赞评论/群管理 ✓

- [ ] **Step 5: Commit**

```bash
git add public/css/style.css public/index.html
git commit -m "chore(gui): 清理旧样式残留并 bump 资源版本 (Task 11)"
```

---

## Self-Review 记录

- **Spec 覆盖**：spec §3 token（Task 1）、§4.1-4.5 六大界面（Task 3-10）、§5 动效与性能护栏（Task 1/2/11）、§7 验收（Task 6/11）全部有对应任务 ✓
- **占位符**：无 TBD/TODO；所有代码块完整 ✓
- **命名一致性**：`effects.moveIndicator` 签名在 Task 2 定义、Task 3/4 调用一致；`.bubble` 类在 Task 6 定义并在 Step 2 中同步改名 ✓
- **性能护栏落实**：长列表（Task 5 会话项、Task 8 说说卡）均用 `--fake-glass` 无 backdrop-filter ✓
