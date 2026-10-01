<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/zkdesk-logo-light.png" />
  <source media="(prefers-color-scheme: light)" srcset=".github/assets/zkdesk-logo-dark.png" />
  <img src=".github/assets/zkdesk-logo-dark.png" alt="ZKdesk" width="112" height="112" />
</picture>

# ZKdesk

**Confidential credit, treasury and payments on Robinhood Chain.**

Balances, transfers, credit positions and payment terms stay private.<br/>
Every action is proven in the browser with zero-knowledge proofs and verified on-chain.

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

ZKdesk is a confidential finance workspace for businesses and projects. It keeps balances, transfers, credit positions, treasury holdings and payment terms private, and lets their owners disclose exactly what a counterparty needs with a zero-knowledge proof.

ZKdesk is a **client-proved** system:

- The **browser** holds the keys and generates every proof.
- **Contracts** verify proofs and hold the assets.
- **Services** only relay already-authorized data and perform scheduled, publicly verifiable work. No service ever receives a user's keys, balances or transaction plaintext.

## Features

| Area | What it does |
| --- | --- |
| **Shielded pool** | UTXO-style notes (commitments to asset, amount, owner and blinding). Spending publishes a nullifier, which prevents double spends without revealing the note. |
| **Private transfers** | Send, receive and withdraw privately. Actions are submitted by a relayer, so the user's public address never appears on them and no gas is needed. Fees are paid privately inside the proof. |
| **Confidential credit** | Borrow USDG against stock-token collateral. Each position is a hidden commitment in one of the desk's 64 slots. A USDG lending pool supplies the liquidity. |
| **Proven solvency** | The desk operator regularly proves a health epoch over every slot: total collateral, total debt and a commitment to exactly which positions are liquidatable. If no epoch is attested in time, new borrowing halts. |
| **Sealed liquidations** | Breached positions are liquidated in sealed batches that are checked against the attested epoch. |
| **Private treasuries** | Shared private ledgers with role-based members. Each treasury's view key is shared as encrypted on-chain key shares. |
| **Mandates** | Standing, bounded payment permissions with encrypted terms. Only a commitment and status changes are public. |
| **Selective receipts** | Recipients prove they were paid to one specific verifier. They can optionally disclose the amount, their identity or both. |
| **Transparency** | A wallet-free view of public protocol aggregates. It never exposes an individual position, balance, owner or amount. |
| **Deterministic keys** | All keys derive from a single wallet signature, so there is nothing extra to store or back up. |

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
- **Networks:** the same build serves Robinhood Chain mainnet (`4663`) and testnet (`46630`). Mainnet endpoints live under `/api/mainnet/*`.
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
├── public/               Static assets: brand, fonts
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
| `pnpm privacy` | Privacy check on mirror columns, logging, browser storage and bundle secrets |
| `pnpm zk:fixtures` | Regenerate circuit fixtures |
| `pnpm abis` | Export contract ABIs into `src/lib/chain/abis` |

## Configuration

The frontend runs without any secrets. Server functions read their configuration from environment variables. Never commit a `.env` file; it is git-ignored.

| Variable | Scope | Purpose |
| --- | --- | --- |
| `VITE_ZKDESK_MODE` | Build | Dashboard data source: `demo` (default) or `testnet` |
| `VITE_ZKDESK_CA` | Build | Token contract address shown on the site |
| `SUPABASE_DB_URL` | Server | Postgres connection for the event mirror |
| `RPC_URL_SERVER` | Server | Server-side RPC endpoint |
| `RELAYER_PRIVATE_KEY` | Server | Relayer account that submits private actions |
| `DESK_OPERATOR_SK` | Server | Desk operator key used for health epochs |
| `SCHEDULER_SEED` | Server | Seed for the mandate scheduler |
| `CRON_SECRET` | Server | Authenticates scheduled invocations |

Mainnet functions read the same server names with a `MAINNET_` prefix (for example `MAINNET_RPC_URL_SERVER`).

## Smart contracts

```sh
cd contracts
pnpm install --frozen-lockfile --ignore-workspace
forge install foundry-rs/forge-std@v1.16.2 --no-git
forge test
```

The test suite verifies real UltraHonk proofs generated from `circuits/fixtures`. Deployed addresses for each network are tracked in `src/lib/chain/deployments/`.

## Circuits

```sh
cd circuits
nargo compile --workspace
```

Compiled artifacts used by the browser prover live in `src/lib/zk/artifacts/`. The Noir and Barretenberg versions must change together as a matched pair; see `circuits/VERSIONS`.

## Public API

All endpoints are served from the site origin. Mainnet equivalents live under `/api/mainnet/*`.

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/transparency` | Public protocol aggregates (cached up to 30 s) |
| `GET` | `/api/relay` | Relayer availability and base fee |
| `POST` | `/api/relay` | Submit a proven private action |
| `GET` | `/api/ops/:id` | Status of a relayed operation |
| `GET` / `POST` | `/api/requests` | Sealed treasury approval requests (readable only by members) |

## Testing and CI

Every push and pull request runs on GitHub Actions:

1. **App:** install, `pnpm test`, `pnpm build` and the privacy check.
2. **Contracts:** `forge test` with real proofs.

## Security

- Keys and plaintext never leave the browser. Services handle only proofs and encrypted payloads.
- Authorization is enforced on-chain by proof verification, not by the frontend.
- Please report vulnerabilities privately through GitHub's **Report a vulnerability** form on the [Security tab](https://github.com/ZkDesk/ZkDeskRh/security) rather than in a public issue.

> Stock tokens are issued by third parties and carry their own eligibility and transfer rules. Nothing in this repository is an offer of a financial product.

## License

Released under the [MIT License](LICENSE).
