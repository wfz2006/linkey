// Linkey Admin Dashboard Client Logic (Universal Polyfilled)
if (window.NodeList && !NodeList.prototype.forEach) {
  NodeList.prototype.forEach = Array.prototype.forEach;
}
if (!String.prototype.padStart) {
  String.prototype.padStart = function(targetLength, padString) {
    targetLength = targetLength >> 0;
    padString = String(typeof padString !== 'undefined' ? padString : ' ');
    if (this.length > targetLength) return String(this);
    targetLength = targetLength - this.length;
    while (padString.length < targetLength) { padString += padString; }
    return padString.slice(0, targetLength) + String(this);
  };
}

function forEachElement(selectorOrList, callback) {
  var list = typeof selectorOrList === 'string' ? document.querySelectorAll(selectorOrList) : selectorOrList;
  if (!list) return;
  for (var i = 0; i < list.length; i++) {
    callback(list[i], i);
  }
}

function padZero(n) {
  return n < 10 ? '0' + n : '' + n;
}


var state = {
  token: sessionStorage.getItem('fastqq_admin_token') || null,
  activeTab: 'dashboard',
  statusTimer: null,
  statsTimer: null,
  logsTimer: null,
  migrationStatusTimer: null,
  migrationStatusPending: false,
  migrationStatusPendingEpoch: null,
  migrationStatusEpoch: 0,
  consecutiveLossCount: 0,
  selectedLogFile: null,
  logAutoRefresh: true,
  // Users state
  usersPage: 1,
  usersPageSize: 15,
  usersSearch: '',
  usersStatus: 'all',
  socialUserId: '',
  socialDisplayName: '',
  socialData: null,
  // Messages state
  messagesConvId: '',
  messagesPage: 1,
  messagesPageSize: 20,
  messagesQuery: '',
  messagesType: 'all',
  selectedMessageIds: {},
  attachmentObjectUrls: [],
  // Files state
  filesPage: 1,
  filesPageSize: 24,
  filesCategory: 'all',
  filesSearch: ''
};

// ============================================================================
// 1. API WRAPPER (Universal XMLHttpRequest with Promise)
// ============================================================================

function fetchApi(endpoint, options) {
  options = options || {};
  var headers = options.headers || {};
  headers['Content-Type'] = headers['Content-Type'] || 'application/json';

  if (state.token) {
    headers['Authorization'] = 'Bearer ' + state.token;
  }

  var startMs = Date.now();

  return new Promise(function(resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open(options.method || 'GET', endpoint, true);

    for (var k in headers) {
      if (headers.hasOwnProperty(k)) {
        xhr.setRequestHeader(k, headers[k]);
      }
    }

    xhr.onload = function() {
      var latency = Date.now() - startMs;
      updateLatency(latency);

      if (xhr.status === 401) {
        sessionStorage.removeItem('fastqq_admin_token');
        state.token = null;
        showLoginView();
        var authError = new Error('登录会话已过期，请重新登录');
        authError.status = 401;
        authError.code = 'UNAUTHORIZED';
        return reject(authError);
      }

      var data = {};
      try {
        data = JSON.parse(xhr.responseText || '{}');
      } catch (e) {
        data = { error: xhr.responseText };
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        state.consecutiveLossCount = 0;
        updateDisconnectedBanner(false);
        resolve(data);
      } else {
        var requestError = new Error(data.error || ('请求失败 (' + xhr.status + ')'));
        requestError.status = xhr.status;
        requestError.code = data.code || '';
        reject(requestError);
      }
    };

    xhr.onerror = function() {
      state.consecutiveLossCount++;
      if (state.consecutiveLossCount >= 3) {
        updateDisconnectedBanner(true);
      }
      var networkError = new Error('网络请求失败，请检查服务是否正常启动');
      networkError.status = 0;
      networkError.isNetworkError = true;
      reject(networkError);
    };

    xhr.send(options.body || null);
  });
}

function fetchAdminBlob(fileName, download) {
  var endpoint = '/api/admin/files/content?file=' + encodeURIComponent(fileName);
  if (download) endpoint += '&download=1';

  return new Promise(function(resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', endpoint, true);
    xhr.responseType = 'blob';
    if (state.token) xhr.setRequestHeader('Authorization', 'Bearer ' + state.token);

    xhr.onload = function() {
      if (xhr.status === 401) {
        sessionStorage.removeItem('fastqq_admin_token');
        state.token = null;
        releaseAttachmentObjectUrls();
        showLoginView();
        return reject(new Error('登录会话已过期，请重新登录'));
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        return resolve(xhr.response);
      }
      reject(new Error(xhr.status === 404 ? '附件不存在' : '附件读取失败 (' + xhr.status + ')'));
    };
    xhr.onerror = function() { reject(new Error('附件读取网络请求失败')); };
    xhr.send();
  });
}

function getStoredAttachmentName(content) {
  var value = String(content || '').split('?')[0].replace(/\\/g, '/');
  var name = value.slice(value.lastIndexOf('/') + 1);
  try { return decodeURIComponent(name); } catch (e) { return name; }
}

function rememberAttachmentObjectUrl(blob) {
  var objectUrl = URL.createObjectURL(blob);
  state.attachmentObjectUrls.push(objectUrl);
  return objectUrl;
}

function releaseAttachmentObjectUrls() {
  for (var i = 0; i < state.attachmentObjectUrls.length; i++) {
    URL.revokeObjectURL(state.attachmentObjectUrls[i]);
  }
  state.attachmentObjectUrls = [];
  var lightboxImg = document.getElementById('lightboxImg');
  if (lightboxImg) lightboxImg.src = '';
}

function downloadAdminAttachment(fileName, displayName) {
  fetchAdminBlob(fileName, true).then(function(blob) {
    var objectUrl = URL.createObjectURL(blob);
    var anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = displayName || fileName;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(function() { URL.revokeObjectURL(objectUrl); }, 1000);
  }).catch(function(err) {
    showToast('下载失败: ' + err.message);
  });
}

function hydrateProtectedAttachments(root) {
  if (!root) return;

  forEachElement(root.querySelectorAll('.admin-protected-image'), function(img) {
    var fileName = img.getAttribute('data-admin-file');
    fetchAdminBlob(fileName, false).then(function(blob) {
      var objectUrl = rememberAttachmentObjectUrl(blob);
      img.src = objectUrl;
      img.addEventListener('click', function() { window.__adminLightbox(objectUrl); });
    }).catch(function(err) {
      img.alt = '附件加载失败';
      img.title = err.message;
      img.className += ' attachment-load-failed';
    });
  });

  forEachElement(root.querySelectorAll('.btn-admin-attachment-download'), function(btn) {
    btn.addEventListener('click', function() {
      downloadAdminAttachment(btn.getAttribute('data-admin-file'), btn.getAttribute('data-download-name'));
    });
  });
}

function showToast(msg, duration) {
  duration = duration || 3000;
  var container = document.getElementById('toastContainer');
  if (!container) return;
  var t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(function() { t.remove(); }, duration);
}

function confirmAction(title, message, onConfirm) {
  var modal = document.getElementById('modalConfirm');
  var titleEl = document.getElementById('modalConfirmTitle');
  var msgEl = document.getElementById('modalConfirmMessage');
  var btnOk = document.getElementById('btnModalConfirm');
  var btnCancel = document.getElementById('btnModalCancel');

  titleEl.textContent = title;
  msgEl.textContent = message;
  modal.style.display = 'flex';

  var cleanup = function() {
    modal.style.display = 'none';
    btnOk.onclick = null;
    btnCancel.onclick = null;
  };

  btnCancel.onclick = cleanup;
  btnOk.onclick = function() {
    cleanup();
    onConfirm();
  };
}

function updateDisconnectedBanner(isDisconnected) {
  var b = document.getElementById('bannerDisconnected');
  if (b) b.style.display = isDisconnected ? 'block' : 'none';
}

function updateLatency(ms) {
  var el = document.getElementById('headerLatencyTag');
  if (el) el.textContent = '延迟: ' + ms + 'ms';
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  var k = 1024;
  var sizes = ['B', 'KB', 'MB', 'GB'];
  var i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0) return '0m';
  var d = Math.floor(seconds / 86400);
  var h = Math.floor((seconds % 86400) / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

function formatTimestamp(ts) {
  if (!ts) return '-';
  var d = new Date(ts);
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + padZero(d.getHours()) + ':' + padZero(d.getMinutes()) + ':' + padZero(d.getSeconds());
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ============================================================================
// 2. VIEW SWITCHING & LOGIN
// ============================================================================

function showLoginView(isSetup) {
  document.getElementById('viewLogin').style.display = 'flex';
  document.getElementById('viewMain').style.display = 'none';

  var loginArea = document.getElementById('loginFormArea');
  var setupArea = document.getElementById('setupFormArea');

  if (isSetup) {
    loginArea.style.display = 'none';
    setupArea.style.display = 'block';
  } else {
    loginArea.style.display = 'block';
    setupArea.style.display = 'none';
  }

  stopAllPolling();
}

function showMainView() {
  document.getElementById('viewLogin').style.display = 'none';
  document.getElementById('viewMain').style.display = 'flex';

  startAllPolling();
  refreshAllData();
}

function handleLogin() {
  var pwdInput = document.getElementById('loginPasswordInput');
  var password = pwdInput ? pwdInput.value.trim() : '';
  if (!password) {
    showToast('请输入控制台密码');
    return;
  }

  fetchApi('/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ password: password })
  }).then(function(res) {
    state.token = res.token;
    sessionStorage.setItem('fastqq_admin_token', res.token);
    if (pwdInput) pwdInput.value = '';
    showToast('✅ 登录成功！');
    showMainView();
  }).catch(function(err) {
    if (err.message.indexOf('尚未设置') !== -1 || err.message.indexOf('needsSetup') !== -1) {
      showLoginView(true);
    }
    showToast(err.message);
  });
}

function handleSetupPassword() {
  var pwdInput = document.getElementById('setupPasswordInput');
  var confirmInput = document.getElementById('setupPasswordConfirmInput');

  var pwd = pwdInput ? pwdInput.value.trim() : '';
  var confirm = confirmInput ? confirmInput.value.trim() : '';

  if (!pwd || pwd.length < 4) {
    showToast('密码长度不能少于 4 位');
    return;
  }
  if (pwd !== confirm) {
    showToast('两次输入的新密码不一致');
    return;
  }

  fetchApi('/api/admin/setup-password', {
    method: 'POST',
    body: JSON.stringify({ password: pwd })
  }).then(function(res) {
    state.token = res.token;
    sessionStorage.setItem('fastqq_admin_token', res.token);
    showToast('🎉 管理员密码初始化成功！');
    showMainView();
  }).catch(function(err) {
    showToast('初始化失败: ' + err.message);
  });
}

function handleLogout() {
  releaseAttachmentObjectUrls();
  sessionStorage.removeItem('fastqq_admin_token');
  state.token = null;
  showToast('已安全退出控制台');
  showLoginView();
}

// ============================================================================
// 3. DASHBOARD POLLING & RENDERING
// ============================================================================

function refreshStatus() {
  fetchApi('/api/admin/status').then(function(data) {
    renderStatus(data);
  }).catch(function() {});
}

function renderStatus(data) {
  var app = data.app || {};
  var health = data.health || {};
  var backup = data.backup || {};

  var headerBadge = document.getElementById('headerStatusBadge');
  var headerText = document.getElementById('headerStatusText');
  var badgeAppState = document.getElementById('badgeAppState');

  if (app.state === 'RUNNING') {
    headerBadge.className = 'status-badge running';
    headerText.textContent = '主服务运行中';
    badgeAppState.className = 'badge-tag green';
    badgeAppState.textContent = 'RUNNING';
  } else if (app.state === 'BACKOFF') {
    headerBadge.className = 'status-badge backoff';
    headerText.textContent = '异常自动重启中';
    badgeAppState.className = 'badge-tag yellow';
    badgeAppState.textContent = 'BACKOFF';
  } else {
    headerBadge.className = 'status-badge stopped';
    headerText.textContent = '主服务已停止';
    badgeAppState.className = 'badge-tag red';
    badgeAppState.textContent = app.state || 'STOPPED';
  }

  document.getElementById('valAppUptime').textContent = formatDuration(app.uptime || 0);
  document.getElementById('valAppPid').textContent = app.pid || '-';
  document.getElementById('valRestartCount').textContent = app.consecutiveCrashes || 0;

  var ws = health.ws || {};
  document.getElementById('valWsConnections').textContent = ws.connections || 0;
  document.getElementById('valOnlineUsers').textContent = ws.onlineUsers || 0;

  if (health.memory) {
    document.getElementById('valMemoryRss').textContent = (health.memory.rss / (1024 * 1024)).toFixed(1) + ' MB';
    document.getElementById('valMemoryHeap').textContent = (health.memory.heapUsed / (1024 * 1024)).toFixed(1) + ' MB';
  } else {
    document.getElementById('valMemoryRss').textContent = '-';
    document.getElementById('valMemoryHeap').textContent = '-';
  }

  document.getElementById('valBackupCount').textContent = backup.backupCount || 0;
  document.getElementById('valNextBackupTime').textContent = formatTimestamp(backup.nextBackupAt);
}

function refreshStats() {
  fetchApi('/api/admin/stats').then(function(stats) {
    var todayMsgs = document.getElementById('valTodayMsgs');
    var todayUsers = document.getElementById('valTodayUsers');
    var totalConvs = document.getElementById('valTotalConvs');
    if (todayMsgs) todayMsgs.textContent = stats.messagesToday || 0;
    if (todayUsers) todayUsers.textContent = stats.totalUsersToday || 0;
    if (totalConvs) totalConvs.textContent = stats.conversations || 0;

    var topContainer = document.getElementById('topConvsContainer');
    if (!topContainer) return;
    var topList = stats.topConversations || [];
    if (topList.length === 0) {
      topContainer.innerHTML = '<div style="color: var(--text-muted); font-size: 13px; text-align: center; padding: 20px;">今日暂无消息产生</div>';
    } else {
      topContainer.innerHTML = '<table class="data-table"><thead><tr><th>会话 ID</th><th>会话名称</th><th>类型</th><th>今日消息条数</th></tr></thead><tbody>' +
        topList.map(function(c) {
          return '<tr><td><code style="color: #00F2FE;">' + escapeHtml(c.id) + '</code></td><td><strong>' + escapeHtml(c.name || '私聊会话') + '</strong></td><td><span class="badge-tag ' + (c.type === 'group' ? 'blue' : 'green') + '">' + (c.type === 'group' ? '群聊' : '私聊') + '</span></td><td><strong style="color: #FFB703;">' + c.msgCount + '</strong> 条</td></tr>';
        }).join('') + '</tbody></table>';
    }
  }).catch(function() {});
}

function refreshTunnelStatus() {
  fetchApi('/api/admin/tunnel/status').then(function(res) {
    var t = res.tunnel || {};
    var badge = document.getElementById('badgeTunnelStatus');
    var box = document.getElementById('tunnelUrlBox');
    var link = document.getElementById('linkTunnelPublicUrl');
    var btnStart = document.getElementById('btnStartTunnel');
    var btnStop = document.getElementById('btnStopTunnel');

    if (t.status === 'online' && t.publicUrl) {
      if (badge) {
        badge.className = 'badge-tag green';
        badge.textContent = 'ONLINE · 已连接';
      }
      if (box) box.style.display = 'flex';
      if (link) {
        link.href = t.publicUrl;
        link.textContent = t.publicUrl;
      }
      if (btnStart) btnStart.style.display = 'none';
      if (btnStop) btnStop.style.display = 'inline-block';
    } else if (t.status === 'starting') {
      if (badge) {
        badge.className = 'badge-tag orange';
        badge.textContent = 'STARTING · 正在穿透...';
      }
      if (box) box.style.display = 'none';
      if (btnStart) {
        btnStart.style.display = 'inline-block';
        btnStart.disabled = true;
        btnStart.textContent = '⏳ 正在连接全球网络...';
      }
      if (btnStop) btnStop.style.display = 'none';
    } else {
      if (badge) {
        badge.className = 'badge-tag red';
        badge.textContent = 'OFFLINE · 离线';
      }
      if (box) box.style.display = 'none';
      if (btnStart) {
        btnStart.style.display = 'inline-block';
        btnStart.disabled = false;
        btnStart.textContent = '🚀 开启外网联机';
      }
      if (btnStop) btnStop.style.display = 'none';
    }
  }).catch(function() {});
}

function handleStartTunnel() {
  var btnStart = document.getElementById('btnStartTunnel');
  if (btnStart) {
    btnStart.disabled = true;
    btnStart.textContent = '⏳ 正在连接全球网络...';
  }
  fetchApi('/api/admin/tunnel/start', { method: 'POST' }).then(function() {
    showToast('🚀 外网穿透请求已发送！');
    setTimeout(refreshTunnelStatus, 1500);
    setTimeout(refreshTunnelStatus, 3500);
    setTimeout(refreshTunnelStatus, 6000);
  }).catch(function(err) {
    showToast('启动外网穿透失败: ' + err.message);
    refreshTunnelStatus();
  });
}

function handleStopTunnel() {
  fetchApi('/api/admin/tunnel/stop', { method: 'POST' }).then(function() {
    showToast('外网联机已关闭');
    refreshTunnelStatus();
  }).catch(function(err) {
    showToast('关闭失败: ' + err.message);
  });
}

// ============================================================================
// 4. 👥 USER MANAGEMENT
// ============================================================================

function loadUsers() {
  var tbody = document.getElementById('usersTbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 30px;">正在加载用户列表...</td></tr>';

  var params = '?page=' + state.usersPage + '&pageSize=' + state.usersPageSize + '&search=' + encodeURIComponent(state.usersSearch) + '&status=' + encodeURIComponent(state.usersStatus);

  fetchApi('/api/admin/users' + params).then(function(data) {
    var countTag = document.getElementById('usersCountTag');
    if (countTag) countTag.textContent = '共 ' + data.total + ' 位用户';

    if (!data.users || data.users.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 30px;">未查询到匹配的用户</td></tr>';
      updateUsersPagination(1, 1);
      return;
    }

    tbody.innerHTML = data.users.map(function(u) {
      var isBanned = u.status === 'banned';
      var isOnline = u.status === 'online';
      var statusBadge = isBanned
        ? '<span class="badge-tag red">🚫 已封禁</span>'
        : isOnline
          ? '<span class="badge-tag green">🟢 在线</span>'
          : '<span class="badge-tag gray">⚪ 离线</span>';

      var avatarSrc = u.avatar || ('https://api.dicebear.com/7.x/bottts/svg?seed=' + encodeURIComponent(u.username));

      return '<tr>' +
        '<td><div class="user-cell"><img src="' + escapeHtml(avatarSrc) + '" class="user-cell-avatar" alt="avatar" onerror="this.src=\'https://api.dicebear.com/7.x/bottts/svg?seed=fallback\'"><div class="user-cell-info"><span class="user-nickname">' + escapeHtml(u.nickname || u.username) + '</span><span class="user-username">@' + escapeHtml(u.username) + '</span></div></div></td>' +
        '<td><div style="font-size: 12.5px; color: var(--text-secondary); max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">' + escapeHtml(u.bio || '暂无个性签名') + '</div></td>' +
        '<td><strong style="color: #00F2FE; font-family: monospace;">' + escapeHtml(u.qq_number || '-') + '</strong></td>' +
        '<td><span class="badge-tag yellow">Lv.' + (u.qq_level || 1) + '</span></td>' +
        '<td>' + statusBadge + '</td>' +
        '<td><span style="font-size: 12px; color: var(--text-secondary);">💬 <strong>' + (u.messageCount || 0) + '</strong> 条 · 👥 <strong>' + (u.friendCount || 0) + '</strong> 好友</span></td>' +
        '<td style="font-size: 12px; color: var(--text-muted);">' + formatTimestamp(u.created_at) + '</td>' +
        '<td style="text-align: right;"><div style="display: inline-flex; gap: 6px;">' +
        '<button class="btn-secondary btn-xs btn-user-social" data-id="' + escapeHtml(u.id) + '" data-name="' + escapeHtml(u.nickname || u.username) + '">👥 关系</button>' +
        '<button class="btn-secondary btn-xs btn-user-edit" data-id="' + escapeHtml(u.id) + '" data-name="' + escapeHtml(u.nickname || u.username) + '" data-qq="' + escapeHtml(u.qq_number || '') + '" data-level="' + (u.qq_level || 1) + '" data-bio="' + escapeHtml(u.bio || '') + '">✏️ 编辑</button>' +
        '<button class="btn-secondary btn-xs btn-user-pwd" data-id="' + escapeHtml(u.id) + '" data-name="' + escapeHtml(u.nickname || u.username) + '">🔑 改密</button>' +
        '<button class="btn-' + (isBanned ? 'success' : 'warning') + ' btn-xs btn-user-ban" data-id="' + escapeHtml(u.id) + '" data-banned="' + (isBanned ? '1' : '0') + '" data-name="' + escapeHtml(u.nickname || u.username) + '">' + (isBanned ? '✅ 解封' : '🚫 封禁') + '</button>' +
        '<button class="btn-danger btn-xs btn-user-del" data-id="' + escapeHtml(u.id) + '" data-name="' + escapeHtml(u.nickname || u.username) + '">🗑️</button>' +
        '</div></td>' +
        '</tr>';
    }).join('');

    bindUserRowEvents();
    updateUsersPagination(data.page, data.totalPages);
  }).catch(function(err) {
    tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; color: #EF4444; padding: 20px;">加载用户失败: ' + escapeHtml(err.message) + '</td></tr>';
  });
}

function bindUserRowEvents() {
  forEachElement('.btn-user-social', function(btn) {
    btn.addEventListener('click', function() {
      openUserSocialModal(btn.getAttribute('data-id'), btn.getAttribute('data-name'));
    });
  });

  forEachElement('.btn-user-edit', function(btn) {
    btn.addEventListener('click', function() {
      var id = btn.getAttribute('data-id');
      var name = btn.getAttribute('data-name');
      var qq = btn.getAttribute('data-qq');
      var level = btn.getAttribute('data-level');
      var bio = btn.getAttribute('data-bio');
      openEditUserModal({ id: id, nickname: name, qq_number: qq, qq_level: level, bio: bio });
    });
  });

  forEachElement('.btn-user-pwd', function(btn) {
    btn.addEventListener('click', function() {
      var id = btn.getAttribute('data-id');
      var name = btn.getAttribute('data-name');
      openResetUserPwdModal(id, name);
    });
  });

  forEachElement('.btn-user-ban', function(btn) {
    btn.addEventListener('click', function() {
      var id = btn.getAttribute('data-id');
      var isBanned = btn.getAttribute('data-banned') === '1';
      var name = btn.getAttribute('data-name');
      var actionText = isBanned ? '解封' : '封禁';

      confirmAction(actionText + '用户账号', '确定要' + actionText + '用户 [' + name + '] 吗？' + (!isBanned ? '封禁后该用户将无法登录通讯系统。' : '解封后恢复正常登录。'), function() {
        fetchApi('/api/admin/users/' + id + '/toggle-ban', {
          method: 'POST',
          body: JSON.stringify({ isBanned: !isBanned })
        }).then(function() {
          showToast('已' + actionText + '用户 [' + name + ']');
          loadUsers();
        }).catch(function(err) {
          showToast(actionText + '失败: ' + err.message);
        });
      });
    });
  });

  forEachElement('.btn-user-del', function(btn) {
    btn.addEventListener('click', function() {
      var id = btn.getAttribute('data-id');
      var name = btn.getAttribute('data-name');

      confirmAction('注销并删除用户', '⚠️ 警告：确定要彻底注销用户 [' + name + '] 吗？该操作将物理级级联删除该用户的全部聊天记录、好友关系和群聊身份，不可恢复！', function() {
        fetchApi('/api/admin/users/' + id, { method: 'DELETE' }).then(function() {
          showToast('已删除用户 [' + name + ']');
          loadUsers();
        }).catch(function(err) {
          showToast('删除失败: ' + err.message);
        });
      });
    });
  });
}

function updateUsersPagination(page, totalPages) {
  state.usersPage = page;
  document.getElementById('usersPageInfo').textContent = '第 ' + page + ' / ' + totalPages + ' 页';
  document.getElementById('btnUsersPrevPage').disabled = page <= 1;
  document.getElementById('btnUsersNextPage').disabled = page >= totalPages;
}

function openEditUserModal(user) {
  document.getElementById('editUserId').value = user.id;
  document.getElementById('editUserNickname').value = user.nickname || '';
  document.getElementById('editUserQQNumber').value = user.qq_number || '';
  document.getElementById('editUserQQLevel').value = user.qq_level || 1;
  document.getElementById('editUserBio').value = user.bio || '';
  document.getElementById('modalEditUser').style.display = 'flex';
}

function handleSaveEditUser() {
  var id = document.getElementById('editUserId').value;
  var nickname = document.getElementById('editUserNickname').value.trim();
  var qq_number = document.getElementById('editUserQQNumber').value.trim();
  var qq_level = parseInt(document.getElementById('editUserQQLevel').value, 10) || 1;
  var bio = document.getElementById('editUserBio').value.trim();

  if (!nickname) {
    showToast('用户昵称不能为空');
    return;
  }

  fetchApi('/api/admin/users/' + id, {
    method: 'PUT',
    body: JSON.stringify({ nickname: nickname, qq_number: qq_number, qq_level: qq_level, bio: bio })
  }).then(function() {
    document.getElementById('modalEditUser').style.display = 'none';
    showToast('✅ 用户资料修改成功');
    loadUsers();
  }).catch(function(err) {
    showToast('修改失败: ' + err.message);
  });
}

function openResetUserPwdModal(id, name) {
  document.getElementById('resetPwdUserId').value = id;
  document.getElementById('resetPwdUserLabel').textContent = '正在为用户 [' + name + '] 重置登录密码：';
  document.getElementById('resetPwdNewInput').value = '';
  document.getElementById('modalResetUserPwd').style.display = 'flex';
}

function handleConfirmResetUserPwd() {
  var id = document.getElementById('resetPwdUserId').value;
  var newPassword = document.getElementById('resetPwdNewInput').value.trim();

  if (!newPassword || newPassword.length < 4) {
    showToast('新密码长度不能少于 4 位');
    return;
  }

  fetchApi('/api/admin/users/' + id + '/reset-password', {
    method: 'POST',
    body: JSON.stringify({ newPassword: newPassword })
  }).then(function() {
    document.getElementById('modalResetUserPwd').style.display = 'none';
    showToast('✅ 强制重置密码成功');
  }).catch(function(err) {
    showToast('重置密码失败: ' + err.message);
  });
}

// ============================================================================
// 4.5 👥 USER SOCIAL RELATIONS (好友关系管理 / 申请记录 / 会话跳转)
// ============================================================================

function openUserSocialModal(userId, displayName) {
  state.socialUserId = userId;
  state.socialDisplayName = displayName;
  document.getElementById('modalUserSocial').style.display = 'flex';
  document.getElementById('socialUserLabel').textContent = '正在查看用户 [' + displayName + '] 的社交关系：';
  document.getElementById('socialFriendsList').innerHTML = '<span style="font-size: 12px; color: var(--text-muted);">加载中...</span>';
  document.getElementById('socialRequestsList').innerHTML = '';
  document.getElementById('socialConvsList').innerHTML = '';

  fetchApi('/api/admin/users/' + userId).then(function(data) {
    state.socialData = data;

    // ---- 好友列表 ----
    var friends = data.friends || [];
    var friendsBox = document.getElementById('socialFriendsList');
    if (friends.length === 0) {
      friendsBox.innerHTML = '<span style="font-size: 12px; color: var(--text-muted);">该用户暂无好友</span>';
    } else {
      friendsBox.innerHTML = friends.map(function(f) {
        return '<div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; background: rgba(255,255,255,0.04); border-radius: 8px;">' +
          '<div style="display: flex; align-items: center; gap: 10px; min-width: 0;">' +
            '<img src="' + escapeHtml(f.avatar || '') + '" style="width: 30px; height: 30px; border-radius: 50%;" alt="av" onerror="this.style.display=\'none\'">' +
            '<div style="min-width: 0;">' +
              '<div style="font-size: 12.5px; font-weight: 600;">' + escapeHtml(f.remark ? f.remark + ' (' + f.nickname + ')' : f.nickname) + ' <span style="color: var(--text-muted); font-weight: 400;">@' + escapeHtml(f.username) + '</span></div>' +
              '<div style="font-size: 11px; color: var(--text-muted);">' + escapeHtml(f.group_name || '我的好友') + ' · ' + (f.status === 'online' ? '🟢 在线' : '⚪ 离线') + '</div>' +
            '</div>' +
          '</div>' +
          '<div style="display: inline-flex; gap: 6px; flex-shrink: 0;">' +
            '<button class="btn-secondary btn-xs btn-social-chat" data-friend-id="' + escapeHtml(f.friend_id) + '">💬 聊天记录</button>' +
            '<button class="btn-danger btn-xs btn-social-unfriend" data-friend-id="' + escapeHtml(f.friend_id) + '" data-friend-name="' + escapeHtml(f.nickname || f.username) + '">❌ 解除</button>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    // ---- 好友申请记录 ----
    var reqBox = document.getElementById('socialRequestsList');
    var incoming = data.incomingRequests || [];
    var outgoing = data.outgoingRequests || [];
    var reqHtml = '';
    var requestActions = [
      { action: 'accept', label: '✅ 同意', className: 'btn-success' },
      { action: 'reject', label: '❌ 拒绝', className: 'btn-danger' }
    ];
    function renderRequestActions(request) {
      if (request.status !== 'pending') return '';
      return '<span style="display: inline-flex; gap: 5px; margin-left: 8px;">' + requestActions.map(function(item) {
        return '<button class="' + item.className + ' btn-xs btn-social-request-action" data-request-id="' + escapeHtml(request.id) + '" data-action="' + item.action + '">' + item.label + '</button>';
      }).join('') + '</span>';
    }
    incoming.forEach(function(r) {
      var st = r.status === 'pending' ? '<span class="badge-tag yellow">待处理</span>' : (r.status === 'accepted' ? '<span class="badge-tag green">已同意</span>' : '<span class="badge-tag red">已拒绝</span>');
      reqHtml += '<div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 10px; background: rgba(255,255,255,0.04); border-radius: 8px; font-size: 12px;"><span>📩 收到来自 <strong>' + escapeHtml(r.from_nickname || r.from_username) + '</strong> 的申请 ' + st + ' <span style="color: var(--text-muted);">' + escapeHtml(r.message || '') + '</span> <span style="color: var(--text-muted); font-size: 11px;">' + formatTimestamp(r.created_at) + '</span></span>' + renderRequestActions(r) + '</div>';
    });
    outgoing.forEach(function(r) {
      var st = r.status === 'pending' ? '<span class="badge-tag yellow">待处理</span>' : (r.status === 'accepted' ? '<span class="badge-tag green">已同意</span>' : '<span class="badge-tag red">已拒绝</span>');
      reqHtml += '<div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 7px 10px; background: rgba(255,255,255,0.03); border-radius: 8px; font-size: 12px;"><span>📤 发送给 <strong>' + escapeHtml(r.to_nickname || r.to_username) + '</strong> 的申请 ' + st + ' <span style="color: var(--text-muted); font-size: 11px;">' + formatTimestamp(r.created_at) + '</span></span>' + renderRequestActions(r) + '</div>';
    });
    reqBox.innerHTML = reqHtml || '<span style="font-size: 12px; color: var(--text-muted);">无好友申请记录</span>';

    // ---- 会话列表 ----
    var convs = data.groups || [];
    var convBox = document.getElementById('socialConvsList');
    if (convs.length === 0) {
      convBox.innerHTML = '<span style="font-size: 12px; color: var(--text-muted);">该用户未参与任何会话</span>';
    } else {
      convBox.innerHTML = convs.map(function(c) {
        var label = c.type === 'group'
          ? '👑 ' + escapeHtml(c.name || '群聊') + (c.role === 'owner' ? ' <span class="badge-tag yellow">群主</span>' : '')
          : '💬 与 [' + escapeHtml(c.peerName || '未知') + '] 的私聊';
        return '<div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; background: rgba(255,255,255,0.04); border-radius: 8px;">' +
          '<div style="font-size: 12.5px;">' + label + ' <span style="color: var(--text-muted); font-size: 11px;">(' + (c.messageCount || 0) + ' 条消息)</span></div>' +
          '<button class="btn-secondary btn-xs btn-social-viewconv" data-conv-id="' + escapeHtml(c.id) + '">📖 查看聊天记录</button>' +
        '</div>';
      }).join('');
    }

    bindSocialModalEvents();
  }).catch(function(err) {
    showToast('加载社交关系失败: ' + err.message);
  });
}

function bindSocialModalEvents() {
  var modal = document.getElementById('modalUserSocial');

  forEachElement('.btn-social-request-action', function(btn) {
    btn.addEventListener('click', function() {
      var requestId = btn.getAttribute('data-request-id');
      var action = btn.getAttribute('data-action');
      var actionLabel = action === 'accept' ? '同意' : '拒绝';
      fetchApi('/api/admin/friend-requests/' + requestId + '/respond', {
        method: 'POST',
        body: JSON.stringify({ action: action })
      }).then(function() {
        showToast('已' + actionLabel + '该好友申请');
        openUserSocialModal(state.socialUserId, state.socialDisplayName);
      }).catch(function(err) {
        showToast(actionLabel + '申请失败: ' + err.message);
      });
    });
  });

  forEachElement('.btn-social-unfriend', function(btn) {
    btn.addEventListener('click', function() {
      var friendId = btn.getAttribute('data-friend-id');
      var friendName = btn.getAttribute('data-friend-name');
      confirmAction('解除好友关系', '确定要解除该用户与 [' + friendName + '] 的好友关系吗？（双向移除，双方好友列表都会更新）', function() {
        fetchApi('/api/admin/users/' + state.socialUserId + '/friends/' + friendId, { method: 'DELETE' }).then(function() {
          showToast('已解除与 [' + friendName + '] 的好友关系');
          openUserSocialModal(state.socialUserId, state.socialDisplayName);
        }).catch(function(err) {
          showToast('解除失败: ' + err.message);
        });
      });
    });
  });

  forEachElement('.btn-social-chat', function(btn) {
    btn.addEventListener('click', function() {
      var friendId = btn.getAttribute('data-friend-id');
      var convs = (state.socialData && state.socialData.groups) || [];
      var conv = null;
      for (var i = 0; i < convs.length; i++) {
        if (convs[i].type === 'direct' && convs[i].peerId === friendId) { conv = convs[i]; break; }
      }
      if (!conv) {
        showToast('两人之间暂无私聊会话');
        return;
      }
      jumpToConversation(conv.id);
    });
  });

  forEachElement('.btn-social-viewconv', function(btn) {
    btn.addEventListener('click', function() {
      jumpToConversation(btn.getAttribute('data-conv-id'));
    });
  });

  var btnClose = document.getElementById('btnCloseSocialModal');
  if (btnClose) {
    btnClose.onclick = function() { modal.style.display = 'none'; };
  }
}

// 跳转到 聊天记录 页签并定位到指定会话
function jumpToConversation(convId) {
  document.getElementById('modalUserSocial').style.display = 'none';
  switchTab('messages');
  setTimeout(function() {
    var select = document.getElementById('msgConvSelect');
    if (select) {
      select.value = convId;
      if (select.value !== convId) {
        loadConversationsList();
        setTimeout(function() { select.value = convId; loadMessages(); }, 400);
        return;
      }
    }
    state.messagesPage = 1;
    loadMessages();
  }, 150);
}

// ============================================================================
// 5. 💬 CHAT RECORDS AUDIT & CONVERSATIONS MANAGEMENT
// ============================================================================

function loadConversationsList() {
  var select = document.getElementById('msgConvSelect');
  if (!select) return;
  fetchApi('/api/admin/conversations').then(function(data) {
    var convs = data.conversations || [];
    var currentVal = select.value;
    select.innerHTML = '<option value="">-- 选择要查看的会话/群聊 --</option>' +
      convs.map(function(c) {
        return '<option value="' + escapeHtml(c.id) + '">[' + (c.type === 'group' ? '群聊' : '私聊') + '] ' + escapeHtml(c.name || '私聊会话') + ' (' + c.messageCount + ' 条消息)</option>';
      }).join('');

    if (currentVal) select.value = currentVal;
  }).catch(function() {});
}

function loadMessages() {
  releaseAttachmentObjectUrls();
  var convId = document.getElementById('msgConvSelect').value;
  var tbody = document.getElementById('messagesTbody');
  var btnClear = document.getElementById('btnClearCurrentConv');
  var btnDelConv = document.getElementById('btnDeleteCurrentConv');
  var pag = document.getElementById('messagesPagination');

  state.selectedMessageIds = {};
  updateBatchBar();

  if (!convId) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 30px;">请先从上方选择一个会话以查看聊天记录</td></tr>';
    btnClear.disabled = true;
    btnDelConv.disabled = true;
    pag.style.display = 'none';
    return;
  }

  btnClear.disabled = false;
  btnDelConv.disabled = false;
  pag.style.display = 'flex';
  tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 30px;">正在检索聊天记录...</td></tr>';

  var params = '?page=' + state.messagesPage + '&pageSize=' + state.messagesPageSize + '&query=' + encodeURIComponent(state.messagesQuery) + '&type=' + encodeURIComponent(state.messagesType);

  fetchApi('/api/admin/conversations/' + convId + '/messages' + params).then(function(data) {
    var msgs = data.messages || [];

    if (msgs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 30px;">该会话暂无聊天消息或无匹配检索结果</td></tr>';
      updateMessagesPagination(1, 1);
      return;
    }

    tbody.innerHTML = msgs.map(function(m) {
      var contentPreview = escapeHtml(m.content);
      var typeBadge = '<span class="badge-tag gray">文本</span>';

      if (m.type === 'image') {
        typeBadge = '<span class="badge-tag blue">🖼️ 图片</span>';
        var imageStorageName = getStoredAttachmentName(m.content);
        contentPreview = '<div style="display: flex; align-items: center; gap: 8px;"><img class="admin-protected-image" data-admin-file="' + escapeHtml(imageStorageName) + '" style="width: 44px; height: 44px; border-radius: 6px; object-fit: cover; cursor: pointer;" alt="正在加载图片"><span style="font-size: 11.5px; color: var(--text-muted);">' + escapeHtml(m.file_name || '图片') + '</span></div>';
      } else if (m.type === 'file') {
        typeBadge = '<span class="badge-tag yellow">📁 文件</span>';
        var fileStorageName = getStoredAttachmentName(m.content);
        contentPreview = '<div style="font-size: 12.5px;">📄 <button class="btn-secondary btn-xs btn-admin-attachment-download" data-admin-file="' + escapeHtml(fileStorageName) + '" data-download-name="' + escapeHtml(m.file_name || fileStorageName) + '">📥 ' + escapeHtml(m.file_name || '下载附件') + '</button> <span style="font-size: 11px; color: var(--text-muted);">(' + formatBytes(m.file_size) + ')</span></div>';
      } else if (m.type === 'poke') {
        typeBadge = '<span class="badge-tag purple">👉 戳一戳</span>';
        contentPreview = '<span style="color: #FFB703;">' + escapeHtml(m.content) + '</span>';
      }

      return '<tr>' +
        '<td><input type="checkbox" class="chk-msg-item" data-id="' + m.id + '"></td>' +
        '<td><code style="color: var(--text-muted); font-size: 11px;">#' + m.id + '</code></td>' +
        '<td><div style="display: flex; align-items: center; gap: 6px;"><span style="font-weight: 600; font-size: 12.5px;">' + escapeHtml(m.nickname || m.username || '系统') + '</span><span style="font-size: 11px; color: var(--text-muted);">(@' + escapeHtml(m.username || '-') + ')</span></div></td>' +
        '<td>' + typeBadge + '</td>' +
        '<td><div style="max-width: 320px; word-break: break-word; line-height: 1.4;">' + contentPreview + '</div></td>' +
        '<td style="font-size: 11.5px; color: var(--text-muted);">' + formatTimestamp(m.created_at) + '</td>' +
        '<td style="text-align: right;"><button class="btn-danger btn-xs btn-msg-del" data-id="' + m.id + '">🗑️ 删除</button></td>' +
        '</tr>';
    }).join('');

    bindMessageRowEvents();
    hydrateProtectedAttachments(tbody);
    updateMessagesPagination(data.page, data.totalPages);
  }).catch(function(err) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #EF4444; padding: 20px;">检索失败: ' + escapeHtml(err.message) + '</td></tr>';
  });
}

function bindMessageRowEvents() {
  forEachElement('.chk-msg-item', function(chk) {
    chk.addEventListener('change', function(e) {
      var id = chk.getAttribute('data-id');
      if (e.target.checked) state.selectedMessageIds[id] = true;
      else delete state.selectedMessageIds[id];
      updateBatchBar();
    });
  });

  forEachElement('.btn-msg-del', function(btn) {
    btn.addEventListener('click', function() {
      var id = btn.getAttribute('data-id');
      confirmAction('删除消息记录', '确定要彻底删除消息 #' + id + ' 吗？', function() {
        fetchApi('/api/admin/messages/' + id, { method: 'DELETE' }).then(function() {
          showToast('已删除消息 #' + id);
          loadMessages();
        }).catch(function(err) {
          showToast('删除失败: ' + err.message);
        });
      });
    });
  });
}

function updateBatchBar() {
  var bar = document.getElementById('msgBatchActionBar');
  var countEl = document.getElementById('msgSelectedCount');
  var count = Object.keys(state.selectedMessageIds).length;

  if (count > 0) {
    bar.style.display = 'flex';
    countEl.textContent = count;
  } else {
    bar.style.display = 'none';
  }
}

function updateMessagesPagination(page, totalPages) {
  state.messagesPage = page;
  document.getElementById('msgsPageInfo').textContent = '第 ' + page + ' / ' + totalPages + ' 页';
  document.getElementById('btnMsgsPrevPage').disabled = page <= 1;
  document.getElementById('btnMsgsNextPage').disabled = page >= totalPages;
}

// ============================================================================
// 6. 📁 FILE & ASSET MANAGEMENT
// ============================================================================

function loadFilesStats() {
  fetchApi('/api/admin/files/stats').then(function(stats) {
    document.getElementById('valFilesTotalSize').textContent = formatBytes(stats.totalBytes);
    document.getElementById('valFilesTotalCount').textContent = stats.totalFiles;
    document.getElementById('valFilesImageCount').textContent = stats.images.count;
    document.getElementById('valFilesImageSize').textContent = formatBytes(stats.images.bytes);
    document.getElementById('valFilesDocCount').textContent = stats.docs.count;
    document.getElementById('valFilesDocSize').textContent = formatBytes(stats.docs.bytes);
  }).catch(function() {});
}

function loadFilesList() {
  releaseAttachmentObjectUrls();
  var container = document.getElementById('filesContainer');
  if (!container) return;
  container.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 40px; grid-column: 1 / -1;">正在扫描文件列表...</div>';

  var params = '?page=' + state.filesPage + '&pageSize=' + state.filesPageSize + '&category=' + encodeURIComponent(state.filesCategory) + '&search=' + encodeURIComponent(state.filesSearch);

  fetchApi('/api/admin/files' + params).then(function(data) {
    var files = data.files || [];

    if (files.length === 0) {
      container.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 40px; grid-column: 1 / -1;">未扫描到匹配的上传文件</div>';
      updateFilesPagination(1, 1);
      return;
    }

    container.innerHTML = files.map(function(f) {
      var isImg = f.type === 'image';
      var thumbContent = isImg
        ? '<img class="admin-protected-image" data-admin-file="' + escapeHtml(f.name) + '" alt="正在加载 ' + escapeHtml(f.name) + '">'
        : '<span style="font-size: 38px;">' + (f.type === 'doc' ? '📄' : '📦') + '</span>';

      return '<div class="file-card">' +
        '<div class="file-thumb-box" title="点击预览">' + thumbContent + '</div>' +
        '<span class="file-card-name" title="' + escapeHtml(f.name) + '">' + escapeHtml(f.name) + '</span>' +
        '<div class="file-card-meta"><span>' + formatBytes(f.size) + '</span> · <span>' + formatTimestamp(f.mtime) + '</span></div>' +
        '<div class="file-card-actions">' +
        '<button class="btn-primary btn-xs btn-admin-attachment-download" data-admin-file="' + escapeHtml(f.name) + '" data-download-name="' + escapeHtml(f.name) + '">📥 下载</button>' +
        '<button class="btn-danger btn-xs btn-file-del" data-name="' + escapeHtml(f.name) + '">🗑️</button>' +
        '</div></div>';
    }).join('');

    bindFileEvents();
    hydrateProtectedAttachments(container);
    updateFilesPagination(data.page, data.totalPages);
  }).catch(function(err) {
    container.innerHTML = '<div style="text-align: center; color: #EF4444; padding: 30px; grid-column: 1 / -1;">加载文件失败: ' + escapeHtml(err.message) + '</div>';
  });
}

function bindFileEvents() {
  forEachElement('.btn-file-del', function(btn) {
    btn.addEventListener('click', function() {
      var name = btn.getAttribute('data-name');
      confirmAction('永久删除文件', '确定要从服务器磁盘物理删除文件 [' + name + '] 吗？', function() {
        fetchApi('/api/admin/files?file=' + encodeURIComponent(name), { method: 'DELETE' }).then(function() {
          showToast('已删除文件 ' + name);
          loadFilesStats();
          loadFilesList();
        }).catch(function(err) {
          showToast('删除失败: ' + err.message);
        });
      });
    });
  });
}

function updateFilesPagination(page, totalPages) {
  state.filesPage = page;
  document.getElementById('filesPageInfo').textContent = '第 ' + page + ' / ' + totalPages + ' 页';
  document.getElementById('btnFilesPrevPage').disabled = page <= 1;
  document.getElementById('btnFilesNextPage').disabled = page >= totalPages;
}

window.__adminLightbox = function(url) {
  var modal = document.getElementById('modalFileLightbox');
  var img = document.getElementById('lightboxImg');
  if (img) img.src = url;
  if (modal) modal.style.display = 'flex';
};

// ============================================================================
// 7. 📜 LOGS & 💾 BACKUPS & ⚙️ SETTINGS
// ============================================================================

function refreshLogsList() {
  var select = document.getElementById('logFileSelect');
  if (!select) return;
  fetchApi('/api/admin/logs/list').then(function(data) {
    var files = data.files || [];

    if (files.length === 0) {
      select.innerHTML = '<option value="">暂无日志文件</option>';
      document.getElementById('logConsole').textContent = '未找到任何日志文件';
      return;
    }

    select.innerHTML = files.map(function(f) {
      return '<option value="' + escapeHtml(f.name) + '">' + escapeHtml(f.name) + ' (' + formatBytes(f.size) + ')</option>';
    }).join('');

    if (!state.selectedLogFile || !files.some(function(f) { return f.name === state.selectedLogFile; })) {
      state.selectedLogFile = files[0].name;
    }
    select.value = state.selectedLogFile;
    loadActiveLogContent();
  }).catch(function() {});
}

function loadActiveLogContent() {
  var select = document.getElementById('logFileSelect');
  var tailSelect = document.getElementById('logTailSelect');
  var consoleEl = document.getElementById('logConsole');
  if (!select || !consoleEl) return;
  var file = select.value;
  var tail = tailSelect ? tailSelect.value : '200';

  if (!file) return;

  fetchApi('/api/admin/logs/read?file=' + encodeURIComponent(file) + '&tail=' + tail).then(function(data) {
    var lines = data.lines || [];

    if (lines.length === 0) {
      consoleEl.textContent = '【日志文件为空】';
      return;
    }

    consoleEl.innerHTML = lines.map(function(line) {
      var isErr = line.indexOf('ERR') !== -1 || line.indexOf('Error') !== -1 || line.indexOf('异常') !== -1 || line.indexOf('Fail') !== -1;
      return '<div class="' + (isErr ? 'log-line-err' : '') + '">' + escapeHtml(line) + '</div>';
    }).join('');

    consoleEl.scrollTop = consoleEl.scrollHeight;
  }).catch(function(err) {
    consoleEl.textContent = '读取日志失败: ' + err.message;
  });
}

function downloadLogFile(file) {
  var url = '/api/admin/logs/download?file=' + encodeURIComponent(file);
  window.open(url, '_blank');
}

function refreshBackupsList() {
  var tbody = document.getElementById('backupsTbody');
  if (!tbody) return;
  fetchApi('/api/admin/backups/list').then(function(data) {
    var files = data.files || [];

    if (files.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 30px;">暂无备份文件，点击上方按钮立即创建备份</td></tr>';
      return;
    }

    tbody.innerHTML = files.map(function(b) {
      return '<tr>' +
        '<td><strong style="color: #00F2FE;">' + escapeHtml(b.name) + '</strong></td>' +
        '<td>' + formatBytes(b.size) + '</td>' +
        '<td>' + formatTimestamp(b.createdAt) + '</td>' +
        '<td><span class="badge-tag green">✅ 校验通过 (OK)</span></td>' +
        '<td style="text-align: right;">' +
        '<a href="/api/admin/backups/download?file=' + encodeURIComponent(b.name) + '" class="btn-secondary btn-xs" style="text-decoration: none; display: inline-flex; align-items: center; gap: 4px;">📥 下载</a>' +
        '<button class="btn-danger btn-xs btn-backup-del" data-file="' + escapeHtml(b.name) + '" style="margin-left: 6px;">🗑️ 删除</button>' +
        '</td></tr>';
    }).join('');

    forEachElement('.btn-backup-del', function(btn) {
      btn.addEventListener('click', function() {
        var file = btn.getAttribute('data-file');
        confirmAction('删除数据库备份', '确定要删除备份文件 ' + file + ' 吗？', function() {
          fetchApi('/api/admin/backups?file=' + encodeURIComponent(file), { method: 'DELETE' }).then(function() {
            showToast('备份已删除');
            refreshBackupsList();
          }).catch(function(err) {
            showToast('删除失败: ' + err.message);
          });
        });
      });
    });
  }).catch(function(err) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #EF4444; padding: 20px;">加载备份失败: ' + escapeHtml(err.message) + '</td></tr>';
  });
}

function handleCreateBackup() {
  showToast('正在创建数据库热备份...');
  fetchApi('/api/admin/backups/create', { method: 'POST' }).then(function(res) {
    showToast('✅ 备份创建成功: ' + res.backup.name);
    refreshBackupsList();
    refreshStatus();
  }).catch(function(err) {
    showToast('备份失败: ' + err.message);
  });
}

function renderMigrationStatus(status) {
  var statusEl = document.getElementById('migrationExportStatus');
  var exportButton = document.getElementById('btnExportMigration');
  if (!statusEl || !exportButton) return;

  status = status || { state: 'idle', phase: null };
  var result = status.result || status;
  var currentState = status.state || 'idle';
  var phaseLabels = {
    snapshot: '正在创建数据库快照',
    attachments: '正在核对并复制聊天附件',
    manifest: '正在生成迁移清单',
    archive: '正在压缩完整迁移包',
    verify: '正在校验迁移包'
  };
  var message = '尚未开始导出';

  if (currentState === 'running') {
    message = status.message || phaseLabels[status.phase] || '正在准备完整迁移包';
  } else if (currentState === 'completed') {
    message = result.fileName
      ? '已生成：' + result.fileName + (typeof result.size === 'number' ? ' · ' + formatBytes(result.size) : '')
      : '完整迁移包已生成';
  } else if (currentState === 'failed') {
    message = '导出失败：' + (status.message || status.error || '请查看服务端日志后重试');
  }

  var cleanupWarnings = status.cleanupWarnings || result.cleanupWarnings;
  if (cleanupWarnings && cleanupWarnings.length) {
    message += currentState === 'completed'
      ? ' · 已生成，但有临时文件清理警告'
      : ' · 另有临时文件清理警告';
  }

  statusEl.textContent = message;
  statusEl.className = 'migration-export-status'
    + (cleanupWarnings && cleanupWarnings.length && currentState !== 'failed' ? ' has-warning' : '');
  statusEl.setAttribute('data-state', currentState);
  if (statusEl.dataset) statusEl.dataset.state = currentState;
  exportButton.disabled = currentState === 'running';
  exportButton.textContent = currentState === 'running' ? '正在生成迁移包…' : '导出完整迁移包';
  exportButton.setAttribute('aria-busy', currentState === 'running' ? 'true' : 'false');
}

function clearMigrationStatusTimer() {
  if (state.migrationStatusTimer) clearTimeout(state.migrationStatusTimer);
  state.migrationStatusTimer = null;
}

function stopMigrationStatusPolling() {
  state.migrationStatusEpoch = (state.migrationStatusEpoch || 0) + 1;
  clearMigrationStatusTimer();
  state.migrationStatusPending = false;
  state.migrationStatusPendingEpoch = null;
}

function scheduleMigrationStatusPoll(expectedEpoch, delay) {
  var epoch = typeof expectedEpoch === 'number' ? expectedEpoch : state.migrationStatusEpoch;
  clearMigrationStatusTimer();
  if (state.activeTab !== 'backups' || epoch !== state.migrationStatusEpoch) return;
  state.migrationStatusTimer = setTimeout(function() {
    if (epoch !== state.migrationStatusEpoch || state.activeTab !== 'backups') return;
    state.migrationStatusTimer = null;
    refreshMigrationStatus(epoch);
  }, delay || 2500);
}

function refreshMigrationStatus(expectedEpoch) {
  var epoch = typeof expectedEpoch === 'number' ? expectedEpoch : state.migrationStatusEpoch;
  if (state.activeTab !== 'backups' || epoch !== state.migrationStatusEpoch) return Promise.resolve(null);
  if (state.migrationStatusPendingEpoch === epoch) return Promise.resolve(null);
  state.migrationStatusPending = true;
  state.migrationStatusPendingEpoch = epoch;

  return fetchApi('/api/admin/migration/status').then(function(status) {
    if (epoch !== state.migrationStatusEpoch || state.activeTab !== 'backups') return null;
    renderMigrationStatus(status);
    if (status && status.state === 'running') scheduleMigrationStatusPoll(epoch);
    else clearMigrationStatusTimer();
    return status;
  }).catch(function(err) {
    if (epoch !== state.migrationStatusEpoch || state.activeTab !== 'backups') return null;
    if (err.status === 401) {
      stopMigrationStatusPolling();
      return null;
    }
    if (err.isNetworkError || err.status === 0) {
      renderMigrationStatus({ state: 'running', message: '连接暂时中断，正在重试' });
      scheduleMigrationStatusPoll(epoch);
      return null;
    }
    renderMigrationStatus({ state: 'running', message: '状态暂不可用，正在重试' });
    scheduleMigrationStatusPoll(epoch, 5000);
    return null;
  }).then(function(result) {
    if (epoch === state.migrationStatusEpoch && state.activeTab === 'backups'
        && state.migrationStatusPendingEpoch === epoch) {
      state.migrationStatusPending = false;
      state.migrationStatusPendingEpoch = null;
    }
    return result;
  }, function(err) {
    if (epoch === state.migrationStatusEpoch && state.activeTab === 'backups'
        && state.migrationStatusPendingEpoch === epoch) {
      state.migrationStatusPending = false;
      state.migrationStatusPendingEpoch = null;
    }
    throw err;
  });
}

function handleExportMigration() {
  confirmAction(
    '导出完整迁移包',
    '迁移包包含账号、好友、群聊、聊天记录、图片和文件等私密数据，并将保存到服务器 dist 目录。确认现在导出吗？',
    function() {
      stopMigrationStatusPolling();
      var exportEpoch = state.migrationStatusEpoch;
      renderMigrationStatus({ state: 'running', phase: 'snapshot' });
      scheduleMigrationStatusPoll(exportEpoch);

      fetchApi('/api/admin/migration/export', { method: 'POST' }).then(function(res) {
        if (exportEpoch !== state.migrationStatusEpoch || state.activeTab !== 'backups') return;
        var result = res.migration || res.result || res;
        stopMigrationStatusPolling();
        renderMigrationStatus({ state: 'completed', result: result, cleanupWarnings: result.cleanupWarnings });
        showToast('✅ 完整迁移包已生成：' + (result.fileName || '请查看 dist 目录'));
      }).catch(function(err) {
        if (exportEpoch !== state.migrationStatusEpoch || state.activeTab !== 'backups') return;
        if (err.status === 409 && err.code === 'MIGRATION_IN_PROGRESS') {
          clearMigrationStatusTimer();
          renderMigrationStatus({ state: 'running', phase: 'snapshot' });
          showToast('完整数据迁移正在进行，请等待当前任务完成');
          refreshMigrationStatus(exportEpoch);
          return;
        }

        if (err.isNetworkError || err.status === 0) {
          renderMigrationStatus({ state: 'running', message: '正在确认服务器状态' });
          scheduleMigrationStatusPoll(exportEpoch);
          return;
        }

        stopMigrationStatusPolling();
        var message = err.status === 409
          ? '同名迁移包已存在，请保留或移走后重试'
          : err.message;
        renderMigrationStatus({ state: 'failed', message: message });
        showToast('迁移导出失败：' + message);
      });
    }
  );
}

function handleChangeAdminPassword() {
  var oldPwd = document.getElementById('oldAdminPwd').value.trim();
  var newPwd = document.getElementById('newAdminPwd').value.trim();
  var confirmPwd = document.getElementById('confirmAdminPwd').value.trim();

  if (!oldPwd) {
    showToast('请输入原管理密码');
    return;
  }
  if (!newPwd || newPwd.length < 4) {
    showToast('新密码长度不能少于 4 位');
    return;
  }
  if (newPwd !== confirmPwd) {
    showToast('两次输入的新密码不一致');
    return;
  }

  fetchApi('/api/admin/password', {
    method: 'POST',
    body: JSON.stringify({ oldPassword: oldPwd, newPassword: newPwd })
  }).then(function() {
    showToast('🔒 密码修改成功！请重新登录');
    handleLogout();
  }).catch(function(err) {
    showToast('修改失败: ' + err.message);
  });
}

function handleShutdownAdmin() {
  confirmAction('关停 Admin 控制台与主服务', '⚠️ 警告：该操作将彻底退出 Admin 守护进程与主服务。执行后将无法继续通过网页控制台管理，需手动在服务器运行 start 脚本恢复。', function() {
    fetchApi('/api/admin/shutdown', { method: 'POST' }).then(function() {
      showToast('已发送关停指令，页面即将关闭');
    }).catch(function() {});
  });
}

// ============================================================================
// 8. LIFECYCLE & EVENT BINDINGS
// ============================================================================

function startAllPolling() {
  stopAllPolling();
  state.statusTimer = setInterval(refreshStatus, 5000);
  state.statsTimer = setInterval(refreshStats, 60000);
  state.logsTimer = setInterval(function() {
    if (state.activeTab === 'logs' && state.logAutoRefresh) {
      loadActiveLogContent();
    }
  }, 5000);
}

function stopAllPolling() {
  if (state.statusTimer) clearInterval(state.statusTimer);
  if (state.statsTimer) clearInterval(state.statsTimer);
  if (state.logsTimer) clearInterval(state.logsTimer);
  stopMigrationStatusPolling();
  state.statusTimer = null;
  state.statsTimer = null;
  state.logsTimer = null;
  state.migrationStatusPending = false;
}

function refreshAllData() {
  refreshStatus();
  refreshStats();
  refreshTunnelStatus();
  if (state.activeTab === 'users') loadUsers();
  if (state.activeTab === 'messages') { loadConversationsList(); loadMessages(); }
  if (state.activeTab === 'files') { loadFilesStats(); loadFilesList(); }
  if (state.activeTab === 'logs') refreshLogsList();
  if (state.activeTab === 'backups') { refreshBackupsList(); refreshMigrationStatus(); }
}

function switchTab(tabName) {
  if (tabName !== 'backups') stopMigrationStatusPolling();
  state.activeTab = tabName;

  forEachElement('.nav-tab', function(t) {
    t.classList.toggle('active', t.getAttribute('data-tab') === tabName);
  });

  forEachElement('.tab-pane', function(p) {
    p.classList.remove('active');
  });

  var activePane = document.getElementById('tab' + tabName.charAt(0).toUpperCase() + tabName.slice(1));
  if (activePane) activePane.classList.add('active');

  if (tabName === 'dashboard') refreshAllData();
  if (tabName === 'users') loadUsers();
  if (tabName === 'messages') { loadConversationsList(); loadMessages(); }
  if (tabName === 'files') { loadFilesStats(); loadFilesList(); }
  if (tabName === 'logs') refreshLogsList();
  if (tabName === 'backups') { refreshBackupsList(); refreshMigrationStatus(); }
}

function bindEvents() {
  var btnLogin = document.getElementById('btnLogin');
  if (btnLogin) btnLogin.addEventListener('click', handleLogin);

  var loginPwdInput = document.getElementById('loginPasswordInput');
  if (loginPwdInput) {
    loginPwdInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.keyCode === 13) handleLogin();
    });
  }

  var btnSetup = document.getElementById('btnSetupPassword');
  if (btnSetup) btnSetup.addEventListener('click', handleSetupPassword);

  var btnLogout = document.getElementById('btnLogout');
  if (btnLogout) btnLogout.addEventListener('click', handleLogout);

  forEachElement('.nav-tab', function(tab) {
    tab.addEventListener('click', function() {
      var tabName = tab.getAttribute('data-tab');
      switchTab(tabName);
    });
  });

  var btnStart = document.getElementById('btnStartApp');
  if (btnStart) {
    btnStart.addEventListener('click', function() {
      fetchApi('/api/admin/app/start', { method: 'POST' }).then(function() {
        showToast('已发送主服务启动指令');
        refreshStatus();
      }).catch(function(err) {
        showToast('启动失败: ' + err.message);
      });
    });
  }

  var btnRestart = document.getElementById('btnRestartApp');
  if (btnRestart) {
    btnRestart.addEventListener('click', function() {
      confirmAction('重启主服务', '确定要重启 Linkey 主服务吗？所有正在连接的客户端将短暂断线并随后自动重连。', function() {
        fetchApi('/api/admin/app/restart', { method: 'POST' }).then(function() {
          showToast('正在重启主服务...');
          refreshStatus();
        }).catch(function(err) {
          showToast('重启失败: ' + err.message);
        });
      });
    });
  }

  var btnStop = document.getElementById('btnStopApp');
  if (btnStop) {
    btnStop.addEventListener('click', function() {
      confirmAction('停止主服务', '确定要停止 Linkey 主服务吗？主服务停止后将进入手动停止状态，不再自动拉起，直至管理员重新点击启动。', function() {
        fetchApi('/api/admin/app/stop', { method: 'POST' }).then(function() {
          showToast('已停止主服务');
          refreshStatus();
        }).catch(function(err) {
          showToast('停止失败: ' + err.message);
        });
      });
    });
  }

  // Users Events
  var btnSearchUsers = document.getElementById('btnSearchUsers');
  if (btnSearchUsers) {
    btnSearchUsers.addEventListener('click', function() {
      state.usersSearch = document.getElementById('userSearchInput').value.trim();
      state.usersStatus = document.getElementById('userStatusFilter').value;
      state.usersPage = 1;
      loadUsers();
    });
  }

  var userSearchInput = document.getElementById('userSearchInput');
  if (userSearchInput) {
    userSearchInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' || e.keyCode === 13) btnSearchUsers.click();
    });
  }

  var btnResetUsers = document.getElementById('btnResetUsersFilter');
  if (btnResetUsers) {
    btnResetUsers.addEventListener('click', function() {
      document.getElementById('userSearchInput').value = '';
      document.getElementById('userStatusFilter').value = 'all';
      state.usersSearch = '';
      state.usersStatus = 'all';
      state.usersPage = 1;
      loadUsers();
    });
  }

  var btnRefreshUsers = document.getElementById('btnRefreshUsers');
  if (btnRefreshUsers) btnRefreshUsers.addEventListener('click', loadUsers);

  var btnUsersPrev = document.getElementById('btnUsersPrevPage');
  if (btnUsersPrev) {
    btnUsersPrev.addEventListener('click', function() {
      if (state.usersPage > 1) {
        state.usersPage--;
        loadUsers();
      }
    });
  }

  var btnUsersNext = document.getElementById('btnUsersNextPage');
  if (btnUsersNext) {
    btnUsersNext.addEventListener('click', function() {
      state.usersPage++;
      loadUsers();
    });
  }

  var btnCancelEdit = document.getElementById('btnCancelEditUser');
  if (btnCancelEdit) btnCancelEdit.addEventListener('click', function() { document.getElementById('modalEditUser').style.display = 'none'; });

  var btnSaveEdit = document.getElementById('btnSaveEditUser');
  if (btnSaveEdit) btnSaveEdit.addEventListener('click', handleSaveEditUser);

  var btnCancelReset = document.getElementById('btnCancelResetUserPwd');
  if (btnCancelReset) btnCancelReset.addEventListener('click', function() { document.getElementById('modalResetUserPwd').style.display = 'none'; });

  var btnConfirmReset = document.getElementById('btnConfirmResetUserPwd');
  if (btnConfirmReset) btnConfirmReset.addEventListener('click', handleConfirmResetUserPwd);

  // Messages Events
  var msgConvSelect = document.getElementById('msgConvSelect');
  if (msgConvSelect) {
    msgConvSelect.addEventListener('change', function() {
      state.messagesPage = 1;
      loadMessages();
    });
  }

  var btnSearchMsgs = document.getElementById('btnSearchMessages');
  if (btnSearchMsgs) {
    btnSearchMsgs.addEventListener('click', function() {
      state.messagesQuery = document.getElementById('msgSearchKeyword').value.trim();
      state.messagesType = document.getElementById('msgTypeFilter').value;
      state.messagesPage = 1;
      loadMessages();
    });
  }

  var btnRefreshMsgs = document.getElementById('btnRefreshMessages');
  if (btnRefreshMsgs) btnRefreshMsgs.addEventListener('click', loadMessages);

  var btnMsgsPrev = document.getElementById('btnMsgsPrevPage');
  if (btnMsgsPrev) {
    btnMsgsPrev.addEventListener('click', function() {
      if (state.messagesPage > 1) {
        state.messagesPage--;
        loadMessages();
      }
    });
  }

  var btnMsgsNext = document.getElementById('btnMsgsNextPage');
  if (btnMsgsNext) {
    btnMsgsNext.addEventListener('click', function() {
      state.messagesPage++;
      loadMessages();
    });
  }

  var chkAllMsgs = document.getElementById('chkSelectAllMsgs');
  if (chkAllMsgs) {
    chkAllMsgs.addEventListener('change', function(e) {
      var checked = e.target.checked;
      forEachElement('.chk-msg-item', function(chk) {
        chk.checked = checked;
        var id = chk.getAttribute('data-id');
        if (checked) state.selectedMessageIds[id] = true;
        else delete state.selectedMessageIds[id];
      });
      updateBatchBar();
    });
  }

  var btnCancelBatch = document.getElementById('btnCancelBatchSelect');
  if (btnCancelBatch) {
    btnCancelBatch.addEventListener('click', function() {
      state.selectedMessageIds = {};
      if (chkAllMsgs) chkAllMsgs.checked = false;
      forEachElement('.chk-msg-item', function(chk) { chk.checked = false; });
      updateBatchBar();
    });
  }

  var btnBatchDel = document.getElementById('btnBatchDeleteMsgs');
  if (btnBatchDel) {
    btnBatchDel.addEventListener('click', function() {
      var ids = Object.keys(state.selectedMessageIds).map(Number);
      confirmAction('批量删除消息', '确定要彻底删除勾选的 ' + ids.length + ' 条消息吗？', function() {
        fetchApi('/api/admin/messages/batch-delete', {
          method: 'POST',
          body: JSON.stringify({ ids: ids })
        }).then(function(res) {
          showToast('已成功批量删除 ' + res.deletedCount + ' 条消息');
          state.selectedMessageIds = {};
          if (chkAllMsgs) chkAllMsgs.checked = false;
          loadMessages();
        }).catch(function(err) {
          showToast('批量删除失败: ' + err.message);
        });
      });
    });
  }

  var btnClearConv = document.getElementById('btnClearCurrentConv');
  if (btnClearConv) {
    btnClearConv.addEventListener('click', function() {
      var convId = document.getElementById('msgConvSelect').value;
      confirmAction('清空会话聊天记录', '确定要清空当前选中的会话的所有历史聊天记录吗？此操作不可逆！', function() {
        fetchApi('/api/admin/conversations/' + convId + '/clear', { method: 'POST' }).then(function(res) {
          showToast('已清空会话记录 (删除了 ' + res.deletedCount + ' 条消息)');
          loadMessages();
          loadConversationsList();
        }).catch(function(err) {
          showToast('清空失败: ' + err.message);
        });
      });
    });
  }

  var btnDelConv = document.getElementById('btnDeleteCurrentConv');
  if (btnDelConv) {
    btnDelConv.addEventListener('click', function() {
      var convId = document.getElementById('msgConvSelect').value;
      confirmAction('解散/删除会话', '⚠️ 警告：确定要彻底删除该会话/群聊及其所有关联记录吗？', function() {
        fetchApi('/api/admin/conversations/' + convId, { method: 'DELETE' }).then(function() {
          showToast('已解散并删除会话');
          document.getElementById('msgConvSelect').value = '';
          loadConversationsList();
          loadMessages();
        }).catch(function(err) {
          showToast('删除失败: ' + err.message);
        });
      });
    });
  }

  // Files Events
  forEachElement('#fileCategoryTabs .segment-btn', function(btn) {
    btn.addEventListener('click', function() {
      forEachElement('#fileCategoryTabs .segment-btn', function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      state.filesCategory = btn.getAttribute('data-cat');
      state.filesPage = 1;
      loadFilesList();
    });
  });

  var btnSearchFiles = document.getElementById('btnSearchFiles');
  if (btnSearchFiles) {
    btnSearchFiles.addEventListener('click', function() {
      state.filesSearch = document.getElementById('fileSearchInput').value.trim();
      state.filesPage = 1;
      loadFilesList();
    });
  }

  var btnRefreshFiles = document.getElementById('btnRefreshFiles');
  if (btnRefreshFiles) {
    btnRefreshFiles.addEventListener('click', function() {
      loadFilesStats();
      loadFilesList();
    });
  }

  var btnFilesPrev = document.getElementById('btnFilesPrevPage');
  if (btnFilesPrev) {
    btnFilesPrev.addEventListener('click', function() {
      if (state.filesPage > 1) {
        state.filesPage--;
        loadFilesList();
      }
    });
  }

  var btnFilesNext = document.getElementById('btnFilesNextPage');
  if (btnFilesNext) {
    btnFilesNext.addEventListener('click', function() {
      state.filesPage++;
      loadFilesList();
    });
  }

  var btnCleanOrphans = document.getElementById('btnCleanOrphanFiles');
  if (btnCleanOrphans) {
    btnCleanOrphans.addEventListener('click', function() {
      confirmAction('清理孤立文件', '确定要扫描并清理 uploads 中未被任何消息或用户引用的孤立垃圾文件吗？', function() {
        fetchApi('/api/admin/files/cleanup-orphaned', { method: 'POST' }).then(function(res) {
          showToast('🧹 清理完成：删除了 ' + res.deletedCount + ' 个孤立文件 (释放 ' + Math.round((res.freedBytes || 0) / 1024) + ' KB)');
          loadFilesStats();
          loadFilesList();
        }).catch(function(err) {
          showToast('清理失败: ' + err.message);
        });
      });
    });
  }

  var btnCloseLight = document.getElementById('btnCloseLightbox');
  if (btnCloseLight) {
    btnCloseLight.addEventListener('click', function() {
      document.getElementById('modalFileLightbox').style.display = 'none';
    });
  }

  // Logs Toolbar
  var logSelect = document.getElementById('logFileSelect');
  if (logSelect) {
    logSelect.addEventListener('change', function() {
      state.selectedLogFile = logSelect.value;
      loadActiveLogContent();
    });
  }

  var logTail = document.getElementById('logTailSelect');
  if (logTail) logTail.addEventListener('change', loadActiveLogContent);

  var chkAutoRef = document.getElementById('chkAutoRefreshLogs');
  if (chkAutoRef) {
    chkAutoRef.addEventListener('change', function(e) {
      state.logAutoRefresh = e.target.checked;
    });
  }

  var btnRefLogs = document.getElementById('btnRefreshLogs');
  if (btnRefLogs) {
    btnRefLogs.addEventListener('click', function() {
      loadActiveLogContent();
      showToast('日志已刷新');
    });
  }

  var btnDlLog = document.getElementById('btnDownloadLog');
  if (btnDlLog) {
    btnDlLog.addEventListener('click', function() {
      var file = document.getElementById('logFileSelect').value;
      if (file) downloadLogFile(file);
    });
  }

  // Backups
  var btnCreateBak = document.getElementById('btnCreateBackup');
  if (btnCreateBak) btnCreateBak.addEventListener('click', handleCreateBackup);

  var btnExportMigration = document.getElementById('btnExportMigration');
  if (btnExportMigration) btnExportMigration.addEventListener('click', handleExportMigration);

  // Settings
  var btnSaveAdminPwd = document.getElementById('btnSaveAdminPwd');
  if (btnSaveAdminPwd) btnSaveAdminPwd.addEventListener('click', handleChangeAdminPassword);

  var btnShutAdmin = document.getElementById('btnShutdownAdmin');
  if (btnShutAdmin) btnShutAdmin.addEventListener('click', handleShutdownAdmin);

  // Tunnel Management Buttons
  var btnStartTunnel = document.getElementById('btnStartTunnel');
  if (btnStartTunnel) btnStartTunnel.addEventListener('click', handleStartTunnel);

  var btnStopTunnel = document.getElementById('btnStopTunnel');
  if (btnStopTunnel) btnStopTunnel.addEventListener('click', handleStopTunnel);

  var btnCopyTunnel = document.getElementById('btnCopyTunnelUrl');
  if (btnCopyTunnel) {
    btnCopyTunnel.addEventListener('click', function() {
      var link = document.getElementById('linkTunnelPublicUrl');
      if (link && link.textContent && link.textContent !== '-') {
        navigator.clipboard.writeText(link.textContent).then(function() {
          showToast('📋 已复制外网访问地址到剪贴板！');
        }).catch(function() {
          showToast('复制成功: ' + link.textContent);
        });
      }
    });
  }
}

// Expose handlers to window for inline onclick fallbacks
window.handleLogin = handleLogin;
window.handleSetupPassword = handleSetupPassword;
window.addEventListener('pagehide', stopMigrationStatusPolling);
function handleMigrationPageShow(event) {
  if (event.persisted && state.activeTab === 'backups') {
    stopMigrationStatusPolling();
    refreshMigrationStatus();
  }
}
window.addEventListener('pageshow', handleMigrationPageShow);

function init() {
  bindEvents();
  if (state.token) {
    showMainView();
  } else {
    showLoginView();
  }
}

// Initial Entry (handles both loading and already-loaded states)
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
