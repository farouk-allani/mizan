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

# Route sanity: twak's router rejects bare alt symbols (TOKEN_NOT_FOUND), so quote each
# alt by its PINNED BSC contract — mirror of CONTRACT_PINS in src/tokens/allowlist.ts.
declare -A PINS=(
  [CAKE]=0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82
  [FLOKI]=0xfb5B838b6cfEEdC2873aB27866079AC55363D37E
  [TWT]=0x4B0F1812e5Df2A09796481Ff14017e6005508003
  [PENDLE]=0xb3Ed0A426155B79B898849803E3B36552f7ED507
  [INJ]=0xa2B726B1145A4773F68593CF171187d8EBe4d495
  [FET]=0x031b41e504677879370e9DBcF937283A8691Fa7f
  [LINK]=0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD
  [UNI]=0xBf5140A22578168FD562DCcF235E5D43A02ce9B1
  [AAVE]=0xfb6115445Bff7b52FeB98650C87f44907E58f802
)
for SYM in "${!PINS[@]}"; do
  twak swap USDT "${PINS[$SYM]}" --chain bsc --usd 5 --quote-only --json >/dev/null 2>&1 \
    && pass "route OK: USDT->$SYM (${PINS[$SYM]:0:10}…)" || echo "⚠️  no route USDT->$SYM — re-verify pin in allowlist.ts"
done

# x402: preview what CMC charges (read-only, no signing)
twak x402 quote https://mcp.coinmarketcap.com/x402/mcp --method POST \
  --body "{\"jsonrpc\":\"2.0\",\"id\":\"pf\",\"method\":\"tools/call\",\"params\":{\"name\":\"get_global_metrics_latest\",\"arguments\":{}}}" \
  --json >/dev/null 2>&1 && pass "x402 challenge reachable" || echo "⚠️  x402 quote failed — verify endpoint before live week"

node dist/verify-ledger.js ./data/ledger.jsonl || true
echo "—— preflight complete ——"
