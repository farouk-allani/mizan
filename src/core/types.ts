/**
 * MIZAN — core domain types.
 * Everything flows through these. Adapters translate the outside world
 * (twak CLI, CMC MCP, LLM endpoints) into these shapes and back.
 */

// ---------- Market & portfolio ----------

export interface TokenQuote {
  symbol: string;
  priceUsd: number;
  pctChange24h?: number;
  volume24h?: number;
  marketCap?: number;
  asOf: string; // ISO timestamp
}

export interface TechnicalSnapshot {
  symbol: string;
  rsi14?: number;
  macd?: { value: number; signal: number; histogram: number };
  ema20?: number;
  ema50?: number;
  asOf: string;
}

export interface GlobalSnapshot {
  fearGreed?: number; // 0..100
  btcDominance?: number;
  altcoinSeason?: number;
  /** Aggregate derivatives positioning — used as a *signal only*, never traded. */
  derivatives?: { aggOpenInterestUsd?: number; avgFundingRate?: number };
  asOf: string;
}

export interface Holding {
  symbol: string;
  amount: number;
  valueUsd: number;
}

export interface PortfolioSnapshot {
  totalUsd: number;
  holdings: Holding[];
  asOf: string;
}

// ---------- Regime & proposals ----------

export type Regime = 'risk_on' | 'neutral' | 'risk_off';

export interface RegimeReading {
  regime: Regime;
  score: number; // -1..1, deterministic composite
  inputs: Record<string, number | string>;
  asOf: string;
}

/** What the Strategist (LLM or rules) is allowed to ask for. Nothing else exists. */
export interface TradeProposal {
  kind: 'swap';
  fromSymbol: string;
  toSymbol: string;
  /** USD notional of the source leg. Sentinel re-caps this regardless. */
  usdNotional: number;
  /** Free-text rationale — goes to the audit ledger and Telegram, never to execution. */
  rationale: string;
  /**
   * Which subsystem proposed it.
   * - `risk_exit` is a DETERMINISTIC protective exit (trailing stop / trend break / regime
   *   flip to risk_off). Like the breaker it owns capital preservation, so the Sentinel
   *   exempts it from the anti-churn timers (cooldown, min-hold) and the daily trade cap.
   */
  source: 'strategist_llm' | 'rules' | 'heartbeat' | 'circuit_breaker' | 'risk_exit' | 'contrarian';
}

export interface SentinelVerdict {
  approved: boolean;
  reasons: string[];
  /** Possibly clamped version of the proposal (e.g. notional reduced to cap). */
  effective?: TradeProposal;
}

// ---------- Execution ----------

export type VenueKind = 'spot' | 'perps';

export interface ExecutionResult {
  ok: boolean;
  txHash?: string;
  explorerUrl?: string;
  errorCode?: string;
  error?: string;
  quote?: { input: string; output: string; provider?: string; priceImpact?: string };
}

// ---------- Audit ----------

export interface LedgerEntry {
  ts: string;
  type:
    | 'cycle_start'
    | 'data'
    | 'regime'
    | 'proposal'
    | 'verdict'
    | 'execution'
    | 'circuit_breaker'
    | 'heartbeat'
    | 'rules_fallback'
    | 'error'
    | 'x402_payment'
    | 'automation';
  payload: unknown;
  /** Hash-chain: sha256 of (prevHash + canonical(payload)). Tamper-evident audit trail. */
  prevHash: string;
  hash: string;
}

export interface AgentState {
  /**
   * High-water mark for the *soft* (re-armable) breaker. Rebased to current equity when the
   * breaker re-arms, so the 18% soft trigger measures from each fresh start.
   */
  equityHighWaterUsd: number;
  /**
   * All-time equity peak — the immovable reference for the permanent hard-stop. Never
   * rebased, so repeated soft re-arms can never quietly stack past the disqualification gate.
   */
  equityPeakAllTimeUsd?: number;
  /** Set once the permanent hard-stop engages; the agent never re-risks for the rest of the run. */
  hardStopped?: boolean;
  lastEquityUsd: number;
  tradesToday: number;
  notionalTodayUsd: number;
  dayKey: string; // YYYY-MM-DD (UTC)
  lastTradeAt?: string;
  lastTradeFromSymbol?: string;
  lastTradeToSymbol?: string;
  lastTradeSource?: TradeProposal['source'];
  circuitBreakerTrippedAt?: string;
  flattened: boolean;
  /**
   * Open-position memory for the let-winners-run engine. Tracks the single dominant
   * volatile holding so the strategy can hold it, scale into it, and trail-stop it.
   * Derived from the portfolio each cycle (see `syncPosition`), not hand-maintained.
   */
  positionSymbol?: string;
  /** Mark price when the position was first observed (cost-basis proxy). */
  positionEntryPriceUsd?: number;
  /** Highest mark price seen since entry — the trailing-stop reference. */
  positionPeakPriceUsd?: number;
  positionEntryAt?: string;
}
