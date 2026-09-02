/**
 * The composition SEQUENCE `main.ts` runs, extracted so it can be tested.
 *
 * Round-3 review R3-H1: `main.ts` connects and OWNS the Redis transport
 * BEFORE `DataGateway.create()` opens the WAL — and its fatal handler only
 * set `process.exitCode = 1`. A WAL that would not open therefore logged the
 * fatal error and then sat forever on the connected transport's referenced
 * socket: the mirror image of R2-H5 (that one exited when it should have
 * stayed alive; this one stayed alive when it should have exited).
 *
 * ## Startup is TRANSACTIONAL (the R3-H1 invariant)
 *
 * On ANY fatal startup error, every INDEPENDENT resource cleanup is
 * INITIATED — `gateway.stop()` starts its independent disposal families
 * together, so a cleanup that never settles cannot block a sibling's cleanup
 * from being called (round 6, M-1; the round-4 wording "every resource's
 * cleanup is CALLED" was false when an intermediate cleanup hung: sequential
 * awaits meant a hanging journal close left the transport close uncalled) —
 * `close` is initiated at most once per resource, and the process exits
 * nonzero: promptly when the cleanup calls complete, and at latest at the
 * cleanup deadline when one of them fails or hangs (round 4, below; the
 * round-3 wording "exits 1 promptly" silently assumed the cleanup calls
 * themselves succeed). A deadline expiry may leave the HUNG disposal
 * incomplete; every sibling was already initiated and given the chance to
 * settle, and every settled failure was already reported (`[disposal]`
 * lines via `GatewayObserver.onDisposalFailure`). Ownership is single and
 * explicit, which is what makes exactly-once checkable:
 *
 * - the TRANSPORT belongs to this sequence from the moment `connectTransport`
 *   resolves until `DataGateway.create()` returns; a failure in that window
 *   closes it here, and nothing else can (no signal handler is registered
 *   yet).
 * - once `create()` returns, the GATEWAY owns everything: the WAL journal,
 *   the transport (`stop()` closes both), and — from `start()` — the lifetime
 *   anchor. A failure after that point runs `gateway.stop()`, which is
 *   state-guarded (a second `stop()` returns before touching anything) and
 *   releases the lifetime handle at most once (`start()`'s release-on-throw
 *   clears the handle before this cleanup can see it).
 * - `create()` itself guarantees the same transactionality one level down:
 *   if it throws after opening the WAL journal, it closes the journal before
 *   the error escapes (`gateway.ts`) — and since round 5 (M-2) that internal
 *   close runs under the same fatal-startup deadline this sequence arms,
 *   supplied through the `CleanupDeadline` capability: a never-settling
 *   journal close used to leave `create()` pending forever, before this
 *   sequence's own catch (and therefore its deadline) could ever run.
 *
 * The signal path cannot race the fatal path: `SIGINT`/`SIGTERM` handlers are
 * registered only AFTER `start()` succeeds, at which point the fatal cleanup
 * below is unreachable — the two disposal paths are mutually exclusive by
 * construction, not by locking.
 *
 * ## The cleanup itself is guarded by a hard deadline (round 4)
 *
 * Transactional release assumed the cleanup CALLS complete. Round 4's finding:
 * a cleanup failure was only logged, and the original error was rethrown to a
 * handler that merely sets `process.exitCode = 1` — so a transport whose
 * `close()` rejected BEFORE releasing its referenced handle (or hung outright)
 * produced the fatal log and then the original hang shape, forever. Both
 * cleanup paths therefore arm a REFERENCED hard-deadline timer
 * (`host.armCleanupDeadline`, `cleanupDeadlineMs`, default
 * {@link DEFAULT_CLEANUP_DEADLINE_MS}) at cleanup entry:
 *
 * - cleanup COMPLETES → the deadline is cleared, and the normal exit codes
 *   are untouched (no stray referenced timer — the round-2 lesson).
 * - cleanup REJECTS or HANGS → the deadline is deliberately NOT cleared: a
 *   rejected close may still hold its referenced handle, so the expiry logs
 *   and forces a nonzero exit (`host.forceExit`). A cleanup that failed after
 *   releasing everything still exits nonzero the natural way — the armed
 *   deadline only bounds WHEN, never changes the code.
 *
 * The deadline belongs to BOTH paths — fatal startup AND signal shutdown —
 * because both funnel through the same disposal (`gateway.stop()`): a SIGTERM
 * whose `stop()` never resolves would wedge the process identically, and a
 * supervisor's kill-grace SIGKILL would only mask that defect (exit 137, no
 * evidence), not fix it. The invariant: on any fatal startup error the
 * process exits nonzero within one deadline of any cleanup hang or rejection
 * — including a hang inside `create()`'s own post-open cleanup (round 5,
 * M-2) — and on a shutdown signal the process exits within the deadline even
 * if `stop()` does not resolve. Every independent cleanup is INITIATED — a
 * disposal that hangs cannot block its sibling families, which `stop()`
 * starts together (round 6, M-1) — and every settled failure is reported at
 * collection time (`GatewayObserver.onDisposalFailure`); a forced exit at
 * deadline expiry may still leave the HUNG disposal itself incomplete, in
 * which case the WAL tail is crash-recovered on the next start (the WP-050
 * recovery shape) — the contract is bounded, initiated, evidenced cleanup,
 * never guaranteed release.
 *
 * ## Why a separate module
 *
 * The subprocess regression for R3-H1 needs a main-shaped composition whose
 * transport is CONNECTED and holds a referenced handle — which no closed
 * loopback port can produce and no real Redis is permitted to. The probe
 * entry (`./testing/fatal-startup-probe-entry.ts`) therefore runs THIS
 * function — the same code `main.ts` runs — substituting only the transport.
 * Everything impure stays injected: the host effects (`GatewayHost`) are
 * ports, so this module touches no runtime global and the `system.ts`
 * discipline survives.
 *
 * Safety: unchanged from `main.ts` — public unauthenticated data only, no
 * credential, no signer, no order path.
 */

import type { MarketEventTransport } from "@polymarket-bot/event-bus";

import type { GatewayConfig } from "./config.js";
import { GatewayConfigurationError } from "./errors.js";
import type { GatewayPorts } from "./gateway.js";
import { DataGateway } from "./gateway.js";
import type { CancelCleanupDeadline } from "./ports.js";
import { UnavailableEventTransport } from "./unavailable-transport.js";

export type { CancelCleanupDeadline } from "./ports.js";

/**
 * The composition root's process-level effects, as a port.
 *
 * `main.ts` passes `console.error`, `process.once`, and `process.exitCode`;
 * tests pass recorders. Kept minimal on purpose: this is not a general
 * process abstraction, it is exactly what the startup sequence needs.
 */
export interface GatewayHost {
  /** Operator-facing log line (the real host writes to stderr). */
  logError(line: string, detail?: unknown): void;
  /** Registers ONE handler for both shutdown signals, once each. */
  registerShutdownSignals(handler: () => void): void;
  /** Sets the process exit code for when the event loop drains. */
  setExitCode(code: number): void;
  /**
   * Arms the cleanup hard-deadline (round 4): runs `onExpiry` once after
   * `delayMs` unless the returned cancel is called first. The real host uses
   * a plain, NOT-unref'd `setTimeout` — the second deliberate exception to
   * the app's unref-everything policy, alongside the lifetime anchor. The
   * reference is the point twice over: the timer must survive to force the
   * exit when a failed cleanup left a referenced handle behind, and it must
   * hold the event loop open long enough to fire when a failed cleanup left
   * NOTHING referenced at all.
   */
  armCleanupDeadline(delayMs: number, onExpiry: () => void): CancelCleanupDeadline;
  /**
   * Forces an immediate nonzero process exit (the real host: `process.exit`).
   * Called ONLY from a cleanup deadline's expiry — every normal path exits by
   * draining the event loop after `setExitCode`.
   */
  forceExit(code: number): void;
}

export interface GatewaySequenceOptions {
  readonly config: GatewayConfig;
  /**
   * Connects the real transport. A throw here is NOT fatal (§4.2, round-1
   * review H5): the gateway is built on `UnavailableEventTransport`,
   * publication is put into the terminal halt a mid-run outage produces, and
   * recording starts anyway.
   */
  readonly connectTransport: () => Promise<MarketEventTransport>;
  /** Retention bound for the `UnavailableEventTransport` fallback (ADR-003). */
  readonly retentionEvents: number;
  /**
   * Hard deadline for BOTH cleanup paths — fatal startup and signal shutdown
   * (round 4; the module header states the invariant and the both-paths
   * decision). Default {@link DEFAULT_CLEANUP_DEADLINE_MS}; `main.ts` exposes
   * it as `GATEWAY_CLEANUP_DEADLINE_MS`. A safety parameter, not a tuning
   * knob: it bounds how long a hung or handle-holding cleanup can keep a
   * process alive that has already decided to exit.
   *
   * Round 5 (M-1): validated FAIL-CLOSED before any resource is acquired —
   * it must be a whole number of milliseconds in
   * [{@link MIN_CLEANUP_DEADLINE_MS}, {@link MAX_CLEANUP_DEADLINE_MS}].
   * Anything else (`NaN`, zero, negative, fractional, `Infinity`, beyond
   * Node's timer range) is refused with a typed configuration error, because
   * Node's `setTimeout` silently coerces every such value to an effectively
   * IMMEDIATE deadline — which force-exits healthy cleanups (a legitimate
   * 50 ms transport close was force-exited after ~4 ms under `NaN`).
   */
  readonly cleanupDeadlineMs?: number;
  /** Every gateway port except the transport, which this sequence derives. */
  readonly ports: Omit<GatewayPorts, "transport">;
  readonly host: GatewayHost;
}

/**
 * Default cleanup hard-deadline: 10 seconds. Long enough for any real
 * disposal in this app (WAL settle + fsync + close, transport quit) by orders
 * of magnitude; short enough that an operator watching a fatal log sees the
 * forced exit rather than a wedged process.
 */
export const DEFAULT_CLEANUP_DEADLINE_MS = 10_000;

/**
 * Smallest permitted cleanup deadline (round 5, M-1): 100 ms.
 *
 * The deadline is a FALLBACK, so it must never race a healthy cleanup. Every
 * real disposal in this app completes in single-digit milliseconds, but is
 * subject to event-loop and OS scheduling jitter of tens of milliseconds —
 * below 100 ms the "fallback" starts winning races against cleanups that were
 * completing normally (the round-5 reviewer's probe: an unvalidated `NaN`,
 * coerced by Node to ~1 ms, force-exited a legitimate 50 ms transport close
 * after ~4 ms, while 200 ms let it complete). 100 ms sits comfortably above
 * that jitter while still bounding a wedged process to a tenth of a second.
 */
export const MIN_CLEANUP_DEADLINE_MS = 100;

/**
 * Largest permitted cleanup deadline (round 5, M-1): Node's timer maximum
 * (2^31 − 1 ms). Beyond it `setTimeout` coerces the delay to ~1 ms, which
 * would silently invert the meaning — the LARGEST requested deadline becoming
 * the most immediate forced exit.
 */
export const MAX_CLEANUP_DEADLINE_MS = 2_147_483_647;

/** The environment variable `main.ts` (and the probe entry) expose. */
const CLEANUP_DEADLINE_ENV_VAR = "GATEWAY_CLEANUP_DEADLINE_MS";

/** Whole decimal milliseconds; anything else fails closed. */
const WHOLE_DECIMAL_MS = /^\d+$/u;

function refuseCleanupDeadline(offending: string | number): GatewayConfigurationError {
  // The M2 cadence precedent (`config.ts`): a ONE-LINE refusal naming the
  // variable, the offending value, and the permitted domain, raised as the
  // typed configuration error so `main.ts` exits 1 before anything opens.
  const shown = typeof offending === "string" ? JSON.stringify(offending) : String(offending);
  return new GatewayConfigurationError(
    `${CLEANUP_DEADLINE_ENV_VAR} (cleanupDeadlineMs) must be a whole number of milliseconds ` +
      `from ${String(MIN_CLEANUP_DEADLINE_MS)} to ${String(MAX_CLEANUP_DEADLINE_MS)}, got ` +
      `${shown}: Node coerces every other value to an effectively immediate timer, which ` +
      "would force-exit healthy cleanups; unset or empty means the default " +
      `${String(DEFAULT_CLEANUP_DEADLINE_MS)}`,
    {
      variable: CLEANUP_DEADLINE_ENV_VAR,
      offendingValue: typeof offending === "number" ? String(offending) : offending,
      permittedMinMs: MIN_CLEANUP_DEADLINE_MS,
      permittedMaxMs: MAX_CLEANUP_DEADLINE_MS,
      defaultMs: DEFAULT_CLEANUP_DEADLINE_MS,
    },
  );
}

function isValidCleanupDeadlineMs(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= MIN_CLEANUP_DEADLINE_MS &&
    value <= MAX_CLEANUP_DEADLINE_MS
  );
}

/**
 * Parses `GATEWAY_CLEANUP_DEADLINE_MS` FAIL-CLOSED (round 5, M-1).
 *
 * Unset or empty means {@link DEFAULT_CLEANUP_DEADLINE_MS} — the package's
 * established treatment of an empty environment value as absent
 * (`GATEWAY_CONFIG_PATH` in `main.ts`), pinned by test. Every present value
 * must be a plain whole-decimal string inside the permitted domain; anything
 * else (`NaN`, `-5`, `0`, `Infinity`, `2147483648`, `1500.5`, text,
 * whitespace, scientific notation) throws the one-line typed refusal, because
 * before round 5 every one of those reached `setTimeout` unchecked and became
 * an effectively immediate deadline that punished healthy cleanups.
 */
export function parseCleanupDeadlineMs(raw: string | undefined): number {
  if (raw === undefined || raw === "") {
    return DEFAULT_CLEANUP_DEADLINE_MS;
  }
  if (!WHOLE_DECIMAL_MS.test(raw)) {
    throw refuseCleanupDeadline(raw);
  }
  const value = Number(raw);
  if (!isValidCleanupDeadlineMs(value)) {
    throw refuseCleanupDeadline(raw);
  }
  return value;
}

/**
 * Runs the whole startup sequence and returns the RUNNING gateway.
 *
 * On a fatal error it releases everything acquired so far (see the module
 * header) and rethrows, so the caller's fatal handler only needs to log and
 * set the exit code — when the cleanup completes, nothing referenced is left
 * behind and setting `process.exitCode` is enough for a prompt exit; when it
 * does not, the armed cleanup deadline forces the nonzero exit instead
 * (round 4).
 */
export async function runGatewaySequence(
  options: GatewaySequenceOptions,
): Promise<DataGateway> {
  const { config, host } = options;
  const cleanupDeadlineMs = options.cleanupDeadlineMs ?? DEFAULT_CLEANUP_DEADLINE_MS;
  // Round 5 (M-1): fail closed BEFORE any resource is acquired. This seam
  // guards programmatic callers the same way `parseCleanupDeadlineMs` guards
  // the environment: an out-of-domain value here would otherwise flow
  // straight into `setTimeout`, where Node coerces it to an effectively
  // immediate deadline.
  if (!isValidCleanupDeadlineMs(cleanupDeadlineMs)) {
    throw refuseCleanupDeadline(cleanupDeadlineMs);
  }

  // Round 4: the fallback exit deadline, armed at every cleanup entry and
  // cleared only when that cleanup COMPLETES (module header: a cleanup that
  // rejects may still hold its referenced handle, so its deadline stays
  // armed and the expiry forces the exit).
  const armCleanupDeadline = (path: "fatal-startup" | "shutdown"): CancelCleanupDeadline =>
    host.armCleanupDeadline(cleanupDeadlineMs, () => {
      host.logError(
        `data-gateway: cleanup deadline (${String(cleanupDeadlineMs)} ms) expired on the ` +
          `${path} path; a resource's cleanup hung or failed while holding a referenced ` +
          "handle — forcing a nonzero exit",
      );
      host.forceExit(1);
    });

  // §4.2: the transport is NOT a precondition for recording. A failure here
  // becomes a terminal publication halt after the gateway is built, never an
  // exit — see `unavailable-transport.ts`.
  let transportFailure: string | undefined;
  let transport: MarketEventTransport;
  try {
    transport = await options.connectTransport();
  } catch (error) {
    transportFailure = error instanceof Error ? error.message : String(error);
    host.logError(
      `[transport] the event bus was unreachable at startup (${transportFailure}); publication will be halted and RECORDING WILL CONTINUE`,
    );
    transport = new UnavailableEventTransport(transportFailure, {
      maxEvents: options.retentionEvents,
    });
  }

  const startGateway = async (): Promise<DataGateway> => {
    let created: DataGateway | undefined;
    try {
      // Round 5 (M-2): `create()`'s own post-open cleanup — the journal close
      // it awaits before rejecting — runs under the SAME fatal-startup
      // deadline as this sequence's cleanup arms below. Without it, a
      // never-settling `journal.close()` after a post-open construction error
      // left `create()` pending forever: the catch below never ran, no
      // deadline ever armed, and a connected transport's referenced handle
      // held the process indefinitely. `create()` arms the capability only
      // once its failure path begins — never around a normal open — so a
      // slow-but-healthy startup is untouched.
      created = await DataGateway.create(
        config,
        { ...options.ports, transport },
        { cleanupDeadline: { arm: () => armCleanupDeadline("fatal-startup") } },
      );
      if (transportFailure !== undefined) {
        // Same terminal halt, same PAGE incident, same operator story as a
        // mid-run outage — but the WAL is already open and the feeds start
        // next.
        created.haltPublication(
          "EVENT_BUS_UNAVAILABLE",
          `the event bus was unreachable at startup (${transportFailure}); recording continues and a restart is required once the bus is back`,
        );
      }
      created.start();
      return created;
    } catch (error) {
      // R3-H1: transactional startup. Whatever this sequence acquired must be
      // released before the fatal error escapes, or a connected transport's
      // referenced socket holds the "exiting" process alive forever. Exactly
      // once per resource: before `create()` returns the transport is OURS to
      // close; afterwards the gateway owns it and `stop()` is the single
      // disposal for the journal, the transport, and the lifetime anchor
      // (already cleared if `start()` was the thing that threw). A cleanup
      // failure is logged and must not mask the original error — and (round
      // 4) it must not be the end of the story either: the deadline armed
      // below stays armed unless the cleanup COMPLETES, so a close that
      // rejects while holding its referenced handle (or never settles at all)
      // still ends in a forced nonzero exit instead of the original hang.
      if (created === undefined) {
        host.logError(
          "data-gateway: startup failed before the gateway existed; closing the event-bus transport before exiting",
        );
        const cancelDeadline = armCleanupDeadline("fatal-startup");
        try {
          await transport.close();
          cancelDeadline();
        } catch (closeError) {
          host.logError("data-gateway: fatal-path transport close failed", closeError);
        }
      } else {
        host.logError(
          "data-gateway: startup failed after the gateway was created; stopping it (WAL journal and event-bus transport close) before exiting",
        );
        const cancelDeadline = armCleanupDeadline("fatal-startup");
        try {
          await created.stop();
          cancelDeadline();
        } catch (stopError) {
          host.logError("data-gateway: fatal-path gateway stop failed", stopError);
        }
      }
      throw error;
    }
  };

  const gateway = await startGateway();

  host.logError(
    `data-gateway running: epoch ${gateway.gatewayEpoch}, stream ${config.streamName}, wal ${config.wal.rootPath}${
      transportFailure === undefined ? "" : " — PUBLICATION HALTED, RECORDING ONLY"
    }`,
  );

  const shutdown = (): void => {
    host.logError("data-gateway: shutting down");
    // Round 4: the SAME deadline as the fatal path, and for the same reason —
    // this is the other entry into `gateway.stop()`'s disposal, and a stop()
    // that never resolves (or rejects with a referenced handle still held)
    // would wedge a process the operator just asked to exit. Cleared BEFORE
    // the success exit code is set, so the clean path is untouched.
    const cancelDeadline = armCleanupDeadline("shutdown");
    void gateway.stop().then(
      () => {
        cancelDeadline();
        host.setExitCode(0);
      },
      (error: unknown) => {
        // Deliberately NOT cancelled: `stop()` isolates disposals (round 4),
        // so a rejection means at least one resource did not release cleanly
        // and may still hold a referenced handle. If nothing referenced
        // remains, the process exits 1 naturally — at latest at the deadline.
        host.logError("data-gateway: shutdown error", error);
        host.setExitCode(1);
      },
    );
  };
  host.registerShutdownSignals(shutdown);
  return gateway;
}
