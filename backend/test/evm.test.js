const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { createEvmWalletSnapshotProvider } = require('../providers/evm');

test('EVM provider reads a deterministic balance from a JSON-RPC endpoint', async (t) => {
  const calls = [];
  const rpc = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const payload = JSON.parse(body);
    calls.push(payload.method);
    const result = payload.method === 'eth_blockNumber' ? '0x7b' : payload.method === 'eth_getBlockByNumber' ? { number: '0x7b', hash: `0x${'ab'.repeat(32)}` } : payload.method === 'eth_getBalance' ? '0xde0b6b3a7640000' : '0x0';
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }));
  });
  await new Promise((resolve) => rpc.listen(0, '127.0.0.1', resolve));
  t.after(() => rpc.close());
  const address = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
  const port = rpc.address().port;
  const provider = createEvmWalletSnapshotProvider({ rpcUrl: `http://127.0.0.1:${port}`, chain: 'testnet' });
  const result = await provider({ address, block: 'latest' });
  assert.equal(result.provider, 'evm-rpc');
  assert.equal(result.blockNumber, 123);
  assert.equal(result.result.nativeBalance.atomic, '1000000000000000000');
  assert.deepEqual(calls, ['eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBalance']);
});
