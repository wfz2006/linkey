import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { initDatabase, closeDb } from '../src/db/database.js';
import { register } from '../src/services/authService.js';
import {
  getOrCreateDirectConversation,
  createGroupConversation,
  getUserConversations,
  getConversationById,
  saveMessage,
  getMessages,
  markAsRead,
  getConversationMembers
} from '../src/services/chatService.js';

describe('Chat Service Tests', () => {
  const testDbPath = './test-chat-service.db';
  let userA, userB, userC;

  before(() => {
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
    initDatabase(testDbPath);

    userA = register({ username: 'usera', password: 'password', nickname: 'Alice' }).user;
    userB = register({ username: 'userb', password: 'password', nickname: 'Bob' }).user;
    userC = register({ username: 'userc', password: 'password', nickname: 'Charlie' }).user;
  });

  after(() => {
    closeDb();
    if (fs.existsSync(testDbPath)) {
      try { fs.unlinkSync(testDbPath); } catch {}
    }
  });

  test('should create and retrieve 1-on-1 direct conversation idempotently', () => {
    const dm1 = getOrCreateDirectConversation(userA.id, userB.id);
    assert.ok(dm1.id.startsWith('dm_'));
    assert.equal(dm1.type, 'direct');
    assert.equal(dm1.name, 'Bob', 'From Alice perspective, DM name should be Bob');
    assert.equal(dm1.peerUser.id, userB.id);

    // Call from Bob's perspective
    const dm2 = getOrCreateDirectConversation(userB.id, userA.id);
    assert.equal(dm1.id, dm2.id, 'Should return same DM conversation ID');
    assert.equal(dm2.name, 'Alice', 'From Bob perspective, DM name should be Alice');
  });

  test('should create group conversation with multiple members', () => {
    const group = createGroupConversation(userA.id, 'Project Alpha', [userB.id, userC.id]);
    assert.ok(group.id.startsWith('grp_'));
    assert.equal(group.type, 'group');
    assert.equal(group.name, 'Project Alpha');
    assert.equal(group.memberCount, 3);

    const members = getConversationMembers(group.id);
    assert.equal(members.length, 3);
    const owner = members.find(m => m.role === 'owner');
    assert.equal(owner.id, userA.id);
  });

  test('should send message, update unread count, and mark as read', () => {
    const dm = getOrCreateDirectConversation(userA.id, userB.id);

    // Alice sends 2 messages to Bob
    const m1 = saveMessage({
      conversationId: dm.id,
      senderId: userA.id,
      type: 'text',
      content: 'Hey Bob!'
    });
    const m2 = saveMessage({
      conversationId: dm.id,
      senderId: userA.id,
      type: 'text',
      content: 'Are you ready for the meeting?'
    });

    // Check Bob's conversations list
    const bobConvs = getUserConversations(userB.id);
    const bobDm = bobConvs.find(c => c.id === dm.id);
    assert.equal(bobDm.unreadCount, 2, 'Bob should have 2 unread messages');
    assert.equal(bobDm.lastMessagePreview, 'Are you ready for the meeting?');

    // Alice's unread count should be 0 for her own messages
    const aliceConvs = getUserConversations(userA.id);
    const aliceDm = aliceConvs.find(c => c.id === dm.id);
    assert.equal(aliceDm.unreadCount, 0);

    // Bob marks as read
    markAsRead(dm.id, userB.id, m2.id);

    const bobConvsAfter = getUserConversations(userB.id);
    const bobDmAfter = bobConvsAfter.find(c => c.id === dm.id);
    assert.equal(bobDmAfter.unreadCount, 0, 'Unread count should be 0 after reading');
  });

  test('should retrieve message history in chronological order with sender details', () => {
    const dm = getOrCreateDirectConversation(userA.id, userB.id);

    // Bob replies
    saveMessage({
      conversationId: dm.id,
      senderId: userB.id,
      type: 'text',
      content: 'Yes, I am ready!'
    });

    const messages = getMessages(dm.id, 10);
    assert.equal(messages.length, 3);
    assert.equal(messages[0].content, 'Hey Bob!');
    assert.equal(messages[1].content, 'Are you ready for the meeting?');
    assert.equal(messages[2].content, 'Yes, I am ready!');
    assert.equal(messages[2].sender.nickname, 'Bob');
  });
});
