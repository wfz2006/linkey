import crypto from 'node:crypto';
import EventEmitter from 'node:events';
import { verifyToken, updateUserStatus } from '../services/authService.js';
import {
  saveMessage,
  markAsRead,
  getUserConversations,
  getConversationMembers,
  getConversationById
} from '../services/chatService.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class WebSocketClient extends EventEmitter {
  constructor(socket, user) {
    super();
    this.id = 'sock_' + crypto.randomUUID().replace(/-/g, '');
    this.socket = socket;
    this.user = user;
    this.rooms = new Set();
    this.buffer = Buffer.alloc(0);
    this.isAlive = true;

    this.socket.on('data', (chunk) => this._handleData(chunk));
    this.socket.on('close', () => this._handleClose());
    this.socket.on('error', (err) => {
      // Ignore network reset errors when client closes browser tab
      this._handleClose();
    });
    this.on('error', () => {});
  }

  _handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this._processFrames();
  }

  _processFrames() {
    while (this.buffer.length >= 2) {
      const firstByte = this.buffer[0];
      const secondByte = this.buffer[1];

      const fin = (firstByte & 0x80) === 0x80;
      const opcode = firstByte & 0x0f;
      const masked = (secondByte & 0x80) === 0x80;
      let payloadLength = secondByte & 0x7f;

      let offset = 2;

      if (payloadLength === 126) {
        if (this.buffer.length < offset + 2) return;
        payloadLength = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (payloadLength === 127) {
        if (this.buffer.length < offset + 8) return;
        payloadLength = Number(this.buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      let maskKey = null;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        maskKey = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }

      if (this.buffer.length < offset + payloadLength) {
        return; // Incomplete frame, wait for more data
      }

      const payload = Buffer.from(this.buffer.subarray(offset, offset + payloadLength));
      this.buffer = this.buffer.subarray(offset + payloadLength);

      if (masked && maskKey) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] ^= maskKey[i % 4];
        }
      }

      // Handle Opcodes
      if (opcode === 0x8) { // Close
        this.close();
        return;
      } else if (opcode === 0x9) { // Ping
        this._sendFrame(0xa, payload); // Pong
      } else if (opcode === 0xa) { // Pong
        this.isAlive = true;
      } else if (opcode === 0x1) { // Text frame
        try {
          const text = payload.toString('utf8');
          const message = JSON.parse(text);
          if (message && message.event) {
            this.emit(message.event, message.data);
          }
        } catch (err) {
          console.error('Failed to parse WebSocket JSON:', err);
        }
      }
    }
  }

  _sendFrame(opcode, payloadBuffer) {
    if (this.socket.destroyed) return;
    const length = payloadBuffer.length;
    let header;

    if (length <= 125) {
      header = Buffer.alloc(2);
      header[0] = 0x80 | opcode;
      header[1] = length;
    } else if (length <= 65535) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }

    try {
      this.socket.write(Buffer.concat([header, payloadBuffer]));
    } catch {}
  }

  emitEvent(event, data = {}) {
    const jsonStr = JSON.stringify({ event, data });
    this._sendFrame(0x1, Buffer.from(jsonStr, 'utf8'));
  }

  join(room) {
    this.rooms.add(room);
  }

  leave(room) {
    this.rooms.delete(room);
  }

  close() {
    this._sendFrame(0x8, Buffer.alloc(0));
    try { this.socket.end(); } catch {}
    this._handleClose();
  }

  _handleClose() {
    this.emit('close');
  }
}

export class WebSocketServer extends EventEmitter {
  constructor() {
    super();
    this.clients = new Map(); // socketId -> client
    this.userClients = new Map(); // userId -> Set of clients

    // Heartbeat check every 30s
    this.heartbeatInterval = setInterval(() => {
      for (const client of this.clients.values()) {
        if (!client.isAlive) {
          client.close();
          continue;
        }
        client.isAlive = false;
        client._sendFrame(0x9, Buffer.from('ping'));
      }
    }, 30000);
  }

  handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const token = url.searchParams.get('token');
    const authUser = verifyToken(token);
    if (!authUser) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (!key) {
      socket.destroy();
      return;
    }

    const acceptKey = crypto
      .createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64');

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '\r\n'
    ];

    socket.write(headers.join('\r\n'));

    const client = new WebSocketClient(socket, authUser);
    this._onClientConnected(client);

    if (head && head.length > 0) {
      client._handleData(head);
    }
  }

  _onClientConnected(client) {
    const userId = client.user.userId;
    this.clients.set(client.id, client);

    if (!this.userClients.has(userId)) {
      this.userClients.set(userId, new Set());
    }
    this.userClients.get(userId).add(client);

    // Join user's personal room
    client.join(`user:${userId}`);

    // Join all conversation rooms for this user
    const convs = getUserConversations(userId);
    for (const c of convs) {
      client.join(`conv:${c.id}`);
    }

    // Mark online
    updateUserStatus(userId, 'online');
    this.broadcastAll('user:status', { userId, status: 'online' });

    // Setup client event listeners
    this._bindClientEvents(client);

    client.on('close', () => {
      this._onClientDisconnected(client);
    });

    this.emit('connection', client);
  }

  _bindClientEvents(client) {
    const userId = client.user.userId;

    // Send message with Delivery Ack, ReplyTo and Mentions
    client.on('message:send', (data) => {
      try {
        const { conversationId, type, content, fileName, fileSize, replyToId, mentions, clientMsgId } = data;
        const savedMessage = saveMessage({
          conversationId,
          senderId: userId,
          type: type || 'text',
          content,
          fileName,
          fileSize,
          replyToId,
          mentions
        });

        // Send delivery ack back to sender immediately
        client.emitEvent('message:ack', {
          clientMsgId,
          messageId: savedMessage.id,
          conversationId,
          createdAt: savedMessage.createdAt
        });

        // Ensure all members of the conversation are in the room
        const members = getConversationMembers(conversationId);
        for (const m of members) {
          const userSockets = this.userClients.get(m.id);
          if (userSockets) {
            for (const s of userSockets) {
              s.join(`conv:${conversationId}`);
            }
          }
        }

        // Broadcast new message to conversation room
        this.to(`conv:${conversationId}`).emit('message:new', {
          message: savedMessage,
          conversationId
        });
      } catch (err) {
        client.emitEvent('error', { message: err.message });
      }
    });

    // Message recall
    client.on('message:recall', (data) => {
      try {
        const { messageId } = data;
        const result = recallMessage(messageId, userId);
        this.to(`conv:${result.conversationId}`).emit('message:recalled', result);
      } catch (err) {
        client.emitEvent('error', { message: err.message });
      }
    });

    // Message delete
    client.on('message:delete', (data) => {
      try {
        const { messageId } = data;
        const result = deleteMessage(messageId, userId);
        this.to(`conv:${result.conversationId}`).emit('message:deleted', result);
      } catch (err) {
        client.emitEvent('error', { message: err.message });
      }
    });

    // Typing start
    client.on('typing:start', (data) => {
      if (!data || !data.conversationId) return;
      this.to(`conv:${data.conversationId}`).emit('typing:start', {
        conversationId: data.conversationId,
        userId: userId,
        nickname: client.user.nickname || client.user.username
      }, client.id);
    });

    // Typing stop
    client.on('typing:stop', (data) => {
      if (!data || !data.conversationId) return;
      this.to(`conv:${data.conversationId}`).emit('typing:stop', {
        conversationId: data.conversationId,
        userId: userId
      }, client.id);
    });

    // Mark as read
    client.on('message:read', (data) => {
      if (!data || !data.conversationId) return;
      markAsRead(data.conversationId, userId, data.maxMessageId);
      this.to(`conv:${data.conversationId}`).emit('message:read_ack', {
        conversationId: data.conversationId,
        userId: userId,
        maxMessageId: data.maxMessageId
      });
    });

    // Status update (online / away)
    client.on('status:update', (data) => {
      const status = data && data.status ? data.status : 'online';
      updateUserStatus(userId, status);
      this.broadcastAll('user:status', { userId, status });
    });
  }

  _onClientDisconnected(client) {
    this.clients.delete(client.id);
    const userId = client.user.userId;
    const userSockets = this.userClients.get(userId);
    if (userSockets) {
      userSockets.delete(client);
      if (userSockets.size === 0) {
        this.userClients.delete(userId);
        updateUserStatus(userId, 'offline');
        this.broadcastAll('user:status', { userId, status: 'offline' });
      }
    }
  }

  to(room) {
    return {
      emit: (event, data, excludeSocketId = null) => {
        for (const client of this.clients.values()) {
          if (client.rooms.has(room) && client.id !== excludeSocketId) {
            client.emitEvent(event, data);
          }
        }
      }
    };
  }

  broadcastAll(event, data, excludeSocketId = null) {
    for (const client of this.clients.values()) {
      if (client.id !== excludeSocketId) {
        client.emitEvent(event, data);
      }
    }
  }

  notifyUser(userId, event, data) {
    this.to(`user:${userId}`).emit(event, data);
  }

  removeUserFromRoom(userId, room) {
    const userSockets = this.userClients.get(userId);
    if (userSockets) {
      for (const s of userSockets) {
        s.leave(room);
      }
    }
  }

  close() {
    clearInterval(this.heartbeatInterval);
    for (const client of this.clients.values()) {
      client.close();
    }
  }
}
