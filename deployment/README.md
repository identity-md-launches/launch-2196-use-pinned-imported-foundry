# Deployment handoff (not a deployment receipt)

Use `launch.json` with `deployment/launch-terms.json`: Robinhood Chain 4663, `univ4_hook`, LaunchFactory. The latter freezes owner and the 88% pool / 10% swarm / 2% remainder allocation. Owner, treasury and remainder are `0x4251627b712762b6e81799698a05c6c9dff35c5d`. IMD retains LP custody and its platform distribution. The policy's 2,500 IMD opening valuation prices a single-sided CABAL seed; it is not 2,500 IMD deposited. The one-to-one manifest `initialPrice` is the required schema value; IMD computes the opening price from policy and the final token ordering.

`artifacts.json` contains exact constructor arguments/bytes, init-code hash, a proposed CREATE2 salt, predicted hook address and runtime hashes. The `.hex` and `abi/` files reproduce these without a package install. No ABI linking is required. `scripts/launch-artifacts.mjs` builds with the unchanged Foundry configuration, identifies immutables by compiler AST, patches the runtime template and checks the result against both local factory deployments.

The proposed hook address is deterministic, **not live**. Its salt may be replaced by IMD with another address satisfying `(address & 0x3fff) == 0x20cc`. CABAL's address depends on the actual IMD launch number and the token creation-code hash. No launch number, contributor Merkle root, source attestation, signature or production token address is invented here; IMD supplies its deployment metadata after acceptance. The token/hook addresses and pool IDs in fork reports are explicitly local fixtures.

Reproduce offline (Node 24+, Foundry 1.8.3, cached solc 0.8.26):

```sh
forge build --offline
FOUNDRY_FUZZ_SEED=0x25b0e155b7d99a4afe16ce19daf869cbff1cc18990f23669c40b4f5e6ad46323 forge test --offline
node scripts/launch-artifacts.mjs
node --test test/*.test.mjs
node scripts/simulate.mjs
```

Public read/fork checks, with no public transactions:

```sh
node scripts/check-protocol.mjs
node scripts/check-oracle.mjs
node scripts/review-factory.mjs
node scripts/review-factory.mjs --production-router
```

After IMD deploys, verify chain ID and runtime hashes of both contracts; read all six hook immutables; verify the token's name/symbol/decimals/supply/PvP views; derive the actual key from `LaunchFactory.positionOf(launchNumber)` and compare its ID to `boundPool`; require IMD/CABAL currencies, fee 12500, spacing 60, hook mask 0x20cc and the factory initializer. Verify the frozen `poolBps=8800`, MerkleDistributor swarm allocation and named remainder, including ordinary liquidity dust. Record the actual deployment transaction, block, token/hook addresses, pool ID and source attestation before creating any operational configuration.

At deployment, `paymentsEnabled=false`, `worker=address(0)` (the deliberate unconfigured state), and both spending caps are zero. An owner then configures a real worker and reviewed per-request/daily limits. The worker's current per-request cap must match 0.5 IMD and live capabilities/on-chain price. The daily cap bounds admission as well as payment: the worker refuses a duel whose eight decisions, beside every open reservation and today's recorded spend, do not fit `dailyLimit`, so sixteen simultaneous BO5s need a cap of at least 64 IMD per UTC day, and `dailyLimitAtomic` in the worker configuration must equal the on-chain value. Fund the request reserve separately with Robinhood IMD and gas separately with native Robinhood ETH. The disabled example deliberately leaves contract, worker and operational limits unset. There is no secret discovery or live-payment CLI.

The project must host its own durable worker and integrate the game coordinator, fresh wallet-signature eligibility checks and verified oracle result application. The free wording check is not admission or payment, and a paid event is not a verdict. Do not enable the game path before a paid live validation and failure/recovery review. No website, private delivery service, hosting or ongoing server operation is included in this handoff.
