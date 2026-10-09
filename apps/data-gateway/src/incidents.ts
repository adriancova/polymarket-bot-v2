/**
 * Gateway-originated data-quality incidents (§8.3, §7.4, ADR-002 §2.5).
 *
 * The adapters already emit `DataQualityIncidentOpened` for the conditions
 * they can judge; this registry is for the conditions only the GATEWAY can
 * judge — a WAL refusal, a transport outage, a rejected envelope, an
 * escalated reconnect loop, a freshness failure. Those carry
 * `source: "internal"` (§7.1's token for the platform itself).
 *
 * Incident ids are minted here: `gw-<scope>-<ordinal>`, unique per gateway
 * epoch by the ordinal. The registry is BOUNDED: one OPEN incident per
 * `(scope, reasonCode)` key at a time — a repeat while open increments a
 * counter instead of flooding the stream — and the key set itself is capped,
 * evicting the oldest closed keys first, so a pathological feed cannot grow
 * memory without bound (§8.3: every queue is bounded, including this one).
 * Nothing is silent: every suppressed repeat is counted and observable.
 *
 * ## The key separator is written `\u0000`, deliberately
 *
 * `(scope, reasonCode)` is joined with a NUL, because NUL cannot occur in
 * either half (both are `CodeString`-shaped), so no pair of distinct inputs
 * can collide on one key. Round 1 wrote the separator as a LITERAL NUL BYTE in
 * the source, which made Git classify this TypeScript file as BINARY and hide
 * its diff from every review tool (round-1 review L5; WP-090 hit the same
 * thing and made the same correction). The escape below produces the
 * identical runtime string and a readable diff.
 */

import type {
  DataQualityIncidentClosedPayload,
  DataQualityIncidentOpenedPayload,
  IncidentSeverity,
} from "@polymarket-bot/domain";

import type { EnvelopeDraft } from "./envelope.js";
import { GatewayConfigurationError } from "./errors.js";
import { isoFromMs } from "./ports.js";

/** `sourceChannel` for gateway-internal events. */
export const GATEWAY_INTERNAL_CHANNEL = "gateway:internal";

/** `C1-HALTS`: the `resolutionCode` of every close the gateway publishes — the condition its key named cleared. */
export const INCIDENT_CONDITION_CLEARED = "GATEWAY_CONDITION_CLEARED";

export interface OpenIncidentInput {
  /** Bounded scope key: a feed id, or a gateway subsystem name. */
  readonly scope: string;
  /** Stable `CodeString` reason. */
  readonly reasonCode: string;
  readonly severity: IncidentSeverity;
  readonly detail: string;
  readonly atMs: number;
  /** The affected feed, when there is one. */
  readonly feedId?: string | undefined;
}

export type OpenIncidentOutcome =
  | {
      readonly opened: true;
      readonly incidentId: string;
      /** Ready for the dispatcher; `source: "internal"`. */
      readonly draft: EnvelopeDraft;
    }
  | {
      /** An incident with this key is already open; the repeat was counted. */
      readonly opened: false;
      readonly incidentId: string;
      readonly repeatCount: number;
    };

interface IncidentState {
  incidentId: string;
  open: boolean;
  repeats: number;
}

export interface IncidentRegistryMetrics {
  readonly incidentsOpened: number;
  readonly repeatsSuppressed: number;
  readonly trackedKeys: number;
  readonly evictedKeys: number;
}

export class IncidentRegistry {
  readonly #states = new Map<string, IncidentState>();
  readonly #maxTrackedKeys: number;
  #ordinal = 0;
  #opened = 0;
  #repeatsSuppressed = 0;
  #evictedKeys = 0;

  constructor(options: { readonly maxTrackedKeys?: number } = {}) {
    const max = options.maxTrackedKeys ?? 1024;
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new GatewayConfigurationError("maxTrackedKeys must be a positive safe integer", {
        maxTrackedKeys: max,
      });
    }
    this.#maxTrackedKeys = max;
  }

  /**
   * Opens (or counts a repeat of) an incident.
   *
   * The returned draft is a complete `DataQualityIncidentOpened` payload under
   * `source: "internal"`; the caller dispatches it like any other event.
   */
  open(input: OpenIncidentInput): OpenIncidentOutcome {
    const key = `${input.scope}\u0000${input.reasonCode}`;
    const existing = this.#states.get(key);
    if (existing !== undefined && existing.open) {
      existing.repeats += 1;
      this.#repeatsSuppressed += 1;
      return { opened: false, incidentId: existing.incidentId, repeatCount: existing.repeats };
    }

    this.#ordinal += 1;
    this.#opened += 1;
    const incidentId = `gw-${input.scope}-${String(this.#ordinal)}`;
    this.#remember(key, { incidentId, open: true, repeats: 0 });

    const payload: DataQualityIncidentOpenedPayload = {
      incidentId,
      openedAt: isoFromMs(input.atMs),
      reasonCode: input.reasonCode,
      severity: input.severity,
      detail: input.detail.slice(0, 2000),
      ...(input.feedId === undefined ? {} : { feedId: input.feedId }),
    };
    return {
      opened: true,
      incidentId,
      draft: {
        eventType: "DataQualityIncidentOpened",
        schemaVersion: 1,
        source: "internal",
        sourceChannel: GATEWAY_INTERNAL_CHANNEL,
        payload,
      },
    };
  }

  /**
   * Marks the incident for a key closed, so a recurrence opens a fresh one.
   * Answers the incident's id when THIS call closed an OPEN incident
   * (`C1-HALTS`: the dispatcher then publishes its close), `undefined` when
   * the key was unknown or already closed.
   */
  markClosed(scope: string, reasonCode: string): string | undefined {
    const state = this.#states.get(`${scope}\u0000${reasonCode}`);
    if (state === undefined || !state.open) return undefined;
    state.open = false;
    return state.incidentId;
  }

  /**
   * `C1-HALTS` (DQ-CLOSE): the `DataQualityIncidentClosed` draft for an
   * incident {@link markClosed} just closed, under `source: "internal"`. The
   * frozen contract carries only the `incidentId`; a consumer routes the close
   * to whatever holds that id (the trader: every market whose active set does).
   */
  closedDraft(input: {
    readonly incidentId: string;
    readonly scope: string;
    readonly reasonCode: string;
    readonly atMs: number;
  }): EnvelopeDraft {
    const payload: DataQualityIncidentClosedPayload = {
      incidentId: input.incidentId,
      closedAt: isoFromMs(input.atMs),
      resolutionCode: INCIDENT_CONDITION_CLEARED,
      detail: `the ${input.reasonCode} condition for ${input.scope} cleared`.slice(0, 2000),
    };
    return {
      eventType: "DataQualityIncidentClosed",
      schemaVersion: 1,
      source: "internal",
      sourceChannel: GATEWAY_INTERNAL_CHANNEL,
      payload,
    };
  }

  /** Whether an incident is currently open for the key. */
  isOpen(scope: string, reasonCode: string): boolean {
    return this.#states.get(`${scope}\u0000${reasonCode}`)?.open === true;
  }

  metrics(): IncidentRegistryMetrics {
    return {
      incidentsOpened: this.#opened,
      repeatsSuppressed: this.#repeatsSuppressed,
      trackedKeys: this.#states.size,
      evictedKeys: this.#evictedKeys,
    };
  }

  #remember(key: string, state: IncidentState): void {
    this.#states.delete(key);
    this.#states.set(key, state);
    if (this.#states.size <= this.#maxTrackedKeys) {
      return;
    }
    // Evict the oldest CLOSED key first; only evict an open one when every
    // tracked key is open (the dedup for that key is lost, which costs a
    // duplicate incident, never a suppressed one — the loud direction).
    for (const [candidateKey, candidate] of this.#states) {
      if (!candidate.open) {
        this.#states.delete(candidateKey);
        this.#evictedKeys += 1;
        return;
      }
    }
    const oldest = this.#states.keys().next();
    if (!oldest.done && oldest.value !== key) {
      this.#states.delete(oldest.value);
      this.#evictedKeys += 1;
    }
  }
}
