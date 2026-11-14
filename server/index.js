const path = require('path');
const { createServer } = require('./app');

const port = Number(process.env.PORT) || 3000;
const { server } = createServer({
  dbFile: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'murmur.db'),
  secureCookies: process.env.NODE_ENV === 'production',
});

server.listen(port, () => console.log(`Murmur running at http://localhost:${port}`));
