import test from 'node:test';
import assert from 'node:assert';
import { initDatabase, closeDb } from '../src/db/database.js';
import { register, login, changePassword, createAlbum, addPhotoToAlbum, getUserAlbums, getUserPhotos, toggleLikeZonePost, createZonePost } from '../src/services/authService.js';
import { sendFriendRequest, getFriendRequests, respondFriendRequest, getFriends, deleteFriend, updateFriendInfo } from '../src/services/friendService.js';
import { getOrCreateDirectConversation, createGroupConversation, saveMessage, getMessages, recallMessage, searchMessages, togglePinConversation, updateGroupInfo, kickGroupMember, toggleMuteMember } from '../src/services/chatService.js';

test('Advanced Friendship, Messaging, and Group Administration Test Suite', async (t) => {
  initDatabase(':memory:');

  // 1. Create two users
  const user1 = register({ username: 'alice', password: 'password123', nickname: '爱丽丝' });
  const user2 = register({ username: 'bob', password: 'password123', nickname: '鲍勃' });
  const user3 = register({ username: 'charlie', password: 'password123', nickname: '查理' });

  await t.test('Friendship lifecycle (Request -> Accept -> List -> Remark -> Delete)', () => {
    // Send request
    const req = sendFriendRequest(user1.user.id, user2.user.id, '你好，我是爱丽丝');
    assert.strictEqual(req.status, 'pending');

    // Check incoming requests for bob
    const bobReqs = getFriendRequests(user2.user.id);
    assert.strictEqual(bobReqs.incoming.length, 1);
    assert.strictEqual(bobReqs.incoming[0].from_user_id, user1.user.id);

    // Accept friend request
    const acceptRes = respondFriendRequest(req.id, user2.user.id, 'accept');
    assert.strictEqual(acceptRes.action, 'accepted');

    // Check friends list
    const aliceFriends = getFriends(user1.user.id);
    assert.strictEqual(aliceFriends.length, 1);
    assert.strictEqual(aliceFriends[0].friend_id, user2.user.id);

    const bobFriends = getFriends(user2.user.id);
    assert.strictEqual(bobFriends.length, 1);
    assert.strictEqual(bobFriends[0].friend_id, user1.user.id);

    // Update friend remark
    const updatedFriend = updateFriendInfo(user1.user.id, user2.user.id, { remark: '小鲍', groupName: '大学同学' });
    assert.strictEqual(updatedFriend.remark, '小鲍');
    assert.strictEqual(updatedFriend.group_name, '大学同学');

    // Delete friend
    deleteFriend(user1.user.id, user2.user.id);
    assert.strictEqual(getFriends(user1.user.id).length, 0);
  });

  await t.test('Advanced Messaging: Quote Reply, Recall, and Search', () => {
    const conv = getOrCreateDirectConversation(user1.user.id, user3.user.id);

    // 1. Send first message
    const msg1 = saveMessage({
      conversationId: conv.id,
      senderId: user1.user.id,
      type: 'text',
      content: '明天的会议时间定在下午两点。'
    });
    assert.ok(msg1.id > 0);

    // 2. Quote reply
    const msg2 = saveMessage({
      conversationId: conv.id,
      senderId: user3.user.id,
      type: 'text',
      content: '收到，准时参加！',
      replyToId: msg1.id
    });
    assert.strictEqual(msg2.replyTo.id, msg1.id);
    assert.strictEqual(msg2.replyTo.content, '明天的会议时间定在下午两点。');

    // 3. Search messages
    const searchRes = searchMessages(user1.user.id, '会议时间');
    assert.strictEqual(searchRes.length, 1);
    assert.strictEqual(searchRes[0].id, msg1.id);

    // 4. Recall message
    const recalled = recallMessage(msg1.id, user1.user.id);
    assert.strictEqual(recalled.messageId, msg1.id);

    const history = getMessages(conv.id);
    const recalledInHistory = history.find(m => m.id === msg1.id);
    assert.strictEqual(recalledInHistory.isRecalled, true);
    assert.strictEqual(recalledInHistory.content, '对方撤回了一条消息');
  });

  await t.test('Group Administration: Notice, Pinning, Kick and Mute', () => {
    const grp = createGroupConversation(user1.user.id, '极速技术群', [user2.user.id, user3.user.id]);
    assert.strictEqual(grp.memberCount, 3);

    // 1. Pin conversation
    const pinned = togglePinConversation(grp.id, user1.user.id, true);
    assert.strictEqual(pinned.isPinned, true);

    // 2. Update notice
    const updatedGrp = updateGroupInfo(grp.id, user1.user.id, { notice: '欢迎大家进群交流技术！' });
    assert.strictEqual(updatedGrp.notice, '欢迎大家进群交流技术！');

    // 3. Mute member
    toggleMuteMember(grp.id, user1.user.id, user2.user.id, true);
    assert.throws(() => {
      saveMessage({
        conversationId: grp.id,
        senderId: user2.user.id,
        content: '禁言中发言'
      });
    }, /禁言/);

    // 4. Kick member and verify kicked member cannot send messages
    const kickRes = kickGroupMember(grp.id, user1.user.id, user2.user.id);
    assert.strictEqual(kickRes.success, true);

    // Kicked member cannot send message
    assert.throws(() => {
      saveMessage({
        conversationId: grp.id,
        senderId: user2.user.id,
        content: '被踢后发消息'
      });
    }, /不是该群成员/);

    // Cannot kick non-member
    assert.throws(() => {
      kickGroupMember(grp.id, user1.user.id, user2.user.id);
    }, /不在该群聊中/);
  });

  await t.test('Photo Albums, Zone Likes Toggle and Password Change', () => {
    // 1. Create album and add photo
    const album = createAlbum(user1.user.id, '旅行相册', '云南之旅');
    assert.strictEqual(album.name, '旅行相册');

    const photo = addPhotoToAlbum(user1.user.id, { albumId: album.id, url: '/uploads/travel.jpg', name: '苍山洱海' });
    assert.strictEqual(photo.name, '苍山洱海');

    const albums = getUserAlbums(user1.user.id);
    assert.strictEqual(albums.length, 1);
    assert.strictEqual(albums[0].photo_count, 1);

    // 2. Zone Post Like Toggle
    const post = createZonePost(user1.user.id, '今天天气真好！');
    const likeRes1 = toggleLikeZonePost(post.id, user2.user.id);
    assert.strictEqual(likeRes1.hasLiked, true);
    assert.strictEqual(likeRes1.likesCount, 1);

    const likeRes2 = toggleLikeZonePost(post.id, user2.user.id);
    assert.strictEqual(likeRes2.hasLiked, false);
    assert.strictEqual(likeRes2.likesCount, 0);

    // 3. Change password
    const pwdRes = changePassword(user1.user.id, 'password123', 'newpassword888');
    assert.strictEqual(pwdRes.success, true);

    const loginRes = login({ username: 'alice', password: 'newpassword888' });
    assert.ok(loginRes.token);
  });

  closeDb();
});
