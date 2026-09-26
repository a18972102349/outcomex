# OutcomeX backend v0.1

Zero-dependency Node HTTP API for the OutcomeX prototype. It uses deterministic mock providers by default, so it is safe to run locally without an RPC key or a wallet. Orders are held in memory and are lost when the process exits.

## Run

```powershell
cd backend
npm start
```

The server listens on `http://localhost:8787` (override with `PORT=9000`). CORS is enabled for the prototype frontend.

## API

`GET /health` returns process and settlement mode. `GET /v1/services` lists the three v0.1 services.

Create a quote:

```powershell
Invoke-RestMethod http://localhost:8787/v1/quote -Method Post -ContentType 'application/json' -Body (@{
  serviceId = 'wallet_snapshot'
  input = @{ address = '0x0000000000000000000000000000000000000001'; chain = 'base-sepolia'; block = 123 }
  maxPayment = '0.020'
} | ConvertTo-Json)
```

Execute directly (the default local mode accepts a mock payment):

```powershell
Invoke-RestMethod http://localhost:8787/v1/request -Method Post -ContentType 'application/json' -Body (@{
  serviceId = 'wallet_snapshot'
  input = @{ address = '0x0000000000000000000000000000000000000001'; block = 123 }
  maxPayment = '0.020'
} | ConvertTo-Json)
```

The quote flow can instead be completed with `POST /v1/orders/:orderId/request`, then read at `GET /v1/orders/:orderId/receipt`. `GET /v1/orders/:orderId` returns the full in-memory order state. `POST /v1/orders/:orderId/challenge` accepts `{ "evidenceHash": "0x...", "reason": "..." }` and records evidence without changing settlement or issuing a refund.

The default local mode is deliberately explicit: it uses `paymentMode=mock`, never transfers funds, and returns a receipt with `status=simulated`, `onchain=false`, and `txHash=null`. Set `OUTCOMEX_AUTO_SETTLE=false` or `OUTCOMEX_PAYMENT_MODE=disabled` to refuse execution until a real payment verifier is implemented. Arbitrary objects and `X-Payment-Proof` headers are not accepted as proof.

Any unsupported value of `OUTCOMEX_PAYMENT_MODE` is reported as `unsupported` and also refuses execution; it never silently falls back to mock payments.

## Providers

The mock providers implement deterministic responses for `wallet_snapshot`, `contract_events`, and `token_price_snapshot`. A provider is an async function `(input, context) => ({ result, blockNumber, proof, provider })`. Register one from code with `registerProvider('wallet_snapshot', fn)`, or load a module at startup:

```powershell
$env:OUTCOMEX_PROVIDER_MODULE = 'C:\path\to\providers.js'
npm start
```

The module may export either `{ wallet_snapshot: fn }` or `{ providers: { wallet_snapshot: fn } }`. Production providers should validate and replay the requested block before returning a result; this API only supplies the protocol envelope and in-memory lifecycle.

### Real EVM read-only provider

Set `OUTCOMEX_RPC_URL` to opt `wallet_snapshot` into the built-in native `fetch` provider. The local mock remains the default when this variable is absent.

```powershell
$env:OUTCOMEX_RPC_URL = 'https://your-base-sepolia-rpc.example'
$env:OUTCOMEX_CHAIN_ID = 'base-sepolia'
$env:OUTCOMEX_USDC_ADDRESS = '0xYourUsdcContractAddress' # optional
npm start
```

The provider reads `eth_blockNumber`, `eth_getBlockByNumber`, `eth_getBalance`, and, when an address is configured, the USDC `balanceOf` call at one pinned block. It does not hold keys or submit transactions. RPC responses are included in the result proof envelope, but are not an independent cryptographic attestation.

## Test

```powershell
npm test
```
