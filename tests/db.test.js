import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initDatabase, getDb, run, get, all, closeDb } from '../src/db/database.js';

describe('Database Layer Tests', () => {
  const testDbPath = './test-chat.db';

  before(() => {
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
    initDatabase(testDbPath);
  });

  after(() => {
    closeDb();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
  });

  test('should create tables correctly', () => {
    const tables = all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;");
    const tableNames = tables.map(t => t.name);
    assert.ok(tableNames.includes('users'), 'users table should exist');
    assert.ok(tableNames.includes('conversations'), 'conversations table should exist');
    assert.ok(tableNames.includes('conversation_members'), 'conversation_members table should exist');
    assert.ok(tableNames.includes('messages'), 'messages table should exist');
  });

  test('should insert and query a user', () => {
    run(
      'INSERT INTO users (id, username, password_hash, nickname, avatar, bio) VALUES (?, ?, ?, ?, ?, ?)',
      ['u_test_1', 'alice', 'hash_secret', 'Alice Wonder', 'avatar_1.png', 'Hello world']
    );

    const user = get('SELECT * FROM users WHERE id = ?', ['u_test_1']);
    assert.ok(user, 'User should be found');
    assert.equal(user.username, 'alice');
    assert.equal(user.nickname, 'Alice Wonder');
    assert.equal(user.avatar, 'avatar_1.png');
    assert.equal(user.status, 'offline');
  });

  test('should insert conversation, member, and message', () => {
    // Add another user
    run(
      'INSERT INTO users (id, username, password_hash, nickname) VALUES (?, ?, ?, ?)',
      ['u_test_2', 'bob', 'hash_bob', 'Bob Builder']
    );

    // Create conversation
    run(
      'INSERT INTO conversations (id, type, name, creator_id) VALUES (?, ?, ?, ?)',
      ['conv_1', 'direct', null, 'u_test_1']
    );

    // Add members
    run(
      'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)',
      ['conv_1', 'u_test_1', 'owner']
    );
    run(
      'INSERT INTO conversation_members (conversation_id, user_id, role) VALUES (?, ?, ?)',
      ['conv_1', 'u_test_2', 'member']
    );

    // Add message
    const msgRes = run(
      'INSERT INTO messages (conversation_id, sender_id, type, content) VALUES (?, ?, ?, ?)',
      ['conv_1', 'u_test_1', 'text', 'Hello Bob!']
    );
    assert.ok(msgRes.changes > 0, 'Message should be inserted');

    // Query messages
    const msgs = all('SELECT * FROM messages WHERE conversation_id = ?', ['conv_1']);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].content, 'Hello Bob!');
    assert.equal(msgs[0].sender_id, 'u_test_1');
  });
});
