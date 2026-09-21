import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

let dbInstance = null;

export function initDatabase(dbPath = './qq_chat.db') {
  if (dbInstance) {
    return dbInstance;
  }

  if (dbPath !== ':memory:') {
    const dir = path.dirname(path.resolve(dbPath));
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  dbInstance = new DatabaseSync(dbPath);

  // Enable foreign keys
  dbInstance.exec(`PRAGMA foreign_keys = ON;`);

  // Initialize schema
  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      nickname TEXT NOT NULL,
      avatar TEXT,
      bio TEXT DEFAULT '',
      qq_number TEXT,
      qq_level INTEGER DEFAULT 18,
      status TEXT DEFAULT 'offline',
      last_seen TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Auto-migrate missing columns if users table was created previously
  try {
    const cols = dbInstance.prepare(`PRAGMA table_info(users)`).all();
    const colNames = new Set(cols.map(c => c.name));
    if (!colNames.has('qq_number')) {
      dbInstance.exec(`ALTER TABLE users ADD COLUMN qq_number TEXT;`);
    }
    if (!colNames.has('qq_level')) {
      dbInstance.exec(`ALTER TABLE users ADD COLUMN qq_level INTEGER DEFAULT 18;`);
    }
    if (!colNames.has('cover_theme')) {
      dbInstance.exec(`ALTER TABLE users ADD COLUMN cover_theme TEXT DEFAULT 'aurora';`);
    }
    if (!colNames.has('tags')) {
      dbInstance.exec(`ALTER TABLE users ADD COLUMN tags TEXT DEFAULT '["极客", "乐在沟通", "QQ常驻"]';`);
    }
    if (!colNames.has('qzone_visitors')) {
      dbInstance.exec(`ALTER TABLE users ADD COLUMN qzone_visitors INTEGER DEFAULT 128;`);
    }
    if (!colNames.has('qzone_yellow_diamond')) {
      dbInstance.exec(`ALTER TABLE users ADD COLUMN qzone_yellow_diamond INTEGER DEFAULT 6;`);
    }
  } catch (err) {
    console.warn('Migration note (users):', err.message);
  }

  dbInstance.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK(type IN ('direct', 'group')),
      name TEXT,
      avatar TEXT,
      creator_id TEXT,
      notice TEXT DEFAULT '',
      last_message_preview TEXT DEFAULT '',
      last_message_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT DEFAULT 'member' CHECK(role IN ('owner', 'admin', 'member')),
      last_read_message_id INTEGER DEFAULT 0,
      is_pinned INTEGER DEFAULT 0,
      is_muted INTEGER DEFAULT 0,
      joined_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (conversation_id, user_id),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      type TEXT DEFAULT 'text' CHECK(type IN ('text', 'image', 'file', 'system', 'poke', 'recalled')),
      content TEXT NOT NULL,
      file_name TEXT,
      file_size INTEGER,
      is_recalled INTEGER DEFAULT 0,
      reply_to_id INTEGER,
      mentions TEXT DEFAULT '[]',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS friends (
      user_id TEXT NOT NULL,
      friend_id TEXT NOT NULL,
      remark TEXT DEFAULT '',
      group_name TEXT DEFAULT '我的好友',
      is_blocked INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, friend_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS friend_requests (
      id TEXT PRIMARY KEY,
      from_user_id TEXT NOT NULL,
      to_user_id TEXT NOT NULL,
      message TEXT DEFAULT '',
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected')),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (from_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (to_user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_albums (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      cover_url TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_photos (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      album_id TEXT,
      url TEXT NOT NULL,
      name TEXT DEFAULT '',
      size INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (album_id) REFERENCES user_albums(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS zone_posts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      images TEXT DEFAULT '[]',
      likes_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS zone_comments (
      id TEXT PRIMARY KEY,
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (post_id) REFERENCES zone_posts(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS zone_guestbook (
      id TEXT PRIMARY KEY,
      host_id TEXT NOT NULL,
      author_id TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (host_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS zone_visitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host_id TEXT NOT NULL,
      visitor_id TEXT NOT NULL,
      visited_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (host_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (visitor_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS zone_likes (
      post_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (post_id, user_id),
      FOREIGN KEY (post_id) REFERENCES zone_posts(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_conv_members_user ON conversation_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_conv_last_msg ON conversations(last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_friends_user ON friends(user_id, group_name);
    CREATE INDEX IF NOT EXISTS idx_friend_req_to ON friend_requests(to_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_user_photos_user ON user_photos(user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_zone_comments_post ON zone_comments(post_id, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_zone_guestbook_host ON zone_guestbook(host_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_zone_visitors_host ON zone_visitors(host_id, visited_at DESC);
  `);

  // Auto-migrate missing columns for existing tables
  try {
    const convCols = new Set(dbInstance.prepare(`PRAGMA table_info(conversations)`).all().map(c => c.name));
    if (!convCols.has('notice')) dbInstance.exec(`ALTER TABLE conversations ADD COLUMN notice TEXT DEFAULT '';`);

    const memberCols = new Set(dbInstance.prepare(`PRAGMA table_info(conversation_members)`).all().map(c => c.name));
    if (!memberCols.has('is_pinned')) dbInstance.exec(`ALTER TABLE conversation_members ADD COLUMN is_pinned INTEGER DEFAULT 0;`);
    if (!memberCols.has('is_muted')) dbInstance.exec(`ALTER TABLE conversation_members ADD COLUMN is_muted INTEGER DEFAULT 0;`);

    const msgCols = new Set(dbInstance.prepare(`PRAGMA table_info(messages)`).all().map(c => c.name));
    if (!msgCols.has('is_recalled')) dbInstance.exec(`ALTER TABLE messages ADD COLUMN is_recalled INTEGER DEFAULT 0;`);
    if (!msgCols.has('reply_to_id')) dbInstance.exec(`ALTER TABLE messages ADD COLUMN reply_to_id INTEGER;`);
    if (!msgCols.has('mentions')) dbInstance.exec(`ALTER TABLE messages ADD COLUMN mentions TEXT DEFAULT '[]';`);
  } catch (err) {
    console.warn('Migration note (dynamic cols):', err.message);
  }

  return dbInstance;
}

export function getDb() {
  if (!dbInstance) {
    throw new Error('Database is not initialized. Call initDatabase() first.');
  }
  return dbInstance;
}

export function run(sql, params = []) {
  const db = getDb();
  const stmt = db.prepare(sql);
  const result = stmt.run(...params);
  return {
    changes: result.changes,
    lastInsertRowid: result.lastInsertRowid
  };
}

export function get(sql, params = []) {
  const db = getDb();
  const stmt = db.prepare(sql);
  return stmt.get(...params);
}

export function all(sql, params = []) {
  const db = getDb();
  const stmt = db.prepare(sql);
  return stmt.all(...params);
}

export function exec(sql) {
  const db = getDb();
  return db.exec(sql);
}

export function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
