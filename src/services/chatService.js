import crypto from 'node:crypto';
import { run, get, all } from '../db/database.js';
import { getUserById, generateLocalAvatar } from './authService.js';

/**
 * Get or create a 1-on-1 Direct Conversation
 */
export function getOrCreateDirectConversation(user1Id, user2Id) {
  if (!user1Id || !user2Id) throw new Error('用户 ID 缺失');
  if (user1Id === user2Id) throw new Error('不能与自己建立私聊');

  // Check if direct conversation already exists between these 2 users
  const existing = get(`
    SELECT c.id, c.type, c.name, c.avatar, c.creator_id, c.last_message_preview, c.last_message_at, c.created_at
    FROM conversations c
    JOIN conversation_members m1 ON c.id = m1.conversation_id AND m1.user_id = ?
    JOIN conversation_members m2 ON c.id = m2.conversation_id AND m2.user_id = ?
    WHERE c.type = 'direct'
  `, [user1Id, user2Id]);

  if (existing) {
    return formatConversationForUser(existing, user1Id);
  }

  // Create new direct conversation
  const convId = 'dm_' + crypto.randomUUID().replace(/-/g, '');
  run(
    'INSERT INTO conversations (id, type, name, creator_id) VALUES (?, ?, ?, ?)',
    [convId, 'direct', null, user1Id]
  );

  run(
    'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)',
    [convId, user1Id, 'owner']
  );
  run(
    'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)',
    [convId, user2Id, 'member']
  );

  const newConv = get('SELECT * FROM conversations WHERE id = ?', [convId]);
  return formatConversationForUser(newConv, user1Id);
}

/**
 * Create a new Group Conversation
 */
export function createGroupConversation(creatorId, name, memberIds = [], avatar = '') {
  if (!creatorId || !name) throw new Error('群聊名称不能为空');

  name = name.trim();
  const convId = 'grp_' + crypto.randomUUID().replace(/-/g, '');
  const defaultAvatar = avatar || generateLocalAvatar(name, true);

  run(
    'INSERT INTO conversations (id, type, name, avatar, creator_id, last_message_preview) VALUES (?, ?, ?, ?, ?, ?)',
    [convId, 'group', name, defaultAvatar, creatorId, '群聊已创建']
  );

  // Add creator as owner
  run(
    'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)',
    [convId, creatorId, 'owner']
  );

  // Add other members
  const uniqueMemberIds = Array.from(new Set(memberIds.filter(id => id && id !== creatorId)));
  for (const mid of uniqueMemberIds) {
    run(
      'INSERT OR IGNORE INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)',
      [convId, mid, 'member']
    );
  }

  // Add system welcome message
  saveMessage({
    conversationId: convId,
    senderId: creatorId,
    type: 'system',
    content: '群聊已创建，快和大家打个招呼吧！'
  });

  const groupConv = get('SELECT * FROM conversations WHERE id = ?', [convId]);
  return formatConversationForUser(groupConv, creatorId);
}

/**
 * Format a conversation record for a specific user (resolves peer info for DMs)
 */
export function formatConversationForUser(conv, userId) {
  if (!conv) return null;

  let displayName = conv.name;
  let displayAvatar = conv.avatar || generateLocalAvatar(conv.name || '群聊', conv.type === 'group');
  let peerUser = null;

  if (conv.type === 'direct') {
    // Find the peer user (another user, or self if self-chat)
    let peerMember = get(`
      SELECT u.id, u.username, u.nickname, u.avatar, u.status, u.last_seen, u.qq_number, u.qq_level
      FROM conversation_members m
      JOIN users u ON m.user_id = u.id
      WHERE m.conversation_id = ? AND m.user_id != ?
    `, [conv.id, userId]);

    if (!peerMember) {
      peerMember = get(`
        SELECT u.id, u.username, u.nickname, u.avatar, u.status, u.last_seen, u.qq_number, u.qq_level
        FROM conversation_members m
        JOIN users u ON m.user_id = u.id
        WHERE m.conversation_id = ?
        LIMIT 1
      `, [conv.id]);
    }

    if (peerMember) {
      peerUser = peerMember;
      displayName = peerMember.nickname || peerMember.username;
      displayAvatar = peerMember.avatar || generateLocalAvatar(displayName);
    } else {
      displayName = conv.name || 'QQ 好友';
      displayAvatar = conv.avatar || generateLocalAvatar(displayName);
    }
  }

  // Calculate unread count and member settings
  const memberRow = get(`
    SELECT last_read_message_id, role, is_pinned, is_muted, joined_at 
    FROM conversation_members 
    WHERE conversation_id = ? AND user_id = ?
  `, [conv.id, userId]);

  const lastReadId = memberRow ? memberRow.last_read_message_id : 0;
  const unreadRow = get(`
    SELECT COUNT(*) as count 
    FROM messages 
    WHERE conversation_id = ? AND id > ? AND sender_id != ?
  `, [conv.id, lastReadId, userId]);

  const unreadCount = unreadRow ? unreadRow.count : 0;

  // Get member count for groups
  let memberCount = 0;
  if (conv.type === 'group') {
    const countRow = get('SELECT COUNT(*) as count FROM conversation_members WHERE conversation_id = ?', [conv.id]);
    memberCount = countRow ? countRow.count : 0;
  }

  return {
    id: conv.id,
    type: conv.type,
    name: displayName,
    rawName: conv.name,
    avatar: displayAvatar,
    creatorId: conv.creator_id,
    notice: conv.notice || '',
    lastMessagePreview: conv.last_message_preview,
    lastMessageAt: conv.last_message_at,
    createdAt: conv.created_at,
    unreadCount,
    lastReadMessageId: lastReadId,
    memberCount,
    peerUser,
    role: memberRow ? memberRow.role : 'member',
    isPinned: memberRow ? !!memberRow.is_pinned : false,
    isMuted: memberRow ? !!memberRow.is_muted : false
  };
}

/**
 * Get all conversations for a user (pinned conversations float to the top)
 */
export function getUserConversations(userId) {
  const convs = all(`
    SELECT c.*, m.is_pinned
    FROM conversations c
    JOIN conversation_members m ON c.id = m.conversation_id
    WHERE m.user_id = ?
    ORDER BY m.is_pinned DESC, c.last_message_at DESC
  `, [userId]);

  return convs.map(conv => formatConversationForUser(conv, userId));
}

/**
 * Get conversation by ID for user
 */
export function getConversationById(conversationId, userId) {
  const conv = get(`
    SELECT c.*
    FROM conversations c
    JOIN conversation_members m ON c.id = m.conversation_id
    WHERE c.id = ? AND m.user_id = ?
  `, [conversationId, userId]);

  if (!conv) return null;
  return formatConversationForUser(conv, userId);
}

/**
 * Get members of a conversation
 */
export function getConversationMembers(conversationId) {
  return all(`
    SELECT m.role, m.is_pinned, m.is_muted, m.joined_at, u.id, u.username, u.nickname, u.avatar, u.bio, u.status, u.last_seen, u.qq_number, u.qq_level
    FROM conversation_members m
    JOIN users u ON m.user_id = u.id
    WHERE m.conversation_id = ?
    ORDER BY (m.role = 'owner') DESC, (m.role = 'admin') DESC, u.nickname ASC
  `, [conversationId]);
}

/**
 * Save a message and update conversation
 */
export function saveMessage({ conversationId, senderId, type = 'text', content, fileName = null, fileSize = null, replyToId = null, mentions = [] }) {
  if (!conversationId || !senderId || !content) {
    throw new Error('消息内容与发送者不能为空');
  }

  // Check if member is part of conversation and check mute status
  const member = get('SELECT role, is_muted FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [conversationId, senderId]);
  if (!member) {
    throw new Error('您不是该群成员或已被移出群聊，无法发送消息');
  }
  if (member.is_muted) {
    throw new Error('您已被群管理员禁言，无法发送消息');
  }

  const mentionsJson = Array.isArray(mentions) ? JSON.stringify(mentions) : '[]';

  const res = run(
    'INSERT INTO messages (conversation_id, sender_id, type, content, file_name, file_size, reply_to_id, mentions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [conversationId, senderId, type, content, fileName, fileSize, replyToId || null, mentionsJson]
  );

  const messageId = res.lastInsertRowid;

  // Determine preview text
  let preview = content;
  if (type === 'image') preview = '[图片]';
  else if (type === 'file') preview = `[文件] ${fileName || '附件'}`;
  else if (type === 'system') preview = `[系统通知] ${content}`;
  else if (type === 'poke') preview = `[戳一戳] ${content}`;

  if (preview.length > 50) preview = preview.slice(0, 47) + '...';

  run(
    "UPDATE conversations SET last_message_preview = ?, last_message_at = datetime('now') WHERE id = ?",
    [preview, conversationId]
  );

  // Automatically mark as read for sender
  run(
    'UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?',
    [messageId, conversationId, senderId]
  );

  return formatMessageRecord(messageId);
}

/**
 * Helper to format message with sender & reply details
 */
export function formatMessageRecord(messageId) {
  const rawMsg = get('SELECT * FROM messages WHERE id = ?', [messageId]);
  if (!rawMsg) return null;

  const sender = getUserById(rawMsg.sender_id);
  
  let replyTo = null;
  if (rawMsg.reply_to_id) {
    const parent = get('SELECT m.*, u.nickname, u.username FROM messages m JOIN users u ON m.sender_id = u.id WHERE m.id = ?', [rawMsg.reply_to_id]);
    if (parent) {
      replyTo = {
        id: parent.id,
        senderId: parent.sender_id,
        senderName: parent.nickname || parent.username,
        content: parent.is_recalled ? '消息已撤回' : (parent.type === 'image' ? '[图片]' : (parent.type === 'file' ? `[文件] ${parent.file_name}` : parent.content)),
        type: parent.type
      };
    }
  }

  let mentions = [];
  try {
    if (rawMsg.mentions) mentions = JSON.parse(rawMsg.mentions);
  } catch {}

  return {
    id: rawMsg.id,
    conversationId: rawMsg.conversation_id,
    senderId: rawMsg.sender_id,
    type: rawMsg.type,
    content: rawMsg.is_recalled ? '对方撤回了一条消息' : rawMsg.content,
    fileName: rawMsg.file_name,
    fileSize: rawMsg.file_size,
    isRecalled: !!rawMsg.is_recalled,
    replyToId: rawMsg.reply_to_id,
    replyTo,
    mentions,
    createdAt: rawMsg.created_at,
    sender: sender ? {
      id: sender.id,
      username: sender.username,
      nickname: sender.nickname,
      avatar: sender.avatar,
      qqNumber: sender.qq_number,
      qqLevel: sender.qq_level
    } : null
  };
}

/**
 * Get messages of a conversation (chronological order)
 */
export function getMessages(conversationId, limit = 50, beforeId = null) {
  let sql = `
    SELECT id FROM messages
    WHERE conversation_id = ?
  `;
  const params = [conversationId];

  if (beforeId) {
    sql += ' AND id < ?';
    params.push(beforeId);
  }

  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(limit);

  const rawRows = all(sql, params);
  rawRows.reverse();

  return rawRows.map(r => formatMessageRecord(r.id));
}

/**
 * Recall a message (within 2 mins for sender, or any for group owner/admin)
 */
export function recallMessage(messageId, userId) {
  const msg = get('SELECT * FROM messages WHERE id = ?', [messageId]);
  if (!msg) throw new Error('消息不存在');
  if (msg.is_recalled) throw new Error('该消息已撤回');

  const member = get('SELECT * FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [msg.conversation_id, userId]);
  if (!member) throw new Error('无权操作该会话');

  const isSender = msg.sender_id === userId;
  const isOwnerOrAdmin = member.role === 'owner' || member.role === 'admin';

  const elapsedMs = Date.now() - new Date(msg.created_at + (msg.created_at.endsWith('Z') ? '' : 'Z')).getTime();
  const elapsedMinutes = elapsedMs / 60000;

  if (isSender && elapsedMinutes > 2 && !isOwnerOrAdmin) {
    throw new Error('已超过 2 分钟，无法撤回该消息');
  }
  if (!isSender && !isOwnerOrAdmin) {
    throw new Error('只能撤回自己发送的消息');
  }

  // Compatible with DB CHECK(type IN ('text','image','file','system','poke')) without modifying type
  run("UPDATE messages SET is_recalled = 1, content = '撤回了一条消息' WHERE id = ?", [messageId]);

  // Update preview
  run("UPDATE conversations SET last_message_preview = '对方撤回了一条消息' WHERE id = ?", [msg.conversation_id]);

  return {
    messageId: msg.id,
    conversationId: msg.conversation_id,
    recalledBy: userId,
    senderId: msg.sender_id
  };
}

/**
 * Delete a message for self
 */
export function deleteMessage(messageId, userId) {
  const msg = get('SELECT * FROM messages WHERE id = ?', [messageId]);
  if (!msg) throw new Error('消息不存在');
  if (msg.sender_id !== userId) throw new Error('只能删除自己发送的消息');

  run('DELETE FROM messages WHERE id = ?', [messageId]);
  return { success: true, messageId, conversationId: msg.conversation_id };
}

/**
 * Pin / Unpin conversation
 */
export function togglePinConversation(conversationId, userId, isPinned = true) {
  run('UPDATE conversation_members SET is_pinned = ? WHERE conversation_id = ? AND user_id = ?', [isPinned ? 1 : 0, conversationId, userId]);
  return getConversationById(conversationId, userId);
}

/**
 * Update Group info & notice (Owner/Admin)
 */
export function updateGroupInfo(conversationId, userId, { name, avatar, notice }) {
  const member = get('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [conversationId, userId]);
  if (!member || (member.role !== 'owner' && member.role !== 'admin')) {
    throw new Error('只有群主或管理员可以修改群资料');
  }
  const conv = get("SELECT * FROM conversations WHERE id = ? AND type = 'group'", [conversationId]);
  if (!conv) throw new Error('群聊不存在');

  const newName = name !== undefined ? name.trim() : conv.name;
  const newAvatar = avatar !== undefined ? avatar : conv.avatar;
  const newNotice = notice !== undefined ? notice.trim() : (conv.notice || '');

  run(
    'UPDATE conversations SET name = ?, avatar = ?, notice = ? WHERE id = ?',
    [newName, newAvatar, newNotice, conversationId]
  );

  if (notice !== undefined && notice.trim() !== (conv.notice || '')) {
    saveMessage({
      conversationId,
      senderId: userId,
      type: 'system',
      content: `📢 群公告更新：${newNotice}`
    });
  }

  return getConversationById(conversationId, userId);
}

/**
 * Kick group member
 */
export function kickGroupMember(conversationId, operatorId, targetUserId) {
  const op = get('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [conversationId, operatorId]);
  if (!op || (op.role !== 'owner' && op.role !== 'admin')) throw new Error('无权踢出群成员');
  if (operatorId === targetUserId) throw new Error('不能踢出自己');

  const targetMember = get('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [conversationId, targetUserId]);
  if (!targetMember) throw new Error('目标用户不在该群聊中');
  if (targetMember.role === 'owner') throw new Error('不能踢出群主');

  const targetUser = getUserById(targetUserId);
  run('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [conversationId, targetUserId]);

  saveMessage({
    conversationId,
    senderId: operatorId,
    type: 'system',
    content: `${targetUser ? targetUser.nickname : '成员'} 已被移出群聊`
  });

  return { success: true, kickedUserId: targetUserId };
}

/**
 * Leave group
 */
export function leaveGroup(conversationId, userId) {
  const member = get('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [conversationId, userId]);
  if (!member) throw new Error('未加入该群聊');

  const user = getUserById(userId);
  run('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [conversationId, userId]);

  const remaining = all('SELECT user_id, role FROM conversation_members WHERE conversation_id = ?', [conversationId]);
  let newOwnerId = null;
  if (remaining.length === 0) {
    run('DELETE FROM conversations WHERE id = ?', [conversationId]);
  } else if (member.role === 'owner') {
    newOwnerId = remaining[0].user_id;
    run("UPDATE conversation_members SET role = 'owner' WHERE conversation_id = ? AND user_id = ?", [conversationId, newOwnerId]);
    const newOwnerUser = getUserById(newOwnerId);
    saveMessage({
      conversationId,
      senderId: userId,
      type: 'system',
      content: `${user ? user.nickname : '群主'} 离开了群聊，已将群主自动转让给 ${newOwnerUser ? newOwnerUser.nickname : '新群员'}`
    });
  } else {
    saveMessage({
      conversationId,
      senderId: userId,
      type: 'system',
      content: `${user ? user.nickname : '成员'} 离开了群聊`
    });
  }

  return { success: true, conversationId, newOwnerId };
}

/**
 * Mute / Unmute group member
 */
export function toggleMuteMember(conversationId, operatorId, targetUserId, isMuted = true) {
  const op = get('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [conversationId, operatorId]);
  if (!op || (op.role !== 'owner' && op.role !== 'admin')) throw new Error('无权禁言群成员');

  const targetMember = get('SELECT role FROM conversation_members WHERE conversation_id = ? AND user_id = ?', [conversationId, targetUserId]);
  if (!targetMember) throw new Error('目标用户不在该群聊中');

  run('UPDATE conversation_members SET is_muted = ? WHERE conversation_id = ? AND user_id = ?', [isMuted ? 1 : 0, conversationId, targetUserId]);
  const targetUser = getUserById(targetUserId);

  saveMessage({
    conversationId,
    senderId: operatorId,
    type: 'system',
    content: isMuted ? `成员 ${targetUser ? targetUser.nickname : ''} 已被禁言` : `成员 ${targetUser ? targetUser.nickname : ''} 已解除禁言`
  });

  return { success: true, targetUserId, isMuted };
}

/**
 * Search messages across user conversations
 */
export function searchMessages(userId, query, conversationId = null) {
  if (!query || !query.trim()) return [];
  const q = `%${query.trim()}%`;
  let sql = `
    SELECT m.*, u.username, u.nickname, u.avatar, c.name as conversation_name, c.type as conversation_type
    FROM messages m
    JOIN conversation_members cm ON m.conversation_id = cm.conversation_id AND cm.user_id = ?
    JOIN conversations c ON m.conversation_id = c.id
    JOIN users u ON m.sender_id = u.id
    WHERE m.content LIKE ? AND m.type IN ('text', 'image', 'file', 'poke') AND m.is_recalled = 0
  `;
  const params = [userId, q];
  if (conversationId) {
    sql += ' AND m.conversation_id = ?';
    params.push(conversationId);
  }
  sql += ' ORDER BY m.created_at DESC LIMIT 50';
  return all(sql, params);
}

/**
 * Mark all messages as read in a conversation
 */
export function markConversationAsRead(conversationId, userId) {
  const lastMsg = get('SELECT id FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', [conversationId]);
  if (!lastMsg) return;

  run(
    'UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?',
    [lastMsg.id, conversationId, userId]
  );
}

/**
 * Clear conversation messages for user
 */
export function clearConversationHistory(conversationId, userId) {
  // Mark last read to current max id
  const lastMsg = get('SELECT id FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1', [conversationId]);
  if (lastMsg) {
    run('UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ?', [lastMsg.id, conversationId, userId]);
  }
  return { success: true, conversationId };
}

/**
 * Mark conversation messages as read
 */
export function markAsRead(conversationId, userId, maxMessageId) {
  if (!conversationId || !userId) return;

  const targetId = maxMessageId || 999999999;
  run(`
    UPDATE conversation_members 
    SET last_read_message_id = MAX(last_read_message_id, ?) 
    WHERE conversation_id = ? AND user_id = ?
  `, [targetId, conversationId, userId]);

  return { success: true, conversationId, lastReadMessageId: targetId };
}
