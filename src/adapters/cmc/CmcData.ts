import { randomUUID } from 'node:crypto';
import type { Config } from '../../config.js';
import type { GlobalSnapshot, TechnicalSnapshot, TokenQuote } from '../../core/types.js';
import type { MarketDataProvider } from '../../ports/index.js';
import { TwakCli } from '../twak/cli.js';
import type { Ledger } from '../../core/ledger.js';

/**
 * CMC market data, two transports behind one port:
 *
 *  - CmcApiKeyData : direct MCP-over-HTTP with X-CMC-MCP-API-KEY (free tier; dev/build window)
 *  - CmcX402Data   : paid CoinMarketCap x402 REST endpoints via twak x402 request.
 *                    TWAK 0.19.1 cannot add the MCP Streamable HTTP Accept header
 *                    required by /x402/mcp, so live x402 uses REST resources.
 *
 * MCP tool names AND payload shapes verified against the live Agent Hub (2026-06-13).
 * Two facts the API enforces
 * that earlier drafts got wrong, pinned here:
 *   1. Quote/technical tools key on numeric `id`, NOT `symbol` (see CMC_ID below).
 *   2. Responses are column-tables / nested objects with string-formatted numbers
 *      ("+58.6%", "372.73 B"); parse via `parseNum`, not JSON-path-into-quote.USD.
 */

/**
 * Symbol → CoinMarketCap numeric id. The MCP quote/TA tools REQUIRE `id`; passing
 * `symbol` returns "Required parameter is missing". Verified via tools/list +
 * search_cryptos on the live Agent Hub. Extend this map if you widen WATCHLIST.
 */
export const CMC_ID: Readonly<Record<string, number>> = {
  ETH: 1027,
  CAKE: 7186,
  LINK: 1975,
  UNI: 7083,
  AAVE: 7278,
  FLOKI: 10804,
  TWT: 5964,
  PENDLE: 9481,
  INJ: 7226,
  FET: 3773,
  USDT: 825,
  USDC: 3408,
};

interface McpToolResult {
  result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  error?: { message: string };
}

function mcpEnvelope(tool: string, args: Record<string, unknown>) {
  return {
    jsonrpc: '2.0',
    id: randomUUID(),
    method: 'tools/call',
    params: { name: tool, arguments: args },
  };
}

function extractText(r: McpToolResult): string {
  if (r.error) throw new Error(`CMC MCP error: ${r.error.message}`);
  const text = r.result?.content?.find((c) => c.type === 'text')?.text;
  if (!text) throw new Error('CMC MCP: empty tool result');
  // CMC reports tool-level failures (bad/missing params) with isError + an error string.
  if (r.result?.isError) throw new Error(`CMC MCP tool error: ${text.slice(0, 200)}`);
  return text;
}

type JsonRecord = Record<string, unknown>;

interface CmcRestEnvelope {
  status?: {
    timestamp?: string;
    error_code?: number;
    error_message?: string | null;
  };
  data?: unknown;
}

function asRecord(v: unknown): JsonRecord | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonRecord) : undefined;
}

function cmcRestUrl(base: string, path: string, params: Record<string, string>): string {
  const root = base.replace(/\/+$/, '');
  const suffix = path.replace(/^\/+/, '');
  const query = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v).replace(/%2C/gi, ',')}`)
    .join('&');
  return query ? `${root}/${suffix}?${query}` : `${root}/${suffix}`;
}

function unwrapCmcRest(r: unknown): unknown {
  const env = asRecord(r) as CmcRestEnvelope | undefined;
  if (!env) throw new Error('CMC x402 REST: non-object response');
  const code = env.status?.error_code;
  if (code !== undefined && code !== 0) {
    throw new Error(`CMC x402 REST error ${code}: ${env.status?.error_message ?? 'unknown error'}`);
  }
  if (env.data === undefined) throw new Error('CMC x402 REST: missing data');
  return env.data;
}

function quoteUsd(row: JsonRecord): JsonRecord {
  const quote = asRecord(row.quote);
  const usd = quote ? asRecord(quote.USD) : undefined;
  return usd ?? {};
}

function restQuoteRows(data: unknown): JsonRecord[] {
  const rows = Array.isArray(data) ? data : Object.values(asRecord(data) ?? {});
  return rows.flatMap((r) => {
    const row = asRecord(r);
    if (!row) return [];
    const usd = quoteUsd(row);
    return [{
      id: row.id,
      name: row.name,
      symbol: row.symbol,
      price: usd.price,
      percent_change_1h: usd.percent_change_1h,
      percent_change_24h: usd.percent_change_24h,
      percent_change_7d: usd.percent_change_7d,
      percent_change_30d: usd.percent_change_30d,
      volume_24h: usd.volume_24h,
      market_cap: usd.market_cap,
      last_updated: usd.last_updated,
    }];
  });
}

function listingsGlobalProxy(data: unknown): JsonRecord {
  const rows = restQuoteRows(data);
  const stable = new Set(['USDT', 'USDC', 'DAI', 'FDUSD', 'TUSD', 'USDE', 'USDD']);
  const btc = rows.find((r) => String(r.symbol ?? '').toUpperCase() === 'BTC');
  const btcChange = parseNum(btc?.percent_change_24h);
  const totalMarketCap = rows.reduce((sum, r) => sum + (parseNum(r.market_cap) ?? 0), 0);
  const btcMarketCap = parseNum(btc?.market_cap);

  let outperformers = 0;
  let eligible = 0;
  if (btcChange !== undefined) {
    for (const r of rows) {
      const sym = String(r.symbol ?? '').toUpperCase();
      if (!sym || sym === 'BTC' || stable.has(sym)) continue;
      const change = parseNum(r.percent_change_24h);
      if (change === undefined) continue;
      eligible += 1;
      if (change > btcChange) outperformers += 1;
    }
  }

  const altBreadth = eligible > 0 ? Math.round((outperformers / eligible) * 100) : undefined;
  const out: JsonRecord = {
    source: 'cmc_x402_listings_latest_proxy',
    rotation: {},
    dominance: {},
  };
  if (altBreadth !== undefined) {
    out.rotation = { altcoin_season: { current: { index: altBreadth } } };
  }
  if (btcMarketCap !== undefined && totalMarketCap > 0) {
    out.dominance = { btc: { current: `${((btcMarketCap / totalMarketCap) * 100).toFixed(2)}%` } };
  }
  return out;
}

/** Shared response→domain mapping. CMC returns LLM-friendly tables/objects; parse defensively. */
abstract class CmcBase implements MarketDataProvider {
  abstract readonly name: string;
  protected constructor(protected readonly ledger?: Ledger) {}
  protected abstract call(tool: string, args: Record<string, unknown>): Promise<string>;

  /** Surface degraded data: a CMC outage or payload change becomes a visible ledger entry
   *  instead of silently feeding zeros to the strategist/regime. */
  protected warn(where: string, reason: string, sample?: string): void {
    this.ledger?.append('error', { where, reason, ...(sample ? { sample: sample.slice(0, 160) } : {}) });
  }

  /** Resolve known symbols to a comma-joined id string for the `id`-keyed tools. */
  private idsFor(symbols: string[]): string {
    return symbols
      .map((s) => CMC_ID[s.toUpperCase()])
      .filter((id): id is number => id !== undefined)
      .join(',');
  }

  async quotes(symbols: string[]): Promise<TokenQuote[]> {
    const ids = this.idsFor(symbols);
    if (!ids) {
      this.warn('cmc.quotes', `no CMC ids mapped for: ${symbols.join(',')}`);
      return symbols.map((s) => ({ symbol: s, priceUsd: 0, asOf: new Date().toISOString() }));
    }
    const text = await this.call('get_crypto_quotes_latest', { id: ids });
    const out = parseQuotes(text, symbols);
    if (out.every((q) => q.priceUsd === 0)) this.warn('cmc.quotes', 'all quotes parsed to $0 — bad/changed CMC payload', text);
    return out;
  }

  async technicals(symbol: string): Promise<TechnicalSnapshot> {
    const id = CMC_ID[symbol.toUpperCase()];
    if (id === undefined) return { symbol, asOf: new Date().toISOString() };
    const text = await this.call('get_crypto_technical_analysis', { id: String(id) });
    const snap = parseTechnicals(text, symbol);
    if (snap.rsi14 === undefined && !snap.macd) this.warn('cmc.technicals', `no RSI/MACD parsed for ${symbol}`, text);
    return snap;
  }

  async global(): Promise<GlobalSnapshot> {
    const [g, d] = await Promise.all([
      this.call('get_global_metrics_latest', {}),
      this.call('get_global_crypto_derivatives_metrics', {}).catch(() => ''),
    ]);
    const snap = parseGlobal(g, d);
    if (snap.fearGreed === undefined && snap.altcoinSeason === undefined && !snap.derivatives) {
      this.warn('cmc.global', 'no regime inputs parsed — bad/changed CMC payload', g);
    }
    return snap;
  }
}

export class CmcApiKeyData extends CmcBase {
  readonly name = 'cmc-mcp-apikey';
  constructor(
    private readonly cfg: Config,
    private readonly apiKey: string,
    ledger?: Ledger,
  ) {
    super(ledger);
  }

  protected async call(tool: string, args: Record<string, unknown>): Promise<string> {
    const res = await fetch(this.cfg.data.cmcMcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'X-CMC-MCP-API-KEY': this.apiKey,
      },
      body: JSON.stringify(mcpEnvelope(tool, args)),
    });
    if (!res.ok) throw new Error(`CMC MCP HTTP ${res.status}`);
    return extractText((await res.json()) as McpToolResult);
  }
}

export class CmcX402Data extends CmcBase {
  readonly name = 'cmc-x402-rest';
  constructor(
    private readonly cfg: Config,
    private readonly twak: TwakCli,
    ledger: Ledger,
  ) {
    super(ledger);
  }

  private async paidGet(path: string, params: Record<string, string>, tool: string): Promise<unknown> {
    const url = cmcRestUrl(this.cfg.data.cmcX402RestBase, path, params);
    const out = await this.twak.run<unknown>([
      'x402', 'request', url,
      '--max-payment', this.cfg.data.x402MaxPaymentAtomic,
      '--prefer-network', 'base',
      '--yes',
    ]);
    const status = asRecord(out)?.status;
    this.ledger?.append('x402_payment', {
      tool,
      transport: 'cmc-rest-x402',
      endpoint: path,
      maxPaymentAtomic: this.cfg.data.x402MaxPaymentAtomic,
      network: 'base',
      ...(status ? { status } : {}),
    });
    return unwrapCmcRest(out);
  }

  async technicals(symbol: string): Promise<TechnicalSnapshot> {
    return { symbol, asOf: new Date().toISOString() };
  }

  protected async call(tool: string, args: Record<string, unknown>): Promise<string> {
    if (tool === 'get_crypto_quotes_latest') {
      const id = String(args.id ?? '');
      const data = await this.paidGet('/v3/cryptocurrency/quotes/latest', {
        id,
      }, tool);
      return JSON.stringify(restQuoteRows(data));
    }

    if (tool === 'get_global_metrics_latest') {
      const data = await this.paidGet('/v3/cryptocurrency/listings/latest', {}, tool);
      return JSON.stringify(listingsGlobalProxy(data));
    }

    if (tool === 'get_crypto_technical_analysis') {
      // CMC's documented x402 REST endpoints do not expose the MCP technical-analysis
      // tool. Return an empty technical payload rather than inventing RSI/MACD.
      return JSON.stringify({});
    }

    if (tool === 'get_global_crypto_derivatives_metrics') {
      // No x402 REST equivalent today. Derivatives are advisory only and optional.
      return JSON.stringify({});
    }

    throw new Error(`CMC x402 REST: unsupported MCP tool mapping: ${tool}`);
  }
}

// ---------- Parsers (pinned to the live CMC Agent Hub payloads, 2026-06-13) ----------

/**
 * CMC mixes raw numbers and formatted strings in the same payloads:
 *   1.3464 | "45.53" | "+58.6%" | "0.00025896" | "372.73 B" | "2.19 T"
 * Normalise all of them to a plain number (sign/percent stripped, K/M/B/T expanded).
 */
export function parseNum(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v !== 'string') return undefined;
  const s = v.trim().replace(/[+%,]/g, '');
  const m = s.match(/^(-?\d*\.?\d+)\s*([KMBT])?$/i);
  if (!m) {
    const n = Number(s);
    return Number.isFinite(n) ? n : undefined;
  }
  let n = Number(m[1]);
  const mult: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  if (m[2]) n *= mult[m[2].toUpperCase()] ?? 1;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * get_crypto_quotes_latest returns TWO shapes depending on id count:
 *   - multiple ids → column table: { headers:["id","name","symbol","price",...], rows:[[...]] }
 *   - single id    → array of row-objects: [{ id, symbol, price, percent_change_24h, ... }]
 * Handle both, else single-token requests (e.g. paper mark-to-market) silently parse to $0.
 */
export function parseQuotes(text: string, symbols: string[]): TokenQuote[] {
  const asOf = new Date().toISOString();
  const mk = (symbol: string, price: unknown, pct: unknown, vol: unknown, mc: unknown): TokenQuote => {
    const q: TokenQuote = { symbol: symbol.toUpperCase(), priceUsd: parseNum(price) ?? 0, asOf };
    const p = parseNum(pct);
    if (p !== undefined) q.pctChange24h = p;
    const v = parseNum(vol);
    if (v !== undefined) q.volume24h = v;
    const m = parseNum(mc);
    if (m !== undefined) q.marketCap = m;
    return q;
  };
  try {
    const j = JSON.parse(text) as unknown;
    const bySym = new Map<string, TokenQuote>();

    if (Array.isArray(j)) {
      for (const r of j as Array<Record<string, unknown>>) {
        const sym = String(r.symbol ?? '');
        if (sym) bySym.set(sym.toUpperCase(), mk(sym, r.price, r.percent_change_24h, r.volume_24h, r.market_cap));
      }
    } else {
      const o = j as { headers?: unknown; rows?: unknown };
      const headers = o.headers as string[] | undefined;
      const rows = o.rows as unknown[][] | undefined;
      if (!Array.isArray(headers) || !Array.isArray(rows)) throw new Error('unrecognized quotes shape');
      const c = {
        sym: headers.indexOf('symbol'),
        price: headers.indexOf('price'),
        pct: headers.indexOf('percent_change_24h'),
        vol: headers.indexOf('volume_24h'),
        mc: headers.indexOf('market_cap'),
      };
      for (const row of rows) {
        const sym = String(row[c.sym] ?? '');
        if (sym) bySym.set(sym.toUpperCase(), mk(sym, row[c.price], row[c.pct], row[c.vol], row[c.mc]));
      }
    }

    // Preserve the requested order; surface a zero-price stub for anything missing.
    return symbols.map((s) => bySym.get(s.toUpperCase()) ?? { symbol: s, priceUsd: 0, asOf });
  } catch {
    return symbols.map((s) => ({ symbol: s, priceUsd: 0, asOf }));
  }
}

/**
 * get_crypto_technical_analysis returns:
 *   { moving_averages:{ exponential_moving_average_30_day:"1.37", ..._200_day:"1.65", ... },
 *     macd:{ macdLine:"-0.0426", signalLine:"-0.0473", histogram:"0.0047" },
 *     rsi:{ rsi7, rsi14:"45.53", rsi21 }, fibonacciLevels, pivotPoint }
 */
export function parseTechnicals(text: string, symbol: string): TechnicalSnapshot {
  const asOf = new Date().toISOString();
  try {
    const d = JSON.parse(text) as Record<string, any>;
    const snap: TechnicalSnapshot = { symbol, asOf };
    const rsi14 = parseNum(d?.rsi?.rsi14);
    if (rsi14 !== undefined) snap.rsi14 = rsi14;
    const m = d?.macd;
    if (m) {
      const value = parseNum(m.macdLine);
      const signal = parseNum(m.signalLine);
      const histogram = parseNum(m.histogram);
      if (value !== undefined || signal !== undefined || histogram !== undefined) {
        snap.macd = { value: value ?? 0, signal: signal ?? 0, histogram: histogram ?? 0 };
      }
    }
    // CMC exposes 7/30/200-day EMAs. The domain type carries two slots; map the
    // 30-day to the short slot (ema20) and 200-day to the long slot (ema50) so the
    // strategist still sees a short-vs-long trend read. Values are LLM context only.
    const ma = d?.moving_averages;
    if (ma) {
      const eShort = parseNum(ma.exponential_moving_average_30_day);
      const eLong = parseNum(ma.exponential_moving_average_200_day);
      if (eShort !== undefined) snap.ema20 = eShort;
      if (eLong !== undefined) snap.ema50 = eLong;
    }
    return snap;
  } catch {
    return { symbol, asOf };
  }
}

/**
 * get_global_metrics_latest: { sentiment:{ fear_greed:{ current:{ index } } },
 *   rotation:{ altcoin_season:{ current:{ index } } }, dominance:{ btc:{ current:"+58.6%" } } }
 * get_global_crypto_derivatives_metrics: { fundingRate:{ current:"0.00025896" },
 *   totalOpenInterest:{ current:"372.73 B" } }
 */
export function parseGlobal(globalText: string, derivativesText: string): GlobalSnapshot {
  const asOf = new Date().toISOString();
  const out: GlobalSnapshot = { asOf };
  try {
    const g = JSON.parse(globalText) as Record<string, any>;
    const fg = parseNum(g?.sentiment?.fear_greed?.current?.index);
    if (fg !== undefined) out.fearGreed = fg;
    const alt = parseNum(g?.rotation?.altcoin_season?.current?.index);
    if (alt !== undefined) out.altcoinSeason = alt;
    const dom = parseNum(g?.dominance?.btc?.current);
    if (dom !== undefined) out.btcDominance = dom;
  } catch {
    /* keep defaults — regime degrades gracefully */
  }
  if (derivativesText) {
    try {
      const d = JSON.parse(derivativesText) as Record<string, any>;
      const fr = parseNum(d?.fundingRate?.current);
      const oi = parseNum(d?.totalOpenInterest?.current);
      const deriv: { aggOpenInterestUsd?: number; avgFundingRate?: number } = {};
      if (oi !== undefined) deriv.aggOpenInterestUsd = oi;
      if (fr !== undefined) deriv.avgFundingRate = fr;
      if (Object.keys(deriv).length) out.derivatives = deriv;
    } catch {
      /* sentiment thermometer unavailable — regime degrades gracefully */
    }
  }
  return out;
}
