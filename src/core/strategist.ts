import { z } from 'zod';
import type { Config } from '../config.js';
import type { AgentState, GlobalSnapshot, PortfolioSnapshot, RegimeReading, TechnicalSnapshot, TokenQuote, TradeProposal } from './types.js';
import type { LlmClient } from '../ports/index.js';
import { COMPETITION_ALLOWLIST } from '../tokens/allowlist.js';

/**
 * Regime detection — DETERMINISTIC. No LLM involvement.
 * Composite of Fear&Greed, BTC dominance drift, and aggregate funding rate
 * (derivatives data is read as a *sentiment thermometer*; MIZAN never trades
 * derivatives — compliance.halalMode).
 */
export function detectRegime(g: GlobalSnapshot): RegimeReading {
  let score = 0;
  const inputs: Record<string, number | string> = {};

  if (g.fearGreed !== undefined) {
    // 0..100 -> -1..1 centered at 50
    const fg = (g.fearGreed - 50) / 50;
    score += 0.5 * fg;
    inputs.fearGreed = g.fearGreed;
  }
  if (g.derivatives?.avgFundingRate !== undefined) {
    // extreme positive funding = froth (fade), mild positive = healthy risk-on
    const f = g.derivatives.avgFundingRate;
    score += f > 0.0008 ? -0.25 : f > 0 ? 0.25 : -0.25;
    inputs.avgFundingRate = f;
  }
  if (g.altcoinSeason !== undefined) {
    score += 0.25 * ((g.altcoinSeason - 50) / 50);
    inputs.altcoinSeason = g.altcoinSeason;
  }

  const regime: RegimeReading['regime'] = score > 0.15 ? 'risk_on' : score < -0.15 ? 'risk_off' : 'neutral';
  return { regime, score: Number(score.toFixed(3)), inputs, asOf: new Date().toISOString() };
}

// ---------- Strategist (LLM) ----------

const ProposalJson = z.object({
  action: z.enum(['swap', 'hold']),
  fromSymbol: z.string().optional(),
  toSymbol: z.string().optional(),
  usdNotional: z.number().positive().optional(),
  rationale: z.string().min(1).max(2000),
});

const SYSTEM_PROMPT = `You are the Strategist module of MIZAN, a halal-compliant SPOT-ONLY autonomous trading agent competing on BSC.
Your job is OFFENSE: keep capital deployed in the strongest allowlist asset and let winners run. A separate
deterministic module owns DEFENSE — it trailing-stops, exits on trend breaks, and de-risks to stable when the
regime turns risk_off — so you do NOT need to propose protective sells; if you try to dump a healthy holding to a
stable while the regime is not risk_off, that proposal is overridden and the cycle is wasted.

Hard facts you must respect (violations are discarded by a deterministic Sentinel, wasting the cycle):
- You may only propose swaps between symbols in the provided allowlist.
- Spot only. No leverage, no perps, no shorting. You may READ derivatives data as sentiment.
- Regime: risk_on/neutral => be deployed in momentum leaders; risk_off => the defense module handles de-risking.
- Every swap costs ~0.4-0.5% in spread/impact per leg (~1% round trip), marked against mid. Only ENTER or ROTATE
  when the expected edge clearly beats that cost. Prefer HOLDING an asset you already own that is still trending.
- Do not churn. Rotate to a different token only when it is *materially* stronger than what you hold.
- Respond with ONLY a JSON object: {"action":"swap"|"hold","fromSymbol"?,"toSymbol"?,"usdNotional"?,"rationale"}.
- No markdown, no code fences, no commentary outside the JSON.`;

export async function strategistPropose(
  llm: LlmClient,
  cfg: Config,
  ctx: {
    regime: RegimeReading;
    quotes: TokenQuote[];
    technicals: TechnicalSnapshot[];
    holdingsSummary: string;
    state: AgentState;
    paperPnlPct?: number;
  },
): Promise<TradeProposal | null> {
  const allow = [...COMPETITION_ALLOWLIST].slice(0, 149).join(', ');
  const lastTrade = ctx.state.lastTradeAt
    ? `${ctx.state.lastTradeFromSymbol ?? '?'}->${ctx.state.lastTradeToSymbol ?? '?'} at ${ctx.state.lastTradeAt}`
    : 'none today/loaded state';
  const position = ctx.state.positionSymbol
    ? `${ctx.state.positionSymbol} (entry ~$${(ctx.state.positionEntryPriceUsd ?? 0).toFixed(4)}, peak ~$${(ctx.state.positionPeakPriceUsd ?? 0).toFixed(4)}, since ${ctx.state.positionEntryAt ?? '?'})`
    : 'flat (stables only)';
  const user = [
    `Regime: ${ctx.regime.regime} (score ${ctx.regime.score}) inputs=${JSON.stringify(ctx.regime.inputs)}`,
    `Holdings: ${ctx.holdingsSummary}`,
    `Open position: ${position}`,
    `Trading state: tradesToday=${ctx.state.tradesToday}/${cfg.risk.maxTradesPerDay}, notionalTodayUsd=${ctx.state.notionalTodayUsd.toFixed(2)}, lastTrade=${lastTrade}, cooldownMinutes=${cfg.risk.cooldownMinutes}, switchMarginScore=${cfg.risk.switchMarginScore}`,
    ctx.paperPnlPct === undefined ? undefined : `Paper PnL: ${ctx.paperPnlPct.toFixed(2)}%`,
    `Quotes: ${JSON.stringify(ctx.quotes)}`,
    `Technicals: ${JSON.stringify(ctx.technicals)}`,
    `Allowlist: ${allow}`,
    `Propose at most one swap (ENTER a leader, or ROTATE the held token into a materially stronger one), or hold. ` +
      `Do not propose selling a healthy holding to a stable — defense handles that. Hold when the edge is unclear.`,
  ].filter((line): line is string => line !== undefined).join('\n');

  const raw = await llm.complete(SYSTEM_PROMPT, user);
  const stripped = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();

  let parsed: z.infer<typeof ProposalJson>;
  try {
    parsed = ProposalJson.parse(JSON.parse(stripped));
  } catch {
    // Malformed model output is treated as 'hold' — never guess a trade.
    return null;
  }

  if (parsed.action === 'hold') return null;
  if (!parsed.fromSymbol || !parsed.toSymbol || !parsed.usdNotional) return null;

  return {
    kind: 'swap',
    fromSymbol: parsed.fromSymbol,
    toSymbol: parsed.toSymbol,
    usdNotional: parsed.usdNotional,
    rationale: parsed.rationale,
    source: 'strategist_llm',
  };
}

// ---------- Deterministic target-allocation engine ----------
//
// The architecture is a single coherent policy, NOT two competing voices:
//   • DEFENSE (evaluateExit): deterministic protective exits — trailing stop, trend break,
//     regime flip to risk_off. Owns capital preservation, fires regardless of cooldown.
//   • OFFENSE (LLM strategist, with rulesTargetAllocation as the deterministic fallback):
//     deploy into the strongest leader, scale toward the volatile target, let winners run,
//     and rotate only when a candidate is *materially* stronger (clears switchMarginScore).
//   • reconcileLlmProposal: a let-winners-run guard so the LLM can't churn-sell a healthy
//     position to stable while the regime is constructive — defense owns that decision.
// This removes the old buy-bias-vs-sell-bias ping-pong that bled spread every cycle.

export const STABLES = new Set(['USDT', 'USDC', 'DAI', 'TUSD', 'FDUSD', 'USD1', 'USDE', 'USDD', 'FRAX', 'LISUSD', 'USDF', 'FRXUSD']);
const ALLOWLIST_SYMBOLS = new Set([...COMPETITION_ALLOWLIST].map((s) => s.toUpperCase()));

export function isStable(symbol: string): boolean {
  return STABLES.has(symbol.toUpperCase());
}

function heldUsd(portfolio: PortfolioSnapshot, symbol: string): number {
  return portfolio.holdings.find((h) => h.symbol.toUpperCase() === symbol.toUpperCase())?.valueUsd ?? 0;
}

function volatileUsd(portfolio: PortfolioSnapshot): number {
  return portfolio.holdings
    .filter((h) => !isStable(h.symbol))
    .reduce((sum, h) => sum + h.valueUsd, 0);
}

function technicalScore(t?: TechnicalSnapshot): number {
  if (!t) return 0;
  let score = 0;
  if (t.rsi14 !== undefined) {
    if (t.rsi14 >= 45 && t.rsi14 <= 72) score += 1.5;
    else if (t.rsi14 > 78) score -= 2;
    else if (t.rsi14 < 35) score -= 1;
  }
  if (t.macd) score += t.macd.histogram > 0 ? 2 : -1;
  if (t.ema20 !== undefined && t.ema50 !== undefined) score += t.ema20 > t.ema50 ? 1 : -1;
  return score;
}

/** Momentum + technical score for one symbol. Used for both entry ranking and rotation edge. */
function scoreFor(symbol: string, quotes: TokenQuote[], technicals: TechnicalSnapshot[]): number {
  const q = quotes.find((x) => x.symbol.toUpperCase() === symbol.toUpperCase());
  const t = technicals.find((x) => x.symbol.toUpperCase() === symbol.toUpperCase());
  return (q?.pctChange24h ?? 0) + technicalScore(t);
}

/**
 * Trend confirmation for an ENTRY. When technicals exist for the symbol we require an actual
 * uptrend (MACD histogram > 0 and EMA20 > EMA50) — not just a positive 24h print — so the bot
 * deploys into confirmed momentum rather than getting chopped up entering weak setups. When no
 * technicals are available we don't block (the score/24h gate still applies).
 */
function trendConfirmed(symbol: string, technicals: TechnicalSnapshot[]): boolean {
  const t = technicals.find((x) => x.symbol.toUpperCase() === symbol.toUpperCase());
  if (!t) return true;
  const macdOk = !t.macd || t.macd.histogram > 0;
  const emaOk = t.ema20 === undefined || t.ema50 === undefined || t.ema20 > t.ema50;
  return macdOk && emaOk;
}

/**
 * Re-entry cooldown: after a protective `risk_exit`, stand down from new deployments for
 * `reentryCooldownMinutes`. This is the anti-whipsaw guard — without it the offense re-enters
 * the same chop that just stopped us out, paying spread on every round trip. Reuses the
 * last-trade memory (no extra state), and only applies when the last trade was an exit.
 */
export function inReentryCooldown(state: AgentState, cfg: Config, now: Date = new Date()): boolean {
  if (state.lastTradeSource !== 'risk_exit' || !state.lastTradeAt) return false;
  const mins = (now.getTime() - new Date(state.lastTradeAt).getTime()) / 60_000;
  return Number.isFinite(mins) && mins < cfg.risk.reentryCooldownMinutes;
}

function bestMomentum(quotes: TokenQuote[], technicals: TechnicalSnapshot[], stableSymbol: string) {
  const techBySymbol = new Map(technicals.map((t) => [t.symbol.toUpperCase(), t]));
  return quotes
    .filter((q) => q.priceUsd > 0)
    .filter((q) => q.symbol.toUpperCase() !== stableSymbol.toUpperCase())
    .filter((q) => !isStable(q.symbol))
    .filter((q) => ALLOWLIST_SYMBOLS.has(q.symbol.toUpperCase()))
    .map((q) => {
      const pct24h = q.pctChange24h ?? 0;
      return { quote: q, pct24h, score: pct24h + technicalScore(techBySymbol.get(q.symbol.toUpperCase())) };
    })
    .sort((a, b) => b.score - a.score)[0];
}

export interface OpenPosition {
  symbol: string;
  valueUsd: number;
  priceUsd: number;
}

/** The single dominant volatile holding (above the dust line), priced from current quotes. */
export function findPosition(portfolio: PortfolioSnapshot, quotes: TokenQuote[], _cfg: Config): OpenPosition | null {
  const priceBySym = new Map(quotes.map((q) => [q.symbol.toUpperCase(), q.priceUsd]));
  const volatile = portfolio.holdings
    .filter((h) => !isStable(h.symbol) && h.valueUsd > 1)
    .sort((a, b) => b.valueUsd - a.valueUsd);
  const top = volatile[0];
  if (!top) return null;
  return { symbol: top.symbol, valueUsd: top.valueUsd, priceUsd: priceBySym.get(top.symbol.toUpperCase()) ?? 0 };
}

/**
 * Daily position-memory sync. Derived from the portfolio truth each cycle so it survives
 * restarts, paper/live differences, and externally-changed balances. Initializes entry/peak
 * on a freshly seen position and ratchets the peak up while it is held.
 */
export function syncPosition(state: AgentState, portfolio: PortfolioSnapshot, quotes: TokenQuote[], cfg: Config): AgentState {
  const pos = findPosition(portfolio, quotes, cfg);
  if (!pos) {
    if (!state.positionSymbol) return state;
    // Flat now — drop the position-memory fields entirely (exactOptionalPropertyTypes).
    const { positionSymbol, positionEntryPriceUsd, positionPeakPriceUsd, positionEntryAt, ...rest } = state;
    void positionSymbol; void positionEntryPriceUsd; void positionPeakPriceUsd; void positionEntryAt;
    return rest;
  }
  const price = pos.priceUsd > 0 ? pos.priceUsd : state.positionPeakPriceUsd ?? 0;
  if (state.positionSymbol !== pos.symbol) {
    return { ...state, positionSymbol: pos.symbol, positionEntryPriceUsd: price, positionPeakPriceUsd: price, positionEntryAt: new Date().toISOString() };
  }
  const peak = Math.max(state.positionPeakPriceUsd ?? price, price);
  return { ...state, positionPeakPriceUsd: peak };
}

/**
 * DEFENSE — deterministic protective exit. Returns a full flatten-to-stable of the held
 * position when a preservation trigger fires; otherwise null. Source `risk_exit` is
 * cooldown/min-hold/daily-cap exempt in the Sentinel (capital preservation must not wait).
 *
 * Two triggers only — deliberately NOT a fast oscillating signal:
 *  - regime flip to risk_off (macro de-risk);
 *  - trailing stop, which doubles as a hard stop-loss (peak starts at entry, so a position
 *    that falls trailingStopPct below entry exits) AND a profit-lock (the peak trails up).
 * A short-horizon MACD/EMA "trend break" was intentionally removed: it whipsawed against the
 * momentum entry signal in chop, dumping healthy positions on noise and bleeding spread.
 */
export function evaluateExit(
  cfg: Config,
  ctx: { regime: RegimeReading; quotes: TokenQuote[]; portfolio: PortfolioSnapshot; state: AgentState },
): TradeProposal | null {
  const stable = cfg.risk.stableSymbol;
  const pos = findPosition(ctx.portfolio, ctx.quotes, cfg);
  if (!pos || pos.symbol.toUpperCase() === stable.toUpperCase()) return null;

  const peak = ctx.state.positionPeakPriceUsd ?? pos.priceUsd;

  let reason: string | null = null;
  if (ctx.regime.regime === 'risk_off') {
    reason = `regime risk_off (score ${ctx.regime.score}): de-risk ${pos.symbol} to ${stable}`;
  } else if (pos.priceUsd > 0 && peak > 0 && pos.priceUsd <= peak * (1 - cfg.risk.trailingStopPct)) {
    const drop = ((peak - pos.priceUsd) / peak) * 100;
    reason = `trailing stop: ${pos.symbol} -${drop.toFixed(1)}% from peak (>${(cfg.risk.trailingStopPct * 100).toFixed(0)}%)`;
  }
  if (!reason) return null;

  return {
    kind: 'swap',
    fromSymbol: pos.symbol,
    toSymbol: stable,
    usdNotional: Number((pos.valueUsd * 0.98).toFixed(2)),
    rationale: reason,
    source: 'risk_exit',
  };
}

/**
 * Let-winners-run guard. Defense owns exits, so a discretionary LLM sell of the held
 * position to a stable is suppressed unless the regime is risk_off (where de-risking is
 * legitimate). Entries and volatile→volatile rotations pass through untouched.
 */
export function reconcileLlmProposal(
  proposal: TradeProposal | null,
  cfg: Config,
  ctx: { regime: RegimeReading; quotes: TokenQuote[]; portfolio: PortfolioSnapshot },
): TradeProposal | null {
  if (!proposal || proposal.source !== 'strategist_llm') return proposal;
  if (!isStable(proposal.toSymbol)) return proposal; // entry or rotation — allowed
  if (ctx.regime.regime === 'risk_off') return proposal; // legitimate de-risk
  const pos = findPosition(ctx.portfolio, ctx.quotes, cfg);
  if (pos && proposal.fromSymbol.toUpperCase() === pos.symbol.toUpperCase()) return null; // hold the winner
  return proposal;
}

/**
 * OFFENSE fallback — deterministic target-allocation. Runs only when the LLM holds/errors.
 * Position-aware so it never fights an existing holding: it holds winners, scales toward the
 * volatile target in constructive regimes, and rotates only on a materially stronger leader.
 * Sentinel still validates every proposal before any quote/signing.
 */
export function rulesFallbackPropose(
  cfg: Config,
  ctx: {
    regime: RegimeReading;
    quotes: TokenQuote[];
    technicals: TechnicalSnapshot[];
    portfolio: PortfolioSnapshot;
  },
): TradeProposal | null {
  const stable = cfg.risk.stableSymbol;
  const equity = ctx.portfolio.totalUsd;
  if (equity < cfg.risk.minPortfolioUsd) return null;
  if (ctx.regime.regime === 'risk_off') return null; // defense de-risks; offense stays out

  const candidate = bestMomentum(ctx.quotes, ctx.technicals, stable);
  if (!candidate) return null;

  // Entry quality gate, slightly stricter in neutral than risk_on; require a confirmed uptrend.
  const minScore = ctx.regime.regime === 'risk_on' ? 3 : 5;
  const min24h = ctx.regime.regime === 'risk_on' ? 1 : 2;
  const candidatePasses =
    candidate.pct24h >= min24h && candidate.score >= minScore && trendConfirmed(candidate.quote.symbol, ctx.technicals);

  const perTradeCap = equity * cfg.risk.maxTradePctOfEquity;
  const stableUsd = heldUsd(ctx.portfolio, stable);
  const currentVolatileUsd = volatileUsd(ctx.portfolio);
  const targetVolatileUsd = equity * cfg.risk.maxVolatilePctOfEquity;
  const minTradeUsd = Math.max(5, Math.min(25, equity * 0.05));
  const pos = findPosition(ctx.portfolio, ctx.quotes, cfg);

  // --- Holding a volatile position already ---
  if (pos) {
    const heldScore = scoreFor(pos.symbol, ctx.quotes, ctx.technicals);
    // Rotate only when a *different* leader is materially stronger (covers the round-trip cost).
    if (
      candidate.quote.symbol.toUpperCase() !== pos.symbol.toUpperCase() &&
      candidatePasses &&
      candidate.score - heldScore > cfg.risk.switchMarginScore
    ) {
      const notional = Math.min(perTradeCap, pos.valueUsd * 0.98);
      if (notional >= minTradeUsd) {
        return {
          kind: 'swap',
          fromSymbol: pos.symbol,
          toSymbol: candidate.quote.symbol,
          usdNotional: Number(notional.toFixed(2)),
          rationale: `rotate ${pos.symbol}->${candidate.quote.symbol}: score edge ${(candidate.score - heldScore).toFixed(2)} > switch margin ${cfg.risk.switchMarginScore}`,
          source: 'rules',
        };
      }
    }
    // Scale into the held winner toward the volatile target while it still rates a hold
    // and its trend is still confirmed.
    if (heldScore >= minScore && trendConfirmed(pos.symbol, ctx.technicals) && currentVolatileUsd < targetVolatileUsd && stableUsd > minTradeUsd) {
      const notional = Math.min(perTradeCap, targetVolatileUsd - currentVolatileUsd, stableUsd * 0.98);
      if (notional >= minTradeUsd) {
        return {
          kind: 'swap',
          fromSymbol: stable,
          toSymbol: pos.symbol,
          usdNotional: Number(notional.toFixed(2)),
          rationale: `scale into held leader ${pos.symbol} toward ${(cfg.risk.maxVolatilePctOfEquity * 100).toFixed(0)}% volatile target (score ${heldScore.toFixed(2)})`,
          source: 'rules',
        };
      }
    }
    return null; // hold
  }

  // --- Flat (stables only): open a position in the leader if it clears the gate ---
  if (!candidatePasses || stableUsd < minTradeUsd || currentVolatileUsd >= targetVolatileUsd) return null;
  const notional = Math.min(perTradeCap, targetVolatileUsd - currentVolatileUsd, stableUsd * 0.98);
  if (notional < minTradeUsd) return null;

  return {
    kind: 'swap',
    fromSymbol: stable,
    toSymbol: candidate.quote.symbol,
    usdNotional: Number(notional.toFixed(2)),
    rationale: `${ctx.regime.regime} entry into strongest confirmed momentum ${candidate.quote.symbol} (24h ${candidate.pct24h.toFixed(2)}%, score ${candidate.score.toFixed(2)})`,
    source: 'rules',
  };
}
