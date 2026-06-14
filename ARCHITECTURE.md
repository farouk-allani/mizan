# MIZAN — Architecture

> **ميزان** — "the scales." A risk-first, halal-compliant, self-custody autonomous spot
> trading agent for BNB Chain. Built for BNB Hack: AI Trading Agent Edition (Track 1),
> designed to keep running for its operator long after the competition ends.

## Design thesis

Most trading agents are an LLM with a wallet bolted on. MIZAN inverts that: it is a
**deterministic risk machine with an LLM bolted on**. The model proposes; a pure,
config-frozen Sentinel disposes. There is no code path from model output to a signed
transaction that does not pass through the Sentinel, and nothing the model emits can
modify a rule.

```
            ┌──────────────────────────────────────────────────────────┐
            │                        MIZAN loop                         │
            │                                                          │
  CMC Agent │  ┌──────────┐   ┌─────────┐   ┌────────────┐   ┌───────┐ │  BSC
  Hub (MCP) ├──► DataPort  ├──► Regime   ├──► Strategist  ├──►Sentinel│ │
  apikey /  │  │ (quotes,  │   │(determin-│   │ (LLM, JSON │   │(pure, │ │
  x402 paid │  │ TA, F&G,  │   │ istic)   │   │ contract)  │   │ hard) │ │
  via twak  │  │ funding)  │   └─────────┘   └────────────┘   └───┬───┘ │
            │  └──────────┘                       ▲ heartbeat /    │approved
            │                                     │ breaker also   ▼ only
            │  ┌────────────────┐             propose      ┌────────────┐
            │  │ Ledger (JSONL  │◄────every step───────────┤ Venue port │
            │  │ hash-chained)  │                          │ TwakSpot   ├──► twak swap
            │  └────────────────┘                          │ (ONLY impl)│    (local BIP39
            │  ┌────────────────┐                          └────────────┘     signing,
            │  │ Telegram notify│                                              ~/.twak)
            └──┴────────────────┴──────────────────────────────────────┘
```

## Layer map → judging rubric

| Layer | Implementation | Rubric line it scores |
|---|---|---|
| Execution | `TwakSpotVenue` — sole venue; twak CLI, `--json`, local keystore signing | TWAK integration depth (30), self-custody (25) |
| Guardrails | `sentinel.ts` — 10 pure rules: allowlist, ambiguity pins, per-trade clamp, daily caps, cooldown, drawdown breaker, dust floor | Autonomous execution & guardrails (20) |
| Data | CMC Agent Hub MCP for API-key mode; **live x402 pays CMC REST quotes/listings from the agent's own wallet via `twak x402 request`** | Native x402 (10) |
| Identity | (optional module) ERC-8004 registration via `bnbagent` on BSC testnet | Best Use of BNB AI Agent SDK ($2k special) |
| Audit | Hash-chained JSONL ledger, `npm run verify-ledger` | Demo & on-chain proof (5) |
| Compliance | `halalMode` load-time invariant | Originality / real-world relevance (10) |

## The Sentinel contract

`sentinelValidate(proposal, portfolio, state, config) → verdict` is a **pure function**:
no I/O, no clock surprises (time injected), fully unit-tested (11 tests). Rules:

1. Both legs in the 149-token competition allowlist (anything else cannot score).
2. Ambiguous symbols (B, H, M, Q, U, HOME, REAL, …) require pinned BSC contract
   addresses — symbol-resolution collisions are how agents donate money to scam tokens.
3. Per-trade notional clamped to `maxTradePctOfEquity` (clamp, don't reject — keep alpha).
4. Max trades/day; 5. max daily notional; 6. cooldown between trades (heartbeat exempt).
7. **Drawdown circuit breaker**: equity below HWM×(1−18%) ⇒ only `circuit_breaker`-source
   flatten-to-USDT proposals pass. The competition disqualifies at ~30% drawdown;
   disqualification is the only unrecoverable state, so we never get near it.
8. Dust floor: portfolio may never approach the $1/hour zero-scoring rule.
9. No self-swaps; 10. positive notional; plus source-of-funds check against holdings.

## Venue configurability (the "disable perps" requirement)

`ExecutionVenue` is a port. `TwakSpotVenue` is the only adapter that ships. The config
declares a venue registry:

```yaml
compliance: { halalMode: true }
venues:
  spot:  { enabled: true }
  perps: { enabled: false }   # reserved
```

`ConfigSchema.superRefine` makes `halalMode && perps.enabled` a **parse error** — the
process refuses to boot. Derivatives data from CMC is still consumed, but strictly as a
sentiment thermometer for regime detection. Adding perps later (for a non-halal operator)
means writing an adapter AND flipping two config values; it can never happen by accident,
by prompt injection, or by LLM creativity.

## Strategy (live-week profile)

**Regime-aware spot momentum rotation**, tournament-tuned:

- Deterministic regime from Fear & Greed + aggregate funding + altcoin season:
  `risk_on | neutral | risk_off`.
- `risk_on`: rotate up to 15%/trade into strongest momentum names on the BSC allowlist
  (CAKE, FLOKI, TWT, PENDLE, INJ, FET…), RSI/MACD-confirmed via CMC TA tools.
- `risk_off`: rotate toward USDT; a daily `twak automate` DCA (executed by `twak watch`)
  fires one small trade/day to stay qualified (≥1 trade/day rule = 7 over the week), with
  an in-loop backstop if the automation hasn't run that day.
- Sentiment-divergence exit: social heat up while momentum rolls over ⇒ strategist is
  prompted to propose de-risking.
- Tournament logic: most entrants either blow the 30% gate or hide in stables at ~0%.
  Concentrated-but-clamped risk with an 18% hard flatten occupies the winning region.

## Self-custody integrity

- Keys: twak's local BIP39 keystore (`~/.twak/wallet.json`); signing on-device.
- MIZAN never reads, stores, or transmits a private key; the wallet password reaches
  twak only via `TWAK_WALLET_PASSWORD`/OS keychain — never argv (twak itself warns
  that `--password` leaks into shell history).
- No custodial fallback exists in the codebase. The penalty ladder's 20–25 band is the
  only band we can land in.

## Audit ledger

Every cycle, data fetch, regime reading, proposal, verdict, execution, x402 payment and
error is appended to `data/ledger.jsonl` where each entry's sha256 chains the previous —
tamper-evident by construction (`npm run verify-ledger`). This is the same auditability
idea as YieldMind's HCS decision log, without a second chain dependency. The demo shows:
ledger entry → Sentinel verdict → twak tx hash → BscScan, end to end.

## Failure containment

- Cycle errors are logged + notified, never fatal; systemd restarts on crash.
- `KILL` file = clean stop (no orphaned automations).
- twak error codes (`NO_ROUTES`, `INSUFFICIENT_BALANCE`, `TX_FAILED`,
  `APPROVAL_SENT_SWAP_FAILED`…) surface verbatim into the ledger and Telegram.
- Notifications can fail silently; trading never depends on Telegram being up.

## Post-hackathon mode (the real goal)

Copy `config/default.yaml` → `config/personal.yaml`, then: lower `maxTradePctOfEquity`,
disable `heartbeat` (it exists only for the competition rule), keep `halalMode: true`,
optionally switch `cmcTransport` back to `apikey` (free tier) and widen
`loop.intervalMinutes`. Point `MIZAN_CONFIG` at it. Same binary, same guardrails,
your capital, your rules.

## Known day-1 verification tasks (honest TODOs)

- Pin `twak wallet portfolio --json` exact output shape (adapter is defensive for now).
- Pin CMC MCP tool result payload shapes (parsers are defensive for now).
- Populate `CONTRACT_PINS` for every symbol the strategy can touch; run
  `scripts/preflight.sh` route checks.
- Confirm the CMC REST x402 quote endpoint is reachable with `twak x402 quote`;
  live settlement uses gasless Base USDC.
