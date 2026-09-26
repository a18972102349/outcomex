const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { server, providers, registerProvider } = require('../server');

let base;
test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { await new Promise((resolve) => server.close(resolve)); });

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, { headers: { 'content-type': 'application/json', ...(options.headers || {}) }, ...options });
  const body = await response.json();
  return { response, body };
}

test('lists services', async () => {
  const { response, body } = await request('/v1/services');
  assert.equal(response.status, 200);
  assert.equal(body.services.length, 3);
  assert.equal(body.services[0].id, 'wallet_snapshot');
});

test('health describes mock data and simulated settlement', async () => {
  const { response, body } = await request('/health');
  assert.equal(response.status, 200);
  assert.equal(body.dataMode, 'mock');
  assert.equal(body.paymentMode, 'mock');
  assert.equal(body.providerMetadata.wallet_snapshot.mode, 'mock');
});

test('quotes, executes and reads a deterministic wallet receipt', async () => {
  const payload = { serviceId: 'wallet_snapshot', input: { address: '0x0000000000000000000000000000000000000001', block: 123 }, maxPayment: '0.02' };
  const quote = await request('/v1/quote', { method: 'POST', body: JSON.stringify(payload) });
  assert.equal(quote.response.status, 200);
  assert.equal(quote.body.status, 'quoted');
  const execution = await request(`/v1/orders/${quote.body.orderId}/request`, { method: 'POST', body: '{}' });
  assert.equal(execution.response.status, 200);
  assert.equal(execution.body.status, 'fulfilled');
  assert.match(execution.body.result.resultHash, /^0x[0-9a-f]{64}$/);
  const receipt = await request(`/v1/orders/${quote.body.orderId}/receipt`);
  assert.equal(receipt.response.status, 200);
  assert.equal(receipt.body.status, 'simulated');
  assert.equal(receipt.body.onchain, false);
  assert.equal(receipt.body.payment.mode, 'mock');
});

test('rejects unknown service and low max payment', async () => {
  const unknown = await request('/v1/quote', { method: 'POST', body: JSON.stringify({ serviceId: 'nope', input: {} }) });
  assert.equal(unknown.response.status, 404);
  const low = await request('/v1/quote', { method: 'POST', body: JSON.stringify({ serviceId: 'wallet_snapshot', input: { address: '0x0000000000000000000000000000000000000001' }, maxPayment: '0.001' }) });
  assert.equal(low.response.status, 402);
});

test('validates service inputs before creating an order', async () => {
  const invalid = await request('/v1/quote', { method: 'POST', body: JSON.stringify({ serviceId: 'wallet_snapshot', input: { address: 'not-an-address' }, maxPayment: '0.01' }) });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error.code, 'invalid_input');
});

test('concurrent execution shares one receipt', async () => {
  const quote = await request('/v1/quote', { method: 'POST', body: JSON.stringify({ serviceId: 'wallet_snapshot', input: { address: '0x0000000000000000000000000000000000000002', block: 123 }, maxPayment: '0.01' }) });
  const path = `/v1/orders/${quote.body.orderId}/request`;
  const [first, second] = await Promise.all([request(path, { method: 'POST', body: '{}' }), request(path, { method: 'POST', body: '{}' })]);
  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  assert.equal(first.body.receipt.receiptId, second.body.receipt.receiptId);
});

test('provider failure leaves an order retryable and without a receipt', async () => {
  const original = providers.get('wallet_snapshot');
  registerProvider('wallet_snapshot', async () => { throw new Error('rpc unavailable'); });
  try {
    const quote = await request('/v1/quote', { method: 'POST', body: JSON.stringify({ serviceId: 'wallet_snapshot', input: { address: '0x0000000000000000000000000000000000000003' }, maxPayment: '0.01' }) });
    const failed = await request(`/v1/orders/${quote.body.orderId}/request`, { method: 'POST', body: '{}' });
    assert.equal(failed.response.status, 502);
    const order = await request(`/v1/orders/${quote.body.orderId}`);
    assert.equal(order.response.status, 200);
    assert.equal(order.body.status, 'quoted');
    assert.equal(order.body.receipt, null);
  } finally {
    registerProvider('wallet_snapshot', original);
  }
});
