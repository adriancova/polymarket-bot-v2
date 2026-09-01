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
 * On ANY fatal startup error, every resource acquired so far is released,
 * `close` is called exactly once per resource, and the process exits 1
 * promptly. Ownership is single and explicit, which is what makes
 * exactly-once checkable:
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
 *   the error escapes (`gateway.ts`).
 *
 * The signal path cannot race the fatal path: `SIGINT`/`SIGTERM` handlers are
 * registered only AFTER `start()` succeeds, at which point the fatal cleanup
 * below is unreachable — the two disposal paths are mutually exclusive by
 * construction, not by locking.
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
import type { GatewayPorts } from "./gateway.js";
import { DataGateway } from "./gateway.js";
import { UnavailableEventTransport } from "./unavailable-transport.js";

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
  /** Every gateway port except the transport, which this sequence derives. */
  readonly ports: Omit<GatewayPorts, "transport">;
  readonly host: GatewayHost;
}

/**
 * Runs the whole startup sequence and returns the RUNNING gateway.
 *
 * On a fatal error it releases everything acquired so far (see the module
 * header) and rethrows, so the caller's fatal handler only needs to log and
 * set the exit code — with nothing referenced left behind, setting
 * `process.exitCode` is enough for a prompt exit.
 */
export async function runGatewaySequence(
  options: GatewaySequenceOptions,
): Promise<DataGateway> {
  const { config, host } = options;

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
      created = await DataGateway.create(config, { ...options.ports, transport });
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
      // failure is logged and must not mask the original error.
      if (created === undefined) {
        host.logError(
          "data-gateway: startup failed before the gateway existed; closing the event-bus transport before exiting",
        );
        try {
          await transport.close();
        } catch (closeError) {
          host.logError("data-gateway: fatal-path transport close failed", closeError);
        }
      } else {
        host.logError(
          "data-gateway: startup failed after the gateway was created; stopping it (WAL journal and event-bus transport close) before exiting",
        );
        try {
          await created.stop();
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
    void gateway.stop().then(
      () => {
        host.setExitCode(0);
      },
      (error: unknown) => {
        host.logError("data-gateway: shutdown error", error);
        host.setExitCode(1);
      },
    );
  };
  host.registerShutdownSignals(shutdown);
  return gateway;
}
