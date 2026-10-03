<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/zkdesk-logo-light.png" />
  <source media="(prefers-color-scheme: light)" srcset=".github/assets/zkdesk-logo-dark.png" />
  <img src=".github/assets/zkdesk-logo-dark.png" alt="ZKdesk" width="112" height="112" />
</picture>

# ZKdesk

**Confidential credit, treasury and payments on Robinhood Chain.**

Your keys never leave your browser. Balances and transfers stay confidential on a public chain.<br/>
Every action you take is proven in your browser with zero-knowledge proofs and verified on-chain.

[![CI](https://github.com/ZkDesk/ZkDeskRh/actions/workflows/ci.yml/badge.svg)](https://github.com/ZkDesk/ZkDeskRh/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-0071e3)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A522.12-339933?logo=node.js&logoColor=white)
![Noir](https://img.shields.io/badge/noir-1.0.0--beta.22-1a1a1a)
![Solidity](https://img.shields.io/badge/solidity-foundry-363636?logo=solidity)

[Website](https://zkdesk.tech) · [Developer docs](https://zkdesk.tech/docs) · [X](https://x.com/ZkDesk) · [Telegram](https://t.me/zkdeskrh)

**$ZKD CA (Robinhood Chain):** [`0x2c612e2f811f106f1Baa1Dbc5fbaE88F1ac561C7`](https://robinhoodchain.blockscout.com/address/0x2c612e2f811f106f1Baa1Dbc5fbaE88F1ac561C7)

</div>

---

## Table of contents

- [Overview](#overview)
- [Features](#features)
- [Who sees what](#who-sees-what)
- [Governance and trust](#governance-and-trust)
- [Architecture](#architecture)
- [Repository layout](#repository-layout)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Smart contracts](#smart-contracts)
- [Circuits](#circuits)
- [Public API](#public-api)
- [AI agents](#ai-agents)
- [Testing and CI](#testing-and-ci)
- [Deployed contracts](#deployed-contracts)
- [Operations](#operations)
- [Security](#security)
- [License](#license)

## Overview

ZKdesk is a confidential finance workspace for businesses and projects. It keeps balances, transfers, treasury holdings and payment terms confidential, and lets their owners disclose exactly what a counterparty needs with a zero-knowledge proof. [Who sees what](#who-sees-what) lists exactly what is public and what ZKdesk services can see.

ZKdesk is a **client-proved** system:

- The **browser** holds your keys and proves every action you take. Your keys never leave it.
- **Contracts** verify proofs and hold the assets.
- **Services** relay authorized actions and run scheduled upkeep: health epochs, liquidations and opt-in scheduled payments, which they prove themselves. The desk operator can read credit positions to do this.

## Features

| Area | What it does |
| --- | --- |
| **Shielded pool** | UTXO-style notes (commitments to asset, amount, owner and blinding). Spending publishes a nullifier, which prevents double spends without revealing the note. |
| **Private transfers** | Send and receive privately. Relayed actions don't show your public address and need no gas; the relay fee is paid from your private notes. Deposits and withdrawals are public at the edge of the pool. |
| **Payment requests** | Ask to be paid privately with a link or QR code. It opens ZKdesk with a private send to your address (and optional amount and note) filled in; nothing about the request is posted anywhere. Your balances can also be merged into one note (**Combine notes**) so any amount goes out in one step. |
| **Confidential credit** | Borrow USDG against stock-token collateral. Each position is a hidden commitment in one of the desk's 64 slots, with a minimum size per collateral class; an idle position without debt is evicted after a day, and its collateral returns to the owner as a note. A USDG lending pool supplies the liquidity. |
| **Proven solvency** | The desk operator regularly proves a health epoch over every slot: total collateral, total debt and a commitment to exactly which positions are liquidatable. If no epoch is attested in time, new borrowing halts. |
| **Sealed liquidations** | Breached positions are liquidated in sealed batches that are checked against the attested epoch. |
| **Private treasuries** | Shared private ledgers with role-based members. Each treasury's view key is shared as encrypted on-chain key shares. |
| **Mandates** | Standing, bounded payment permissions with encrypted terms. Commitments, status changes and payment timing are public. |
| **Selective receipts** | Recipients prove they were paid to one specific verifier. They can optionally disclose the amount, their identity or both. |
| **Transparency** | A wallet-free view of protocol aggregates, built only from data that is already public on-chain. |
| **Deterministic keys** | All keys derive from a single wallet signature, so there is nothing extra to store or back up. |

## Who sees what

| | Public (anyone on-chain) | ZKdesk services | Private |
| --- | --- | --- | --- |
| **Keys** | — | Never | Spend, view and encryption keys stay in your browser |
| **Balances** | Pool totals per asset | — | Your notes and amounts |
| **Deposits and withdrawals** | Address, token and amount | — | Which later spends they fund |
| **Transfers** | That a transfer happened, its asset, fee and time | The relayer sees the request and its timing | Amount, sender and recipient |
| **Credit** | Each step's collateral, borrow and repay amounts and slot; desk and batch totals | The desk operator reads each position's collateral, debt and owner key | Which wallet owns a position |
| **Treasury** | Treasury identifier, action type, allocated or withdrawn amounts, solvency results | The opt-in scheduler, if made Payer, can read that treasury and act as its Payer (pay mandates; transfer below the dual-control threshold) | Balances, members, roles and policy values |
| **Payments** | Mandate commitments, status changes, each payment's period and timing | The opt-in scheduler, for treasuries that use it | Recipient, terms and amounts |
| **Receipts and statements** | A receipt names the treasury and the period, so whoever receives it can match it to that mandate's public payments and learn its schedule. A solvency statement publishes the nullifiers of the notes it counts, so later spends of those notes link back to it | — | The amount and the recipient unless disclosed; the treasury balance |

Slot numbers, treasury identifiers and timing can be correlated. The full model is in the [developer docs](https://zkdesk.tech/docs#privacy).

## Governance and trust

ZKdesk has not been audited by an independent firm. An automated AI audit (October 2026) found two high and seven medium issues; all are fixed in the contracts and services listed under [Security](#security).

- **Governance** is a Safe with a 2-of-3 threshold acting through a timelock of 48 hours (24 hours until a change already scheduled through the timelock takes effect on 3 October 2026). The three signer keys are held by the project's developer, not by independent parties or hardware devices.
- **After the 48-hour timelock**, governance can list or de-list assets for *new* deposits (a de-listed asset can still be withdrawn from the pool and the credit desk; treasury transfers and mandate payments of it stop until it is listed again, which the next contract version removes), change collateral class parameters (a disabled class still allows repaying, adding collateral and closing), change the liquidation venue and bonus address, set the price-pinning key and unpause the desk. It cannot add a contract that moves pool funds: the pool's modules are fixed at deployment.
- **Immediately**, the guardian key can pause new borrowing and partial collateral withdrawals, and the screener key can flag a deposit during its 60-second standby so that it can only be refunded to its origin. Both are separate from the deployer.
- **Every timelock proposal** raises an alert to the operators during its delay.
- **Liquidations** repay lenders first; the bonus and any surplus go to the governance Safe. Debt a liquidation cannot cover is written off and lowers lending-pool share value.
- **The relayer** submits private actions; every relay pays its own gas. Desk epochs, liquidations, price pins and deposit clearing run from a separate keeper key. While the services are down, funds stay in the contracts but private actions, clearing, pinning and health epochs pause.
- **Reserves** (10% of interest) have no withdrawal path and stay in the lending pool.

Full details: [Governance and safety](https://zkdesk.tech/docs#governance) and [Security status and limitations](https://zkdesk.tech/docs#status).

## Architecture

```
┌──────────────────────────── Browser ────────────────────────────┐
│  React UI ──► Web Worker (keys, notes, Noir witness, UltraHonk) │
│                     │ proof + encrypted payload                 │
└─────────────────────┼───────────────────────────────────────────┘
                      ▼
          ┌─────────────────────────┐          ┌──────────────────────┐
          │  Serverless API (/api)  │◄────────►│  Postgres mirror     │
          │  relay · ops · requests │          │  (indexed events)    │
          │  transparency · crons   │          └──────────────────────┘
          └───────────┬─────────────┘
                      ▼
┌──────────────────────── Robinhood Chain ────────────────────────┐
│  ZKDeskPool · CreditDesk · LendingPoolUSDG · TreasuryLedger      │
│  MandateRegistry · DeskGuardian · AssetGate · Marker · verifiers │
└──────────────────────────────────────────────────────────────────┘
```

- **Proving:** Noir circuits are compiled to ACIR and proven with Barretenberg's UltraHonk backend, which needs no per-circuit trusted setup. Proofs run in a dedicated Web Worker and are verified on-chain by generated Solidity verifiers.
- **Networks:** the same build serves Robinhood Chain mainnet (`4663`) and testnet (`46630`). Mainnet endpoints live under `/api/mainnet/*`. Mainnet uses real USDG and Robinhood stock tokens with Chainlink price feeds; testnet uses mock tokens, feeds, market maker and vault.
- **Liquidation venue:** on mainnet, `UniswapV3Venue` sells liquidated collateral for USDG through Uniswap v3.
- **Scheduled work:** cron functions advance rate checkpoints, attest desk health epochs and execute due mandate pulls.

## Repository layout

```
.
├── agent/                AI agent SDK, MCP server and CLI (Node)
├── api/                  Serverless functions (relay, ops status, requests, transparency, crons)
│   ├── _lib/             Shared server clients: chain, relayer, database
│   └── mainnet/          Mainnet wrappers around the shared handlers
├── circuits/             Noir workspace: transact, position, ledger, liquidate, health_epoch,
│                         mandate_auth, mandate_pull, receipt, role_auth, treasury_attest
├── contracts/            Foundry project
│   ├── src/              Pool, credit desk, lending pool, treasury ledger, mandates, guardian
│   ├── script/           Deployment scripts and ABI export
│   └── test/             Forge tests driven by real UltraHonk proofs
├── public/               Static assets: brand artwork and logo
├── scripts/              Local server, privacy check, receipt verifier, operational e2e drills
├── src/
│   ├── dashboard/        Dashboard UI and state model
│   ├── devdocs/          In-app developer documentation
│   ├── lib/chain/        Network config, deployments, ABIs, wallet
│   ├── lib/zk/           Keys, notes, encryption, witness building, prover, client transport
│   └── brand/            Brand identity and site chrome
├── supabase/             SQL migrations for the event mirror
└── vercel.json           Routing, function limits, cron schedule, isolation headers
```

## Tech stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19, Vite 7, JavaScript (JSX) |
| Proving | Noir `1.0.0-beta.22`, Barretenberg `5.0.0-nightly.20260522` (UltraHonk), `@noir-lang/noir_js`, `@aztec/bb.js` |
| Cryptography | Poseidon, Grumpkin, `@noble/curves`, `@noble/ciphers`, `@noble/hashes`, `@zk-kit/lean-imt` |
| Chain | Solidity on Foundry `1.8.3`, `viem` |
| Backend | Vercel Functions (Node.js), PostgreSQL via `pg` |
| Tooling | pnpm `11.19.0`, Node.js `>= 22.12`, GitHub Actions |

## Getting started

### Prerequisites

- Node.js **22.12+**
- pnpm **11.19.0** (`corepack enable` picks up the pinned version)
- Typeface: the site is designed for **PP Neue Montreal** (Pangram Pangram), a commercial font that is not distributed in this repository. Place licensed `PPNeueMontreal-Book` / `-Light` `.woff2`/`.woff` files in `public/fonts/`; without them the UI falls back to system fonts.
- Optional: [Foundry](https://getfoundry.sh) for contracts, and [noirup](https://noir-lang.org) / `bbup` for circuits (versions pinned in `circuits/VERSIONS`)

### Install and run

```sh
pnpm install --frozen-lockfile
pnpm dev          # http://127.0.0.1:5184
```

### Common scripts

| Command | Description |
| --- | --- |
| `pnpm dev` | Start the Vite dev server |
| `pnpm build` | Production build into `dist/` |
| `pnpm preview` | Serve the production build locally |
| `pnpm test` | Dashboard model and ZK primitive test suites |
| `pnpm privacy` | Static privacy checks: mirror column names, server logging, browser storage and secret names in the bundle (run after `pnpm build`) |
| `pnpm zk:fixtures` | Regenerate circuit artifacts, Solidity verifiers and test fixtures from `circuits/target` (after `nargo compile`) |
| `pnpm abis` | Export contract ABIs from `contracts/out` into `src/lib/chain/abis` (after `forge build`) |

## Configuration

The frontend runs without any secrets. Server functions read their configuration from environment variables. Never commit a `.env` file; it is git-ignored.

| Variable | Scope | Purpose |
| --- | --- | --- |
| `VITE_ZKDESK_MODE` | Build | Dashboard data source: `demo` (local sample data, the default) or `testnet` (live chain mode: Robinhood Chain mainnet by default, with a switch to testnet) |
| `VITE_ZKDESK_CA` | Build | Token contract address shown on the site |
| `SUPABASE_DB_URL` | Server | Postgres connection for the event mirror |
| `RPC_URL_SERVER` | Server | Server-side RPC endpoint |
| `RELAYER_PRIVATE_KEY` | Server | Relayer account that submits private actions (user relays only) |
| `KEEPER_PRIVATE_KEY` | Server | Service account for desk epochs, liquidations, price pins and deposit clearing (falls back to the relayer if unset) |
| `DESK_OPERATOR_SK` | Server | Desk operator key used to prove health epochs and liquidation batches |
| `SCHEDULER_SEED` | Server | Key seed for the opt-in mandate scheduler |
| `CRON_SECRET` | Server | Authenticates scheduled invocations |

Mainnet functions read `RPC_URL_SERVER`, `RELAYER_PRIVATE_KEY`, `KEEPER_PRIVATE_KEY`, `DESK_OPERATOR_SK` and `SCHEDULER_SEED` with a `MAINNET_` prefix. `SUPABASE_DB_URL` and `CRON_SECRET` are shared (Vercel Cron sends one secret to every scheduled path; it is compared in constant time), and mainnet data lives in a separate `mainnet` database schema. Contract deployment scripts also read `DEPLOYER_PRIVATE_KEY`, `RELAYER_ADDRESS`, `DESK_OPERATOR_PK_X` and `DESK_OPERATOR_PK_Y` (with `MAINNET_` variants). All names are listed in `.env.example`.

## Smart contracts

```sh
cd contracts
pnpm install --frozen-lockfile --ignore-workspace
forge install foundry-rs/forge-std@v1.16.2 --no-git
forge test
```

Most suites verify real UltraHonk proofs generated from `circuits/fixtures`; `Invariants.t.sol` and `Fuzz.t.sol` cover accounting under random sequences. `MainnetFork.t.sol` runs only when `MAINNET_FORK` is set. Deployed addresses for each network are in `src/lib/chain/deployments/`.

`RELEASE=v3 bash contracts/deploy-v2.sh <testnet|mainnet> --broadcast` deploys the protocol and verifies every contract's source on Sourcify; `node scripts/ops/merge-v2.mjs <chainId> v3` then makes it the app's current release. Anyone can then confirm the governance and wiring with a read-only check:

```sh
node scripts/check-deployment.mjs mainnet
```

It checks the Safe threshold, the timelock delay, who owns each contract, the guardian and screener keys, the fixed pool modules, the tree depth and every collateral class.

Earlier deployments (v1, tag `v1-final`, and v2) stay on-chain so their notes can still be withdrawn. Their `Marker` (price pins) is shared with v3; that contract's comment calls `marketOpen` an "informational market-hours flag", but the flag selects the liquidation price band, the epoch interval and the off-hours liquidation floor.

## Circuits

```sh
cd circuits
nargo compile --workspace
cd ..
pnpm zk:fixtures
```

`pnpm zk:fixtures` regenerates the prover artifacts in `src/lib/zk/artifacts/`, the Solidity verifiers in `contracts/src/verifiers/` and the test fixtures. A changed circuit therefore needs its verifier redeployed. The Noir and Barretenberg versions must change together as a matched pair; see `circuits/VERSIONS`.

## Public API

All endpoints are served from the site origin. Mainnet equivalents live under `/api/mainnet/*`.

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/transparency` | Public protocol aggregates (CDN-cached for 30 s, then served stale for up to 60 s while revalidating) |
| `GET` | `/api/relay` | Relayer address, availability and the live minimum relay fees per asset (base units) |
| `POST` | `/api/relay` | Submit a proven private action |
| `GET` | `/api/ops/:id` | Status of a relayed operation |
| `GET` / `POST` | `/api/requests` | Sealed treasury approval requests. Anyone can read the ciphertexts, which only treasury members can open; posting needs a signature from the treasury's mailbox key, registered by its create request, and the treasury must exist on-chain |

## AI agents

`agent/` gives an AI agent its own private ZKdesk account. It proves each step locally and uses the ZKdesk relayer, so it needs no wallet or gas.

```sh
node agent/cli.mjs keygen                      # prints ZKDESK_SEED and the agent's zkd: address
ZKDESK_SEED=0x… node agent/mcp.mjs             # MCP server (stdio) for Claude or any MCP client
```

- **MCP tools:**
  - `zkdesk_address`, `zkdesk_balance`
  - `zkdesk_send`, `zkdesk_withdraw`
  - `zkdesk_treasuries`, `zkdesk_pay`, `zkdesk_requests`, `zkdesk_complete`
  - `zkdesk_mandates`, `zkdesk_pay_mandate`
  - `zkdesk_combine` (merges the agent's notes; a payment spends at most two)
  - `zkdesk_fetch_paid` (pays a ZKdesk 402 challenge up to `max_price`, then fetches again)
  - `zkdesk_incoming`, `zkdesk_wait_for_payment` (payments received from others; wait for one before acting)
  - `zkdesk_pay_link`, `zkdesk_request_link` (the dashboard's payment request links, paid or created)
  - `zkdesk_receipts`, `zkdesk_prove_receipt`, `zkdesk_verify_receipt` (with `expected_verifier`, a receipt made out to anyone else is refused)
- **SDK:** `createAgent({ seed, network, maxPerTx })` from `agent/index.mjs`. TypeScript types ship beside it (`agent/index.d.mts`, `agent/paywall.d.mts`).
- **Environment:** `ZKDESK_NETWORK` (default `mainnet`), `ZKDESK_API`, `ZKDESK_RPC`.
- **Local guards** (`off` removes one): `ZKDESK_MAX_PER_TX` (default 50 USDG), `ZKDESK_MAX_PER_DAY` (rolling 24 h with fees, default 100, kept in a 0600 file), `ZKDESK_ALLOW_TO` (allowed recipients), `ZKDESK_TREASURIES` (allowed treasuries), `ZKDESK_MAX_FEE` (per relay step, default 2).
- **Getting paid:** only payments in the pool count as received. A deposit in screening can still be taken back by its sender, so it is reported as pending.
- **Binding limits** come from making the agent a treasury's **Payer**: mandate caps, the Owner's approval threshold, the transfer-count limit and (since contract set v3.4) the Owner's list of allowed recipients and budget per day, week or 30 days are enforced on-chain, the last two inside the payment proof. Payments the Owner approves are outside the list and the budget. The local guards protect against a confused or prompt-injected model; anyone with the seed controls the agent's account.

### Pay-per-call APIs

`agent/paywall.mjs` puts any HTTP route behind a private per-request price:
`createPaywall({ agent, price }).guard(req, res)` with the service's own ZKdesk account.

- An unpaid request gets a 402 challenge: a unique amount, a payment link and a request id.
- The agent pays with `zkdesk_fetch_paid` and repeats the request with `x-zkdesk-request`.
- One payment of exactly that amount, made after the challenge and in the pool (not a deposit in screening), unlocks that request once.
- Behind a reverse proxy, pass `clientOf` so the per-caller limit (5 open challenges) reads the real client address.
- **State:** `memoryStore()` (default, one process), `fileStore(path)` (survives restarts) or `redisStore(client)` (several instances; payments are claimed atomically; use `maxmemory-policy noeviction` and one `prefix` per account).
- `ZKDESK_ALLOW_HTTP=1` is for local tests only.

## Testing and CI

Pushes to `main` and every pull request run on GitHub Actions, with every action pinned to a commit and read-only permissions:

| Job | What it runs |
| --- | --- |
| App | `pnpm test`, API coverage (`pnpm test:coverage`: the relay and mailbox handlers on a mocked database and chain, at least 70% of lines, report in the job summary), `pnpm build` and the privacy check (no client IPs or payload logging on the server, no keys in browser storage, no server secrets in the bundle) |
| Contracts | `forge test`: real-proof suites, a test for each audit finding, invariants and fuzzing |
| Circuits | `nargo check` and `nargo test` over all 12 crates; each circuit's tests replay accepted and rejected witnesses |
| Slither | Static analysis of the contracts (generated verifiers stubbed); fails on any high-impact finding |
| Semgrep | JavaScript and secret rules over the app and services |
| gitleaks | Secret scanning over the full history |

Invariants (`contracts/test/Invariants.t.sol`, 1,600 runs of 64 random calls over deposits, transfers, withdrawals, credit steps, snapshots and epochs, liquidations, stale batches, evictions and treasury ledger actions):

| Invariant | Test |
| --- | --- |
| The pool holds at least every note and pending deposit, per asset, and its books match exactly | `invariant_poolConservation` |
| No nullifier is accepted twice | `invariant_noDoubleSpend` |
| Every insertion is a root, and the current root is always usable | `invariant_rootHistory` |
| The desk holds exactly its positions' collateral, and its debt matches | `invariant_deskBooks` |
| One slot per live position; lender value is cash plus debt minus reserves | `invariant_slotsAndLenderNav` |
| The desk never keeps sale proceeds; a batch over changed slots moves nothing; a snapshot backs one epoch | `invariant_liquidationAndEpochs` |
| A treasury approval pays for one transfer; unapproved intents never pay; transfer limits hold; the ledger keeps no funds | `invariant_treasuryLedger` |

## Deployed contracts

Robinhood Chain mainnet (chain 4663), v3 (contract set v3.4), deployed in block 78978681. Every contract and library source is verified on [Sourcify](https://repo.sourcify.dev/4663/0x5844696eaE3656F7625A488b371b013C5Ad5152C), which the explorer imports.

**Build of record:** `127afe9b8c0261847699f3d5c30c7ee5fd3b1291372c31dc2d0d211e9dcbcc72`, reproducible from a clone. `node scripts/build-hash.mjs mainnet` (after `forge build` in `contracts/`) compares the runtime code of all 42 deployed contracts and libraries with your build, with immutables, library links and metadata masked, and prints this hash of the build. `node scripts/check-deployment.mjs mainnet` runs the same comparison together with the governance and wiring checks, and CI runs it daily.

| Contract | Address |
| --- | --- |
| ZKDeskPool (shielded pool) | [0x5844696eaE3656F7625A488b371b013C5Ad5152C](https://robinhoodchain.blockscout.com/address/0x5844696eaE3656F7625A488b371b013C5Ad5152C) |
| AssetGate | [0x8Fe078a8a3f9Fa388B1d5EFC1D0f2da6496b4Aef](https://robinhoodchain.blockscout.com/address/0x8Fe078a8a3f9Fa388B1d5EFC1D0f2da6496b4Aef) |
| CreditDesk | [0x4C403FAd44fdc358fE859c3Ec8358aC6a140110F](https://robinhoodchain.blockscout.com/address/0x4C403FAd44fdc358fE859c3Ec8358aC6a140110F) |
| DeskGuardian | [0xAe4d74483C6F115fD4565656108f5b54EDC7dfe2](https://robinhoodchain.blockscout.com/address/0xAe4d74483C6F115fD4565656108f5b54EDC7dfe2) |
| LendingPoolUSDG | [0x172c21b2997C0c97974D688431273865fc381FfA](https://robinhoodchain.blockscout.com/address/0x172c21b2997C0c97974D688431273865fc381FfA) |
| UniswapV3Venue | [0x3B49337Fe4009eeec87fFcb8664Cb7bAb3A3D9d6](https://robinhoodchain.blockscout.com/address/0x3B49337Fe4009eeec87fFcb8664Cb7bAb3A3D9d6) |
| TreasuryLedger | [0x165763D0F57DC29c77e87b73380b0102d3a5F16F](https://robinhoodchain.blockscout.com/address/0x165763D0F57DC29c77e87b73380b0102d3a5F16F) |
| MandateRegistry | [0xF68159A388De6B7BbD1e737e16D2dCB2e2AE79C5](https://robinhoodchain.blockscout.com/address/0xF68159A388De6B7BbD1e737e16D2dCB2e2AE79C5) |
| Marker (shared with earlier releases) | [0xC3061368E66b5a4253E5E98346677c6Ce093A735](https://robinhoodchain.blockscout.com/address/0xC3061368E66b5a4253E5E98346677c6Ce093A735) |
| Governance Safe (2-of-3) | [0x1abAE714C8A68c73627b021F18FB3A68d9BE4EF8](https://robinhoodchain.blockscout.com/address/0x1abAE714C8A68c73627b021F18FB3A68d9BE4EF8) |
| TimelockController | [0xe89b6689d8C1C30fD9FF47b4dbcFe5c4b790c0fF](https://robinhoodchain.blockscout.com/address/0xe89b6689d8C1C30fD9FF47b4dbcFe5c4b790c0fF) |
| $ZKD token (ZkProof) | [0x2c612e2f811f106f1Baa1Dbc5fbaE88F1ac561C7](https://robinhoodchain.blockscout.com/address/0x2c612e2f811f106f1Baa1Dbc5fbaE88F1ac561C7) |

Earlier releases remain on-chain so their notes can always be withdrawn: v2 pool [0x21c3f3acd89B90E5fee0c8dd2Cf472CEcB2FC28F](https://robinhoodchain.blockscout.com/address/0x21c3f3acd89B90E5fee0c8dd2Cf472CEcB2FC28F) and v1 pool (tag `v1-final`) [0x804170e2A552EFF5b29710E9378E7c7Df31D607A](https://robinhoodchain.blockscout.com/address/0x804170e2A552EFF5b29710E9378E7c7Df31D607A). Earlier v3 contract sets, replaced while the desk held no positions, are recorded under `v3-replaced`, `v3-replaced-2`, `v3-replaced-3` and `v3` (contract set v3.3) in `src/lib/chain/deployments/4663.json`. Testnet (46630) addresses are in `src/lib/chain/deployments/46630.json`.

## Operations

The services alert the operators (Telegram or a webhook) on low relayer or keeper gas, overdue desk epochs, a paused desk, failing relays and every timelock proposal. During an incident the guardian pauses new borrowing at once, while repaying, closing and every pool withdrawal keep working. A proposal that should not happen can be cancelled by the Safe during its 48-hour delay.

## Security

- Your keys never leave your browser. What the public and ZKdesk services can see is listed in [Who sees what](#who-sees-what).
- Authorization is enforced on-chain by proof verification, not by the frontend.
- Report vulnerabilities privately; see [SECURITY.md](SECURITY.md), which also lists the accepted risks. Incident procedures are in [RUNBOOK.md](RUNBOOK.md).

Findings of the automated audit (October 2026) and their fixes:

| Finding | Fix | Test |
| --- | --- | --- |
| H-1: 64 dust positions could fill every credit slot | A minimum position size per class, bound into the position proof; idle positions without debt are evicted after a day (`circuits/evict`) | `test_audit_h1_*` |
| H-2: the relayer could be drained with free relays | Every relay pays its gas (a fee note, or a prepaid voucher for steps without a fee field); a separate keeper key runs the desk | `scripts/ops/relay-test.mjs` |
| M-1: an old health proof could roll back the liquidatable set | Epochs use the current marks and index; the operator attests and liquidates in one transaction | `test_audit_m1_*` |
| M-2: a full note tree would freeze exits | Tree depth 32 and a 1,024-root history; the empty root is only accepted while the tree is empty | `test_audit_m2_rootHistory` |
| M-3: governance could block exits | Delisting and disabling stop new deposits and new risk only. Since v3, treasury transfers, mandate payments and converts do not check the listing either | `test_audit_m3_*`, `test_v3_delisted*` |
| M-4: dual control could be bypassed from a second treasury | Approvals belong to one treasury and are used once; owners can limit transfers without approval per period | `test_audit_m4_*` |
| M-5: one position could halt the operator | The circuit rejects `operator_r = 0`, and the operator decodes the point at infinity | `zk.test.js`, `circuits/position` tests |
| M-6: the approval mailbox could be flooded | Posts are signed with a key only treasury members hold; per-treasury daily cap; 14-day expiry | `scripts/ops/e2e-approvals.mjs` |
| M-7: governance was a single key | 2-of-3 Safe, 48-hour timelock, separate guardian and screener, fixed pool modules, timelock alerts | `test_audit_m7_modulesAreFixed`, `scripts/check-deployment.mjs` |
| L-1, L-2: receipts and statements link to public data | Documented in [Who sees what](#who-sees-what); accepted in [SECURITY.md](SECURITY.md) | — |

Findings of the re-audit after v2 (October 2026):

| Finding | Status | Test |
| --- | --- | --- |
| N-0 (critical): a request kind such as `constructor` made the relayer sign any call | Fixed. The relay dispatches only to its own parsers, and every call it signs must be on an allow-list of six protocol functions. It was not exploited | `api/relay.test.mjs` |
| N-2: requests spending the same note made the relayer pay for reverts | Fixed. One pending operation per note, and each call is simulated again inside the nonce lock | `scripts/ops/relay-race.mjs` |
| N-3: the payment scheduler could be starved | Fixed. Only successful payments count, one per treasury per run, and the starting treasury rotates | `api/relay.test.mjs` |
| M-1 (residual): the operator's fallback sent liquidations separately | Fixed. A batch that would revert is dropped from the atomic call, never sent on its own | `scripts/ops/e2e-liquidation.mjs` |
| M-6 (residual), N-4: mailbox flooding and squatting | Fixed. A mailbox key is registered only by the treasury's own create request (no public registration), and posts are accepted only for treasuries that exist on-chain | `api/relay.test.mjs`, `scripts/ops/e2e-approvals.mjs` |
| N-1: a no-op position step can block an epoch | Fixed in v3. Every step moves something and leaves its position healthy at the latest mark (a breached position can only cure, close or be liquidated), one step per slot per 10 minutes (closing exempt). Epochs prove single-use snapshots of the slots, and a batch over a changed slot is skipped, not reverted | `test_v3_emptyStepRejected`, `test_v3_breachedStepMustCure`, `test_v3_churnBetweenSnapshotAndLiquidate`; Noir `rejects_noop_step`, `rejects_breached_step_that_stays_breached`, `accepts_breached_step_that_cures` |
| H-1 (residual): a position with dust debt cannot be evicted | Fixed in v3. Debt is zero or at least the class minimum (250 USDG since v3.2), in the position and liquidation proofs; a partial liquidation that would leave dust repays in full | `test_v3_dustDebtCannotHoldSlots`, `test_v3_stepBindsMinimumDebt`; Noir `rejects_dust_debt`, `rejects_partial_sale_leaving_dust_debt` |
| M-3 (residual): treasury transfers and mandate payments check the asset listing | Fixed in v3. Only deposits check it | `test_v3_delistedAssetStillLeavesTreasury`, `test_v3_delistedAssetStillPaysMandates`, `test_v3_delistedAssetStillConverts` |

Findings of the rescore of v3 (October 2026), fixed in the v3.2 contracts:

| Finding | Fix | Test |
| --- | --- | --- |
| H-1r (medium): 64 positions at the minimums fill every slot; a 1-wei top-up keeps an idle position from eviction | Minimums of about $1,000 collateral and 250 USDG debt per class, so filling the desk ties up $64,000; only opening, debt moves and collateral moves of at least the class minimum count as activity for eviction | `test_v32_tinyTopUpDoesNotDelayEviction`, `test_v32_topUpOfTheMinimumCountsAsActivity`, `check-deployment` |
| L-a: a breached borrower could "cure" at the previous, higher price for 10 minutes | A step may use the previous pin only if it is not higher than the current one | `test_v32_previousMarkOnlyWhenNotHigher` |
| L-b: the step interval blocked defensive moves | Adding collateral and repaying are exempt; borrowing and withdrawing wait | `test_v32_addAndRepaySkipTheStepInterval`, `test_v3_stepsAreSpacedButCloseIsNot` |
| L-c: the mailbox key was not bound to the create proof | The key is a contract argument inside the proof's ext hash, emitted as `MailboxKey` and indexed from the event | `test_v32_mailboxKeyIsBoundToTheCreateProof`, `test_v32_mailboxKeyIsSetByTheCreateOnly` |
| L-d: the mailbox row was written before the create confirmed | Written only after a successful receipt (and from the event) | `api/handlers.test.mjs` |
| Leads | `BatchSkipped` only after the proof verifies; mailbox posts authenticate before any chain read; the operator checks the snapshot's leaves hash before proving; the fallback desk script proves evictions; the deployed runtime code is compared with this repository's build | `test_v32_staleBatchMustVerifyBeforeItIsSkipped`, `api/handlers.test.mjs`, `api/crons.test.mjs`, `scripts/build-hash.mjs` |

Slither reports no high-impact issues. Its medium findings are reentrancy patterns in functions that already hold a reentrancy lock and only call the protocol's own immutable contracts, and return values that are deliberately ignored.

> Stock tokens are issued by third parties and carry their own eligibility and transfer rules. Nothing in this repository is an offer of a financial product.

## License

Released under the [MIT License](LICENSE).

### Third-party code

| Component | Location | License |
| --- | --- | --- |
| UltraHonk Solidity verifiers, generated by Barretenberg | `contracts/src/verifiers/` | Apache-2.0, Copyright 2022 Aztec (notice kept in each file) |
| `@zk-kit/lean-imt.sol` 2.0.1, vendored unmodified | `contracts/src/vendor/lean-imt/` | MIT, Copyright 2024 Ethereum Foundation (see its `LICENSE`) |

Packages installed through pnpm (for example OpenZeppelin, viem, Noir and Barretenberg) remain under their own licenses.
