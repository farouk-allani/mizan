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
  /** Which subsystem proposed it. */
  source: 'strategist_llm' | 'rules' | 'heartbeat' | 'circuit_breaker';
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
    | 'error'
    | 'x402_payment';
  payload: unknown;
  /** Hash-chain: sha256 of (prevHash + canonical(payload)). Tamper-evident audit trail. */
  prevHash: string;
  hash: string;
}

export interface AgentState {
  /** High-water mark of portfolio equity, used for drawdown computation. */
  equityHighWaterUsd: number;
  lastEquityUsd: number;
  tradesToday: number;
  notionalTodayUsd: number;
  dayKey: string; // YYYY-MM-DD (UTC)
  lastTradeAt?: string;
  circuitBreakerTrippedAt?: string;
  flattened: boolean;
}
