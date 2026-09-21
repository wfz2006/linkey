import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initDatabase, closeDb } from '../src/db/database.js';
import {
  hashPassword,
  verifyPassword,
  createToken,
  verifyToken,
  register,
  login,
  getUserById,
  searchUsers,
  updateUserProfile,
  updateUserStatus
} from '../src/services/authService.js';

describe('Auth Service Tests', () => {
  const testDbPath = './test-auth.db';

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

  test('should hash and verify passwords correctly', () => {
    const password = 'mySecretPassword123';
    const hash = hashPassword(password);
    assert.ok(hash.includes(':'), 'Hash format should be salt:derivedKey');
    assert.ok(verifyPassword(password, hash), 'Correct password should verify');
    assert.ok(!verifyPassword('wrongPassword', hash), 'Wrong password should fail');
  });

  test('should create and verify JWT tokens correctly', () => {
    const payload = { userId: 'u_123', username: 'john' };
    const token = createToken(payload);
    assert.ok(token.split('.').length === 3, 'JWT should have 3 parts');

    const decoded = verifyToken(token);
    assert.ok(decoded, 'Decoded token should exist');
    assert.equal(decoded.userId, 'u_123');
    assert.equal(decoded.username, 'john');

    // Invalid signature token
    const invalidToken = token + 'tampered';
    assert.equal(verifyToken(invalidToken), null, 'Tampered token should return null');
  });

  test('should register a new user successfully', () => {
    const res = register({
      username: 'alice',
      password: 'password123',
      nickname: 'Alice W.',
      avatar: 'avatar.png',
      bio: 'Developer'
    });

    assert.ok(res.user, 'User object should be returned');
    assert.equal(res.user.username, 'alice');
    assert.equal(res.user.nickname, 'Alice W.');
    assert.equal(res.user.bio, 'Developer');
    assert.ok(!res.user.password_hash, 'password_hash should never be exposed');
    assert.ok(res.token, 'Token should be returned');
  });

  test('should reject duplicate registration', () => {
    assert.throws(
      () => {
        register({
          username: 'alice',
          password: 'anotherPassword',
          nickname: 'Alice Clone'
        });
      },
      /已被注册/
    );
  });

  test('should login registered user successfully and reject invalid password', () => {
    // Correct login
    const loginRes = login({ username: 'alice', password: 'password123' });
    assert.ok(loginRes.token);
    assert.equal(loginRes.user.username, 'alice');

    // Invalid password
    assert.throws(
      () => {
        login({ username: 'alice', password: 'wrongPassword' });
      },
      /用户名或密码错误/
    );
  });

  test('should search users and update profile/status', () => {
    // Register second user
    const bob = register({
      username: 'bob_dev',
      password: 'password123',
      nickname: 'Bob The Builder'
    });

    const searchResults = searchUsers('bob');
    assert.equal(searchResults.length, 1);
    assert.equal(searchResults[0].username, 'bob_dev');

    // Update profile
    const updatedBob = updateUserProfile(bob.user.id, {
      nickname: 'Bob Senior',
      bio: 'Building dreams'
    });
    assert.equal(updatedBob.nickname, 'Bob Senior');
    assert.equal(updatedBob.bio, 'Building dreams');

    // Update status
    const statusBob = updateUserStatus(bob.user.id, 'online');
    assert.equal(statusBob.status, 'online');
  });
});
