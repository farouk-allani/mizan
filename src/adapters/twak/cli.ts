import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

export interface TwakOptions {
  bin: string;
  timeoutMs: number;
  /** Name of env var holding the wallet password (never passed as a CLI flag —
   *  twak itself warns that --password leaks into shell history). */
  walletPasswordEnv: string;
}

export class TwakError extends Error {
  constructor(
    message: string,
    public readonly errorCode: string,
    public readonly stderr?: string,
  ) {
    super(message);
  }
}

/**
 * Thin, typed wrapper over the twak CLI.
 * Every call uses --json; per the CLI reference, stdout carries ONLY the JSON
 * object while progress/warnings go to stderr — so parsing stdout is safe.
 */
export class TwakCli {
  constructor(private readonly opts: TwakOptions) {}

  async run<T>(args: string[]): Promise<T> {
    const env = { ...process.env };
    // TWAK resolves password: --password -> TWAK_WALLET_PASSWORD -> OS keychain.
    // We rely on the env var path; map from configured env var name if custom.
    const pw = process.env[this.opts.walletPasswordEnv];
    if (pw) env.TWAK_WALLET_PASSWORD = pw;

    // On Windows the global `twak` is a .cmd shim, and Node 22 refuses to spawn .cmd
    // without a shell (EINVAL). We enable a shell on win32 only — but a shell mangles
    // args containing spaces/quotes, so we refuse those loudly rather than risk
    // mis-executing a real trade. The only such arg is x402's JSON --body, which runs
    // live on the Linux VPS (shell off, fully safe). See RUNBOOK2 §8.
    const isWin = process.platform === 'win32';
    if (isWin && args.some((a) => /[\s"'^&|<>%]/.test(a))) {
      throw new TwakError(
        'twak call has shell-unsafe args; native Windows cannot run this safely (the twak.cmd ' +
          'shim needs a shell). Run MIZAN on Linux / WSL / the VPS for live mode + x402.',
        'WINDOWS_SHELL_UNSAFE',
      );
    }

    try {
      const { stdout } = await pExecFile(this.opts.bin, [...args, '--json'], {
        timeout: this.opts.timeoutMs,
        env,
        maxBuffer: 8 * 1024 * 1024,
        shell: isWin,
      });
      const parsed = JSON.parse(stdout.trim()) as T & { error?: string; errorCode?: string };
      if (parsed && typeof parsed === 'object' && 'errorCode' in parsed && parsed.errorCode) {
        throw new TwakError(parsed.error ?? 'twak error', parsed.errorCode);
      }
      return parsed;
    } catch (e) {
      if (e instanceof TwakError) throw e;
      const err = e as { stdout?: string; stderr?: string; message?: string };
      // twak exits 1 with the JSON error envelope still on stdout
      if (err.stdout) {
        try {
          const env2 = JSON.parse(err.stdout.trim()) as { error?: string; errorCode?: string };
          if (env2.errorCode) throw new TwakError(env2.error ?? 'twak error', env2.errorCode, err.stderr);
        } catch (inner) {
          if (inner instanceof TwakError) throw inner;
        }
      }
      throw new TwakError(err.message ?? 'twak invocation failed', 'PROCESS_ERROR', err.stderr);
    }
  }
}

// ---------- Typed command surfaces (verified against tw-agent-skills references) ----------

export interface SwapQuoteOut {
  input: string;
  output: string;
  minReceived?: string;
  provider: string;
  priceImpact: string;
  networkFee?: string;
  steps?: number;
}

export interface SwapExecOut extends SwapQuoteOut {
  hash: string;
  fromChain: string;
  toChain: string;
  explorer: string;
}

export interface CompeteStatusOut {
  registered: boolean;
  participant: string;
  opensAt: string;
  deadline: string;
  open: boolean;
  secondsRemaining: number;
  chain: 'bsc';
}

export interface PriceOut {
  token: string;
  chain: string;
  priceUsd: number;
}
