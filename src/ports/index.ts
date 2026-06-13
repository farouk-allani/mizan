import type {
  ExecutionResult,
  GlobalSnapshot,
  PortfolioSnapshot,
  TechnicalSnapshot,
  TokenQuote,
  TradeProposal,
  VenueKind,
} from '../core/types.js';

/**
 * Execution port. TwakSpotVenue is the only shipped implementation.
 * A perps venue COULD implement this same port — but config refuses to enable
 * it while compliance.halalMode is true (see config.ts superRefine).
 */
export interface ExecutionVenue {
  readonly kind: VenueKind;
  readonly name: string;
  /** Quote without signing anything. */
  quote(p: TradeProposal): Promise<ExecutionResult>;
  /** Sign + broadcast. Only the orchestrator calls this, only after a Sentinel approval. */
  execute(p: TradeProposal, opts: { slippagePct: number }): Promise<ExecutionResult>;
}

export interface PortfolioReader {
  snapshot(): Promise<PortfolioSnapshot>;
}

export interface MarketDataProvider {
  readonly name: string;
  quotes(symbols: string[]): Promise<TokenQuote[]>;
  technicals(symbol: string): Promise<TechnicalSnapshot>;
  global(): Promise<GlobalSnapshot>;
}

export interface LlmClient {
  /** Returns raw assistant text; caller parses/validates. */
  complete(system: string, user: string): Promise<string>;
}

export interface Notifier {
  send(text: string): Promise<void>;
}
