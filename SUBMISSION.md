# MIZAN ⚖️ — DoraHacks Submission (Track 1: Autonomous Trading Agents)

> **ميزان — "the scales."** A risk-first, halal-compliant, fully self-custody autonomous
> spot trading agent on BNB Chain. The LLM proposes. A deterministic Sentinel disposes.
> Keys never leave the machine.

**Agent wallet (BSC):** `0xCa3077EB13c10D844aCE8f5992c692073b5C5c81`
**Registration tx:** `0xfb05463bc15ce293089b157d315aa766b74879cac6ba69bc4af0bc8d61c106cc` ([BscScan](https://bscscan.com/tx/0xfb05463bc15ce293089b157d315aa766b74879cac6ba69bc4af0bc8d61c106cc))
**Repo:** https://github.com/farouk-allani/mizan
**Demo video:** https://www.youtube.com/watch?v=KnvOTW_CUL8
**ERC-8004 identity (BSC testnet):** agentId `1391`, tx `0xafc8eee5506179148687d3692d0e45c733ca07eb5f742c2837ecd61e3fb3f0e6`, identity wallet `0x3141789d9D515Ec21530A0D69E91f5234995018E`

---

## The problem with trading agents

Most "AI trading agents" are a language model with a wallet bolted on: the model's output
*is* the trade. That architecture has two fatal flaws — an LLM can be talked into
anything (prompt injection, hallucinated tickers, runaway sizing), and a one-week PnL
competition punishes exactly one mistake type above all: **blowing the drawdown gate.**

## Our answer: invert the architecture

MIZAN is a **deterministic risk machine with an LLM bolted on.** Every trade proposal —
whether it comes from the LLM strategist, the heartbeat scheduler, or the circuit
breaker — passes through a pure, config-frozen Sentinel before any signing happens.
There is no code path from model output to a transaction that bypasses it. Nothing the
model emits can change a rule, because the rules are parsed and frozen before the model
ever runs.

## Strategy (as required by the rules: how we achieve our results)

**Regime-aware momentum with a let-winners-run position engine — offense and defense split.**

The strategy is one coherent policy, not a model toggling buy/sell each cycle. It answers
*"what should we be holding, and is a better option worth the ~1% round-trip cost?"* — then
holds until that answer changes.

1. **Regime detection (deterministic, no LLM):** a composite of CMC Fear & Greed,
   aggregate derivatives funding rate, and the Altcoin Season index classifies each
   cycle as `risk_on / neutral / risk_off`. Derivatives data is read strictly as a
   *sentiment thermometer* — MIZAN never trades derivatives (see Compliance).
2. **Offense (entries & rotations) — `risk_on` only:** momentum deploys *only* in a confirmed
   uptrend. The LLM strategist proposes deploying into the strongest momentum names on the
   149-token BSC allowlist (CAKE, FLOKI, TWT, PENDLE, INJ, FET, …), confirmed by RSI/MACD on the
   cycle's top movers; in `neutral`/`risk_off` chop it holds cash (buying strength in neutral is
   a buy-the-top round trip, not edge). Capital scales toward a concentrated-but-clamped volatile
   target; we **rotate only when a candidate beats the held token by a margin sized to cover the
   round-trip cost** — never between near-ties. A deterministic target-allocation engine drives
   the same policy whenever the LLM holds.
3. **Defense (exits, deterministic):** a per-position **trailing stop** (doubling as a hard
   stop-loss) and a **regime flip to risk_off** flatten to USDT. A **profit-lock** tightens the
   trail once a position is meaningfully in profit, so a reversal banks the gain instead of
   round-tripping it — while genuine trends still run. Protective exits are exempt from the
   anti-churn timers so capital preservation never waits; a let-winners-run guard suppresses any
   discretionary LLM sell of a healthy holding. The loop runs on a tight interval and a held
   position is monitored with a price-only cycle (no paid technicals), keeping the stop reactive
   without burning the x402 budget.
4. **Contrarian sleeve (extreme fear):** when Fear & Greed hits capitulation (≤25), momentum
   offense stays out — but that is where bounces start, so MIZAN may take a *small, tightly
   capped* mean-reversion bet on an oversold-and-*turning* quality token (RSI recovering +
   MACD turning up — never a falling knife). Smaller per-trade and volatile caps; the trailing
   and hard stops still protect, and the risk_off auto-exit is suspended while armed so the bet
   isn't reversed next cycle.
5. **Qualification:** a daily `twak automate` DCA (~$5, executed by `twak watch`) keeps us
   qualified under the 1-trade/day minimum; an in-loop backstop fires only if the automation
   hasn't run that day.
6. **Tournament logic:** most entrants either breach the ~30% drawdown gate (disqualified)
   or hide in stables (~0%). The winning region is *concentrated-but-clamped* risk. A
   two-tier breaker keeps us there: a **re-armable 18% soft breaker** flattens to USDT, waits
   out the dip, then redeploys (so one bad swing doesn't bench us for the week), while a
   **permanent 25% hard stop** against the all-time peak guarantees we never approach the
   ~30% gate. We can lose a battle and recover; disqualification — the only unrecoverable
   outcome — is structurally off the table.

## The Sentinel (guardrails)

Eleven pure rules, 100% unit-tested: competition allowlist on both legs · ambiguous-symbol
contract pinning (single-letter tickers like B/H/M/Q/U are how agents donate money to
scam tokens) · 25%-of-equity per-trade clamp (concentrated entries) · max 6 trades/day ·
daily notional cap · 45-min cooldown · minimum-hold anti-roundtrip rule · **two-tier drawdown
protection: re-armable 18% soft breaker + permanent 25% hard stop → flatten to USDT** · $25
dust floor (the $1/hour rule never threatens us) · no self-swaps · source-of-funds
verification. The breaker **and** deterministic protective exits (`risk_exit`) are exempt from
the anti-churn timers and daily caps — preservation first.

## Self-custody integrity (TWAK special prize)

- **TWAK is the sole execution layer.** Surfaces used: agent wallet (local BIP39
  keystore, on-device signing), `twak swap` with quote-first discipline and slippage
  caps, **`twak automate`** (a real on-wallet daily DCA automation created at boot and
  executed by `twak watch` — the autonomous qualification trade, not an in-process timer),
  `twak compete` (on-chain registration), and `twak x402` (see below). No custodial
  component exists anywhere in the flow.
- The wallet password reaches twak only via env/OS-keychain — never argv.

## Native x402 — the agent funds its own data

During the live week MIZAN's paid market data uses CoinMarketCap's x402 REST surface:
**each paid CMC REST call is funded by the agent's own wallet via `twak x402 request`,
inside the trade loop**, with each successful payment recorded in the audit ledger.
Settlement uses the endpoint's preferred route — **gasless EIP-3009 USDC on Base,
signed locally by the same self-custody key that trades on BSC** — so the agent funds its
own data without spending the BSC trading capital it is scored on, and with no separate gas
token. The MCP x402 endpoint itself is not called by TWAK 0.19.1 because it requires the
Streamable HTTP `Accept: application/json, text/event-stream` header that TWAK cannot
currently add.

## CMC Agent Hub usage (special prize)

In build-window mode, MIZAN consumes CMC Agent Hub MCP tools for quotes, technical
analysis, global metrics, and derivatives positioning. In live x402 mode, TWAK pays CMC's
REST x402 quotes/listings endpoints; quotes feed the strategist directly, and listings
derive a paid breadth/dominance proxy for the deterministic regime engine.

## BNB AI Agent SDK usage (special prize)

MIZAN registers an **ERC-8004 on-chain identity** on BSC testnet (gas-free via MegaFuel)
with an A2A agent card describing its capabilities, making the agent discoverable in the
on-chain registry — see `identity/` in the repo. The identity wallet is intentionally
separate from the trading wallet (key isolation).

## Compliance as architecture (originality / real-world relevance)

MIZAN's operator trades halal: spot-only, no leverage, no interest-bearing instruments.
This isn't a policy in a prompt — it's a **load-time invariant**: with
`compliance.halalMode: true`, a config that enables any derivatives venue *fails to
parse* and the process refuses to boot. There is a real, underserved user base for
faith-compliant automated investing; MIZAN is built for it from the first line, and its
operator will keep running it on personal capital after the competition — same binary,
lower risk caps.

## Auditability

Every cycle, data fetch, regime reading, proposal, Sentinel verdict, execution, x402
payment and error is appended to a **hash-chained JSONL ledger** (`npm run verify-ledger`
proves integrity). The demo traces one decision end-to-end: ledger entry → verdict →
twak tx hash → BscScan.

## Stack

TypeScript (strict) · TWAK CLI (`@trustwallet/cli`) · CMC Agent Hub MCP + x402 ·
BNB AI Agent SDK (`bnbagent`, ERC-8004) · any OpenAI-compatible LLM endpoint ·
systemd-hardened VPS deployment · Telegram ops channel.

## Honest limitations

twak portfolio and CMC payload shapes are pinned against the live APIs, not assumed — the
portfolio reader parses twak's flat multi-chain array (BSC tokens only, native gas
excluded), and the CMC adapter keys on numeric IDs with table/nested parsers; every
watchlist alt has a `--quote-only`-verified BSC contract pin. x402 settles on the
endpoint's preferred gasless USDC-on-Base route, confirmed via `twak x402 quote`. The
honest residual: one trading week is variance-dominated, so MIZAN is tuned to never breach
the drawdown gate rather than to chase the top of the leaderboard.
