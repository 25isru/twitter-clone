'use strict';

const POST_MAX = 280;
const root = document.getElementById('app');
let me = null;        // signed-in user, or null
let socket = null;
let onDm = null;      // set by the messages view to receive live messages
let renderSeq = 0;    // guards against out-of-order async renders

// ---------- helpers ----------
async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  if (res.status === 401 && me) { me = null; teardown(); renderAuth(); }
  if (!res.ok) throw new Error((data && data.error) || 'Something went wrong');
  return data;
}

// Tiny DOM builder. Text is always inserted as text nodes, never as HTML.
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...kids.flat(Infinity).filter((k) => k != null && k !== false));
  return el;
}
function icon(d) {
  const span = document.createElement('span');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
  return span.firstChild;
}
const ICONS = {
  home: 'M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  explore: 'M21 21l-4.3-4.3M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z',
  messages: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm0 1l8 7 8-7',
  profile: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-8 9a8 8 0 0 1 16 0',
  reply: 'M21 12a8 8 0 0 1-11.8 7L4 20l1.2-4.6A8 8 0 1 1 21 12z',
  heart: 'M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z',
  trash: 'M4 7h16M9 7V4h6v3m-8 0l1 13h8l1-13',
};

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2500);
}
const guard = (fn) => async (...args) => { try { await fn(...args); } catch (e) { toast(e.message); } };

function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  if (s < 7 * 86400) return Math.floor(s / 86400) + 'd';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
const clock = (ts) => new Date(ts).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' });

function avatar(username, large) {
  let hash = 0;
  for (const c of username.toLowerCase()) hash = (hash * 31 + c.charCodeAt(0)) % 360;
  return h('div', { class: 'avatar' + (large ? ' lg' : ''), style: `background:hsl(${hash} 45% 42%)`, 'aria-hidden': 'true' }, username[0]);
}

// Turn @mentions into profile links.
function rich(text) {
  return text.split(/(@[A-Za-z0-9_]{3,15})/g).map((part, i) =>
    i % 2 ? h('a', { class: 'mention', href: '#/u/' + part.slice(1), onclick: (e) => e.stopPropagation() }, part) : part
  );
}

// ---------- auth screen ----------
function renderAuth(mode = 'login') {
  const signup = mode === 'signup';
  const err = h('div', { class: 'error', role: 'alert' });
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      err.textContent = '';
      const f = new FormData(form);
      try {
        me = await api('POST', signup ? '/signup' : '/login', Object.fromEntries(f));
        location.hash = '#/home';
        boot();
      } catch (ex) { err.textContent = ex.message; }
    },
  },
    h('label', {}, 'Username', h('input', { type: 'text', name: 'username', required: true, autocomplete: 'username', autocapitalize: 'none', maxlength: 15 })),
    signup && h('label', {}, 'Display name', h('input', { type: 'text', name: 'displayName', maxlength: 50, placeholder: 'Optional' })),
    h('label', {}, 'Password', h('input', { type: 'password', name: 'password', required: true, minlength: 8, autocomplete: signup ? 'new-password' : 'current-password' })),
    err,
    h('button', { class: 'btn primary' }, signup ? 'Create account' : 'Sign in')
  );
  root.replaceChildren(
    h('div', { class: 'auth' },
      h('div', { class: 'auth-card' },
        h('h1', {}, 'Murmur'),
        h('p', { class: 'muted' }, signup ? 'Create an account to start posting.' : 'Short posts, follows, and private messages.'),
        form,
        h('p', { class: 'switch muted' },
          signup ? 'Already have an account? ' : 'New here? ',
          h('a', { class: 'link', href: '#', onclick: (e) => { e.preventDefault(); renderAuth(signup ? 'login' : 'signup'); } }, signup ? 'Sign in' : 'Create an account'))
      ))
  );
  form.querySelector('input').focus();
}

// ---------- shell ----------
let mainEl, navEl, asideEl;

function renderShell() {
  navEl = h('nav', { class: 'nav' });
  mainEl = h('main');
  asideEl = h('aside');
  root.replaceChildren(h('div', { class: 'shell' }, navEl, mainEl, asideEl));
  renderNav();
  renderAside();
}

function renderNav() {
  const hash = location.hash || '#/home';
  const item = (href, name, label, badge) =>
    h('a', { class: 'item' + (hash.startsWith(href) ? ' active' : ''), href, 'aria-label': label },
      icon(ICONS[name]), h('span', { class: 'label' }, label), badge ? h('span', { class: 'badge' }, String(badge)) : null);
  navEl.replaceChildren(
    h('div', { class: 'brand' }, 'M', h('span', {}, 'urmur')),
    item('#/home', 'home', 'Home'),
    item('#/explore', 'explore', 'Explore'),
    item('#/messages', 'messages', 'Messages', me.unread),
    item('#/u/' + me.username, 'profile', 'Profile'),
    h('div', { class: 'spacer' }),
    h('div', { class: 'whoami' },
      avatar(me.username),
      h('div', { class: 'names' }, h('div', {}, h('b', {}, me.displayName)), h('div', { class: 'muted' }, '@' + me.username)),
      h('button', { class: 'btn', title: 'Sign out', onclick: guard(async () => { await api('POST', '/logout'); me = null; teardown(); renderAuth(); }) }, 'Out'))
  );
}

async function refreshUnread() {
  try {
    const fresh = await api('GET', '/me');
    if (fresh && me) { me.unread = fresh.unread; renderNav(); }
  } catch { /* handled in api() */ }
}

function userRow(u, onChange) {
  const btn = u.username.toLowerCase() === me.username.toLowerCase() ? null : followButton(u, onChange);
  return h('div', { class: 'user-row' },
    h('a', { href: '#/u/' + u.username }, avatar(u.username)),
    h('a', { class: 'names', href: '#/u/' + u.username },
      h('div', {}, h('b', {}, u.displayName)), h('div', { class: 'muted' }, '@' + u.username)),
    btn);
}

function followButton(u, onChange) {
  const btn = h('button', { class: 'btn' + (u.isFollowing ? '' : ' primary') }, u.isFollowing ? 'Following' : 'Follow');
  btn.addEventListener('click', guard(async () => {
    const r = await api(u.isFollowing ? 'DELETE' : 'POST', `/users/${u.username}/follow`);
    u.isFollowing = r.isFollowing;
    btn.textContent = u.isFollowing ? 'Following' : 'Follow';
    btn.className = 'btn' + (u.isFollowing ? '' : ' primary');
    if (onChange) onChange(u);
  }));
  return btn;
}

async function renderAside() {
  try {
    const users = await api('GET', '/users');
    asideEl.replaceChildren(h('div', { class: 'panel' },
      h('div', { class: 'card' }, h('h3', {}, 'Who to follow'),
        users.length ? users.map((u) => userRow(u)) : h('div', { class: 'muted' }, 'You follow everyone here. Invite a friend!'))));
  } catch { /* sidebar is optional */ }
}

// ---------- posts ----------
function composer({ placeholder, replyTo, onPosted }) {
  const count = h('span', { class: 'count muted' }, String(POST_MAX));
  const btn = h('button', { class: 'btn primary', disabled: true }, replyTo ? 'Reply' : 'Post');
  const ta = h('textarea', { rows: 2, placeholder, 'aria-label': placeholder });
  const sync = () => {
    const left = POST_MAX - [...ta.value.trim()].length;
    count.textContent = String(left);
    count.classList.toggle('over', left < 0);
    btn.disabled = left < 0 || left === POST_MAX;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  };
  const submit = guard(async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      const post = await api('POST', '/posts', { body: ta.value, replyTo });
      ta.value = '';
      onPosted(post);
    } finally { sync(); }
  });
  ta.addEventListener('input', sync);
  ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); });
  btn.addEventListener('click', submit);
  return h('div', { class: 'composer' }, avatar(me.username),
    h('div', { class: 'body' }, ta, h('div', { class: 'row' }, count, btn)));
}

function postEl(p, { focus = false, onDelete } = {}) {
  const likeCount = h('span', {}, String(p.likes));
  const likeBtn = h('button', { class: 'like' + (p.liked ? ' on' : ''), 'aria-label': 'Like', 'aria-pressed': String(p.liked) }, icon(ICONS.heart), likeCount);
  likeBtn.addEventListener('click', guard(async (e) => {
    e.stopPropagation();
    const r = await api(p.liked ? 'DELETE' : 'POST', `/posts/${p.id}/like`);
    p.liked = r.liked; p.likes = r.likes;
    likeCount.textContent = String(r.likes);
    likeBtn.classList.toggle('on', r.liked);
    likeBtn.setAttribute('aria-pressed', String(r.liked));
  }));
  const mine = p.username.toLowerCase() === me.username.toLowerCase();
  const el = h('article', { class: 'post' + (focus ? ' focus' : '') },
    h('a', { href: '#/u/' + p.username, onclick: (e) => e.stopPropagation() }, avatar(p.username)),
    h('div', { class: 'content' },
      h('div', { class: 'meta' },
        h('a', { class: 'name', href: '#/u/' + p.username, onclick: (e) => e.stopPropagation() }, p.displayName),
        h('span', { class: 'muted' }, '@' + p.username),
        h('span', { class: 'muted' }, '·'),
        h('time', { class: 'muted', title: new Date(p.createdAt).toLocaleString() }, focus ? clock(p.createdAt) : ago(p.createdAt))),
      h('div', { class: 'text' }, rich(p.body)),
      h('div', { class: 'actions' },
        h('button', { 'aria-label': 'Reply', onclick: (e) => { e.stopPropagation(); location.hash = '#/post/' + p.id; } }, icon(ICONS.reply), h('span', {}, String(p.replies))),
        likeBtn,
        mine && h('button', { class: 'del', 'aria-label': 'Delete post', onclick: guard(async (e) => {
          e.stopPropagation();
          await api('DELETE', '/posts/' + p.id);
          el.remove();
          toast('Post deleted');
          if (onDelete) onDelete();
        }) }, icon(ICONS.trash)))));
  if (!focus) el.addEventListener('click', () => { if (!getSelection().toString()) location.hash = '#/post/' + p.id; });
  return el;
}

// ---------- views ----------
async function viewFeed(scope, seq) {
  const list = h('div');
  const more = h('button', { class: 'btn more', hidden: true }, 'Load more');
  let oldest = null;
  const load = guard(async () => {
    const page = await api('GET', `/feed?scope=${scope}${oldest ? '&before=' + oldest : ''}`);
    if (seq !== renderSeq) return;
    if (!page.length && !oldest) {
      list.append(h('div', { class: 'empty' }, scope === 'home'
        ? 'Your timeline is empty. Write something, or find people to follow in Explore.'
        : 'Nobody has posted yet. Be the first!'));
    }
    list.append(...page.map((p) => postEl(p)));
    if (page.length) oldest = page[page.length - 1].id;
    more.hidden = page.length < 30;
  });
  more.addEventListener('click', load);

  if (scope === 'home') {
    mainEl.replaceChildren(
      h('div', { class: 'head' }, h('h2', {}, 'Home')),
      composer({ placeholder: "What's on your mind?", onPosted: (p) => { list.querySelector('.empty')?.remove(); list.prepend(postEl(p)); } }),
      list, more);
  } else {
    const results = h('div');
    const input = h('input', { type: 'search', placeholder: 'Search people', 'aria-label': 'Search people' });
    let timer;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(guard(async () => {
        const q = input.value.trim();
        if (!q) { results.replaceChildren(); list.hidden = false; return; }
        const users = await api('GET', '/users?q=' + encodeURIComponent(q));
        if (input.value.trim() !== q) return;
        list.hidden = true; more.hidden = true;
        results.replaceChildren(...(users.length ? users.map((u) => userRow(u)) : [h('div', { class: 'empty' }, 'No one matches that.')]));
      }), 200);
    });
    mainEl.replaceChildren(h('div', { class: 'head' }, h('h2', {}, 'Explore')), h('div', { class: 'searchbar' }, input), results, list, more);
  }
  await load();
}

async function viewPost(id, seq) {
  const data = await api('GET', '/posts/' + id);
  if (seq !== renderSeq) return;
  const replies = h('div', {}, data.replies.map((p) => postEl(p)));
  mainEl.replaceChildren(
    h('div', { class: 'head' }, h('button', { class: 'btn', onclick: () => history.back() }, '←'), h('h2', {}, 'Post')),
    data.parent && postEl(data.parent),
    postEl(data.post, { focus: true, onDelete: () => { location.hash = '#/home'; } }),
    composer({ placeholder: 'Write a reply', replyTo: data.post.id, onPosted: (p) => replies.append(postEl(p)) }),
    replies);
}

async function viewProfile(username, seq) {
  const u = await api('GET', '/users/' + encodeURIComponent(username));
  if (seq !== renderSeq) return;
  const followers = h('b', {}, String(u.followers));
  const editForm = h('form', { hidden: true, onsubmit: guard(async (e) => {
    e.preventDefault();
    const updated = await api('PATCH', '/me', Object.fromEntries(new FormData(editForm)));
    Object.assign(me, updated);
    renderNav();
    route();
  }) },
    h('input', { type: 'text', name: 'displayName', value: u.displayName, maxlength: 50, 'aria-label': 'Display name', placeholder: 'Display name' }),
    h('textarea', { name: 'bio', rows: 3, maxlength: 160, 'aria-label': 'Bio', placeholder: 'Bio' }, u.bio),
    h('div', {}, h('button', { class: 'btn primary' }, 'Save')));
  mainEl.replaceChildren(
    h('div', { class: 'head' }, h('h2', {}, u.displayName)),
    h('div', { class: 'profile' },
      h('div', { class: 'top' }, avatar(u.username, true),
        h('div', { class: 'btns' }, u.isMe
          ? h('button', { class: 'btn', onclick: () => { editForm.hidden = !editForm.hidden; } }, 'Edit profile')
          : [h('a', { class: 'btn', href: '#/messages/' + u.username }, 'Message'),
             followButton(u, () => { u.followers += u.isFollowing ? 1 : -1; followers.textContent = String(u.followers); })])),
      h('h3', {}, u.displayName),
      h('div', { class: 'muted' }, '@' + u.username),
      u.bio && h('div', { class: 'bio' }, rich(u.bio)),
      h('div', { class: 'stats' },
        h('span', {}, h('b', {}, String(u.following)), h('span', { class: 'muted' }, ' following')),
        h('span', {}, followers, h('span', { class: 'muted' }, ' followers')),
        h('span', { class: 'muted' }, 'Joined ' + new Date(u.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' }))),
      editForm),
    u.posts.length ? u.posts.map((p) => postEl(p)) : h('div', { class: 'empty' }, 'No posts yet.'));
}

async function viewMessages(username, seq) {
  const convs = await api('GET', '/dm');
  const thread = username ? await api('GET', '/dm/' + encodeURIComponent(username)) : null;
  if (seq !== renderSeq) return;
  if (thread) refreshUnread();

  const listEl = h('div');
  const drawList = (items) => listEl.replaceChildren(...(items.length
    ? items.map((c) => h('a', {
        class: 'conv' + (c.unread ? ' unread' : '') + (thread && c.username === thread.user.username ? ' active' : ''),
        href: '#/messages/' + c.username },
        avatar(c.username),
        h('div', { class: 'names' },
          h('div', {}, h('b', {}, c.displayName), h('span', { class: 'muted' }, ' · ' + ago(c.lastAt))),
          h('div', { class: 'preview muted' }, (c.lastMine ? 'You: ' : '') + c.lastBody)),
        c.unread ? h('span', { class: 'badge' }, String(c.unread)) : null))
    : [h('div', { class: 'empty' }, 'No conversations yet. Enter a username above to start one.')]));
  drawList(convs);
  const reloadList = guard(async () => { const fresh = await api('GET', '/dm'); if (seq === renderSeq) drawList(fresh); });

  const newInput = h('input', { type: 'text', placeholder: 'Message @username', 'aria-label': 'Start a conversation with username', autocapitalize: 'none' });
  const newForm = h('form', { onsubmit: (e) => {
    e.preventDefault();
    const name = newInput.value.trim().replace(/^@/, '');
    if (name) location.hash = '#/messages/' + encodeURIComponent(name);
  } }, newInput, h('button', { class: 'btn' }, 'Go'));

  let threadEl;
  if (thread) {
    const seen = new Set();
    const bubbles = h('div', { class: 'bubbles' });
    const add = (m) => {
      if (seen.has(m.id)) return;
      seen.add(m.id);
      bubbles.querySelector('.empty')?.remove();
      bubbles.append(h('div', { class: 'bubble' + (m.from === me.username ? ' mine' : '') }, m.body, h('time', {}, clock(m.createdAt))));
      bubbles.scrollTop = bubbles.scrollHeight;
    };
    if (!thread.messages.length) bubbles.append(h('div', { class: 'empty' }, `This is the start of your conversation with @${thread.user.username}.`));
    const input = h('input', { type: 'text', placeholder: 'Write a message', maxlength: 1000, 'aria-label': 'Message', autocomplete: 'off' });
    const send = h('form', { class: 'dm-send', onsubmit: guard(async (e) => {
      e.preventDefault();
      const body = input.value.trim();
      if (!body) return;
      input.value = '';
      try { add(await api('POST', '/dm/' + thread.user.username, { body })); reloadList(); }
      catch (ex) { input.value = body; throw ex; }
    }) }, input, h('button', { class: 'btn primary' }, 'Send'));
    threadEl = h('div', { class: 'dm-thread' },
      h('div', { class: 'head' },
        h('a', { class: 'btn back', href: '#/messages' }, '←'),
        h('a', { href: '#/u/' + thread.user.username }, avatar(thread.user.username)),
        h('h2', {}, h('a', { href: '#/u/' + thread.user.username }, thread.user.displayName, h('span', { class: 'muted' }, ' @' + thread.user.username)))),
      bubbles, send);
    onDm = (m) => {
      const other = m.from === me.username ? m.to : m.from;
      if (other === thread.user.username) {
        add(m);
        if (m.from !== me.username) api('POST', `/dm/${other}/read`).then(refreshUnread, () => {});
      } else refreshUnread();
      reloadList();
    };
    setTimeout(() => { thread.messages.forEach(add); input.focus(); });
  } else {
    threadEl = h('div', { class: 'dm-thread' }, h('div', { class: 'empty' }, 'Select a conversation, or start a new one.'));
    onDm = () => { refreshUnread(); reloadList(); };
  }

  mainEl.replaceChildren(h('div', { class: 'dm' + (thread ? ' open' : '') },
    h('div', { class: 'dm-list' }, h('div', { class: 'head' }, h('h2', {}, 'Messages')), newForm, listEl),
    threadEl));
}

// ---------- routing ----------
async function route() {
  if (!me) return;
  const seq = ++renderSeq;
  onDm = null;
  const [, page, arg] = (location.hash || '#/home').split('/');
  renderNav();
  window.scrollTo(0, 0);
  try {
    if (page === 'explore') await viewFeed('explore', seq);
    else if (page === 'u' && arg) await viewProfile(decodeURIComponent(arg), seq);
    else if (page === 'post' && arg) await viewPost(arg, seq);
    else if (page === 'messages') await viewMessages(arg ? decodeURIComponent(arg) : null, seq);
    else await viewFeed('home', seq);
  } catch (e) {
    if (seq === renderSeq && me) {
      mainEl.replaceChildren(h('div', { class: 'head' }, h('h2', {}, 'Oops')), h('div', { class: 'empty' }, e.message));
    }
  }
}
window.addEventListener('hashchange', route);

// ---------- live connection ----------
function connect() {
  if (!me || (socket && socket.readyState <= 1)) return;
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  socket.onmessage = (e) => {
    const event = JSON.parse(e.data);
    if (event.type !== 'dm') return;
    if (onDm) onDm(event.message);
    else if (event.message.from !== me.username) {
      refreshUnread();
      toast(`New message from @${event.message.from}`);
    }
  };
  socket.onclose = () => { socket = null; if (me) setTimeout(connect, 3000); };
}
function teardown() {
  onDm = null;
  if (socket) { socket.onclose = null; socket.close(); socket = null; }
}

async function boot() {
  if (!me) me = await api('GET', '/me').catch(() => null);
  if (!me) return renderAuth();
  renderShell();
  connect();
  route();
}
boot();
