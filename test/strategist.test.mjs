import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rulesFallbackPropose } from '../dist/core/strategist.js';

const cfg = {
  mode: 'paper',
  chain: 'bsc',
  compliance: { halalMode: true },
  venues: { spot: { enabled: true }, perps: { enabled: false } },
  loop: { intervalMinutes: 15, killSwitchPath: './KILL' },
  risk: {
    maxTradePctOfEquity: 0.15,
    maxTradesPerDay: 12,
    maxDailyNotionalPctOfEquity: 1.0,
    maxDrawdownPct: 0.18,
    maxSlippagePct: 1.0,
    cooldownMinutes: 20,
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
const quote = (symbol, pctChange24h) => ({ symbol, priceUsd: 1, pctChange24h, asOf: new Date().toISOString() });

test('rules fallback makes a tiny risk-off spot probe into a strong allowlist mover', () => {
  const proposal = rulesFallbackPropose(cfg, {
    regime: regime('risk_off', -0.4),
    quotes: [quote('CAKE', 2)],
    technicals: [],
    portfolio: portfolio(100, [{ symbol: 'USDT', amount: 100, valueUsd: 100 }]),
  });

  assert.equal(proposal.source, 'rules');
  assert.equal(proposal.fromSymbol, 'USDT');
  assert.equal(proposal.toSymbol, 'CAKE');
  assert.equal(proposal.usdNotional, 4.5);
});

test('rules fallback stays passive in risk-off when momentum is weak', () => {
  const proposal = rulesFallbackPropose(cfg, {
    regime: regime('risk_off', -0.4),
    quotes: [quote('CAKE', -1)],
    technicals: [],
    portfolio: portfolio(100, [{ symbol: 'USDT', amount: 100, valueUsd: 100 }]),
  });

  assert.equal(proposal, null);
});

test('rules fallback sizes larger in risk-on and chooses the highest scored token', () => {
  const proposal = rulesFallbackPropose(cfg, {
    regime: regime('risk_on', 0.4),
    quotes: [quote('CAKE', 1), quote('PENDLE', 5)],
    technicals: [],
    portfolio: portfolio(100, [{ symbol: 'USDT', amount: 100, valueUsd: 100 }]),
  });

  assert.equal(proposal.toSymbol, 'PENDLE');
  assert.equal(proposal.usdNotional, 12);
});

test('rules fallback does not trade without stable balance', () => {
  const proposal = rulesFallbackPropose(cfg, {
    regime: regime('risk_on', 0.4),
    quotes: [quote('CAKE', 4)],
    technicals: [],
    portfolio: portfolio(100, [{ symbol: 'CAKE', amount: 100, valueUsd: 100 }]),
  });

  assert.equal(proposal, null);
});
