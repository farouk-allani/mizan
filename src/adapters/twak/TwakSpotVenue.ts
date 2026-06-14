import type { Config } from '../../config.js';
import type { ExecutionResult, PortfolioSnapshot, TradeProposal } from '../../core/types.js';
import type { ExecutionVenue, PortfolioReader } from '../../ports/index.js';
import { COMPETITION_ALLOWLIST, tradableIdentifier } from '../../tokens/allowlist.js';
import { TwakCli, TwakError, type SwapExecOut, type SwapQuoteOut } from './cli.js';

/**
 * TwakSpotVenue — the ONLY execution layer in MIZAN.
 *
 * Self-custody integrity story (TWAK prize, 25 pts):
 *  - Keys live in twak's local BIP39 keystore (~/.twak/wallet.json); signing is
 *    on-device. MIZAN never sees, stores, or transmits a private key.
 *  - The wallet password reaches twak only via TWAK_WALLET_PASSWORD / OS
 *    keychain — never argv.
 *  - There is no custodial fallback path anywhere in this codebase.
 */
export class TwakSpotVenue implements ExecutionVenue {
  readonly kind = 'spot' as const;
  readonly name = 'twak-spot-bsc';

  constructor(
    private readonly cli: TwakCli,
    private readonly cfg: Config,
  ) {}

  private legs(p: TradeProposal): { from: string; to: string } {
    const from = tradableIdentifier(p.fromSymbol);
    const to = tradableIdentifier(p.toSymbol);
    if (!from.ok) throw new TwakError(from.reason, 'VALIDATION_ERROR');
    if (!to.ok) throw new TwakError(to.reason, 'VALIDATION_ERROR');
    return { from: from.id, to: to.id };
  }

  async quote(p: TradeProposal): Promise<ExecutionResult> {
    try {
      const { from, to } = this.legs(p);
      const q = await this.cli.run<SwapQuoteOut>([
        'swap', from, to,
        '--chain', this.cfg.chain,
        '--usd', String(p.usdNotional),
        '--quote-only',
      ]);
      return { ok: true, quote: { input: q.input, output: q.output, provider: q.provider, priceImpact: q.priceImpact } };
    } catch (e) {
      const err = e as TwakError;
      return { ok: false, errorCode: err.errorCode, error: err.message };
    }
  }

  async execute(p: TradeProposal, opts: { slippagePct: number }): Promise<ExecutionResult> {
    try {
      const { from, to } = this.legs(p);
      const r = await this.cli.run<SwapExecOut>([
        'swap', from, to,
        '--chain', this.cfg.chain,
        '--usd', String(p.usdNotional),
        '--slippage', String(opts.slippagePct),
      ]);
      return {
        ok: true,
        txHash: r.hash,
        explorerUrl: r.explorer,
        quote: { input: r.input, output: r.output, provider: r.provider, priceImpact: r.priceImpact },
      };
    } catch (e) {
      const err = e as TwakError;
      return { ok: false, errorCode: err.errorCode, error: err.message };
    }
  }
}

/**
 * Portfolio via twak. Pinned against the live `twak wallet portfolio --json` (2026-06-13):
 * the CLI returns a FLAT ARRAY of per-chain rows, not an object —
 *   { chain, type: 'native'|'token', symbol, address, balance: "100", usdValue, contract? }
 * spanning ~24 chains. We keep BSC token balances only (MIZAN trades and is scored on BSC)
 * and exclude the native BNB gas reserve, which is not an in-scope asset and must never be
 * flattened to USDT by the circuit breaker. Object shapes are tolerated as a fallback.
 */
export class TwakPortfolioReader implements PortfolioReader {
  constructor(private readonly cli: TwakCli) {}

  async snapshot(): Promise<PortfolioSnapshot> {
    const raw = await this.cli.run<unknown>(['wallet', 'portfolio']);
    const asOf = new Date().toISOString();

    const obj = raw as Record<string, unknown>;
    const rowsRaw: unknown[] = Array.isArray(raw)
      ? raw
      : (obj?.holdings as unknown[]) ?? (obj?.tokens as unknown[]) ?? (obj?.assets as unknown[]) ?? [];

    const holdings = rowsRaw
      .map((h) => h as Record<string, unknown>)
      .filter((o) => String(o.chain ?? 'bsc').toLowerCase() === 'bsc' && String(o.type ?? 'token') !== 'native')
      .map((o) => ({
        symbol: String(o.symbol ?? o.token ?? ''),
        amount: Number(o.balance ?? o.amount ?? 0),
        valueUsd: Number(o.usdValue ?? o.valueUsd ?? o.value ?? 0),
      }))
      // Count ONLY competition-eligible assets toward equity. A priced scam-airdrop on BSC
      // would otherwise inflate equity and distort the per-trade cap, daily cap, and the
      // drawdown breaker. This also keeps internal equity aligned with the scored portfolio.
      .filter((h) => h.symbol && COMPETITION_ALLOWLIST.has(h.symbol));

    const totalUsd = holdings.reduce((s, h) => s + h.valueUsd, 0);
    return { totalUsd, holdings, asOf };
  }
}
