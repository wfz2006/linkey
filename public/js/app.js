import { api } from './api.js';
import { socketClient } from './socket.js';
import { playMessageSound, playPokeSound, toggleMute, getMuteState } from './audio.js';
import { effects } from './effects.js';

// 注册 Service Worker（PWA 离线缓存 / 添加到主屏幕）
if ('serviceWorker' in navigator && location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[PWA] Service Worker 注册失败:', err.message);
    });
  });
}

// QQ Huanglian Emojis
const EMOJIS = [
  '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '😉', '😊', '😇',
  '🥰', '😍', '🤩', '😘', '😗', '😋', '😛', '😜', '🤪', '😎', '🥳', '😏',
  '🤔', '🤫', '🤭', '🤐', '🤨', '😐', '😑', '😶', '😴', '😷', '🤒', '🤕',
  '👍', '👎', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✌️', '🤞', '🤟', '🤘',
  '❤️', '🌹', '💔', '🔥', '🎉', '✨', '🚀', '💯', '💩', '👻', '⭐', '🎈'
];

// App State
const state = {
  currentUser: null,
  conversations: [],
  contacts: [],
  friendRequests: { incoming: [], outgoing: [] },
  zonePosts: [],
  zoneAlbums: [],
  activeConversationId: null,
  activeMessages: [],
  activeChatMembers: [],
  activePeerUser: null,
  currentTab: 'chats',
  typingTimeout: null,
  isRegisterMode: false,
  replyingTo: null,
  forwardingMsg: null,
  selectedZonePhotos: [],
  pendingMsgPayloads: new Map(), // clientMsgId -> { conversationId, type, content, fileName, fileSize, replyToId }
  isLoadingEarlierMessages: false,
  hasMoreEarlierMessages: true,
  unreadTotal: 0,
  isWindowFocused: true,
  titleFlashTimer: null,
  selectedMsgForContext: null,
  selectedConvForContext: null
};

// 移动端返回按钮锁：history.back() 异步派发 popstate 前屏蔽重复点击
let mobileBackLock = false;

// Auto-Link URL Converter
function formatMessageContent(text) {
  if (!text) return '';
  const escaped = escapeHtml(text);
  // Match URLs
  const urlRegex = /(https?:\/\/[^\s<]+)/g;
  return escaped.replace(urlRegex, (url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer" style="color: #00F2FE; text-decoration: underline; word-break: break-all;">${url}</a>`;
  });
}

function createSvgAvatar(emoji, color1, color2) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${color1}"/><stop offset="100%" stop-color="${color2}"/></linearGradient></defs><rect width="100" height="100" rx="50" fill="url(#g)"/><text x="50" y="58" font-size="52" text-anchor="middle" dominant-baseline="middle">${emoji}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// 12 Self-Contained High-Res SVG Preset Avatars (100% Offline & Instant)
const PRESET_AVATARS = [
  { id: 'penguin', name: '经典企鹅', svg: createSvgAvatar('🐧', '#00C6FF', '#0072FF') },
  { id: 'boy', name: '极客少年', svg: createSvgAvatar('👦', '#667EEA', '#764BA2') },
  { id: 'girl', name: '元气少女', svg: createSvgAvatar('👧', '#F355A0', '#FF758C') },
  { id: 'cat', name: '软萌猫咪', svg: createSvgAvatar('🐱', '#FF9A9E', '#FECFEF') },
  { id: 'dog', name: '元气柴犬', svg: createSvgAvatar('🐶', '#F6D365', '#FDA085') },
  { id: 'robot', name: '赛博机甲', svg: createSvgAvatar('🤖', '#4FACFE', '#00F2FE') },
  { id: 'astro', name: '星际宇航', svg: createSvgAvatar('🧑‍🚀', '#30CFD0', '#330867') },
  { id: 'gamer', name: '电竞高玩', svg: createSvgAvatar('🎮', '#8E2DE2', '#4A00E0') },
  { id: 'vip', name: '至尊皇冠', svg: createSvgAvatar('👑', '#FFE000', '#799F0C') },
  { id: 'fox', name: '灵动赤狐', svg: createSvgAvatar('🦊', '#FF512F', '#DD2476') },
  { id: 'star', name: '璀璨之星', svg: createSvgAvatar('🌟', '#F857A6', '#FF5858') },
  { id: 'coffee', name: '治愈咖啡', svg: createSvgAvatar('☕', '#43E97B', '#38F9D7') }
];

// Local Self-Contained SVG Avatar Generator (100% Offline & Reliable)
function getSafeAvatar(url, name = 'user', isGroup = false) {
  if (url) {
    if (url.startsWith('/uploads/') || url.startsWith('data:image/png') || url.startsWith('data:image/jpeg') || url.startsWith('data:image/webp')) {
      return url;
    }
    if (url.startsWith('data:image/svg+xml')) {
      if (url.includes('<svg') || url.includes('"')) {
        const svgContent = url.replace(/^data:image\/svg\+xml(;utf8)?,?/, '');
        return `data:image/svg+xml;utf8,${encodeURIComponent(svgContent)}`;
      }
      return url;
    }
    if ((url.startsWith('http://') || url.startsWith('https://')) && !url.includes('dicebear')) {
      return url;
    }
  }
  const colors = [
    ['#00C6FF', '#0072FF'],
    ['#F355A0', '#FF758C'],
    ['#10B981', '#059669'],
    ['#8B5CF6', '#6D28D9'],
    ['#F59E0B', '#D97706'],
    ['#00F2FE', '#4FACFE'],
    ['#EC4899', '#BE185D']
  ];
  const s = String(name || 'user');
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash << 5) - hash + s.charCodeAt(i);
  const cp = colors[Math.abs(hash) % colors.length];
  const init = (s.trim().charAt(0) || 'Q').toUpperCase();

  if (isGroup) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${cp[0]}"/><stop offset="100%" stop-color="${cp[1]}"/></linearGradient></defs><rect width="100" height="100" rx="50" fill="url(#g)"/><text x="50" y="58" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="44" fill="white" text-anchor="middle" dominant-baseline="middle">👥</text></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  if (s.toLowerCase().includes('helper') || s.toLowerCase().includes('penguin') || s.includes('管家')) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#00C6FF"/><stop offset="100%" stop-color="#0072FF"/></linearGradient></defs><rect width="100" height="100" rx="50" fill="url(#g)"/><text x="50" y="58" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="52" fill="white" text-anchor="middle" dominant-baseline="middle">🐧</text></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${cp[0]}"/><stop offset="100%" stop-color="${cp[1]}"/></linearGradient></defs><rect width="100" height="100" rx="50" fill="url(#g)"/><text x="50" y="58" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif" font-size="46" font-weight="700" fill="white" text-anchor="middle" dominant-baseline="middle">${init}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// Format QQ Level into 👑 ☀️ 🌙 ⭐️
function formatQQLevel(level) {
  if (!level || level <= 0) return '⭐️';
  let remaining = level;
  let res = '';

  const crowns = Math.floor(remaining / 64);
  remaining %= 64;
  const suns = Math.floor(remaining / 16);
  remaining %= 16;
  const moons = Math.floor(remaining / 4);
  remaining %= 4;
  const stars = remaining;

  for (let i = 0; i < crowns; i++) res += '👑';
  for (let i = 0; i < suns; i++) res += '☀️';
  for (let i = 0; i < moons; i++) res += '🌙';
  for (let i = 0; i < stars; i++) res += '⭐️';
  return res || '⭐️';
}

// Format Time
function formatMessageTime(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString.endsWith('Z') ? isoString : isoString + 'Z');
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');

  if (isToday) return `${hours}:${minutes}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hours}:${minutes}`;
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

// Web Notifications & Title Flashing
function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function triggerDesktopNotification(title, body, icon) {
  if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
    try {
      new Notification(title, {
        body,
        icon: icon || '/app-icon-192.png',
        tag: 'qq-msg'
      });
    } catch {}
  }
}

function startTitleFlashing(msgTitle) {
  if (state.titleFlashTimer) clearInterval(state.titleFlashTimer);
  let flag = true;
  state.titleFlashTimer = setInterval(() => {
    document.title = flag ? `【新消息】${msgTitle}` : 'Linkey';
    flag = !flag;
  }, 1000);
}

function stopTitleFlashing() {
  if (state.titleFlashTimer) {
    clearInterval(state.titleFlashTimer);
    state.titleFlashTimer = null;
  }
  document.title = 'Linkey';
}

window.addEventListener('focus', () => {
  state.isWindowFocused = true;
  stopTitleFlashing();
});
window.addEventListener('blur', () => {
  state.isWindowFocused = false;
});

// Toast notification
const toastContainer = document.getElementById('toastContainer');
function showToast(message, duration = 3000) {
  if (!toastContainer) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  toastContainer.appendChild(toast);
  setTimeout(() => { toast.remove(); }, duration);
}

// DOM Elements
const authView = document.getElementById('authView');
const appView = document.getElementById('appView');
const authForm = document.getElementById('authForm');
const tabLogin = document.getElementById('tabLogin');
const tabRegister = document.getElementById('tabRegister');
const registerFields = document.getElementById('registerFields');
const authBtnText = document.getElementById('authBtnText');
const quickUsersGrid = document.getElementById('quickUsersGrid');

const navAvatarImg = document.getElementById('navAvatarImg');
const navStatusDot = document.getElementById('navStatusDot');
const navTabChats = document.getElementById('navTabChats');
const navTabContacts = document.getElementById('navTabContacts');
const navTabZone = document.getElementById('navTabZone');
const navMuteToggle = document.getElementById('navMuteToggle');
const navLogoutBtn = document.getElementById('navLogoutBtn');

const sidebarTitleText = document.getElementById('sidebarTitleText');
const sidebarChatsPane = document.getElementById('sidebarChatsPane');
const sidebarContactsPane = document.getElementById('sidebarContactsPane');
const sidebarZonePane = document.getElementById('sidebarZonePane');
const conversationList = document.getElementById('conversationList');
const searchInput = document.getElementById('searchInput');
const btnNewDirectChat = document.getElementById('btnNewDirectChat');
const btnNewGroupChat = document.getElementById('btnNewGroupChat');

const btnOpenAddFriendModal = document.getElementById('btnOpenAddFriendModal');
const btnNewFriendRequests = document.getElementById('btnNewFriendRequests');
const badgeNewFriendReqs = document.getElementById('badgeNewFriendReqs');
const groupListSpecial = document.getElementById('groupListSpecial');
const groupListFriends = document.getElementById('groupListFriends');
const groupListGroups = document.getElementById('groupListGroups');
const countSpecial = document.getElementById('countSpecial');
const countFriends = document.getElementById('countFriends');
const countGroups = document.getElementById('countGroups');

const chatMain = document.getElementById('chatMain');
const chatEmptyPlaceholder = document.getElementById('chatEmptyPlaceholder');
const chatActiveWindow = document.getElementById('chatActiveWindow');
const btnMobileBack = document.getElementById('btnMobileBack');
const chatHeaderAvatar = document.getElementById('chatHeaderAvatar');
const chatHeaderTitle = document.getElementById('chatHeaderTitle');
const chatHeaderLevelTag = document.getElementById('chatHeaderLevelTag');
const chatHeaderStatus = document.getElementById('chatHeaderStatus');
const btnSearchChatMessages = document.getElementById('btnSearchChatMessages');
const btnHeaderPoke = document.getElementById('btnHeaderPoke');
const btnToolbarPoke = document.getElementById('btnToolbarPoke');
const btnGroupSettings = document.getElementById('btnGroupSettings');
const chatMessageSearchBar = document.getElementById('chatMessageSearchBar');
const chatSearchInput = document.getElementById('chatSearchInput');
const btnCloseChatSearch = document.getElementById('btnCloseChatSearch');
const groupNoticeBanner = document.getElementById('groupNoticeBanner');
const groupNoticeText = document.getElementById('groupNoticeText');
const btnEditNoticeFast = document.getElementById('btnEditNoticeFast');
const messagesContainer = document.getElementById('messagesContainer');
const messagesLoadingTop = document.getElementById('messagesLoadingTop');

const quoteReplyBar = document.getElementById('quoteReplyBar');
const quoteReplyUser = document.getElementById('quoteReplyUser');
const quoteReplySnippet = document.getElementById('quoteReplySnippet');
const btnCancelQuoteReply = document.getElementById('btnCancelQuoteReply');

const chatInput = document.getElementById('chatInput');
const btnSendMessage = document.getElementById('btnSendMessage');
const btnEmojiToggle = document.getElementById('btnEmojiToggle');
const emojiPopover = document.getElementById('emojiPopover');
const mentionsPopup = document.getElementById('mentionsPopup');
const btnSendImage = document.getElementById('btnSendImage');
const btnSendFile = document.getElementById('btnSendFile');
const imageFileInput = document.getElementById('imageFileInput');
const generalFileInput = document.getElementById('generalFileInput');

// Modals
const modalDirectChat = document.getElementById('modalDirectChat');
const modalUserSearchInput = document.getElementById('modalUserSearchInput');
const userSearchResults = document.getElementById('userSearchResults');
const modalGroupChat = document.getElementById('modalGroupChat');
const groupNameInput = document.getElementById('groupNameInput');
const groupMemberList = document.getElementById('groupMemberList');
const btnConfirmCreateGroup = document.getElementById('btnConfirmCreateGroup');
const modalProfile = document.getElementById('modalProfile');
const modalAddFriendPrompt = document.getElementById('modalAddFriendPrompt');
const addFriendTargetAvatar = document.getElementById('addFriendTargetAvatar');
const addFriendTargetName = document.getElementById('addFriendTargetName');
const addFriendTargetQQ = document.getElementById('addFriendTargetQQ');
const addFriendMessageInput = document.getElementById('addFriendMessageInput');
const btnConfirmSendFriendReq = document.getElementById('btnConfirmSendFriendReq');
const modalFriendRequests = document.getElementById('modalFriendRequests');
const friendRequestsListContainer = document.getElementById('friendRequestsListContainer');
const modalChangePassword = document.getElementById('modalChangePassword');
const oldPasswordInput = document.getElementById('oldPasswordInput');
const newPasswordInput = document.getElementById('newPasswordInput');
const confirmNewPasswordInput = document.getElementById('confirmNewPasswordInput');
const btnConfirmChangePassword = document.getElementById('btnConfirmChangePassword');
const modalGroupSettings = document.getElementById('modalGroupSettings');
const groupSettingsNameInput = document.getElementById('groupSettingsNameInput');
const groupSettingsNoticeInput = document.getElementById('groupSettingsNoticeInput');
const btnSaveGroupNotice = document.getElementById('btnSaveGroupNotice');
const groupSettingsMemberCount = document.getElementById('groupSettingsMemberCount');
const groupSettingsMemberList = document.getElementById('groupSettingsMemberList');
const btnLeaveGroup = document.getElementById('btnLeaveGroup');
const modalForwardMessage = document.getElementById('modalForwardMessage');
const forwardMsgPreview = document.getElementById('forwardMsgPreview');
const forwardTargetList = document.getElementById('forwardTargetList');
const modalUserProfileCard = document.getElementById('modalUserProfileCard');
const modalDedicatedQzone = document.getElementById('modalDedicatedQzone');
const msgContextMenu = document.getElementById('msgContextMenu');
const convContextMenu = document.getElementById('convContextMenu');
const imageLightbox = document.getElementById('imageLightbox');
const lightboxImg = document.getElementById('lightboxImg');
const lightboxClose = document.getElementById('lightboxClose');

// ============================================================================
// 1. INITIALIZATION & AUTHENTICATION
// ============================================================================

async function initApp() {
  requestNotificationPermission();

  // Populate Emoji Popover with header and grid
  if (emojiPopover) {
    emojiPopover.innerHTML = `
      <div class="emoji-popover-header">
        <span class="emoji-popover-title">😊 常用表情</span>
        <button id="btnCloseEmojiPopover" class="emoji-popover-close" title="收起表情面板 (Esc)">✕</button>
      </div>
      <div class="emoji-popover-grid">
        ${EMOJIS.map(e => `<span class="emoji-item" data-emoji="${e}">${e}</span>`).join('')}
      </div>
    `;

    const btnCloseEmoji = document.getElementById('btnCloseEmojiPopover');
    if (btnCloseEmoji) {
      btnCloseEmoji.addEventListener('click', (e) => {
        e.stopPropagation();
        hideEmojiPopover();
      });
    }
  }

  // Bind UI Events
  bindEventListeners();

  // Check saved session
  const token = api.getToken();
  if (token) {
    try {
      const user = await api.getMe();
      state.currentUser = user;
      setupAppSession(user, token);
      return;
    } catch {
      api.clearAuth();
    }
  }

  // Show Auth View
  showAuthView();
  loadQuickUsers();
}

function showAuthView() {
  if (authView) authView.style.display = 'flex';
  if (appView) appView.style.display = 'none';
}

function showAppView() {
  if (authView) authView.style.display = 'none';
  if (appView) appView.style.display = 'flex';
}

// 定位登录 Tab 液态指示器（switchAuthMode 与初始加载共用）
function positionAuthIndicator(activeTab) {
  const tabsWrap = document.querySelector('.auth-tabs');
  const indicator = document.querySelector('.auth-tab-indicator');
  if (tabsWrap && indicator && activeTab) {
    tabsWrap.classList.add('single-active');
    effects.moveIndicator(indicator, activeTab);
  }
}

// 切换登录/注册 Tab（含液态指示器定位）
function switchAuthMode(isRegister) {
  state.isRegisterMode = isRegister;   // 预留：表单提交逻辑接入后读取
  tabLogin.classList.toggle('active', !isRegister);
  tabRegister.classList.toggle('active', isRegister);
  // 注册模式展开昵称/签名额外字段
  if (registerFields) registerFields.style.display = isRegister ? 'block' : 'none';
  if (authBtnText) authBtnText.textContent = isRegister ? '立即注册' : '立即进入 QQ';

  positionAuthIndicator(isRegister ? tabRegister : tabLogin);
}

async function loadQuickUsers() {
  try {
    // 公网隧道访问时后端已禁用快捷登录，前端同步隐藏入口
    if (location.hostname.toLowerCase().endsWith('.trycloudflare.com')) {
      const quickWrap = quickUsersGrid ? quickUsersGrid.closest('.quick-users') : null;
      if (quickWrap) quickWrap.style.display = 'none';
      return;
    }
    const users = await api.getQuickUsers();
    if (!quickUsersGrid) return;

    quickUsersGrid.innerHTML = users.map(u => {
      const av = getSafeAvatar(u.avatar, u.nickname || u.username);
      return `
        <div class="quick-user-card" data-username="${escapeHtml(u.username)}">
          <img src="${av}" alt="avatar">
          <div class="quick-user-name">${escapeHtml(u.nickname)}</div>
          <div class="quick-user-role">QQ: ${escapeHtml(u.qq_number || '100000')}</div>
        </div>
      `;
    }).join('');

    quickUsersGrid.querySelectorAll('.quick-user-card').forEach(card => {
      card.addEventListener('click', async () => {
        const un = card.getAttribute('data-username');
        try {
          const res = await api.quickLogin(un);
          state.currentUser = res.user;
          setupAppSession(res.user, res.token);
        } catch (err) {
          showToast(`快捷登录失败: ${err.message}`);
        }
      });
    });
  } catch (err) {
    console.warn('Failed to load quick users:', err);
  }
}

function setupAppSession(user, token) {
  showAppView();
  updateUserNav(user);

  // 进入主界面后首次定位导航液态指示器（复用 switchTab，'chats' 分支无额外加载副作用）
  switchTab(state.currentTab);

  // Initialize chat pane to empty state until a conversation is opened
  state.activeConversationId = null;
  if (chatActiveWindow) chatActiveWindow.style.display = 'none';
  if (chatEmptyPlaceholder) chatEmptyPlaceholder.style.display = 'flex';

  // Connect WebSocket
  socketClient.connect(token);

  // Load Initial Data
  loadConversations();
  loadContacts();
  loadZonePosts();
}

function updateUserNav(user) {
  if (!user) return;
  if (navAvatarImg) {
    navAvatarImg.src = getSafeAvatar(user.avatar, user.nickname || user.username);
  }
  if (navStatusDot) {
    navStatusDot.className = `status-dot ${user.status || 'online'}`;
  }
}

// ============================================================================
// 2. REALTIME WEBSOCKET SUBSCRIPTIONS
// ============================================================================

socketClient.on('connect', () => {
  socketClient.updateStatus(state.currentUser?.status || 'online');
});

socketClient.on('reconnected', () => {
  showToast('🔄 网络已重新连接，数据同步完成');
  loadConversations();
  loadContacts();
  if (state.activeConversationId) {
    loadConversationMessages(state.activeConversationId, true);
  }
});

socketClient.on('message:ack', (data) => {
  if (data && data.clientMsgId) {
    const el = document.querySelector(`[data-client-id="${data.clientMsgId}"]`);
    if (el) {
      el.setAttribute('data-id', data.messageId);
      const statusSpan = el.querySelector('.msg-status-indicator');
      if (statusSpan) {
        statusSpan.className = 'msg-status-indicator delivered';
        statusSpan.textContent = '✓ 送达';
      }
    }
  }
});

socketClient.on('message:new', (data) => {
  const { message, conversationId } = data;
  if (!message) return;

  // Sound & Notification & Poke Shake
  if (message.type === 'poke') {
    playPokeSound();
    triggerScreenShake();
  } else if (message.senderId !== state.currentUser?.id) {
    playMessageSound();
  }

  if (message.senderId !== state.currentUser?.id) {
    const senderName = message.sender?.nickname || 'QQ好友';
    triggerDesktopNotification(`Linkey - ${senderName}`, message.type === 'poke' ? '戳了戳你' : message.content, getSafeAvatar(message.sender?.avatar, senderName));
    if (!state.isWindowFocused) {
      startTitleFlashing(`${senderName}: ${message.content.slice(0, 15)}`);
    }
  }

  // If in current active conversation
  if (state.activeConversationId === conversationId) {
    // Check if optimistic message already exists
    const existing = document.querySelector(`[data-id="${message.id}"]`);
    if (!existing) {
      appendMessageToDOM(message);
      scrollToBottom();
    }
    // Mark as read
    if (message.senderId !== state.currentUser?.id) {
      api.markConversationAsRead(conversationId);
      socketClient.markRead(conversationId, message.id);
    }
  } else {
    // Increment unread and sound
    state.unreadTotal++;
  }

  // Update conversation list item
  loadConversations();
});

socketClient.on('message:recalled', (data) => {
  const { messageId, conversationId, recalledBy } = data;
  const msgEl = document.querySelector(`.message-row[data-id="${messageId}"]`);
  if (msgEl) {
    const isMe = recalledBy === state.currentUser?.id;
    msgEl.className = 'message-row system-msg';
    msgEl.innerHTML = `<div class="system-msg-bubble">${isMe ? '你' : '对方'}撤回了一条消息</div>`;
  }
  loadConversations();
});

socketClient.on('message:deleted', (data) => {
  const { messageId } = data;
  const msgEl = document.querySelector(`.message-row[data-id="${messageId}"]`);
  if (msgEl) msgEl.remove();
  loadConversations();
});

socketClient.on('message:read_ack', (data) => {
  const { conversationId, maxMessageId, userId } = data;
  if (state.activeConversationId === conversationId && userId !== state.currentUser?.id) {
    document.querySelectorAll('.message-row.outgoing .msg-status-indicator').forEach(el => {
      const parent = el.closest('.message-row');
      const mid = parseInt(parent?.getAttribute('data-id') || '0', 10);
      if (mid && mid <= maxMessageId) {
        el.className = 'msg-status-indicator read';
        el.textContent = '✓ 已读';
      }
    });
  }
});

// 恢复聊天头部状态栏文案（直接会话显示在线状态，群聊显示成员数）
function restoreChatHeaderStatus() {
  if (!chatHeaderStatus) return;
  const conv = (state.conversations || []).find(c => c.id === state.activeConversationId);
  if (conv && conv.type === 'group') {
    chatHeaderStatus.textContent = `群聊 · ${conv.memberCount || 0}人`;
  } else {
    chatHeaderStatus.innerHTML = state.activePeerUser?.status === 'online'
      ? '<span class="dot-online"></span>在线'
      : '⚪ 离线';
  }
  chatHeaderStatus.style.color = '';
}

socketClient.on('typing:start', (data) => {
  if (data.conversationId === state.activeConversationId && data.userId !== state.currentUser?.id) {
    if (chatHeaderStatus) {
      chatHeaderStatus.textContent = '对方正在输入中...';
      chatHeaderStatus.style.color = '#00F2FE';
    }
  }
});

socketClient.on('typing:stop', (data) => {
  if (data.conversationId === state.activeConversationId && data.userId !== state.currentUser?.id) {
    restoreChatHeaderStatus();
  }
});

socketClient.on('friend:request', (data) => {
  playMessageSound();
  showToast(`🔔 收到来自 ${data.fromUser?.nickname || '用户'} 的好友申请！`);
  loadContacts();
});

socketClient.on('friend:accepted', (data) => {
  playMessageSound();
  showToast(`🎉 ${data.byUser?.nickname || '好友'} 已同意您的好友申请！`);
  loadContacts();
  loadConversations();
});

socketClient.on('group:kicked', (data) => {
  const { conversationId, reason } = data;
  showToast(`⚠️ ${reason || '您已被移出群聊'}`);
  if (state.activeConversationId === conversationId) {
    state.activeConversationId = null;
    if (chatActiveWindow) chatActiveWindow.style.display = 'none';
    if (chatEmptyPlaceholder) chatEmptyPlaceholder.style.display = 'flex';
  }
  loadConversations();
  loadContacts();
});

socketClient.on('group:owner_transferred', (data) => {
  showToast('👑 前群主已离开，您已自动成为该群的新群主！');
  loadConversations();
  if (state.activeConversationId === data.conversationId) {
    loadConversationDetails(data.conversationId);
  }
});

socketClient.on('conversation:new', () => {
  loadConversations();
});

socketClient.on('conversation:updated', () => {
  loadConversations();
  if (state.activeConversationId) {
    loadConversationDetails(state.activeConversationId);
  }
});

socketClient.on('user:status', (data) => {
  const { userId, status } = data;
  document.querySelectorAll(`[data-user-id="${userId}"] .status-dot, [data-user-id="${userId}"] .status-indicator`).forEach(el => {
    el.className = `status-dot ${status}`;
  });
  if (state.currentUser && state.currentUser.id === userId) {
    state.currentUser.status = status;
    updateUserNav(state.currentUser);
  }
  if (state.activePeerUser && state.activePeerUser.id === userId) {
    state.activePeerUser.status = status;
    if (chatHeaderStatus) {
      const isSelf = userId === state.currentUser?.id;
      // 在线状态渲染为呼吸圆点（.dot-online 由 CSS 提供呼吸动画）
      chatHeaderStatus.innerHTML = status === 'online'
        ? `<span class="dot-online"></span>在线${isSelf ? ' (我的电脑/我)' : ''}`
        : '⚪ 离线';
    }
  }
});

// ============================================================================
// 3. CONVERSATION MANAGEMENT
// ============================================================================

async function loadConversations() {
  try {
    const convs = await api.getConversations();
    state.conversations = convs;
    renderConversationList(convs);
  } catch (err) {
    console.error('Failed to load conversations:', err);
  }
}

function renderConversationList(convs) {
  if (!conversationList) return;

  if (convs.length === 0) {
    conversationList.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 40px 16px; font-size: 13px;">
        暂无活跃会话<br>点击上方 ➕ 发起聊天
      </div>
    `;
    return;
  }

  conversationList.innerHTML = convs.map(c => {
    const isActive = c.id === state.activeConversationId;
    const isPinned = c.isPinned;
    const isGroup = c.type === 'group';
    const avatar = getSafeAvatar(c.avatar, c.name, isGroup);
    // 未读红点：挂在头像左下角（conv-avatar-wrap 内），超过 99 显示 99+
    const unread = c.unreadCount > 0 ? `<span class="conv-badge">${c.unreadCount > 99 ? '99+' : c.unreadCount}</span>` : '';

    return `
      <div class="conv-item ${isActive ? 'active' : ''} ${isPinned ? 'pinned' : ''}" data-conv-id="${c.id}">
        <div class="conv-avatar-wrap">
          <img class="conv-avatar" src="${avatar}" alt="avatar">
          ${unread}
        </div>
        <div class="conv-main">
          <div class="conv-row-top">
            <span class="conv-name">${escapeHtml(c.name)}</span>
            <span class="conv-time">${formatMessageTime(c.lastMessageAt)}</span>
          </div>
          <div class="conv-preview">${escapeHtml(c.lastMessagePreview || '暂无消息')}</div>
        </div>
      </div>
    `;
  }).join('');

  conversationList.querySelectorAll('.conv-item').forEach(item => {
    const convId = item.getAttribute('data-conv-id');
    item.addEventListener('click', () => openConversation(convId));
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openConvContextMenu(e, convId);
    });
  });
}

function openConvContextMenu(e, convId) {
  state.selectedConvForContext = convId;
  const conv = state.conversations.find(c => c.id === convId);
  if (!conv || !convContextMenu) return;

  const pinItem = document.getElementById('ctxPinConv');
  if (pinItem) {
    pinItem.textContent = conv.isPinned ? '📌 取消置顶' : '📌 置顶会话';
  }

  convContextMenu.style.display = 'block';
  convContextMenu.style.left = `${Math.min(e.clientX, window.innerWidth - 160)}px`;
  convContextMenu.style.top = `${Math.min(e.clientY, window.innerHeight - 100)}px`;
}

// ============================================================================
// 4. CHAT WINDOW & MESSAGING
// ============================================================================

async function openConversation(conversationId) {
  state.activeConversationId = conversationId;
  state.replyingTo = null;
  state.hasMoreEarlierMessages = true;
  hideQuoteReplyBar();
  hideEmojiPopover();

  // Mobile layout switch（已在聊天页时仅刷新标记，避免历史栈单调增长）
  if (window.innerWidth < 768) {
    chatMain.classList.add('mobile-active');
    if (history.state && history.state.inChat) {
      history.replaceState({ inChat: true }, '');
    } else {
      history.pushState({ inChat: true }, '');
    }
  }

  // Update active state in sidebar
  document.querySelectorAll('.conv-item').forEach(el => {
    el.classList.toggle('active', el.getAttribute('data-conv-id') === conversationId);
  });

  if (chatEmptyPlaceholder) chatEmptyPlaceholder.style.display = 'none';
  if (chatActiveWindow) chatActiveWindow.style.display = 'flex';

  await loadConversationDetails(conversationId);
  await loadConversationMessages(conversationId);

  // Mark as read
  api.markConversationAsRead(conversationId);
  loadConversations();
}

async function loadConversationDetails(conversationId) {
  const conv = state.conversations.find(c => c.id === conversationId);
  if (!conv) return;

  const isGroup = conv.type === 'group';
  chatHeaderAvatar.src = getSafeAvatar(conv.avatar, conv.name, isGroup);
  chatHeaderTitle.textContent = conv.name;

  if (isGroup) {
    chatHeaderLevelTag.style.display = 'none';
    chatHeaderStatus.textContent = `群聊 · ${conv.memberCount || 0}人`;
    if (btnGroupSettings) btnGroupSettings.style.display = 'inline-flex';

    // Show Group Notice if present
    if (conv.notice && conv.notice.trim()) {
      groupNoticeBanner.style.display = 'flex';
      groupNoticeText.textContent = conv.notice;
    } else {
      groupNoticeBanner.style.display = 'none';
    }

    // Load group members
    try {
      const members = await api.getConversationMembers(conversationId);
      state.activeChatMembers = members;
    } catch {}
  } else {
    if (btnGroupSettings) btnGroupSettings.style.display = 'none';
    groupNoticeBanner.style.display = 'none';
    state.activePeerUser = conv.peerUser;

    if (conv.peerUser) {
      const isSelf = conv.peerUser.id === state.currentUser?.id;
      const status = isSelf ? (state.currentUser?.status || 'online') : conv.peerUser.status;
      chatHeaderLevelTag.style.display = 'inline-flex';
      chatHeaderLevelTag.textContent = formatQQLevel(conv.peerUser.qq_level || 1);
      // 在线状态渲染为呼吸圆点（.dot-online 由 CSS 提供呼吸动画）
      chatHeaderStatus.innerHTML = status === 'online'
        ? `<span class="dot-online"></span>在线${isSelf ? ' (我的电脑/我)' : ''}`
        : '⚪ 离线';
    } else {
      chatHeaderLevelTag.style.display = 'none';
      chatHeaderStatus.textContent = 'QQ 好友';
    }
  }
}

async function loadConversationMessages(conversationId, appendNewOnly = false) {
  try {
    const messages = await api.getMessages(conversationId, 40);
    state.activeMessages = messages;
    renderMessages(messages);
    scrollToBottom();
  } catch (err) {
    console.error('Failed to load messages:', err);
  }
}

async function loadEarlierMessages() {
  if (state.isLoadingEarlierMessages || !state.hasMoreEarlierMessages || !state.activeConversationId) return;
  if (state.activeMessages.length === 0) return;

  state.isLoadingEarlierMessages = true;
  if (messagesLoadingTop) messagesLoadingTop.style.display = 'flex';

  const earliestId = state.activeMessages[0].id;
  const prevHeight = messagesContainer.scrollHeight;

  try {
    const earlier = await api.getMessages(state.activeConversationId, 30, earliestId);
    if (earlier.length === 0) {
      state.hasMoreEarlierMessages = false;
    } else {
      state.activeMessages = [...earlier, ...state.activeMessages];
      renderMessages(state.activeMessages);
      // Restore scroll position
      messagesContainer.scrollTop = messagesContainer.scrollHeight - prevHeight;
    }
  } catch (err) {
    console.error('Failed to load earlier messages:', err);
  } finally {
    state.isLoadingEarlierMessages = false;
    if (messagesLoadingTop) messagesLoadingTop.style.display = 'none';
  }
}

function renderMessages(messages) {
  if (!messagesContainer) return;

  const topLoading = messagesLoadingTop ? messagesLoadingTop.outerHTML : '';
  const html = messages.map(m => renderSingleMessageHTML(m)).join('');
  messagesContainer.innerHTML = topLoading + html;

  bindMessageBubbleEvents();
}

function renderSingleMessageHTML(msg) {
  if (msg.type === 'system' || msg.isRecalled) {
    return `
      <div class="message-row system-msg" data-id="${msg.id}">
        <div class="system-msg-bubble">${escapeHtml(msg.content)}</div>
      </div>
    `;
  }

  const isMe = msg.senderId === state.currentUser?.id;
  const senderName = msg.sender?.nickname || msg.sender?.username || '用户';
  const avatar = getSafeAvatar(msg.sender?.avatar, senderName);

  let quoteSnippet = '';
  if (msg.replyTo) {
    // 引用回复：气泡内嵌单行小玻璃片（点击跳转原消息）
    quoteSnippet = `
      <div class="quote-chip" data-parent-id="${msg.replyTo.id}">
        <span class="quote-chip-user">${escapeHtml(msg.replyTo.senderName)}:</span>
        <span class="quote-chip-text">${escapeHtml(msg.replyTo.content)}</span>
      </div>
    `;
  }

  let bodyContent = '';
  if (msg.type === 'image') {
    // 图片消息：交给 .message-image 样式（悬浮放大 + 灯箱预览）
    // src 经转义并仅放行同源上传路径，防止存储型 XSS
    const src = escapeHtml(msg.content);
    bodyContent = `<img class="message-image" src="${src}" alt="图片">`;
  } else if (msg.type === 'file') {
    // 文件消息：深色文件卡片（图标 + 文件名 + 大小）
    const href = escapeHtml(msg.content);
    bodyContent = `
      <a href="${href}" download="${escapeHtml(msg.fileName || 'file')}" class="message-file">
        <span class="file-icon">📁</span>
        <span class="file-meta">
          <span class="file-name">${escapeHtml(msg.fileName || '附件')}</span>
          ${msg.fileSize ? `<span class="file-size">${escapeHtml(String(msg.fileSize))}</span>` : ''}
        </span>
      </a>
    `;
  } else if (msg.type === 'poke') {
    bodyContent = `<span style="color: #FFB703; font-weight: 600;">👉 ${escapeHtml(msg.content)}</span>`;
  } else {
    bodyContent = formatMessageContent(msg.content);
  }

  let statusIndicator = '';
  if (isMe) {
    statusIndicator = `<span class="msg-status-indicator delivered">✓</span>`;
  }

  return `<div class="message-row ${isMe ? 'outgoing' : 'incoming'}" data-id="${msg.id}" data-client-id="${msg.clientMsgId || ''}" data-sender-id="${msg.senderId}"><img class="message-avatar" src="${avatar}" data-user-id="${msg.senderId}" alt="avatar"><div class="message-body">${!isMe ? `<div class="msg-sender-name">${escapeHtml(senderName)}</div>` : ''}<div class="bubble">${quoteSnippet}<div class="msg-content-body">${bodyContent}</div></div><div class="msg-meta-row"><span class="msg-timestamp">${formatMessageTime(msg.createdAt)}</span>${statusIndicator}</div></div></div>`;
}

function appendMessageToDOM(msg) {
  if (!messagesContainer) return;
  const tempDiv = document.createElement('div');
  tempDiv.innerHTML = renderSingleMessageHTML(msg);
  const el = tempDiv.firstElementChild;
  if (el) {
    // 液态玻璃动效：气泡弹入 + 连发涟漪（system/撤回/戳一戳消息不需要弹入动画）
    if (msg.type !== 'system' && !msg.isRecalled && msg.type !== 'poke') {
      effects.popIn(el);
      if (msg.senderId === state.currentUser?.id) effects.rippleOnSend(el);
    }
    messagesContainer.appendChild(el);
    bindSingleMessageEvents(el);
  }
}

function bindMessageBubbleEvents() {
  document.querySelectorAll('.message-row').forEach(el => bindSingleMessageEvents(el));
}

function bindSingleMessageEvents(el) {
  // 点击图片消息打开灯箱预览
  const img = el.querySelector('.message-image');
  if (img) {
    img.addEventListener('click', () => {
      if (imageLightbox && lightboxImg) {
        lightboxImg.src = img.src;
        imageLightbox.style.display = 'flex';
      }
    });
  }

  // 点击引用小玻璃片跳转到原消息
  const quoteCard = el.querySelector('.quote-chip');
  if (quoteCard) {
    quoteCard.addEventListener('click', () => {
      const pid = quoteCard.getAttribute('data-parent-id');
      const targetMsg = document.querySelector(`.message-row[data-id="${pid}"]`);
      if (targetMsg) {
        targetMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });
        targetMsg.classList.add('pulse-highlight');
        setTimeout(() => targetMsg.classList.remove('pulse-highlight'), 1500);
      }
    });
  }

  // 点击头像打开用户资料卡
  const avatars = el.querySelectorAll('.message-avatar');
  avatars.forEach(av => {
    av.addEventListener('click', () => {
      const uid = av.getAttribute('data-user-id');
      if (uid) openUserProfileCard(uid);
    });
  });

  // Right-click context menu
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const msgId = parseInt(el.getAttribute('data-id') || '0', 10);
    const senderId = el.getAttribute('data-sender-id');
    if (msgId) openMessageContextMenu(e, msgId, senderId);
  });
}

function openMessageContextMenu(e, msgId, senderId) {
  state.selectedMsgForContext = msgId;
  const isMe = senderId === state.currentUser?.id;
  const msg = state.activeMessages.find(m => m.id === msgId);

  const recallItem = document.getElementById('ctxRecallMsg');
  if (recallItem) {
    recallItem.style.display = isMe ? 'flex' : 'none';
  }

  if (msgContextMenu) {
    msgContextMenu.style.display = 'block';
    msgContextMenu.style.left = `${Math.min(e.clientX, window.innerWidth - 160)}px`;
    msgContextMenu.style.top = `${Math.min(e.clientY, window.innerHeight - 150)}px`;
  }
}

function scrollToBottom() {
  if (messagesContainer) {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }
}

// Quote Reply Handling
function setQuoteReply(msg) {
  state.replyingTo = msg;
  if (quoteReplyBar && quoteReplyUser && quoteReplySnippet) {
    quoteReplyUser.textContent = `回复 ${msg.sender?.nickname || '用户'}:`;
    quoteReplySnippet.textContent = msg.type === 'image' ? '[图片]' : (msg.content.slice(0, 30) + '...');
    quoteReplyBar.style.display = 'flex';
  }
  if (chatInput) chatInput.focus();
}

function hideQuoteReplyBar() {
  state.replyingTo = null;
  if (quoteReplyBar) quoteReplyBar.style.display = 'none';
}

function retrySendMessage(clientMsgId) {
  const payload = state.pendingMsgPayloads.get(clientMsgId);
  if (!payload) return;

  const el = document.querySelector(`[data-client-id="${clientMsgId}"] .msg-status-indicator`);
  if (el) {
    el.className = 'msg-status-indicator delivered';
    el.textContent = '...';
    el.onclick = null;
  }

  const sent = socketClient.sendMessage(
    payload.conversationId,
    payload.type,
    payload.content,
    payload.fileName,
    payload.fileSize,
    payload.replyToId,
    [],
    clientMsgId
  );

  if (!sent && el) {
    el.className = 'msg-status-indicator failed';
    el.textContent = '! 失败，点击重试';
    el.onclick = () => retrySendMessage(clientMsgId);
  }
}

// Send Message Flow
async function handleSendMessage() {
  if (!state.activeConversationId || !chatInput) return;
  const content = chatInput.value.trim();
  if (!content) return;

  const clientMsgId = `cmsg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const replyToId = state.replyingTo ? state.replyingTo.id : null;

  // Cache payload for retry
  state.pendingMsgPayloads.set(clientMsgId, {
    conversationId: state.activeConversationId,
    type: 'text',
    content,
    fileName: null,
    fileSize: null,
    replyToId
  });

  // Optimistic render
  const optimisticMsg = {
    id: `temp_${Date.now()}`,
    clientMsgId,
    conversationId: state.activeConversationId,
    senderId: state.currentUser.id,
    type: 'text',
    content,
    replyTo: state.replyingTo ? {
      id: state.replyingTo.id,
      senderName: state.replyingTo.sender?.nickname || '用户',
      content: state.replyingTo.content
    } : null,
    createdAt: new Date().toISOString(),
    sender: state.currentUser
  };

  appendMessageToDOM(optimisticMsg);
  scrollToBottom();

  chatInput.value = '';
  hideQuoteReplyBar();
  hideEmojiPopover();

  // Send via WebSocket
  const sent = socketClient.sendMessage(state.activeConversationId, 'text', content, null, null, replyToId, [], clientMsgId);
  if (!sent) {
    showToast('⚠️ 网络离线，发送失败');
    const el = document.querySelector(`[data-client-id="${clientMsgId}"] .msg-status-indicator`);
    if (el) {
      el.className = 'msg-status-indicator failed';
      el.textContent = '! 失败，点击重试';
      el.onclick = () => retrySendMessage(clientMsgId);
    }
  }
}

// ============================================================================
// 5. CONTACTS & FRIENDSHIP SUBSYSTEM
// ============================================================================

async function loadContacts() {
  try {
    const [friends, requests] = await Promise.all([
      api.getFriends(),
      api.getFriendRequests()
    ]);

    state.contacts = friends;
    state.friendRequests = requests;

    // Update New Friend Requests Badge
    const incomingPending = requests.incoming || [];
    if (badgeNewFriendReqs) {
      if (incomingPending.length > 0) {
        badgeNewFriendReqs.style.display = 'flex';
        badgeNewFriendReqs.textContent = incomingPending.length;
      } else {
        badgeNewFriendReqs.style.display = 'none';
      }
    }

    renderContactsList(friends);
  } catch (err) {
    console.error('Failed to load contacts:', err);
  }
}

function renderContactsList(friends) {
  // Separate into Special (特别关心) & Normal Friends
  const specialList = friends.filter(f => f.group_name === '特别关心');
  const normalList = friends.filter(f => f.group_name !== '特别关心');
  const groupsList = state.conversations.filter(c => c.type === 'group');

  if (countSpecial) countSpecial.textContent = specialList.length;
  if (countFriends) countFriends.textContent = normalList.length;
  if (countGroups) countGroups.textContent = groupsList.length;

  const renderFriendItem = (f) => {
    const av = getSafeAvatar(f.avatar, f.remark || f.nickname || f.username);
    const displayName = f.remark ? `${f.remark} (${f.nickname})` : f.nickname;
    const isOnline = f.status === 'online';

    return `
      <div class="contact-item" data-user-id="${f.friend_id}">
        <div class="conv-avatar-wrap">
          <img class="conv-avatar" src="${av}" alt="avatar">
          <span class="status-dot ${f.status || 'offline'}"></span>
        </div>
        <div class="contact-meta">
          <div class="contact-name-row">
            <span class="contact-name">${escapeHtml(displayName)}</span>
            <span class="qq-level-tag">${formatQQLevel(f.qq_level)}</span>
          </div>
          <div class="contact-bio">${escapeHtml(f.bio || '乐在沟通')}</div>
        </div>
      </div>
    `;
  };

  if (groupListSpecial) {
    groupListSpecial.innerHTML = specialList.length > 0
      ? specialList.map(renderFriendItem).join('')
      : `<div style="padding: 10px 16px; font-size: 11px; color: var(--text-muted);">暂无特别关心好友</div>`;
  }

  if (groupListFriends) {
    groupListFriends.innerHTML = normalList.length > 0
      ? normalList.map(renderFriendItem).join('')
      : `<div style="padding: 10px 16px; font-size: 11px; color: var(--text-muted);">暂无好友，点击上方加好友</div>`;
  }

  if (groupListGroups) {
    groupListGroups.innerHTML = groupsList.length > 0
      ? groupsList.map(g => {
        const av = getSafeAvatar(g.avatar, g.name, true);
        return `
          <div class="contact-item" data-group-conv-id="${g.id}">
            <div class="conv-avatar-wrap">
              <img class="conv-avatar" src="${av}" alt="avatar">
            </div>
            <div class="contact-meta">
              <div class="contact-name-row">
                <span class="contact-name">${escapeHtml(g.name)}</span>
              </div>
              <div class="contact-bio">群聊 · ${g.memberCount || 0}人</div>
            </div>
          </div>
        `;
      }).join('')
      : `<div style="padding: 10px 16px; font-size: 11px; color: var(--text-muted);">暂未加入群聊</div>`;
  }

  // Bind clicks
  document.querySelectorAll('.contact-item[data-user-id]').forEach(item => {
    const uid = item.getAttribute('data-user-id');
    item.addEventListener('click', () => openUserProfileCard(uid));
  });

  document.querySelectorAll('.contact-item[data-group-conv-id]').forEach(item => {
    const cid = item.getAttribute('data-group-conv-id');
    item.addEventListener('click', () => openConversation(cid));
  });

  // 分组折叠：header 点击切换 .open（默认展开特别关心与我的好友）
  // 用 onclick 赋值而非 addEventListener，重复渲染列表时天然幂等、不叠加监听
  document.querySelectorAll('.contact-group-header').forEach(h => {
    h.onclick = (e) => {
      if (e.target.closest('.contact-item')) return;   // 成员行点击不触发折叠
      h.closest('.contact-group').classList.toggle('open');
    };
  });
}

// Friend Requests Modal Handler
function openFriendRequestsModal() {
  const incoming = state.friendRequests?.incoming || [];
  if (!friendRequestsListContainer) return;

  if (incoming.length === 0) {
    friendRequestsListContainer.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); padding: 30px; font-size: 13px;">
        暂无待处理的好友申请
      </div>
    `;
  } else {
    friendRequestsListContainer.innerHTML = incoming.map(r => {
      const av = getSafeAvatar(r.avatar, r.nickname || r.username);
      return `
        <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(255, 255, 255, 0.05); padding: 10px 12px; border-radius: var(--radius-md); border: 1px solid var(--glass-border-light);">
          <div style="display: flex; align-items: center; gap: 10px;">
            <img src="${av}" style="width: 38px; height: 38px; border-radius: 50%;" alt="avatar">
            <div>
              <div style="font-size: 13.5px; font-weight: 700; color: var(--text-primary);">${escapeHtml(r.nickname)} <span style="font-size: 11px; color: #00F2FE;">${formatQQLevel(r.qq_level)}</span></div>
              <div style="font-size: 11.5px; color: var(--text-secondary); margin-top: 2px;">留言: "${escapeHtml(r.message || '加个好友呗')}"</div>
            </div>
          </div>
          <div style="display: flex; gap: 6px;">
            <button class="btn-primary btn-accept-friend" data-id="${r.id}" style="height: 28px; padding: 0 12px; font-size: 11.5px;">同意</button>
            <button class="btn-secondary btn-reject-friend" data-id="${r.id}" style="height: 28px; padding: 0 10px; font-size: 11.5px;">拒绝</button>
          </div>
        </div>
      `;
    }).join('');

    friendRequestsListContainer.querySelectorAll('.btn-accept-friend').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        try {
          await api.respondFriendRequest(id, 'accept');
          showToast('✅ 已同意好友申请，已建立会话！');
          loadContacts();
          loadConversations();
          modalFriendRequests.style.display = 'none';
        } catch (err) {
          showToast(`操作失败: ${err.message}`);
        }
      });
    });

    friendRequestsListContainer.querySelectorAll('.btn-reject-friend').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.getAttribute('data-id');
        try {
          await api.respondFriendRequest(id, 'reject');
          showToast('已拒绝好友申请');
          loadContacts();
          modalFriendRequests.style.display = 'none';
        } catch (err) {
          showToast(`操作失败: ${err.message}`);
        }
      });
    });
  }

  if (modalFriendRequests) modalFriendRequests.style.display = 'flex';
}

// ============================================================================
// 6. USER PROFILE CARD (QQ 豪华资料卡)
// ============================================================================

async function openUserProfileCard(userId) {
  try {
    const user = await api.getUserProfile(userId);
    if (!user || !modalUserProfileCard) return;

    const isSelf = user.id === state.currentUser?.id;
    const isFriend = user.is_friend;

    // Fill profile fields
    document.getElementById('userCardAvatar').src = getSafeAvatar(user.avatar, user.nickname || user.username);
    document.getElementById('userCardStatusDot').className = `status-dot ${user.status || 'offline'}`;
    document.getElementById('userCardNickname').textContent = user.nickname;
    document.getElementById('userCardStatusLabel').textContent = user.status === 'online' ? '🟢 在线' : '⚪ 离线';
    document.getElementById('userCardQQNumber').textContent = `QQ: ${user.qq_number || '100000'}`;
    document.getElementById('userCardRegDays').textContent = `常驻 ${user.reg_days || 1} 天`;
    document.getElementById('userCardBadgeLevel').textContent = `${formatQQLevel(user.qq_level)} Lv.${user.qq_level}`;
    document.getElementById('userCardBio').textContent = user.bio || '这个人很懒，什么都没写~';
    document.getElementById('userCardPostsCount').textContent = user.posts_count || 0;
    document.getElementById('userCardVisitorsCount').textContent = user.total_visitors || 0;
    document.getElementById('userCardIntimacy').textContent = user.intimacy || '0°C';

    // 亲密度温度计（0~99 映射宽度）
    const meter = document.getElementById('intimacyFill');
    if (meter) meter.style.width = Math.min(99, user.intimacy_score || 0) + '%';

    // Yellow Diamond
    const diaBadge = document.getElementById('userCardBadgeDiamond');
    if (user.qzone_yellow_diamond > 0) {
      diaBadge.style.display = 'inline-flex';
      diaBadge.textContent = `💎 空间黄钻 Lv.${user.qzone_yellow_diamond}`;
    } else {
      diaBadge.style.display = 'none';
    }

    // Action buttons
    const btnSend = document.getElementById('btnUserCardSendMessage');
    const btnAdd = document.getElementById('btnUserCardAddFriend');
    const btnZone = document.getElementById('btnUserCardOpenZone');
    const btnPoke = document.getElementById('btnUserCardPoke');

    if (isSelf) {
      btnAdd.style.display = 'none';
      btnSend.style.display = 'none';
      if (btnPoke) btnPoke.style.display = 'none';
    } else if (isFriend) {
      btnAdd.style.display = 'none';
      btnSend.style.display = 'inline-flex';
      if (btnPoke) btnPoke.style.display = 'inline-flex';
    } else {
      btnSend.style.display = 'none';
      btnAdd.style.display = 'inline-flex';
      if (btnPoke) btnPoke.style.display = 'none';
      btnAdd.textContent = user.has_sent_pending_request ? '⏳ 已发送申请' : '➕ 加为好友';
    }

    btnSend.onclick = async () => {
      modalUserProfileCard.style.display = 'none';
      const conv = await api.createDirectChat(user.id);
      openConversation(conv.id);
    };

    btnAdd.onclick = () => {
      if (user.has_sent_pending_request) {
        showToast('已向对方发送过申请，请耐心等待对方同意');
        return;
      }
      modalUserProfileCard.style.display = 'none';
      openAddFriendVerificationModal(user);
    };

    btnZone.onclick = () => {
      modalUserProfileCard.style.display = 'none';
      openDedicatedQzone(user.id);
    };

    btnPoke.onclick = () => {
      playPokeSound();
      showToast(`👉 你戳了戳 ${user.nickname}！`);
    };

    modalUserProfileCard.style.display = 'flex';
  } catch (err) {
    showToast(`无法加载资料卡: ${err.message}`);
  }
}

function openAddFriendVerificationModal(targetUser) {
  addFriendTargetAvatar.src = getSafeAvatar(targetUser.avatar, targetUser.nickname);
  addFriendTargetName.textContent = targetUser.nickname;
  addFriendTargetQQ.textContent = `QQ: ${targetUser.qq_number}`;
  addFriendMessageInput.value = `我是 ${state.currentUser?.nickname || 'QQ用户'}，想加您为好友`;

  btnConfirmSendFriendReq.onclick = async () => {
    const msg = addFriendMessageInput.value.trim();
    try {
      await api.sendFriendRequest(targetUser.id, msg);
      showToast('✅ 好友申请已发送！');
      modalAddFriendPrompt.style.display = 'none';
      loadContacts();
    } catch (err) {
      showToast(`发送失败: ${err.message}`);
    }
  };

  if (modalAddFriendPrompt) modalAddFriendPrompt.style.display = 'flex';
}

// ============================================================================
// 7. QQ ZONE (全功能空间主页)
// ============================================================================

async function openDedicatedQzone(targetUserId = null) {
  const hostId = targetUserId || state.currentUser?.id;
  state.qzoneHostId = hostId;
  try {
    const hostUser = await api.getUserProfile(hostId);
    if (!hostUser || !modalDedicatedQzone) return;

    document.getElementById('qzoneHeroAvatar').src = getSafeAvatar(hostUser.avatar, hostUser.nickname);
    document.getElementById('qzoneHeroName').textContent = `${hostUser.nickname} 的个人空间`;
    document.getElementById('qzoneTodayVisitors').textContent = hostUser.today_visitors || 0;
    document.getElementById('qzoneTotalVisitors').textContent = hostUser.total_visitors || 0;

    // Load Sub-Views
    loadQzonePostsSubView(hostId);
    loadQzonePhotosSubView(hostId);
    loadQzoneGuestbookSubView(hostId);

    // Setup about tab
    document.getElementById('qzoneAboutQQ').textContent = hostUser.qq_number || '-';
    document.getElementById('qzoneAboutLevel').textContent = `${formatQQLevel(hostUser.qq_level)} Lv.${hostUser.qq_level}`;
    document.getElementById('qzoneAboutStatus').textContent = hostUser.status === 'online' ? '在线' : '离线';

    modalDedicatedQzone.style.display = 'flex';
  } catch (err) {
    showToast(`无法加载空间: ${err.message}`);
  }
}

async function loadZonePosts() {
  try {
    const posts = await api.getZonePosts();
    state.zonePosts = posts;
    const container = document.getElementById('zonePostsContainer');
    if (container) {
      container.innerHTML = posts.map(p => renderZonePostCardHTML(p)).join('');
      bindZonePostEvents(container);
    }
  } catch (err) {
    console.error('Failed to load zone posts:', err);
  }
}

async function loadQzonePostsSubView(hostId) {
  try {
    const posts = await api.getZonePosts(hostId);
    const list = document.getElementById('qzonePostsList');
    if (list) {
      list.innerHTML = posts.map(p => renderZonePostCardHTML(p, true)).join('');
      bindZonePostEvents(list);
    }
  } catch {}
}

async function loadQzonePhotosSubView(hostId) {
  try {
    const photos = await api.getZonePhotos(hostId);
    const grid = document.getElementById('qzonePhotosGrid');
    const countSpan = document.getElementById('qzonePhotoCount');
    if (countSpan) countSpan.textContent = `共 ${photos.length} 张照片`;
    if (grid) {
      if (photos.length === 0) {
        grid.innerHTML = `<div style="color: var(--text-muted); font-size: 12px; padding: 20px;">暂无上传的照片，点击右上角上传</div>`;
      } else {
        grid.innerHTML = photos.map(ph => `
          <div class="qzone-photo-card">
            <img src="${ph.url}" alt="photo" class="qzone-photo-thumb">
          </div>
        `).join('');

        grid.querySelectorAll('.qzone-photo-thumb').forEach(img => {
          img.addEventListener('click', () => {
            if (imageLightbox && lightboxImg) {
              lightboxImg.src = img.src;
              imageLightbox.style.display = 'flex';
            }
          });
        });
      }
    }
  } catch {}
}

async function loadQzoneGuestbookSubView(hostId) {
  try {
    const msgs = await api.getGuestbookMessages(hostId);
    const list = document.getElementById('qzoneGuestbookList');
    if (list) {
      if (msgs.length === 0) {
        list.innerHTML = `<div style="color: var(--text-muted); font-size: 12px; padding: 20px;">暂无空间留言，快来留下第一条寄语吧！</div>`;
      } else {
        list.innerHTML = msgs.map(g => {
          const av = getSafeAvatar(g.author?.avatar, g.author?.nickname);
          const isAuthor = g.authorId === state.currentUser?.id;
          return `
            <div class="guestbook-card" style="background: rgba(255,255,255,0.04); border: 1px solid var(--glass-border-light); border-radius: 8px; padding: 10px 12px; margin-bottom: 8px;">
              <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
                <div style="display: flex; align-items: center; gap: 8px;">
                  <img src="${av}" style="width: 28px; height: 28px; border-radius: 50%;" alt="avatar">
                  <span style="font-size: 12.5px; font-weight: 700; color: #00F2FE;">${escapeHtml(g.author?.nickname)}</span>
                </div>
                <div style="display: flex; align-items: center; gap: 8px;">
                  <span style="font-size: 11px; color: var(--text-muted);">${formatMessageTime(g.createdAt)}</span>
                  ${isAuthor ? `<button class="btn-del-gb" data-id="${g.id}" style="background: none; border: none; color: #EF4444; font-size: 11px; cursor: pointer;">删除</button>` : ''}
                </div>
              </div>
              <div style="font-size: 13px; color: var(--text-primary);">${escapeHtml(g.content)}</div>
            </div>
          `;
        }).join('');

        list.querySelectorAll('.btn-del-gb').forEach(btn => {
          btn.addEventListener('click', async () => {
            const id = btn.getAttribute('data-id');
            await api.deleteGuestbookMessage(id);
            loadQzoneGuestbookSubView(hostId);
          });
        });
      }
    }
  } catch {}
}

function renderZonePostCardHTML(post, isSubView = false) {
  const av = getSafeAvatar(post.author?.avatar, post.author?.nickname);
  const isAuthor = post.userId === state.currentUser?.id;
  const hasLiked = post.hasLiked;

  let imgHtml = '';
  if (post.images && post.images.length > 0) {
    // 说说配图：3 列方图九宫格（样式见 .zone-post-images）
    imgHtml = `
      <div class="zone-post-images">
        ${post.images.map(img => `<img src="${img}" class="zone-card-thumb">`).join('')}
      </div>
    `;
  }

  // 评论列表：内嵌玻璃小片（.comment-chip）
  const commentsHtml = (post.comments || []).map(c => `
    <div class="comment-chip" style="display: flex; justify-content: space-between;">
      <span><strong style="color: #00F2FE;">${escapeHtml(c.author?.nickname)}:</strong> ${escapeHtml(c.content)}</span>
      ${c.userId === state.currentUser?.id ? `<button class="btn-del-comm" data-id="${c.id}" style="background: none; border: none; color: #EF4444; font-size: 10px; cursor: pointer;">删除</button>` : ''}
    </div>
  `).join('');

  return `
    <div class="zone-post-card" data-post-id="${post.id}">
      <div class="zone-post-header">
        <img src="${av}" alt="avatar" style="cursor: pointer;" data-user-id="${post.userId}">
        <div style="flex: 1;">
          <div class="zone-author-name">${escapeHtml(post.author?.nickname)}</div>
          <div class="zone-post-time">${formatMessageTime(post.createdAt)}</div>
        </div>
        ${isAuthor ? `<button class="btn-del-post" data-id="${post.id}" style="background: none; border: none; color: #EF4444; font-size: 11.5px; cursor: pointer;">删除</button>` : ''}
      </div>
      <div class="zone-post-content">${formatMessageContent(post.content)}</div>
      ${imgHtml}
      <div class="zone-post-actions" style="display: flex; gap: 14px; margin-top: 10px; font-size: 12px;">
        <button class="btn-like-post ${hasLiked ? 'liked' : ''}" data-id="${post.id}" style="background: none; border: none; cursor: pointer; display: flex; align-items: center; gap: 4px;">
          <span class="like-heart">${hasLiked ? '❤️' : '🤍'}</span> <span>${post.likesCount || 0}</span>
        </button>
      </div>
      <div class="zone-post-comments-wrap" style="margin-top: 8px; padding-top: 6px; border-top: 1px solid var(--glass-border-light);">
        ${commentsHtml}
        <div style="display: flex; gap: 6px; margin-top: 6px;">
          <input type="text" class="comm-input" placeholder="写评论..." style="flex: 1; height: 26px; border-radius: 4px; background: rgba(0,0,0,0.25); border: 1px solid var(--glass-border-light); color: white; padding: 0 8px; font-size: 11.5px;">
          <button class="btn-send-comm btn-primary" data-id="${post.id}" style="height: 26px; padding: 0 10px; font-size: 11.5px;">发送</button>
        </div>
      </div>
    </div>
  `;
}

function bindZonePostEvents(container) {
  // Thumbs lightbox
  container.querySelectorAll('.zone-card-thumb').forEach(img => {
    img.addEventListener('click', () => {
      if (imageLightbox && lightboxImg) {
        lightboxImg.src = img.src;
        imageLightbox.style.display = 'flex';
      }
    });
  });

  // Like Toggle with instant local in-place update (No page blink!)
  container.querySelectorAll('.btn-like-post').forEach(btn => {
    btn.addEventListener('click', async () => {
      const pid = btn.getAttribute('data-id');
      try {
        const res = await api.toggleLikeZonePost(pid);
        // 颜色统一由 CSS .liked 类管理（此处不再写内联 color，避免双源）
        btn.className = `btn-like-post ${res.hasLiked ? 'liked' : ''}`;
        const iconSpan = btn.querySelector('span:first-child');
        const countSpan = btn.querySelector('span:last-child');
        if (iconSpan) iconSpan.textContent = res.hasLiked ? '❤️' : '🤍';
        if (countSpan) countSpan.textContent = res.likesCount || 0;
        // 点赞心形 ❤️ 弹出动效（重启 keyframes）
        const heart = btn.querySelector('.like-heart') || btn.firstElementChild;
        if (heart) { heart.classList.remove('like-heart'); void heart.offsetWidth; heart.classList.add('like-heart'); }
      } catch (err) {
        showToast(`点赞失败: ${err.message}`);
      }
    });
  });

  // Delete Post
  container.querySelectorAll('.btn-del-post').forEach(btn => {
    btn.addEventListener('click', async () => {
      const pid = btn.getAttribute('data-id');
      try {
        await api.deleteZonePost(pid);
        showToast('已删除说说');
        loadZonePosts();
      } catch {}
    });
  });

  // Add Comment
  container.querySelectorAll('.btn-send-comm').forEach(btn => {
    btn.addEventListener('click', async () => {
      const pid = btn.getAttribute('data-id');
      const input = btn.previousElementSibling;
      const text = input ? input.value.trim() : '';
      if (!text) return;
      try {
        await api.addZoneComment(pid, text);
        input.value = '';
        loadZonePosts();
      } catch {}
    });
  });

  // Delete Comment
  container.querySelectorAll('.btn-del-comm').forEach(btn => {
    btn.addEventListener('click', async () => {
      const cid = btn.getAttribute('data-id');
      try {
        await api.deleteZoneComment(cid);
        loadZonePosts();
      } catch {}
    });
  });
}

// ============================================================================
// 8. BIND EVENT LISTENERS & UI INTERACTIONS
// ============================================================================

function showEmojiPopover() {
  if (!emojiPopover) return;
  emojiPopover.style.display = 'flex';
  if (btnEmojiToggle) btnEmojiToggle.classList.add('active');
}

function hideEmojiPopover() {
  if (!emojiPopover) return;
  emojiPopover.style.display = 'none';
  if (btnEmojiToggle) btnEmojiToggle.classList.remove('active');
}

function toggleEmojiPopover() {
  if (!emojiPopover) return;
  if (emojiPopover.style.display === 'none' || !emojiPopover.style.display) {
    showEmojiPopover();
  } else {
    hideEmojiPopover();
  }
}

function insertEmojiAtCursor(emoji) {
  if (!chatInput) return;
  const start = chatInput.selectionStart ?? chatInput.value.length;
  const end = chatInput.selectionEnd ?? chatInput.value.length;
  const text = chatInput.value;
  chatInput.value = text.slice(0, start) + emoji + text.slice(end);
  const newPos = start + emoji.length;
  chatInput.setSelectionRange(newPos, newPos);
  chatInput.focus();
}

function triggerScreenShake() {
  const container = document.getElementById('appView') || document.querySelector('.app-container') || document.body;
  container.classList.remove('window-shake');
  void container.offsetWidth; // Trigger reflow
  container.classList.add('window-shake');
  setTimeout(() => container.classList.remove('window-shake'), 600);
}

function openProfileModal() {
  if (!state.currentUser || !modalProfile) return;
  const u = state.currentUser;
  
  const av = getSafeAvatar(u.avatar, u.nickname || u.username);
  const previewAvatar = document.getElementById('profilePreviewAvatar');
  if (previewAvatar) previewAvatar.src = av;

  const urlInput = document.getElementById('profileAvatarUrlInput');
  if (urlInput) urlInput.value = u.avatar || av;

  const nickLabel = document.getElementById('profileNicknameLabel');
  if (nickLabel) nickLabel.textContent = u.nickname || u.username;

  const qqLabel = document.getElementById('profileQQLabel');
  if (qqLabel) qqLabel.textContent = `QQ: ${u.qq_number || '100000'}`;

  const levelLabel = document.getElementById('profileLevelDisplay');
  if (levelLabel) levelLabel.textContent = `${formatQQLevel(u.qq_level || 1)} 等级 Lv.${u.qq_level || 1}`;

  const nickInput = document.getElementById('profileNicknameInput');
  if (nickInput) nickInput.value = u.nickname || '';

  const bioInput = document.getElementById('profileBioInput');
  if (bioInput) bioInput.value = u.bio || '';

  const statusInput = document.getElementById('profileStatusInput');
  if (statusInput) statusInput.value = u.status || 'online';

  // Render Preset Avatars Grid
  const presetGrid = document.getElementById('presetAvatarGrid');
  if (presetGrid) {
    presetGrid.innerHTML = '';
    PRESET_AVATARS.forEach(p => {
      const isSelected = (urlInput && urlInput.value === p.svg);
      const item = document.createElement('div');
      item.className = 'preset-avatar-item';
      item.setAttribute('data-id', p.id);
      item.title = p.name;
      item.style.cssText = 'cursor: pointer; position: relative; border-radius: 50%; padding: 2px; border: 2px solid ' + (isSelected ? '#00F2FE' : 'transparent') + '; transition: transform 0.15s ease, border-color 0.15s ease; width: 44px; height: 44px; margin: auto; display: flex; align-items: center; justify-content: center;';

      const img = document.createElement('img');
      img.src = p.svg;
      img.alt = p.name;
      img.style.cssText = 'width: 100%; height: 100%; border-radius: 50%; object-fit: cover; display: block;';

      item.appendChild(img);

      item.addEventListener('click', () => {
        if (previewAvatar) previewAvatar.src = p.svg;
        if (urlInput) urlInput.value = p.svg;
        presetGrid.querySelectorAll('.preset-avatar-item').forEach(i => {
          i.style.borderColor = (i === item) ? '#00F2FE' : 'transparent';
        });
        showToast(`已选择预设头像【${p.name}】`);
      });

      presetGrid.appendChild(item);
    });
  }

  // Highlight active status in segmented control
  document.querySelectorAll('#statusPicker .status-option').forEach(opt => {
    opt.classList.toggle('active', opt.getAttribute('data-status') === (u.status || 'online'));
  });

  modalProfile.style.display = 'flex';
}

function bindEventListeners() {
  // Navigation Tabs
  if (navTabChats) navTabChats.addEventListener('click', () => switchTab('chats'));
  if (navTabContacts) navTabContacts.addEventListener('click', () => switchTab('contacts'));
  if (navTabZone) navTabZone.addEventListener('click', () => switchTab('zone'));

  // 登录/注册 Tab 切换（驱动液态指示器）
  if (tabLogin) tabLogin.addEventListener('click', () => switchAuthMode(false));
  if (tabRegister) tabRegister.addEventListener('click', () => switchAuthMode(true));

  // 登录/注册表单提交（账号密码主链路）
  if (authForm) {
    authForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const usernameEl = document.getElementById('authUsername');
      const passwordEl = document.getElementById('authPassword');
      const username = usernameEl ? usernameEl.value.trim() : '';
      const password = passwordEl ? passwordEl.value : '';
      if (!username || !password) return;
      const submitBtn = document.getElementById('authSubmitBtn');
      if (submitBtn) submitBtn.disabled = true;
      try {
        let res;
        if (state.isRegisterMode) {
          const nicknameEl = document.getElementById('authNickname');
          const bioEl = document.getElementById('authBio');
          const nickname = (nicknameEl && nicknameEl.value.trim()) || username;
          const bio = (bioEl && bioEl.value.trim()) || '';
          res = await api.register(username, password, nickname, undefined, bio);
        } else {
          res = await api.login(username, password);
        }
        state.currentUser = res.user;
        setupAppSession(res.user, res.token);
      } catch (err) {
        showToast(`${state.isRegisterMode ? '注册' : '登录'}失败: ${err.message}`);
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }
  
  const navUserProfile = document.getElementById('navUserProfile');
  if (navUserProfile) navUserProfile.addEventListener('click', openProfileModal);
  if (navAvatarImg) navAvatarImg.addEventListener('click', openProfileModal);

  // 侧边栏搜索框：按当前页签过滤会话/联系人
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.trim().toLowerCase();
      if (state.currentTab === 'contacts') {
        const friends = (state.contacts || []).filter(f => {
          const hay = `${f.remark || ''}${f.nickname || ''}${f.username || ''}`.toLowerCase();
          return !q || hay.includes(q);
        });
        renderContactsList(friends);
      } else if (!state.currentTab || state.currentTab === 'chats') {
        const convs = (state.conversations || []).filter(c => !q || (c.name || '').toLowerCase().includes(q));
        renderConversationList(convs);
      }
    });
  }

  // Custom Avatar Local Upload
  const avatarFileInput = document.getElementById('profileAvatarFileInput');
  if (avatarFileInput) {
    avatarFileInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) {
        showToast('请选择有效的图片文件 (PNG/JPG/GIF/WebP)');
        return;
      }
      if (file.size > 10 * 1024 * 1024) {
        showToast('图片文件大小不能超过 10MB');
        return;
      }
      showToast('正在上传并生成自定义头像...');
      try {
        const res = await api.uploadFile(file);
        const previewAvatar = document.getElementById('profilePreviewAvatar');
        const urlInput = document.getElementById('profileAvatarUrlInput');
        if (previewAvatar) previewAvatar.src = res.url;
        if (urlInput) urlInput.value = res.url;
        
        const presetGrid = document.getElementById('presetAvatarGrid');
        if (presetGrid) {
          presetGrid.querySelectorAll('.preset-avatar-item').forEach(i => i.style.borderColor = 'transparent');
        }
        showToast('✅ 头像上传成功！点击下方“保存修改”即可生效');
      } catch (err) {
        showToast(`上传头像失败: ${err.message}`);
      }
    });
  }

  // Random Avatar Generator Button
  const btnRandomAvatar = document.getElementById('btnRandomAvatar');
  if (btnRandomAvatar) {
    btnRandomAvatar.addEventListener('click', () => {
      const randomIdx = Math.floor(Math.random() * PRESET_AVATARS.length);
      const chosen = PRESET_AVATARS[randomIdx];
      const previewAvatar = document.getElementById('profilePreviewAvatar');
      const urlInput = document.getElementById('profileAvatarUrlInput');
      if (previewAvatar) previewAvatar.src = chosen.svg;
      if (urlInput) urlInput.value = chosen.svg;

      const presetGrid = document.getElementById('presetAvatarGrid');
      if (presetGrid) {
        presetGrid.querySelectorAll('.preset-avatar-item').forEach(i => {
          i.style.borderColor = (i.getAttribute('data-id') === chosen.id) ? '#00F2FE' : 'transparent';
        });
      }
      showToast(`🎲 随机抽中【${chosen.name}】头像`);
    });
  }

  // Mobile Sync Guide Modal with Dynamic Public/LAN Address switching
  const navMobileSyncBtn = document.getElementById('navMobileSyncBtn');
  const modalMobileSync = document.getElementById('modalMobileSync');
  const mobileQrImg = document.getElementById('mobileQrImg');
  const mobileAddressDisplay = document.getElementById('mobileAddressDisplay');
  const mobilePublicLink = document.getElementById('mobilePublicLink');
  const btnTabPublicNet = document.getElementById('btnTabPublicNet');
  const btnTabLanNet = document.getElementById('btnTabLanNet');
  const btnCopyMobileLink = document.getElementById('btnCopyMobileLink');

  let currentActiveShareUrl = location.origin;
  let serverPublicUrl = null;
  let serverLanUrl = location.origin;
  let currentActiveTabType = 'public';
  let syncModalPollTimer = null;

  async function updateMobileSyncModal(targetType = currentActiveTabType) {
    currentActiveTabType = targetType;
    try {
      const res = await fetch('/api/server/public-url').then(r => r.json()).catch(() => null);
      if (res && res.success) {
        if (res.publicUrl) serverPublicUrl = res.publicUrl;
        if (res.localUrl) serverLanUrl = res.localUrl;
      }
    } catch {}

    if (currentActiveTabType === 'public') {
      if (btnTabPublicNet) {
        btnTabPublicNet.style.background = 'var(--gradient-brand)';
        btnTabPublicNet.style.color = '#FFFFFF';
        btnTabPublicNet.style.boxShadow = 'var(--shadow-brand)';
      }
      if (btnTabLanNet) {
        btnTabLanNet.style.background = 'transparent';
        btnTabLanNet.style.color = 'var(--text-muted)';
        btnTabLanNet.style.boxShadow = 'none';
      }

      if (serverPublicUrl) {
        currentActiveShareUrl = serverPublicUrl;
        if (mobileAddressDisplay) {
          mobileAddressDisplay.innerHTML = `外网访问地址 (全国各地上网均可进): <br><a id="mobilePublicLink" href="${serverPublicUrl}" target="_blank" style="color: #00F2FE; font-size: 13.5px; font-weight: 700; word-break: break-all;">${serverPublicUrl}</a>`;
        }
      } else {
        currentActiveShareUrl = serverLanUrl;
        if (mobileAddressDisplay) {
          mobileAddressDisplay.innerHTML = `
            <div style="color: #F59E0B; font-size: 12px; margin-bottom: 6px;">⚠️ 正在连接外网隧道...</div>
            <a id="mobilePublicLink" href="${serverLanUrl}" target="_blank" style="color: #00F2FE;">${serverLanUrl}</a>
          `;
        }
      }
    } else {
      currentActiveShareUrl = serverLanUrl;
      if (btnTabLanNet) {
        btnTabLanNet.style.background = 'var(--gradient-brand)';
        btnTabLanNet.style.color = '#FFFFFF';
        btnTabLanNet.style.boxShadow = 'var(--shadow-brand)';
      }
      if (btnTabPublicNet) {
        btnTabPublicNet.style.background = 'transparent';
        btnTabPublicNet.style.color = 'var(--text-muted)';
        btnTabPublicNet.style.boxShadow = 'none';
      }
      if (mobileAddressDisplay) {
        mobileAddressDisplay.innerHTML = `局域网地址 (同一 WiFi): <br><a id="mobilePublicLink" href="${serverLanUrl}" target="_blank" style="color: #00F2FE; font-size: 13.5px; font-weight: 700; word-break: break-all;">${serverLanUrl}</a>`;
      }
    }

    if (mobileQrImg && currentActiveShareUrl) {
      // 本地零依赖二维码生成（不再依赖第三方 api.qrserver.com）
      if (window.LinkeyQR) {
        mobileQrImg.src = window.LinkeyQR.toSvgDataUrl(currentActiveShareUrl);
      }
    }
  }

  function startSyncModalPolling() {
    stopSyncModalPolling();
    updateMobileSyncModal(currentActiveTabType);
    syncModalPollTimer = setInterval(() => {
      if (modalMobileSync && modalMobileSync.style.display !== 'none') {
        updateMobileSyncModal(currentActiveTabType);
      } else {
        stopSyncModalPolling();
      }
    }, 1500);
  }

  function stopSyncModalPolling() {
    if (syncModalPollTimer) {
      clearInterval(syncModalPollTimer);
      syncModalPollTimer = null;
    }
  }

  if (btnTabPublicNet) {
    btnTabPublicNet.addEventListener('click', (e) => {
      e.stopPropagation();
      updateMobileSyncModal('public');
    });
  }
  if (btnTabLanNet) {
    btnTabLanNet.addEventListener('click', (e) => {
      e.stopPropagation();
      updateMobileSyncModal('lan');
    });
  }

  if (btnCopyMobileLink) {
    btnCopyMobileLink.addEventListener('click', () => {
      navigator.clipboard.writeText(currentActiveShareUrl).then(() => {
        showToast('📋 联机地址已复制到剪贴板，直接发给朋友即可！');
      }).catch(() => {
        showToast(`复制成功: ${currentActiveShareUrl}`);
      });
    });
  }

  if (navMobileSyncBtn && modalMobileSync) {
    navMobileSyncBtn.addEventListener('click', () => {
      modalMobileSync.style.display = 'flex';
      startSyncModalPolling();
    });
  }

  window.__openMobileSync = () => {
    if (modalMobileSync) {
      modalMobileSync.style.display = 'flex';
      startSyncModalPolling();
    }
  };

  // Profile Modal - Status Picker
  document.querySelectorAll('#statusPicker .status-option').forEach(opt => {
    opt.addEventListener('click', () => {
      document.querySelectorAll('#statusPicker .status-option').forEach(o => o.classList.remove('active'));
      opt.classList.add('active');
      const st = opt.getAttribute('data-status');
      const statusInput = document.getElementById('profileStatusInput');
      if (statusInput) statusInput.value = st;
    });
  });

  // Profile Modal - Save Profile
  const btnSaveProfile = document.getElementById('btnSaveProfile');
  if (btnSaveProfile) {
    btnSaveProfile.addEventListener('click', async () => {
      const nickInput = document.getElementById('profileNicknameInput');
      const bioInput = document.getElementById('profileBioInput');
      const statusInput = document.getElementById('profileStatusInput');
      const urlInput = document.getElementById('profileAvatarUrlInput');

      const nickname = nickInput ? nickInput.value.trim() : '';
      const bio = bioInput ? bioInput.value.trim() : '';
      const status = statusInput ? statusInput.value : 'online';
      const avatar = urlInput && urlInput.value ? urlInput.value.trim() : undefined;

      if (!nickname) {
        showToast('昵称不能为空');
        return;
      }

      try {
        const updated = await api.updateProfile({ nickname, bio, status, avatar });
        state.currentUser = updated;
        updateUserNav(updated);
        socketClient.updateStatus(status);
        showToast('🎉 个人资料与头像保存成功！');
        if (modalProfile) modalProfile.style.display = 'none';
        loadConversations();
        loadContacts();
      } catch (err) {
        showToast(`保存失败: ${err.message}`);
      }
    });
  }

  // Change Password & Delete Account Modals
  const btnOpenChangePwdModal = document.getElementById('btnOpenChangePwdModal');
  if (btnOpenChangePwdModal && modalChangePassword) {
    btnOpenChangePwdModal.addEventListener('click', () => {
      oldPasswordInput.value = '';
      newPasswordInput.value = '';
      confirmNewPasswordInput.value = '';
      if (modalProfile) modalProfile.style.display = 'none';
      modalChangePassword.style.display = 'flex';
    });
  }

  if (btnConfirmChangePassword) {
    btnConfirmChangePassword.addEventListener('click', async () => {
      const oldPwd = oldPasswordInput.value.trim();
      const newPwd = newPasswordInput.value.trim();
      const confirmPwd = confirmNewPasswordInput.value.trim();
      if (!oldPwd || !newPwd) {
        showToast('请输入原密码与新密码');
        return;
      }
      if (newPwd !== confirmPwd) {
        showToast('两次输入的新密码不一致');
        return;
      }
      if (newPwd.length < 4) {
        showToast('新密码长度不能少于 4 位');
        return;
      }
      try {
        await api.changePassword(oldPwd, newPwd);
        showToast('✅ 密码修改成功！');
        modalChangePassword.style.display = 'none';
      } catch (err) {
        showToast(`修改失败: ${err.message}`);
      }
    });
  }

  const btnOpenDeleteAccountModal = document.getElementById('btnOpenDeleteAccountModal');
  const modalDeleteAccount = document.getElementById('modalDeleteAccount');
  const deleteAccountPasswordInput = document.getElementById('deleteAccountPasswordInput');
  const btnConfirmDeleteAccount = document.getElementById('btnConfirmDeleteAccount');

  if (btnOpenDeleteAccountModal && modalDeleteAccount) {
    btnOpenDeleteAccountModal.addEventListener('click', () => {
      deleteAccountPasswordInput.value = '';
      if (modalProfile) modalProfile.style.display = 'none';
      modalDeleteAccount.style.display = 'flex';
    });
  }

  if (btnConfirmDeleteAccount) {
    btnConfirmDeleteAccount.addEventListener('click', async () => {
      const pwd = deleteAccountPasswordInput.value.trim();
      if (!pwd) {
        showToast('请输入登录密码以确认身份');
        return;
      }
      try {
        await api.deleteAccount(pwd);
        showToast('您的账号已注销');
        api.clearAuth();
        socketClient.disconnect();
        location.reload();
      } catch (err) {
        showToast(`注销失败: ${err.message}`);
      }
    });
  }

  // Mobile Tabs
  const mChats = document.getElementById('mobileTabChats');
  const mContacts = document.getElementById('mobileTabContacts');
  const mZone = document.getElementById('mobileTabZone');
  const mProfile = document.getElementById('mobileTabProfile');

  if (mChats) mChats.addEventListener('click', () => switchTab('chats'));
  if (mContacts) mContacts.addEventListener('click', () => switchTab('contacts'));
  if (mZone) mZone.addEventListener('click', () => switchTab('zone'));
  if (mProfile) mProfile.addEventListener('click', () => {
    // 移动端"我的"打开完整资料弹层：含修改密码/注销/退出登录入口
    if (state.currentUser) openProfileModal();
  });

  // Audio Toggle
  if (navMuteToggle) {
    navMuteToggle.addEventListener('click', () => {
      const muted = toggleMute();
      navMuteToggle.style.opacity = muted ? '0.4' : '1';
      showToast(muted ? '🔇 已静音提示音' : '🔔 已开启提示音');
    });
  }

  // Logout
  if (navLogoutBtn) {
    navLogoutBtn.addEventListener('click', () => {
      api.clearAuth();
      socketClient.disconnect();
      state.currentTab = 'chats';   // 重置标签，避免下次登录残留 contacts/zone 触发重复加载
      location.reload();
    });
  }

  // 资料弹层内的退出登录（移动端隐藏侧边栏后，这里是手机端唯一退出入口）
  const btnLogoutFromProfile = document.getElementById('btnLogoutFromProfile');
  if (btnLogoutFromProfile) {
    btnLogoutFromProfile.addEventListener('click', () => {
      if (modalProfile) modalProfile.style.display = 'none';
      api.clearAuth();
      socketClient.disconnect();
      state.currentTab = 'chats';
      location.reload();
    });
  }

  // Contacts Action Buttons
  if (btnOpenAddFriendModal) {
    btnOpenAddFriendModal.addEventListener('click', () => {
      if (modalDirectChat) modalDirectChat.style.display = 'flex';
    });
  }

  if (btnNewFriendRequests) {
    btnNewFriendRequests.addEventListener('click', () => {
      openFriendRequestsModal();
    });
  }

  // Direct chat user search
  if (modalUserSearchInput) {
    modalUserSearchInput.addEventListener('input', async (e) => {
      const q = e.target.value.trim();
      if (!userSearchResults) return;
      if (!q) {
        userSearchResults.innerHTML = '';
        return;
      }
      try {
        const users = await api.searchUsers(q);
        userSearchResults.innerHTML = users.map(u => {
          const av = getSafeAvatar(u.avatar, u.nickname);
          return `
            <div style="display: flex; align-items: center; justify-content: space-between; padding: 8px 10px; background: rgba(255,255,255,0.04); border-radius: 6px;">
              <div style="display: flex; align-items: center; gap: 8px;">
                <img src="${av}" style="width: 32px; height: 32px; border-radius: 50%;" alt="av">
                <div>
                  <div style="font-size: 13px; font-weight: 700; color: white;">${escapeHtml(u.nickname)}</div>
                  <div style="font-size: 11px; color: var(--text-muted);">QQ: ${escapeHtml(u.qq_number || '100000')}</div>
                </div>
              </div>
              <button class="btn-primary btn-search-add" data-id="${u.id}" style="height: 28px; padding: 0 12px; font-size: 11.5px;">加好友</button>
            </div>
          `;
        }).join('');

        userSearchResults.querySelectorAll('.btn-search-add').forEach(btn => {
          btn.addEventListener('click', () => {
            const uid = btn.getAttribute('data-id');
            const targetUser = users.find(u => u.id === uid);
            if (targetUser) {
              modalDirectChat.style.display = 'none';
              openAddFriendVerificationModal(targetUser);
            }
          });
        });
      } catch {}
    });
  }

  // Create Group Chat
  if (btnNewGroupChat) {
    btnNewGroupChat.addEventListener('click', async () => {
      if (groupMemberList) {
        const friends = await api.getFriends();
        groupMemberList.innerHTML = friends.map(f => `
          <label style="display: flex; align-items: center; gap: 8px; padding: 6px; font-size: 13px; cursor: pointer;">
            <input type="checkbox" value="${f.friend_id}" class="group-member-checkbox">
            <img src="${getSafeAvatar(f.avatar, f.nickname)}" style="width: 24px; height: 24px; border-radius: 50%;" alt="av">
            <span>${escapeHtml(f.remark || f.nickname)}</span>
          </label>
        `).join('');
      }
      if (modalGroupChat) modalGroupChat.style.display = 'flex';
    });
  }

  if (btnConfirmCreateGroup) {
    btnConfirmCreateGroup.addEventListener('click', async () => {
      const name = groupNameInput.value.trim();
      if (!name) {
        showToast('请输入群聊名称');
        return;
      }
      const checkedIds = Array.from(document.querySelectorAll('.group-member-checkbox:checked')).map(cb => cb.value);
      try {
        const conv = await api.createGroupChat(name, checkedIds, '');
        showToast('🎉 群聊创建成功！');
        modalGroupChat.style.display = 'none';
        groupNameInput.value = '';
        loadConversations();
        openConversation(conv.id);
      } catch (err) {
        showToast(`建群失败: ${err.message}`);
      }
    });
  }

  // Send Message
  if (btnSendMessage) btnSendMessage.addEventListener('click', handleSendMessage);
  if (chatInput) {
    chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        if (e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        handleSendMessage();
      }
    });

    // "正在输入"提示：输入时发送 typing:start，停止输入 2 秒后发送 typing:stop
    let typingStopTimer = null;
    let typingActive = false;
    chatInput.addEventListener('input', () => {
      if (!state.activeConversationId) return;
      if (!typingActive) {
        typingActive = true;
        socketClient.sendTypingStart(state.activeConversationId);
      }
      clearTimeout(typingStopTimer);
      typingStopTimer = setTimeout(() => {
        typingActive = false;
        socketClient.sendTypingStop(state.activeConversationId);
      }, 2000);
    });
    chatInput.addEventListener('blur', () => {
      if (typingActive) {
        typingActive = false;
        clearTimeout(typingStopTimer);
        socketClient.sendTypingStop(state.activeConversationId);
      }
    });
  }

  // Poke Buttons
  if (btnHeaderPoke) btnHeaderPoke.addEventListener('click', sendPoke);
  if (btnToolbarPoke) btnToolbarPoke.addEventListener('click', sendPoke);

  // Group Settings
  if (btnGroupSettings) {
    btnGroupSettings.addEventListener('click', () => openGroupSettingsModal());
  }

  // 群公告横幅上的快捷"编辑"按钮：直接打开群设置弹层（此前无绑定）
  if (btnEditNoticeFast) {
    btnEditNoticeFast.addEventListener('click', () => openGroupSettingsModal());
  }

  // Inline Chat Search
  if (btnSearchChatMessages) {
    btnSearchChatMessages.addEventListener('click', () => {
      if (chatMessageSearchBar) {
        chatMessageSearchBar.style.display = chatMessageSearchBar.style.display === 'none' ? 'flex' : 'none';
        if (chatSearchInput) chatSearchInput.focus();
      }
    });
  }

  if (btnCloseChatSearch) {
    btnCloseChatSearch.addEventListener('click', () => {
      if (chatMessageSearchBar) chatMessageSearchBar.style.display = 'none';
      if (chatSearchInput) chatSearchInput.value = '';
      renderMessages(state.activeMessages);
    });
  }

  if (chatSearchInput) {
    chatSearchInput.addEventListener('input', (e) => {
      const q = e.target.value.trim().toLowerCase();
      if (!q) {
        renderMessages(state.activeMessages);
        return;
      }
      const filtered = state.activeMessages.filter(m => m.content && m.content.toLowerCase().includes(q));
      renderMessages(filtered);
    });
  }

  // Infinite Scroll Trigger
  if (messagesContainer) {
    messagesContainer.addEventListener('scroll', () => {
      if (messagesContainer.scrollTop < 50 && !state.isLoadingEarlierMessages && state.hasMoreEarlierMessages) {
        loadEarlierMessages();
      }
    });
  }

  // Cancel quote reply
  if (btnCancelQuoteReply) btnCancelQuoteReply.addEventListener('click', hideQuoteReplyBar);

  // Context Menu Actions
  const ctxQuote = document.getElementById('ctxQuoteReply');
  if (ctxQuote) {
    ctxQuote.addEventListener('click', () => {
      const msg = state.activeMessages.find(m => m.id === state.selectedMsgForContext);
      if (msg) setQuoteReply(msg);
      if (msgContextMenu) msgContextMenu.style.display = 'none';
    });
  }

  const ctxRecall = document.getElementById('ctxRecallMsg');
  if (ctxRecall) {
    ctxRecall.addEventListener('click', async () => {
      if (state.selectedMsgForContext) {
        try {
          await api.recallMessage(state.selectedMsgForContext);
          showToast('已撤回消息');
        } catch (err) {
          showToast(`撤回失败: ${err.message}`);
        }
      }
      if (msgContextMenu) msgContextMenu.style.display = 'none';
    });
  }

  const ctxDel = document.getElementById('ctxDeleteMsg');
  if (ctxDel) {
    ctxDel.addEventListener('click', async () => {
      if (state.selectedMsgForContext) {
        try {
          await api.deleteMessage(state.selectedMsgForContext);
          showToast('已删除消息');
        } catch (err) {
          showToast(`删除失败: ${err.message}`);
        }
      }
      if (msgContextMenu) msgContextMenu.style.display = 'none';
    });
  }

  // 转发消息：弹出会话选择浮层，选中后原样转发（此前为无绑定的死菜单项）
  const ctxForward = document.getElementById('ctxForwardMsg');
  if (ctxForward) {
    ctxForward.addEventListener('click', () => {
      if (msgContextMenu) msgContextMenu.style.display = 'none';
      const msg = (state.activeMessages || []).find(m => m.id === state.selectedMsgForContext);
      if (!msg || msg.type === 'recalled' || msg.type === 'system') {
        showToast('该消息不支持转发');
        return;
      }
      openForwardPicker(msg);
    });
  }

  const ctxPin = document.getElementById('ctxPinConv');
  if (ctxPin) {
    ctxPin.addEventListener('click', async () => {
      if (state.selectedConvForContext) {
        const conv = state.conversations.find(c => c.id === state.selectedConvForContext);
        if (conv) {
          await api.togglePinConversation(conv.id, !conv.isPinned);
          loadConversations();
        }
      }
      if (convContextMenu) convContextMenu.style.display = 'none';
    });
  }

  const ctxClear = document.getElementById('ctxClearConv');
  if (ctxClear) {
    ctxClear.addEventListener('click', async () => {
      if (state.selectedConvForContext) {
        await api.clearConversation(state.selectedConvForContext);
        showToast('已清空聊天记录');
        loadConversations();
        if (state.activeConversationId === state.selectedConvForContext) {
          renderMessages([]);
        }
      }
      if (convContextMenu) convContextMenu.style.display = 'none';
    });
  }

  // Dismiss context menus & emoji popover on click outside
  document.addEventListener('click', (e) => {
    if (emojiPopover && emojiPopover.style.display !== 'none') {
      if (!emojiPopover.contains(e.target) && !btnEmojiToggle?.contains(e.target)) {
        hideEmojiPopover();
      }
    }
    if (msgContextMenu) msgContextMenu.style.display = 'none';
    if (convContextMenu) convContextMenu.style.display = 'none';
  });

  // Global ESC key dismiss for emoji popover
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (emojiPopover && emojiPopover.style.display !== 'none') {
        hideEmojiPopover();
        if (chatInput) chatInput.focus();
      }
    }
  });

  // Mobile Back Button（回退历史，由 popstate 统一执行关闭逻辑；
  // 锁标志防止 back() 异步窗口内双击导致多退一条历史）
  if (btnMobileBack) {
    btnMobileBack.addEventListener('click', () => {
      hideEmojiPopover();
      if (mobileBackLock) return;
      if (window.innerWidth < 768 && chatMain.classList.contains('mobile-active')) {
        mobileBackLock = true;
        history.back();
      }
    });
  }

  // 移动端历史导航：popstate 统一收口聊天面板的关闭
  // （注册于 bindEventListeners，仅执行一次，避免 setupAppSession 多次调用时重复累积监听器）
  window.addEventListener('popstate', () => {
    mobileBackLock = false;
    hideEmojiPopover();
    if (window.innerWidth < 768 && chatMain.classList.contains('mobile-active')) {
      chatMain.classList.remove('mobile-active');
      state.activeConversationId = null;
      if (chatActiveWindow) chatActiveWindow.style.display = 'none';
      if (chatEmptyPlaceholder) chatEmptyPlaceholder.style.display = 'flex';
    }
  });

  // 跨断点状态清理：窗口从移动端拉大到桌面端时，
  // 移除残留的 mobile-active 并清掉历史栈中的 inChat 标记，
  // 防止再缩回移动端时聊天面板凭空处于翻开态 / 返回键行为错位
  const mobileMQ = window.matchMedia('(max-width: 767px)');
  const onBreakpointChange = (e) => {
    hideEmojiPopover();
    if (!e.matches && chatMain.classList.contains('mobile-active')) {
      chatMain.classList.remove('mobile-active');
      if (history.state && history.state.inChat) history.replaceState({}, '');
    }
  };
  if (typeof mobileMQ.addEventListener === 'function') {
    mobileMQ.addEventListener('change', onBreakpointChange);
  } else if (typeof mobileMQ.addListener === 'function') {
    mobileMQ.addListener(onBreakpointChange);   // 旧版 Safari 兼容
  }

  // Emoji Picker Toggle & Item Click
  if (btnEmojiToggle && emojiPopover) {
    btnEmojiToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleEmojiPopover();
    });

    emojiPopover.addEventListener('click', (e) => {
      const item = e.target.closest('.emoji-item');
      if (item) {
        const emoji = item.getAttribute('data-emoji');
        insertEmojiAtCursor(emoji);
      }
    });
  }

  // Send Image & File
  if (btnSendImage && imageFileInput) {
    btnSendImage.addEventListener('click', () => {
      hideEmojiPopover();
      imageFileInput.click();
    });
    imageFileInput.addEventListener('change', async () => {
      const file = imageFileInput.files[0];
      if (!file) return;
      try {
        showToast('正在上传图片...');
        const res = await api.uploadFile(file);
        socketClient.sendMessage(state.activeConversationId, 'image', res.url, file.name, file.size);
      } catch (err) {
        showToast(`上传失败: ${err.message}`);
      } finally {
        imageFileInput.value = '';
      }
    });
  }

  if (btnSendFile && generalFileInput) {
    btnSendFile.addEventListener('click', () => {
      hideEmojiPopover();
      generalFileInput.click();
    });
    generalFileInput.addEventListener('change', async () => {
      const file = generalFileInput.files[0];
      if (!file) return;
      try {
        showToast('正在上传文件...');
        const res = await api.uploadFile(file);
        socketClient.sendMessage(state.activeConversationId, 'file', res.url, file.name, file.size);
      } catch (err) {
        showToast(`上传失败: ${err.message}`);
      } finally {
        generalFileInput.value = '';
      }
    });
  }

  // Dedicated Space Photo Upload Button
  const btnUploadAlbumPhoto = document.getElementById('btnUploadAlbumPhoto');
  const albumPhotoFileInput = document.getElementById('albumPhotoFileInput');
  if (btnUploadAlbumPhoto && albumPhotoFileInput) {
    btnUploadAlbumPhoto.addEventListener('click', () => albumPhotoFileInput.click());
    albumPhotoFileInput.addEventListener('change', async () => {
      const file = albumPhotoFileInput.files[0];
      if (!file) return;
      try {
        showToast('正在上传照片到相册...');
        const res = await api.uploadFile(file);
        await api.addPhotoToAlbum({ url: res.url, name: file.name, size: file.size });
        showToast('✅ 照片已成功保存至空间相册！');
        loadQzonePhotosSubView(state.currentUser.id);
      } catch (err) {
        showToast(`上传失败: ${err.message}`);
      } finally {
        albumPhotoFileInput.value = '';
      }
    });
  }

  // Zone Post Publishing in Sidebar Zone Pane
  const btnPublishZonePost = document.getElementById('btnPublishZonePost');
  const zoneInputText = document.getElementById('zoneInputText');
  const btnZoneSelectPhotos = document.getElementById('btnZoneSelectPhotos');
  const zonePhotoFileInput = document.getElementById('zonePhotoFileInput');
  const zonePostImagePreviews = document.getElementById('zonePostImagePreviews');
  const btnClearZoneFilter = document.getElementById('btnClearZoneFilter');

  let selectedZonePhotos = [];

  if (btnZoneSelectPhotos && zonePhotoFileInput) {
    btnZoneSelectPhotos.addEventListener('click', () => zonePhotoFileInput.click());
    zonePhotoFileInput.addEventListener('change', async () => {
      const files = Array.from(zonePhotoFileInput.files || []);
      for (const file of files) {
        try {
          showToast('正在上传配图...');
          const res = await api.uploadFile(file);
          selectedZonePhotos.push(res.url);
        } catch (err) {
          showToast(`配图上传失败: ${err.message}`);
        }
      }
      zonePhotoFileInput.value = '';
      if (zonePostImagePreviews) {
        zonePostImagePreviews.style.display = selectedZonePhotos.length > 0 ? 'flex' : 'none';
        zonePostImagePreviews.innerHTML = selectedZonePhotos.map((url, idx) => `
          <div style="position: relative; width: 60px; height: 60px;">
            <img src="${url}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 4px;" alt="preview">
            <span class="btn-remove-preview" data-idx="${idx}" style="position: absolute; top: -4px; right: -4px; background: rgba(0,0,0,0.7); color: white; border-radius: 50%; width: 16px; height: 16px; font-size: 11px; display: flex; align-items: center; justify-content: center; cursor: pointer;">✕</span>
          </div>
        `).join('');
        zonePostImagePreviews.querySelectorAll('.btn-remove-preview').forEach(btn => {
          btn.addEventListener('click', () => {
            const idx = parseInt(btn.getAttribute('data-idx'));
            selectedZonePhotos.splice(idx, 1);
            btn.parentElement.remove();
            if (selectedZonePhotos.length === 0) zonePostImagePreviews.style.display = 'none';
          });
        });
      }
    });
  }

  if (btnPublishZonePost) {
    btnPublishZonePost.addEventListener('click', async () => {
      const content = zoneInputText ? zoneInputText.value.trim() : '';
      if (!content && selectedZonePhotos.length === 0) {
        showToast('请输入说说内容或选择配图');
        return;
      }
      try {
        await api.createZonePost(content, selectedZonePhotos);
        showToast('🎉 说说发表成功！');
        if (zoneInputText) zoneInputText.value = '';
        selectedZonePhotos = [];
        if (zonePostImagePreviews) {
          zonePostImagePreviews.innerHTML = '';
          zonePostImagePreviews.style.display = 'none';
        }
        loadZonePosts();
      } catch (err) {
        showToast(`发表失败: ${err.message}`);
      }
    });
  }

  if (btnClearZoneFilter) {
    btnClearZoneFilter.addEventListener('click', () => {
      const filterHeader = document.getElementById('zoneFilterHeader');
      if (filterHeader) filterHeader.style.display = 'none';
      loadZonePosts();
    });
  }

  // ===== 专属空间弹层内的说说发布 / 配图 / 留言板提交（此前无绑定） =====
  const btnPublishQzonePost = document.getElementById('btnPublishQzonePost');
  const qzoneInputText = document.getElementById('qzoneInputText');
  const btnQzoneSelectPhotos = document.getElementById('btnQzoneSelectPhotos');
  const qzonePostPhotoInput = document.getElementById('qzonePostPhotoInput');
  const qzonePostImagePreviews = document.getElementById('qzonePostImagePreviews');
  const btnPublishGuestbook = document.getElementById('btnPublishGuestbook');
  const qzoneGuestbookInput = document.getElementById('qzoneGuestbookInput');

  let selectedQzonePhotos = [];

  const renderQzonePhotoPreviews = () => {
    if (!qzonePostImagePreviews) return;
    qzonePostImagePreviews.style.display = selectedQzonePhotos.length > 0 ? 'flex' : 'none';
    qzonePostImagePreviews.innerHTML = selectedQzonePhotos.map((url, idx) => `
      <div style="position: relative; width: 60px; height: 60px;">
        <img src="${url}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 4px;" alt="preview">
        <span class="btn-remove-preview" data-idx="${idx}" style="position: absolute; top: -4px; right: -4px; background: rgba(0,0,0,0.7); color: white; border-radius: 50%; width: 16px; height: 16px; font-size: 11px; display: flex; align-items: center; justify-content: center; cursor: pointer;">✕</span>
      </div>
    `).join('');
    qzonePostImagePreviews.querySelectorAll('.btn-remove-preview').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-idx'));
        selectedQzonePhotos.splice(idx, 1);
        renderQzonePhotoPreviews();
      });
    });
  };

  if (btnQzoneSelectPhotos && qzonePostPhotoInput) {
    btnQzoneSelectPhotos.addEventListener('click', () => qzonePostPhotoInput.click());
    qzonePostPhotoInput.addEventListener('change', async () => {
      const files = Array.from(qzonePostPhotoInput.files || []);
      for (const file of files) {
        try {
          showToast('正在上传配图...');
          const res = await api.uploadFile(file);
          selectedQzonePhotos.push(res.url);
        } catch (err) {
          showToast(`配图上传失败: ${err.message}`);
        }
      }
      qzonePostPhotoInput.value = '';
      renderQzonePhotoPreviews();
    });
  }

  if (btnPublishQzonePost) {
    btnPublishQzonePost.addEventListener('click', async () => {
      const content = qzoneInputText ? qzoneInputText.value.trim() : '';
      if (!content && selectedQzonePhotos.length === 0) {
        showToast('请输入说说内容或选择配图');
        return;
      }
      try {
        await api.createZonePost(content, selectedQzonePhotos);
        showToast('🎉 说说发表成功！');
        if (qzoneInputText) qzoneInputText.value = '';
        selectedQzonePhotos = [];
        renderQzonePhotoPreviews();
        loadQzonePostsSubView(state.qzoneHostId || state.currentUser?.id);
        loadZonePosts();
      } catch (err) {
        showToast(`发表失败: ${err.message}`);
      }
    });
  }

  if (btnPublishGuestbook) {
    btnPublishGuestbook.addEventListener('click', async () => {
      const content = qzoneGuestbookInput ? qzoneGuestbookInput.value.trim() : '';
      if (!content) {
        showToast('请输入留言内容');
        return;
      }
      try {
        await api.addGuestbookMessage(state.qzoneHostId || state.currentUser?.id, content);
        showToast('💬 留言提交成功！');
        if (qzoneGuestbookInput) qzoneGuestbookInput.value = '';
        loadQzoneGuestbookSubView(state.qzoneHostId || state.currentUser?.id);
      } catch (err) {
        showToast(`留言失败: ${err.message}`);
      }
    });
  }

  // Direct chat new conversation button in sidebar
  if (btnNewDirectChat) {
    btnNewDirectChat.addEventListener('click', () => {
      if (modalDirectChat) modalDirectChat.style.display = 'flex';
      if (modalUserSearchInput) modalUserSearchInput.focus();
    });
  }

  // 联系人分组折叠交互已迁移至 renderContactsList（.contact-group + .open 机制）


  // Space Sub Tabs Switcher
  document.querySelectorAll('.qzone-sub-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.qzone-sub-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const tabName = tab.getAttribute('data-tab');
      document.querySelectorAll('.qzone-view-section').forEach(s => s.style.display = 'none');
      if (tabName === 'posts') document.getElementById('qzoneViewPosts').style.display = 'block';
      else if (tabName === 'photos') document.getElementById('qzoneViewPhotos').style.display = 'block';
      else if (tabName === 'guestbook') document.getElementById('qzoneViewGuestbook').style.display = 'block';
      else if (tabName === 'about') document.getElementById('qzoneViewAbout').style.display = 'block';
    });
  });

  // Modal Close Buttons
  document.querySelectorAll('.close-modal').forEach(btn => {
    btn.addEventListener('click', () => {
      const modal = btn.closest('.modal-overlay');
      if (modal) modal.style.display = 'none';
    });
  });

  // Modal Overlay click outside to close
  document.querySelectorAll('.modal-overlay').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.style.display = 'none';
      }
    });
  });

  // Lightbox Close
  if (lightboxClose && imageLightbox) {
    lightboxClose.addEventListener('click', () => {
      imageLightbox.style.display = 'none';
    });
  }
}

function switchTab(tab) {
  state.currentTab = tab;
  hideEmojiPopover();

  // 导航液态指示器跟随：定位到当前激活的导航按钮
  const navIndicator = document.querySelector('.nav-liquid-indicator');
  const navWrap = document.querySelector('.nav-links');
  const tabBtnMap = { chats: 'navTabChats', contacts: 'navTabContacts', zone: 'navTabZone' };
  const btnId = tabBtnMap[tab];
  if (navIndicator && btnId) {
    const btn = document.getElementById(btnId);
    if (navWrap) navWrap.classList.add('ready');
    effects.moveIndicator(navIndicator, btn);
  }

  document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.mobile-tab-btn').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.sidebar-view-pane').forEach(el => el.classList.remove('active'));

  if (tab === 'chats') {
    if (navTabChats) navTabChats.classList.add('active');
    const m = document.getElementById('mobileTabChats');
    if (m) m.classList.add('active');
    if (sidebarChatsPane) sidebarChatsPane.classList.add('active');
    if (sidebarTitleText) sidebarTitleText.textContent = '消息';
  } else if (tab === 'contacts') {
    if (navTabContacts) navTabContacts.classList.add('active');
    const m = document.getElementById('mobileTabContacts');
    if (m) m.classList.add('active');
    if (sidebarContactsPane) sidebarContactsPane.classList.add('active');
    if (sidebarTitleText) sidebarTitleText.textContent = '联系人';
    loadContacts();
  } else if (tab === 'zone') {
    if (navTabZone) navTabZone.classList.add('active');
    const m = document.getElementById('mobileTabZone');
    if (m) m.classList.add('active');
    if (sidebarZonePane) sidebarZonePane.classList.add('active');
    if (sidebarTitleText) sidebarTitleText.textContent = '空间动态';
    loadZonePosts();
  }
}

function sendPoke() {
  hideEmojiPopover();
  if (!state.activeConversationId) return;
  socketClient.sendMessage(state.activeConversationId, 'poke', '戳了戳对方');
  playPokeSound();
  triggerScreenShake();
  showToast('👉 戳了戳对方');
}

// 转发选择器：动态浮层列出全部会话
function openForwardPicker(msg) {
  let picker = document.getElementById('forwardPickerOverlay');
  if (picker) picker.remove();

  const convs = (state.conversations || []).filter(c => c.id !== state.activeConversationId);
  picker = document.createElement('div');
  picker.id = 'forwardPickerOverlay';
  picker.style.cssText = 'position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 10000; display: flex; align-items: center; justify-content: center;';
  picker.innerHTML = `
    <div style="width: min(360px, 90vw); max-height: 70vh; background: #161d2c; border: 1px solid var(--glass-border, rgba(255,255,255,0.12)); border-radius: 14px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 20px 60px rgba(0,0,0,0.5);">
      <div style="padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,0.08); font-size: 14px; font-weight: 700; color: #fff;">转发到</div>
      <div id="forwardPickerList" style="flex: 1; overflow-y: auto; padding: 8px;">
        ${convs.length === 0 ? '<div style="padding: 24px; text-align: center; color: var(--text-muted, #8a94a8); font-size: 13px;">暂无其他会话</div>' : convs.map(c => `
          <div class="forward-target" data-conv-id="${c.id}" style="display: flex; align-items: center; gap: 10px; padding: 10px; border-radius: 8px; cursor: pointer;">
            <img src="${getSafeAvatar(c.avatar, c.name, c.type === 'group')}" style="width: 34px; height: 34px; border-radius: 50%;" alt="av">
            <span style="font-size: 13.5px; color: #fff;">${escapeHtml(c.name)}</span>
          </div>
        `).join('')}
      </div>
      <div style="padding: 10px 16px; border-top: 1px solid rgba(255,255,255,0.08); text-align: right;">
        <button id="btnForwardCancel" style="background: none; border: none; color: var(--text-muted, #8a94a8); font-size: 13px; cursor: pointer; padding: 6px 12px;">取消</button>
      </div>
    </div>
  `;
  document.body.appendChild(picker);

  picker.addEventListener('click', async (e) => {
    if (e.target === picker || e.target.id === 'btnForwardCancel') {
      picker.remove();
      return;
    }
    const item = e.target.closest('.forward-target');
    if (!item) return;
    const targetConvId = item.getAttribute('data-conv-id');
    try {
      const sent = socketClient.sendMessage(targetConvId, msg.type, msg.content, msg.fileName || null, msg.fileSize || null);
      if (sent) {
        showToast('✅ 转发成功');
      } else {
        showToast('转发失败: 连接未就绪');
      }
    } catch (err) {
      showToast(`转发失败: ${err.message}`);
    }
    picker.remove();
  });
}

async function openGroupSettingsModal() {
  const conv = state.conversations.find(c => c.id === state.activeConversationId);
  if (!conv || !modalGroupSettings) return;

  groupSettingsNameInput.value = conv.rawName || conv.name;
  groupSettingsNoticeInput.value = conv.notice || '';

  const members = await api.getConversationMembers(conv.id);
  groupSettingsMemberCount.textContent = members.length;

  const isOwner = conv.role === 'owner';
  btnSaveGroupNotice.onclick = async () => {
    const newName = groupSettingsNameInput.value.trim();
    const newNotice = groupSettingsNoticeInput.value.trim();
    try {
      await api.updateGroupInfo(conv.id, { name: newName, notice: newNotice });
      showToast('✅ 群设置已保存！');
      loadConversations();
      loadConversationDetails(conv.id);
    } catch (err) {
      showToast(`保存失败: ${err.message}`);
    }
  };

  groupSettingsMemberList.innerHTML = members.map(m => {
    const av = getSafeAvatar(m.avatar, m.nickname);
    const roleBadge = m.role === 'owner' ? '👑 群主' : (m.role === 'admin' ? '🛡️ 管理员' : '群员');
    const canManage = isOwner && m.id !== state.currentUser.id;

    return `
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 6px 8px; background: rgba(255,255,255,0.03); border-radius: 6px;">
        <div style="display: flex; align-items: center; gap: 8px;">
          <img src="${av}" style="width: 28px; height: 28px; border-radius: 50%;" alt="av">
          <span style="font-size: 13px; font-weight: 600; color: white;">${escapeHtml(m.nickname)}</span>
          <span style="font-size: 10px; color: ${m.role === 'owner' ? '#FFB703' : '#00F2FE'}; background: rgba(255,255,255,0.06); padding: 1px 5px; border-radius: 3px;">${roleBadge}</span>
        </div>
        ${canManage ? `
          <div style="display: flex; gap: 4px;">
            <button class="btn-kick-member" data-id="${m.id}" style="background: rgba(239,68,68,0.15); border: 1px solid rgba(239,68,68,0.3); color: #EF4444; border-radius: 4px; padding: 2px 6px; font-size: 10.5px; cursor: pointer;">踢出</button>
          </div>
        ` : ''}
      </div>
    `;
  }).join('');

  groupSettingsMemberList.querySelectorAll('.btn-kick-member').forEach(btn => {
    btn.addEventListener('click', async () => {
      const uid = btn.getAttribute('data-id');
      try {
        await api.kickGroupMember(conv.id, uid);
        showToast('已将成员移出群聊');
        openGroupSettingsModal();
      } catch (err) {
        showToast(`操作失败: ${err.message}`);
      }
    });
  });

  btnLeaveGroup.onclick = async () => {
    if (confirm('确定要退出该群聊吗？')) {
      try {
        await api.leaveGroup(conv.id);
        showToast('已退出群聊');
        modalGroupSettings.style.display = 'none';
        chatActiveWindow.style.display = 'none';
        chatEmptyPlaceholder.style.display = 'flex';
        state.activeConversationId = null;
        loadConversations();
      } catch (err) {
        showToast(`退出失败: ${err.message}`);
      }
    }
  };

  modalGroupSettings.style.display = 'flex';
}

// 登录页指示器初始定位
(function initAuthIndicator() {
  // module 脚本执行时 DOM 已解析完成且 authView 默认可见，此时定位有效
  const activeTab = document.querySelector('.auth-tab.active');
  if (activeTab) positionAuthIndicator(activeTab);
})();

// Expose helpers to window for immediate inline onclick triggers
window.__openProfileModal = openProfileModal;
window.__getSafeAvatar = getSafeAvatar;

// Start app on DOMContentLoaded or immediately if already loaded
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initApp();
  });
} else {
  initApp();
}
