import { existsSync } from 'node:fs';
import { loadConfig, type Config } from './config.js';
import { detectRegime, strategistPropose } from './core/strategist.js';
import { rollState, sentinelValidate } from './core/sentinel.js';
import { Ledger, loadState, saveState } from './core/ledger.js';
import type { AgentState, PortfolioSnapshot, TradeProposal } from './core/types.js';
import type { ExecutionVenue, MarketDataProvider, Notifier, PortfolioReader } from './ports/index.js';
import { TwakCli } from './adapters/twak/cli.js';
import { TwakPortfolioReader, TwakSpotVenue } from './adapters/twak/TwakSpotVenue.js';
import { CmcApiKeyData, CmcX402Data } from './adapters/cmc/CmcData.js';
import { ConsoleNotifier, OpenAICompatLlm, TelegramNotifier } from './adapters/llm/index.js';

/** Watch universe: liquid, BSC-native movers from the allowlist. Tune freely. */
const WATCHLIST = ['CAKE', 'FLOKI', 'TWT', 'PENDLE', 'INJ', 'FET', 'LINK', 'UNI', 'AAVE', 'ETH'];

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
  return new CmcApiKeyData(cfg, key);
}

async function executeApproved(
  proposal: TradeProposal,
  venue: ExecutionVenue,
  cfg: Config,
  ledger: Ledger,
  notifier: Notifier,
  state: AgentState,
): Promise<AgentState> {
  // Quote first (twak best practice), then execute.
  const q = await venue.quote(proposal);
  ledger.append('execution', { stage: 'quote', proposal, result: q });
  if (!q.ok) {
    await notifier.send(`⚠️ Quote failed [${q.errorCode}] ${proposal.fromSymbol}→${proposal.toSymbol}: ${q.error}`);
    return state;
  }

  const r = await venue.execute(proposal, { slippagePct: cfg.risk.maxSlippagePct });
  ledger.append('execution', { stage: 'execute', proposal, result: r });

  if (r.ok) {
    const next: AgentState = {
      ...state,
      tradesToday: state.tradesToday + 1,
      notionalTodayUsd: state.notionalTodayUsd + proposal.usdNotional,
      lastTradeAt: new Date().toISOString(),
    };
    await notifier.send(
      `✅ ${proposal.source}: ${r.quote?.input} → ${r.quote?.output} via ${r.quote?.provider}\n${r.explorerUrl}`,
    );
    return next;
  }
  await notifier.send(`❌ Swap failed [${r.errorCode}]: ${r.error}`);
  return state;
}

/** Flatten everything volatile into the stable token. Triggered by the drawdown breaker. */
async function flattenAll(
  portfolio: PortfolioSnapshot,
  venue: ExecutionVenue,
  cfg: Config,
  ledger: Ledger,
  notifier: Notifier,
  state: AgentState,
): Promise<AgentState> {
  let s = state;
  for (const h of portfolio.holdings) {
    if (h.symbol === cfg.risk.stableSymbol || h.valueUsd < 2) continue;
    const p: TradeProposal = {
      kind: 'swap',
      fromSymbol: h.symbol,
      toSymbol: cfg.risk.stableSymbol,
      usdNotional: Number((h.valueUsd * 0.98).toFixed(2)),
      rationale: 'circuit breaker: flatten to preserve capital before the disqualification threshold',
      source: 'circuit_breaker',
    };
    const verdict = sentinelValidate(p, portfolio, s, cfg);
    ledger.append('verdict', { proposal: p, verdict });
    if (verdict.approved && verdict.effective) {
      s = await executeApproved(verdict.effective, venue, cfg, ledger, notifier, s);
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
}): Promise<void> {
  const { cfg, venue, data, portfolioReader, notifier, ledger, statePath } = deps;
  ledger.append('cycle_start', { mode: cfg.mode, dataTransport: cfg.data.cmcTransport });

  const portfolio = await portfolioReader.snapshot();
  let state = rollState(loadState(statePath), portfolio.totalUsd);

  // --- Circuit breaker check (before anything else) ---
  const drawdown = state.equityHighWaterUsd > 0 ? 1 - portfolio.totalUsd / state.equityHighWaterUsd : 0;
  if (drawdown >= cfg.risk.maxDrawdownPct && !state.flattened) {
    ledger.append('circuit_breaker', { drawdown, hwm: state.equityHighWaterUsd, equity: portfolio.totalUsd });
    await notifier.send(`🛑 CIRCUIT BREAKER: drawdown ${(drawdown * 100).toFixed(1)}% — flattening to ${cfg.risk.stableSymbol}`);
    state = await flattenAll(portfolio, venue, cfg, ledger, notifier, state);
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
  const utcHour = new Date().getUTCHours();
  if (!proposal && cfg.heartbeat.enabled && state.tradesToday === 0 && utcHour >= cfg.heartbeat.deadlineUtcHour) {
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

  if (proposal) {
    ledger.append('proposal', proposal);
    const verdict = sentinelValidate(proposal, portfolio, state, cfg);
    ledger.append('verdict', { proposal, verdict });
    if (verdict.approved && verdict.effective) {
      if (cfg.mode === 'paper') {
        const q = await venue.quote(verdict.effective);
        ledger.append('execution', { stage: 'paper', proposal: verdict.effective, result: q });
        await notifier.send(`📝 PAPER: would swap ${verdict.effective.usdNotional} USD ${verdict.effective.fromSymbol}→${verdict.effective.toSymbol} | ${q.quote?.output ?? q.error}`);
      } else {
        state = await executeApproved(verdict.effective, venue, cfg, ledger, notifier, state);
      }
    } else {
      await notifier.send(`🚫 Sentinel rejected ${proposal.fromSymbol}→${proposal.toSymbol}: ${verdict.reasons.join('; ')}`);
    }
  }

  saveState(statePath, state);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const ledger = new Ledger(cfg.paths.ledger);
  const cli = new TwakCli({ bin: cfg.twak.bin, timeoutMs: cfg.twak.timeoutMs, walletPasswordEnv: cfg.twak.walletPasswordEnv });
  const venue = buildVenue(cfg, cli);
  const data = buildData(cfg, cli, ledger);
  const portfolioReader = new TwakPortfolioReader(cli);
  const notifier: Notifier = cfg.notify.telegram.enabled ? new TelegramNotifier(cfg) : new ConsoleNotifier();

  await notifier.send(`🟢 MIZAN online | mode=${cfg.mode} venue=${venue.name} data=${data.name} halal=${cfg.compliance.halalMode}`);

  // Simple resilient loop: a failed cycle logs + notifies, never kills the process.
  for (;;) {
    if (existsSync(cfg.loop.killSwitchPath)) {
      await notifier.send('🔴 Kill switch file detected — MIZAN exiting cleanly.');
      break;
    }
    try {
      await cycle({ cfg, venue, data, portfolioReader, notifier, ledger, statePath: cfg.paths.state });
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
