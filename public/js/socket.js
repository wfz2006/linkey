// WebSocket Client Manager for Realtime Communication

export class SocketClient {
  constructor() {
    this.ws = null;
    this.token = null;
    this.listeners = new Map();
    this.reconnectTimer = null;
    this.isConnected = false;
    this.isExplicitlyClosed = false;
    this.hasConnectedOnce = false;
  }

  connect(token) {
    this.token = token;
    this.isExplicitlyClosed = false;

    if (this.ws) {
      try { this.ws.close(); } catch {}
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws?token=${encodeURIComponent(token)}`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.isConnected = true;
      const isReconnection = this.hasConnectedOnce;
      this.hasConnectedOnce = true;
      
      this._emit('connect', { isReconnection });
      if (isReconnection) {
        this._emit('reconnected');
      }

      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload && payload.event) {
          this._emit(payload.event, payload.data);
        }
      } catch (err) {
        console.error('Failed to parse incoming WebSocket message:', err);
      }
    };

    this.ws.onclose = () => {
      this.isConnected = false;
      this._emit('disconnect');
      if (!this.isExplicitlyClosed) {
        this._scheduleReconnect();
      }
    };

    this.ws.onerror = (err) => {
      this._emit('error', err);
    };
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.token && !this.isExplicitlyClosed) {
        this.connect(this.token);
      }
    }, 2500);
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(callback);
    }
  }

  _emit(event, data) {
    if (this.listeners.has(event)) {
      for (const callback of this.listeners.get(event)) {
        try {
          callback(data);
        } catch (err) {
          console.error(`Error in event listener for ${event}:`, err);
        }
      }
    }
  }

  send(event, data = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn(`Cannot send event ${event}: WebSocket is not open.`);
      return false;
    }
    this.ws.send(JSON.stringify({ event, data }));
    return true;
  }

  // Convenience methods
  sendMessage(conversationId, type, content, fileName = null, fileSize = null, replyToId = null, mentions = [], clientMsgId = null) {
    return this.send('message:send', {
      conversationId,
      type,
      content,
      fileName,
      fileSize,
      replyToId,
      mentions,
      clientMsgId: clientMsgId || `cmsg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
    });
  }

  recallMessage(messageId) {
    return this.send('message:recall', { messageId });
  }

  deleteMessage(messageId) {
    return this.send('message:delete', { messageId });
  }

  sendTypingStart(conversationId) {
    return this.send('typing:start', { conversationId });
  }

  sendTypingStop(conversationId) {
    return this.send('typing:stop', { conversationId });
  }

  markRead(conversationId, maxMessageId) {
    return this.send('message:read', { conversationId, maxMessageId });
  }

  updateStatus(status) {
    return this.send('status:update', { status });
  }

  disconnect() {
    this.isExplicitlyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.isConnected = false;
  }
}

export const socketClient = new SocketClient();
