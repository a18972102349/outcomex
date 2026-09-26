const http = require('node:http');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT || 8787);
const CHAIN_ID = process.env.OUTCOMEX_CHAIN_ID || 'base-sepolia';
const PAYMENT_ASSET = process.env.OUTCOMEX_PAYMENT_ASSET || 'USDC';
const TREASURY_ADDRESS = process.env.OUTCOMEX_TREASURY_ADDRESS || '0x0000000000000000000000000000000000000001';
const AUTO_SETTLE = process.env.OUTCOMEX_AUTO_SETTLE !== 'false';
// Only the local mock is implemented in v0.1. A future verifier must be
// explicitly implemented before AUTO_SETTLE=false can accept a proof.
const REQUESTED_PAYMENT_MODE = process.env.OUTCOMEX_PAYMENT_MODE || 'mock';
const PAYMENT_MODE = ['mock', 'disabled'].includes(REQUESTED_PAYMENT_MODE) ? REQUESTED_PAYMENT_MODE : 'unsupported';
const MAX_BODY_BYTES = 1024 * 1024;

const now = () => Math.floor(Date.now() / 1000);
const randomId = (prefix) => `${prefix}_${crypto.randomBytes(12).toString('hex')}`;

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function hash(value) {
  const input = typeof value === 'string' ? value : canonicalize(value);
  return `0x${crypto.createHash('sha256').update(input).digest('hex')}`;
}

function isAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

function toNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseUsdc(value, field = 'amount') {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d+(?:\.\d{1,6})?$/.test(text)) {
    throw new ApiError(400, 'invalid_usdc_amount', `${field} must be a non-negative decimal with at most 6 digits`);
  }
  const [whole, fractional = ''] = text.split('.');
  return BigInt(whole) * 1_000_000n + BigInt(fractional.padEnd(6, '0') || '0');
}

function formatUsdc(units) {
  const value = BigInt(units);
  const whole = value / 1_000_000n;
  const fractional = (value % 1_000_000n).toString().padStart(6, '0');
  return `${whole}.${fractional}`;
}

const serviceDefinitions = [
  {
    id: 'wallet_snapshot',
    name: 'Wallet Snapshot',
    description: '在指定区块读取钱包余额、代币持仓和最近转账。',
    priceUsdc: '0.010',
    proof: 'Deterministic',
    mockProvider: 'deterministic-mock',
    inputSchema: { address: '0x-prefixed EVM address', chain: 'optional chain id', block: 'optional block number or latest' }
  },
  {
    id: 'contract_events',
    name: 'Contract Events',
    description: '查询合约事件并返回可独立复核的规范化日志。',
    priceUsdc: '0.015',
    proof: 'Replayable',
    mockProvider: 'deterministic-mock',
    inputSchema: { address: '0x-prefixed contract address', eventSignature: 'optional event signature', fromBlock: 'number', toBlock: 'number' }
  },
  {
    id: 'token_price_snapshot',
    name: 'Token Price Snapshot',
    description: '从链上池子储备计算指定区块的价格和流动性快照。',
    priceUsdc: '0.020',
    proof: 'Block-bound',
    mockProvider: 'deterministic-mock',
    inputSchema: { pair: 'token pair or pool address', chain: 'optional chain id', block: 'optional block number or latest' }
  }
];

function servicePublicView(service) {
  return {
    id: service.id,
    name: service.name,
    description: service.description,
    price: `${service.priceUsdc} USDC`,
    priceUsdc: service.priceUsdc,
    proof: service.proof,
    inputSchema: service.inputSchema,
    providerMetadata: providerMetadataFor(service.id)
  };
}

function normalizeBlock(input) {
  if (input === undefined || input === null || input === '' || input === 'latest') {
    return { blockNumber: 20_000_000, blockTag: 'latest' };
  }
  const blockNumber = Number(input);
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new ApiError(400, 'invalid_block', 'block must be a non-negative integer or latest');
  }
  return { blockNumber, blockTag: String(blockNumber) };
}

function makeWalletSnapshot(input) {
  if (!input || !isAddress(input.address)) {
    throw new ApiError(400, 'invalid_input', 'wallet_snapshot requires a valid EVM address');
  }
  const block = normalizeBlock(input.block);
  const chain = input.chain || CHAIN_ID;
  const seed = hash({ service: 'wallet_snapshot', address: input.address.toLowerCase(), chain, block: block.blockNumber });
  const integer = BigInt(`0x${seed.slice(2, 18)}`);
  const nativeWei = (integer % 3_000_000_000_000_000_000n).toString();
  const usdcUnits = (integer % 100_000_000n).toString();
  const result = {
    address: input.address,
    chain,
    blockNumber: block.blockNumber,
    nativeBalance: { symbol: 'ETH', decimals: 18, atomic: nativeWei },
    tokenBalances: [{ symbol: 'USDC', address: '0x0000000000000000000000000000000000000002', decimals: 6, atomic: usdcUnits }],
    nftHoldings: [],
    recentTransfers: []
  };
  return { result, blockNumber: block.blockNumber, proof: { source: 'mock://wallet-snapshot', method: 'deterministic-replay', seed } };
}

function makeContractEvents(input) {
  if (!input || !isAddress(input.address)) throw new ApiError(400, 'invalid_input', 'contract_events requires a valid contract address');
  const fromBlock = toNumber(input.fromBlock, 0);
  const toBlock = toNumber(input.toBlock, fromBlock + 100);
  if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) || fromBlock < 0 || toBlock < fromBlock) {
    throw new ApiError(400, 'invalid_input', 'fromBlock and toBlock must be valid ordered block numbers');
  }
  const seed = hash({ service: 'contract_events', input });
  return { result: { address: input.address, eventSignature: input.eventSignature || null, fromBlock, toBlock, events: [] }, blockNumber: toBlock, proof: { source: 'mock://contract-events', method: 'deterministic-replay', seed } };
}

function makeTokenPriceSnapshot(input) {
  if (!input || typeof input.pair !== 'string' || !input.pair.trim()) throw new ApiError(400, 'invalid_input', 'token_price_snapshot requires pair');
  const block = normalizeBlock(input.block);
  const seed = hash({ service: 'token_price_snapshot', pair: input.pair, chain: input.chain || CHAIN_ID, block: block.blockNumber });
  const basis = Number.parseInt(seed.slice(2, 10), 16);
  const price = (0.5 + (basis % 50000) / 10000).toFixed(6);
  return { result: { pair: input.pair, chain: input.chain || CHAIN_ID, blockNumber: block.blockNumber, price, liquidityUsd: ((basis % 900000) + 100000).toFixed(2) }, blockNumber: block.blockNumber, proof: { source: 'mock://token-price-snapshot', method: 'deterministic-replay', seed } };
}

const providers = new Map([
  ['wallet_snapshot', makeWalletSnapshot],
  ['contract_events', makeContractEvents],
  ['token_price_snapshot', makeTokenPriceSnapshot]
]);

function registerProvider(serviceId, provider) {
  if (typeof serviceId !== 'string' || typeof provider !== 'function') throw new TypeError('registerProvider requires serviceId and function');
  providers.set(serviceId, provider);
}

// A deployment can provide a module exporting { [serviceId]: provider }.
if (process.env.OUTCOMEX_PROVIDER_MODULE) {
  const external = require(require('node:path').resolve(process.env.OUTCOMEX_PROVIDER_MODULE));
  for (const [serviceId, provider] of Object.entries(external.providers || external)) registerProvider(serviceId, provider);
}

// Opt into a real read-only EVM provider without changing the safe local default.
if (process.env.OUTCOMEX_RPC_URL) {
  const { createEvmWalletSnapshotProvider } = require('./providers/evm');
  registerProvider('wallet_snapshot', createEvmWalletSnapshotProvider());
}

function providerMetadataFor(serviceId) {
  const rpcWallet = serviceId === 'wallet_snapshot' && Boolean(process.env.OUTCOMEX_RPC_URL);
  if (rpcWallet) {
    return {
      mode: 'rpc',
      provider: 'evm-rpc',
      source: 'configured JSON-RPC endpoint',
      proof: { type: 'rpc-read', independentlyAuthenticated: false, note: 'Proof records RPC reads; it is not an independent attestation.' }
    };
  }
  return {
    mode: 'mock',
    provider: 'deterministic-mock',
    source: 'local deterministic provider',
    proof: { type: 'deterministic-replay', independentlyAuthenticated: false, note: 'Mock data is for development only.' }
  };
}

function dataMode() {
  return process.env.OUTCOMEX_RPC_URL ? 'mixed' : 'mock';
}

function validateServiceInput(serviceId, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new ApiError(400, 'invalid_input', 'input must be an object');
  }
  if (serviceId === 'wallet_snapshot') {
    if (!isAddress(input.address)) throw new ApiError(400, 'invalid_input', 'wallet_snapshot requires a valid EVM address');
    normalizeBlock(input.block);
    if (input.chain !== undefined && (typeof input.chain !== 'string' || !input.chain.trim())) throw new ApiError(400, 'invalid_input', 'chain must be a non-empty string');
    return;
  }
  if (serviceId === 'contract_events') {
    if (!isAddress(input.address)) throw new ApiError(400, 'invalid_input', 'contract_events requires a valid contract address');
    const fromBlock = toNumber(input.fromBlock, 0);
    const toBlock = toNumber(input.toBlock, fromBlock + 100);
    if (!Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) || fromBlock < 0 || toBlock < fromBlock) {
      throw new ApiError(400, 'invalid_input', 'fromBlock and toBlock must be valid ordered block numbers');
    }
    if (input.eventSignature !== undefined && typeof input.eventSignature !== 'string') throw new ApiError(400, 'invalid_input', 'eventSignature must be a string');
    return;
  }
  if (serviceId === 'token_price_snapshot') {
    if (typeof input.pair !== 'string' || !input.pair.trim()) throw new ApiError(400, 'invalid_input', 'token_price_snapshot requires pair');
    normalizeBlock(input.block);
    if (input.chain !== undefined && (typeof input.chain !== 'string' || !input.chain.trim())) throw new ApiError(400, 'invalid_input', 'chain must be a non-empty string');
  }
}

class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

class OrderStore {
  constructor() { this.orders = new Map(); }
  create({ service, input, maxPayment, buyer }) {
    const createdAt = now();
    const requestId = randomId('req');
    const orderId = randomId('ord');
    const inputHash = hash(input);
    const amountUnits = parseUsdc(service.priceUsdc, 'service price');
    if (maxPayment !== undefined && maxPayment !== null) {
      const maxUnits = parseUsdc(maxPayment, 'maxPayment');
      if (maxUnits < amountUnits) {
        throw new ApiError(402, 'payment_limit_too_low', `maxPayment must be at least ${formatUsdc(amountUnits)} USDC`, { quoted: formatUsdc(amountUnits), maxPayment: String(maxPayment) });
      }
    }
    const order = {
      orderId, requestId, status: 'quoted', serviceId: service.id, input, inputHash, buyer: buyer || null,
      chainId: CHAIN_ID, amountUnits: amountUnits.toString(), amount: formatUsdc(amountUnits), asset: PAYMENT_ASSET,
      createdAt, updatedAt: createdAt, expiresAt: createdAt + 15 * 60, result: null, receipt: null,
      challenge: null, payment: null, lastError: null
    };
    this.orders.set(orderId, order);
    return order;
  }
  get(orderId) {
    const order = this.orders.get(orderId);
    if (!order) throw new ApiError(404, 'order_not_found', `Unknown order ${orderId}`);
    return order;
  }
  update(order, patch) { Object.assign(order, patch, { updatedAt: now() }); return order; }
}

const store = new OrderStore();

function paymentRequest(order) {
  return {
    mode: PAYMENT_MODE,
    scheme: PAYMENT_MODE === 'mock' ? 'simulation' : 'disabled',
    required: false,
    network: order.chainId,
    asset: order.asset,
    amount: order.amount,
    amountAtomic: order.amountUnits,
    recipient: null,
    expiresAt: order.expiresAt,
    description: `OutcomeX ${order.serviceId} request ${order.requestId}`,
    note: 'No funds are transferred by the local prototype.'
  };
}

function feeSplit(order) {
  const amount = BigInt(order.amountUnits);
  const provider = amount * 98n / 100n;
  const verifier = amount * 1n / 100n;
  const treasury = amount - provider - verifier;
  return {
    provider: formatUsdc(provider),
    verificationPool: formatUsdc(verifier),
    protocolTreasury: formatUsdc(treasury),
    providerAtomic: provider.toString(),
    verificationPoolAtomic: verifier.toString(),
    protocolTreasuryAtomic: treasury.toString(),
    asset: order.asset
  };
}

function quoteView(order) {
  const service = serviceDefinitions.find((item) => item.id === order.serviceId);
  return {
    orderId: order.orderId,
    requestId: order.requestId,
    status: order.status,
    service: servicePublicView(service),
    request: { serviceId: order.serviceId, input: order.input, inputHash: order.inputHash },
    payment: paymentRequest(order),
    protocolFee: { rate: '0.01', amount: feeSplit(order).protocolTreasury, amountAtomic: feeSplit(order).protocolTreasuryAtomic, treasury: null },
    settlement: { mode: PAYMENT_MODE, onchain: false, txHash: null },
    expiresAt: order.expiresAt
  };
}

function orderView(order) {
  return {
    orderId: order.orderId,
    requestId: order.requestId,
    status: order.status,
    serviceId: order.serviceId,
    buyer: order.buyer,
    chainId: order.chainId,
    amount: order.amount,
    amountAtomic: order.amountUnits,
    asset: order.asset,
    input: order.input,
    inputHash: order.inputHash,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    expiresAt: order.expiresAt,
    payment: order.payment,
    result: order.result,
    receipt: order.receipt,
    challenge: order.challenge,
    lastError: order.lastError
  };
}

async function executeOrderInternal(order) {
  if (order.status === 'fulfilled') return order;
  if (order.status === 'challenged' || order.status === 'refunded') throw new ApiError(409, 'order_closed', `Order is ${order.status}`);
  if (now() > order.expiresAt) { store.update(order, { status: 'expired' }); throw new ApiError(410, 'quote_expired', 'Payment quote has expired'); }
  if (PAYMENT_MODE !== 'mock' || !AUTO_SETTLE) {
    throw new ApiError(503, 'payment_verifier_unavailable', 'A real payment verifier is not configured; no payment proof was accepted', { paymentMode: PAYMENT_MODE, autoSettle: AUTO_SETTLE });
  }
  const provider = providers.get(order.serviceId);
  if (!provider) throw new ApiError(503, 'provider_unavailable', `No provider registered for ${order.serviceId}`);
  store.update(order, { status: 'processing', payment: { mode: 'mock', status: 'simulated', onchain: false, txHash: null, recipient: null } });
  let response;
  try {
    response = await provider(order.input, { order, chainId: CHAIN_ID });
    if (!response || !response.result) throw new Error('Provider returned no result');
  } catch (error) {
    store.update(order, { status: 'quoted', payment: null, result: null, receipt: null, lastError: { code: error.code || 'provider_failed', message: error.message || 'Provider failed', at: now() } });
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, 'provider_failed', error.message || 'Provider failed');
  }
  try {
    const resultHash = hash(response.result);
    const blockNumber = response.blockNumber ?? null;
    const proofType = response.provider === 'evm-rpc' ? 'rpc-read' : 'deterministic-replay';
    const result = {
      requestId: order.requestId,
      serviceId: order.serviceId,
      chainId: order.chainId,
      blockNumber,
      inputHash: order.inputHash,
      result: response.result,
      resultHash,
      provider: response.provider || 'mock-provider',
      proof: { ...response.proof, resultHash, type: proofType, independentlyAuthenticated: false },
      expiresAt: order.expiresAt
    };
    const receipt = {
      receiptId: randomId('rcpt'), orderId: order.orderId, requestId: order.requestId, status: 'simulated',
      settledAt: now(), onchain: false, txHash: null, payment: order.payment, split: feeSplit(order), resultHash
    };
    return store.update(order, { status: 'fulfilled', result, receipt, lastError: null });
  } catch (error) {
    store.update(order, { status: 'quoted', payment: null, result: null, receipt: null, lastError: { code: 'settlement_failed', message: error.message || 'Settlement failed', at: now() } });
    throw new ApiError(500, 'settlement_failed', error.message || 'Settlement failed');
  }
}

function executeOrder(order) {
  if (order.status === 'fulfilled') return Promise.resolve(order);
  if (order.executionPromise) return order.executionPromise;
  const execution = executeOrderInternal(order);
  order.executionPromise = execution;
  return execution.finally(() => {
    if (order.executionPromise === execution) delete order.executionPromise;
  });
}

async function parseBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new ApiError(413, 'body_too_large', 'Request body exceeds 1 MiB');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw); } catch (_) { throw new ApiError(400, 'invalid_json', 'Request body must be valid JSON'); }
}

function send(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Payment-Proof', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', ...headers });
  response.end(body);
}

function errorPayload(error) {
  return { error: { code: error.code || 'internal_error', message: error.message || 'Unexpected error', ...(error.details ? { details: error.details } : {}) } };
}

async function handle(request, response) {
  if (request.method === 'OPTIONS') { response.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-Payment-Proof', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }); return response.end(); }
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  const path = url.pathname.replace(/\/$/, '') || '/';
  if (request.method === 'GET' && path === '/health') {
    const providerMetadata = Object.fromEntries(serviceDefinitions.map((service) => [service.id, providerMetadataFor(service.id)]));
    return send(response, 200, {
      ok: true,
      service: 'outcomex-backend',
      chainId: CHAIN_ID,
      autoSettle: AUTO_SETTLE,
      paymentMode: PAYMENT_MODE,
      dataMode: dataMode(),
      providerMetadata
    });
  }
  if (request.method === 'GET' && path === '/v1/services') return send(response, 200, { services: serviceDefinitions.map(servicePublicView), chainId: CHAIN_ID, asset: PAYMENT_ASSET });
  const serviceMatch = path.match(/^\/v1\/services\/([^/]+)\/request$/);
  if (request.method === 'GET' && serviceMatch) {
    const service = serviceDefinitions.find((item) => item.id === serviceMatch[1]);
    if (!service) throw new ApiError(404, 'service_not_found', `Unknown service ${serviceMatch[1]}`);
    return send(response, 200, { service: servicePublicView(service), method: 'POST', endpoint: '/v1/request' });
  }
  if (request.method === 'POST' && path === '/v1/quote') {
    const body = await parseBody(request);
    const service = serviceDefinitions.find((item) => item.id === body.serviceId);
    if (!service) throw new ApiError(404, 'service_not_found', `Unknown service ${body.serviceId || ''}`);
    validateServiceInput(service.id, body.input);
    const order = store.create({ service, input: body.input, maxPayment: body.maxPayment, buyer: body.buyer });
    return send(response, 200, quoteView(order));
  }
  if (request.method === 'POST' && path === '/v1/request') {
    const body = await parseBody(request);
    const service = serviceDefinitions.find((item) => item.id === body.serviceId);
    if (!service) throw new ApiError(404, 'service_not_found', `Unknown service ${body.serviceId || ''}`);
    validateServiceInput(service.id, body.input);
    const order = store.create({ service, input: body.input, maxPayment: body.maxPayment, buyer: body.buyer });
    await executeOrder(order);
    return send(response, 200, { ...quoteView(order), result: order.result, receipt: order.receipt });
  }
  const orderRequestMatch = path.match(/^\/v1\/orders\/([^/]+)\/request$/);
  if (request.method === 'POST' && orderRequestMatch) {
    const body = await parseBody(request);
    const order = store.get(orderRequestMatch[1]);
    await executeOrder(order);
    return send(response, 200, { ...quoteView(order), result: order.result, receipt: order.receipt });
  }
  const orderMatch = path.match(/^\/v1\/orders\/([^/]+)$/);
  if (request.method === 'GET' && orderMatch) {
    return send(response, 200, orderView(store.get(orderMatch[1])));
  }
  const receiptMatch = path.match(/^\/v1\/orders\/([^/]+)\/receipt$/);
  if (request.method === 'GET' && receiptMatch) {
    const order = store.get(receiptMatch[1]);
    if (!order.receipt) throw new ApiError(404, 'receipt_not_ready', 'No receipt is available for this order');
    return send(response, 200, { ...order.receipt, result: order.result });
  }
  const challengeMatch = path.match(/^\/v1\/orders\/([^/]+)\/challenge$/);
  if (request.method === 'POST' && challengeMatch) {
    const body = await parseBody(request);
    const order = store.get(challengeMatch[1]);
    if (order.status !== 'fulfilled') throw new ApiError(409, 'challenge_unavailable', 'Only fulfilled orders can be challenged');
    if (!body.evidenceHash || typeof body.evidenceHash !== 'string') throw new ApiError(400, 'invalid_challenge', 'evidenceHash is required');
    store.update(order, { challenge: { status: 'recorded', evidenceHash: body.evidenceHash, reason: body.reason || null, createdAt: now() } });
    return send(response, 202, { orderId: order.orderId, status: order.status, challenge: order.challenge, note: 'Demo challenge evidence was recorded. It does not initiate a refund or change settlement.' });
  }
  throw new ApiError(404, 'not_found', `No route for ${request.method} ${path}`);
}

const server = http.createServer((request, response) => {
  handle(request, response).catch((error) => {
    const apiError = error instanceof ApiError ? error : new ApiError(500, 'internal_error', error.message || 'Unexpected error');
    send(response, apiError.status, errorPayload(apiError));
  });
});

if (require.main === module) server.listen(PORT, () => console.log(`OutcomeX backend listening on http://localhost:${PORT}`));

module.exports = { server, handle, registerProvider, providers, serviceDefinitions, store, canonicalize, hash };
