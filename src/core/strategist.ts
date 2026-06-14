import { z } from 'zod';
import type { Config } from '../config.js';
import type { GlobalSnapshot, PortfolioSnapshot, RegimeReading, TechnicalSnapshot, TokenQuote, TradeProposal } from './types.js';
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
Hard facts you must respect (violations are discarded by a deterministic Sentinel, wasting the cycle):
- You may only propose swaps between symbols in the provided allowlist.
- Spot only. No leverage, no perps, no shorting. You may READ derivatives data as sentiment.
- Keep proposals consistent with the provided regime. risk_off => rotate toward stables. risk_on => momentum rotation.
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
  },
): Promise<TradeProposal | null> {
  const allow = [...COMPETITION_ALLOWLIST].slice(0, 149).join(', ');
  const user = [
    `Regime: ${ctx.regime.regime} (score ${ctx.regime.score}) inputs=${JSON.stringify(ctx.regime.inputs)}`,
    `Holdings: ${ctx.holdingsSummary}`,
    `Quotes: ${JSON.stringify(ctx.quotes)}`,
    `Technicals: ${JSON.stringify(ctx.technicals)}`,
    `Allowlist: ${allow}`,
    `Propose at most one swap, or hold.`,
  ].join('\n');

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

// ---------- Deterministic active fallback ----------

const STABLES = new Set(['USDT', 'USDC', 'DAI', 'TUSD', 'FDUSD', 'USD1', 'USDE', 'USDD', 'FRAX', 'LISUSD', 'USDF', 'FRXUSD']);
const ALLOWLIST_SYMBOLS = new Set([...COMPETITION_ALLOWLIST].map((s) => s.toUpperCase()));

function heldUsd(portfolio: PortfolioSnapshot, symbol: string): number {
  return portfolio.holdings.find((h) => h.symbol.toUpperCase() === symbol.toUpperCase())?.valueUsd ?? 0;
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

function bestMomentum(quotes: TokenQuote[], technicals: TechnicalSnapshot[], stableSymbol: string) {
  const techBySymbol = new Map(technicals.map((t) => [t.symbol.toUpperCase(), t]));
  return quotes
    .filter((q) => q.priceUsd > 0)
    .filter((q) => q.symbol.toUpperCase() !== stableSymbol.toUpperCase())
    .filter((q) => !STABLES.has(q.symbol.toUpperCase()))
    .filter((q) => ALLOWLIST_SYMBOLS.has(q.symbol.toUpperCase()))
    .map((q) => {
      const pct24h = q.pctChange24h ?? 0;
      return {
        quote: q,
        pct24h,
        score: pct24h + technicalScore(techBySymbol.get(q.symbol.toUpperCase())),
      };
    })
    .sort((a, b) => b.score - a.score)[0];
}

/**
 * Conservative rules fallback for the competition profile. It only runs after the LLM
 * declines to trade, so paper/live mode keeps moving without making the model the only
 * source of initiative. Sentinel still validates every proposal before any quote/signing.
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
  const stableUsd = heldUsd(ctx.portfolio, stable);
  const candidate = bestMomentum(ctx.quotes, ctx.technicals, stable);
  if (!candidate || stableUsd < 1 || equity < cfg.risk.minPortfolioUsd) return null;

  const perTradeCap = equity * cfg.risk.maxTradePctOfEquity;
  let fractionOfCap: number;
  let minScore: number;
  let reason: string;

  if (ctx.regime.regime === 'risk_on') {
    fractionOfCap = 0.8;
    minScore = -2;
    reason = 'risk-on fallback: deploy spot capital into strongest allowlist momentum';
  } else if (ctx.regime.regime === 'neutral') {
    fractionOfCap = 0.45;
    minScore = 1;
    reason = 'neutral fallback: small spot rotation into strongest allowlist momentum';
  } else {
    fractionOfCap = 0.3;
    minScore = 0;
    reason = 'risk-off fallback: tiny probe only into relative-strength allowlist token';
  }

  if (candidate.score < minScore) return null;
  const notional = Math.min(perTradeCap * fractionOfCap, stableUsd * 0.98);
  if (notional < 1) return null;

  return {
    kind: 'swap',
    fromSymbol: stable,
    toSymbol: candidate.quote.symbol,
    usdNotional: Number(notional.toFixed(2)),
    rationale: `${reason}; picked ${candidate.quote.symbol} (24h ${candidate.pct24h.toFixed(2)}%, score ${candidate.score.toFixed(2)})`,
    source: 'rules',
  };
}
