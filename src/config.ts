import { readFileSync } from 'node:fs';
import { z } from 'zod';
import YAML from 'yaml';

/**
 * MIZAN configuration.
 *
 * Design intent: *compliance and risk are config-load-time invariants*, not
 * runtime opinions. If `compliance.halalMode` is true, the perps venue cannot
 * be enabled — the config simply refuses to load. The LLM never sees a world
 * in which derivatives are an option.
 */

const VenueToggle = z.object({
  enabled: z.boolean(),
});

export const ConfigSchema = z
  .object({
    mode: z.enum(['paper', 'live']).default('paper'),
    chain: z.literal('bsc').default('bsc'),

    compliance: z.object({
      /** Spot-only, no leverage, no interest-bearing instruments. */
      halalMode: z.boolean().default(true),
    }),

    venues: z.object({
      spot: VenueToggle, // TwakSpotVenue
      perps: VenueToggle, // reserved — no implementation ships; see ARCHITECTURE.md
    }),

    loop: z.object({
      intervalMinutes: z.number().int().min(1).max(240).default(15),
      /** Stop file: if this path exists, the loop exits before the next cycle. */
      killSwitchPath: z.string().default('./KILL'),
    }),

    risk: z.object({
      /** Hard cap per trade as a fraction of current equity (enables concentrated entries). */
      maxTradePctOfEquity: z.number().min(0.001).max(0.5).default(0.25),
      maxTradesPerDay: z.number().int().min(1).default(6),
      maxDailyNotionalPctOfEquity: z.number().min(0.01).max(3).default(0.8),
      /**
       * Soft circuit breaker: flatten to stable WELL BEFORE the competition's
       * disqualification threshold (~30%). Disqualification is the only
       * unrecoverable outcome.
       */
      maxDrawdownPct: z.number().min(0.05).max(0.29).default(0.18),
      /**
       * Permanent hard-stop, measured against the ALL-TIME equity peak (not the re-armable
       * soft reference). Sits below the ~30% disqualification gate. Once breached the agent
       * flattens and never re-risks — this bounds the cumulative damage soft re-arms could stack.
       */
      hardStopDrawdownPct: z.number().min(0.05).max(0.29).default(0.25),
      /** Hours the soft breaker stays flat before re-arming and allowing redeployment. */
      breakerRearmHours: z.number().min(0).default(8),
      maxSlippagePct: z.number().min(0.1).max(5).default(1.0),
      cooldownMinutes: z.number().int().min(0).default(45),
      /** Minimum time before reversing the previous pair (discretionary trades only — a
       *  protective `risk_exit` is exempt, like the breaker). */
      minHoldMinutes: z.number().int().min(0).default(90),
      /**
       * Anti-whipsaw: after a protective `risk_exit`, stand down from new entries/rotations
       * for this long. Stops the offense from re-deploying into the same chop that just
       * stopped us out. The dominant anti-churn guard once a position has been exited.
       */
      reentryCooldownMinutes: z.number().int().min(0).default(180),
      /**
       * DEFENSE: trailing stop. Exit the held position once its mark falls this fraction
       * below the peak seen since entry. The core let-winners-run protection.
       */
      trailingStopPct: z.number().min(0.01).max(0.5).default(0.08),
      /**
       * OFFENSE anti-churn: only rotate the held token into a different one when the new
       * candidate's momentum+technical score beats the held score by more than this margin
       * (sized to cover the ~1% round-trip cost). Prevents flip-flopping between near-ties.
       */
      switchMarginScore: z.number().min(0).default(4),
      /** Target ceiling on total volatile exposure — "concentrated but clamped". */
      maxVolatilePctOfEquity: z.number().min(0.05).max(1).default(0.6),
      /** Never let portfolio approach the $1 dust rule. */
      minPortfolioUsd: z.number().min(1).default(25),
      /** Symbol the breaker flattens into. Must be in the allowlist. */
      stableSymbol: z.string().default('USDT'),
    }),

    heartbeat: z.object({
      /** Competition requires >= 1 trade/day. Fire a tiny stable<->stable-adjacent
       *  rotation if nothing traded by this UTC hour. */
      enabled: z.boolean().default(true),
      deadlineUtcHour: z.number().int().min(0).max(23).default(20),
      usdNotional: z.number().min(1).default(5),
      toSymbol: z.string().default('CAKE'),
    }),

    data: z.object({
      /** 'apikey' (dev, free tier) | 'x402' (live week — pays per call, scores the prize). */
      cmcTransport: z.enum(['apikey', 'x402']).default('apikey'),
      cmcMcpUrl: z.string().url().default('https://mcp.coinmarketcap.com/mcp'),
      /** MCP x402 endpoint kept for manual diagnostics; TWAK live mode uses cmcX402RestBase. */
      cmcX402Url: z.string().url().default('https://mcp.coinmarketcap.com/x402/mcp'),
      /**
       * REST x402 base, used by the LIVE transport. The MCP x402 endpoint can't be used
       * from twak (MCP-over-HTTP requires an `Accept: …text/event-stream` header twak
       * doesn't send → HTTP 400); CMC's plain REST x402 resources have no such requirement
       * and work with `twak x402 request`. Settles on Base USDC.
       */
      cmcX402RestBase: z.string().url().default('https://pro-api.coinmarketcap.com/x402'),
      /** Max x402 payment per call, atomic units (USDC 6dp): 0.01 USDC = "10000". */
      x402MaxPaymentAtomic: z.string().regex(/^\d+$/).default('10000'),
    }),

    llm: z.object({
      enabled: z.boolean().default(true),
      /** OpenAI-compatible endpoint — works with OpenRouter, MiMo, etc. */
      baseUrl: z.string().url(),
      model: z.string(),
      apiKeyEnv: z.string().default('LLM_API_KEY'),
      temperature: z.number().min(0).max(1).default(0.2),
    }),

    notify: z.object({
      telegram: z.object({
        enabled: z.boolean().default(false),
        botTokenEnv: z.string().default('TELEGRAM_BOT_TOKEN'),
        chatIdEnv: z.string().default('TELEGRAM_CHAT_ID'),
      }),
    }),

    twak: z.object({
      bin: z.string().default('twak'),
      walletPasswordEnv: z.string().default('TWAK_WALLET_PASSWORD'),
      timeoutMs: z.number().int().default(180_000),
    }),

    paths: z.object({
      ledger: z.string().default('./data/ledger.jsonl'),
      state: z.string().default('./data/state.json'),
      /** Virtual portfolio for paper mode (PnL simulation). Delete the file to reset PnL. */
      paperBook: z.string().default('./data/paper-book.json'),
    }),
  })
  .superRefine((cfg, ctx) => {
    if (cfg.compliance.halalMode && cfg.venues.perps.enabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['venues', 'perps', 'enabled'],
        message:
          'compliance.halalMode=true forbids enabling the perps venue. ' +
          'This is a load-time invariant, not a runtime check.',
      });
    }
    if (!cfg.venues.spot.enabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['venues', 'spot', 'enabled'],
        message: 'At least the spot venue must be enabled.',
      });
    }
    if (cfg.risk.hardStopDrawdownPct <= cfg.risk.maxDrawdownPct) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['risk', 'hardStopDrawdownPct'],
        message: 'hardStopDrawdownPct must exceed maxDrawdownPct (the permanent stop sits beyond the soft breaker).',
      });
    }
  });

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(path = process.env.MIZAN_CONFIG ?? './config/default.yaml'): Config {
  const raw = YAML.parse(readFileSync(path, 'utf8'));
  return ConfigSchema.parse(raw);
}
