/**
 * BNB Hack Track 1 — eligible BEP-20 token allowlist (from the official brief).
 * Trades outside this list DO NOT COUNT toward competition scoring, so the
 * Sentinel treats any symbol outside this set as a hard rejection.
 *
 * ⚠️ OPERATIONAL WARNING — symbol ambiguity:
 * Single-letter symbols (B, H, M, Q, U) and generic ones (HOME, REAL, OPEN, BILL)
 * are dangerously collision-prone in DEX routing. Before the live window, pin
 * BSC contract addresses for every symbol the strategy can actually touch via
 * CONTRACT_PINS below, and verify each with `twak swap ... --quote-only`.
 * The Sentinel refuses to trade an ambiguous symbol that has no pinned address.
 */

export const COMPETITION_ALLOWLIST: ReadonlySet<string> = new Set([
  'ETH', 'USDT', 'USDC', 'XRP', 'TRX', 'DOGE', 'ZEC', 'ADA', 'LINK', 'BCH',
  'DAI', 'TON', 'USD1', 'USDe', 'M', 'LTC', 'AVAX', 'SHIB', 'XAUt', 'WLFI',
  'H', 'DOT', 'UNI', 'ASTER', 'DEXE', 'USDD', 'ETC', 'AAVE', 'ATOM', 'U',
  'STABLE', 'FIL', 'INJ', '币安人生', 'NIGHT', 'FET', 'TUSD', 'BONK', 'PENGU',
  'CAKE', 'SIREN', 'LUNC', 'ZRO', 'KITE', 'FDUSD', 'BEAT', 'PIEVERSE', 'BTT',
  'NFT', 'EDGE', 'FLOKI', 'LDO', 'B', 'FF', 'PENDLE', 'NEX', 'STG', 'AXS',
  'TWT', 'HOME', 'RAY', 'COMP', 'GWEI', 'XCN', 'GENIUS', 'XPL', 'BAT',
  'SKYAI', 'APE', 'IP', 'SFP', 'TAG', 'NXPC', 'AB', 'SAHARA', '1INCH',
  'CHEEMS', 'BANANAS31', 'RIVER', 'MYX', 'RAVE', 'SNX', 'FORM', 'LAB', 'HTX',
  'USDf', 'CTM', 'BDX', 'SLX', 'UB', 'DUCKY', 'FRAX', 'BILL', 'WFI', 'KOGE',
  'ALE', 'FRXUSD', 'USDF', 'GOMINING', 'VCNT', 'GUA', 'DUSD', 'SMILEK', '0G',
  'BEAM', 'MY', 'SOON', 'REAL', 'Q', 'AIOZ', 'ZIG', 'YFI', 'TAC', 'lisUSD',
  'CYS', 'ZAMA', 'TRIA', 'HUMA', 'PLUME', 'ZIL', 'XPR', 'ZETA', 'BabyDoge',
  'NILA', 'ROSE', 'VELO', 'UAI', 'BRETT', 'OPEN', 'BSB', 'TOSHI', 'BAS',
  'ACH', 'AXL', 'LUR', 'ELF', 'KAVA', 'APR', 'IRYS', 'EURI', 'XUSD', 'BARD',
  'DUSK', 'SUSHI', 'PEAQ', 'COAI', 'BDCA', 'XAUM',
]);

/** Symbols too ambiguous to trade without a pinned BSC contract address. */
export const AMBIGUOUS_SYMBOLS: ReadonlySet<string> = new Set([
  'B', 'H', 'M', 'Q', 'U', 'AB', 'FF', 'MY', 'UB', 'HOME', 'REAL', 'OPEN',
  'BILL', 'STABLE', 'NFT', 'EDGE', 'TAG', 'LAB', 'BEAT', 'NIGHT', 'GWEI',
  'GENIUS', 'SOON', 'RIVER', 'RAVE', 'ALE', 'GUA', 'BAS', 'APR', 'FORM', 'IP',
]);

/**
 * BSC contract address pins. Populate during the build window:
 *   1. Look the token up on CoinMarketCap → BNB Smart Chain contract.
 *   2. Verify route: `twak swap 5 USDT <address> --chain bsc --quote-only --json`
 *   3. Pin it here. Sentinel allows ambiguous symbols only when pinned.
 */
export const CONTRACT_PINS: Readonly<Record<string, string>> = {
  // CAKE — PancakeSwap (verify before live week):
  // CAKE: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
};

export function isEligible(symbol: string): boolean {
  return COMPETITION_ALLOWLIST.has(symbol);
}

export function tradableIdentifier(symbol: string): { ok: true; id: string } | { ok: false; reason: string } {
  if (!isEligible(symbol)) return { ok: false, reason: `${symbol} is not in the competition allowlist` };
  const pin = CONTRACT_PINS[symbol];
  if (pin) return { ok: true, id: pin };
  if (AMBIGUOUS_SYMBOLS.has(symbol)) {
    return { ok: false, reason: `${symbol} is ambiguous and has no pinned BSC contract address` };
  }
  return { ok: true, id: symbol };
}
