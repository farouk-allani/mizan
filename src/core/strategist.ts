import { z } from 'zod';
import type { Config } from '../config.js';
import type { GlobalSnapshot, RegimeReading, TechnicalSnapshot, TokenQuote, TradeProposal } from './types.js';
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
