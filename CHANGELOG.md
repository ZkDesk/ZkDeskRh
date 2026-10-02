# Changelog

## 3.15.0 (October 2026)

- **TypeScript types for the agent SDK:** `agent/index.d.mts` and `agent/paywall.d.mts` describe `createAgent` and every agent method, `createPaywall`, and the memory, file and Redis stores, including the result shapes. A payment is either confirmed with its transaction or not confirmed with a status. A paid fetch either has the answer, or has the request id to retry with. Editors complete and check every call; nothing changes at run time.
- `pnpm test:types` compiles a usage example against the types (also in CI), and `pnpm test` fails if a method or export is added without its type.
- **Fix (found by the review):** checking a payment receipt (`verifyReceipt`, `zkdesk_verify_receipt`, `scripts/verify-receipt.mjs`) asked whichever contract the receipt itself named. A forged receipt naming a contract that always answers "valid" passed. Receipts are now checked only against ZKdesk's own MandateRegistry on the agent's network (the current one, or a replaced contract set's for an older receipt). A receipt naming another contract or network is refused.
- `scripts/verify-receipt.mjs` now verifies mainnet receipts: it takes the network from the receipt; before, it always checked testnet. Pass your address as `expected-verifier` to check a receipt is meant for you. `zkdesk_verify_receipt` now returns what a valid receipt proves (who it is for, the treasury, the period, the amount if disclosed) alongside `valid`.

## 3.14.0 (October 2026)

- **Lasting paywall state:** `createPaywall({ store })` keeps open challenges, reserved amounts, used payments and per-caller slots in a store with three atomic operations: add-if-absent with an expiry, get and delete.
  - `memoryStore()`, the default: one process, forgotten on a restart.
  - `fileStore(path)`: one process, kept across restarts; written privately and atomically.
  - `redisStore(client)`: any number of instances sharing a node-redis client; no new dependency.
- **Across instances:** each payment is claimed with add-if-absent, so it unlocks exactly one request even when two instances see it at once. A challenge issued by one instance is served by another, and the per-caller bound counts across them. A used payment stays claimed for 30 days.
- The open challenges are bounded by the 9,999 amounts, which replaces `maxOpen`.
- Paywalls on one account that are given no store share one, so their amounts never collide.
- **Reviewed adversarially before release.** Two rounds found and fixed:
  - a paid caller left unserved when the store failed after the payment was claimed, or when the file store could not save (a change that is not saved is now undone)
  - a stale copy of a challenge on another instance claiming a newer challenge's payment
  - unbounded state from long URLs (over 2,048 bytes is a 414; routes are stored hashed)
  - caller slots and amounts kept after a failure, and too many store calls when amounts run short
  - IPv6 callers keyed before their address was expanded
  - the file store's temporary file (now created new, synced, then renamed) and a corrupt file being overwritten (it now stops the start)
  - Redis: it must not evict keys early (`maxmemory-policy noeviction`)

## 3.13.0 (October 2026)

- **Combine notes for agents:** `zkdesk_combine` / `combine({ target })` merges the agent's USDG notes, largest first, two per relayed self-transfer, until one note holds `target` or one note is left. A payment can spend at most two notes, so an agent paid many times (for example through a paywall) combines before a larger payment.
  - Each merge pays one relay fee. At most 20 merges per call.
  - The fees count toward `ZKDESK_MAX_PER_DAY` and are reserved before the first merge; `ZKDESK_MAX_FEE` applies to every merge.
  - A target that combining cannot reach is refused before anything is merged.
- `zkdesk_balance` now reports how many notes hold the balance and the largest note. A payment that needs more than two notes now tells the model to call `zkdesk_combine`.
- **Spending guards, hardened by a two-round adversarial review:**
  - Every agent payment now runs with its reserved relay fee as a ceiling. A relay that raises its fee mid-step is refused, and combine stops instead of overspending.
  - A step that fails before anything reaches the relay releases its daily reservation (counted by the client, not by error text), with the reservation's own timestamp.
  - Above the approval threshold, an agent that is also the treasury Owner reserves both vouchers.
  - Money-moving SDK calls run one at a time even outside the MCP server.
  - Combine plans exactly the merges a target needs, returns unused reservation, and reports whether it reached the target and why it stopped.

## 3.12.0 (October 2026)

- **Pay-per-call APIs for agents:** `agent/paywall.mjs` puts any HTTP route behind a private per-request price, paid to the service's own ZKdesk account. An unpaid request gets a 402 challenge:
  - a request id
  - its own amount (the price plus 1 to 9,999 millionths)
  - a payment link
  - an expiry

  The challenge is bound to the method and path. The route is served once a payment of exactly that amount, made after the challenge, is in the pool. Each payment unlocks one request; deposits in screening don't count. Open challenges are bounded, and the chain is read at most every few seconds however many requests arrive.
- **`zkdesk_fetch_paid` / `fetchPaid`:**
  - pays a 402 challenge only up to `max_price`, and through every agent limit (per payment, per day, allowed recipients, fee cap)
  - then fetches again
  - https only, no redirects, at most 64 KB of the body, returned as `untrustedBody`
- **Reviewed adversarially before release.** Two rounds found and fixed:
  - a request that could crash the service
  - one chain sync per concurrent retry
  - open-challenge exhaustion: now at most 5 per caller, 5-minute expiry
  - reuse of a freed amount by a late payment
  - a head that could go backwards
  - an unbounded 402 body
  - a payer left without its request id when the service failed after the payment
  - an amount-picker hang
  - per-caller limits defeated by IPv6
  - IPv6 forms of private addresses
  - The agent also refuses private and loopback hosts and challenges about to expire.

## 3.11.0 (October 2026)

Contract set v3.3 for the contract findings of the "V39 RESCORE" report. Circuits, verifiers and fixtures are unchanged. Live on mainnet since block 78408404 (pool `0xc1D05420b6EA4128F4D4eeb33152fe671D7326A9`, desk `0xF8eCB1f27F5878Db30ca46c4d299339AF2331bF3`), deployed while the desk held no positions; the v3.2 set is kept under `v3-replaced-3`. Build of record `c2c00380…` (42/42 contracts and libraries match).

- **N-A (Medium):** a position step that leaves the position open must prove at the current rate index. The previous index understated debt, so a breached decoy could keep stepping and get its whole batch skipped every epoch.
  - Closing may still use the previous index.
  - The app proves a step again once if a checkpoint lands mid-proof.
- **N-A, cron half:** when a batch is skipped because one of its positions changed after the snapshot (a cure), the desk cron re-plans the others without that slot and liquidates them in the same epoch.
- **N-3 (Low):** `attestAndLiquidate` no longer reverts when someone front-runs the operator's epoch proof with `attest`. If the same snapshot and breached set are already attested, its batches go straight through.
- **H-1r residual (Low):** a draw or repay below the class minimum is no longer activity for eviction.
- **Tests:**
  - `test_v33_*` (current index, same-epoch re-plan, front-run attest, dust debt moves)
  - a new invariant for the idle, eviction and index rules (8 invariants at 102,400 calls)
  - `scripts/ops/e2e-replan.mjs` (real proofs: one position cures after the snapshot, and its batch-mate is still liquidated in the same epoch)

## 3.10.1 (October 2026)

Fixes from the "V39 RESCORE" report (agent findings; the contract Medium N-A needs v3.3 and is planned separately).

- **A-1 (High):** an agent no longer counts a deposit still in screening as received; its sender could take it back with `refundToOrigin`.
  - `incoming` and `waitForPayment` count only notes in the pool.
  - A matching deposit in screening is returned as `{ received: false, pending: true }`.
  - The client indexes `DepositRefunded`, so a refunded deposit is marked `refunded` and is never shown as a payment (also in the dashboard's Activity).
- **A-2 (Medium):** new local guards:
  - `ZKDESK_MAX_PER_DAY` (rolling 24 h, relay fees included, kept in a 0600 file, default 100 USDG)
  - `ZKDESK_ALLOW_TO` (allowed recipients, compared canonically)
  - Link memos come back as `untrustedMemo`, and the server tells the model that names, labels and memos are untrusted text.
- **A-3:** `ZKDESK_MAX_FEE` (default 2 USDG per relay step, voucher price at most 2), fees counted in the daily cap, and every "confirmed" payment checked against its on-chain receipt.
- **A-4:** `ZKDESK_TREASURIES` allow-list. Treasuries where the agent cannot move funds are not listed, and each listed one shows its owner key.
- **A-5:** request links add a few millionths of a USDG to the amount (unless `exact`), so each payment is matched to its own link.
- **Leads:**
  - the passkey is bound to the exact host name
  - URLs in MCP tool errors keep only their origin (no RPC keys)
  - `zkd:` addresses with an owner key above the field are rejected (no aliases)
  - the agent e2e uses a random seed

## 3.10.0 (October 2026)

- **Add an AI agent from the dashboard:** a treasury's Treasury view has an "AI agent" panel showing the Payer (you, the ZKdesk scheduler, or an agent), the Owner approval threshold, and the payments made without approval in the current window.
  - The Owner adds or changes the agent in one guided step: its zkd: address, the threshold, and an optional count limit per day or week (`setTransferLimit`, now in the UI).
  - *Remove agent* makes the Owner the Payer again.
  - Which member made a payment stays private on-chain, so payments are not attributed to the agent.
  - A removed agent can no longer pay but keeps the treasury's viewing key until the funds move to a new treasury (no re-keying yet). The remove dialog and the docs say so.

## 3.9.0 (October 2026)

- **Incoming payments for agents:** `zkdesk_incoming` lists the payments others made to the agent, newest first, with the kind of each:
  - private payment
  - mandate payment (has a receipt)
  - deposit (in screening)

  The agent's own change and self-transfers are left out: a note made by a transaction that also spent the agent's notes is not a payment received.
- `zkdesk_wait_for_payment` waits, up to 15 minutes, for a new payment (optionally of an exact amount, such as the amount of a link the agent shared) so the agent can deliver once it is paid.
- SDK: `incoming` and `waitForPayment`. The client's notes now carry the transaction that created and the one that spent them.

## 3.8.0 (October 2026)

- **Payment links for agents:** `zkdesk_pay_link` pays a ZKdesk payment request link, from the agent's own balance or from a treasury where it is Payer.
  - If the link sets an amount, that amount is used, and a different amount is refused.
  - A link for another network is refused.
  - The per-transaction limit still applies.
- `zkdesk_request_link` creates a link so anyone, a person or another agent, can pay the agent or its treasury privately.
- SDK: `payLink`, `requestLink` and `readLink`.
- The link format is shared with the dashboard's "Request payment" (`src/lib/zk/request-link.js`).

## 3.7.0 (October 2026)

- **AI agents:** `agent/` gives an agent its own private ZKdesk account. It proves each step locally and uses the ZKdesk relayer, so it needs no wallet or gas.
  - **SDK:** `createAgent({ seed, network, maxPerTx })` to send, withdraw, pay from a treasury, complete approved requests, pay mandates, and prove and verify receipts.
  - **MCP server:** `node agent/mcp.mjs` exposes the same actions as 13 tools for Claude or any MCP client.
  - **CLI:** `node agent/cli.mjs keygen|address|balance`.
  - **Limits:** binding limits come from making the agent a treasury's Payer (mandate caps, the Owner's approval threshold, the transfer-count limit). `ZKDESK_MAX_PER_TX` (default 50 USDG) is a guard on the agent's own machine.
  - The MCP protocol is implemented in the server itself, with no new dependency.
- **Docs:** a new "AI agents" guide, and an agents section in the public README.

## 3.6.0 (October 2026)

- **Passkey accounts:** unlock the dashboard with Face ID, Touch ID, Windows Hello or a security key instead of a MetaMask signature. The keys come from the passkey's WebAuthn PRF output (separate mainnet and testnet keys, different from any signature account), stay in the account worker, and are the same on every device the passkey syncs to. Sending, withdrawing, credit and treasuries need no wallet; MetaMask is asked for only to fund a deposit.
- **Recovery key:** creating a passkey shows its seed as 24 words (BIP-39 English) that must be confirmed before the account opens; Settings shows them again after the passkey confirms, and "Use recovery key" restores the account without the passkey. Nothing is stored.
- **Tests:** a cron test no longer fails when it runs at the top of the hour (it reused a stale snapshot in the mock).

## 3.5.0 (October 2026)

- **Credit health gauge:** each borrowing position on the Credit tab shows its live health against the liquidation threshold (Safe, Watch, At risk, Liquidatable), the current price and the price at which it would be liquidated, with how far the price can fall. A warning above the positions names any position close to or below its threshold. Computed in the browser from your private notes and the pinned marks; nothing new is revealed.

## 3.4.0 (October 2026)

Contract set v3.2 for the rescore of v3, redeployed while the desk held no positions.

- **Credit slots (H-1 residual):** minimum position about $1,000 of collateral and 250 USDG of debt per class, so filling all 64 slots ties up $64,000. Eviction counts only opening, debt moves and collateral moves of at least the class minimum as activity (`activeAt`), so a 1-wei top-up no longer keeps an idle position.
- **Step marks (L-a):** a step can use the previous price pin only if it is not higher than the current one.
- **Defensive steps (L-b):** adding collateral and repaying are not rate limited; borrowing and withdrawing still wait 10 minutes.
- **Mailbox key (L-c, L-d):** bound to the treasury's create proof (an argument in its ext hash), emitted as `MailboxKey`, and stored only once the create is confirmed.
- **Leads:** `BatchSkipped` only for a batch whose proof verifies; mailbox posts authenticate before any chain read; the operator checks the snapshot's leaves hash before proving; the fallback desk script proves evictions.
- **Build of record** (`cf7ed7de…`): `scripts/build-hash.mjs` compares every deployed contract and library with this repository's `forge build` (immutables, library links and metadata masked) and hashes the build, reproducible from a clone; `check-deployment` and the daily workflow run it.
- **Tests:** `test_v32_*` per finding; API tests for the crons (tick, desk, pulls), alerts, transparency and operation status on a mocked database and chain, with CI failing under 85% of API lines (92% now).

## 3.3.0 (October 2026)

- **Payment requests:** **Request payment** (Treasury tab, personal account or a treasury) makes a link and a QR code with your private address and an optional amount and note. Opening it shows the request, and after connecting a wallet the private send is filled in for review. Nothing about the request is stored or posted; the note travels in the link only. The QR code is drawn as inline SVG (`qrcode-generator`, MIT, no dependencies).

## 3.2.0 (October 2026)

- **Combine notes:** a balance spread over several private notes can be merged into one from the dashboard (Treasury tab, personal account: **Combine notes**). Each merge is a private self-transfer paying one relay fee; notes too small to pay their own merge are left alone. Sends that need more than two notes now point to it instead of failing without a way forward (`client.combine`, `scripts/ops/e2e-combine.mjs`).

## 3.1.0 (October 2026)

- **Market hours:** the desk's market-hours flag follows the NYSE calendar: exchange holidays count as off-hours (1-hour epochs, the wider off-hours band and deep liquidations only), and early-close days end at 13:00. Rules-based, so no yearly data file; unscheduled closures can be added by date (`api/_lib/nyse.js`). Checked against the published 2025-2027 calendars (`api/nyse.test.mjs`).

## 3.0.1 (October 2026)

- **Lending pool:** debt written off in a liquidation is covered by the reserves first (`coverLoss`), so lender assets never underflow. Found by the liquidation invariant handler in public CI right after 3.0.0; the 3.0.0 contract set held no funds and was redeployed with the fix (recorded as `v3-replaced`).

## 3.0.0 (October 2026)

Contract fixes for the remaining findings of the re-audit after v2 (N-1, H-1 and M-3 residuals), deployed as a new set beside v2. v2 held no positions or notes when it was replaced.

- **Credit steps (N-1):** a step must move collateral or debt; every step that leaves a position open proves it healthy at the class's liquidation threshold, at the latest pinned mark, so a breached position can only cure, close or be liquidated. A slot takes one step per 10 minutes, closing excepted.
- **Health epochs (N-1, M-1):** the desk records snapshots of its slots (`snapshot()`, permissionless, never overwritten); an epoch proves one recent snapshot, and its id is a public input, so each proof is used once. A liquidation batch over a slot that changed after the snapshot is skipped instead of reverting the call.
- **Dust debt (H-1 residual):** debt is zero or at least the class minimum (5 USDG), bound into the position and liquidation proofs; a partial liquidation that would leave dust repays the position in full.
- **Exits (M-3 residual):** treasury transfers, mandate payments and pool converts no longer check the asset listing; only deposits do.
- **Lending pool:** available cash saturates at zero when reserves exceed it.
- **Tests:** a Foundry and a Noir test per finding (`test_v3_*`; `rejects_noop_step`, `rejects_breached_step_that_stays_breached`, `accepts_breached_step_that_cures`, `rejects_dust_debt`, `rejects_partial_sale_leaving_dust_debt`); invariant handlers for liquidations, stale batches, evictions, snapshots and treasury ledgers (1,600 runs of 64 calls); relay and mailbox handler tests on a mocked database and chain with coverage reported in CI.

## 2.1.0 (October 2026)

Off-chain fixes from the re-audit after v2. No contract changes.

- **Relay (N-0, critical):** requests dispatch only to the relay's own parsers (a kind such as `constructor` made it sign any call), and every signed call must be one of six protocol functions. Not exploited.
- **Relay (N-2):** at most one pending operation per note; calls are simulated again inside the nonce lock; calls heavier than the quoted gas pay proportionally.
- **Scheduler (N-3):** only successful payments count toward a run's limit, one payment per treasury per run, with a rotating start.
- **Desk operator (M-1 residual):** epochs and liquidations are always one transaction; a batch that would revert is dropped and retried next epoch.
- **Approval mailbox (M-6 residual, N-4):** a mailbox key can only be registered before its treasury exists on-chain, with global caps; unused registrations are pruned.
- **Keys:** derived from the canonical form of the wallet signature (low s, v = 27/28), so every wallet encoding gives the same keys. Canonical signatures are unchanged.
- **Treasury limits:** the M-4 transfer limit can be set through the relay and the client (`setTransferLimit`).
- **Operations:** alerts are recorded only once delivered; the timelock scan is bounded; `check-deployment` also checks timelock roles, Safe owners, the pinner, feeds and every verifier, and runs daily in CI. `SECURITY.md` lists accepted risks; `RUNBOOK.md` is public.
- **Tests:** API tests for every relay kind, the allow-list, note claims, fee scaling, scheduler rotation and mailbox validation (`pnpm test`).

## 2.0.0 (October 2026)

Fixes every high and medium finding of the automated audit of October 2026 (`v1-final`, commit `d9c0d1b`). New contracts and circuits, deployed beside v1; v1 stays on-chain so its notes can still be withdrawn.

- **Credit slots (H-1):** a minimum position size per collateral class, bound into the position proof; positions without debt and without activity for a day are evicted, and their collateral returns to the owner as a note (`circuits/evict`).
- **Relayer (H-2):** every relay pays its gas, either through a fee note or a prepaid voucher; minimum fees follow the gas price. Desk epochs, liquidations, price pins and deposit clearing run from a separate keeper key. User relays stop at a balance floor.
- **Health epochs (M-1):** an epoch uses the current marks and rate index; the operator attests and liquidates in one transaction (`attestAndLiquidate`).
- **Note tree (M-2):** depth 32 instead of 20, with a 1,024-root history; the empty root is accepted only while the tree is empty.
- **Exits (M-3):** delisting an asset only stops new deposits; disabling a collateral class only stops new risk. Repay, add collateral, close and withdrawals always work.
- **Treasury dual control (M-4):** an approval belongs to one treasury and is used once; owners can limit how many transfers leave without approval per period.
- **Operator (M-5):** the position circuit rejects `operator_r = 0`; the operator decodes the point at infinity.
- **Approval mailbox (M-6):** posts are signed with a key derived from the treasury secret; per-treasury daily cap; 14-day expiry.
- **Governance (M-7):** a 2-of-3 Safe and a 48-hour timelock (the delay change takes effect on 3 October 2026); separate guardian and screener keys; pool modules fixed at deployment; alerts on every timelock proposal, low service gas and missed epochs.
- **Hardening:** CSP, HSTS and related headers; exact dependency pins; constant-time cron authentication; reentrancy lock on the pool's module hooks; a convert is checked as pool solvency.
- **Tests and CI:** invariant and fuzz suites, a test for each finding, Noir tests for every circuit, Slither, Semgrep and gitleaks in CI, SHA-pinned actions; a public post-deployment check (`scripts/check-deployment.mjs`) and explorer-verified sources.

## 1.0.0 (September 2026)

First mainnet deployment on Robinhood Chain: shielded pool, private transfers, confidential credit with health epochs and sealed liquidations, private treasuries, payment mandates, selective receipts and the transparency view.
