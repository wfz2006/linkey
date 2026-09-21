// API Client for REST requests

const TOKEN_KEY = 'chat_auth_token';
const USER_KEY = 'chat_auth_user';

export const api = {
  getToken() {
    return localStorage.getItem(TOKEN_KEY);
  },

  getCurrentUser() {
    const raw = localStorage.getItem(USER_KEY);
    try {
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },

  setAuth(token, user) {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
  },

  clearAuth() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  },

  async request(endpoint, options = {}) {
    const token = this.getToken();
    const headers = {
      ...(options.headers || {})
    };

    if (token && !headers['Authorization']) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    if (options.body && !(options.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }

    const response = await fetch(endpoint, {
      ...options,
      headers
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || `Request failed with status ${response.status}`);
    }

    return data;
  },

  // Auth & Quick Login endpoints
  async getQuickUsers() {
    const res = await this.request('/api/auth/quick-users');
    return res.users || [];
  },

  async quickLogin(username) {
    const res = await this.request('/api/auth/quick-login', {
      method: 'POST',
      body: { username }
    });
    this.setAuth(res.token, res.user);
    return res;
  },

  async register(username, password, nickname, avatar, bio) {
    const res = await this.request('/api/auth/register', {
      method: 'POST',
      body: { username, password, nickname, avatar, bio }
    });
    this.setAuth(res.token, res.user);
    return res;
  },

  async login(username, password) {
    const res = await this.request('/api/auth/login', {
      method: 'POST',
      body: { username, password }
    });
    this.setAuth(res.token, res.user);
    return res;
  },

  async getMe() {
    const res = await this.request('/api/auth/me');
    if (res.user) {
      localStorage.setItem(USER_KEY, JSON.stringify(res.user));
    }
    return res.user;
  },

  async changePassword(oldPassword, newPassword) {
    return await this.request('/api/auth/change-password', {
      method: 'POST',
      body: { oldPassword, newPassword }
    });
  },

  async deleteAccount(password) {
    return await this.request('/api/auth/delete-account', {
      method: 'POST',
      body: { password }
    });
  },

  // Friendship endpoints
  async getFriends() {
    const res = await this.request('/api/friends');
    return res.friends || [];
  },

  async getFriendRequests() {
    const res = await this.request('/api/friends/requests');
    return res || { incoming: [], outgoing: [] };
  },

  async sendFriendRequest(targetUserId, message = '') {
    return await this.request('/api/friends/requests', {
      method: 'POST',
      body: { targetUserId, message }
    });
  },

  async respondFriendRequest(requestId, action) {
    return await this.request(`/api/friends/requests/${requestId}/respond`, {
      method: 'POST',
      body: { action }
    });
  },

  async updateFriendRemark(friendId, remark, groupName) {
    return await this.request(`/api/friends/${friendId}/remark`, {
      method: 'PUT',
      body: { remark, groupName }
    });
  },

  async deleteFriend(friendId) {
    return await this.request(`/api/friends/${friendId}`, {
      method: 'DELETE'
    });
  },

  async toggleBlockUser(friendId, isBlocked = true) {
    return await this.request(`/api/friends/${friendId}/block`, {
      method: 'POST',
      body: { isBlocked }
    });
  },

  // User endpoints
  async getUserProfile(userId) {
    const res = await this.request(`/api/users/${userId}`);
    return res.user || null;
  },

  async searchUsers(query) {
    const res = await this.request(`/api/users/search?q=${encodeURIComponent(query)}`);
    return res.users || [];
  },

  async updateProfile(profile) {
    const res = await this.request('/api/users/profile', {
      method: 'POST',
      body: profile
    });
    if (res.user) {
      localStorage.setItem(USER_KEY, JSON.stringify(res.user));
    }
    return res.user;
  },

  // Conversation endpoints
  async getConversations() {
    const res = await this.request('/api/conversations');
    return res.conversations || [];
  },

  async createDirectChat(targetUserId) {
    const res = await this.request('/api/conversations/direct', {
      method: 'POST',
      body: { targetUserId }
    });
    return res.conversation;
  },

  async createGroupChat(name, memberIds, avatar) {
    const res = await this.request('/api/conversations/group', {
      method: 'POST',
      body: { name, memberIds, avatar }
    });
    return res.conversation;
  },

  async togglePinConversation(conversationId, isPinned = true) {
    const res = await this.request(`/api/conversations/${conversationId}/pin`, {
      method: 'POST',
      body: { isPinned }
    });
    return res.conversation;
  },

  async clearConversation(conversationId) {
    return await this.request(`/api/conversations/${conversationId}/clear`, {
      method: 'POST'
    });
  },

  async markConversationAsRead(conversationId) {
    return await this.request(`/api/conversations/${conversationId}/read`, {
      method: 'POST'
    });
  },

  async updateGroupInfo(conversationId, data) {
    const res = await this.request(`/api/conversations/${conversationId}`, {
      method: 'PUT',
      body: data
    });
    return res.conversation;
  },

  async kickGroupMember(conversationId, targetUserId) {
    return await this.request(`/api/conversations/${conversationId}/members/${targetUserId}`, {
      method: 'DELETE'
    });
  },

  async leaveGroup(conversationId) {
    return await this.request(`/api/conversations/${conversationId}/leave`, {
      method: 'POST'
    });
  },

  async toggleMuteMember(conversationId, targetUserId, isMuted = true) {
    return await this.request(`/api/conversations/${conversationId}/members/${targetUserId}/mute`, {
      method: 'POST',
      body: { isMuted }
    });
  },

  async getMessages(conversationId, limit = 50, before = null) {
    let url = `/api/conversations/${conversationId}/messages?limit=${limit}`;
    if (before) url += `&before=${before}`;
    const res = await this.request(url);
    return res.messages || [];
  },

  async recallMessage(messageId) {
    return await this.request(`/api/messages/${messageId}/recall`, {
      method: 'POST'
    });
  },

  async deleteMessage(messageId) {
    return await this.request(`/api/messages/${messageId}`, {
      method: 'DELETE'
    });
  },

  async searchMessages(query, conversationId = null) {
    let url = `/api/messages/search?q=${encodeURIComponent(query)}`;
    if (conversationId) url += `&conversationId=${encodeURIComponent(conversationId)}`;
    const res = await this.request(url);
    return res.messages || [];
  },

  async getConversationMembers(conversationId) {
    const res = await this.request(`/api/conversations/${conversationId}/members`);
    return res.members || [];
  },

  // QQ Zone (空间动态) endpoints
  async getZonePosts(userId = null) {
    let url = '/api/zone/posts';
    if (userId) url += `?userId=${encodeURIComponent(userId)}`;
    const res = await this.request(url);
    return res.posts || [];
  },

  async createZonePost(content, images = []) {
    const res = await this.request('/api/zone/posts', {
      method: 'POST',
      body: { content, images }
    });
    return res.post;
  },

  async toggleLikeZonePost(postId) {
    return await this.request(`/api/zone/posts/${postId}/like`, {
      method: 'POST'
    });
  },

  async deleteZonePost(postId) {
    return await this.request(`/api/zone/posts/${postId}`, {
      method: 'DELETE'
    });
  },

  async addZoneComment(postId, content) {
    const res = await this.request(`/api/zone/posts/${postId}/comments`, {
      method: 'POST',
      body: { content }
    });
    return res.comments || [];
  },

  async deleteZoneComment(commentId) {
    return await this.request(`/api/zone/comments/${commentId}`, {
      method: 'DELETE'
    });
  },

  async getZoneComments(postId) {
    const res = await this.request(`/api/zone/posts/${postId}/comments`);
    return res.comments || [];
  },

  async getGuestbookMessages(hostId) {
    const res = await this.request(`/api/zone/guestbook?hostId=${encodeURIComponent(hostId)}`);
    return res.messages || [];
  },

  async addGuestbookMessage(hostId, content) {
    const res = await this.request('/api/zone/guestbook', {
      method: 'POST',
      body: { hostId, content }
    });
    return res.messages || [];
  },

  async deleteGuestbookMessage(messageId) {
    return await this.request(`/api/zone/guestbook/${messageId}`, {
      method: 'DELETE'
    });
  },

  // Albums & Photos
  async getUserAlbums(userId = null) {
    let url = '/api/zone/albums';
    if (userId) url += `?userId=${encodeURIComponent(userId)}`;
    const res = await this.request(url);
    return res.albums || [];
  },

  async createAlbum(name, description = '') {
    const res = await this.request('/api/zone/albums', {
      method: 'POST',
      body: { name, description }
    });
    return res.album;
  },

  async addPhotoToAlbum(photoData) {
    const res = await this.request('/api/zone/photos', {
      method: 'POST',
      body: photoData
    });
    return res.photo;
  },

  async getUserPhotos(userId = null, albumId = null) {
    let url = '/api/zone/photos?';
    if (userId) url += `userId=${encodeURIComponent(userId)}&`;
    if (albumId) url += `albumId=${encodeURIComponent(albumId)}&`;
    const res = await this.request(url);
    return res.photos || [];
  },

  async deletePhoto(photoId) {
    return await this.request(`/api/zone/photos/${photoId}`, {
      method: 'DELETE'
    });
  },

  async getZonePhotos(userId = null) {
    let url = '/api/zone/photos';
    if (userId) url += `?userId=${encodeURIComponent(userId)}`;
    const res = await this.request(url);
    return res.photos || [];
  },

  // File Upload endpoint
  async uploadFile(file) {
    const formData = new FormData();
    formData.append('file', file);

    const res = await this.request('/api/upload', {
      method: 'POST',
      body: formData
    });
    return res;
  }
};
