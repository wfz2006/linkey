import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { initDatabase } from './db/database.js';
import {
  register,
  login,
  getUserById,
  searchUsers,
  updateUserProfile,
  changePassword,
  deleteAccount,
  verifyToken,
  getQuickUsers,
  quickLogin,
  getZonePosts,
  createZonePost,
  toggleLikeZonePost,
  deleteZonePost,
  addZoneComment,
  deleteZoneComment,
  getZoneComments,
  addGuestbookMessage,
  deleteGuestbookMessage,
  getGuestbookMessages,
  createAlbum,
  getUserAlbums,
  addPhotoToAlbum,
  getUserPhotos,
  deletePhoto,
  getZonePhotos,
  seedInitialData
} from './services/authService.js';
import {
  getOrCreateDirectConversation,
  createGroupConversation,
  getUserConversations,
  getConversationById,
  getMessages,
  getConversationMembers,
  recallMessage,
  deleteMessage,
  togglePinConversation,
  updateGroupInfo,
  kickGroupMember,
  leaveGroup,
  toggleMuteMember,
  searchMessages,
  clearConversationHistory,
  markConversationAsRead
} from './services/chatService.js';
import {
  getFriends,
  checkFriendshipStatus,
  sendFriendRequest,
  getFriendRequests,
  respondFriendRequest,
  deleteFriend,
  updateFriendInfo,
  toggleBlockUser
} from './services/friendService.js';
import { WebSocketServer } from './socket/wsServer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const UPLOADS_DIR = path.join(ROOT_DIR, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

process.on('uncaughtException', (err) => {
  if (err.code !== 'ECONNRESET') {
    console.warn('[SERVER ERROR]', err.message);
  }
});
process.on('unhandledRejection', (reason) => {
  console.warn('[UNHANDLED REJECTION]', reason);
});

export const wsServer = new WebSocketServer();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.apk': 'application/vnd.android.package-archive'
};

/**
 * Send JSON response
 */
function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  });
  res.end(JSON.stringify(data));
}

/**
 * Read request body
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = [];
    req.on('data', chunk => body.push(chunk));
    req.on('end', () => resolve(Buffer.concat(body)));
    req.on('error', reject);
  });
}

/**
 * Simple Multipart Parser for file uploads
 */
function parseMultipart(buffer, boundary) {
  const boundaryBuf = Buffer.from('--' + boundary);
  const parts = [];
  let start = 0;

  while ((start = buffer.indexOf(boundaryBuf, start)) !== -1) {
    start += boundaryBuf.length;
    if (buffer.subarray(start, start + 2).toString() === '--') break; // End boundary
    if (buffer.subarray(start, start + 2).toString() === '\r\n') start += 2;

    const end = buffer.indexOf(boundaryBuf, start);
    if (end === -1) break;

    const partBuf = buffer.subarray(start, end - 2); // strip trailing \r\n
    const headerEnd = partBuf.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) continue;

    const headersStr = partBuf.subarray(0, headerEnd).toString('utf8');
    const data = partBuf.subarray(headerEnd + 4);

    const nameMatch = headersStr.match(/name="([^"]+)"/);
    const filenameMatch = headersStr.match(/filename="([^"]+)"/);
    const typeMatch = headersStr.match(/Content-Type:\s*([^\r\n]+)/i);

    parts.push({
      name: nameMatch ? nameMatch[1] : null,
      filename: filenameMatch ? filenameMatch[1] : null,
      contentType: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
      data
    });
  }
  return parts;
}

/**
 * Authenticate HTTP request
 */
function authenticate(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.substring(7);
  return verifyToken(token);
}

/**
 * Serve static files
 */
function serveStaticFile(req, res, filePath) {
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  res.writeHead(200, {
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0'
  });

  const stream = fs.createReadStream(filePath);
  stream.pipe(res);
}

/**
 * Main HTTP Request Handler
 */
export async function handleRequest(req, res) {
  // Handle CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  try {
    // === HEALTH CHECK (无需鉴权，仅返回运行指标，不含任何用户数据) ===
    if (pathname === '/healthz' && req.method === 'GET') {
      const mem = process.memoryUsage();
      return sendJson(res, 200, {
        status: 'ok',
        app: 'fast-qq',
        version: '4.1.0',
        pid: process.pid,
        uptime: Math.floor(process.uptime()),
        memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
        ws: {
          connections: wsServer.clients.size,
          onlineUsers: wsServer.userClients.size
        },
        timestamp: Date.now()
      });
    }

    // === PUBLIC TUNNEL / SERVER INFO ROUTE ===
    if (pathname === '/api/server/public-url' && req.method === 'GET') {
      let publicUrl = null;
      let source = null;

      // 1. 实时询问 admin 守护进程的隧道状态（最可靠）
      try {
        const adminRes = await fetch('http://127.0.0.1:3001/api/admin/tunnel/status', { signal: AbortSignal.timeout(600) }).then(r => r.json()).catch(() => null);
        if (adminRes && adminRes.tunnel && adminRes.tunnel.status === 'online' && adminRes.tunnel.publicUrl) {
          publicUrl = adminRes.tunnel.publicUrl;
          source = 'tunnel-live';
        }
      } catch {}

      // 2. 回退到 public-url.json，但必须新鲜（临时隧道随进程消亡，超过 6 小时的记录视为死链）
      if (!publicUrl) {
        try {
          const pubPath = path.join(ROOT_DIR, 'public-url.json');
          if (fs.existsSync(pubPath)) {
            const data = JSON.parse(fs.readFileSync(pubPath, 'utf8'));
            const age = Date.now() - (data.updatedAt || 0);
            if (data && data.publicUrl && age < 6 * 3600 * 1000) {
              publicUrl = data.publicUrl;
              source = 'file-cache';
            } else {
              fs.unlinkSync(pubPath); // 过期死链，清理
            }
          }
        } catch {}
      }

      return sendJson(res, 200, {
        success: true,
        publicUrl,
        source,
        localUrl: `http://${getLocalIp()}:3000`,
        isTunnelActive: !!publicUrl
      });
    }

/**
 * Detect requests arriving through the public cloudflared tunnel.
 * Convenience/demo endpoints must never be exposed to the public internet.
 */
function isPublicTunnelRequest(req) {
  const host = String(req.headers['host'] || '').toLowerCase();
  return host.endsWith('.trycloudflare.com');
}

// === AUTH ROUTES ===
if (pathname === '/api/auth/quick-users' && req.method === 'GET') {
  if (isPublicTunnelRequest(req)) {
    return sendJson(res, 403, { error: '公网访问模式下快捷登录已禁用，请使用账号密码登录' });
  }
  const users = getQuickUsers();
  return sendJson(res, 200, { success: true, users });
}

if (pathname === '/api/auth/quick-login' && req.method === 'POST') {
  if (isPublicTunnelRequest(req)) {
    return sendJson(res, 403, { error: '公网访问模式下快捷登录已禁用，请使用账号密码登录' });
  }
  const raw = await readBody(req);
  const body = JSON.parse(raw.toString('utf8') || '{}');
  const result = quickLogin(body.username);
  return sendJson(res, 200, { success: true, ...result });
}

    if (pathname === '/api/auth/register' && req.method === 'POST') {
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        const result = register(body);
        return sendJson(res, 200, { success: true, ...result });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (pathname === '/api/auth/login' && req.method === 'POST') {
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        const result = login(body);
        return sendJson(res, 200, { success: true, ...result });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (pathname === '/api/auth/me' && req.method === 'GET') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录或 Token 已过期' });
      const user = getUserById(auth.userId);
      return sendJson(res, 200, { success: true, user });
    }

    if (pathname === '/api/auth/change-password' && req.method === 'POST') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        const result = changePassword(auth.userId, body.oldPassword, body.newPassword);
        return sendJson(res, 200, { success: true, ...result });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (pathname === '/api/auth/delete-account' && req.method === 'POST') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        const result = deleteAccount(auth.userId, body.password);
        return sendJson(res, 200, { success: true, ...result });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // === FRIENDSHIP (好友体系) ROUTES ===
    if (pathname === '/api/friends' && req.method === 'GET') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      const friends = getFriends(auth.userId);
      return sendJson(res, 200, { success: true, friends });
    }

    if (pathname === '/api/friends/requests' && req.method === 'GET') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      const requests = getFriendRequests(auth.userId);
      return sendJson(res, 200, { success: true, ...requests });
    }

    if (pathname === '/api/friends/requests' && req.method === 'POST') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        const targetUserId = body.toUserId || body.targetUserId;
        const request = sendFriendRequest(auth.userId, targetUserId, body.message);

        // Notify target user via WebSocket
        const sender = getUserById(auth.userId);
        wsServer.notifyUser(targetUserId, 'friend:request', {
          request,
          fromUser: sender
        });

        return sendJson(res, 200, { success: true, request });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (pathname.startsWith('/api/friends/requests/') && pathname.endsWith('/respond') && req.method === 'POST') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      try {
        const reqId = pathname.split('/')[4];
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        const result = respondFriendRequest(reqId, auth.userId, body.action);

        if (body.action === 'accept') {
          const accepter = getUserById(auth.userId);
          wsServer.notifyUser(result.fromUserId, 'friend:accepted', {
            byUser: accepter,
            conversationId: result.conversationId
          });
        }

        return sendJson(res, 200, { success: true, ...result });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (pathname.startsWith('/api/friends/') && pathname.endsWith('/remark') && req.method === 'PUT') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      try {
        const friendId = pathname.split('/')[3];
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        const updated = updateFriendInfo(auth.userId, friendId, body);
        return sendJson(res, 200, { success: true, friend: updated });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (pathname.startsWith('/api/friends/') && pathname.endsWith('/block') && req.method === 'POST') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      try {
        const friendId = pathname.split('/')[3];
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        const result = toggleBlockUser(auth.userId, friendId, body.isBlocked !== false);
        return sendJson(res, 200, { success: true, ...result });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (pathname.startsWith('/api/friends/') && req.method === 'DELETE') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      try {
        const friendId = pathname.split('/')[3];
        const result = deleteFriend(auth.userId, friendId);
        return sendJson(res, 200, { success: true, ...result });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // === QQ ZONE (空间动态) ROUTES ===
    if (pathname === '/api/zone/posts' && req.method === 'GET') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      const targetUserId = url.searchParams.get('userId');
      const posts = getZonePosts(targetUserId, 30, auth.userId);
      return sendJson(res, 200, { success: true, posts });
    }

    if (pathname === '/api/zone/posts' && req.method === 'POST') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString('utf8') || '{}');
      const post = createZonePost(auth.userId, body.content, body.images || []);
      return sendJson(res, 200, { success: true, post });
    }

    if (pathname.startsWith('/api/zone/posts/') && pathname.endsWith('/like') && req.method === 'POST') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      const parts = pathname.split('/');
      const postId = parts[4];
      const result = toggleLikeZonePost(postId, auth.userId);
      return sendJson(res, 200, { success: true, ...result });
    }

    if (pathname.startsWith('/api/zone/posts/') && req.method === 'DELETE') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      try {
        const parts = pathname.split('/');
        const postId = parts[4];
        const result = deleteZonePost(postId, auth.userId);
        return sendJson(res, 200, { success: true, ...result });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (pathname.startsWith('/api/zone/posts/') && pathname.endsWith('/comments') && req.method === 'POST') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      const parts = pathname.split('/');
      const postId = parts[4];
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString('utf8') || '{}');
      const comments = addZoneComment(postId, auth.userId, body.content);
      return sendJson(res, 200, { success: true, comments });
    }

    if (pathname.startsWith('/api/zone/posts/') && pathname.endsWith('/comments') && req.method === 'GET') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      const parts = pathname.split('/');
      const postId = parts[4];
      const comments = getZoneComments(postId);
      return sendJson(res, 200, { success: true, comments });
    }

    if (pathname.startsWith('/api/zone/comments/') && req.method === 'DELETE') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      try {
        const commentId = pathname.split('/')[4];
        const result = deleteZoneComment(commentId, auth.userId);
        return sendJson(res, 200, { success: true, ...result });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (pathname === '/api/zone/guestbook' && req.method === 'GET') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      const hostId = url.searchParams.get('hostId') || auth.userId;
      const messages = getGuestbookMessages(hostId);
      return sendJson(res, 200, { success: true, messages });
    }

    if (pathname === '/api/zone/guestbook' && req.method === 'POST') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString('utf8') || '{}');
      const messages = addGuestbookMessage(body.hostId || auth.userId, auth.userId, body.content);
      return sendJson(res, 200, { success: true, messages });
    }

    if (pathname.startsWith('/api/zone/guestbook/') && req.method === 'DELETE') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      try {
        const messageId = pathname.split('/')[4];
        const result = deleteGuestbookMessage(messageId, auth.userId);
        return sendJson(res, 200, { success: true, ...result });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // === ALBUM & PHOTO ROUTES ===
    if (pathname === '/api/zone/albums' && req.method === 'GET') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      const targetUserId = url.searchParams.get('userId') || auth.userId;
      const albums = getUserAlbums(targetUserId);
      return sendJson(res, 200, { success: true, albums });
    }

    if (pathname === '/api/zone/albums' && req.method === 'POST') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        const album = createAlbum(auth.userId, body.name, body.description);
        return sendJson(res, 200, { success: true, album });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (pathname === '/api/zone/photos' && req.method === 'GET') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      const targetUserId = url.searchParams.get('userId');
      const albumId = url.searchParams.get('albumId');
      if (albumId) {
        const photos = getUserPhotos(targetUserId || auth.userId, albumId);
        return sendJson(res, 200, { success: true, photos });
      }
      const photos = getZonePhotos(targetUserId);
      return sendJson(res, 200, { success: true, photos });
    }

    if (pathname === '/api/zone/photos' && req.method === 'POST') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      try {
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        const photo = addPhotoToAlbum(auth.userId, body);
        return sendJson(res, 200, { success: true, photo });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (pathname.startsWith('/api/zone/photos/') && req.method === 'DELETE') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      try {
        const photoId = pathname.split('/')[4];
        const result = deletePhoto(photoId, auth.userId);
        return sendJson(res, 200, { success: true, ...result });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    // === USER ROUTES ===
    if (pathname === '/api/users/search' && req.method === 'GET') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      const query = url.searchParams.get('q') || '';
      const users = searchUsers(query, auth.userId);
      return sendJson(res, 200, { success: true, users });
    }

    if (pathname.startsWith('/api/users/') && req.method === 'GET' && !pathname.includes('/search')) {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      const targetUserId = pathname.split('/')[3];
      const targetUser = getUserById(targetUserId, auth.userId);
      if (!targetUser) return sendJson(res, 404, { error: '用户不存在' });
      return sendJson(res, 200, { success: true, user: targetUser });
    }

    if (pathname === '/api/users/profile' && req.method === 'POST') {
      const auth = authenticate(req);
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString('utf8') || '{}');
      const updatedUser = updateUserProfile(auth.userId, body);
      if (body.status) {
        wsServer.broadcastAll('user:status', { userId: auth.userId, status: body.status });
      }
      return sendJson(res, 200, { success: true, user: updatedUser });
    }

    // === MESSAGE RECALL & SEARCH ROUTES ===
    if (pathname.startsWith('/api/messages/') && pathname.endsWith('/recall') && req.method === 'POST') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      try {
        const msgId = parseInt(pathname.split('/')[3], 10);
        const result = recallMessage(msgId, auth.userId);
        wsServer.to(`conv:${result.conversationId}`).emit('message:recalled', result);
        return sendJson(res, 200, { success: true, ...result });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (pathname.startsWith('/api/messages/') && req.method === 'DELETE') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      try {
        const msgId = parseInt(pathname.split('/')[3], 10);
        const result = deleteMessage(msgId, auth.userId);
        wsServer.to(`conv:${result.conversationId}`).emit('message:deleted', result);
        return sendJson(res, 200, { success: true, ...result });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (pathname === '/api/messages/search' && req.method === 'GET') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      const q = url.searchParams.get('q') || '';
      const convId = url.searchParams.get('conversationId') || null;
      const messages = searchMessages(auth.userId, q, convId);
      return sendJson(res, 200, { success: true, messages });
    }

    // === CONVERSATION ROUTES ===
    if (pathname === '/api/conversations' && req.method === 'GET') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      const conversations = getUserConversations(auth.userId);
      return sendJson(res, 200, { success: true, conversations });
    }

    if (pathname === '/api/conversations/direct' && req.method === 'POST') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString('utf8') || '{}');
      const targetId = body.targetUserId || body.userId || body.peerUserId;
      const conv = getOrCreateDirectConversation(auth.userId, targetId);

      // Notify target user via WebSocket if connected
      wsServer.notifyUser(targetId, 'conversation:new', { conversation: getConversationById(conv.id, targetId) });

      return sendJson(res, 200, { success: true, conversation: conv });
    }

    if (pathname === '/api/conversations/group' && req.method === 'POST') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString('utf8') || '{}');
      const conv = createGroupConversation(auth.userId, body.name, body.memberIds || [], body.avatar || '');

      // Notify all invited members
      if (body.memberIds) {
        for (const mid of body.memberIds) {
          wsServer.notifyUser(mid, 'conversation:new', { conversation: getConversationById(conv.id, mid) });
        }
      }

      return sendJson(res, 200, { success: true, conversation: conv });
    }

    if (pathname.startsWith('/api/conversations/') && pathname.endsWith('/pin') && req.method === 'POST') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      const convId = pathname.split('/')[3];
      const raw = await readBody(req);
      const body = JSON.parse(raw.toString('utf8') || '{}');
      const updated = togglePinConversation(convId, auth.userId, body.isPinned !== false);
      return sendJson(res, 200, { success: true, conversation: updated });
    }

    if (pathname.startsWith('/api/conversations/') && pathname.endsWith('/clear') && req.method === 'POST') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      const convId = pathname.split('/')[3];
      const result = clearConversationHistory(convId, auth.userId);
      return sendJson(res, 200, { success: true, ...result });
    }

    if (pathname.startsWith('/api/conversations/') && pathname.endsWith('/leave') && req.method === 'POST') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      try {
        const convId = pathname.split('/')[3];
        const result = leaveGroup(convId, auth.userId);
        wsServer.removeUserFromRoom(auth.userId, `conv:${convId}`);
        if (result.newOwnerId) {
          wsServer.notifyUser(result.newOwnerId, 'group:owner_transferred', { conversationId: convId });
        }
        wsServer.to(`conv:${convId}`).emit('conversation:updated', { conversationId: convId });
        return sendJson(res, 200, { success: true, ...result });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (pathname.startsWith('/api/conversations/') && pathname.endsWith('/read') && req.method === 'POST') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      const convId = pathname.split('/')[3];
      markConversationAsRead(convId, auth.userId);
      return sendJson(res, 200, { success: true });
    }

    if (pathname.startsWith('/api/conversations/') && req.method === 'PUT') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      try {
        const convId = pathname.split('/')[3];
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        const updated = updateGroupInfo(convId, auth.userId, body);
        wsServer.to(`conv:${convId}`).emit('conversation:updated', { conversation: updated });
        return sendJson(res, 200, { success: true, conversation: updated });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (pathname.startsWith('/api/conversations/') && pathname.includes('/members/') && pathname.endsWith('/mute') && req.method === 'POST') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      try {
        const parts = pathname.split('/');
        const convId = parts[3];
        const targetUserId = parts[5];
        const raw = await readBody(req);
        const body = JSON.parse(raw.toString('utf8') || '{}');
        const result = toggleMuteMember(convId, auth.userId, targetUserId, body.isMuted !== false);
        return sendJson(res, 200, { success: true, ...result });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (pathname.startsWith('/api/conversations/') && pathname.includes('/members/') && req.method === 'DELETE') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      try {
        const parts = pathname.split('/');
        const convId = parts[3];
        const targetUserId = parts[5];
        const result = kickGroupMember(convId, auth.userId, targetUserId);
        wsServer.removeUserFromRoom(targetUserId, `conv:${convId}`);
        wsServer.notifyUser(targetUserId, 'group:kicked', { conversationId: convId, reason: '您已被移出群聊' });
        wsServer.to(`conv:${convId}`).emit('conversation:updated', { conversationId: convId });
        return sendJson(res, 200, { success: true, ...result });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }

    if (pathname.startsWith('/api/conversations/') && pathname.endsWith('/messages') && req.method === 'GET') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      const parts = pathname.split('/');
      const conversationId = parts[3];
      const limit = parseInt(url.searchParams.get('limit') || '50', 10);
      const beforeId = url.searchParams.get('before') ? parseInt(url.searchParams.get('before'), 10) : null;
      const messages = getMessages(conversationId, limit, beforeId);
      return sendJson(res, 200, { success: true, messages });
    }

    if (pathname.startsWith('/api/conversations/') && pathname.endsWith('/members') && req.method === 'GET') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });
      const parts = pathname.split('/');
      const conversationId = parts[3];
      const members = getConversationMembers(conversationId);
      return sendJson(res, 200, { success: true, members });
    }

    // === FILE UPLOAD ROUTE ===
    if (pathname === '/api/upload' && req.method === 'POST') {
      const auth = authenticate(req);
      if (!auth) return sendJson(res, 401, { error: '未登录' });

      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(.+)$/);
      if (!boundaryMatch) {
        return sendJson(res, 400, { error: '无效的表单格式 (Missing boundary)' });
      }

      const boundary = boundaryMatch[1];
      const raw = await readBody(req);
      const parts = parseMultipart(raw, boundary);
      const filePart = parts.find(p => p.filename && p.data && p.data.length > 0);

      if (!filePart) {
        return sendJson(res, 400, { error: '没有检测到上传的文件' });
      }

      // Check size limit (30MB max)
      if (filePart.data.length > 30 * 1024 * 1024) {
        return sendJson(res, 400, { error: '文件大小超过 30MB 限制' });
      }

      // Sanitize extension and filename
      const ext = path.extname(filePart.filename).toLowerCase() || '.bin';
      const safeName = `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;
      const savePath = path.join(UPLOADS_DIR, safeName);

      fs.writeFileSync(savePath, filePart.data);

      return sendJson(res, 200, {
        success: true,
        url: `/uploads/${safeName}`,
        fileName: filePart.filename,
        fileSize: filePart.data.length,
        mimeType: filePart.contentType
      });
    }

    // === SERVE UPLOADS ===
    if (pathname.startsWith('/uploads/')) {
      const fileName = path.basename(pathname);
      const filePath = path.join(UPLOADS_DIR, fileName);
      return serveStaticFile(req, res, filePath);
    }

    // === SERVE FRONTEND STATIC FILES ===
    let staticPath = path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname);
    if (!fs.existsSync(staticPath) || fs.statSync(staticPath).isDirectory()) {
      staticPath = path.join(PUBLIC_DIR, 'index.html');
    }
    return serveStaticFile(req, res, staticPath);

  } catch (err) {
    console.error('Request handler error:', err);
    return sendJson(res, 500, { error: err.message || 'Internal Server Error' });
  }
}

/**
 * Create and start HTTP + WebSocket Server
 */
export function createServer(port = 3000, dbPath = './qq_chat.db') {
  initDatabase(dbPath);
  try { seedInitialData(); } catch (err) { console.warn('Seed note:', err.message); }

  const server = http.createServer(handleRequest);

  server.on('upgrade', (req, socket, head) => {
    wsServer.handleUpgrade(req, socket, head);
  });

  return new Promise((resolve) => {
    server.listen(port, () => {
      resolve(server);
    });
  });
}

function getLocalIp() {
  try {
    const interfaces = os.networkInterfaces();
    const allIps = [];
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          allIps.push(iface.address);
        }
      }
    }
    const lanIp = allIps.find(ip => ip.startsWith('192.168.') || ip.startsWith('10.'));
    if (lanIp) return lanIp;
    if (allIps.length > 0) return allIps[0];
  } catch {}
  return '127.0.0.1';
}

// Auto start if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const PORT = process.env.PORT || 3000;
  createServer(PORT).then((server) => {
    const address = server.address();
    const localIp = getLocalIp();
    console.log(`\n=======================================================`);
    console.log(`[SUCCESS] Chat Server is Running!`);
    console.log(`-------------------------------------------------------`);
    console.log(`> PC / Desktop Browser : http://localhost:${address.port}`);
    console.log(`> Mobile / Phone Access: http://${localIp}:${address.port}`);
    console.log(`> WebSocket Gateway    : ws://localhost:${address.port}/ws`);
    console.log(`=======================================================\n`);
  });
}
