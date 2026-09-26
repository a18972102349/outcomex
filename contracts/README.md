# OutcomeX settlement contract

`src/OutcomeXSettlement.sol` is the v0.1 smart-contract USDC escrow and settlement contract. It holds tokens by contract rules but never receives private keys.

The buyer approves the contract and calls `createOrder` with the expected provider address. Only that provider can call `submitResult` with the result hash and a hash of its off-chain proof. The configured verifier calls `settle`
before expiry. Settlement pays the provider 98%, `rewardPool` 1%, and `treasury` 1%. If an
order is not settled by expiry, the buyer can call `refund`.

The contract stores only hashes. Gateway responses and proofs can remain off-chain while the
`OrderCreated`, `ResultSubmitted`, `OrderSettled`, and `OrderRefunded` events form an auditable
receipt trail.

## Build and test

The project is laid out for Foundry:

```bash
cd contracts
forge build
forge test -vvv
```

Foundry is not required to inspect or compile the sources. With Node.js and npm, a one-off
Solidity compiler invocation is:

```bash
npx --yes solc@0.8.24 --base-path . --bin --abi src/OutcomeXSettlement.sol
npx --yes solc@0.8.24 --base-path . --bin --abi test/OutcomeXSettlement.t.sol
```

Before deploying, use the official USDC address for the target network and set separate
verifier, reward-pool, treasury, and expected-provider addresses. The verifier is trusted in v0.1; a later version
can replace that role with a dispute or multi-verifier mechanism.
