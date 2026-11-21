const { test, before, after } = require('node:test');
const assert = require('node:assert');
const app = require('../server');

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const valid = { name: 'Flour', supplier: 'Acme', receivedDate: '2026-11-01', unit: 'kg', quantity: 5 };

async function post(path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(path) {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
}

test('stores a valid expiration date and returns it from POST and both GETs', async () => {
  const created = await post('/api/items', { ...valid, expirationDate: ' 2026-12-01 ' });
  assert.strictEqual(created.status, 201);
  assert.strictEqual(created.body.expirationDate, '2026-12-01');

  const list = await get('/api/items');
  assert.strictEqual(list.body.find((i) => i.id === created.body.id).expirationDate, '2026-12-01');

  const one = await get(`/api/items/${created.body.id}`);
  assert.strictEqual(one.body.expirationDate, '2026-12-01');
});

test('missing, null, empty and whitespace expiration dates are stored as null', async () => {
  for (const extra of [{}, { expirationDate: null }, { expirationDate: '' }, { expirationDate: '   ' }]) {
    const created = await post('/api/items', { ...valid, ...extra });
    assert.strictEqual(created.status, 201, JSON.stringify(extra));
    assert.strictEqual(created.body.expirationDate, null, JSON.stringify(extra));
  }
});

test('rejects badly formatted, impossible and non-string expiration dates', async () => {
  for (const expirationDate of ['12/01/2026', '2026/12/01', '2026-02-30', '2026-13-01', 5]) {
    const res = await post('/api/items', { ...valid, expirationDate });
    assert.strictEqual(res.status, 400, String(expirationDate));
    assert.match(res.body.error, /Expiration date/, String(expirationDate));
  }
});

test('rejects an expiration date before the received date', async () => {
  const res = await post('/api/items', { ...valid, expirationDate: '2026-10-31' });
  assert.strictEqual(res.status, 400);
  assert.match(res.body.error, /before the received date/);
});

test('accepts an expiration date equal to the received date', async () => {
  const res = await post('/api/items', { ...valid, expirationDate: '2026-11-01' });
  assert.strictEqual(res.status, 201);
  assert.strictEqual(res.body.expirationDate, '2026-11-01');
});

test('an item without an expiration date keeps all existing fields and accepts usages', async () => {
  const created = await post('/api/items', valid);
  assert.strictEqual(created.status, 201);
  const item = created.body;
  assert.match(item.id, /^[0-9a-f-]{36}$/);
  assert.strictEqual(item.name, 'Flour');
  assert.strictEqual(item.supplier, 'Acme');
  assert.strictEqual(item.receivedDate, '2026-11-01');
  assert.strictEqual(item.unit, 'kg');
  assert.strictEqual(item.initialQuantity, 5);
  assert.strictEqual(item.remainingQuantity, 5);
  assert.ok(item.createdAt);
  assert.deepStrictEqual(item.usages, []);
  assert.match(item.qrDataUrl, /^data:image\/png;base64,/);
  assert.strictEqual(item.expirationDate, null);

  const used = await post(`/api/items/${item.id}/usages`, { quantity: 2, purpose: 'Bread' });
  assert.strictEqual(used.status, 200);
  assert.strictEqual(used.body.remainingQuantity, 3);
  assert.strictEqual(used.body.expirationDate, null);
});
