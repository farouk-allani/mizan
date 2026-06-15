<p align="center">
  <img src="./assets/mizan-logo.png" alt="MIZAN balance-scale logo mark" width="240">
</p>

# MIZAN

**A halal-compliant, Sentinel-guarded autonomous spot trading agent for BNB Chain.**

MIZAN was built for **BNB Hack: AI Trading Agent Edition - Track 1**. It combines
CoinMarketCap market data, Trust Wallet Agent Kit execution, x402-paid data access, and a
deterministic risk layer that prevents the LLM from directly controlling funds.

**Repository:** https://github.com/farouk-allani/mizan  
**Demo video:** https://www.youtube.com/watch?v=KnvOTW_CUL8

The core idea is simple:

```text
The agent executes.
The LLM only advises.
The Sentinel decides what is allowed.
```

## Why MIZAN Exists

Most autonomous trading agents are risky because model output can sit too close to
wallet authority. A malformed response, prompt injection, or hallucinated trade should
not be able to move funds.

MIZAN separates strategy from authority:

```text
CMC data
  -> regime detection
  -> LLM or rules-based proposal
  -> deterministic Sentinel validation
  -> TWAK quote/execution
  -> hash-chained audit ledger
```

The LLM can propose one spot rotation. It cannot sign, bypass risk rules, change
configuration, enable derivatives, or execute directly.

## What It Does

- **Autonomous spot trading on BNB Chain** using a self-custodial agent wallet.
- **Trust Wallet Agent Kit integration** for wallet operations, swap routing, competition
  registration, automation, and x402 requests.
- **CoinMarketCap data integration** for token quotes, global market context, regime
  signals, and technical inputs.
- **Sentinel risk validation** before every trade proposal can reach execution.
- **Paper mode** with real TWAK quotes and virtual portfolio fills.
- **Live mode** where approved swaps are signed and broadcast through TWAK.
- **x402 live data mode** where the agent can pay CMC REST x402 data calls from its own
  wallet.
- **Tamper-evident JSONL ledger** for every cycle, proposal, verdict, execution, error,
  and x402 payment event.

## Sentinel Guardrails

Sentinel is a deterministic validation layer in [src/core/sentinel.ts](./src/core/sentinel.ts).
It is intentionally not an LLM.

It enforces:

- Competition token allowlist.
- Ambiguous-symbol protection through pinned token contracts.
- Spot-only execution.
- Per-trade position sizing.
- Daily trade and notional caps.
- Cooldown between trades.
- Minimum-hold anti-roundtrip protection.
- Source-of-funds checks.
- Dust-floor protection.
- 18 percent drawdown circuit breaker.
- Flatten-to-stable behavior when the breaker is active.

If Sentinel rejects a proposal, nothing is quoted or executed.

## Halal Spot-Only Invariant

MIZAN is designed as a halal-compliant spot-only agent.

Derivatives data may be read as market sentiment, but derivatives are not traded. The
execution layer ships only a spot venue adapter, and the config refuses to load if
`halalMode` is enabled while perps are enabled.

```yaml
compliance:
  halalMode: true

venues:
  spot:
    enabled: true
  perps:
    enabled: false
```

## Trading Loop

1. Fetch market data from CMC.
2. Detect market regime: `risk_on`, `neutral`, or `risk_off`.
3. Ask the LLM strategist for one JSON trade proposal.
4. If the LLM holds or fails, use a conservative rules fallback.
5. Validate the proposal through Sentinel.
6. Quote and execute through TWAK if approved.
7. Append every step to the ledger.
8. Notify the operator through Telegram or console.

In paper mode, the same path runs but fills are applied to a virtual book. In live mode,
approved trades are signed by the agent wallet through TWAK.

## Auditability

MIZAN writes a hash-chained ledger to `data/ledger.jsonl`.

Each entry contains:

- timestamp
- event type
- payload
- previous hash
- current hash

Verify the chain:

```bash
npm run verify-ledger
```

This makes the run inspectable after the fact: data, regime, proposal, Sentinel verdict,
execution result, and x402 payments can be reviewed in order.

## Hackathon Fit

MIZAN targets Track 1 with a working autonomous trading loop and a strong safety story:

- **BNB Chain:** spot trading and competition registration use the BSC agent wallet.
- **TWAK:** wallet, swap, automation, x402 request, and competition surfaces.
- **CMC:** market data, quotes, regime context, and x402-paid live data path.
- **Autonomy:** persistent VPS process with Telegram monitoring and systemd restart.
- **Guardrails:** deterministic Sentinel between every proposal and every execution.
- **Audit:** hash-chained ledger and reproducible verification command.

## Repository Map

```text
src/index.ts                     main agent loop
src/core/strategist.ts           LLM strategist + active rules fallback
src/core/sentinel.ts             deterministic risk validation
src/core/ledger.ts               hash-chained audit ledger
src/adapters/twak/               TWAK CLI integration
src/adapters/cmc/                CMC API-key and x402 data providers
src/adapters/paper/PaperBook.ts  paper-trading virtual portfolio
src/tokens/allowlist.ts          competition allowlist and contract pins
config/default.yaml              competition configuration
scripts/preflight.sh             deployment and dependency checks
```

For the full design rationale, see [ARCHITECTURE.md](./ARCHITECTURE.md).

## Running Locally

Prerequisites:

- Node.js 20+
- Trust Wallet Agent Kit CLI: `npm install -g @trustwallet/cli`
- TWAK credentials from the Trust Wallet portal
- CMC API key for development API-key mode
- OpenAI-compatible LLM endpoint

Install and test:

```bash
npm install
npm test
npm run build
```

Run in paper mode:

```bash
npm start
```

Preflight before deployment or live mode:

```bash
npm run preflight
```

Environment variables are loaded from `.env` at runtime. Do not commit `.env`, wallet
keystores, private keys, API keys, or local ledger data.

## Operations

On a VPS, MIZAN is intended to run under `systemd` using
[scripts/mizan.service](./scripts/mizan.service). The service keeps the agent alive after
terminal disconnects and restarts it on failure or reboot.

Useful checks:

```bash
sudo systemctl status mizan
tail -20 data/ledger.jsonl
npm run verify-ledger
```

## Safety

MIZAN can sign real on-chain trades in live mode. It ships in `paper` mode by default.
Use live mode only after verifying wallet registration, route availability, x402
readiness, and ledger integrity.

This project is a hackathon trading-agent prototype. It is not financial advice.

## License

MIT
