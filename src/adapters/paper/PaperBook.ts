import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Holding, PortfolioSnapshot } from '../../core/types.js';
import type { MarketDataProvider, PortfolioReader } from '../../ports/index.js';

/**
 * Paper-trading portfolio simulator.
 *
 * In paper mode this REPLACES the real-wallet reader, so the entire loop — trade sizing,
 * daily caps, cooldown, and the drawdown breaker — runs on a *simulated* portfolio that
 * actually moves. It is seeded once (from the real wallet, so PnL reflects real capital),
 * applies each paper fill at the quoted rate (which already embeds DEX price impact), and
 * marks holdings to market via CMC each cycle to produce equity + PnL. The real wallet is
 * never touched.
 *
 * Honesty note: mark-to-market uses CMC mid prices, so it ignores sell-side slippage —
 * paper PnL is indicative, not a guarantee of live fills.
 */

/** In-scope stables valued at $1 for mark-to-market. */
const STABLE_USD = new Set([
  'USDT', 'USDC', 'DAI', 'TUSD', 'FDUSD', 'USD1', 'USDe', 'USDD', 'FRAX', 'lisUSD', 'USDf', 'FRXUSD',
]);

function parseAmount(s: string | undefined): number {
  if (!s) return 0;
  const m = String(s).trim().match(/-?\d*\.?\d+/);
  return m ? Number(m[0]) : 0;
}

interface PaperState {
  holdings: Record<string, number>; // symbol -> amount
  startEquityUsd: number;
  fills: number;
  startedAt: string;
}

export class PaperBook implements PortfolioReader {
  private state: PaperState;

  constructor(
    private readonly path: string,
    private readonly data: MarketDataProvider,
  ) {
    this.state = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as PaperState)
      : { holdings: {}, startEquityUsd: 0, fills: 0, startedAt: new Date().toISOString() };
  }

  get seeded(): boolean {
    return Object.keys(this.state.holdings).length > 0;
  }

  get startEquityUsd(): number {
    return this.state.startEquityUsd;
  }

  /** Seed the virtual book from a real-wallet snapshot (first paper run only). Start equity
   *  is computed via the SAME mark-to-market path as ongoing equity, so PnL starts at 0%. */
  async seed(holdings: Holding[]): Promise<void> {
    this.state.holdings = {};
    for (const h of holdings) this.state.holdings[h.symbol] = (this.state.holdings[h.symbol] ?? 0) + h.amount;
    const snap = await this.snapshot();
    this.state.startEquityUsd = snap.totalUsd;
    this.state.startedAt = new Date().toISOString();
    this.persist();
  }

  private nonStableSymbols(): string[] {
    return Object.keys(this.state.holdings).filter((s) => !STABLE_USD.has(s) && (this.state.holdings[s] ?? 0) > 1e-9);
  }

  /** Mark the virtual holdings to market via CMC → the snapshot the loop consumes. */
  async snapshot(): Promise<PortfolioSnapshot> {
    const syms = this.nonStableSymbols();
    const quotes = syms.length ? await this.data.quotes(syms) : [];
    const priceBySym = new Map(quotes.map((q) => [q.symbol, q.priceUsd]));
    const priceOf = (sym: string): number => (STABLE_USD.has(sym) ? 1 : priceBySym.get(sym) ?? 0);

    const holdings: Holding[] = Object.entries(this.state.holdings)
      .filter(([, amt]) => Math.abs(amt) > 1e-9)
      .map(([symbol, amount]) => ({ symbol, amount, valueUsd: amount * priceOf(symbol) }));
    const totalUsd = holdings.reduce((s, h) => s + h.valueUsd, 0);
    return { totalUsd, holdings, asOf: new Date().toISOString() };
  }

  /** Apply a paper fill at the quoted rate. `inputStr`/`outputStr` are twak quote strings. */
  applyFill(fromSymbol: string, inputStr: string | undefined, toSymbol: string, outputStr: string | undefined): void {
    const fromAmt = parseAmount(inputStr);
    const toAmt = parseAmount(outputStr);
    if (fromAmt <= 0 || toAmt <= 0) return;
    this.state.holdings[fromSymbol] = (this.state.holdings[fromSymbol] ?? 0) - fromAmt;
    this.state.holdings[toSymbol] = (this.state.holdings[toSymbol] ?? 0) + toAmt;
    if ((this.state.holdings[fromSymbol] ?? 0) < 1e-9) delete this.state.holdings[fromSymbol];
    this.state.fills += 1;
    this.persist();
  }

  /** Percentage return vs the seeded starting equity. */
  pnlPct(currentEquityUsd: number): number {
    if (this.state.startEquityUsd <= 0) return 0;
    return ((currentEquityUsd - this.state.startEquityUsd) / this.state.startEquityUsd) * 100;
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.state, null, 2));
  }
}
