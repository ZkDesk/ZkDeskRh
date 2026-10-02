# Changelog

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
