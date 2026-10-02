# Changelog

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
