// Fills the database with a few demo accounts so there is something to look at.
// Usage: npm run seed   (all demo accounts use the password "password123")
const path = require('path');
const openDb = require('./db');
const { hashPassword } = require('./app');

const db = openDb(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'murmur.db'));
if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) {
  console.log('Database already has users — skipping seed.');
  process.exit(0);
}

const now = Date.now();
const users = [
  ['ada', 'Ada', 'Counting things, mostly.'],
  ['linus', 'Linus', 'Coffee, kernels, long walks.'],
  ['grace', 'Grace', 'Found a moth in the relay once.'],
];
const ids = {};
const addUser = db.prepare('INSERT INTO users (username, display_name, bio, password_hash, created_at) VALUES (?, ?, ?, ?, ?)');
for (const [username, name, bio] of users) {
  ids[username] = addUser.run(username, name, bio, hashPassword('password123'), now).lastInsertRowid;
}

const addPost = db.prepare('INSERT INTO posts (user_id, body, reply_to, created_at) VALUES (?, ?, ?, ?)');
const first = addPost.run(ids.ada, 'First post here. Hello, everyone!', null, now - 3600_000).lastInsertRowid;
addPost.run(ids.linus, 'Welcome @ada!', first, now - 3500_000);
addPost.run(ids.grace, 'Shipping something small today beats shipping something big never.', null, now - 1800_000);
addPost.run(ids.linus, 'Is it still a side project if it has a backlog?', null, now - 600_000);

const follow = db.prepare('INSERT INTO follows (follower_id, followee_id) VALUES (?, ?)');
follow.run(ids.ada, ids.linus);
follow.run(ids.ada, ids.grace);
follow.run(ids.linus, ids.ada);
db.prepare('INSERT INTO likes (user_id, post_id) VALUES (?, ?)').run(ids.grace, first);

const dm = db.prepare('INSERT INTO messages (sender_id, recipient_id, body, created_at) VALUES (?, ?, ?, ?)');
dm.run(ids.linus, ids.ada, 'Hey Ada, glad you joined!', now - 3000_000);
dm.run(ids.ada, ids.linus, 'Thanks! Still finding my way around.', now - 2900_000);

console.log('Seeded demo users: ada, linus, grace (password: password123)');
