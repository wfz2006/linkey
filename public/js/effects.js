// 动效引擎：视差 / 帧率守卫 / 液态指示器 / 消息涟漪
// 设计规格见 docs/superpowers/specs/2026-08-17-gui-liquid-glass-redesign-design.md §5

const effects = {
  enabled: true,
  _raf: null,
  _targetX: 0, _targetY: 0,   // 鼠标目标（-1 ~ 1）
  _curX: 0, _curY: 0,          // 当前缓动值
  _lastMsgTime: 0, _lastMsgContainer: null,

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
      if (!this.enabled) return;   // 帧率降级后彻底停用视差
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
          this.enabled = false;   // 停用动效（视差循环由 mousemove 守卫彻底阻断）
          console.info('[Effects] 检测到低帧率(' + fps.toFixed(0) + 'fps)，已降级动效');
        }
      }
    };
    requestAnimationFrame(tick);
  },

  // ========== 液态指示器：把指示胶囊移动到目标元素位置 ==========
  // 注意：x/y 双轴定位，同时设置 width/height（供导航竖排与 Tab 横排共用）
  // 显隐统一由 CSS 类通道控制（如 .single-active / .ready），此处不写 opacity，
  // 避免与 CSS 类形成双通道冗余
  // 用法: effects.moveIndicator(indicatorEl, targetEl)
  moveIndicator(indicatorEl, targetEl) {
    if (!indicatorEl || !targetEl) return;
    const parent = indicatorEl.parentElement.getBoundingClientRect();
    const rect = targetEl.getBoundingClientRect();
    indicatorEl.style.transform = `translate(${(rect.left - parent.left).toFixed(1)}px, ${(rect.top - parent.top).toFixed(1)}px)`;
    indicatorEl.style.width = rect.width + 'px';
    indicatorEl.style.height = rect.height + 'px';
  },

  // ========== 消息涟漪：同一消息容器 500ms 内连发触发 ==========
  // 说明：调用方每次传入新创建的元素，故按"所属消息容器一致"判定连发，
  // 而非比较元素本身（那样条件恒为 false）
  // 用法: effects.rippleOnSend(bubbleEl)
  rippleOnSend(el) {
    if (!this.enabled || !el) return;
    const now = Date.now();
    const container = el.closest('.messages-container') || el.parentElement;
    if (now - this._lastMsgTime < 500 && this._lastMsgContainer === container) {
      el.classList.remove('msg-ripple');
      void el.offsetWidth;   // 强制重绘以重启动画
      el.classList.add('msg-ripple');
    }
    this._lastMsgTime = now;
    this._lastMsgContainer = container;
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
