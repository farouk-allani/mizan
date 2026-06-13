import { Ledger } from './core/ledger.js';

const path = process.argv[2] ?? './data/ledger.jsonl';
const r = Ledger.verify(path);
if (r.ok) {
  console.log(`✅ ledger intact — ${r.entries} entries, hash chain verified (${path})`);
  process.exit(0);
}
console.error(`❌ ledger TAMPERED — chain broken at entry ${r.brokenAt} of ${r.entries} (${path})`);
process.exit(1);
