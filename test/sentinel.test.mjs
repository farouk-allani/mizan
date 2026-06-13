import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sentinelValidate, rollState } from '../dist/core/sentinel.js';

const cfg = {
  mode: 'paper', chain: 'bsc',
  compliance: { halalMode: true },
  venues: { spot: { enabled: true }, perps: { enabled: false } },
  loop: { intervalMinutes: 15, killSwitchPath: './KILL' },
  risk: {
    maxTradePctOfEquity: 0.15, maxTradesPerDay: 12, maxDailyNotionalPctOfEquity: 1.0,
    maxDrawdownPct: 0.18, maxSlippagePct: 1.0, cooldownMinutes: 20,
    minPortfolioUsd: 25, stableSymbol: 'USDT',
  },
  heartbeat: { enabled: true, deadlineUtcHour: 20, usdNotional: 5, toSymbol: 'CAKE' },
  data: { cmcTransport: 'apikey', cmcMcpUrl: 'https://x', cmcX402Url: 'https://y', x402MaxPaymentAtomic: '10000' },
  llm: { enabled: false, baseUrl: 'https://z', model: 'm', apiKeyEnv: 'K', temperature: 0.2 },
  notify: { telegram: { enabled: false, botTokenEnv: 'T', chatIdEnv: 'C' } },
  twak: { bin: 'twak', walletPasswordEnv: 'TWAK_WALLET_PASSWORD', timeoutMs: 1000 },
  paths: { ledger: './data/ledger.jsonl', state: './data/state.json' },
};

const portfolio = (totalUsd, holdings) => ({ totalUsd, holdings, asOf: new Date().toISOString() });
const baseState = {
  equityHighWaterUsd: 1000, lastEquityUsd: 1000, tradesToday: 0, notionalTodayUsd: 0,
  dayKey: new Date().toISOString().slice(0, 10), flattened: false,
};
const prop = (over = {}) => ({
  kind: 'swap', fromSymbol: 'USDT', toSymbol: 'CAKE', usdNotional: 50,
  rationale: 't', source: 'strategist_llm', ...over,
});

test('approves a clean in-allowlist trade', () => {
  const v = sentinelValidate(prop(), portfolio(1000, [{ symbol: 'USDT', amount: 1000, valueUsd: 1000 }]), baseState, cfg);
  assert.equal(v.approved, true);
  assert.equal(v.effective.usdNotional, 50);
});

test('rejects non-allowlist token (BTC is NOT eligible!)', () => {
  const v = sentinelValidate(prop({ toSymbol: 'BTC' }), portfolio(1000, [{ symbol: 'USDT', amount: 1000, valueUsd: 1000 }]), baseState, cfg);
  assert.equal(v.approved, false);
  assert.match(v.reasons.join(' '), /allowlist/);
});

test('rejects ambiguous unpinned symbol (single-letter "B")', () => {
  const v = sentinelValidate(prop({ toSymbol: 'B' }), portfolio(1000, [{ symbol: 'USDT', amount: 1000, valueUsd: 1000 }]), baseState, cfg);
  assert.equal(v.approved, false);
  assert.match(v.reasons.join(' '), /ambiguous/);
});

test('clamps oversized notional to per-trade cap (15% of equity)', () => {
  const v = sentinelValidate(prop({ usdNotional: 900 }), portfolio(1000, [{ symbol: 'USDT', amount: 1000, valueUsd: 1000 }]), baseState, cfg);
  assert.equal(v.approved, true);
  assert.equal(v.effective.usdNotional, 150);
});

test('blocks new risk while circuit breaker drawdown active', () => {
  const v = sentinelValidate(prop(), portfolio(800, [{ symbol: 'USDT', amount: 800, valueUsd: 800 }]), baseState, cfg); // 20% DD vs HWM 1000
  assert.equal(v.approved, false);
  assert.match(v.reasons.join(' '), /circuit breaker/);
});

test('circuit_breaker-source flatten IS allowed during drawdown', () => {
  const v = sentinelValidate(
    prop({ fromSymbol: 'CAKE', toSymbol: 'USDT', usdNotional: 100, source: 'circuit_breaker' }),
    portfolio(800, [{ symbol: 'CAKE', amount: 50, valueUsd: 800 }]), baseState, cfg,
  );
  assert.equal(v.approved, true);
});

test('enforces daily trade cap', () => {
  const v = sentinelValidate(prop(), portfolio(1000, [{ symbol: 'USDT', amount: 1000, valueUsd: 1000 }]), { ...baseState, tradesToday: 12 }, cfg);
  assert.equal(v.approved, false);
  assert.match(v.reasons.join(' '), /daily trade cap/);
});

test('enforces cooldown but exempts heartbeat', () => {
  const justNow = new Date(Date.now() - 5 * 60_000).toISOString();
  const block = sentinelValidate(prop(), portfolio(1000, [{ symbol: 'USDT', amount: 1000, valueUsd: 1000 }]), { ...baseState, lastTradeAt: justNow }, cfg);
  assert.equal(block.approved, false);
  const hb = sentinelValidate(prop({ source: 'heartbeat', usdNotional: 5 }), portfolio(1000, [{ symbol: 'USDT', amount: 1000, valueUsd: 1000 }]), { ...baseState, lastTradeAt: justNow }, cfg);
  assert.equal(hb.approved, true);
});

test('rejects when portfolio under dust safety floor', () => {
  const v = sentinelValidate(prop({ usdNotional: 2 }), portfolio(10, [{ symbol: 'USDT', amount: 10, valueUsd: 10 }]), { ...baseState, equityHighWaterUsd: 10 }, cfg);
  assert.equal(v.approved, false);
  assert.match(v.reasons.join(' '), /safety floor/);
});

test('rejects self-swap and non-positive notional', () => {
  const a = sentinelValidate(prop({ toSymbol: 'USDT' }), portfolio(1000, [{ symbol: 'USDT', amount: 1000, valueUsd: 1000 }]), baseState, cfg);
  assert.equal(a.approved, false);
  const b = sentinelValidate(prop({ usdNotional: 0 }), portfolio(1000, [{ symbol: 'USDT', amount: 1000, valueUsd: 1000 }]), baseState, cfg);
  assert.equal(b.approved, false);
});

test('rollState resets daily counters on new day and tracks HWM', () => {
  const s = rollState({ ...baseState, dayKey: '2020-01-01', tradesToday: 7, notionalTodayUsd: 400 }, 1200);
  assert.equal(s.tradesToday, 0);
  assert.equal(s.notionalTodayUsd, 0);
  assert.equal(s.equityHighWaterUsd, 1200);
});
