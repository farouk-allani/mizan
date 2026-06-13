import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import type { AgentState, LedgerEntry } from './types.js';

/**
 * Tamper-evident audit ledger.
 *
 * Every decision, data fetch, verdict, execution and x402 payment is appended
 * as a JSONL entry whose hash chains to the previous entry — the same idea as
 * MIZAN's spiritual ancestor (YieldMind's HCS decision log), without needing a
 * second chain. Judges can verify the file with `npm run verify-ledger`.
 */
export class Ledger {
  private lastHash = 'GENESIS';

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
      const last = lines.at(-1);
      if (last) this.lastHash = (JSON.parse(last) as LedgerEntry).hash;
    }
  }

  append(type: LedgerEntry['type'], payload: unknown): LedgerEntry {
    const ts = new Date().toISOString();
    const body = JSON.stringify({ ts, type, payload });
    const hash = createHash('sha256').update(this.lastHash + body).digest('hex');
    const entry: LedgerEntry = { ts, type, payload, prevHash: this.lastHash, hash };
    appendFileSync(this.path, JSON.stringify(entry) + '\n');
    this.lastHash = hash;
    return entry;
  }

  static verify(path: string): { ok: boolean; entries: number; brokenAt?: number } {
    if (!existsSync(path)) return { ok: true, entries: 0 };
    const lines = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean);
    let prev = 'GENESIS';
    for (let i = 0; i < lines.length; i++) {
      const e = JSON.parse(lines[i]!) as LedgerEntry;
      const body = JSON.stringify({ ts: e.ts, type: e.type, payload: e.payload });
      const expect = createHash('sha256').update(prev + body).digest('hex');
      if (e.prevHash !== prev || e.hash !== expect) return { ok: false, entries: lines.length, brokenAt: i };
      prev = e.hash;
    }
    return { ok: true, entries: lines.length };
  }
}

// ---------- Agent state persistence ----------

const DEFAULT_STATE: AgentState = {
  equityHighWaterUsd: 0,
  lastEquityUsd: 0,
  tradesToday: 0,
  notionalTodayUsd: 0,
  dayKey: new Date().toISOString().slice(0, 10),
  flattened: false,
};

export function loadState(path: string): AgentState {
  if (!existsSync(path)) return { ...DEFAULT_STATE };
  return { ...DEFAULT_STATE, ...(JSON.parse(readFileSync(path, 'utf8')) as Partial<AgentState>) };
}

export function saveState(path: string, state: AgentState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}
