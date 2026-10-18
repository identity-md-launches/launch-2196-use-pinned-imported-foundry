# Cabal funding test review

This contribution adds tests and review evidence only. `src/`, the worker, the
launch manifest, deployment artifacts, dependencies, and configuration are
unchanged. No live deployment, paid oracle admission, or game operation is claimed.
No new implementation defect was confirmed by this review.

This revision reran every suite after the accepted worker day-cap change
(`worker/day-cap.mjs`, admission and engine deferral) and added contract-level
tests for the hook state that change reads.

## Reproduce offline

The Solidity suite uses the existing pinned libraries and a small local cheatcode
interface; no added package, RPC, FFI, or forge-std installation is required.
Node tests use the supplied vendor bundle and Node 24's SQLite.

```sh
FOUNDRY_OUT=test/scratch/out FOUNDRY_CACHE_PATH=test/scratch/cache forge build
FOUNDRY_OUT=test/scratch/out FOUNDRY_CACHE_PATH=test/scratch/cache FOUNDRY_FUZZ_SEED=0x25b0e155b7d99a4afe16ce19daf869cbff1cc18990f23669c40b4f5e6ad46323 forge test
npm test
node test/replay-reviews.mjs local
```

The output-directory variables confine generated files to the assigned scratch
area. They do not alter compiler settings or the tested behavior. Ordinary
`forge test` also discovers every new Solidity test. Scratch is not a dependency:
it can be deleted before a clean build. No test changes environment variables.

`replay-reviews.mjs` runs unmodified copies of the existing review programs in
scratch and saves their reports under `test/review-results/`. It needs Anvil for
`local` and `router`; the default Foundry suite does not. Reproduce public reads
and the optional production-router fork separately:

```sh
node test/replay-reviews.mjs protocol
node test/replay-reviews.mjs router
```

Only these two optional modes need network access. The public RPC in the fork
program is read-only; all transaction execution occurs on disposable loopback
Anvil. The local E2E uses the actual compiled hook and PoolManager, SQLite journal,
and transaction adapter with a mock Intake.

## Added properties and adversarial cases

| Test file | Properties checked |
| --- | --- |
| `CabalFundingHookFailures.t.sol` | All six constructor roles; invalid hook mask; constructor without external calls; exact permission flags; default-disabled settings; factory-only, one-time pool binding; wrong pool/manager/owner/worker; immutable economics; worker rotation; calendar-day and deadline boundaries; empty, zero and oversized requests; maximum body; exact action/asset/no callback; event fields used by receipt reconciliation. |
| `CabalFundingHookFailures.t.sol` | Atomic rollback on Intake revert, undercharge, overcharge, zero ID, approval failure and allowance-clear failure; retry after rollback; fee-on-transfer deposit/harvest rejection; zero/excess settlement; reentrancy into funding operations; unsynced donations; swaps and harvest during Intake/treasury failure. |
| `CabalFundingHookArithmetic.t.sol` | 1,000-run full-uint256 fee bounds and round-trip rounding properties; zero/one/divisor/max edges; signed bounds; wrong-sign deltas; partial-fill rejection; real swaps at atomic-unit boundaries; ten one-wei harvests with interleaved treasury payouts; CABAL-only first buys in both orderings; actual unrelated-pool swaps and plain wallet transfers. |
| `CabalFundingHookInvariant.t.sol` | Real PoolManager and LaunchToken; three funded actors; four swap modes; prefunding, unsynced donations, sync, dust/full harvest, fixed-treasury payout, owner configuration, day advancement, payments, replay, Intake failures, unauthorized calls and buy/sell round trips. |
| `CabalFundingHookDayCap.t.sol` | The `dailyLimit`/`spentDay`/`spentToday` views the worker's admission reads: stale views after UTC midnight still allow a full new-day cap; a reverted payment on a new day leaves the old day recorded; lowering the cap below today's spend gives zero headroom without reset; caps that are not a price multiple round down; 63.5 IMD funds 127 decisions and 64 IMD exactly sixteen BO5s. A 512-run fuzz copies the worker's headroom formula and checks, for worker clocks from one hour behind to five minutes ahead of the chain, that it never promises a payment `payRequest` rejects, and is exact outside the skew window. |
| `LaunchTokenInvariant.t.sol` | Four holders; transfers, self/zero/full-balance transfers, finite/infinite approvals, delegated transfers, revoked allowances, overdraw failures and crossing both sides of the PvP threshold. |

The hook handler keeps separate cumulative ghosts for fees, redeemed claims,
deposits, unbooked donations, paid decisions, treasury transfers and daily spend.
Swap properties compare router deltas with actual wallet debits/credits and the
required rounding inequalities. Invariants check:

- ERC-6909 claims equal fees not yet redeemed.
- Harvested fees equal the cumulative 70/30 allocations, including dust.
- Cash equals requests plus treasury plus explicitly unbooked donations.
- Actual Intake and fixed-treasury receipts equal the corresponding ledger flows.
- Decision IDs/body hashes never change after successful payment; failed attempts
  do not consume keys, caps, balances or approval.
- A full final harvest and treasury payout remain possible after each sequence.
- CABAL supply remains exactly 1e27 across all tracked holders, with current-balance
  eligibility at exactly 50,000 CABAL and no CABAL collected as custom tax.

Each of the three invariant campaigns has **256 runs, depth 64**, with
`fail-on-revert = true` on the concrete test contract. The requested seed produced
16,384 calls per campaign, 49,152 total, with zero unexpected reverts or discards.
Expected failures are explicitly asserted. Smoke sequences exercise every handler
action so a passing result cannot be explained by only idle actions. These tests
use no assumptions that discard fuzz inputs and do not read implementation storage
slots to force a desired state.

The pinned Pashov conservation/transition/rounding guidance, Trail of Bits property
and failure-classification guidance, and Ethereum testing reference informed the
properties. The oracle callback conformance vector is intentionally inapplicable:
this hook pays with no callback and implements no attestation/result consumer.
Adding such a consumer or mutable protocol addresses would violate this assignment.

## Review evidence

- `review-results/validation.json`: build/test results and per-selector invariant
  activity for the requested seed.
- `review-results/local-e2e.json`: 1,000 IMD taxable input, 40 IMD custom fees,
  28 IMD request allocation, 12 IMD treasury payment; eight payments costing 4 IMD,
  24 IMD left; delayed inclusion and lost-broadcast-reply recovery without duplicates;
  worker day-cap headroom equal to the compiled hook's state and a capped request
  deferred without any transaction.
- `review-results/protocol-review.json`: public reads at Robinhood block **92141844**.
  Policy **30** is unchanged: 12500 pool fee, 2,500 IMD opening valuation, 1000 bps
  swarm. The request action still costs **0.5 IMD** and capabilities match. Runtime
  hashes for the factory, manager, IMD, Intake, fees, router, quoter and Permit2 match
  the pinned inputs.
- `review-results/production-router-review.json`: local fork of block **92141917**,
  both currency orderings. Real LaunchFactory construction and initialization,
  8800/1000/200 allocation (including recorded liquidity dust), factory LP custody,
  bound pool, mask `0x20cc`, constructor inputs, runtime hashes, default-disabled
  payments and separate platform 80/20 distribution all passed.

The fork uses UniversalRouter `0x8876789976decbfcbbbe364623c63652db8c0904`,
V4Quoter `0x8dc178efb8111bb0973dd9d722ebeff267c98f94`, and Permit2
`0x000000000022d473030f116ddee9f6b43ac78ba3`. It retains Explorer's extended struct,
`minHopPriceX36=0`, command `0x10`, and exact-input actions `0x060c0f`. Quotes match
execution without deducting custom tax twice. Both directions, exact output,
slippage, stale quotes, deadlines, ERC-20/Permit2 approval failures and fee
accounting pass. Oversized orders fail quoting with `NotEnoughLiquidity`; the
separate raw-router partial-sell experiment is only an adversarial local test and
is not an instruction to bypass the UI's quoting or slippage checks.

## Preserved artifacts and remaining integration limits

The existing `launch.json`, `deployment/launch-terms.json`, `deployment/artifacts.json`,
ABIs and bytecode remain the deployment deliverable. Existing manifest tests pass,
and the new fork reproduced their hook runtime hash
`0xe002e444095eb296e54f14ed9f184ac853b471c487a2eeef691eba00dcde2a12`
and token runtime hash
`0xe4fa5c19f0134218cadbe7b24ed351e93304b662d14aefcba844019a33d9d79d`.
The proposed hook `0xf48FC94eA3E8e096B3e85b5B925645217168E0CC` is a deterministic
candidate, not a production deployment. The real launch number, token address,
and bound pool are still assigned/verified through IMD's launch process.

This suite does not establish IMD off-chain admission, browser wallet integration,
private question acceptance, signature injection, or verified oracle-result
application. The project must separately integrate the game coordinator and its
fresh wallet-signature/eligibility check at every queue entry. Payment receipts
prove spending, not admission or a verdict.

Keep payments disabled and the worker unset at deployment. Owner configuration,
operational review, verified deployment, paid live validation, at least 4 IMD per
reserved BO5 (64 IMD for sixteen) plus an operating reserve, and separate native
Robinhood ETH gas funding remain activation prerequisites. Tax volume is no funding
guarantee. Immutable Intake/action retirement can strand request reserves; the
explicit no-migration/no-sweep design is retained. The authorized factory remains
trusted to choose the final token and tick spacing before permanent binding.

The worker's day-cap arithmetic tolerates its clock running at most five minutes
ahead of the chain. A worker clock further ahead across UTC midnight computes a
full new-day headroom the contract does not yet allow; `payRequest` then rejects
with `LimitExceeded` before any IMD moves, so the limit is liveness, not funds.
Keep the host clock synchronized. The on-chain `dailyLimit` must be at least
64 IMD for sixteen simultaneous BO5s; a larger request fund does not raise it.

The platform fee is additional to custom tax and outside the 70/30 allocation;
these tests do not support a flat all-in 5.25% quote or unlimited fill promise.
