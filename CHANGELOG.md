# Changelog

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
