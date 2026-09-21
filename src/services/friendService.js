import crypto from 'node:crypto';
import { run, get, all } from '../db/database.js';
import { getUserById } from './authService.js';
import { getOrCreateDirectConversation, saveMessage } from './chatService.js';

/**
 * Get all accepted friends of a user
 */
export function getFriends(userId) {
  if (!userId) return [];

  const sql = `
    SELECT 
      f.friend_id,
      f.remark,
      f.group_name,
      f.is_blocked,
      f.created_at as friendship_created_at,
      u.username,
      u.nickname,
      u.avatar,
      u.bio,
      u.qq_number,
      u.qq_level,
      u.status,
      u.last_seen
    FROM friends f
    JOIN users u ON f.friend_id = u.id
    WHERE f.user_id = ? AND f.is_blocked = 0
    ORDER BY (u.status = 'online') DESC, (u.status = 'away') DESC, f.created_at ASC
  `;

  return all(sql, [userId]);
}

/**
 * Check friendship status between two users
 */
export function checkFriendshipStatus(userId, targetUserId) {
  if (!userId || !targetUserId || userId === targetUserId) {
    return { isFriend: false, isSelf: userId === targetUserId, isBlocked: false, pendingRequest: false };
  }

  const friendRow = get(`SELECT * FROM friends WHERE user_id = ? AND friend_id = ?`, [userId, targetUserId]);
  const isFriend = !!friendRow;
  const isBlocked = friendRow ? !!friendRow.is_blocked : false;
  const remark = friendRow ? (friendRow.remark || '') : '';
  const groupName = friendRow ? (friendRow.group_name || '我的好友') : '我的好友';

  // Check if there is an active pending friend request from userId to targetUserId
  const pendingReq = get(`
    SELECT * FROM friend_requests 
    WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending'
  `, [userId, targetUserId]);

  // Check if there is an incoming pending friend request from targetUserId to userId
  const incomingReq = get(`
    SELECT * FROM friend_requests 
    WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending'
  `, [targetUserId, userId]);

  return {
    isFriend,
    isBlocked,
    remark,
    groupName,
    hasSentPendingRequest: !!pendingReq,
    hasIncomingPendingRequest: !!incomingReq,
    incomingRequestId: incomingReq ? incomingReq.id : null
  };
}

/**
 * Send a friend request
 */
export function sendFriendRequest(fromUserId, toUserId, message = '') {
  if (!fromUserId || !toUserId) throw new Error('用户 ID 缺失');
  if (fromUserId === toUserId) throw new Error('不能添加自己为好友');

  const toUser = getUserById(toUserId);
  if (!toUser) throw new Error('目标用户不存在');

  // Check if already friends
  const existingFriend = get('SELECT * FROM friends WHERE user_id = ? AND friend_id = ?', [fromUserId, toUserId]);
  if (existingFriend) throw new Error('对方已经是您的好友');

  // Check if pending request exists
  const existingReq = get(`
    SELECT * FROM friend_requests 
    WHERE from_user_id = ? AND to_user_id = ? AND status = 'pending'
  `, [fromUserId, toUserId]);

  const fromUser = getUserById(fromUserId);
  const cleanMsg = message ? message.trim().slice(0, 100) : `我是 ${fromUser ? (fromUser.nickname || fromUser.username) : 'QQ用户'}`;

  if (existingReq) {
    // Update message and timestamp
    run(
      `UPDATE friend_requests SET message = ?, updated_at = datetime('now') WHERE id = ?`,
      [cleanMsg, existingReq.id]
    );
    return get('SELECT * FROM friend_requests WHERE id = ?', [existingReq.id]);
  }

  const reqId = 'freq_' + crypto.randomUUID().replace(/-/g, '');
  run(
    `INSERT INTO friend_requests (id, from_user_id, to_user_id, message, status) VALUES (?, ?, ?, ?, 'pending')`,
    [reqId, fromUserId, toUserId, cleanMsg]
  );

  return get('SELECT * FROM friend_requests WHERE id = ?', [reqId]);
}

/**
 * Get friend requests (both incoming pending and outgoing sent)
 */
export function getFriendRequests(userId) {
  if (!userId) return { incoming: [], outgoing: [] };

  const incoming = all(`
    SELECT 
      r.id,
      r.from_user_id,
      r.to_user_id,
      r.message,
      r.status,
      r.created_at,
      r.updated_at,
      u.username,
      u.nickname,
      u.avatar,
      u.qq_number,
      u.qq_level,
      u.status as online_status
    FROM friend_requests r
    JOIN users u ON r.from_user_id = u.id
    WHERE r.to_user_id = ? AND r.status = 'pending'
    ORDER BY r.created_at DESC
  `, [userId]);

  const outgoing = all(`
    SELECT 
      r.id,
      r.from_user_id,
      r.to_user_id,
      r.message,
      r.status,
      r.created_at,
      r.updated_at,
      u.username,
      u.nickname,
      u.avatar,
      u.qq_number,
      u.qq_level,
      u.status as online_status
    FROM friend_requests r
    JOIN users u ON r.to_user_id = u.id
    WHERE r.from_user_id = ?
    ORDER BY r.created_at DESC LIMIT 20
  `, [userId]);

  return { incoming, outgoing };
}

/**
 * Respond to a friend request ('accept' | 'reject')
 */
export function respondFriendRequest(requestId, userId, action) {
  if (!requestId || !userId) throw new Error('参数缺失');
  if (!['accept', 'reject'].includes(action)) throw new Error('无效的操作类型');

  const req = get(`SELECT * FROM friend_requests WHERE id = ? AND to_user_id = ?`, [requestId, userId]);
  if (!req) throw new Error('未找到该好友申请或无权操作');
  if (req.status !== 'pending') throw new Error('该申请已被处理');

  if (action === 'reject') {
    run(`UPDATE friend_requests SET status = 'rejected', updated_at = datetime('now') WHERE id = ?`, [requestId]);
    return { success: true, action: 'rejected', requestId };
  }

  // Action is accept: establish mutual friendship
  run(`UPDATE friend_requests SET status = 'accepted', updated_at = datetime('now') WHERE id = ?`, [requestId]);

  // Insert bilateral friendship
  run(`INSERT OR IGNORE INTO friends (user_id, friend_id, group_name) VALUES (?, ?, '我的好友')`, [req.to_user_id, req.from_user_id]);
  run(`INSERT OR IGNORE INTO friends (user_id, friend_id, group_name) VALUES (?, ?, '我的好友')`, [req.from_user_id, req.to_user_id]);

  // Initialize or get direct conversation
  let conv = null;
  try {
    conv = getOrCreateDirectConversation(req.to_user_id, req.from_user_id);
    // Send system welcome message
    saveMessage({
      conversationId: conv.id,
      senderId: req.to_user_id,
      type: 'system',
      content: '你们已成为好友，现在可以开始聊天啦！'
    });
  } catch (err) {
    console.warn('Friendship conversation creation notice:', err.message);
  }

  return {
    success: true,
    action: 'accepted',
    requestId,
    fromUserId: req.from_user_id,
    toUserId: req.to_user_id,
    conversationId: conv ? conv.id : null
  };
}

/**
 * Delete a friend
 */
export function deleteFriend(userId, friendId) {
  if (!userId || !friendId) throw new Error('用户 ID 缺失');
  run(`DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`, [userId, friendId, friendId, userId]);
  return { success: true, deletedFriendId: friendId };
}

/**
 * Update friend remark and group
 */
export function updateFriendInfo(userId, friendId, { remark, groupName }) {
  if (!userId || !friendId) throw new Error('参数缺失');
  const friend = get(`SELECT * FROM friends WHERE user_id = ? AND friend_id = ?`, [userId, friendId]);
  if (!friend) throw new Error('好友关系不存在');

  const newRemark = remark !== undefined ? remark.trim().slice(0, 30) : friend.remark;
  const newGroup = groupName !== undefined ? groupName.trim().slice(0, 20) : friend.group_name;

  run(
    `UPDATE friends SET remark = ?, group_name = ? WHERE user_id = ? AND friend_id = ?`,
    [newRemark, newGroup, userId, friendId]
  );

  return get(`SELECT * FROM friends WHERE user_id = ? AND friend_id = ?`, [userId, friendId]);
}

/**
 * Block or unblock a user
 */
export function toggleBlockUser(userId, targetUserId, isBlocked = true) {
  if (!userId || !targetUserId) throw new Error('参数缺失');
  run(
    `UPDATE friends SET is_blocked = ? WHERE user_id = ? AND friend_id = ?`,
    [isBlocked ? 1 : 0, userId, targetUserId]
  );
  return { success: true, isBlocked };
}
