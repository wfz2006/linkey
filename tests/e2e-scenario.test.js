import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { createServer, wsServer } from '../src/server.js';
import { closeDb } from '../src/db/database.js';

describe('End-to-End Multi-User IM Journey Tests', () => {
  const testDbPath = './test-e2e.db';
  let server;
  let port;
  let baseUrl;

  before(async () => {
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
    server = await createServer(0, testDbPath);
    port = server.address().port;
    baseUrl = `http://localhost:${port}`;
  });

  after(async () => {
    wsServer.close();
    await new Promise((resolve) => server.close(resolve));
    closeDb();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
  });

  function apiCall(method, path, body = null, token = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, baseUrl);
      const headers = { 'Content-Type': 'application/json' };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const req = http.request(url, { method, headers }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, text: data });
          }
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  function connectWebSocket(token) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64');
      const socket = net.createConnection({ port, host: 'localhost' }, () => {
        socket.write([
          `GET /ws?token=${token} HTTP/1.1`,
          `Host: localhost:${port}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '\r\n'
        ].join('\r\n'));
      });

      let upgraded = false;
      const listeners = [];

      socket.on('data', (data) => {
        if (!upgraded) {
          const str = data.toString('utf8');
          if (str.includes('101 Switching Protocols')) {
            upgraded = true;
            resolve({
              send: (event, payload) => {
                const json = JSON.stringify({ event, data: payload });
                const payloadBuf = Buffer.from(json, 'utf8');
                const mask = crypto.randomBytes(4);
                const masked = Buffer.alloc(payloadBuf.length);
                for (let i = 0; i < payloadBuf.length; i++) {
                  masked[i] = payloadBuf[i] ^ mask[i % 4];
                }

                let header;
                if (payloadBuf.length <= 125) {
                  header = Buffer.alloc(2);
                  header[0] = 0x81;
                  header[1] = 0x80 | payloadBuf.length;
                } else {
                  header = Buffer.alloc(4);
                  header[0] = 0x81;
                  header[1] = 0x80 | 126;
                  header.writeUInt16BE(payloadBuf.length, 2);
                }

                socket.write(Buffer.concat([header, mask, masked]));
              },
              onMessage: (cb) => {
                listeners.push(cb);
              },
              close: () => socket.end()
            });
          }
        } else {
          // Parse WebSocket frames
          if (data[0] === 0x81) {
            let len = data[1] & 0x7f;
            let offset = 2;
            if (len === 126) {
              len = data.readUInt16BE(2);
              offset = 4;
            }
            const text = data.subarray(offset, offset + len).toString('utf8');
            try {
              const parsed = JSON.parse(text);
              for (const cb of listeners) cb(parsed);
            } catch {}
          }
        }
      });

      socket.on('error', reject);
    });
  }

  test('full multi-user journey: register, direct chat, group chat, real-time message broadcasting', async () => {
    // 1. Register 3 users
    const regAlice = await apiCall('POST', '/api/auth/register', { username: 'alice_e2e', password: 'password', nickname: 'Alice' });
    const regBob = await apiCall('POST', '/api/auth/register', { username: 'bob_e2e', password: 'password', nickname: 'Bob' });
    const regCharlie = await apiCall('POST', '/api/auth/register', { username: 'charlie_e2e', password: 'password', nickname: 'Charlie' });

    assert.equal(regAlice.status, 200);
    assert.equal(regBob.status, 200);
    assert.equal(regCharlie.status, 200);

    const aliceToken = regAlice.data.token;
    const bobToken = regBob.data.token;
    const charlieToken = regCharlie.data.token;

    // 2. Alice creates direct conversation with Bob
    const dmRes = await apiCall('POST', '/api/conversations/direct', { targetUserId: regBob.data.user.id }, aliceToken);
    assert.equal(dmRes.status, 200);
    const dmId = dmRes.data.conversation.id;

    // 3. Connect Alice & Bob via WebSocket
    const wsAlice = await connectWebSocket(aliceToken);
    const wsBob = await connectWebSocket(bobToken);

    // 4. Test DM real-time messaging
    const bobMsgPromise = new Promise((resolve) => {
      wsBob.onMessage((msg) => {
        if (msg.event === 'message:new') resolve(msg.data);
      });
    });

    wsAlice.send('message:send', {
      conversationId: dmId,
      type: 'text',
      content: 'Hello Bob! This is E2E test'
    });

    const receivedBob = await bobMsgPromise;
    assert.equal(receivedBob.conversationId, dmId);
    assert.equal(receivedBob.message.content, 'Hello Bob! This is E2E test');

    // 5. Test Group Chat Creation
    const groupRes = await apiCall('POST', '/api/conversations/group', {
      name: 'Team Hackathon',
      memberIds: [regBob.data.user.id, regCharlie.data.user.id]
    }, aliceToken);
    assert.equal(groupRes.status, 200);
    const groupId = groupRes.data.conversation.id;

    // Connect Charlie via WebSocket
    const wsCharlie = await connectWebSocket(charlieToken);

    // 6. Charlie sends message to Group -> Both Alice and Bob should receive it!
    const aliceGroupMsgPromise = new Promise((resolve) => {
      wsAlice.onMessage((msg) => {
        if (msg.event === 'message:new' && msg.data.conversationId === groupId) {
          resolve(msg.data);
        }
      });
    });

    const bobGroupMsgPromise = new Promise((resolve) => {
      wsBob.onMessage((msg) => {
        if (msg.event === 'message:new' && msg.data.conversationId === groupId) {
          resolve(msg.data);
        }
      });
    });

    wsCharlie.send('message:send', {
      conversationId: groupId,
      type: 'text',
      content: 'Hi Team from Charlie!'
    });

    const [aliceReceived, bobReceived] = await Promise.all([aliceGroupMsgPromise, bobGroupMsgPromise]);
    assert.equal(aliceReceived.message.content, 'Hi Team from Charlie!');
    assert.equal(bobReceived.message.content, 'Hi Team from Charlie!');

    wsAlice.close();
    wsBob.close();
    wsCharlie.close();
  });
});
