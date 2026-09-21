// ============================================================================
// Linkey 本地二维码生成引擎 (零依赖)
// QR Model 2 / Byte 模式 / 纠错级别 M / 版本 1-6 (最长约 104 字节)
// 替代第三方 api.qrserver.com，分享地址不再外发、断网可用
// ============================================================================
(function (global) {
  'use strict';

  // ---- GF(256) 有限域 (QR 多项式 0x11D) ----
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (function initGF() {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  function gmul(a, b) {
    return (a && b) ? EXP[LOG[a] + LOG[b]] : 0;
  }

  function rsGenPoly(degree) {
    // 生成 ∏(x + alpha^i)，i=0..degree-1，最低次项在前
    let poly = [1];
    for (let i = 0; i < degree; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j + 1] ^= poly[j];              // ×x
        next[j] ^= gmul(poly[j], EXP[i]);    // ×alpha^i
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecLen) {
    const gen = rsGenPoly(ecLen).reverse(); // 转为最高次(首一)在前，供除法循环使用
    const rem = new Array(ecLen).fill(0);
    for (let k = 0; k < data.length; k++) {
      const factor = data[k] ^ rem[0];
      rem.shift();
      rem.push(0);
      for (let i = 0; i < ecLen; i++) rem[i] ^= gmul(gen[i + 1], factor);
    }
    return rem;
  }

  // ---- 版本 1-6 纠错级别 M 的分块表 [块数, 每块总码字, 每块数据码字] ----
  const EC_BLOCKS = [
    [[1, 26, 16]],
    [[1, 44, 28]],
    [[1, 70, 44]],
    [[2, 50, 32]],
    [[2, 67, 43]],
    [[4, 43, 27]]
  ];

  function pickVersion(byteLen) {
    for (let v = 1; v <= 6; v++) {
      const capacity = EC_BLOCKS[v - 1].reduce((s, b) => s + b[0] * b[2], 0) - 2; // 扣除模式+长度头
      if (byteLen <= capacity) return v;
    }
    throw new Error('内容过长，无法生成二维码 (' + byteLen + ' 字节)');
  }

  // ---- 数据编码 ----
  function buildCodewords(bytes, version) {
    const blocks = EC_BLOCKS[version - 1];
    const dataLen = blocks.reduce((s, b) => s + b[0] * b[2], 0);

    const bits = [];
    function push(val, n) {
      for (let i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1);
    }
    push(0b0100, 4); // byte mode
    push(bytes.length, 8);
    for (const b of bytes) push(b, 8);
    push(0, Math.min(4, dataLen * 8 - bits.length)); // terminator
    while (bits.length % 8 !== 0) bits.push(0);

    const codewords = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      codewords.push(v);
    }
    const pads = [0xEC, 0x11];
    let pi = 0;
    while (codewords.length < dataLen) codewords.push(pads[pi++ % 2]);

    // 分块计算纠错码字并交织
    const dataBlocks = [], ecBlocks = [];
    let off = 0;
    for (const [n, total, dlen] of blocks) {
      for (let b = 0; b < n; b++) {
        const d = codewords.slice(off, off + dlen);
        off += dlen;
        dataBlocks.push(d);
        ecBlocks.push(rsEncode(d, total - dlen));
      }
    }
    const out = [];
    const maxD = Math.max.apply(null, dataBlocks.map(b => b.length));
    const maxE = Math.max.apply(null, ecBlocks.map(b => b.length));
    for (let i = 0; i < maxD; i++) for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
    for (let i = 0; i < maxE; i++) for (const b of ecBlocks) if (i < b.length) out.push(b[i]);
    return out;
  }

  // ---- 掩码函数 ----
  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
  ];

  // ---- 功能图形 + 数据布点 ----
  function buildMatrix(version, codewords, maskId, placementLog) {
    const size = 17 + 4 * version;
    const m = [];
    for (let i = 0; i < size; i++) m.push(new Array(size).fill(null));

    function finder(r0, c0) {
      for (let i = -1; i <= 7; i++) {
        for (let j = -1; j <= 7; j++) {
          const r = r0 + i, c = c0 + j;
          if (r < 0 || c < 0 || r >= size || c >= size) continue;
          const inRing = i >= 0 && i <= 6 && j >= 0 && j <= 6;
          m[r][c] = inRing && (i === 0 || i === 6 || j === 0 || j === 6 || (i >= 2 && i <= 4 && j >= 2 && j <= 4));
        }
      }
    }
    finder(0, 0);
    finder(0, size - 7);
    finder(size - 7, 0);

    for (let i = 8; i < size - 8; i++) {
      m[6][i] = i % 2 === 0;
      m[i][6] = i % 2 === 0;
    }

    // 对齐图形 (v2+: 单个中心对齐)
    const ALIGN = [null, 18, 22, 26, 30, 34];
    if (version >= 2) {
      const p = ALIGN[version - 1];
      for (let i = -2; i <= 2; i++) {
        for (let j = -2; j <= 2; j++) {
          m[p + i][p + j] = Math.max(Math.abs(i), Math.abs(j)) !== 1;
        }
      }
    }

    // 固定暗模块
    m[size - 8][8] = true;

    // 格式信息 (EC=M=00, BCH(15,5), XOR 0x5412) —— 必须在数据布点前预留
    const data5 = maskId & 7;
    let rem = data5;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const fmt = (((data5 << 10) | rem) ^ 0x5412) & 0x7FFF;
    const bit = (i) => ((fmt >>> i) & 1) === 1;

    for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
    m[7][8] = bit(6);
    m[8][8] = bit(7);
    m[8][7] = bit(8);
    for (let i = 9; i < 15; i++) m[8][14 - i] = bit(i);
    for (let i = 0; i < 8; i++) m[8][size - 1 - i] = bit(i);
    for (let i = 8; i < 15; i++) m[size - 15 + i][8] = bit(i);

    const isReserved = (r, c) => m[r][c] !== null;

    // 之字形填入数据 (应用掩码) —— 列对从右向左，含 timing 列 6 的列对整体左移一格
    const maskFn = MASKS[maskId];
    let bitIdx = 0;
    const totalBits = codewords.length * 8;
    let upward = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col = 5; // 跳过 timing 列（改写循环变量，后续列对随之左移）
        for (let i = 0; i < size; i++) {
        const r = upward ? size - 1 - i : i;
        for (let dc = 0; dc < 2; dc++) {
          const cc = col - dc;
          if (isReserved(r, cc)) continue;
          let dark = false;
          if (placementLog) placementLog.push([r, cc, bitIdx]);
          if (bitIdx < totalBits) {
            dark = ((codewords[bitIdx >> 3] >>> (7 - (bitIdx & 7))) & 1) === 1;
            bitIdx++;
          }
          m[r][cc] = dark !== maskFn(r, cc);
        }
      }
      upward = !upward;
    }

    return m;
  }

  // ---- 掩码评估 (N1 连续同色 / N3 类查找图形) ----
  function maskPenalty(m) {
    const size = m.length;
    let penalty = 0;
    for (let r = 0; r < size; r++) {
      let run = 1;
      for (let c = 1; c < size; c++) {
        if (m[r][c] === m[r][c - 1]) { run++; if (run === 5) penalty += 3; else if (run > 5) penalty += 1; }
        else run = 1;
      }
    }
    for (let c = 0; c < size; c++) {
      let run = 1;
      for (let r = 1; r < size; r++) {
        if (m[r][c] === m[r - 1][c]) { run++; if (run === 5) penalty += 3; else if (run > 5) penalty += 1; }
        else run = 1;
      }
    }
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) penalty += 3;
      }
    }
    const pat1 = [true, false, true, true, true, false, true];
    for (let r = 0; r < size; r++) {
      for (let c = 0; c <= size - 7; c++) {
        let okH = true, okV = true;
        for (let k = 0; k < 7; k++) {
          if (m[r][c + k] !== pat1[k]) okH = false;
          if (m[c + k][r] !== pat1[k]) okV = false;
        }
        if (okH) penalty += 40;
        if (okV) penalty += 40;
      }
    }
    return penalty;
  }

  function encode(text) {
    const bytes = [];
    if (typeof TextEncoder !== 'undefined') {
      bytes.push.apply(bytes, new TextEncoder().encode(text));
    } else {
      for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code < 0x80) bytes.push(code);
        else if (code < 0x800) bytes.push(0xC0 | (code >> 6), 0x80 | (code & 63));
        else bytes.push(0xE0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
      }
    }

    const version = pickVersion(bytes.length);
    const codewords = buildCodewords(bytes, version);

    let best = null, bestPenalty = Infinity, bestMask = 0, bestLog = null;
    for (let mask = 0; mask < 8; mask++) {
      const log = [];
      const m = buildMatrix(version, codewords, mask, log);
      const p = maskPenalty(m);
      if (p < bestPenalty) { bestPenalty = p; best = m; bestMask = mask; bestLog = log; }
    }
    return { matrix: best, version, mask: bestMask, size: best.length, placement: bestLog };
  }

  // ---- SVG 输出 (可直接作为 <img src>) ----
  function toSvgDataUrl(text, darkColor) {
    const qr = encode(text);
    const quiet = 4;
    const total = qr.size + quiet * 2;
    let path = '';
    for (let r = 0; r < qr.size; r++) {
      for (let c = 0; c < qr.size; c++) {
        if (qr.matrix[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
      }
    }
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
      `<rect width="${total}" height="${total}" fill="#ffffff"/>` +
      `<path d="${path}" fill="${darkColor || '#000000'}"/>` +
      `</svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  global.LinkeyQR = { encode, toSvgDataUrl, _internals: { rsEncode, rsGenPoly, gmul, EXP, buildCodewords } };
})(typeof window !== 'undefined' ? window : this);
