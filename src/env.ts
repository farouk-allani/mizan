import { existsSync, readFileSync } from 'node:fs';

/**
 * Minimal, dependency-free `.env` loader.
 *
 * Loads `KEY=VALUE` lines into `process.env` so `node dist/index.js` (and `npm start`)
 * work without manually `source`-ing `.env` first — a common footgun, especially on the
 * VPS under systemd. Existing environment variables always win, so an explicitly-exported
 * value (or systemd `EnvironmentFile`) is never overridden.
 */
export function loadDotenv(path = process.env.MIZAN_ENV ?? '.env'): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || process.env[key] !== undefined) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}
