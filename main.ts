// Entry lifecycle for the github-core-clone-01 trial harness.
//
// The harness (the env) and this process meet over two calls, and this file owns
// only that meeting — the forge itself lives behind createApp() in app.ts:
//
//   1. Configuration comes from MAKEFUN_ENV_URL, the env's origin. If it is
//      missing or not a usable http(s) URL there is nobody to talk to, so the
//      process reports the problem on stderr and exits 1 before doing anything.
//   2. The forge binds port 0 and lets the kernel pick a free port. Port 8080
//      belongs to the env and is never touched.
//   3. The bound port is announced with POST <env>/register {"port": N}. The
//      env notes the peer address of that request and dials the pair from then
//      on. 200 means this process registered; 409 means a first registration
//      already won, which is equally fine — this process simply waits like any
//      other. 400/405 mean the request itself broke the contract and are fatal.
//      Anything else (a 5xx, a refused connection, a timeout) is retried with
//      a capped exponential backoff, because the env may still be starting.
//   4. GET <env>/done is polled until it answers {"done": true}. The env
//      answers immediately ({"done": false} while the suite runs), so polling
//      — not one long-held request — is the correct shape, and the process
//      never exits before that answer arrives.
//   5. On done, the forge is closed (with a bounded wait, so a lingering
//      connection cannot hang the shutdown) and the process exits 0.
//
// Diagnostics: the plain "[entry] ..." lines on stdout stay as the harness has
// always seen them; alongside them, every lifecycle transition is also written
// to stderr as one JSON object per line (event, timestamp, context) so a run
// can be followed mechanically. Retry noise is throttled: the first failure of
// a phase and every tenth after that are logged, plus the eventual success.
//
// This file imports its server factory and nothing else: no packages and no
// Node built-ins — fetch, timers and AbortSignal are runtime globals.

import { createApp } from './app.ts';

/** The forge's HTTP server, typed only through the factory that builds it. */
type ForgeServer = ReturnType<typeof createApp>;

// ---------------------------------------------------------------------------
// Structured lifecycle log (stderr, one JSON object per event)
// ---------------------------------------------------------------------------

/** Emit one lifecycle event as a JSON line on stderr. */
function logEvent(event: string, context: Readonly<Record<string, unknown>> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), component: 'entry', event, ...context });
  process.stderr.write(`${line}\n`);
}

/** The printable message of an unknown thrown value. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Everything the lifecycle needs, validated once at startup. */
interface LifecycleConfig {
  /** The env's origin, with no trailing slash. */
  readonly envUrl: string;
  /** How long a single register or done request may run before it is abandoned and retried. */
  readonly requestTimeoutMs: number;
  /** The first wait between two attempts of a phase. */
  readonly retryFirstMs: number;
  /** The longest wait between two attempts of a phase. */
  readonly retryMaxMs: number;
  /** How long shutdown waits for the server to close before giving up on it. */
  readonly closeTimeoutMs: number;
}

/** Print a configuration problem in the harness's plain format and exit 1. */
function failConfig(problem: string): never {
  process.stderr.write(`[entry] ${problem}\n`);
  logEvent('config.invalid', { problem });
  process.exit(1);
}

/**
 * Read and validate the environment. A missing MAKEFUN_ENV_URL is the failure
 * the starter always reported; a value that does not parse as an http(s) URL
 * can never be registered with either, so it fails the same way, at once,
 * instead of being retried forever.
 */
function readConfig(): LifecycleConfig {
  const raw = process.env.MAKEFUN_ENV_URL ?? '';
  const envUrl = raw.replace(/\/+$/, '');
  if (envUrl === '') {
    failConfig('MAKEFUN_ENV_URL is not set: there is no env to register with');
  }
  let parsed: URL;
  try {
    parsed = new URL(envUrl);
  } catch {
    failConfig(`MAKEFUN_ENV_URL is not a valid URL: ${JSON.stringify(raw)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    failConfig(`MAKEFUN_ENV_URL must be an http(s) URL, got protocol ${JSON.stringify(parsed.protocol)}`);
  }
  return {
    envUrl,
    requestTimeoutMs: 30_000,
    retryFirstMs: 250,
    retryMaxMs: 2_000,
    closeTimeoutMs: 5_000,
  };
}

// ---------------------------------------------------------------------------
// Retry timing
// ---------------------------------------------------------------------------

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `failures` consecutive failed attempts: doubles from the base, capped. */
function backoffMs(config: LifecycleConfig, failures: number): number {
  const grown = config.retryFirstMs * 2 ** Math.min(failures, 8);
  return Math.min(config.retryMaxMs, grown);
}

/** Whether a retry of attempt `failures` (0-based) is worth a log line. */
function retryWorthLogging(failures: number): boolean {
  return failures === 0 || (failures + 1) % 10 === 0;
}

// ---------------------------------------------------------------------------
// Phase 1: register the bound port with the env
// ---------------------------------------------------------------------------

/** A refusal that retrying cannot fix: the register request broke the contract. */
class RegisterRefused extends Error {}

/**
 * POST {"port": port} to the env until it accepts. Returns how the phase
 * ended: 'registered' on 200, 'already-registered' on 409 (a first register
 * won; this process then just waits like any other). 400 and 405 throw
 * RegisterRefused with the env's answer attached; every other outcome is
 * retried with backoff, since the env may still be starting.
 */
async function registerWithEnv(config: LifecycleConfig, port: number): Promise<'registered' | 'already-registered'> {
  let failures = 0;
  for (;;) {
    try {
      const res = await fetch(`${config.envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      if (res.status === 200) return 'registered';
      if (res.status === 409) return 'already-registered';
      if (res.status === 400 || res.status === 405) {
        throw new RegisterRefused(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
      // Any other status is the env not being ready yet; drain the body so
      // the connection can be reused, then fall through to the retry wait.
      await res.text().catch(() => undefined);
      if (retryWorthLogging(failures)) {
        logEvent('register.retry', { attempt: failures + 1, reason: `HTTP ${res.status}` });
      }
    } catch (err) {
      if (err instanceof RegisterRefused) throw err;
      if (retryWorthLogging(failures)) {
        logEvent('register.retry', { attempt: failures + 1, reason: messageOf(err) });
      }
    }
    await pause(backoffMs(config, failures));
    failures += 1;
  }
}

// ---------------------------------------------------------------------------
// Phase 2: wait until the env says the trial is done
// ---------------------------------------------------------------------------

/**
 * Poll GET /done until the body is {"done": true}; never return before that.
 * A poll that fails (env unreachable, slow, or a non-OK status) simply means
 * "not done yet" and is retried with backoff; only the true answer ends the
 * wait.
 */
async function waitForTrialEnd(config: LifecycleConfig): Promise<void> {
  let failures = 0;
  for (;;) {
    let done = false;
    try {
      const res = await fetch(`${config.envUrl}/done`, {
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        done = body.done === true;
      } else if (retryWorthLogging(failures)) {
        logEvent('done.retry', { attempt: failures + 1, reason: `HTTP ${res.status}` });
      }
    } catch (err) {
      if (retryWorthLogging(failures)) {
        logEvent('done.retry', { attempt: failures + 1, reason: messageOf(err) });
      }
    }
    if (done) return;
    await pause(backoffMs(config, failures));
    failures += 1;
  }
}

// ---------------------------------------------------------------------------
// Server bind and shutdown
// ---------------------------------------------------------------------------

/**
 * Bind the forge on an ephemeral port and return the chosen port. A bind
 * failure is wrapped with its phase named, so the fatal report says what
 * actually went wrong.
 */
async function startListening(server: ForgeServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      reject(new Error(`the forge could not bind an ephemeral port: ${err.message}`));
    };
    server.once('error', onError);
    server.listen(0, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the forge bound without an ephemeral TCP port');
  }
  return address.port;
}

/**
 * Close the forge, waiting at most closeTimeoutMs. A close error or a timeout
 * is logged, never fatal: the trial is already over, and the exit code must
 * stay 0.
 */
async function stopListening(server: ForgeServer, closeTimeoutMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const timer = setTimeout(() => {
      logEvent('shutdown.close_timeout', { closeTimeoutMs });
      finish();
    }, closeTimeoutMs);
    server.close((err) => {
      clearTimeout(timer);
      if (err !== undefined) {
        logEvent('shutdown.close_error', { message: err.message });
      }
      finish();
    });
  });
}

// ---------------------------------------------------------------------------
// The lifecycle itself
// ---------------------------------------------------------------------------

/** Config, bind, register, wait for done, close: the whole life of the process. */
async function lifecycle(): Promise<void> {
  const config = readConfig();
  logEvent('startup', { envUrl: config.envUrl });

  const server = createApp();
  const port = await startListening(server);
  process.stdout.write(`[entry] listening on port ${port}\n`);
  logEvent('listening', { port });

  const registration = await registerWithEnv(config, port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');
  logEvent('registered', { outcome: registration });

  await waitForTrialEnd(config);
  logEvent('done.received', {});

  await stopListening(server, config.closeTimeoutMs);
  process.stdout.write('[entry] done\n');
  logEvent('shutdown.complete', {});
}

try {
  await lifecycle();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${messageOf(err)}\n`);
  logEvent('fatal', { message: messageOf(err) });
  process.exit(1);
}
