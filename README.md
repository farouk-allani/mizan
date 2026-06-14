# MIZAN ⚖️

**Halal-compliant, sentinel-guarded autonomous spot trading agent on BNB Chain.**
Built for *BNB Hack: AI Trading Agent Edition* (Track 1) — CoinMarketCap × Trust Wallet.

- 🔐 **Self-custody only** — Trust Wallet Agent Kit (TWAK) local BIP39 signing; no key ever leaves the machine, no custodial path exists in the code.
- 🛡️ **Sentinel-guarded** — the LLM proposes, a pure deterministic guardrail layer disposes: 149-token allowlist, per-trade & daily caps, cooldowns, an 18% drawdown circuit breaker (vs the 30% disqualification gate), and a dust floor.
- 💸 **Native x402** — in live mode the agent pays CMC REST x402 data calls from its own wallet, inside the trade loop.
- ☪️ **Halal by invariant** — `compliance.halalMode: true` makes enabling any derivatives venue a *config parse error*, not a runtime opinion. Spot only. Always.
- 🧾 **Tamper-evident audit** — every decision hash-chains into `data/ledger.jsonl`; verify with `npm run verify-ledger`.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design.

## Quickstart

```bash
# 0. Prereqs: Node >= 20
npm install -g @trustwallet/cli        # TWAK
git clone <this repo> && cd mizan && npm install

# 1. Secrets
cp .env.example .env                   # fill TWAK + CMC + LLM + Telegram
set -a && source .env && set +a

# 2. TWAK auth + agent wallet (one time)
twak init
twak wallet create --password "$TWAK_WALLET_PASSWORD"
twak wallet address --chain bsc --json   # ← fund this address on BSC

# 3. Build, test, preflight
npm test                               # tsc + 11 sentinel tests
npm run preflight                      # auth, wallet, routes, x402, compete status

# 4. Paper-trade first (default config: mode: paper)
npm run build && npm start

# 5. Register for the competition (idempotent, on-chain)
npm run register

# 6. Go live: set mode: live in config/default.yaml, restart
```

## Competition runbook (June 22–28)

- Deploy on the VPS: `scripts/mizan.service` → `systemctl enable --now mizan`
- Switch `data.cmcTransport: x402` so live-week data is paid per-call (prize criterion)
- Watch Telegram; emergency stop = `touch KILL` (clean exit before next cycle)
- The heartbeat guarantees the 1-trade/day minimum at 20:00 UTC if nothing traded
- Drawdown ≥ 18% ⇒ auto-flatten to USDT and hold (the 30% gate disqualifies — we never visit it)

## Submission checklist (DoraHacks, by June 21 13:00 UTC)

- [ ] `twak compete register` tx hash + agent BSC address
- [ ] This repo public, with setup instructions (this file)
- [ ] Demo video: ledger entry → Sentinel verdict → twak swap → BscScan tx, end to end
- [ ] Strategy write-up (regime-aware spot momentum rotation — see ARCHITECTURE.md)
- [ ] Special prizes pitch: TWAK depth (sole venue, wallet+swap+automation+x402 surfaces), Agent Hub usage, BNB SDK ERC-8004 identity (optional module)

## Safety & disclaimers

Trading agents act on-chain and can lose real money. MIZAN ships in `paper` mode for a
reason; the operator is responsible for every live trade it signs. Not financial advice.

## License

MIT
