const { test, before, after } = require('node:test');
const assert = require('node:assert');
const app = require('../server');

let server;
let base;

let archetype;
let valid;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  archetype = (await post('/api/archetypes', { name: 'Flour', description: 'Type 550', supplier: 'Acme', unit: 'kg' })).body;
  valid = { archetypeId: archetype.id, receivedDate: '2026-11-01', quantity: 5 };
});

after(() => new Promise((resolve) => server.close(resolve)));

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

test('creates an archetype with trimmed fields and an empty description by default', async () => {
  const res = await post('/api/archetypes', { name: ' Flour ', supplier: ' Acme ', unit: 'kg' });
  assert.strictEqual(res.status, 201);
  assert.match(res.body.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.strictEqual(res.body.name, 'Flour');
  assert.strictEqual(res.body.supplier, 'Acme');
  assert.strictEqual(res.body.description, '');
  assert.strictEqual(res.body.unit, 'kg');
  assert.ok(res.body.createdAt);

  const blank = await post('/api/archetypes', { name: 'Sugar', description: '   ', supplier: 'Acme', unit: 'bags' });
  assert.strictEqual(blank.status, 201);
  assert.strictEqual(blank.body.description, '');

  const described = await post('/api/archetypes', { name: 'Salt', description: ' Coarse ', supplier: 'Acme', unit: 'bags' });
  assert.strictEqual(described.body.description, 'Coarse');
});

test('rejects archetypes without a name or supplier, or with a bad unit', async () => {
  const ok = { name: 'Flour', supplier: 'Acme', unit: 'kg' };
  for (const extra of [{ name: '' }, { name: '   ' }, { supplier: '' }, { unit: 'lbs' }]) {
    const res = await post('/api/archetypes', { ...ok, ...extra });
    assert.strictEqual(res.status, 400, JSON.stringify(extra));
    assert.strictEqual(typeof res.body.error, 'string', JSON.stringify(extra));
  }
  const res = await post('/api/archetypes', { ...ok, unit: 'lbs' });
  assert.strictEqual(res.body.error, 'Unit must be bags or kg.');
});

test('lists archetypes newest first and gets one by id', async () => {
  const a = (await post('/api/archetypes', { name: 'Yeast', supplier: 'Acme', unit: 'kg' })).body;
  const b = (await post('/api/archetypes', { name: 'Oats', supplier: 'Mill Co', unit: 'bags' })).body;

  const list = await get('/api/archetypes');
  assert.strictEqual(list.status, 200);
  const ids = list.body.map((x) => x.id);
  assert.ok(ids.includes(archetype.id));
  assert.ok(ids.includes(a.id));
  assert.ok(ids.indexOf(b.id) < ids.indexOf(a.id));

  const one = await get(`/api/archetypes/${a.id}`);
  assert.strictEqual(one.status, 200);
  assert.deepStrictEqual(one.body, a);

  const missing = await get('/api/archetypes/00000000-0000-0000-0000-000000000000');
  assert.strictEqual(missing.status, 404);
  assert.strictEqual(missing.body.error, 'Archetype not found.');
});

test('rejects items with a missing or unknown archetypeId', async () => {
  for (const archetypeId of [undefined, '', '   ', '00000000-0000-0000-0000-000000000000']) {
    const res = await post('/api/items', { ...valid, archetypeId });
    assert.strictEqual(res.status, 400, String(archetypeId));
    assert.match(res.body.error, /archetype/i, String(archetypeId));
  }
});

test('item responses merge in the archetype fields and ignore them in the request body', async () => {
  const created = await post('/api/items', { ...valid, name: 'Other', supplier: 'Other', unit: 'bags', description: 'x' });
  assert.strictEqual(created.status, 201);
  for (const body of [created.body, (await get(`/api/items/${created.body.id}`)).body]) {
    assert.strictEqual(body.archetypeId, archetype.id);
    assert.strictEqual(body.name, 'Flour');
    assert.strictEqual(body.description, 'Type 550');
    assert.strictEqual(body.supplier, 'Acme');
    assert.strictEqual(body.unit, 'kg');
  }
});

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
  assert.strictEqual(item.archetypeId, archetype.id);
  assert.strictEqual(item.name, 'Flour');
  assert.strictEqual(item.description, 'Type 550');
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
  assert.strictEqual(used.body.name, 'Flour');
  assert.strictEqual(used.body.supplier, 'Acme');
  assert.strictEqual(used.body.unit, 'kg');

  const tooMuch = await post(`/api/items/${item.id}/usages`, { quantity: 4, purpose: 'Cake' });
  assert.strictEqual(tooMuch.status, 400);
  assert.strictEqual(tooMuch.body.error, 'Only 3 kg remaining.');
});

test('several items can share one archetype and keep their own dates, quantities and usages', async () => {
  const first = (await post('/api/items', { ...valid, expirationDate: '2026-12-01', quantity: 5 })).body;
  const second = (await post('/api/items', { ...valid, receivedDate: '2026-11-05', expirationDate: '2027-01-15', quantity: 8 })).body;

  const list = (await get('/api/items')).body;
  const a = list.find((i) => i.id === first.id);
  const b = list.find((i) => i.id === second.id);
  for (const i of [a, b]) {
    assert.strictEqual(i.archetypeId, archetype.id);
    assert.strictEqual(i.name, 'Flour');
    assert.strictEqual(i.supplier, 'Acme');
    assert.strictEqual(i.unit, 'kg');
  }
  assert.strictEqual(a.expirationDate, '2026-12-01');
  assert.strictEqual(a.initialQuantity, 5);
  assert.strictEqual(b.receivedDate, '2026-11-05');
  assert.strictEqual(b.expirationDate, '2027-01-15');
  assert.strictEqual(b.initialQuantity, 8);

  const used = await post(`/api/items/${first.id}/usages`, { quantity: 2, purpose: 'Bread' });
  assert.strictEqual(used.body.remainingQuantity, 3);
  const other = (await get(`/api/items/${second.id}`)).body;
  assert.strictEqual(other.remainingQuantity, 8);
  assert.deepStrictEqual(other.usages, []);
});
