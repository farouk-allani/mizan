import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rulesFallbackPropose,
  evaluateExit,
  reconcileLlmProposal,
  syncPosition,
  inReentryCooldown,
  contrarianPropose,
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
    reentryCooldownMinutes: 180,
    trailingStopPct: 0.08,
    profitLockArmPct: 0.05,
    profitLockTrailPct: 0.03,
    switchMarginScore: 4,
    maxVolatilePctOfEquity: 0.6,
    contrarianEnabled: true,
    contrarianFearThreshold: 25,
    contrarianMaxTradePctOfEquity: 0.10,
    contrarianMaxVolatilePctOfEquity: 0.25,
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

test('exit: does NOT dump a position on a short-horizon trend wobble (no trend-break exit)', () => {
  // Weak/bearish technicals but price only -1% from peak: the removed trend-break rule used to
  // whipsaw here. Now only the trailing stop / risk_off exit, so this must HOLD.
  const p = evaluateExit(cfg, {
    regime: regime('risk_on', 0.4),
    quotes: [quote('PENDLE', 5, 99)], // no trailing-stop trigger
    technicals: [bearishTech('PENDLE')],
    portfolio: portfolio(99, [{ symbol: 'PENDLE', amount: 1, valueUsd: 99 }]),
    state: { ...baseState, positionSymbol: 'PENDLE', positionPeakPriceUsd: 100 },
  });
  assert.equal(p, null);
});

test('exit: while contrarian sleeve is armed (extreme fear), the risk_off auto-exit is suspended', () => {
  const p = evaluateExit(cfg, {
    regime: regime('risk_off', -0.5),
    quotes: [quote('PENDLE', 5, 99)], // near peak, no trailing-stop trigger
    portfolio: portfolio(50, [{ symbol: 'PENDLE', amount: 0.5, valueUsd: 50 }]),
    state: { ...baseState, positionSymbol: 'PENDLE', positionPeakPriceUsd: 100 },
    fearGreed: 24, // <= threshold => armed
  });
  assert.equal(p, null); // held, not reversed
});

test('exit: armed or not, the trailing stop still protects a contrarian position', () => {
  const p = evaluateExit(cfg, {
    regime: regime('risk_off', -0.5),
    quotes: [quote('PENDLE', 5, 90)], // 90 <= 100*0.92 => trailing stop
    portfolio: portfolio(45, [{ symbol: 'PENDLE', amount: 0.5, valueUsd: 45 }]),
    state: { ...baseState, positionSymbol: 'PENDLE', positionPeakPriceUsd: 100 },
    fearGreed: 24,
  });
  assert.ok(p);
  assert.match(p.rationale, /trailing stop/);
});

test('profit-lock: once well in profit, a tighter trail exits where the wide trail would not', () => {
  // entry 100, peak 120 (+20% from entry => profit-locked), price 115.2 = -4% from peak.
  // Normal 8% trail would HOLD (-4% < 8%); the 3% profit-lock trail must EXIT.
  const p = evaluateExit(cfg, {
    regime: regime('risk_on', 0.4),
    quotes: [quote('PENDLE', 5, 115.2)],
    portfolio: portfolio(100, [{ symbol: 'PENDLE', amount: 1, valueUsd: 100 }]),
    state: { ...baseState, positionSymbol: 'PENDLE', positionEntryPriceUsd: 100, positionPeakPriceUsd: 120 },
  });
  assert.ok(p);
  assert.match(p.rationale, /profit-lock stop/);
});

test('profit-lock: stays on the wide trail when the position is not yet in profit', () => {
  // entry 100, peak 104, price 100 (gain 0% < 5% arm) => wide 8% trail; -3.8% from peak => HOLD.
  const p = evaluateExit(cfg, {
    regime: regime('risk_on', 0.4),
    quotes: [quote('PENDLE', 5, 100)],
    portfolio: portfolio(100, [{ symbol: 'PENDLE', amount: 1, valueUsd: 100 }]),
    state: { ...baseState, positionSymbol: 'PENDLE', positionEntryPriceUsd: 100, positionPeakPriceUsd: 104 },
  });
  assert.equal(p, null);
});

// ---------- CONTRARIAN sleeve: contrarianPropose ----------

test('contrarian: in extreme fear, opens a small capped bet on an oversold-and-turning token', () => {
  const p = contrarianPropose(cfg, {
    regime: regime('risk_off', -0.5),
    quotes: [quote('CAKE', -3, 1)], // beaten down on 24h, but...
    technicals: [bullishTech('CAKE')], // RSI 58 (recovering) + MACD>0 => reversal confirmed
    portfolio: portfolio(100, [{ symbol: 'USDT', amount: 100, valueUsd: 100 }]),
    fearGreed: 24,
  });
  assert.equal(p.toSymbol, 'CAKE');
  assert.equal(p.source, 'contrarian');
  assert.equal(p.usdNotional, 10); // contrarian per-trade cap 10% of 100
});

test('contrarian: stays out when fear is not extreme (above threshold)', () => {
  const p = contrarianPropose(cfg, {
    regime: regime('risk_off', -0.3),
    quotes: [quote('CAKE', -3, 1)],
    technicals: [bullishTech('CAKE')],
    portfolio: portfolio(100, [{ symbol: 'USDT', amount: 100, valueUsd: 100 }]),
    fearGreed: 40, // > 25 => not armed
  });
  assert.equal(p, null);
});

test('contrarian: refuses to catch a knife — no entry without a confirmed turn', () => {
  const p = contrarianPropose(cfg, {
    regime: regime('risk_off', -0.5),
    quotes: [quote('CAKE', -3, 1)],
    technicals: [bearishTech('CAKE')], // MACD<0 => not turning => no entry
    portfolio: portfolio(100, [{ symbol: 'USDT', amount: 100, valueUsd: 100 }]),
    fearGreed: 24,
  });
  assert.equal(p, null);
});

test('contrarian: disabled config never proposes', () => {
  const p = contrarianPropose({ ...cfg, risk: { ...cfg.risk, contrarianEnabled: false } }, {
    regime: regime('risk_off', -0.5),
    quotes: [quote('CAKE', -3, 1)],
    technicals: [bullishTech('CAKE')],
    portfolio: portfolio(100, [{ symbol: 'USDT', amount: 100, valueUsd: 100 }]),
    fearGreed: 24,
  });
  assert.equal(p, null);
});

// ---------- Anti-whipsaw: inReentryCooldown ----------

test('reentry cooldown blocks offense right after a protective exit', () => {
  const recentExit = new Date(Date.now() - 60 * 60_000).toISOString(); // 60m < 180m
  assert.equal(inReentryCooldown({ ...baseState, lastTradeSource: 'risk_exit', lastTradeAt: recentExit }, cfg), true);
});

test('reentry cooldown clears after the window', () => {
  const oldExit = new Date(Date.now() - 200 * 60_000).toISOString(); // 200m > 180m
  assert.equal(inReentryCooldown({ ...baseState, lastTradeSource: 'risk_exit', lastTradeAt: oldExit }, cfg), false);
});

test('reentry cooldown does not apply when the last trade was not a protective exit', () => {
  const recent = new Date(Date.now() - 10 * 60_000).toISOString();
  assert.equal(inReentryCooldown({ ...baseState, lastTradeSource: 'rules', lastTradeAt: recent }, cfg), false);
});

test('entry requires a confirmed uptrend (blocks marginal momentum with bearish technicals)', () => {
  const p = rulesFallbackPropose(cfg, {
    regime: regime('risk_on', 0.4),
    quotes: [quote('PENDLE', 5)], // positive 24h, but...
    technicals: [bearishTech('PENDLE')], // MACD<0 & EMA20<EMA50 => not confirmed
    portfolio: portfolio(100, [{ symbol: 'USDT', amount: 100, valueUsd: 100 }]),
  });
  assert.equal(p, null);
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

test('reconcile: blocks an LLM entry into volatile during risk_off (defense would reverse it)', () => {
  const entry = { ...llmSell, fromSymbol: 'USDT', toSymbol: 'CAKE' };
  const out = reconcileLlmProposal(entry, cfg, {
    regime: regime('risk_off', -0.5),
    quotes: [quote('CAKE', 5, 1)],
    portfolio: portfolio(100, [{ symbol: 'USDT', amount: 100, valueUsd: 100 }]),
  });
  assert.equal(out, null);
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
