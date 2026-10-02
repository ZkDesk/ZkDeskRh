# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub private vulnerability reporting on the public repository
[ZkDesk/ZkDeskRh](https://github.com/ZkDesk/ZkDeskRh): open the **Security** tab and choose
**Report a vulnerability**.

Do not open public issues, pull requests or discussions for suspected vulnerabilities, and do not test
against funds or accounts that are not yours.

## Status of the protocol

ZKDesk runs on Robinhood Chain. Its contracts and circuits have not been audited by humans; only
automated and AI-assisted reviews have been performed. Treat every deployment as unaudited software.

## Scope

In scope:

- `contracts/` (Solidity contracts and deployment scripts)
- `circuits/` (Noir circuits and the generated verifiers they produce)
- `api/` (serverless API, relay and cron jobs)
- `src/lib/` (client chain and ZK libraries)

Out of scope:

- The demo dashboard and its sample data, balances and receipts (`src/dashboard/` simulation state)
- Third-party services and dependencies (Robinhood Chain, RPC providers, wallets, Uniswap, price feeds,
  hosting, database providers); report those to their maintainers
- Findings that require a compromised user device, browser or private key
- Automated scanner output without a demonstrated impact

## What to include

- Affected component, file and line, and the commit or deployed address
- Network (mainnet or testnet)
- A description of the impact and the conditions needed to trigger it
- Steps to reproduce or a proof of concept (a Foundry test or `nargo` test is ideal)
- Any suggested fix

## Response

Reports are handled on a best-effort basis. There is no guaranteed response time and no bug bounty
program. We aim to acknowledge reports, confirm or dispute the issue, and coordinate a fix and
disclosure with the reporter before details are made public.
