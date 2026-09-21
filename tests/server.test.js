import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { createServer, wsServer } from '../src/server.js';
import { closeDb } from '../src/db/database.js';

describe('HTTP & WebSocket Server Tests', () => {
  const testDbPath = './test-server.db';
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

  function makeRequest(method, path, body = null, token = null) {
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

  let userA, tokenA;
  let userB, tokenB;
  let directConvId;

  test('should register and login users via HTTP API', async () => {
    const regA = await makeRequest('POST', '/api/auth/register', {
      username: 'alice_server',
      password: 'password123',
      nickname: 'Alice Server'
    });
    assert.equal(regA.status, 200);
    assert.ok(regA.data.token);
    userA = regA.data.user;
    tokenA = regA.data.token;

    const regB = await makeRequest('POST', '/api/auth/register', {
      username: 'bob_server',
      password: 'password123',
      nickname: 'Bob Server'
    });
    assert.equal(regB.status, 200);
    userB = regB.data.user;
    tokenB = regB.data.token;
  });

  test('should search users and create DM conversation', async () => {
    const searchRes = await makeRequest('GET', '/api/users/search?q=bob', null, tokenA);
    assert.equal(searchRes.status, 200);
    assert.equal(searchRes.data.users.length, 1);
    assert.equal(searchRes.data.users[0].username, 'bob_server');

    const convRes = await makeRequest('POST', '/api/conversations/direct', {
      targetUserId: userB.id
    }, tokenA);
    assert.equal(convRes.status, 200);
    assert.ok(convRes.data.conversation.id);
    directConvId = convRes.data.conversation.id;
  });

  test('should connect via WebSocket and exchange real-time messages', async () => {
    // Helper to create WebSocket connection
    function connectWS(token) {
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
        const messages = [];

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
                  socket.on('data', (chunk) => {
                    if (chunk[0] === 0x81) {
                      let len = chunk[1] & 0x7f;
                      let offset = 2;
                      if (len === 126) {
                        len = chunk.readUInt16BE(2);
                        offset = 4;
                      }
                      const text = chunk.subarray(offset, offset + len).toString('utf8');
                      try {
                        cb(JSON.parse(text));
                      } catch {}
                    }
                  });
                },
                close: () => socket.end()
              });
            }
          }
        });

        socket.on('error', reject);
      });
    }

    const wsAlice = await connectWS(tokenA);
    const wsBob = await connectWS(tokenB);

    const receivedMessagePromise = new Promise((resolve) => {
      wsBob.onMessage((msg) => {
        if (msg.event === 'message:new') {
          resolve(msg.data);
        }
      });
    });

    // Alice sends message over WebSocket
    wsAlice.send('message:send', {
      conversationId: directConvId,
      type: 'text',
      content: 'Realtime Hello from Alice to Bob!'
    });

    const received = await receivedMessagePromise;
    assert.equal(received.conversationId, directConvId);
    assert.equal(received.message.content, 'Realtime Hello from Alice to Bob!');
    assert.equal(received.message.sender.nickname, 'Alice Server');

    wsAlice.close();
    wsBob.close();
  });
});
