#!/usr/bin/env bash
# Tier-2 ENS demo bring-up — one command: gateway + public tunnel + resolver repoint.
# Run from anywhere:  bash back/backend/scripts/ens-demo-up.sh
# Needs back/backend/.env with ENS_OWNER_KEY, ENS_GATEWAY_SIGNER_KEY, SEPOLIA_RPC_URL,
# ENS_PARENT_NAME (novicorpus.eth). Requires: node/tsx, foundry (cast/forge), ssh.
set -euo pipefail
BACKEND="$(cd "$(dirname "$0")/.." && pwd)"        # back/backend
ROOT="$(cd "$BACKEND/.." && pwd)"                    # back
cd "$BACKEND"
set -a; . ./.env; set +a
PORT="${PORT:-8788}"
PARENT="${ENS_PARENT_NAME:-novicorpus.eth}"

# 1) local gateway
if ! curl -s --max-time 3 "http://localhost:$PORT/" >/dev/null 2>&1; then
  echo "› starting gateway on :$PORT ..."
  nohup npx tsx --env-file=.env scripts/ens-gateway-serve.mts >/tmp/ensgw.log 2>&1 & disown
  sleep 5
fi
curl -s --max-time 3 "http://localhost:$PORT/" >/dev/null 2>&1 && echo "✓ gateway up" || { echo "✗ gateway failed (see /tmp/ensgw.log)"; exit 1; }

# 2) public tunnel (localhost.run over ssh)
echo "› starting tunnel ..."
rm -f /tmp/lhr.log
nohup ssh -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -R "80:localhost:$PORT" nokey@localhost.run >/tmp/lhr.log 2>&1 & disown
URL=""
for _ in $(seq 1 15); do URL=$(grep -oE "https://[a-z0-9]+\.lhr\.life" /tmp/lhr.log | head -1); [ -n "$URL" ] && break; sleep 2; done
[ -z "$URL" ] && { echo "✗ tunnel failed:"; cat /tmp/lhr.log; exit 1; }
echo "✓ tunnel: $URL"

# 3) deploy resolver pointing at the tunnel + repoint the name
SIGNER=$(cast wallet address --private-key "$ENS_GATEWAY_SIGNER_KEY")
cd "$ROOT"
echo "› deploying resolver ..."
NEW=$(forge create src/ens/OffchainResolver.sol:OffchainResolver \
  --rpc-url "$SEPOLIA_RPC_URL" --private-key "$ENS_OWNER_KEY" --broadcast \
  --constructor-args "$URL/ensgateway/{sender}/{data}.json" "[$SIGNER]" 2>&1 \
  | grep -oE "Deployed to: 0x[0-9a-fA-F]{40}" | grep -oE "0x[0-9a-fA-F]{40}")
[ -z "$NEW" ] && { echo "✗ resolver deploy failed"; exit 1; }
REG=0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e
NODE=$(cast namehash "$PARENT")
cast send "$REG" "setResolver(bytes32,address)" "$NODE" "$NEW" --private-key "$ENS_OWNER_KEY" --rpc-url "$SEPOLIA_RPC_URL" >/dev/null
sed -i "s#^ENS_RESOLVER_ADDRESS=.*#ENS_RESOLVER_ADDRESS=$NEW#" "$BACKEND/.env"
echo "✓ resolver $NEW set on $PARENT"
echo ""
echo "READY. Test:"
echo "  cd $BACKEND && NAME=demo.$PARENT AGENT_ID=845859 npx tsx --env-file=.env scripts/ens-demo.mts"
echo "  or open: https://sepolia.app.ens.domains/demo.$PARENT"
echo "Keep this shell open — the tunnel + gateway die if it closes."
