const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const openDb = require('./db');

const SESSION_DAYS = 30;
const POST_MAX = 280;
const DM_MAX = 1000;
const PAGE = 30;

// ---------- password + session helpers ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}
function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':').map((s) => Buffer.from(s, 'hex'));
  return crypto.timingSafeEqual(hash, crypto.scryptSync(password, salt, 64));
}
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
function readCookie(header, name) {
  for (const part of (header || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function createServer({ dbFile = ':memory:', secureCookies = false } = {}) {
  const db = openDb(dbFile);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));

  const fail = (res, code, error) => res.status(code).json({ error });

  function userFromCookie(cookieHeader) {
    const token = readCookie(cookieHeader, 'sid');
    if (!token) return null;
    return db
      .prepare(
        `SELECT u.id, u.username, u.display_name AS displayName, u.bio
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`
      )
      .get(sha256(token), Date.now());
  }

  function startSession(res, userId) {
    const token = crypto.randomBytes(32).toString('hex');
    const maxAge = SESSION_DAYS * 86400;
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
      sha256(token), userId, Date.now() + maxAge * 1000
    );
    res.setHeader(
      'Set-Cookie',
      `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secureCookies ? '; Secure' : ''}`
    );
  }

  // ---------- real-time push ----------
  const sockets = new Map(); // userId -> Set<WebSocket>
  function push(userId, payload) {
    const data = JSON.stringify(payload);
    for (const ws of sockets.get(userId) || []) if (ws.readyState === 1) ws.send(data);
  }

  // ---------- middleware ----------
  const api = express.Router();
  app.use('/api', api);

  // State-changing requests must come from our own frontend (CSRF defence
  // on top of the SameSite cookie).
  api.use((req, res, next) => {
    if (req.method !== 'GET' && req.get('X-Requested-With') !== 'fetch') {
      return fail(res, 403, 'Bad request origin');
    }
    req.user = userFromCookie(req.headers.cookie);
    next();
  });

  const attempts = new Map(); // ip -> { count, reset }
  function authLimiter(req, res, next) {
    const now = Date.now();
    let a = attempts.get(req.ip);
    if (!a || a.reset < now) attempts.set(req.ip, (a = { count: 0, reset: now + 10 * 60_000 }));
    if (++a.count > 50) return fail(res, 429, 'Too many attempts. Try again in a few minutes.');
    next();
  }
  const auth = (req, res, next) => (req.user ? next() : fail(res, 401, 'Not signed in'));

  const unreadCount = (userId) =>
    db.prepare('SELECT COUNT(*) AS n FROM messages WHERE recipient_id = ? AND read_at IS NULL').get(userId).n;
  const findUser = (username) =>
    db.prepare('SELECT id, username, display_name AS displayName, bio, created_at AS createdAt FROM users WHERE username = ?')
      .get(String(username));

  // ---------- auth ----------
  api.post('/signup', authLimiter, (req, res) => {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const displayName = String(req.body.displayName || '').trim().slice(0, 50) || username;
    if (!/^[A-Za-z0-9_]{3,15}$/.test(username)) {
      return fail(res, 400, 'Username must be 3–15 letters, numbers or underscores');
    }
    if (password.length < 8 || password.length > 200) {
      return fail(res, 400, 'Password must be at least 8 characters');
    }
    if (findUser(username)) return fail(res, 409, 'That username is taken');
    const { lastInsertRowid } = db
      .prepare('INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(username, displayName, hashPassword(password), Date.now());
    startSession(res, lastInsertRowid);
    res.status(201).json({ username, displayName, bio: '', unread: 0 });
  });

  api.post('/login', authLimiter, (req, res) => {
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(String(req.body.username || '').trim());
    if (!row || !verifyPassword(String(req.body.password || ''), row.password_hash)) {
      return fail(res, 401, 'Wrong username or password');
    }
    startSession(res, row.id);
    res.json({ username: row.username, displayName: row.display_name, bio: row.bio, unread: unreadCount(row.id) });
  });

  api.post('/logout', (req, res) => {
    const token = readCookie(req.headers.cookie, 'sid');
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  api.get('/me', (req, res) => {
    if (!req.user) return res.json(null);
    const { id, ...me } = req.user;
    res.json({ ...me, unread: unreadCount(id) });
  });

  api.patch('/me', auth, (req, res) => {
    const displayName = String(req.body.displayName || '').trim().slice(0, 50) || req.user.username;
    const bio = String(req.body.bio || '').trim().slice(0, 160);
    db.prepare('UPDATE users SET display_name = ?, bio = ? WHERE id = ?').run(displayName, bio, req.user.id);
    res.json({ username: req.user.username, displayName, bio });
  });

  // ---------- posts ----------
  const POST_SELECT = `
    SELECT p.id, p.body, p.reply_to AS replyTo, p.created_at AS createdAt,
           u.username, u.display_name AS displayName,
           (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS likes,
           (SELECT COUNT(*) FROM posts r WHERE r.reply_to = p.id) AS replies,
           EXISTS(SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = @me) AS liked
    FROM posts p JOIN users u ON u.id = p.user_id`;
  const posts = (where, params) =>
    db.prepare(`${POST_SELECT} WHERE ${where}`).all(params).map((p) => ({ ...p, liked: !!p.liked }));

  api.get('/feed', auth, (req, res) => {
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    const scope =
      req.query.scope === 'explore'
        ? '1'
        : '(p.user_id = @me OR p.user_id IN (SELECT followee_id FROM follows WHERE follower_id = @me))';
    res.json(
      posts(`p.reply_to IS NULL AND p.id < @before AND ${scope} ORDER BY p.id DESC LIMIT ${PAGE}`, {
        me: req.user.id, before,
      })
    );
  });

  api.post('/posts', auth, (req, res) => {
    const body = String(req.body.body || '').trim();
    if (!body) return fail(res, 400, 'Post cannot be empty');
    if ([...body].length > POST_MAX) return fail(res, 400, `Posts are limited to ${POST_MAX} characters`);
    let replyTo = null;
    if (req.body.replyTo != null) {
      replyTo = Number(req.body.replyTo);
      if (!db.prepare('SELECT 1 FROM posts WHERE id = ?').get(replyTo)) return fail(res, 404, 'Post not found');
    }
    const { lastInsertRowid } = db
      .prepare('INSERT INTO posts (user_id, body, reply_to, created_at) VALUES (?, ?, ?, ?)')
      .run(req.user.id, body, replyTo, Date.now());
    res.status(201).json(posts('p.id = @id', { me: req.user.id, id: lastInsertRowid })[0]);
  });

  api.get('/posts/:id', auth, (req, res) => {
    const id = Number(req.params.id);
    const [post] = posts('p.id = @id', { me: req.user.id, id });
    if (!post) return fail(res, 404, 'Post not found');
    const parent = post.replyTo ? posts('p.id = @id', { me: req.user.id, id: post.replyTo })[0] : null;
    res.json({ post, parent, replies: posts('p.reply_to = @id ORDER BY p.id ASC', { me: req.user.id, id }) });
  });

  api.delete('/posts/:id', auth, (req, res) => {
    const r = db.prepare('DELETE FROM posts WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
    r.changes ? res.json({ ok: true }) : fail(res, 404, 'Post not found');
  });

  function setLike(req, res, on) {
    const id = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM posts WHERE id = ?').get(id)) return fail(res, 404, 'Post not found');
    if (on) db.prepare('INSERT OR IGNORE INTO likes (user_id, post_id) VALUES (?, ?)').run(req.user.id, id);
    else db.prepare('DELETE FROM likes WHERE user_id = ? AND post_id = ?').run(req.user.id, id);
    res.json({ liked: on, likes: db.prepare('SELECT COUNT(*) AS n FROM likes WHERE post_id = ?').get(id).n });
  }
  api.post('/posts/:id/like', auth, (req, res) => setLike(req, res, true));
  api.delete('/posts/:id/like', auth, (req, res) => setLike(req, res, false));

  // ---------- users ----------
  api.get('/users', auth, (req, res) => {
    const q = String(req.query.q || '').trim();
    const cols = `u.username, u.display_name AS displayName, u.bio,
      EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = @me AND f.followee_id = u.id) AS isFollowing`;
    const rows = q
      ? db.prepare(
          `SELECT ${cols} FROM users u
           WHERE u.username LIKE @q ESCAPE '\\' OR u.display_name LIKE @q ESCAPE '\\'
           ORDER BY u.username LIMIT 20`
        ).all({ me: req.user.id, q: `%${q.replace(/[\\%_]/g, '\\$&')}%` })
      : // No query: suggest popular accounts the user doesn't follow yet.
        db.prepare(
          `SELECT ${cols} FROM users u
           WHERE u.id != @me AND u.id NOT IN (SELECT followee_id FROM follows WHERE follower_id = @me)
           ORDER BY (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id) DESC, u.id DESC LIMIT 5`
        ).all({ me: req.user.id });
    res.json(rows.map((u) => ({ ...u, isFollowing: !!u.isFollowing })));
  });

  api.get('/users/:username', auth, (req, res) => {
    const u = findUser(req.params.username);
    if (!u) return fail(res, 404, 'User not found');
    const count = (sql) => db.prepare(sql).get(u.id).n;
    const { id, ...profile } = u;
    res.json({
      ...profile,
      followers: count('SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?'),
      following: count('SELECT COUNT(*) AS n FROM follows WHERE follower_id = ?'),
      isMe: id === req.user.id,
      isFollowing: !!db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?').get(req.user.id, id),
      posts: posts('p.user_id = @id ORDER BY p.id DESC LIMIT 50', { me: req.user.id, id }),
    });
  });

  function setFollow(req, res, on) {
    const u = findUser(req.params.username);
    if (!u) return fail(res, 404, 'User not found');
    if (u.id === req.user.id) return fail(res, 400, "You can't follow yourself");
    if (on) db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)').run(req.user.id, u.id);
    else db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?').run(req.user.id, u.id);
    res.json({ isFollowing: on });
  }
  api.post('/users/:username/follow', auth, (req, res) => setFollow(req, res, true));
  api.delete('/users/:username/follow', auth, (req, res) => setFollow(req, res, false));

  // ---------- direct messages ----------
  const MSG_SELECT = `
    SELECT m.id, m.body, m.created_at AS createdAt, s.username AS "from", r.username AS "to"
    FROM messages m JOIN users s ON s.id = m.sender_id JOIN users r ON r.id = m.recipient_id`;

  api.get('/dm', auth, (req, res) => {
    res.json(
      db.prepare(
        `SELECT u.username, u.display_name AS displayName, c.unread,
                m.body AS lastBody, m.created_at AS lastAt, (m.sender_id = @me) AS lastMine
         FROM (
           SELECT other, MAX(id) AS last_id, SUM(unread) AS unread FROM (
             SELECT CASE WHEN sender_id = @me THEN recipient_id ELSE sender_id END AS other, id,
                    (recipient_id = @me AND read_at IS NULL) AS unread
             FROM messages WHERE sender_id = @me OR recipient_id = @me
           ) GROUP BY other
         ) c JOIN users u ON u.id = c.other JOIN messages m ON m.id = c.last_id
         ORDER BY c.last_id DESC`
      ).all({ me: req.user.id }).map((c) => ({ ...c, lastMine: !!c.lastMine }))
    );
  });

  const markRead = (me, other) =>
    db.prepare('UPDATE messages SET read_at = ? WHERE recipient_id = ? AND sender_id = ? AND read_at IS NULL')
      .run(Date.now(), me, other);

  api.get('/dm/:username', auth, (req, res) => {
    const u = findUser(req.params.username);
    if (!u) return fail(res, 404, 'User not found');
    const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
    const messages = db.prepare(
      `${MSG_SELECT}
       WHERE ((m.sender_id = @me AND m.recipient_id = @other) OR (m.sender_id = @other AND m.recipient_id = @me))
         AND m.id < @before
       ORDER BY m.id DESC LIMIT 50`
    ).all({ me: req.user.id, other: u.id, before }).reverse();
    markRead(req.user.id, u.id);
    res.json({ user: { username: u.username, displayName: u.displayName }, messages });
  });

  api.post('/dm/:username/read', auth, (req, res) => {
    const u = findUser(req.params.username);
    if (!u) return fail(res, 404, 'User not found');
    markRead(req.user.id, u.id);
    res.json({ unread: unreadCount(req.user.id) });
  });

  api.post('/dm/:username', auth, (req, res) => {
    const u = findUser(req.params.username);
    if (!u) return fail(res, 404, 'User not found');
    if (u.id === req.user.id) return fail(res, 400, "You can't message yourself");
    const body = String(req.body.body || '').trim();
    if (!body) return fail(res, 400, 'Message cannot be empty');
    if ([...body].length > DM_MAX) return fail(res, 400, `Messages are limited to ${DM_MAX} characters`);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO messages (sender_id, recipient_id, body, created_at) VALUES (?, ?, ?, ?)')
      .run(req.user.id, u.id, body, Date.now());
    const message = db.prepare(`${MSG_SELECT} WHERE m.id = ?`).get(lastInsertRowid);
    push(u.id, { type: 'dm', message });
    push(req.user.id, { type: 'dm', message }); // keep the sender's other tabs in sync
    res.status(201).json(message);
  });

  api.use((req, res) => fail(res, 404, 'Not found'));
  // eslint-disable-next-line no-unused-vars
  api.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return fail(res, 400, 'Invalid request body');
    console.error(err);
    fail(res, 500, 'Something went wrong');
  });

  // ---------- frontend ----------
  const publicDir = path.join(__dirname, '..', 'public');
  app.use(express.static(publicDir));
  app.get('*', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  // ---------- websocket ----------
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    // Browsers send cookies on cross-site WebSocket handshakes, so check Origin.
    const origin = req.headers.origin;
    let sameOrigin = !origin;
    try { sameOrigin = sameOrigin || new URL(origin).host === req.headers.host; } catch { /* malformed */ }
    const user = sameOrigin && req.url === '/ws' ? userFromCookie(req.headers.cookie) : null;
    if (!user) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (!sockets.has(user.id)) sockets.set(user.id, new Set());
      sockets.get(user.id).add(ws);
      ws.on('close', () => {
        sockets.get(user.id)?.delete(ws);
        if (!sockets.get(user.id)?.size) sockets.delete(user.id);
      });
      ws.on('error', () => ws.terminate());
    });
  });

  const sweep = setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600_000);
  sweep.unref();
  server.on('close', () => {
    clearInterval(sweep);
    for (const set of sockets.values()) for (const ws of set) ws.terminate();
    db.close();
  });

  return { server, db, hashPassword };
}

module.exports = { createServer, hashPassword };
