const express = require('express');
const QRCode = require('qrcode');
const selfsigned = require('selfsigned');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const HTTP_PORT = Number(process.env.PORT) || 3000;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 3443;
const UNITS = ['bags', 'kg'];

// In-memory store (wiped on restart)
const items = new Map();
const archetypes = new Map();

const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(ts(), ...a);
const ip = (addr = '') => addr.replace(/^::ffff:/, '');

const app = express();

// Log every HTTP request once it finishes
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    log(`REQ  ${ip(req.socket.remoteAddress)} ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms) [${req.protocol}] ${(req.get('user-agent') || '').slice(0, 60)}`);
  });
  next();
});
app.get('/ping', (req, res) => res.type('text').send(`pong from ${ip(req.socket.localAddress)} to ${ip(req.socket.remoteAddress)}\n`));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Merge the item's archetype fields into the response, then add the QR code
async function toResponse(item) {
  const { name, description, supplier, unit } = archetypes.get(item.archetypeId);
  const qrDataUrl = await QRCode.toDataURL(item.id, { margin: 2, width: 320 });
  return { ...item, name, description, supplier, unit, qrDataUrl };
}

const newestFirst = (a, b) => b.createdAt.localeCompare(a.createdAt);

const text = (v) => (typeof v === 'string' ? v.trim() : '');

// True for a YYYY-MM-DD string that is a real calendar date
function isCalendarDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

app.post('/api/archetypes', (req, res) => {
  const name = text(req.body.name);
  const description = text(req.body.description);
  const supplier = text(req.body.supplier);
  const unit = text(req.body.unit);

  if (!name || !supplier) return res.status(400).json({ error: 'Name and supplier are required.' });
  if (!UNITS.includes(unit)) return res.status(400).json({ error: 'Unit must be bags or kg.' });

  const archetype = { id: randomUUID(), name, description, supplier, unit, createdAt: new Date().toISOString() };
  archetypes.set(archetype.id, archetype);
  res.status(201).json(archetype);
});

app.get('/api/archetypes', (req, res) => {
  res.json([...archetypes.values()].sort(newestFirst));
});

app.get('/api/archetypes/:id', (req, res) => {
  const archetype = archetypes.get(req.params.id);
  if (!archetype) return res.status(404).json({ error: 'Archetype not found.' });
  res.json(archetype);
});

app.post('/api/items', async (req, res) => {
  const archetypeId = text(req.body.archetypeId);
  const receivedDate = text(req.body.receivedDate);
  const quantity = Number(req.body.quantity);
  const rawExpiration = req.body.expirationDate;
  const expirationDate = typeof rawExpiration === 'string' ? rawExpiration.trim() || null : rawExpiration ?? null;

  if (!archetypes.has(archetypeId)) return res.status(400).json({ error: 'Please choose a valid product archetype.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedDate)) return res.status(400).json({ error: 'A valid received date is required.' });
  if (expirationDate !== null) {
    if (typeof expirationDate !== 'string' || !isCalendarDate(expirationDate)) {
      return res.status(400).json({ error: 'Expiration date must be a valid date (YYYY-MM-DD).' });
    }
    if (expirationDate < receivedDate) return res.status(400).json({ error: 'Expiration date can\'t be before the received date.' });
  }
  if (!Number.isFinite(quantity) || quantity <= 0) return res.status(400).json({ error: 'Quantity must be greater than 0.' });

  const item = {
    id: randomUUID(),
    archetypeId,
    receivedDate,
    expirationDate,
    initialQuantity: quantity,
    remainingQuantity: quantity,
    createdAt: new Date().toISOString(),
    usages: [],
  };
  items.set(item.id, item);
  res.status(201).json(await toResponse(item));
});

app.get('/api/items', async (req, res) => {
  const list = [...items.values()].sort(newestFirst);
  res.json(await Promise.all(list.map(toResponse)));
});

app.get('/api/items/:id', async (req, res) => {
  const item = items.get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found.' });
  res.json(await toResponse(item));
});

app.post('/api/items/:id/usages', async (req, res) => {
  const item = items.get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found.' });

  const quantity = Number(req.body.quantity);
  const purpose = text(req.body.purpose);
  if (!Number.isFinite(quantity) || quantity <= 0) return res.status(400).json({ error: 'Quantity must be greater than 0.' });
  if (!purpose) return res.status(400).json({ error: 'Please say what it was used for.' });
  if (quantity > item.remainingQuantity) {
    return res.status(400).json({ error: `Only ${item.remainingQuantity} ${archetypes.get(item.archetypeId).unit} remaining.` });
  }

  item.remainingQuantity = Math.round((item.remainingQuantity - quantity) * 1000) / 1000;
  item.usages.push({ id: randomUUID(), quantity, purpose, date: new Date().toISOString() });
  res.json(await toResponse(item));
});

function lanIps() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
}

// Connection-level logging: shows whether a phone reaches the server at all,
// even when no HTTP request is ever completed (wrong protocol, TLS failure, etc.)
function watch(server, label) {
  const conn = label === 'HTTPS' ? 'connection' : 'connection';
  server.on(conn, (sock) => {
    log(`CONN ${label} ${ip(sock.remoteAddress)}:${sock.remotePort} -> :${sock.localPort}`);
    sock.on('error', (e) => log(`SOCK ${label} ${ip(sock.remoteAddress)} error: ${e.code || e.message}`));
  });
  server.on('clientError', (err, sock) => {
    log(`CLIENT-ERR ${label} ${ip(sock.remoteAddress)}: ${err.code || err.message}`);
    if (sock.writable) sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  server.on('tlsClientError', (err, sock) => {
    log(`TLS-ERR ${label} ${ip(sock.remoteAddress)}: ${err.code || err.message}` +
      (err.code === 'ERR_SSL_HTTP_REQUEST' ? '  <- client sent plain HTTP to the HTTPS port' : ''));
  });
  server.on('secureConnection', (tls) => {
    log(`TLS-OK ${ip(tls.remoteAddress)} ${tls.getProtocol()} sni=${tls.servername || '-'}`);
  });
}

async function main() {
  const httpServer = http.createServer(app);
  watch(httpServer, 'HTTP');
  httpServer.listen(HTTP_PORT, () => {
    log(`HTTP:  http://localhost:${HTTP_PORT}`);
  });

  const ips = lanIps();
  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: 'localhost' }],
    {
      days: 365,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
            ...ips.map((ip) => ({ type: 7, ip })),
          ],
        },
      ],
    }
  );
  const httpsServer = https.createServer({ key: pems.private, cert: pems.cert }, app);
  watch(httpsServer, 'HTTPS');
  httpsServer.listen(HTTPS_PORT, () => {
    log(`HTTPS: https://localhost:${HTTPS_PORT}`);
    ips.forEach((addr) => {
      log(`PHONE (same Wi-Fi): http://${addr}:${HTTP_PORT}/ping   <- try this first, no camera/HTTPS`);
      log(`PHONE (same Wi-Fi): https://${addr}:${HTTPS_PORT}/update.html`);
    });
    log('Waiting for connections. Any phone attempt will print a CONN line.');
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = app;
