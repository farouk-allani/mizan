import { existsSync } from 'node:fs';
import { loadDotenv } from './env.js';
import { loadConfig, type Config } from './config.js';
import { detectRegime, strategistPropose } from './core/strategist.js';
import { rollState, sentinelValidate } from './core/sentinel.js';
import { Ledger, loadState, saveState } from './core/ledger.js';
import type { AgentState, PortfolioSnapshot, TradeProposal } from './core/types.js';
import type { ExecutionVenue, MarketDataProvider, Notifier, PortfolioReader } from './ports/index.js';
import { TwakCli } from './adapters/twak/cli.js';
import { TwakPortfolioReader, TwakSpotVenue } from './adapters/twak/TwakSpotVenue.js';
import { TwakAutomation } from './adapters/twak/TwakAutomation.js';
import { PaperBook } from './adapters/paper/PaperBook.js';
import { CmcApiKeyData, CmcX402Data } from './adapters/cmc/CmcData.js';
import { ConsoleNotifier, OpenAICompatLlm, TelegramNotifier } from './adapters/llm/index.js';

/** Watch universe: liquid, BSC-native movers from the allowlist. Tune freely. */
const WATCHLIST = ['CAKE', 'FLOKI', 'TWT', 'PENDLE', 'INJ', 'FET', 'LINK', 'UNI', 'AAVE', 'ETH'];

const formatPnl = (pct: number): string => `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;

function buildVenue(cfg: Config, cli: TwakCli): ExecutionVenue {
  // Venue registry. Spot is the only implementation that ships.
  // Adding a perps venue would require BOTH writing an adapter AND setting
  // compliance.halalMode=false in config — which this operator never will.
  if (cfg.venues.spot.enabled) return new TwakSpotVenue(cli, cfg);
  throw new Error('No enabled execution venue'); // unreachable: config refuses this state
}

function buildData(cfg: Config, cli: TwakCli, ledger: Ledger): MarketDataProvider {
  if (cfg.data.cmcTransport === 'x402') return new CmcX402Data(cfg, cli, ledger);
  const key = process.env.CMC_API_KEY;
  if (!key) throw new Error('CMC_API_KEY required for apikey transport');
  return new CmcApiKeyData(cfg, key, ledger);
}

/** Everything a settlement needs, regardless of paper/live mode. */
interface SettleCtx {
  cfg: Config;
  venue: ExecutionVenue;
  ledger: Ledger;
  notifier: Notifier;
  paperBook?: PaperBook;
}

/**
 * Settle an approved proposal. Mode-aware and the SOLE path to a fill:
 *  - paper: quote, apply the fill to the virtual book, increment counters — NEVER signs.
 *  - live:  quote then sign+broadcast via the venue.
 * Used by both the strategist/heartbeat path and the drawdown breaker, so paper mode can
 * never accidentally execute a real swap (e.g. when the breaker flattens).
 */
async function settle(proposal: TradeProposal, ctx: SettleCtx, state: AgentState, pnlNote = ''): Promise<AgentState> {
  const q = await ctx.venue.quote(proposal);
  if (!q.ok) {
    ctx.ledger.append('execution', { stage: 'quote', proposal, result: q });
    await ctx.notifier.send(`⚠️ Quote failed [${q.errorCode}] ${proposal.fromSymbol}→${proposal.toSymbol}: ${q.error}`);
    return state;
  }

  if (ctx.cfg.mode === 'paper') {
    if (ctx.paperBook) ctx.paperBook.applyFill(proposal.fromSymbol, q.quote?.input, proposal.toSymbol, q.quote?.output);
    ctx.ledger.append('execution', { stage: 'paper', proposal, result: q });
    await ctx.notifier.send(
      `📝 PAPER ${proposal.source}: ${proposal.usdNotional} USD ${proposal.fromSymbol}→${proposal.toSymbol} | ${q.quote?.input} → ${q.quote?.output}${pnlNote}`,
    );
    return {
      ...state,
      tradesToday: state.tradesToday + 1,
      notionalTodayUsd: state.notionalTodayUsd + proposal.usdNotional,
      lastTradeAt: new Date().toISOString(),
    };
  }

  ctx.ledger.append('execution', { stage: 'quote', proposal, result: q });
  const r = await ctx.venue.execute(proposal, { slippagePct: ctx.cfg.risk.maxSlippagePct });
  ctx.ledger.append('execution', { stage: 'execute', proposal, result: r });
  if (r.ok) {
    await ctx.notifier.send(
      `✅ ${proposal.source}: ${r.quote?.input} → ${r.quote?.output} via ${r.quote?.provider}\n${r.explorerUrl}${pnlNote}`,
    );
    return {
      ...state,
      tradesToday: state.tradesToday + 1,
      notionalTodayUsd: state.notionalTodayUsd + proposal.usdNotional,
      lastTradeAt: new Date().toISOString(),
    };
  }
  await ctx.notifier.send(`❌ Swap failed [${r.errorCode}]: ${r.error}`);
  return state;
}

/** Flatten everything volatile into the stable token. Triggered by the drawdown breaker. */
async function flattenAll(portfolio: PortfolioSnapshot, ctx: SettleCtx, state: AgentState): Promise<AgentState> {
  let s = state;
  for (const h of portfolio.holdings) {
    if (h.symbol === ctx.cfg.risk.stableSymbol || h.valueUsd < 2) continue;
    const p: TradeProposal = {
      kind: 'swap',
      fromSymbol: h.symbol,
      toSymbol: ctx.cfg.risk.stableSymbol,
      usdNotional: Number((h.valueUsd * 0.98).toFixed(2)),
      rationale: 'circuit breaker: flatten to preserve capital before the disqualification threshold',
      source: 'circuit_breaker',
    };
    const verdict = sentinelValidate(p, portfolio, s, ctx.cfg);
    ctx.ledger.append('verdict', { proposal: p, verdict });
    if (verdict.approved && verdict.effective) {
      s = await settle(verdict.effective, ctx, s);
    }
  }
  return { ...s, flattened: true, circuitBreakerTrippedAt: s.circuitBreakerTrippedAt ?? new Date().toISOString() };
}

async function cycle(deps: {
  cfg: Config;
  venue: ExecutionVenue;
  data: MarketDataProvider;
  portfolioReader: PortfolioReader;
  notifier: Notifier;
  ledger: Ledger;
  statePath: string;
  automation?: TwakAutomation;
  paperBook?: PaperBook;
}): Promise<void> {
  const { cfg, venue, data, portfolioReader, notifier, ledger, statePath } = deps;
  const ctx: SettleCtx = { cfg, venue, ledger, notifier, ...(deps.paperBook ? { paperBook: deps.paperBook } : {}) };
  ledger.append('cycle_start', { mode: cfg.mode, dataTransport: cfg.data.cmcTransport });

  const portfolio = await portfolioReader.snapshot();
  let state = rollState(loadState(statePath), portfolio.totalUsd);
  // Paper PnL tag appended to every cycle message so the simulated return is always visible.
  const pnlNote = deps.paperBook ? ` (PnL ${formatPnl(deps.paperBook.pnlPct(portfolio.totalUsd))})` : '';

  // --- Circuit breaker check (before anything else) ---
  const drawdown = state.equityHighWaterUsd > 0 ? 1 - portfolio.totalUsd / state.equityHighWaterUsd : 0;
  if (drawdown >= cfg.risk.maxDrawdownPct && !state.flattened) {
    ledger.append('circuit_breaker', { drawdown, hwm: state.equityHighWaterUsd, equity: portfolio.totalUsd });
    await notifier.send(`🛑 CIRCUIT BREAKER: drawdown ${(drawdown * 100).toFixed(1)}%${pnlNote} — flattening to ${cfg.risk.stableSymbol}`);
    state = await flattenAll(portfolio, ctx, state);
    saveState(statePath, state);
    return;
  }

  // --- Data + regime (deterministic) ---
  const [global, quotes] = await Promise.all([data.global(), data.quotes(WATCHLIST)]);
  const technicals = await Promise.all(WATCHLIST.slice(0, 4).map((s) => data.technicals(s)));
  const regime = detectRegime(global);
  ledger.append('data', { global, quotes: quotes.length, technicals: technicals.length });
  ledger.append('regime', regime);

  // --- Strategist proposal (LLM proposes, never executes) ---
  let proposal: TradeProposal | null = null;
  if (cfg.llm.enabled) {
    const llm = new OpenAICompatLlm(cfg);
    const holdingsSummary = portfolio.holdings.map((h) => `${h.symbol}:$${h.valueUsd.toFixed(0)}`).join(' ');
    proposal = await strategistPropose(llm, cfg, { regime, quotes, technicals, holdingsSummary }).catch((e) => {
      ledger.append('error', { where: 'strategist', message: String(e) });
      return null;
    });
  }

  // --- Heartbeat: guarantee >= 1 trade/day (competition qualification) ---
  // In live mode the `twak automate` DCA is the primary daily trade; this in-loop heartbeat
  // is a backstop that fires only if that automation hasn't run today (best-effort check),
  // so the ≥1-trade/day rule is never missed even if `twak watch` is down.
  const utcHour = new Date().getUTCHours();
  if (!proposal && cfg.heartbeat.enabled && state.tradesToday === 0 && utcHour >= cfg.heartbeat.deadlineUtcHour) {
    const automationCovered = deps.automation ? await deps.automation.ranToday() : false;
    if (!automationCovered) {
      proposal = {
        kind: 'swap',
        fromSymbol: cfg.risk.stableSymbol,
        toSymbol: cfg.heartbeat.toSymbol,
        usdNotional: cfg.heartbeat.usdNotional,
        rationale: 'heartbeat: satisfy the 1-trade/day competition minimum',
        source: 'heartbeat',
      };
      ledger.append('heartbeat', proposal);
    }
  }

  if (proposal) {
    ledger.append('proposal', proposal);
    const verdict = sentinelValidate(proposal, portfolio, state, cfg);
    ledger.append('verdict', { proposal, verdict });
    if (verdict.approved && verdict.effective) {
      state = await settle(verdict.effective, ctx, state, pnlNote);
    } else {
      await notifier.send(`🚫 Sentinel rejected ${proposal.fromSymbol}→${proposal.toSymbol}: ${verdict.reasons.join('; ')}`);
    }
  } else {
    // No trade this cycle (strategist held, or before the heartbeat hour). Surface it so
    // paper/live trading is never silent — report regime, equity, PnL, and the hold decision.
    ledger.append('proposal', { action: 'hold', regime: regime.regime, score: regime.score });
    await notifier.send(`🔵 ${regime.regime} (${regime.score}) · equity $${portfolio.totalUsd.toFixed(2)}${pnlNote} · holding — no trade this cycle`);
  }

  saveState(statePath, state);
}

async function main(): Promise<void> {
  loadDotenv(); // populate process.env from .env before reading config/credentials
  const cfg = loadConfig();
  const ledger = new Ledger(cfg.paths.ledger);
  const cli = new TwakCli({ bin: cfg.twak.bin, timeoutMs: cfg.twak.timeoutMs, walletPasswordEnv: cfg.twak.walletPasswordEnv });
  const venue = buildVenue(cfg, cli);
  const data = buildData(cfg, cli, ledger);
  const notifier: Notifier = cfg.notify.telegram.enabled ? new TelegramNotifier(cfg) : new ConsoleNotifier();

  await notifier.send(`🟢 MIZAN online | mode=${cfg.mode} venue=${venue.name} data=${data.name} halal=${cfg.compliance.halalMode}`);

  // Portfolio source: the real wallet (live) or a seeded virtual book (paper). The paper
  // book makes simulated PnL real and lets the loop exercise sizing / caps / drawdown.
  let paperBook: PaperBook | undefined;
  let portfolioReader: PortfolioReader;
  if (cfg.mode === 'paper') {
    paperBook = new PaperBook(cfg.paths.paperBook, data);
    if (!paperBook.seeded) {
      const real = await new TwakPortfolioReader(cli).snapshot();
      await paperBook.seed(real.holdings);
      await notifier.send(
        `📓 paper book seeded from wallet: $${paperBook.startEquityUsd.toFixed(2)} (${real.holdings.map((h) => h.symbol).join(', ') || 'empty'})`,
      );
    } else {
      await notifier.send(`📓 paper book resumed: start $${paperBook.startEquityUsd.toFixed(2)}`);
    }
    portfolioReader = paperBook;
  } else {
    portfolioReader = new TwakPortfolioReader(cli);
  }

  // LIVE only: ensure the daily DCA heartbeat exists as a real `twak automate` automation
  // (executed by `twak watch` alongside MIZAN). Paper mode never creates real automations.
  let automation: TwakAutomation | undefined;
  if (cfg.mode === 'live' && cfg.heartbeat.enabled) {
    automation = new TwakAutomation(cli, cfg, ledger);
    try {
      const id = await automation.ensureDailyHeartbeat({ expires: '2026-06-29' });
      await notifier.send(
        `🤖 twak automate heartbeat ${id ? `ready (${id})` : 'ensured'}: ${cfg.heartbeat.usdNotional} ${cfg.risk.stableSymbol}/day → ${cfg.heartbeat.toSymbol}. Ensure \`twak watch\` is running to execute it.`,
      );
    } catch (e) {
      await notifier.send(`⚠️ twak automate setup failed: ${String(e).slice(0, 160)} — in-loop heartbeat backstop active.`);
    }
  }

  // Simple resilient loop: a failed cycle logs + notifies, never kills the process.
  for (;;) {
    if (existsSync(cfg.loop.killSwitchPath)) {
      await notifier.send('🔴 Kill switch file detected — MIZAN exiting cleanly.');
      break;
    }
    try {
      await cycle({ cfg, venue, data, portfolioReader, notifier, ledger, statePath: cfg.paths.state, ...(automation ? { automation } : {}), ...(paperBook ? { paperBook } : {}) });
    } catch (e) {
      ledger.append('error', { where: 'cycle', message: String(e) });
      await notifier.send(`⚠️ cycle error: ${String(e).slice(0, 300)}`);
    }
    await new Promise((r) => setTimeout(r, cfg.loop.intervalMinutes * 60_000));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
