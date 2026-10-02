#!/usr/bin/env bash
# Deploys v2 (script/DeployV2.s.sol) and verifies every contract's source on Sourcify, which the
# network's Blockscout imports (Blockscout's own API sits behind a browser challenge).
# Usage (WSL or Linux): bash deploy-v2.sh testnet|mainnet [--broadcast]
#   Without --broadcast: a simulation against the live chain; nothing is sent.
# Afterwards: node scripts/ops/merge-v2.mjs <chainId>, node scripts/ops/reset-mirror.mjs [mainnet],
# then node scripts/check-deployment.mjs <network>.
set -euo pipefail
cd "$(dirname "$0")"
net=${1:?testnet or mainnet}; shift
set -a; source <(tr -d '\r' < ../.env.local); set +a
if [ "$net" = mainnet ]; then
  rpc=https://rpc.mainnet.chain.robinhood.com; explorer=https://robinhoodchain.blockscout.com/api/
  export DESK_OPERATOR_PK_X="$MAINNET_DESK_OPERATOR_PK_X" DESK_OPERATOR_PK_Y="$MAINNET_DESK_OPERATOR_PK_Y"
  # Guardian and screener: governance signers 1 and 2 (secrets/mainnet-governance-keys.json).
  export GUARDIAN="${GUARDIAN:-$(node -e "console.log(require('../secrets/mainnet-governance-keys.json').signers[0].address)")}"
  export SCREENER="${SCREENER:-$(node -e "console.log(require('../secrets/mainnet-governance-keys.json').signers[1].address)")}"
else
  rpc=https://rpc.testnet.chain.robinhood.com; explorer=https://explorer.testnet.chain.robinhood.com/api/
  export GUARDIAN="${GUARDIAN:-$DEPLOYER_ADDRESS}" SCREENER="${SCREENER:-$DEPLOYER_ADDRESS}"
fi
verify=()
if [[ " $* " == *" --broadcast "* ]]; then verify=(--verify --verifier sourcify); fi
: "$explorer" # contract pages: <explorer>/address/<address>
forge script script/DeployV2.s.sol --rpc-url "$rpc" --slow "${verify[@]}" "$@"
