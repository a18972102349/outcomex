const DEFAULT_USDC_ADDRESS = process.env.OUTCOMEX_USDC_ADDRESS || '';

class EvmRpcError extends Error {
  constructor(message, details) { super(message); this.name = 'EvmRpcError'; this.details = details; }
}

function isAddress(value) { return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value); }

function toQuantity(value) {
  if (value === undefined || value === null || value === '' || value === 'latest') return 'latest';
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new EvmRpcError('block must be a non-negative integer or latest');
  return `0x${number.toString(16)}`;
}

function fromQuantity(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new EvmRpcError('RPC returned an invalid quantity', { value });
  return Number.parseInt(value.slice(2) || '0', 16);
}

function quantityToDecimal(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]*$/i.test(value)) throw new EvmRpcError('RPC returned an invalid balance', { value });
  return BigInt(`0x${value.slice(2) || '0'}`).toString(10);
}

function padAddress(address) { return address.slice(2).toLowerCase().padStart(64, '0'); }

function normalizeRpcResult(response) {
  if (!response || response.jsonrpc !== '2.0') throw new EvmRpcError('Invalid JSON-RPC response', { response });
  if (response.error) throw new EvmRpcError(response.error.message || 'JSON-RPC request failed', response.error);
  return response.result;
}

async function rpcRequest(rpcUrl, method, params, fetchImpl = globalThis.fetch) {
  if (!rpcUrl) throw new EvmRpcError('OUTCOMEX_RPC_URL is not configured');
  if (typeof fetchImpl !== 'function') throw new EvmRpcError('This Node runtime does not provide fetch');
  const response = await fetchImpl(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }) });
  if (!response.ok) throw new EvmRpcError(`RPC HTTP ${response.status}`);
  return normalizeRpcResult(await response.json());
}

function createEvmWalletSnapshotProvider({ rpcUrl = process.env.OUTCOMEX_RPC_URL, chain = process.env.OUTCOMEX_CHAIN_ID || 'base-sepolia', usdcAddress = DEFAULT_USDC_ADDRESS, fetchImpl } = {}) {
  return async function evmWalletSnapshot(input) {
    if (!input || !isAddress(input.address)) throw new EvmRpcError('wallet_snapshot requires a valid EVM address');
    const requestedBlock = toQuantity(input.block);
    const blockHex = requestedBlock === 'latest' ? await rpcRequest(rpcUrl, 'eth_blockNumber', [], fetchImpl) : requestedBlock;
    const blockNumber = fromQuantity(blockHex);
    const blockRecord = await rpcRequest(rpcUrl, 'eth_getBlockByNumber', [blockHex, false], fetchImpl);
    if (!blockRecord || typeof blockRecord !== 'object') throw new EvmRpcError('RPC returned no block for the requested height');
    if (blockRecord.number && fromQuantity(blockRecord.number) !== blockNumber) throw new EvmRpcError('RPC block number changed during snapshot');
    const nativeHex = await rpcRequest(rpcUrl, 'eth_getBalance', [input.address, blockHex], fetchImpl);
    const tokenBalances = [];
    if (isAddress(usdcAddress)) {
      const tokenHex = await rpcRequest(rpcUrl, 'eth_call', [{ to: usdcAddress, data: `0x70a08231${padAddress(input.address)}` }, blockHex], fetchImpl);
      tokenBalances.push({ symbol: 'USDC', address: usdcAddress, decimals: 6, atomic: quantityToDecimal(tokenHex) });
    }
    return {
      result: { address: input.address, chain, blockNumber, nativeBalance: { symbol: 'ETH', decimals: 18, atomic: quantityToDecimal(nativeHex) }, tokenBalances, nftHoldings: [], recentTransfers: [] },
      blockNumber,
      provider: 'evm-rpc',
      proof: { source: rpcUrl, method: 'eth_blockNumber+eth_getBlockByNumber+eth_getBalance+eth_call', blockTag: blockHex, blockHash: blockRecord.hash || null }
    };
  };
}

module.exports = { EvmRpcError, createEvmWalletSnapshotProvider, rpcRequest, toQuantity, quantityToDecimal };
