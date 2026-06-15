import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rulesFallbackPropose,
  evaluateExit,
  reconcileLlmProposal,
  syncPosition,
} from '../dist/core/strategist.js';

const cfg = {
  mode: 'paper',
  chain: 'bsc',
  compliance: { halalMode: true },
  venues: { spot: { enabled: true }, perps: { enabled: false } },
  loop: { intervalMinutes: 60, killSwitchPath: './KILL' },
  risk: {
    maxTradePctOfEquity: 0.25,
    maxTradesPerDay: 6,
    maxDailyNotionalPctOfEquity: 0.8,
    maxDrawdownPct: 0.18,
    maxSlippagePct: 1.0,
    cooldownMinutes: 45,
    minHoldMinutes: 90,
    trailingStopPct: 0.08,
    switchMarginScore: 4,
    maxVolatilePctOfEquity: 0.6,
    minPortfolioUsd: 25,
    stableSymbol: 'USDT',
  },
  heartbeat: { enabled: true, deadlineUtcHour: 20, usdNotional: 5, toSymbol: 'CAKE' },
  data: {
    cmcTransport: 'apikey',
    cmcMcpUrl: 'https://mcp.coinmarketcap.com/mcp',
    cmcX402Url: 'https://mcp.coinmarketcap.com/x402/mcp',
    cmcX402RestBase: 'https://pro-api.coinmarketcap.com/x402',
    x402MaxPaymentAtomic: '10000',
  },
  llm: { enabled: false, baseUrl: 'https://z', model: 'm', apiKeyEnv: 'K', temperature: 0.2 },
  notify: { telegram: { enabled: false, botTokenEnv: 'T', chatIdEnv: 'C' } },
  twak: { bin: 'twak', walletPasswordEnv: 'TWAK_WALLET_PASSWORD', timeoutMs: 1000 },
  paths: { ledger: './data/ledger.jsonl', state: './data/state.json', paperBook: './data/paper-book.json' },
};

const portfolio = (totalUsd, holdings) => ({ totalUsd, holdings, asOf: new Date().toISOString() });
const regime = (name, score = 0) => ({ regime: name, score, inputs: {}, asOf: new Date().toISOString() });
const quote = (symbol, pctChange24h, priceUsd = 1) => ({ symbol, priceUsd, pctChange24h, asOf: new Date().toISOString() });
const bullishTech = (symbol) => ({ symbol, rsi14: 58, macd: { value: 1, signal: 0.5, histogram: 0.5 }, ema20: 2, ema50: 1, asOf: new Date().toISOString() });
const bearishTech = (symbol) => ({ symbol, rsi14: 40, macd: { value: -1, signal: -0.5, histogram: -0.5 }, ema20: 1, ema50: 2, asOf: new Date().toISOString() });
const baseState = {
  equityHighWaterUsd: 100, lastEquityUsd: 100, tradesToday: 0, notionalTodayUsd: 0,
  dayKey: new Date().toISOString().slice(0, 10), flattened: false,
};

// ---------- OFFENSE: rulesFallbackPropose ----------

test('offense stays out in risk-off (defense de-risks)', () => {
  const p = rulesFallbackPropose(cfg, {
    regime: regime('risk_off', -0.4),
    quotes: [quote('CAKE', 12)],
    technicals: [bullishTech('CAKE')],
    portfolio: portfolio(100, [{ symbol: 'USDT', amount: 100, valueUsd: 100 }]),
  });
  assert.equal(p, null);
});

test('offense stays flat when momentum is weak', () => {
  const p = rulesFallbackPropose(cfg, {
    regime: regime('risk_on', 0.4),
    quotes: [quote('CAKE', -1)],
    technicals: [],
    portfolio: portfolio(100, [{ symbol: 'USDT', amount: 100, valueUsd: 100 }]),
  });
  assert.equal(p, null);
});

test('flat: opens a position in the strongest confirmed leader, sized to per-trade cap', () => {
  const p = rulesFallbackPropose(cfg, {
    regime: regime('risk_on', 0.4),
    quotes: [quote('CAKE', 1), quote('PENDLE', 5)],
    technicals: [bullishTech('PENDLE')],
    portfolio: portfolio(100, [{ symbol: 'USDT', amount: 100, valueUsd: 100 }]),
  });
  assert.equal(p.fromSymbol, 'USDT');
  assert.equal(p.toSymbol, 'PENDLE');
  assert.equal(p.usdNotional, 25); // min(25% cap, 60% target, 98% stable)
});

test('flat: does not trade without stable balance', () => {
  const p = rulesFallbackPropose(cfg, {
    regime: regime('risk_on', 0.4),
    quotes: [quote('CAKE', 4)],
    technicals: [],
    portfolio: portfolio(100, [{ symbol: 'CAKE', amount: 100, valueUsd: 100 }]),
  });
  // Holding CAKE (no better candidate, already at/over volatile target) => hold.
  assert.equal(p, null);
});

test('holding: holds the winner when no materially stronger leader exists', () => {
  const p = rulesFallbackPropose(cfg, {
    regime: regime('risk_on', 0.4),
    quotes: [quote('PENDLE', 5)],
    technicals: [bullishTech('PENDLE')],
    portfolio: portfolio(100, [
      { symbol: 'USDT', amount: 35, valueUsd: 35 },
      { symbol: 'PENDLE', amount: 65, valueUsd: 65 }, // already over 60% target
    ]),
  });
  assert.equal(p, null);
});

test('holding: scales into the held leader toward the volatile target', () => {
  const p = rulesFallbackPropose(cfg, {
    regime: regime('risk_on', 0.4),
    quotes: [quote('PENDLE', 5)],
    technicals: [bullishTech('PENDLE')],
    portfolio: portfolio(100, [
      { symbol: 'USDT', amount: 60, valueUsd: 60 },
      { symbol: 'PENDLE', amount: 40, valueUsd: 40 },
    ]),
  });
  assert.equal(p.fromSymbol, 'USDT');
  assert.equal(p.toSymbol, 'PENDLE');
  assert.equal(p.usdNotional, 20); // min(25 cap, 60-40 target gap, 58.8 stable)
});

test('holding: rotates only when a candidate clears the switch margin', () => {
  const p = rulesFallbackPropose(cfg, {
    regime: regime('risk_on', 0.4),
    quotes: [quote('CAKE', 1), quote('PENDLE', 8)],
    technicals: [bullishTech('PENDLE')], // PENDLE score ~12.5 vs CAKE ~1 => edge > 4
    portfolio: portfolio(100, [
      { symbol: 'USDT', amount: 60, valueUsd: 60 },
      { symbol: 'CAKE', amount: 40, valueUsd: 40 },
    ]),
  });
  assert.equal(p.fromSymbol, 'CAKE');
  assert.equal(p.toSymbol, 'PENDLE');
});

test('holding: does NOT rotate between near-ties (avoids churn)', () => {
  const p = rulesFallbackPropose(cfg, {
    regime: regime('risk_on', 0.4),
    quotes: [quote('CAKE', 4), quote('PENDLE', 5)], // edge ~1 < switch margin 4
    technicals: [],
    portfolio: portfolio(100, [
      { symbol: 'USDT', amount: 30, valueUsd: 30 },
      { symbol: 'CAKE', amount: 70, valueUsd: 70 }, // over target => no scale-in either
    ]),
  });
  assert.equal(p, null);
});

// ---------- DEFENSE: evaluateExit ----------

test('exit: de-risks the held position to stable in risk-off', () => {
  const p = evaluateExit(cfg, {
    regime: regime('risk_off', -0.4),
    quotes: [quote('PENDLE', 5, 100)],
    technicals: [bullishTech('PENDLE')],
    portfolio: portfolio(50, [{ symbol: 'PENDLE', amount: 0.5, valueUsd: 50 }]),
    state: { ...baseState, positionSymbol: 'PENDLE', positionPeakPriceUsd: 100 },
  });
  assert.equal(p.fromSymbol, 'PENDLE');
  assert.equal(p.toSymbol, 'USDT');
  assert.equal(p.source, 'risk_exit');
});

test('exit: trailing stop fires when price gives back > trailingStopPct from peak', () => {
  const p = evaluateExit(cfg, {
    regime: regime('risk_on', 0.4),
    quotes: [quote('PENDLE', 5, 90)], // 90 <= 100 * (1 - 0.08) = 92
    technicals: [bullishTech('PENDLE')],
    portfolio: portfolio(45, [{ symbol: 'PENDLE', amount: 0.5, valueUsd: 45 }]),
    state: { ...baseState, positionSymbol: 'PENDLE', positionPeakPriceUsd: 100 },
  });
  assert.ok(p);
  assert.equal(p.source, 'risk_exit');
  assert.match(p.rationale, /trailing stop/);
});

test('exit: holds a healthy winner near its peak', () => {
  const p = evaluateExit(cfg, {
    regime: regime('risk_on', 0.4),
    quotes: [quote('PENDLE', 5, 99)], // only -1% from peak
    technicals: [bullishTech('PENDLE')],
    portfolio: portfolio(99, [{ symbol: 'PENDLE', amount: 1, valueUsd: 99 }]),
    state: { ...baseState, positionSymbol: 'PENDLE', positionPeakPriceUsd: 100 },
  });
  assert.equal(p, null);
});

test('exit: trend break (MACD<0 and EMA20<EMA50) flattens the position', () => {
  const p = evaluateExit(cfg, {
    regime: regime('risk_on', 0.4),
    quotes: [quote('PENDLE', 5, 99)], // no trailing-stop trigger
    technicals: [bearishTech('PENDLE')],
    portfolio: portfolio(99, [{ symbol: 'PENDLE', amount: 1, valueUsd: 99 }]),
    state: { ...baseState, positionSymbol: 'PENDLE', positionPeakPriceUsd: 100 },
  });
  assert.ok(p);
  assert.match(p.rationale, /trend break/);
});

// ---------- Let-winners-run guard: reconcileLlmProposal ----------

const llmSell = { kind: 'swap', fromSymbol: 'PENDLE', toSymbol: 'USDT', usdNotional: 50, rationale: 'x', source: 'strategist_llm' };

test('reconcile: suppresses an LLM sell of a healthy position to stable in risk-on', () => {
  const out = reconcileLlmProposal(llmSell, cfg, {
    regime: regime('risk_on', 0.4),
    quotes: [quote('PENDLE', 5, 100)],
    portfolio: portfolio(50, [{ symbol: 'PENDLE', amount: 0.5, valueUsd: 50 }]),
  });
  assert.equal(out, null);
});

test('reconcile: allows the LLM de-risk to stable in risk-off', () => {
  const out = reconcileLlmProposal(llmSell, cfg, {
    regime: regime('risk_off', -0.4),
    quotes: [quote('PENDLE', 5, 100)],
    portfolio: portfolio(50, [{ symbol: 'PENDLE', amount: 0.5, valueUsd: 50 }]),
  });
  assert.equal(out, llmSell);
});

test('reconcile: leaves entries and rotations untouched', () => {
  const entry = { ...llmSell, fromSymbol: 'USDT', toSymbol: 'CAKE' };
  const rotation = { ...llmSell, fromSymbol: 'PENDLE', toSymbol: 'CAKE' };
  const ctx = { regime: regime('risk_on', 0.4), quotes: [quote('PENDLE', 5, 100)], portfolio: portfolio(50, [{ symbol: 'PENDLE', amount: 0.5, valueUsd: 50 }]) };
  assert.equal(reconcileLlmProposal(entry, cfg, ctx), entry);
  assert.equal(reconcileLlmProposal(rotation, cfg, ctx), rotation);
});

// ---------- Position memory: syncPosition ----------

test('syncPosition: clears memory when flat', () => {
  const s = syncPosition({ ...baseState, positionSymbol: 'PENDLE', positionPeakPriceUsd: 100 }, portfolio(100, [{ symbol: 'USDT', amount: 100, valueUsd: 100 }]), [], cfg);
  assert.equal(s.positionSymbol, undefined);
});

test('syncPosition: initializes entry and peak on a freshly seen position', () => {
  const s = syncPosition(baseState, portfolio(50, [{ symbol: 'PENDLE', amount: 5, valueUsd: 50 }]), [quote('PENDLE', 5, 10)], cfg);
  assert.equal(s.positionSymbol, 'PENDLE');
  assert.equal(s.positionEntryPriceUsd, 10);
  assert.equal(s.positionPeakPriceUsd, 10);
});

test('syncPosition: ratchets the peak up while held', () => {
  const s = syncPosition({ ...baseState, positionSymbol: 'PENDLE', positionEntryPriceUsd: 10, positionPeakPriceUsd: 10 }, portfolio(60, [{ symbol: 'PENDLE', amount: 5, valueUsd: 60 }]), [quote('PENDLE', 20, 12)], cfg);
  assert.equal(s.positionPeakPriceUsd, 12);
});
