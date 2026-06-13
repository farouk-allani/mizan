#!/usr/bin/env bash
# MIZAN preflight — run before flipping mode: paper -> live, and before June 22.
set -euo pipefail
pass() { echo "✅ $1"; }
fail() { echo "❌ $1"; exit 1; }

command -v twak >/dev/null || fail "twak not installed (npm install -g @trustwallet/cli)"
pass "twak installed: $(twak --version 2>/dev/null || echo ?)"

twak auth status --json | grep -q "\"configured\": *true" && pass "twak auth configured" || fail "twak auth not configured (set TWAK_ACCESS_ID/TWAK_HMAC_SECRET, run: twak init)"

twak wallet status --json | grep -q "\"agentWallet\": *\"configured\"" && pass "agent wallet exists" || fail "no agent wallet (twak wallet create --password ...)"

echo "→ BSC address:"; twak wallet address --chain bsc --json

# Competition registration window + status
twak compete status --json || fail "compete status failed"

# Route sanity: every strategy symbol must quote on BSC
for SYM in CAKE FLOKI TWT PENDLE; do
  twak swap 5 USDT "$SYM" --chain bsc --quote-only --json >/dev/null 2>&1 \
    && pass "route OK: USDT->$SYM" || echo "⚠️  no route USDT->$SYM (remove from WATCHLIST or pin contract)"
done

# x402: preview what CMC charges (read-only, no signing)
twak x402 quote https://mcp.coinmarketcap.com/x402/mcp --method POST \
  --body "{\"jsonrpc\":\"2.0\",\"id\":\"pf\",\"method\":\"tools/call\",\"params\":{\"name\":\"get_global_metrics_latest\",\"arguments\":{}}}" \
  --json >/dev/null 2>&1 && pass "x402 challenge reachable" || echo "⚠️  x402 quote failed — verify endpoint before live week"

node dist/verify-ledger.js ./data/ledger.jsonl || true
echo "—— preflight complete ——"
