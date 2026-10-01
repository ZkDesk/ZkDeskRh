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
- [Testing and CI](#testing-and-ci)
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
| **Confidential credit** | Borrow USDG against stock-token collateral. Each position is a hidden commitment in one of the desk's 64 slots. A USDG lending pool supplies the liquidity. |
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
| **Treasury** | Treasury identifier, action type, allocated or withdrawn amounts, solvency results | The opt-in scheduler, if made Payer, can read that treasury | Balances, members, roles and policy values |
| **Payments** | Mandate commitments, status changes, each payment's period and timing | The opt-in scheduler, for treasuries that use it | Recipient, terms and amounts |

Slot numbers, treasury identifiers and timing can be correlated. The full model is in the [developer docs](https://zkdesk.tech/docs#privacy).

## Governance and trust

ZKdesk has not been independently audited. Protocol configuration is owned by a governance multisig acting through a timelock (24 hours on mainnet); the multisig currently has a single signer.

- **After the 24-hour timelock**, governance can de-list an asset (which also blocks its withdrawals from the pool), add a module that can move pool funds, disable a collateral class on the desk (which blocks every step in that class), change the liquidation venue and bonus address, and unpause the desk.
- **Immediately**, the guardian can pause new borrowing and partial collateral withdrawals; the deposit screener can flag a deposit during its 60-second standby so that it can only be refunded; and the relayer key sets the market-hours flag.
- **Liquidations** repay lenders first; the bonus and any surplus go to the governance Safe. Debt a liquidation cannot cover is written off and lowers lending-pool share value.
- **The relayer** submits private actions and runs upkeep. While it is down, funds stay in the contracts but private actions, deposit clearing, price pinning and health epochs pause.
- **Reserves** (10% of interest) have no withdrawal path yet and stay in the lending pool.

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
| `RELAYER_PRIVATE_KEY` | Server | Relayer account that submits private actions |
| `DESK_OPERATOR_SK` | Server | Desk operator key used to prove health epochs and liquidation batches |
| `SCHEDULER_SEED` | Server | Key seed for the opt-in mandate scheduler |
| `CRON_SECRET` | Server | Authenticates scheduled invocations |

Mainnet functions read `RPC_URL_SERVER`, `RELAYER_PRIVATE_KEY`, `DESK_OPERATOR_SK` and `SCHEDULER_SEED` with a `MAINNET_` prefix. `SUPABASE_DB_URL` and `CRON_SECRET` are shared, and mainnet data lives in a separate `mainnet` database schema. Contract deployment scripts also read `DEPLOYER_PRIVATE_KEY`, `RELAYER_ADDRESS`, `DESK_OPERATOR_PK_X` and `DESK_OPERATOR_PK_Y` (with `MAINNET_` variants). All names are listed in `.env.example`.

## Smart contracts

```sh
cd contracts
pnpm install --frozen-lockfile --ignore-workspace
forge install foundry-rs/forge-std@v1.16.2 --no-git
forge test
```

Most suites verify real UltraHonk proofs generated from `circuits/fixtures`. `MainnetFork.t.sol` runs only when `MAINNET_FORK` is set. Deployed addresses for each network are tracked in `src/lib/chain/deployments/`.

### Outdated comments in deployed contracts

Deployed contract sources are kept byte-identical so they match on-chain verification. A few comments in them predate the mainnet launch; the code behaves as described here.

| Location | Comment says | Actual behaviour |
| --- | --- | --- |
| `ZKDeskPool.sol` header | "No owner, no pause: exits are never gated" | The pool has no owner or upgrade path, but every transaction requires its asset to be listed in `AssetGate`, which governance controls through the timelock. Governance can also approve modules that move pool funds. See [Governance and trust](#governance-and-trust). |
| `CreditDesk.sol` `operatorPk` and `api/cron/desk.js` | Operator key is a "testnet stand-in for the TEE" | The same operator-key model runs on mainnet. Moving the operator into a TEE is planned. |
| `CreditDesk.sol` header and `healthy()` | Draws halt after "two missed" epochs | Draws halt once 3 epoch lengths pass without an attestation: 45 minutes in market hours, 3 hours outside them. |
| `CreditDesk.sol` and `LendingPoolUSDG.sol` reserves | 10% of interest goes to `ZKDStaking`, "held in cash until swept (M6)" | Reserves stay in the lending pool and have no withdrawal path. `ZKDStaking` is deployed on testnet only. |
| `CreditDesk.sol` `bonusSink` | "sequencer bond pool" | Liquidation bonus and surplus go to the governance Safe on mainnet. |
| `CreditDesk.sol` fee check | "relayer pays gas for credit steps on testnet" | Credit steps carry no relay fee on either network; the relayer pays their gas. |
| `CreditDesk.sol` `ISaleVenue` | "testnet: MockAMM" | Mainnet sells through `UniswapV3Venue`. |
| `CreditDesk.sol` header, `circuits/position` | Owner, size, debt and LTV are private | Position contents are encrypted, but the desk operator can read them, and each step's collateral and borrow amounts are public. See [Who sees what](#who-sees-what). |
| `Marker.sol` `marketOpen` | "Informational market-hours flag" | The flag selects the liquidation price band, the epoch interval and the off-hours liquidation floor. The relayer key sets it. |
| `circuits/treasury_attest` | Neither balances nor the number of notes can be recovered | The balance stays private, but the declared liability and the covering notes' nullifiers are public, so later spends of those notes link to the statement. |

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
| `GET` | `/api/relay` | Relayer address, availability and minimum relay fee (USDG base units) |
| `POST` | `/api/relay` | Submit a proven private action |
| `GET` | `/api/ops/:id` | Status of a relayed operation |
| `GET` / `POST` | `/api/requests` | Sealed treasury approval requests. No authentication: anyone can read or post ciphertexts, which only treasury members can open |

## Testing and CI

Pushes to `main` and every pull request run on GitHub Actions:

1. **App:** install, `pnpm test`, `pnpm build` and the privacy check.
2. **Contracts:** `forge test` with real proofs.

## Security

- Your keys never leave your browser. What the public and ZKdesk services can see is listed in [Who sees what](#who-sees-what).
- Authorization is enforced on-chain by proof verification, not by the frontend.
- Please report vulnerabilities privately through GitHub's **Report a vulnerability** form on the [Security tab](https://github.com/ZkDesk/ZkDeskRh/security) rather than in a public issue.

> Stock tokens are issued by third parties and carry their own eligibility and transfer rules. Nothing in this repository is an offer of a financial product.

## License

Released under the [MIT License](LICENSE).

### Third-party code

| Component | Location | License |
| --- | --- | --- |
| UltraHonk Solidity verifiers, generated by Barretenberg | `contracts/src/verifiers/` | Apache-2.0, Copyright 2022 Aztec (notice kept in each file) |
| `@zk-kit/lean-imt.sol` 2.0.1, vendored unmodified | `contracts/src/vendor/lean-imt/` | MIT, Copyright 2024 Ethereum Foundation (see its `LICENSE`) |

Packages installed through pnpm (for example OpenZeppelin, viem, Noir and Barretenberg) remain under their own licenses.
