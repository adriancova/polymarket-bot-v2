/**
 * The emergency CLI's ports (WP-330). Every venue, credential, database and
 * terminal surface is injected; the CLI itself performs no I/O but its own
 * audit file (`audit-log.ts`), and only through the composition in `main.ts`.
 *
 * ## The credential boundary (handoff §15; ADR-008 §6)
 *
 * > "Independent cancel credentials are protected separately from the main
 * > service runtime where practical." (§15)
 *
 * {@link EmergencyCredentialPort} is the CLI's OWN credential port. It is not
 * the trader's signer handle, not WP-260's `SignerHandle`, and not any
 * environment variable: the trader's composition never sees it, and the CLI
 * never sees the trader's. Its binding is a later, human-gated live item
 * (ADR-010 §1); THIS REPOSITORY WRITES NO CREDENTIAL LOADING. The shipped
 * composition (`main.ts`) binds a source that answers `UNAVAILABLE`, and the
 * signer gate refuses every PAPER process before the port is ever asked.
 *
 * What the binding must honour, when one is written:
 * - it loads from a protected mount or secrets manager reachable by the ops
 *   host only, never from the trader's runtime mount (§15);
 * - it is asked only after WP-260's signer gate permitted the process, and it
 *   is told the gate's verdict and the account the operator confirmed;
 * - the credential it returns is OPAQUE to the CLI: the CLI reads
 *   `accountRef` (to check the scope the operator confirmed, E-16) and hands
 *   the rest, untouched, to the venue factory. Nothing of it is printed,
 *   audited or logged;
 * - its refusal reasons are fixed codes, never secret material.
 *
 * ## The venue (handoff §9.12; WP-260)
 *
 * {@link EmergencyVenueFactory} turns a credential into the two surfaces the
 * commands use: the cancel half of WP-260's `SecureVenueClient` (a real
 * `SecureVenueClient` satisfies {@link EmergencyCancelClient} structurally;
 * `secure-client.test.ts` proves it with WP-260's own test factory), and the
 * authenticated account reads WP-290's coordinator reads through
 * (`AccountReadPort`). No live binding exists in this repository: the live
 * composition binds them after ADR-033 D5 and the live-micro gate.
 */

import type { AccountReadPort, FillIdentity } from "@polymarket-bot/oms";
import type { RateLimitObservation, SecureVenueClient, SignerGateContext } from "@polymarket-bot/polymarket-secure";
import type { FencingLeaseView } from "@polymarket-bot/storage-postgres";

// ---------------------------------------------------------------------------
// The terminal.

/** Where the CLI writes its explicit output, one line at a time. */
export interface OutputPort {
  line(text: string): void;
}

/**
 * The interactive confirmation. `interactive` is false when no operator can
 * answer (no TTY): the CLI then REFUSES a destructive command that carries no
 * `--confirm`, and never waits.
 */
export interface ConfirmationPrompt {
  readonly interactive: boolean;
  /** Ask, and resolve with the line the operator typed, or `null` when none could be read. */
  ask(question: string): Promise<string | null>;
}

/**
 * Time. `nowMs` is epoch milliseconds and MUST be monotonic (the reconciliation
 * coordinator and the rate-limit budget both require it); `sleep` waits.
 */
export interface OpsClock {
  nowMs(): number;
  sleep(ms: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// The emergency credential (§15).

/** Opaque to the CLI: only `accountRef` is read. */
export interface EmergencyCredential {
  /** The account these credentials act for (the account whose orders they own, E-16). */
  readonly accountRef: string;
}

export type CredentialLoadResult =
  | { readonly kind: "LOADED"; readonly credential: EmergencyCredential }
  /** A fixed reason code; never secret material. */
  | { readonly kind: "UNAVAILABLE"; readonly reason: string };

export interface EmergencyCredentialPort {
  load(request: { readonly accountRef: string; readonly gate: SignerGateContext }): Promise<CredentialLoadResult>;
}

// ---------------------------------------------------------------------------
// The venue.

/** The cancel half of WP-260's narrow interface: a `SecureVenueClient` is one. */
export type EmergencyCancelClient = Pick<SecureVenueClient, "identity" | "cancelOrder" | "cancelOrders" | "cancelMarketOrders" | "cancelAll" | "close">;

export interface EmergencyVenue {
  readonly cancels: EmergencyCancelClient;
  /** Authenticated venue-truth reads, in the shapes WP-290's coordinator reads (`AccountReadPort`). */
  readonly reads: AccountReadPort;
}

export type EmergencyVenueOpen =
  | { readonly kind: "OPEN"; readonly venue: EmergencyVenue }
  /** A fixed reason code. */
  | { readonly kind: "UNAVAILABLE"; readonly reason: string };

export interface EmergencyVenueFactory {
  open(request: {
    readonly gate: SignerGateContext;
    readonly credential: EmergencyCredential;
    /** WP-260's `onRateLimitUpdate`: the CLI feeds each observation to its rate-limit budget. */
    readonly onRateLimitUpdate: (observation: RateLimitObservation) => void;
  }): Promise<EmergencyVenueOpen>;
}

// ---------------------------------------------------------------------------
// The ops configuration (operator policy; nothing here is a venue fact).

export type ConfigurationLoadResult =
  | { readonly kind: "LOADED"; readonly document: unknown }
  | { readonly kind: "UNAVAILABLE"; readonly reason: string };

export interface ConfigurationSource {
  load(): Promise<ConfigurationLoadResult>;
}

// ---------------------------------------------------------------------------
// The fencing lease (stop-heartbeat; WP-320).

/**
 * The two operations of WP-320's `FencingLeaseStore` that stop-heartbeat uses;
 * the real store satisfies it (`stop-heartbeat.test.ts`, compile-time).
 */
export interface FencingLeaseAccess {
  current(accountRef: string, environment: string): Promise<FencingLeaseView | null>;
  revoke(input: { readonly fencingLeaseId: string; readonly reason: string }): Promise<boolean>;
}

export type FencingLeaseAccessOpen =
  | { readonly kind: "OPEN"; readonly leases: FencingLeaseAccess; readonly close: () => Promise<void> }
  | { readonly kind: "UNAVAILABLE"; readonly reason: string };

export interface FencingLeaseAccessFactory {
  open(): Promise<FencingLeaseAccessOpen>;
}

// ---------------------------------------------------------------------------
// reconcile: the durable ledger projection, read only.

/**
 * The read half of WP-290's `HoldingsPort`: the account's projected holdings
 * and the bookings of named fills, from the durable ledger. Optional: without
 * one, reconcile reports the holdings comparison as unread (the coordinator
 * holds, `READ_MISSING`), which is fail-closed.
 */
export interface ProjectionSource {
  projected(): Promise<unknown>;
  remainingBookings(fills: readonly FillIdentity[]): Promise<unknown>;
}
