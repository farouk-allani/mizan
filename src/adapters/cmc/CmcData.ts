import { randomUUID } from 'node:crypto';
import type { Config } from '../../config.js';
import type { GlobalSnapshot, TechnicalSnapshot, TokenQuote } from '../../core/types.js';
import type { MarketDataProvider } from '../../ports/index.js';
import { TwakCli } from '../twak/cli.js';
import type { Ledger } from '../../core/ledger.js';

/**
 * CMC Agent Hub data, two transports behind one port:
 *
 *  - CmcApiKeyData : direct MCP-over-HTTP with X-CMC-MCP-API-KEY (free tier; dev/build window)
 *  - CmcX402Data   : the SAME MCP tools via mcp.coinmarketcap.com/x402/mcp, paid 0.01 USDC
 *                    per call THROUGH twak's x402 client — the agent funds its own data
 *                    inside the trade loop (TWAK prize, "native x402" criterion).
 *
 * Both speak MCP JSON-RPC `tools/call` over streamable HTTP. Tool names verified
 * against the CMC MCP page: get_crypto_quotes_latest, get_crypto_technical_analysis,
 * get_global_metrics_latest, get_global_crypto_derivatives_metrics, ...
 */

interface McpToolResult {
  result?: { content?: Array<{ type: string; text?: string }> };
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
  return text;
}

/** Shared response→domain mapping. CMC returns LLM-friendly text/JSON; parse defensively. */
abstract class CmcBase implements MarketDataProvider {
  abstract readonly name: string;
  protected abstract call(tool: string, args: Record<string, unknown>): Promise<string>;

  async quotes(symbols: string[]): Promise<TokenQuote[]> {
    const text = await this.call('get_crypto_quotes_latest', { symbol: symbols.join(',') });
    return parseQuotes(text, symbols);
  }

  async technicals(symbol: string): Promise<TechnicalSnapshot> {
    const text = await this.call('get_crypto_technical_analysis', { symbol });
    return parseTechnicals(text, symbol);
  }

  async global(): Promise<GlobalSnapshot> {
    const [g, d] = await Promise.all([
      this.call('get_global_metrics_latest', {}),
      this.call('get_global_crypto_derivatives_metrics', {}).catch(() => ''),
    ]);
    return parseGlobal(g, d);
  }
}

export class CmcApiKeyData extends CmcBase {
  readonly name = 'cmc-mcp-apikey';
  constructor(
    private readonly cfg: Config,
    private readonly apiKey: string,
  ) {
    super();
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
  readonly name = 'cmc-mcp-x402';
  constructor(
    private readonly cfg: Config,
    private readonly twak: TwakCli,
    private readonly ledger: Ledger,
  ) {
    super();
  }

  protected async call(tool: string, args: Record<string, unknown>): Promise<string> {
    // twak x402 request handles: 402 challenge -> sign EIP-3009/Permit2 -> retry.
    // --prefer-network bsc keeps settlement on BSC; --yes auto-confirms within cap.
    const out = await this.twak.run<{ status?: number; body?: unknown } & Record<string, unknown>>([
      'x402', 'request', this.cfg.data.cmcX402Url,
      '--method', 'POST',
      '--body', JSON.stringify(mcpEnvelope(tool, args)),
      '--max-payment', this.cfg.data.x402MaxPaymentAtomic,
      '--prefer-network', 'bsc',
      '--yes',
    ]);
    this.ledger.append('x402_payment', { tool, maxPaymentAtomic: this.cfg.data.x402MaxPaymentAtomic });
    const body = (out.body ?? out) as McpToolResult;
    return extractText(body);
  }
}

// ---------- Defensive parsers (tighten on day 1 against real payloads) ----------

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function parseQuotes(text: string, symbols: string[]): TokenQuote[] {
  const asOf = new Date().toISOString();
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const data = (j.data ?? j) as Record<string, unknown>;
    return symbols.map((s) => {
      const entryRaw = data[s];
      const entry = (Array.isArray(entryRaw) ? entryRaw[0] : entryRaw) as Record<string, unknown> | undefined;
      const quoteUsd = ((entry?.quote as Record<string, unknown> | undefined)?.USD ?? entry) as
        | Record<string, unknown>
        | undefined;
      return {
        symbol: s,
        priceUsd: num(quoteUsd?.price) ?? 0,
        ...(num(quoteUsd?.percent_change_24h) !== undefined && { pctChange24h: num(quoteUsd?.percent_change_24h)! }),
        ...(num(quoteUsd?.volume_24h) !== undefined && { volume24h: num(quoteUsd?.volume_24h)! }),
        ...(num(quoteUsd?.market_cap) !== undefined && { marketCap: num(quoteUsd?.market_cap)! }),
        asOf,
      };
    });
  } catch {
    return symbols.map((s) => ({ symbol: s, priceUsd: 0, asOf }));
  }
}

export function parseTechnicals(text: string, symbol: string): TechnicalSnapshot {
  const asOf = new Date().toISOString();
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const d = (j.data ?? j) as Record<string, unknown>;
    const macd = d.macd as Record<string, unknown> | undefined;
    return {
      symbol,
      ...(num(d.rsi ?? d.rsi14) !== undefined && { rsi14: num(d.rsi ?? d.rsi14)! }),
      ...(macd && {
        macd: {
          value: num(macd.value) ?? 0,
          signal: num(macd.signal) ?? 0,
          histogram: num(macd.histogram) ?? 0,
        },
      }),
      ...(num(d.ema20) !== undefined && { ema20: num(d.ema20)! }),
      ...(num(d.ema50) !== undefined && { ema50: num(d.ema50)! }),
      asOf,
    };
  } catch {
    return { symbol, asOf };
  }
}

export function parseGlobal(globalText: string, derivativesText: string): GlobalSnapshot {
  const asOf = new Date().toISOString();
  const out: GlobalSnapshot = { asOf };
  try {
    const g = JSON.parse(globalText) as Record<string, unknown>;
    const d = (g.data ?? g) as Record<string, unknown>;
    const fg = num(d.fear_and_greed ?? d.fearGreed ?? (d.fear_greed as Record<string, unknown> | undefined)?.value);
    if (fg !== undefined) out.fearGreed = fg;
    const dom = num(d.btc_dominance ?? d.btcDominance);
    if (dom !== undefined) out.btcDominance = dom;
    const alt = num(d.altcoin_season ?? d.altcoinSeason);
    if (alt !== undefined) out.altcoinSeason = alt;
  } catch {
    /* keep defaults */
  }
  if (derivativesText) {
    try {
      const j = JSON.parse(derivativesText) as Record<string, unknown>;
      const d = (j.data ?? j) as Record<string, unknown>;
      const oi = num(d.open_interest_usd ?? d.openInterestUsd);
      const fr = num(d.avg_funding_rate ?? d.avgFundingRate);
      out.derivatives = {
        ...(oi !== undefined && { aggOpenInterestUsd: oi }),
        ...(fr !== undefined && { avgFundingRate: fr }),
      };
    } catch {
      /* sentiment thermometer unavailable — regime degrades gracefully */
    }
  }
  return out;
}
