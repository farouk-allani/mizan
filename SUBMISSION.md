# MIZAN ⚖️ — DoraHacks Submission (Track 1: Autonomous Trading Agents)

> **ميزان — "the scales."** A risk-first, halal-compliant, fully self-custody autonomous
> spot trading agent on BNB Chain. The LLM proposes. A deterministic Sentinel disposes.
> Keys never leave the machine.

**Agent wallet (BSC):** `0xCa3077EB13c10D844aCE8f5992c692073b5C5c81`
**Registration tx:** `0xfb05463bc15ce293089b157d315aa766b74879cac6ba69bc4af0bc8d61c106cc` ([BscScan](https://bscscan.com/tx/0xfb05463bc15ce293089b157d315aa766b74879cac6ba69bc4af0bc8d61c106cc))
**Repo:** `<GitHub URL>` · **Demo video:** `<link>` · **ERC-8004 identity (BSC testnet):** agentId `<id>`, tx `<hash>`

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

**Regime-aware spot momentum rotation, tournament-tuned.**

1. **Regime detection (deterministic, no LLM):** a composite of CMC Fear & Greed,
   aggregate derivatives funding rate, and the Altcoin Season index classifies each
   cycle as `risk_on / neutral / risk_off`. Derivatives data is read strictly as a
   *sentiment thermometer* — MIZAN never trades derivatives (see Compliance).
2. **Risk-on:** rotate into the strongest momentum names on the 149-token BSC allowlist
   (CAKE, FLOKI, TWT, PENDLE, INJ, FET, …), confirmed by RSI/MACD from CMC's technical
   analysis tools. Per-trade size is clamped to 15% of equity.
3. **Risk-off:** rotate toward USDT and wait. A daily `twak automate` DCA (~$5, executed
   by `twak watch`) keeps us qualified under the 1-trade/day minimum without taking risk;
   an in-loop backstop fires only if the automation hasn't run that day.
4. **Exits:** sentiment divergence (social heat rising while momentum rolls over)
   prompts de-risking proposals; the cooldown timer prevents overtrading chop.
5. **Tournament logic:** most entrants either breach the ~30% drawdown gate (disqualified)
   or hide in stables (~0%). The winning region is *concentrated-but-clamped* risk with a
   hard 18% auto-flatten — we can lose a battle, we cannot lose the war. Disqualification
   is the only unrecoverable outcome, so MIZAN structurally never visits it.

## The Sentinel (guardrails)

Ten pure rules, 100% unit-tested: competition allowlist on both legs · ambiguous-symbol
contract pinning (single-letter tickers like B/H/M/Q/U are how agents donate money to
scam tokens) · 15%-of-equity per-trade clamp · max 12 trades/day · daily notional cap ·
20-min cooldown · **18% drawdown circuit breaker → flatten to USDT** · $25 dust floor
(the $1/hour rule never threatens us) · no self-swaps · source-of-funds verification.

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
