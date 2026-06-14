import type { Config } from '../../config.js';
import type { Ledger } from '../../core/ledger.js';
import { TwakCli } from './cli.js';
import { tradableIdentifier } from '../../tokens/allowlist.js';

/**
 * Daily DCA "heartbeat" via the REAL `twak automate` surface — a genuine autonomous
 * twak execution surface (TWAK prize: depth across signing + swap + x402 + compete +
 * automate), not an in-process scheduler. The automation is created once (idempotent)
 * and executed by `twak watch` running alongside MIZAN on the VPS. The in-loop heartbeat
 * in index.ts stays as a backstop for the ≥1-trade/day rule if the automation hasn't run.
 *
 * LIVE only: automations execute real swaps. MIZAN never creates one in paper mode.
 */
export class TwakAutomation {
  constructor(
    private readonly cli: TwakCli,
    private readonly cfg: Config,
    private readonly ledger: Ledger,
  ) {}

  async list(): Promise<Array<Record<string, unknown>>> {
    try {
      const out = await this.cli.run<unknown>(['automate', 'list']);
      if (Array.isArray(out)) return out as Array<Record<string, unknown>>;
      const inner = (out as Record<string, unknown>)?.automations;
      return Array.isArray(inner) ? (inner as Array<Record<string, unknown>>) : [];
    } catch {
      return [];
    }
  }

  /**
   * Create the daily DCA heartbeat if none exists yet. Idempotent: MIZAN is the only
   * creator of automations on this wallet, so a non-empty list means it already exists —
   * we skip to avoid duplicate daily trades on restart. Returns the automation id (if any).
   */
  async ensureDailyHeartbeat(opts: { expires: string }): Promise<string | null> {
    const to = tradableIdentifier(this.cfg.heartbeat.toSymbol);
    if (!to.ok) {
      this.ledger.append('error', { where: 'automation', reason: to.reason });
      return null;
    }

    const existing = await this.list();
    if (existing.length > 0) {
      const id = String(existing[0]!.id ?? existing[0]!.automationId ?? '') || null;
      this.ledger.append('automation', { event: 'exists', count: existing.length, id });
      return id;
    }

    // `--from USDT` resolves by symbol; `--to` MUST be the pinned BSC contract (twak rejects
    // bare alt symbols). `--amount` is the source-token amount per run (USDT ≈ $1).
    const out = await this.cli.run<Record<string, unknown>>([
      'automate', 'add',
      '--from', this.cfg.risk.stableSymbol,
      '--to', to.id,
      '--chain', this.cfg.chain,
      '--amount', String(this.cfg.heartbeat.usdNotional),
      '--interval', '1d',
      '--max-runs', '7',
      '--expires', opts.expires,
    ]);
    const id = String(out.id ?? out.automationId ?? (out.automation as Record<string, unknown> | undefined)?.id ?? '') || null;
    this.ledger.append('automation', {
      event: 'created',
      from: this.cfg.risk.stableSymbol,
      to: this.cfg.heartbeat.toSymbol,
      contract: to.id,
      amount: this.cfg.heartbeat.usdNotional,
      interval: '1d',
      expires: opts.expires,
      id,
    });
    return id;
  }

  /**
   * Best-effort: did the heartbeat automation execute within the current UTC day?
   * Returns false when it can't be confirmed, so the in-loop backstop still fires and the
   * ≥1-trade/day rule is never missed (an extra small trade is far cheaper than DQ).
   */
  async ranToday(): Promise<boolean> {
    const today = new Date().toISOString().slice(0, 10);
    for (const a of await this.list()) {
      const ts = String(a.lastRunAt ?? a.lastExecutedAt ?? a.lastRun ?? a.executedAt ?? '');
      if (ts.slice(0, 10) === today) return true;
    }
    return false;
  }
}
