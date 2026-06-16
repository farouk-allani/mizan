import type { Config } from '../config.js';
import type { AgentState, PortfolioSnapshot, SentinelVerdict, TradeProposal } from './types.js';
import { tradableIdentifier } from '../tokens/allowlist.js';

/**
 * The Sentinel.
 *
 * Pure, deterministic, dependency-free validation of every trade proposal.
 * The LLM strategist PROPOSES; the Sentinel DISPOSES. There is no code path
 * from model output to `venue.execute()` that does not pass through here,
 * and nothing the model emits can alter these rules — they live in config,
 * loaded before the model ever runs.
 *
 * Rules enforced (each maps to the hackathon's guardrail criterion):
 *  1. Allowlist        — both legs in the 149-token competition list
 *  2. Ambiguity        — collision-prone symbols require pinned contracts
 *  3. Per-trade cap    — notional <= maxTradePctOfEquity * equity (clamped, not rejected)
 *  4. Daily trade cap  — maxTradesPerDay (breaker & risk_exit exempt)
 *  5. Daily notional   — maxDailyNotionalPctOfEquity * equity (breaker & risk_exit exempt)
 *  6. Cooldown         — minimum minutes between trades (heartbeat, breaker & risk_exit exempt)
 *  7. Min hold window  — blocks rapid reversal of the last pair (breaker & risk_exit exempt)
 *  8. Drawdown breaker — equity below HWM*(1-maxDrawdownPct) => only flatten allowed
 *  9. Dust floor       — post-trade portfolio must stay above minPortfolioUsd
 * 10. Self-swap        — from != to
 * 11. Positive notional
 */
export function sentinelValidate(
  proposal: TradeProposal,
  portfolio: PortfolioSnapshot,
  state: AgentState,
  cfg: Config,
  now: Date = new Date(),
): SentinelVerdict {
  const reasons: string[] = [];
  const equity = portfolio.totalUsd;
  const isBreakerFlatten = proposal.source === 'circuit_breaker';
  const isHeartbeat = proposal.source === 'heartbeat';
  // A deterministic protective exit (trailing stop / trend break / risk_off de-risk) preserves
  // capital, so it is exempt from the anti-churn timers and daily caps — like the breaker.
  const exitExempt = isBreakerFlatten || proposal.source === 'risk_exit';
  const minsSinceLastTrade = state.lastTradeAt ? (now.getTime() - new Date(state.lastTradeAt).getTime()) / 60_000 : undefined;

  // 11. sanity
  if (!(proposal.usdNotional > 0)) reasons.push('notional must be > 0');
  // 10. self-swap
  if (proposal.fromSymbol === proposal.toSymbol) reasons.push('from == to');

  // 1 + 2. allowlist & ambiguity (both legs)
  for (const leg of [proposal.fromSymbol, proposal.toSymbol]) {
    const t = tradableIdentifier(leg);
    if (!t.ok) reasons.push(t.reason);
  }

  // 8. drawdown circuit breaker
  const drawdown = state.equityHighWaterUsd > 0 ? 1 - equity / state.equityHighWaterUsd : 0;
  const breakerActive = drawdown >= cfg.risk.maxDrawdownPct || !!state.circuitBreakerTrippedAt || !!state.hardStopped;
  if (breakerActive && !isBreakerFlatten) {
    reasons.push(
      `circuit breaker active (drawdown ${(drawdown * 100).toFixed(1)}% >= ${(cfg.risk.maxDrawdownPct * 100).toFixed(0)}%) — only flatten-to-${cfg.risk.stableSymbol} permitted`,
    );
  }

  // 4. daily trade count (breaker flatten & protective exit always allowed)
  if (!exitExempt && state.tradesToday >= cfg.risk.maxTradesPerDay) {
    reasons.push(`daily trade cap reached (${state.tradesToday}/${cfg.risk.maxTradesPerDay})`);
  }

  // 6. cooldown (heartbeat, breaker & protective exit exempt)
  if (!exitExempt && !isHeartbeat && minsSinceLastTrade !== undefined && Number.isFinite(minsSinceLastTrade)) {
    if (minsSinceLastTrade < cfg.risk.cooldownMinutes) {
      reasons.push(`cooldown: ${minsSinceLastTrade.toFixed(0)}m since last trade < ${cfg.risk.cooldownMinutes}m`);
    }
  }

  // 7. minimum hold window: prevent fee-burning stable<->alt round trips.
  if (
    !exitExempt &&
    minsSinceLastTrade !== undefined &&
    Number.isFinite(minsSinceLastTrade) &&
    state.lastTradeFromSymbol &&
    state.lastTradeToSymbol &&
    proposal.fromSymbol.toUpperCase() === state.lastTradeToSymbol.toUpperCase() &&
    proposal.toSymbol.toUpperCase() === state.lastTradeFromSymbol.toUpperCase() &&
    minsSinceLastTrade < cfg.risk.minHoldMinutes
  ) {
    reasons.push(
      `minimum hold: ${minsSinceLastTrade.toFixed(0)}m since ${state.lastTradeFromSymbol}->${state.lastTradeToSymbol} < ${cfg.risk.minHoldMinutes}m`,
    );
  }

  // 3. per-trade cap — clamp rather than reject
  const perTradeCapUsd = equity * cfg.risk.maxTradePctOfEquity;
  let effectiveNotional = Math.min(proposal.usdNotional, perTradeCapUsd);

  // 5. daily notional cap
  const dailyCapUsd = equity * cfg.risk.maxDailyNotionalPctOfEquity;
  const remainingToday = Math.max(0, dailyCapUsd - state.notionalTodayUsd);
  if (!exitExempt) {
    if (remainingToday <= 0) {
      reasons.push(`daily notional cap exhausted (${state.notionalTodayUsd.toFixed(0)}/${dailyCapUsd.toFixed(0)} USD)`);
    }
    effectiveNotional = Math.min(effectiveNotional, remainingToday);
  }

  // 9. dust floor — a full-balance swap that fails partially must never strand us near $1
  if (equity - 0 < cfg.risk.minPortfolioUsd) {
    reasons.push(`portfolio ${equity.toFixed(2)} USD below safety floor ${cfg.risk.minPortfolioUsd} USD`);
  }

  // source-of-funds: do we actually hold enough of fromSymbol?
  const held = portfolio.holdings.find((h) => h.symbol === proposal.fromSymbol)?.valueUsd ?? 0;
  if (held < effectiveNotional) {
    // clamp to 98% of holding to leave dust/fee margin; reject if still meaningless
    effectiveNotional = Math.min(effectiveNotional, held * 0.98);
    if (effectiveNotional < 1) reasons.push(`insufficient ${proposal.fromSymbol} (held ~$${held.toFixed(2)})`);
  }

  if (reasons.length > 0) return { approved: false, reasons };

  return {
    approved: true,
    reasons: ['all sentinel rules passed'],
    effective: { ...proposal, usdNotional: Number(effectiveNotional.toFixed(2)) },
  };
}

/**
 * Daily state rollover + equity/HWM accounting + soft-breaker re-arm. Call once per cycle.
 *
 * Two equity references are maintained:
 *  - `equityPeakAllTimeUsd` ratchets up forever — the immovable hard-stop reference.
 *  - `equityHighWaterUsd` is the *soft* breaker reference; it is rebased to current equity
 *    when the soft breaker re-arms, so the 18% trigger measures from each fresh start.
 * A tripped soft breaker re-arms after `breakerRearmHours` (unless hard-stopped), clearing
 * the trip and rebasing the soft reference so the agent can redeploy.
 */
export function rollState(state: AgentState, equityUsd: number, cfg: Config, now: Date = new Date()): AgentState {
  const dayKey = now.toISOString().slice(0, 10);
  const next: AgentState = { ...state };
  if (state.dayKey !== dayKey) {
    next.dayKey = dayKey;
    next.tradesToday = 0;
    next.notionalTodayUsd = 0;
  }
  next.lastEquityUsd = equityUsd;

  // All-time peak — never rebased; the hard-stop measures cumulative drawdown against this.
  next.equityPeakAllTimeUsd = Math.max(state.equityPeakAllTimeUsd ?? 0, state.equityHighWaterUsd ?? 0, equityUsd);

  // Soft-breaker re-arm: after the cooldown, clear the trip and rebase the soft reference.
  if (next.circuitBreakerTrippedAt && !next.hardStopped) {
    const hrs = (now.getTime() - new Date(next.circuitBreakerTrippedAt).getTime()) / 3_600_000;
    if (Number.isFinite(hrs) && hrs >= cfg.risk.breakerRearmHours) {
      delete next.circuitBreakerTrippedAt;
      next.flattened = false;
      next.equityHighWaterUsd = equityUsd; // rebase soft reference; all-time peak still guards the gate
      return next;
    }
  }

  if (equityUsd > next.equityHighWaterUsd) next.equityHighWaterUsd = equityUsd;
  return next;
}
