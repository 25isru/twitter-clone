const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');
const { createServer } = require('../server/app');

let base, server;

test.before(async () => {
  ({ server } = createServer());
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
test.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));

// Minimal client that remembers its session cookie.
function client() {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + '/api' + path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', cookie },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: res.status, data: await res.json() };
  };
  call.cookie = () => cookie;
  return call;
}
async function signup(username) {
  const c = client();
  const r = await c('POST', '/signup', { username, password: 'correct horse' });
  assert.equal(r.status, 201);
  return c;
}

test('auth: signup, duplicate, login, logout', async () => {
  const a = await signup('alice');
  assert.equal((await a('GET', '/me')).data.username, 'alice');
  assert.equal((await client()('POST', '/signup', { username: 'ALICE', password: 'correct horse' })).status, 409);
  assert.equal((await client()('POST', '/signup', { username: 'x', password: 'correct horse' })).status, 400);
  assert.equal((await client()('POST', '/login', { username: 'alice', password: 'nope nope' })).status, 401);
  const again = client();
  assert.equal((await again('POST', '/login', { username: 'alice', password: 'correct horse' })).status, 200);
  await again('POST', '/logout');
  assert.equal((await again('GET', '/me')).data, null);
  assert.equal((await client()('GET', '/feed')).status, 401);
});

test('rejects state changes without the CSRF header', async () => {
  const res = await fetch(base + '/api/logout', { method: 'POST' });
  assert.equal(res.status, 403);
});

test('posts, follows, likes, replies and feeds', async () => {
  const bob = await signup('bob');
  const carol = await signup('carol');

  const post = (await bob('POST', '/posts', { body: 'hello from bob' })).data;
  assert.equal(post.username, 'bob');
  assert.equal((await bob('POST', '/posts', { body: 'x'.repeat(281) })).status, 400);
  assert.equal((await bob('POST', '/posts', { body: '   ' })).status, 400);

  // Carol only sees Bob at home after following him.
  assert.equal((await carol('GET', '/feed')).data.length, 0);
  assert.ok((await carol('GET', '/feed?scope=explore')).data.some((p) => p.id === post.id));
  await carol('POST', '/users/bob/follow');
  assert.equal((await carol('GET', '/feed')).data[0].id, post.id);
  assert.equal((await carol('POST', '/users/carol/follow')).status, 400);

  assert.deepEqual((await carol('POST', `/posts/${post.id}/like`)).data, { liked: true, likes: 1 });
  await carol('POST', `/posts/${post.id}/like`); // idempotent
  await carol('POST', '/posts', { body: 'hi bob', replyTo: post.id });
  const thread = (await bob('GET', `/posts/${post.id}`)).data;
  assert.equal(thread.post.likes, 1);
  assert.equal(thread.post.liked, false);
  assert.equal(thread.replies[0].body, 'hi bob');

  const profile = (await carol('GET', '/users/bob')).data;
  assert.equal(profile.followers, 1);
  assert.equal(profile.isFollowing, true);

  // Only the author can delete.
  assert.equal((await carol('DELETE', `/posts/${post.id}`)).status, 404);
  assert.equal((await bob('DELETE', `/posts/${post.id}`)).status, 200);
  assert.equal((await bob('GET', `/posts/${post.id}`)).status, 404);
});

test('direct messages: delivery, unread counts, privacy and real-time push', async () => {
  const dave = await signup('dave');
  const erin = await signup('erin');
  const frank = await signup('frank');

  assert.equal((await dave('POST', '/dm/dave', { body: 'me' })).status, 400);
  assert.equal((await dave('POST', '/dm/nobody', { body: 'hi' })).status, 404);

  const ws = new WebSocket(base.replace('http', 'ws') + '/ws', { headers: { cookie: erin.cookie() } });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  const pushed = new Promise((r) => ws.once('message', (d) => r(JSON.parse(d))));

  await dave('POST', '/dm/erin', { body: 'hey erin' });
  const event = await pushed;
  assert.equal(event.type, 'dm');
  assert.equal(event.message.body, 'hey erin');
  assert.equal(event.message.from, 'dave');
  ws.close();

  assert.equal((await erin('GET', '/me')).data.unread, 1);
  const inbox = (await erin('GET', '/dm')).data;
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].username, 'dave');
  assert.equal(inbox[0].unread, 1);

  // Opening the thread marks it read.
  const thread = (await erin('GET', '/dm/dave')).data;
  assert.equal(thread.messages.length, 1);
  assert.equal((await erin('GET', '/me')).data.unread, 0);

  await erin('POST', '/dm/dave', { body: 'hey dave' });
  assert.deepEqual((await dave('GET', '/dm/erin')).data.messages.map((m) => m.body), ['hey erin', 'hey dave']);

  // A third user sees none of it.
  assert.equal((await frank('GET', '/dm')).data.length, 0);
  assert.equal((await frank('GET', '/dm/dave')).data.messages.length, 0);
});

test('websocket refuses unauthenticated and cross-origin connections', async () => {
  const refused = (opts) =>
    new Promise((r) => {
      const ws = new WebSocket(base.replace('http', 'ws') + '/ws', opts);
      ws.on('open', () => r(false));
      ws.on('error', () => r(true));
    });
  assert.ok(await refused({}));
  const gina = await signup('gina');
  assert.ok(await refused({ headers: { cookie: gina.cookie() }, origin: 'https://evil.example' }));
});
