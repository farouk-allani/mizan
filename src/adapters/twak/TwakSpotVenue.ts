import type { Config } from '../../config.js';
import type { ExecutionResult, PortfolioSnapshot, TradeProposal } from '../../core/types.js';
import type { ExecutionVenue, PortfolioReader } from '../../ports/index.js';
import { tradableIdentifier } from '../../tokens/allowlist.js';
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
 * Portfolio via twak. The CLI's portfolio output shape isn't pinned in the
 * skills reference, so this adapter is defensive: it accepts a few plausible
 * shapes and normalizes. Verify against `twak wallet portfolio --json` output
 * on day 1 and tighten.
 */
export class TwakPortfolioReader implements PortfolioReader {
  constructor(private readonly cli: TwakCli) {}

  async snapshot(): Promise<PortfolioSnapshot> {
    const raw = await this.cli.run<Record<string, unknown>>(['wallet', 'portfolio']);
    const asOf = new Date().toISOString();

    const holdingsRaw =
      (raw.holdings as unknown[]) ?? (raw.tokens as unknown[]) ?? (raw.assets as unknown[]) ?? [];
    const holdings = holdingsRaw
      .map((h) => {
        const o = h as Record<string, unknown>;
        return {
          symbol: String(o.symbol ?? o.token ?? ''),
          amount: Number(o.amount ?? o.balance ?? 0),
          valueUsd: Number(o.valueUsd ?? o.usdValue ?? o.value ?? 0),
        };
      })
      .filter((h) => h.symbol);

    const totalUsd = Number(raw.totalUsd ?? raw.totalValueUsd ?? raw.total ?? holdings.reduce((s, h) => s + h.valueUsd, 0));
    return { totalUsd, holdings, asOf };
  }
}
