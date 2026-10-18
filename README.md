# Cabal automatic request funding

Adapted and revalidated locally, 19 October 2026 (Europe/Berlin). See `ADAPTATION.md` for each change and the imported audit dispositions. Nothing here has been deployed or activated on a public network. Live execution defaults to disabled; production settings are kept outside this reusable source package. The deployed Robinhood LaunchFactory was exercised successfully on a disposable local fork in both currency orderings. See `reports/contract-review.txt`, `reports/factory-fork-review.json` and the subsequent production-router review. These checks do not grant IMD's off-chain manifest acceptance or constitute an independent security audit.

`src/LaunchToken.sol` supplies the required plain ERC-20: Cabal Coin (CABAL), one billion tokens, 18 decimals, all minted to the deploying factory. No token transfer tax, privileged minting or administrative switches are added. The custom tax belongs to the pool hook. The factory handles the supply distribution.

The token exposes a fixed `PVP_MINIMUM_HOLDING` of 50,000 CABAL (`50000000000000000000000` atomic units) and `isPvpEligible(address)`. Both are read-only. Eligibility is inclusive at the threshold and immediately becomes false if a balance falls below it. This never restricts token transfers or authorizes a game session: the authoritative game server must verify a fresh wallet signature and read the current balance/eligibility for each queue entry. The client requires no approval, staking or transaction to check access.

## Money flow

`official CABAL/IMD pool -> 4% custom swap fee -> 70% request fund + 30% fixed project treasury`

The pool's separate 1.25% platform fee remains in place. The hook requires that pool fee at initialization and never overrides it. The 70/30 split applies only to the custom tax. Plain CABAL transfers are unaffected. Pools without this hook are outside its scope.

The hook records fee income as Uniswap ERC-6909 claims during swaps. This avoids withdrawing IMD before a router has settled its input, including the first buy into a pool initially funded only with CABAL. A worker redeems available claims through `harvest`, which makes the 70/30 allocation spendable. It then calls `payTreasury`; the destination is immutable. Treasury payout failure cannot block swaps or erase its outstanding balance.

Fee allocation is cumulative: `requestAllocation = floor(totalHarvested * 7 / 10)`. Treasury gets the remainder. Splitting a harvest into many tiny operations produces the same total allocation. Prefunding through `deposit`, or direct IMD transfers followed by `syncDonations`, goes entirely to requests and is never split again. Undistributed claims remain visible in `pendingFees`.

## Exact fee bases

| Swap | Calculation |
|---|---|
| Buy, exact IMD input | Custom fee `floor(gross IMD input / 25)`, before the remaining input reaches pool pricing. |
| Sell, exact CABAL input | Custom fee `floor(gross IMD output / 25)`, where gross output is the pool result before the hook deduction. |
| Buy, exact CABAL output | Required pool IMD input includes its pool fee. Add `ceil(pool IMD input / 24)` to gross up for a 4% custom tax. |
| Sell, exact IMD output | Add `ceil(net IMD requested / 24)` to the pool output requirement; user receives the specified net IMD. |

The hook uses integer atomic units. Rates must not be advertised as a simple fixed all-in 5.25% quote: fee bases, price impact and rounding matter. Where IMD is the specified amount, a partial fill reverts atomically rather than retaining a prepaid fee on unused input. Normal router slippage protections still apply. IMD's deployed quoter also rejects an amount that cannot fill completely; its UI then disables the trade. Smaller fillable amounts can still quote. See the production-router review for the separate raw-router partial-sell test.

## Restricted request payments

`CabalFundingHook.payRequest` may be called only by the configured worker. It can pay only the immutable IMD token to the immutable intake, using `oracle.request@oracle-1`, with no callback. It cannot select arbitrary recipients or spend the treasury allocation. It enforces per-request and UTC-day limits, an expiry, and a unique decision key. The amount must equal `Intake.priceOf` at execution; overpayment and changed pricing revert before debit. Intake approval is for the exact payment and is cleared immediately afterward. A failed or undercharged intake call rolls back accounting and authorization. Reentrancy is guarded.

The owner can rotate the worker, change its spending caps, and disable request payments. The owner cannot change the 4/4 tax, 70/30 split, treasury recipient, token or intake. There is no token/trading pause, arbitrary fund withdrawal, proxy or upgrade path. Intake migration is deliberately **not** implemented as a generic owner withdrawal; a future change needs a separately reviewed migration design. The operator is trusted to submit legitimate game requests and protect its signing key. Daily limits bound, but cannot eliminate, abuse by a compromised authorized worker.

The owner must fund the request balance with Robinhood-chain IMD and the worker wallet with Robinhood native ETH. No gas conversion, bridging, holder rewards or platform-fee redistribution is implemented.

## Worker and game integration

- `worker/store.mjs`: durable SQLite WAL ledger, full synchronous commits, atomic reservations, immutable queued input, and a worker lease. Place its database on persistent local storage. One coordinator owns this database; do not run an independent copy per region or use a network filesystem for SQLite.
- `worker/budget.mjs`: server-only admission and asynchronous decision queue interface; await `queueDecision`. It reserves up to eight decisions (4 IMD at the current price) per BO5 plus an operator-defined minimum reserve. Sixteen fully reserved BO5s require 64 IMD before that extra reserve and gas. Free matches are not charged by this package. Admission also honors the contract's UTC-day cap: every open reservation plus the spend the contract already counts for today plus the new eight decisions must fit `dailyLimit` (`worker/day-cap.mjs`), so a duel is refused with `Daily spending cap reached` rather than admitted with decisions the contract would reject. An owner `dailyLimit` of at least 64 IMD is therefore needed for sixteen simultaneous BO5s. `config.dailyLimitAtomic` must equal the on-chain cap.
- `worker/engine.mjs`: scheduled maintenance, request submission and reconciliation. The database commits exact signed transaction bytes before broadcasting. Unknown outcomes are reconciled first; retries use the identical bytes/hash/nonce. Confirmed reverts are not automatically paid again. A queued request the contract's UTC-day cap would reject is neither simulated nor signed: the engine reports `day_cap` with the next UTC midnight as `resumesAt`, records one `day_cap` event per day, keeps the job `queued`, and still runs fee harvests and treasury payouts behind it.
- `worker/chain-adapter.mjs`: verifies RPC chain, deployed runtime hash, token/intake, treasury, worker and caps; checks current IMD request price against both capabilities and Intake; refuses changed panel limits; preflights wording before signing; signs through an explicitly supplied wallet client; caps gas cost; verifies canonical receipts and expected events. It checks the last confirmed block for deeper reorgs before further spending.
- `worker/service.mjs`: background loop with operator status callbacks. It creates no wallet, web endpoint or secret loader. The existing game must supply the server wallet adapter and frozen decisions. None of these modules is imported into the browser or enabled by the current combat server.
- `worker/cli.mjs`: read-only preparation status. There is no live-spend CLI command in this package.

Instantiate `FundingStore` on durable storage, build the chain adapter from a reviewed config and a wallet client injected through server secret management, and use `DuelFundingBudget` at authoritative duel admission/round completion. Run `runFundingService` in that same coordinator. Only trusted internal game code may queue paid questions. Do not expose the raw queue as a public player API. The budget helper serializes explicit public oracle fields; private gameplay checks remain server-side and must never be embedded in public questions.

`runFundingService` reports `disabled`, `idle`, `submitted`, `pending`, `confirmed`, `uncertain`, `failed`, `superseded`, `blocked`, `low_gas`, `low_imd`, `day_cap`, `price_changed`, `terms_changed`, or `unavailable`. Feed these to the operator monitor. A payment confirmation is not an oracle verdict: IMD admission/result polling and signed decision application remain a separate game integration. A failed admission can still consume its request fee. Do not blindly repay it or label a local decision as a real swarm result.

## Failure recovery

Keep database backups and its signed-transaction journal private. Signed request transactions expire after the named `REQUEST_DEADLINE_SECONDS=1800` (30 minutes). This allows ordinary inclusion delays; it does not guarantee inclusion. After an uncertain outcome, restart with the same database and signer; the worker reconciles saved transactions. A pending transaction blocks new nonce allocation. The process lease expires after two minutes; fencing is checked before state updates and broadcasts. RPC requests have bounded timeouts. An unusually long external signing operation may lose its lease; it must not broadcast afterward.

`blocked` is persistent and requires operator reconciliation. Never delete the ledger to clear it. For a deep reorg, compare canonical contract events, `paidRequests`, request balances and match reservations before repairing the local checkpoint or reservation values. For an expired/confirmed-reverted transaction, investigate before any separately approved new attempt; the original decision key remains immutable in the local journal, and queueing that decision again throws `Decision payment failed` instead of returning the dead row, so the game coordinator learns the decision is unfunded. `day_cap` is not a fault: it clears at the next UTC midnight, or when the owner raises `dailyLimit` and the worker configuration is updated to match. A dropped transaction can be rebroadcast unchanged; automated gas replacements are intentionally omitted. Low gas/IMD or changed prices stop spending rather than taking money from treasury. Existing ambiguous reservations stay held.

Maintenance batches at a configurable minimum (example: 1 IMD). It does not promise transfers after each swap or at exact intervals. An idle worker settles pending balances; during queued requests it schedules bounded maintenance at roughly one-minute intervals. No service can operate with no ETH for gas. Volume alone is not a funding guarantee.

Unsigned maintenance is resized or marked superseded when another caller has already settled it. Once signed, its bytes remain immutable. Duel admission takes the same coordinator lease as payment reconciliation, preventing a stale balance snapshot from reserving funds just consumed by a payment. A busy coordinator rejects admission temporarily; the matchmaking integration must retry before admitting that duel.

## Reproduce without real funds

Requirements: Node 24+, Foundry 1.8.3, Solidity 0.8.26.

```sh
forge test --offline -vv
npm test
npm run status
npm run simulate
```

The simulation spawns Anvil on `127.0.0.1:18549`, chain 31337, uses a public disposable fixture key, deploys the real Uniswap PoolManager and compiled hook, creates a local pool and executes actual swaps. It uses a mock intake. It kills its Anvil process and removes its temporary database afterward. The local adapter rejects public RPC URLs and other chain IDs. Never fund the public fixture account.

`npm run review:factory` separately runs a local fork of Robinhood, using its deployed factory, pool manager, IMD and intake. It reads the public chain through an explicit read-method allowlist, uses local ports 18551/18552, injects fixture funds only into local state, and impersonates the IMD deployer only on the local fork. It creates no actual launch or paid swarm request. The ABI fixture is copied from the factory's explorer-verified source; provenance is recorded beside it. The JSON report pins the block, runtime hashes and limits of the test. It uses a Uniswap test router; it does not validate the production trading UI or grant IMD's off-chain approval.

The source package includes vendored Solidity dependencies for offline Foundry compilation. Node runtime packages remain pinned in `package-lock.json` and are supplied as ordinary bundled ESM source in `vendor/`, so no npm install is needed for tests or operation. Foundry may need to cache Solidity 0.8.26 once before an offline run. No `forge --broadcast` or public-network script is included.

`npm run review:router` uses the same read-only fork boundary with the deployed IMD UniversalRouter, V4Quoter and Permit2 instead of a test router. It reproduces the observed Explorer exact-input encoding (`0x10`, actions `0x060c0f`, extended swap parameters, 1% output tolerance, ten-minute deadline). It additionally tests the deployed exact-output path. Each currency-ordering scenario starts from the same local fixture snapshot. Quotes must equal execution; expired deadlines, missing approvals and insufficient slippage limits must revert without retaining fees or tokens. The price-movement and liquidity-boundary tests use disposable snapshots. These are local contract-path tests, not browser-wallet interactions or real pool transactions. Provenance is in `test/fixtures/IMDTrading.provenance.json`; results are in `reports/production-router-review.json`.

## Validation and launch readiness

Local validation covers both token orderings and all four buy/sell exact-input/output cases, single-sided first liquidity, 70/30 conservation, cumulative dust, prefunding, plain transfers, access control, reentrancy, daily limits, failed transfers/intake calls, partial-fill rollback, duplicate requests, three fuzz tests, reservations for 16 BO5s, UTC-day-cap admission and dated deferral (also against the compiled contract on the local chain), refusal to re-queue a failed decision key, lost replies, restart recovery, gas exhaustion, changed prices, worker fencing, receipt mismatches and reorgs. The full worker/contract simulation result is in `reports/local-e2e.json`.

Before activation, still required:

1. Production worker address and spending/reserve/gas limits. Owner, treasury and remainder are fixed to `0x4251627b712762b6e81799698a05c6c9dff35c5d`; worker and deployment settings remain unset.
2. Review of this exact code and the pinned dependencies. Passing local tests is not an independent security audit.
3. Final IMD manifest/admission and revalidation against the actual launched pool. Factory deployment, initializer caller, constructor support, CREATE2 mask `0x20cc`, platform fee collection and both currency orderings are covered on a local fork. The production router and quoter are covered by the subsequent review; the actual browser wallet flow is not. The manifest must select `univ4_hook` / LaunchFactory, not `evm_project` / ProjectFactory's initialization-only guard. The final source must be pinned to a public repository and commit before an imported launch request can use it.
4. IMD acceptance of the supplied `launch.json` and `deployment/launch-terms.json`, and the actual deployment receipt. `deployment/artifacts.json` supplies reproducible bytes, ABIs, runtime hashes and a mined hook prediction; it is not a live deployment. The actual launch number determines the token address. Freeze `poolBps=8800` and the named remainder instead of falling back to policy defaults.
5. Durable coordinator deployment, secret injection, operator monitoring, actual game queue/result integration and a finite timeout/error policy.
6. Separately authorized deployment and any public-chain smoke test. Current config remains disabled with unresolved addresses; no funds should be sent to assumed future addresses.

Sources: [IMD documentation](https://imd.fun/docs/), [Uniswap v4-core](https://github.com/Uniswap/v4-core), [OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts). Current policy/code/capability reads and free public wording probes are recorded in `reports/protocol-review.json` and `reports/oracle-preflight-review.json`. No private game question, paid request or public transaction was sent.

## Adapted launch terms and preflight

Policy 30 is unchanged: fee 12500, opening valuation 2,500 IMD, swarm share 10%. Its default pool allocation is 80%, but this launch explicitly supplies `economics: {poolBps: 8800, remainderTo: "0x4251627b712762b6e81799698a05c6c9dff35c5d"}` in the separate deployment terms. Current IMD docs support this override for hook launches. The pool is seeded only with CABAL; the valuation does not require a 2,500 IMD deposit. LP custody and the separate 80% requester / 20% network fee allocation remain with IMD. Factory rounding returns unused atomic liquidity dust to the remainder recipient.

`queueDecision` now returns a Promise and freezes its public body before any network work. Questions may contain 20–2,000 JavaScript UTF-16 code units and must be well-formed Unicode; the original lower bound and fixed panel/output rules are preserved. Before enqueue and again before signing, a free `/requests/check` must return a judged result with no blockers. That endpoint accepts only the documented shorter wording input; the worker validates the fixed paid body locally and never replaces it with the API's default draft. It does not add `allowAmbiguous`, callbacks or unreviewed body fields. No service outage can make a payment bypass preflight. Changed pricing or panel limits persistently halt new spending for operator review.

The original upgrade-choice fixture fails the live wording/public-evidence screen. Real game questions must be independently worded and pass that screen before activation; no private gameplay semantics are invented here. A successful free check still does not guarantee later paid admission or delivery. There is no on-chain result consumer in this package; the separate game integration must verify and apply results. The 30-minute payment transaction deadline is separate from the unchanged 300-second oracle answer validity requested in the body.
