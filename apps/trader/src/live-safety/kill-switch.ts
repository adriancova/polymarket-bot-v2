/**
 * Kill-switch enforcement (WP-320 deliverable; handoff §14.1; ADR-008 §8:
 * "Kill switches outrank everything"; ADR-033 D1 item 3).
 *
 * ## How a running trader observes a switch: a durable read
 *
 * The brief records that "an engaged kill switch does not reach a running
 * trader (no IPC seam in-repo)". This module closes that gap with a DURABLE
 * READ of `ops.kill_switch_events`, the table `apps/control-api`'s
 * PostgreSQL audit sink writes every applied engage and release to. Why the
 * table, and not a message or an in-memory hand-off:
 *
 * - **It is written BEFORE the switch takes effect.** The control plane audits
 *   first and applies only if the append succeeded (`control-plane.ts`,
 *   "AUDIT FIRST, THEN APPLY"), so a switch an operator was told is engaged is
 *   already a row. No message can be "sent but not yet delivered".
 * - **It survives every restart** of the trader, the control API, or both:
 *   the state is re-derived from the rows on every read, never carried in
 *   memory.
 * - **A failed read is a failed proof.** The read is one of the health
 *   lease's seven inputs (§9.18). A process that cannot read kill-switch
 *   state cannot prove it is allowed to trade (ADR-008 §8): its health lease
 *   fails, its heartbeat stops, and the entry gate blocks every submission
 *   until a read succeeds again.
 * - **It needs nothing new.** The table, its CHECK and its append-only guard
 *   exist (migration 0007); Redis is not a fence (§9.18) and is not used.
 *
 * The window in which an engaged switch is not yet enforced is bounded: it is
 * at most one refresh interval plus one read (the refresher reads on a
 * timer), and a read older than the KILL_SWITCH input's maximum age fails the
 * lease and blocks the gate regardless (`health-lease.ts`).
 *
 * ## The fold: fail closed on every ambiguity
 *
 * The reader returns, for each `(environment, scope, scope_ref)`, its latest
 * row under TWO orderings: by `recorded_at` (the database's clock) and by
 * `occurred_at` (the control plane's), each tie broken by the event id. A
 * switch counts as RELEASED only when every latest row for it is a release; a
 * switch any ordering shows engaged is engaged. A row whose state is
 * unreadable counts as a `FULL_HALT` at its scope (or `GLOBAL` when its scope
 * is unreadable). Rows of EVERY environment are honoured: a switch engaged in
 * any run mode's control plane is a switch, and two environments' rows for
 * one scope never release each other, because state is kept per environment.
 *
 * ## What each switch does to THIS process (accountRef)
 *
 * | Scope | Heartbeat (ADR-033 D1 item 3) | New entries | Any submission (reductions included) | Cancels requested |
 * | --- | --- | --- | --- | --- |
 * | `GLOBAL`, or `ACCOUNT` naming this account: `FULL_HALT`, `CANCEL_ALL`, `CANCEL_MARKET`, unreadable | STOPS | blocked | blocked | all of the account's orders |
 * | `GLOBAL` / this `ACCOUNT`: `HALT_NEW_ENTRIES`, `MANAGE_POSITIONS_ONLY` | continues | blocked | permitted | none |
 * | `MARKET` (any action) | NEVER stops | blocked in that market | blocked in that market for `FULL_HALT` / `CANCEL_*` | that market's orders, for `FULL_HALT` / `CANCEL_*` |
 * | `STRATEGY_INSTANCE` (any action) | NEVER stops | blocked for that instance | blocked for that instance for `FULL_HALT` / `CANCEL_*` | that instance's orders, for `FULL_HALT` / `CANCEL_*` |
 * | `ACCOUNT` naming another account | — | — | — | — |
 *
 * WP-320 defines which GLOBAL and ACCOUNT actions stop the heartbeat
 * (ADR-033 D1 item 3): those that end trading on the account. `FULL_HALT`
 * is §9.9's "full halt" (whose "Account state unknown" default also stops the
 * heartbeat), and `CANCEL_ALL` asks for exactly the venue-side cancellation a
 * stopped heartbeat causes, so the stop backs up the explicit cancel.
 * `CANCEL_MARKET` at an account-wide scope names no market, so it is read as
 * its strongest meaning. `HALT_NEW_ENTRIES` and `MANAGE_POSITIONS_ONLY` keep
 * resting orders (exits) alive, so they do not. A `MARKET` or
 * `STRATEGY_INSTANCE` switch never stops the heartbeat: the venue would cancel
 * every order under the credentials, which is wider than the switch (§14.1).
 */

import type { HealthProofReading, HealthProofSource } from "./health-lease.js";
import type { MonotonicClock } from "./ports.js";

export const KILL_SWITCH_SCOPES = Object.freeze(["GLOBAL", "ACCOUNT", "MARKET", "STRATEGY_INSTANCE"] as const);
export const KILL_SWITCH_ACTIONS = Object.freeze(["HALT_NEW_ENTRIES", "CANCEL_ALL", "CANCEL_MARKET", "MANAGE_POSITIONS_ONLY", "FULL_HALT"] as const);
export type KillSwitchScope = (typeof KILL_SWITCH_SCOPES)[number];
export type KillSwitchAction = (typeof KILL_SWITCH_ACTIONS)[number];

/** One latest row, as {@link KillSwitchReader} returns it. */
export interface KillSwitchRow {
  readonly killSwitchEventId: string;
  readonly environment: string;
  readonly scope: string;
  readonly scopeRef: string | null;
  readonly action: string;
  readonly resultingState: unknown;
}

/** Reads the latest kill-switch rows (`kill-switch-postgres.ts`). A throw or a rejection is a failed read. */
export interface KillSwitchReader {
  read(): Promise<readonly KillSwitchRow[]>;
}

export interface EngagedSwitch {
  readonly environment: string;
  readonly scope: KillSwitchScope;
  readonly scopeRef: string | null;
  readonly action: KillSwitchAction;
  readonly killSwitchEventId: string;
  /** The row could not be read as the control plane writes it; it is enforced as `FULL_HALT`. */
  readonly unreadable: boolean;
}

export type CancelDirective =
  | { readonly scope: "ACCOUNT" }
  | { readonly scope: "MARKET"; readonly marketId: string }
  | { readonly scope: "STRATEGY_INSTANCE"; readonly instanceId: string };

export interface KillSwitchEffects {
  readonly engaged: readonly EngagedSwitch[];
  readonly stopsHeartbeat: boolean;
  readonly blocksAllEntries: boolean;
  readonly blocksAllSubmissions: boolean;
  readonly entryBlockedMarkets: ReadonlySet<string>;
  readonly submissionBlockedMarkets: ReadonlySet<string>;
  readonly entryBlockedInstances: ReadonlySet<string>;
  readonly submissionBlockedInstances: ReadonlySet<string>;
  /** Each with the event id that asked for it, so a cancel is requested once per engage. */
  readonly cancels: readonly { readonly directive: CancelDirective; readonly killSwitchEventId: string }[];
}

const ACCOUNT_ENDING: readonly KillSwitchAction[] = ["FULL_HALT", "CANCEL_ALL", "CANCEL_MARKET"];
const SCOPE_ENDING: readonly KillSwitchAction[] = ["FULL_HALT", "CANCEL_ALL", "CANCEL_MARKET"];

function ownString(target: unknown, key: string): string | undefined {
  if (typeof target !== "object" || target === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : undefined;
}

function scopeOf(value: unknown): KillSwitchScope | undefined {
  return KILL_SWITCH_SCOPES.find((scope) => scope === value);
}

function actionOf(value: unknown): KillSwitchAction | undefined {
  return KILL_SWITCH_ACTIONS.find((action) => action === value);
}

/**
 * Fold the latest rows into the engaged switches. A row is a release only when
 * its resulting state is the control plane's release document
 * (`engaged: "false"`) for the row's own scope; anything else that is not a
 * readable engage is an unreadable row, enforced as `FULL_HALT`.
 */
export function foldKillSwitchRows(rows: readonly unknown[]): readonly EngagedSwitch[] {
  const engaged: EngagedSwitch[] = [];
  for (const raw of rows) {
    const id = ownString(raw, "killSwitchEventId") ?? "(unreadable)";
    const environment = ownString(raw, "environment") ?? "(unreadable)";
    const scope = scopeOf(ownString(raw, "scope"));
    const scopeRefRaw = typeof raw === "object" && raw !== null ? Object.getOwnPropertyDescriptor(raw, "scopeRef") : undefined;
    const refValue: unknown = scopeRefRaw !== undefined && "value" in scopeRefRaw ? scopeRefRaw.value : undefined;
    const scopeRef = refValue === null ? null : typeof refValue === "string" ? refValue : undefined;
    const action = actionOf(ownString(raw, "action"));
    const state = typeof raw === "object" && raw !== null ? Object.getOwnPropertyDescriptor(raw, "resultingState") : undefined;
    const resulting: unknown = state !== undefined && "value" in state ? state.value : undefined;
    const flag = ownString(resulting, "engaged");
    const stateScope = ownString(resulting, "scope");
    const readable = scope !== undefined && scopeRef !== undefined && (scope === "GLOBAL") === (scopeRef === null) && stateScope === scope;
    if (readable && flag === "false") continue;
    const stateAction = actionOf(ownString(resulting, "action"));
    if (readable && flag === "true" && action !== undefined && stateAction === action) {
      engaged.push(Object.freeze({ environment, scope, scopeRef, action, killSwitchEventId: id, unreadable: false }));
      continue;
    }
    // Unreadable, or an engage whose action is not the row's: the strongest action, at the row's scope when readable.
    const knownScope = scope !== undefined && scopeRef !== undefined && (scope === "GLOBAL") === (scopeRef === null);
    engaged.push(
      Object.freeze({
        environment,
        scope: knownScope ? scope : "GLOBAL",
        scopeRef: knownScope ? scopeRef : null,
        action: "FULL_HALT" as const,
        killSwitchEventId: id,
        unreadable: true,
      }),
    );
  }
  return Object.freeze(engaged);
}

/** What the engaged switches do to the process trading `accountRef` (the table in the header). */
export function killSwitchEffects(engaged: readonly EngagedSwitch[], accountRef: string): KillSwitchEffects {
  let stopsHeartbeat = false;
  let blocksAllEntries = false;
  let blocksAllSubmissions = false;
  const entryBlockedMarkets = new Set<string>();
  const submissionBlockedMarkets = new Set<string>();
  const entryBlockedInstances = new Set<string>();
  const submissionBlockedInstances = new Set<string>();
  const cancels: { readonly directive: CancelDirective; readonly killSwitchEventId: string }[] = [];
  for (const entry of engaged) {
    const ending = SCOPE_ENDING.includes(entry.action);
    switch (entry.scope) {
      case "GLOBAL":
      case "ACCOUNT": {
        // An ACCOUNT switch for another account is not this process's; an ACCOUNT switch with no readable ref is.
        if (entry.scope === "ACCOUNT" && entry.scopeRef !== null && entry.scopeRef !== accountRef) break;
        blocksAllEntries = true;
        if (ACCOUNT_ENDING.includes(entry.action)) {
          stopsHeartbeat = true;
          blocksAllSubmissions = true;
          cancels.push({ directive: Object.freeze({ scope: "ACCOUNT" as const }), killSwitchEventId: entry.killSwitchEventId });
        }
        break;
      }
      case "MARKET": {
        if (entry.scopeRef === null) break;
        entryBlockedMarkets.add(entry.scopeRef);
        if (ending) {
          submissionBlockedMarkets.add(entry.scopeRef);
          cancels.push({ directive: Object.freeze({ scope: "MARKET" as const, marketId: entry.scopeRef }), killSwitchEventId: entry.killSwitchEventId });
        }
        break;
      }
      case "STRATEGY_INSTANCE": {
        if (entry.scopeRef === null) break;
        entryBlockedInstances.add(entry.scopeRef);
        if (ending) {
          submissionBlockedInstances.add(entry.scopeRef);
          cancels.push({ directive: Object.freeze({ scope: "STRATEGY_INSTANCE" as const, instanceId: entry.scopeRef }), killSwitchEventId: entry.killSwitchEventId });
        }
        break;
      }
    }
  }
  return Object.freeze({
    engaged,
    stopsHeartbeat,
    blocksAllEntries,
    blocksAllSubmissions,
    entryBlockedMarkets,
    submissionBlockedMarkets,
    entryBlockedInstances,
    submissionBlockedInstances,
    cancels: Object.freeze(cancels),
  });
}

/** The latest read, as the gate and the health lease see it. */
export type KillSwitchSnapshot =
  | { readonly known: true; readonly effects: KillSwitchEffects; readonly readStartedAtMs: number }
  | { readonly known: false; readonly reason: "NEVER_READ" | "READ_FAILED" | "READ_TIMED_OUT" | "CLOCK_UNREADABLE" };

/**
 * Reads the kill-switch rows on demand ({@link KillSwitchMonitor.refresh}),
 * one read at a time, and keeps ONLY the latest outcome. A read is timed from
 * the instant before it started (the rows it returns are at least that
 * fresh). The latest outcome failing makes the state unknown at once, whatever
 * an earlier read said.
 *
 * A read still in progress after `abandonAfterMs` is ABANDONED by the next
 * refresh: the state becomes unknown (`READ_TIMED_OUT`) at once, a new read
 * starts, and the abandoned read's answer, when it lands, is discarded. So a
 * hung read can never freeze the state at an old answer.
 */
export class KillSwitchMonitor {
  readonly #reader: KillSwitchReader;
  readonly #clock: MonotonicClock;
  readonly #accountRef: string;
  readonly #abandonAfterMs: number;
  #latest: KillSwitchSnapshot = Object.freeze({ known: false as const, reason: "NEVER_READ" as const });
  #reading: { readonly promise: Promise<boolean>; readonly startedAtMs: number | null; readonly seq: number } | null = null;
  #seq = 0;

  constructor(options: { readonly reader: KillSwitchReader; readonly clock: MonotonicClock; readonly accountRef: string; readonly abandonAfterMs?: number }) {
    this.#reader = options.reader;
    this.#clock = options.clock;
    this.#accountRef = options.accountRef;
    this.#abandonAfterMs = options.abandonAfterMs ?? Number.POSITIVE_INFINITY;
  }

  /** Read now (or join the read in progress, unless it is older than `abandonAfterMs`). `true` when the read succeeded. */
  refresh(): Promise<boolean> {
    const now = this.#readClock();
    const current = this.#reading;
    if (current !== null) {
      const young = now !== null && current.startedAtMs !== null && now - current.startedAtMs < this.#abandonAfterMs;
      if (young) return current.promise;
      // Abandoned: unknown at once; its answer will be discarded.
      this.#latest = Object.freeze({ known: false as const, reason: "READ_TIMED_OUT" as const });
    }
    this.#seq += 1;
    const seq = this.#seq;
    const promise = this.#read(seq, now).finally(() => {
      if (this.#reading?.seq === seq) this.#reading = null;
    });
    this.#reading = { promise, startedAtMs: now, seq };
    return promise;
  }

  snapshot(): KillSwitchSnapshot {
    return this.#latest;
  }

  /**
   * The KILL_SWITCH health input: proved at the instant the latest successful
   * read STARTED, and only while that read's switches let the heartbeat run.
   */
  proofSource(): HealthProofSource {
    return Object.freeze({
      read: (): HealthProofReading => {
        const latest = this.#latest;
        if (!latest.known) return Object.freeze({ healthy: false as const, reason: latest.reason });
        if (latest.effects.stopsHeartbeat) return Object.freeze({ healthy: false as const, reason: "ENGAGED_STOPS_HEARTBEAT" });
        return Object.freeze({ healthy: true as const, provenAtMs: latest.readStartedAtMs });
      },
    });
  }

  #readClock(): number | null {
    try {
      const value = this.#clock.monotonicMs();
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  }

  async #read(seq: number, started: number | null): Promise<boolean> {
    if (started === null) {
      this.#latest = Object.freeze({ known: false as const, reason: "CLOCK_UNREADABLE" as const });
      return false;
    }
    let rows: unknown;
    try {
      rows = await this.#reader.read();
    } catch {
      if (seq === this.#seq) this.#latest = Object.freeze({ known: false as const, reason: "READ_FAILED" as const });
      return false;
    }
    // An abandoned read's answer is discarded: a newer read has started.
    if (seq !== this.#seq) return false;
    if (!Array.isArray(rows)) {
      this.#latest = Object.freeze({ known: false as const, reason: "READ_FAILED" as const });
      return false;
    }
    const list: readonly unknown[] = rows;
    this.#latest = Object.freeze({ known: true as const, effects: killSwitchEffects(foldKillSwitchRows(list), this.#accountRef), readStartedAtMs: started });
    return true;
  }
}
