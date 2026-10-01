#!/usr/bin/env bash
# Usage (WSL): bash mainnet-deploy.sh [--broadcast]   Without --broadcast: a dry run on a fork.
set -euo pipefail
cd "$(dirname "$0")"
set -a; source <(tr -d '\r' < ../.env.local); set +a
export DESK_OPERATOR_PK_X="$MAINNET_DESK_OPERATOR_PK_X" DESK_OPERATOR_PK_Y="$MAINNET_DESK_OPERATOR_PK_Y"
~/.foundry/bin/forge script script/DeployMainnet.s.sol --rpc-url https://rpc.mainnet.chain.robinhood.com --slow "$@"
