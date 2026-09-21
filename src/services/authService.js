import crypto from 'node:crypto';
import { run, get, all } from '../db/database.js';

const JWT_SECRET = process.env.JWT_SECRET || 'cross-platform-im-secret-key-2026';
const TOKEN_EXPIRY_SECONDS = 30 * 24 * 60 * 60; // 30 days

/**
 * Hash password using scrypt
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return `${salt}:${derivedKey.toString('hex')}`;
}

/**
 * Verify password against stored hash
 */
export function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, key] = storedHash.split(':');
  const derivedKey = crypto.scryptSync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(key, 'hex'), derivedKey);
}

/**
 * Base64URL encoding/decoding helper
 */
function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

/**
 * Create a JWT Token
 */
export function createToken(payload, secret = JWT_SECRET, expiresIn = TOKEN_EXPIRY_SECONDS) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const exp = Math.floor(Date.now() / 1000) + expiresIn;
  const fullPayload = { ...payload, exp };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(fullPayload));

  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

/**
 * Verify and decode JWT token
 */
export function verifyToken(token, secret = JWT_SECRET) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, signature] = parts;
  const expectedSig = crypto
    .createHmac('sha256', secret)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

  if (signature !== expectedSig) return null;

  try {
    const payload = JSON.parse(base64UrlDecode(encodedPayload));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Generate 6-digit random QQ number
 */
function generateQQNumber() {
  const randomNum = Math.floor(100000 + Math.random() * 900000);
  return String(randomNum);
}

/**
 * Sanitize user object to remove sensitive data
 */
export function sanitizeUser(user) {
  if (!user) return null;
  const { password_hash, ...safeUser } = user;
  return safeUser;
}

/**
 * Generate 100% Local Self-Contained SVG Avatar (Zero External Dependency)
 */
export function generateLocalAvatar(seed = 'user', isGroup = false) {
  const colors = [
    ['#00C6FF', '#0072FF'],
    ['#F355A0', '#FF758C'],
    ['#10B981', '#059669'],
    ['#8B5CF6', '#6D28D9'],
    ['#F59E0B', '#D97706'],
    ['#00F2FE', '#4FACFE'],
    ['#EC4899', '#BE185D']
  ];
  let hash = 0;
  const str = String(seed || 'user');
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  const colorPair = colors[Math.abs(hash) % colors.length];
  const initial = (str.trim().charAt(0) || 'Q').toUpperCase();

  if (isGroup) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${colorPair[0]}"/><stop offset="100%" stop-color="${colorPair[1]}"/></linearGradient></defs><rect width="100" height="100" rx="50" fill="url(#g)"/><text x="50" y="58" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="44" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle">👥</text></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  if (str.toLowerCase().includes('helper') || str.toLowerCase().includes('penguin') || str.includes('管家')) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#00C6FF"/><stop offset="100%" stop-color="#0072FF"/></linearGradient></defs><rect width="100" height="100" rx="50" fill="url(#g)"/><text x="50" y="58" font-family="-apple-system,BlinkMacSystemFont,sans-serif" font-size="52" fill="white" text-anchor="middle" dominant-baseline="middle">🐧</text></svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${colorPair[0]}"/><stop offset="100%" stop-color="${colorPair[1]}"/></linearGradient></defs><rect width="100" height="100" rx="50" fill="url(#g)"/><text x="50" y="58" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif" font-size="46" font-weight="700" fill="white" text-anchor="middle" dominant-baseline="middle">${initial}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * Register a new user
 */
export function register({ username, password, nickname, avatar = '', bio = '' }) {
  if (!username || !password || !nickname) {
    throw new Error('用户名、密码和昵称不能为空');
  }

  username = username.trim().toLowerCase();
  nickname = nickname.trim();

  if (username.length < 2 || username.length > 30) {
    throw new Error('用户名长度须在 2-30 字符之间');
  }
  if (password.length < 4) {
    throw new Error('密码长度至少 4 位');
  }

  const existing = get('SELECT id FROM users WHERE username = ?', [username]);
  if (existing) {
    throw new Error('该用户名已被注册，请换一个用户名，或直接用该账号登录');
  }

  const userId = 'u_' + crypto.randomUUID().replace(/-/g, '');
  const passwordHash = hashPassword(password);
  const defaultAvatar = avatar || generateLocalAvatar(nickname || username);
  const qqNumber = generateQQNumber();
  const qqLevel = Math.floor(12 + Math.random() * 20); // Level 12-32

  run(
    'INSERT INTO users (id, username, password_hash, nickname, avatar, bio, qq_number, qq_level, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, username, passwordHash, nickname, defaultAvatar, bio, qqNumber, qqLevel, 'offline']
  );

  const user = get('SELECT * FROM users WHERE id = ?', [userId]);
  const safeUser = sanitizeUser(user);
  const token = createToken({ userId: safeUser.id, username: safeUser.username });

  return { user: safeUser, token };
}

/**
 * Login user with username and password
 */
export function login({ username, password }) {
  if (!username || !password) {
    throw new Error('请输入用户名和密码');
  }

  username = username.trim().toLowerCase();
  const user = get('SELECT * FROM users WHERE username = ? OR qq_number = ?', [username, username]);
  if (!user) {
    throw new Error('用户名或密码错误');
  }

  const isValid = verifyPassword(password, user.password_hash);
  if (!isValid) {
    throw new Error('用户名或密码错误');
  }

  run("UPDATE users SET last_seen = datetime('now') WHERE id = ?", [user.id]);

  const safeUser = sanitizeUser(user);
  const token = createToken({ userId: safeUser.id, username: safeUser.username });

  return { user: safeUser, token };
}

/**
 * Fast One-Click Login for Demo Accounts
 */
export function quickLogin(username) {
  const user = get('SELECT * FROM users WHERE username = ?', [username.toLowerCase()]);
  if (!user) throw new Error('预置用户不存在');

  const safeUser = sanitizeUser(user);
  const token = createToken({ userId: safeUser.id, username: safeUser.username });
  return { user: safeUser, token };
}

/**
 * Get preset quick login user profiles
 */
export function getQuickUsers() {
  const users = all('SELECT id, username, nickname, avatar, bio, qq_number, qq_level FROM users ORDER BY qq_number ASC LIMIT 6');
  return users;
}

/**
 * Get user profile by ID with 100% genuine data-driven stats
 */
export function getUserById(userId, viewerUserId = null) {
  return getUserFullStats(userId, viewerUserId);
}

/**
 * Compute and retrieve 100% REAL data-driven stats for a user
 */
export function getUserFullStats(targetUserId, viewerUserId = null) {
  const user = get('SELECT * FROM users WHERE id = ?', [targetUserId]);
  if (!user) return null;

  // 1. Record real visitor if viewing someone else
  if (viewerUserId && viewerUserId !== targetUserId) {
    try {
      run('INSERT INTO zone_visitors (host_id, visitor_id) VALUES (?, ?)', [targetUserId, viewerUserId]);
    } catch {}
  }

  // 2. Real Registration Days
  const regRow = get(`SELECT CAST((julianday('now') - julianday(created_at)) AS INTEGER) + 1 as reg_days FROM users WHERE id = ?`, [targetUserId]);
  const regDays = regRow ? Math.max(1, regRow.reg_days) : 1;

  // 3. Real Sent Messages Count
  const msgRow = get('SELECT COUNT(*) as msg_count FROM messages WHERE sender_id = ?', [targetUserId]);
  const msgCount = msgRow ? msgRow.msg_count : 0;

  // 4. Real Zone Posts Count
  const postRow = get('SELECT COUNT(*) as posts_count FROM zone_posts WHERE user_id = ?', [targetUserId]);
  const postsCount = postRow ? postRow.posts_count : 0;

  // 5. Real Comments & Guestbook Messages Count
  const commRow = get('SELECT COUNT(*) as count FROM zone_comments WHERE user_id = ?', [targetUserId]);
  const guestRow = get('SELECT COUNT(*) as count FROM zone_guestbook WHERE author_id = ?', [targetUserId]);
  const commentsCount = (commRow ? commRow.count : 0) + (guestRow ? guestRow.count : 0);

  // 6. Real Received Likes
  const likeRow = get('SELECT COALESCE(SUM(likes_count), 0) as total_likes FROM zone_posts WHERE user_id = ?', [targetUserId]);
  const receivedLikes = likeRow ? likeRow.total_likes : 0;

  // 7. REAL QQ Level (Genuine calculation from active days & actions)
  // EXP = (regDays * 4) + (msgCount * 2) + (postsCount * 5) + (receivedLikes * 3) + (commentsCount * 2)
  const exp = (regDays * 4) + (msgCount * 2) + (postsCount * 5) + (receivedLikes * 3) + (commentsCount * 2);
  let realLevel = 1;
  if (exp > 5) {
    realLevel = Math.min(100, Math.max(1, Math.floor(Math.sqrt(exp / 2))));
  }
  // Sync real level to DB
  run('UPDATE users SET qq_level = ? WHERE id = ?', [realLevel, targetUserId]);

  // 8. REAL Qzone Yellow Diamond (黄钻等级)
  let realYellowDiamond = 0;
  if (postsCount >= 10) realYellowDiamond = Math.min(8, 3 + Math.floor(postsCount / 5));
  else if (postsCount >= 6) realYellowDiamond = 3;
  else if (postsCount >= 3) realYellowDiamond = 2;
  else if (postsCount >= 1) realYellowDiamond = 1;
  run('UPDATE users SET qzone_yellow_diamond = ? WHERE id = ?', [realYellowDiamond, targetUserId]);

  // 9. REAL Visitor Counts
  const totalVisitorsRow = get('SELECT COUNT(DISTINCT visitor_id) as total_visitors FROM zone_visitors WHERE host_id = ?', [targetUserId]);
  const totalVisitors = totalVisitorsRow ? totalVisitorsRow.total_visitors : 0;

  const todayVisitorsRow = get(`SELECT COUNT(DISTINCT visitor_id) as today_visitors FROM zone_visitors WHERE host_id = ? AND date(visited_at) = date('now')`, [targetUserId]);
  const todayVisitors = todayVisitorsRow ? todayVisitorsRow.today_visitors : 0;

  // 10. REAL Intimacy & Friendship Badge between viewer and target
  let intimacy = '0°C';
  let intimacyScore = 0;
  let intimacyLabel = '初次相识';
  let friendshipBadge = null;

  if (viewerUserId && viewerUserId === targetUserId) {
    intimacy = '100°C';
    intimacyScore = 100;
    intimacyLabel = '本人账号';
  } else if (viewerUserId) {
    // Check direct messages exchanged between viewer and target
    const directMsgsRow = get(`
      SELECT COUNT(*) as count FROM messages m
      WHERE conversation_id IN (
        SELECT cm1.conversation_id FROM conversation_members cm1
        JOIN conversation_members cm2 ON cm1.conversation_id = cm2.conversation_id
        JOIN conversations c ON cm1.conversation_id = c.id
        WHERE cm1.user_id = ? AND cm2.user_id = ? AND c.type = 'direct'
      )
    `, [viewerUserId, targetUserId]);
    const directMsgs = directMsgsRow ? directMsgsRow.count : 0;

    // Social interactions on zone
    const socialRow = get(`
      SELECT (
        (SELECT COUNT(*) FROM zone_comments c JOIN zone_posts p ON c.post_id = p.id WHERE (c.user_id = ? AND p.user_id = ?) OR (c.user_id = ? AND p.user_id = ?))
        +
        (SELECT COUNT(*) FROM zone_guestbook WHERE (author_id = ? AND host_id = ?) OR (author_id = ? AND host_id = ?))
      ) as count
    `, [viewerUserId, targetUserId, targetUserId, viewerUserId, viewerUserId, targetUserId, targetUserId, viewerUserId]);
    const socialInteractions = socialRow ? socialRow.count : 0;

    // Visitors count from viewer to target
    const visitCountRow = get('SELECT COUNT(*) as count FROM zone_visitors WHERE host_id = ? AND visitor_id = ?', [targetUserId, viewerUserId]);
    const visitsFromViewer = visitCountRow ? visitCountRow.count : 0;

    intimacyScore = (directMsgs * 4) + (socialInteractions * 8) + (visitsFromViewer * 2);
    if (intimacyScore === 0) {
      intimacy = '0°C';
      intimacyLabel = '初次相识';
    } else {
      const deg = Math.min(99, intimacyScore);
      intimacy = `${deg}°C`;
      if (deg >= 60) intimacyLabel = '亲密挚友';
      else if (deg >= 30) intimacyLabel = '无话不谈';
      else intimacyLabel = '逐渐熟络';
    }

    if (directMsgs >= 30) {
      friendshipBadge = '🔥 巨轮好友';
    } else if (directMsgs >= 8) {
      friendshipBadge = '🔥 聊翻天';
    } else if (directMsgs >= 1) {
      friendshipBadge = '💬 正在交流';
    } else {
      friendshipBadge = '🌱 刚刚结识';
    }
  }

  // Real friendship relationship state
  let isFriend = false;
  let friendRemark = '';
  let hasSentPendingRequest = false;
  let hasIncomingPendingRequest = false;
  let incomingRequestId = null;

  if (viewerUserId && viewerUserId !== targetUserId) {
    const fr = get('SELECT * FROM friends WHERE user_id = ? AND friend_id = ?', [viewerUserId, targetUserId]);
    isFriend = !!fr;
    if (fr) friendRemark = fr.remark || '';

    const pendingReq = get('SELECT id FROM friend_requests WHERE from_user_id = ? AND to_user_id = ? AND status = "pending"', [viewerUserId, targetUserId]);
    hasSentPendingRequest = !!pendingReq;

    const incomingReq = get('SELECT id FROM friend_requests WHERE from_user_id = ? AND to_user_id = ? AND status = "pending"', [targetUserId, viewerUserId]);
    hasIncomingPendingRequest = !!incomingReq;
    if (incomingReq) incomingRequestId = incomingReq.id;
  }

  // Real music badge (check if user shared audio file or level >= 12)
  const musicRow = get(`SELECT COUNT(*) as count FROM messages WHERE sender_id = ? AND (file_name LIKE '%.mp3' OR file_name LIKE '%.wav' OR file_name LIKE '%.flac' OR file_name LIKE '%.m4a')`, [targetUserId]);
  const hasMusic = (musicRow && musicRow.count > 0) || realLevel >= 12;

  // Real personality tags
  let tags = [];
  try {
    if (user.tags) tags = typeof user.tags === 'string' ? JSON.parse(user.tags) : user.tags;
  } catch {}
  if (!tags || tags.length === 0) {
    tags = ['🚀 极速常驻', '✨ 乐在沟通'];
    if (postsCount > 0) tags.push('📸 空间达人');
    if (msgCount > 20) tags.push('💬 健谈活跃');
  }

  return {
    ...sanitizeUser(user),
    qq_level: realLevel,
    qzone_yellow_diamond: realYellowDiamond,
    reg_days: regDays,
    msg_count: msgCount,
    posts_count: postsCount,
    received_likes: receivedLikes,
    total_visitors: totalVisitors,
    today_visitors: todayVisitors,
    intimacy: intimacy,
    intimacy_score: intimacyScore,
    intimacy_label: intimacyLabel,
    friendship_badge: friendshipBadge,
    has_music_badge: hasMusic,
    is_friend: isFriend,
    friend_remark: friendRemark,
    has_sent_pending_request: hasSentPendingRequest,
    has_incoming_pending_request: hasIncomingPendingRequest,
    incoming_request_id: incomingRequestId,
    tags: tags
  };
}

/**
 * Search users by query
 */
export function searchUsers(query, excludeUserId = null) {
  if (query === undefined || query === null) query = '';
  const q = `%${query.trim().toLowerCase()}%`;

  let sql = `
    SELECT id, username, nickname, avatar, bio, qq_number, qq_level, status, last_seen, created_at 
    FROM users 
    WHERE (LOWER(username) LIKE ? OR LOWER(nickname) LIKE ? OR qq_number LIKE ?)
  `;
  const params = [q, q, q];

  if (excludeUserId) {
    sql += ' AND id != ?';
    params.push(excludeUserId);
  }

  sql += " ORDER BY (status = 'online') DESC, last_seen DESC LIMIT 30";
  return all(sql, params);
}

/**
 * Update user status
 */
export function updateUserStatus(userId, status) {
  run("UPDATE users SET status = ?, last_seen = datetime('now') WHERE id = ?", [status, userId]);
  return getUserById(userId);
}

/**
 * Update user profile
 */
export function updateUserProfile(userId, { nickname, avatar, bio, status, coverTheme, tags }) {
  const user = get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw new Error('用户不存在');

  const newNickname = nickname !== undefined ? nickname.trim() : user.nickname;
  const newAvatar = avatar !== undefined ? avatar.trim() : user.avatar;
  const newBio = bio !== undefined ? bio.trim() : user.bio;
  const newStatus = status !== undefined ? status : user.status;
  const newCoverTheme = coverTheme !== undefined ? coverTheme : (user.cover_theme || 'aurora');
  const newTags = tags !== undefined ? (typeof tags === 'string' ? tags : JSON.stringify(tags)) : (user.tags || '["极客", "乐在沟通", "QQ常驻"]');

  run(
    'UPDATE users SET nickname = ?, avatar = ?, bio = ?, status = ?, cover_theme = ?, tags = ? WHERE id = ?',
    [newNickname, newAvatar, newBio, newStatus, newCoverTheme, newTags, userId]
  );

  return getUserById(userId);
}

/**
 * Change password
 */
export function changePassword(userId, oldPassword, newPassword) {
  if (!oldPassword || !newPassword) throw new Error('旧密码和新密码不能为空');
  if (newPassword.length < 4) throw new Error('新密码长度至少 4 位');

  const user = get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw new Error('用户不存在');

  if (!verifyPassword(oldPassword, user.password_hash)) {
    throw new Error('原密码输入不正确');
  }

  const newHash = hashPassword(newPassword);
  run('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, userId]);
  return { success: true };
}

/**
 * Delete account
 */
export function deleteAccount(userId, password) {
  const user = get('SELECT * FROM users WHERE id = ?', [userId]);
  if (!user) throw new Error('用户不存在');

  if (!verifyPassword(password, user.password_hash)) {
    throw new Error('密码输入不正确，无法注销账号');
  }

  run('DELETE FROM users WHERE id = ?', [userId]);
  return { success: true };
}

/**
 * QQ Zone (空间动态) API
 */
export function getZonePosts(userId = null, limit = 30, viewerUserId = null) {
  let sql = `
    SELECT p.*, u.username, u.nickname, u.avatar, u.qq_number, u.qq_level
    FROM zone_posts p
    JOIN users u ON p.user_id = u.id
  `;
  const params = [];
  if (userId) {
    sql += ' WHERE p.user_id = ?';
    params.push(userId);
  }
  sql += ' ORDER BY p.created_at DESC LIMIT ?';
  params.push(limit);

  const posts = all(sql, params);

  return posts.map(p => {
    const comments = getZoneComments(p.id);
    let hasLiked = false;
    if (viewerUserId) {
      const likeRow = get('SELECT 1 FROM zone_likes WHERE post_id = ? AND user_id = ?', [p.id, viewerUserId]);
      hasLiked = !!likeRow;
    }

    return {
      id: p.id,
      userId: p.user_id,
      content: p.content,
      images: JSON.parse(p.images || '[]'),
      likesCount: p.likes_count,
      hasLiked,
      comments: comments,
      commentsCount: comments.length,
      createdAt: p.created_at,
      author: {
        id: p.user_id,
        username: p.username,
        nickname: p.nickname,
        avatar: p.avatar,
        qqNumber: p.qq_number,
        qqLevel: p.qq_level
      }
    };
  });
}

export function createZonePost(userId, content, images = []) {
  if (!userId || !content) throw new Error('动态内容不能为空');
  const id = 'post_' + crypto.randomUUID().replace(/-/g, '');
  const imagesJson = Array.isArray(images) ? JSON.stringify(images) : (typeof images === 'string' ? images : '[]');

  run(
    'INSERT INTO zone_posts (id, user_id, content, images) VALUES (?, ?, ?, ?)',
    [id, userId, content.trim(), imagesJson]
  );
  const row = get('SELECT * FROM zone_posts WHERE id = ?', [id]);
  const user = getUserById(userId);
  return {
    id: row.id,
    userId: row.user_id,
    content: row.content,
    images: JSON.parse(row.images || '[]'),
    likesCount: row.likes_count,
    hasLiked: false,
    comments: [],
    commentsCount: 0,
    createdAt: row.created_at,
    author: user
  };
}

/**
 * Toggle Like on Zone Post (with anti-duplicate / cancel like support)
 */
export function toggleLikeZonePost(postId, userId) {
  if (!postId || !userId) throw new Error('参数缺失');

  const existingLike = get('SELECT * FROM zone_likes WHERE post_id = ? AND user_id = ?', [postId, userId]);
  let hasLiked = false;

  if (existingLike) {
    // Cancel like
    run('DELETE FROM zone_likes WHERE post_id = ? AND user_id = ?', [postId, userId]);
    run('UPDATE zone_posts SET likes_count = MAX(0, likes_count - 1) WHERE id = ?', [postId]);
    hasLiked = false;
  } else {
    // Add like
    run('INSERT OR IGNORE INTO zone_likes (post_id, user_id) VALUES (?, ?)', [postId, userId]);
    run('UPDATE zone_posts SET likes_count = likes_count + 1 WHERE id = ?', [postId]);
    hasLiked = true;
  }

  const post = get('SELECT likes_count FROM zone_posts WHERE id = ?', [postId]);
  return {
    success: true,
    hasLiked,
    likesCount: post ? post.likes_count : 0
  };
}

/**
 * Delete Zone Post
 */
export function deleteZonePost(postId, userId) {
  const post = get('SELECT * FROM zone_posts WHERE id = ?', [postId]);
  if (!post) throw new Error('动态不存在');
  if (post.user_id !== userId) throw new Error('只能删除自己发表的动态');

  run('DELETE FROM zone_posts WHERE id = ?', [postId]);
  return { success: true, postId };
}

/**
 * QQ Zone Comments API
 */
export function addZoneComment(postId, userId, content) {
  if (!postId || !userId || !content) throw new Error('评论内容不能为空');
  const id = 'zcomm_' + crypto.randomUUID().replace(/-/g, '');
  run(
    'INSERT INTO zone_comments (id, post_id, user_id, content) VALUES (?, ?, ?, ?)',
    [id, postId, userId, content.trim()]
  );
  return getZoneComments(postId);
}

export function deleteZoneComment(commentId, userId) {
  const comm = get('SELECT c.*, p.user_id as post_author_id FROM zone_comments c JOIN zone_posts p ON c.post_id = p.id WHERE c.id = ?', [commentId]);
  if (!comm) throw new Error('评论不存在');
  if (comm.user_id !== userId && comm.post_author_id !== userId) {
    throw new Error('无权删除该评论');
  }

  run('DELETE FROM zone_comments WHERE id = ?', [commentId]);
  return { success: true, commentId };
}

export function getZoneComments(postId) {
  const sql = `
    SELECT c.*, u.username, u.nickname, u.avatar, u.qq_number
    FROM zone_comments c
    JOIN users u ON c.user_id = u.id
    WHERE c.post_id = ?
    ORDER BY c.created_at ASC
  `;
  return all(sql, [postId]).map(c => ({
    id: c.id,
    postId: c.post_id,
    userId: c.user_id,
    content: c.content,
    createdAt: c.created_at,
    author: {
      id: c.user_id,
      username: c.username,
      nickname: c.nickname,
      avatar: c.avatar,
      qqNumber: c.qq_number
    }
  }));
}

/**
 * Guestbook API
 */
export function addGuestbookMessage(hostId, authorId, content) {
  if (!hostId || !authorId || !content) throw new Error('留言内容不能为空');
  const id = 'zmsg_' + crypto.randomUUID().replace(/-/g, '');
  run(
    'INSERT INTO zone_guestbook (id, host_id, author_id, content) VALUES (?, ?, ?, ?)',
    [id, hostId, authorId, content.trim()]
  );
  return getGuestbookMessages(hostId);
}

export function deleteGuestbookMessage(messageId, userId) {
  const msg = get('SELECT * FROM zone_guestbook WHERE id = ?', [messageId]);
  if (!msg) throw new Error('留言不存在');
  if (msg.author_id !== userId && msg.host_id !== userId) {
    throw new Error('无权删除该留言');
  }

  run('DELETE FROM zone_guestbook WHERE id = ?', [messageId]);
  return { success: true, messageId };
}

export function getGuestbookMessages(hostId, limit = 50) {
  const sql = `
    SELECT g.*, u.username, u.nickname, u.avatar, u.qq_number, u.qq_level
    FROM zone_guestbook g
    JOIN users u ON g.author_id = u.id
    WHERE g.host_id = ?
    ORDER BY g.created_at DESC LIMIT ?
  `;
  return all(sql, [hostId, limit]).map(g => ({
    id: g.id,
    hostId: g.host_id,
    authorId: g.author_id,
    content: g.content,
    createdAt: g.created_at,
    author: {
      id: g.author_id,
      username: g.username,
      nickname: g.nickname,
      avatar: g.avatar,
      qqNumber: g.qq_number,
      qqLevel: g.qq_level
    }
  }));
}

/**
 * Dedicated Albums & Photo Management API
 */
export function createAlbum(userId, name, description = '') {
  if (!userId || !name) throw new Error('相册名称不能为空');
  const id = 'album_' + crypto.randomUUID().replace(/-/g, '');
  run(
    'INSERT INTO user_albums (id, user_id, name, description) VALUES (?, ?, ?, ?)',
    [id, userId, name.trim().slice(0, 30), description.trim().slice(0, 100)]
  );
  return get('SELECT * FROM user_albums WHERE id = ?', [id]);
}

export function getUserAlbums(userId) {
  return all(`
    SELECT a.*, COUNT(p.id) as photo_count
    FROM user_albums a
    LEFT JOIN user_photos p ON a.id = p.album_id
    WHERE a.user_id = ?
    GROUP BY a.id
    ORDER BY a.created_at DESC
  `, [userId]);
}

export function addPhotoToAlbum(userId, { albumId = null, url, name = '', size = 0 }) {
  if (!userId || !url) throw new Error('照片 URL 不能为空');
  const id = 'photo_' + crypto.randomUUID().replace(/-/g, '');
  run(
    'INSERT INTO user_photos (id, user_id, album_id, url, name, size) VALUES (?, ?, ?, ?, ?, ?)',
    [id, userId, albumId || null, url, name || '照片', size || 0]
  );
  // Update album cover
  if (albumId) {
    run('UPDATE user_albums SET cover_url = ? WHERE id = ?', [url, albumId]);
  }
  return get('SELECT * FROM user_photos WHERE id = ?', [id]);
}

export function getUserPhotos(userId, albumId = null) {
  let sql = `SELECT * FROM user_photos WHERE user_id = ?`;
  const params = [userId];
  if (albumId) {
    sql += ' AND album_id = ?';
    params.push(albumId);
  }
  sql += ' ORDER BY created_at DESC LIMIT 100';
  return all(sql, params);
}

export function deletePhoto(photoId, userId) {
  const photo = get('SELECT * FROM user_photos WHERE id = ?', [photoId]);
  if (!photo) throw new Error('照片不存在');
  if (photo.user_id !== userId) throw new Error('只能删除自己的照片');

  run('DELETE FROM user_photos WHERE id = ?', [photoId]);
  return { success: true, photoId };
}

/**
 * Get Zone Photos (Aggregates dedicated album photos + zone post shared images)
 */
export function getZonePhotos(userId = null) {
  // 1. Get uploaded album photos
  let albumPhotos = [];
  if (userId) {
    albumPhotos = all(`SELECT id, url, name, created_at FROM user_photos WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`, [userId]);
  } else {
    albumPhotos = all(`SELECT id, url, name, created_at FROM user_photos ORDER BY created_at DESC LIMIT 50`);
  }

  // 2. Get photos from zone posts
  let postSql = `
    SELECT p.id, p.images, p.created_at, p.content, u.nickname, u.username
    FROM zone_posts p
    JOIN users u ON p.user_id = u.id
    WHERE p.images != '[]' AND p.images IS NOT NULL
  `;
  const postParams = [];
  if (userId) {
    postSql += ' AND p.user_id = ?';
    postParams.push(userId);
  }
  postSql += ' ORDER BY p.created_at DESC LIMIT 50';

  const posts = all(postSql, postParams);
  const postPhotos = [];

  for (const p of posts) {
    try {
      const imgs = JSON.parse(p.images || '[]');
      imgs.forEach((imgUrl, idx) => {
        postPhotos.push({
          id: `${p.id}_img_${idx}`,
          url: imgUrl,
          name: p.content ? (p.content.slice(0, 20) + (p.content.length > 20 ? '...' : '')) : '动态配图',
          createdAt: p.created_at
        });
      });
    } catch {}
  }

  const combined = [...albumPhotos, ...postPhotos];
  combined.sort((a, b) => new Date(b.created_at || b.createdAt) - new Date(a.created_at || a.createdAt));
  return combined.slice(0, 60);
}

/**
 * Seed initial QQ helper if database is fresh
 */
export function seedInitialData() {
  const countRow = get('SELECT COUNT(*) as count FROM users');
  if (countRow && countRow.count > 0) return;

  const defaultPassword = 'password123';

  // Create QQ Helper (企鹅小管家)
  const helper = register({
    username: 'qq_helper',
    password: defaultPassword,
    nickname: 'QQ 企鹅小管家',
    avatar: 'https://api.dicebear.com/7.x/bottts/svg?seed=qq_penguin',
    bio: '欢迎使用全新跨端 QQ！随时为您服务 🐧'
  });
  run('UPDATE users SET qq_number = ?, qq_level = ?, status = ? WHERE id = ?', ['100001', 64, 'online', helper.user.id]);
}
