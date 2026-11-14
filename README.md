# Murmur

A small Twitter-style social app with real-time direct messages.

## Features

- Accounts: sign up, sign in, sign out, edit display name and bio
- Posts up to 280 characters, replies, likes, delete your own posts, `@mentions`
- Follow / unfollow; a Home timeline (you + people you follow) and an Explore feed (everyone)
- People search and "who to follow" suggestions
- **Direct messages**: one-to-one conversations, delivered live over WebSocket, with unread badges
- Responsive layout with light and dark themes

## Stack

- **Server**: Node.js, Express, SQLite (`better-sqlite3`), `ws` for WebSockets
- **Client**: plain HTML/CSS/JavaScript single-page app — no build step

## Run it

Requires Node.js 20 or newer.

```bash
npm install
npm run seed   # optional: demo users ada, linus, grace (password: password123)
npm start      # http://localhost:3000
```

To try DMs, sign in as two different users in two browsers (or one normal and one private window).

| Variable   | Default           | Purpose                                         |
| ---------- | ----------------- | ----------------------------------------------- |
| `PORT`     | `3000`            | HTTP port                                       |
| `DB_PATH`  | `data/murmur.db`  | SQLite database file                            |
| `NODE_ENV` | –                 | Set to `production` to mark cookies as `Secure` (needs HTTPS) |

## Tests

```bash
npm test
```

## Layout

```
server/app.js    HTTP API + WebSocket server
server/db.js     SQLite schema
server/seed.js   demo data
public/          frontend (index.html, app.js, style.css)
test/            API tests
```

## Security notes

Passwords are hashed with scrypt; sessions are random tokens stored hashed, in an `HttpOnly`, `SameSite=Lax` cookie. State-changing requests require a custom header, the WebSocket handshake checks `Origin`, and all user text is rendered as text nodes. The login rate limiter is in-memory and per-process — put a real one in front before exposing this to the internet.
