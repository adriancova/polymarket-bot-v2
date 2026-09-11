/**
 * The trader's WIRE door — ADR-020 §5 / `docs/contracts/schema-boundary.md` §6.
 *
 * Every normalized event this process consumes arrives from the transport as
 * caller data. `docs/contracts/schema-boundary.md` §3 records two rows that
 * meet exactly here:
 *
 * - `packages/domain` (frozen) — **LIVE**: "`skipChecks` makes both primitives
 *   accept `"NOT-A-UUID"` / `"yesterday"`; every required `DecisionResult` key
 *   is satisfiable from the prototype". Owner: "contract owner — closed by
 *   ADR-020 §3 **at each door**, not by editing the frozen package";
 * - `packages/event-bus` — **CLOSED** since `WP-060-FU1` merged (`d869868`,
 *   2026-09-11): that row's two defeats (the `skipChecks` acceptance of
 *   `eventId: "not-a-uuid"` / `receivedAt: "yesterday"`, and returning the
 *   caller's own object) are gone, and what now reaches this process is a
 *   frozen prototype-free record the transport built from own data. This door
 *   still stands: it is the trader's own boundary, it is what closes the
 *   `packages/domain` row above on this side, and §6 rule 1 binds it
 *   regardless of how well the sender behaves.
 *
 * This door is the trader's half of both, and it is a NEW boundary, so §6 rule
 * 1 binds it to conform on arrival.
 *
 * ## Conformance statement (schema-boundary §4)
 *
 * 1. **D1** — `readPlainData` (`@polymarket-bot/risk/plain-data`) materializes
 *    the envelope into a fresh prototype-free tree, read by descriptor. An
 *    inherited `payload`, an inherited `gatewayEpoch`, and a getter that answers
 *    differently on the second read are all refused here, before any schema
 *    sees them.
 * 2. **D2** — the parse runs against an ARENA COPY of the frozen contract's own
 *    envelope schema, built and warmed at module load
 *    (`prototypeFreeParser`, `@polymarket-bot/risk/schema-arena`). This is what
 *    closes the `skipChecks` class the `packages/domain` row records: the raw
 *    schema and the arena copy validate identically on clean input, and the
 *    arena copy still refuses `"yesterday"` when the raw one has been switched
 *    off.
 * 3. **D3** — the envelope this door returns is built from the MATERIALIZED
 *    tree. The schema's answer is used; its output is discarded.
 * 4. **D4** — the returned envelope is the prototype-free tree, deep-frozen.
 * 5. **The bound** — under the pollution battery in
 *    `apps/trader/src/event-door.test.ts`, permission never varies and no throw
 *    escapes: an envelope refused clean is refused polluted, and one accepted
 *    clean carries the same values polluted.
 *
 * ## Why the arena copies are built per consumed event type
 *
 * `DOMAIN_EVENT_REGISTRY.safeParseEnvelope` routes on `(eventType,
 * schemaVersion)` and then runs the contract's RAW envelope schema. Routing is
 * exactly what this door needs; the raw parse is exactly what it must not use.
 * So the door does the routing itself against the registry's contracts and
 * parses through a warmed copy — one per event type the trader consumes, built
 * at module load so no lazy is ever forced cold (the "cold-lazy poisoning"
 * class, which permanently poisons the schema object for the process).
 *
 * An event type the trader does not consume is REFUSED by name rather than
 * ignored, so a gateway that starts publishing something new produces a loud
 * refusal here instead of silent under-processing.
 */

import {
  DOMAIN_EVENT_REGISTRY,
  type EventEnvelope,
} from "@polymarket-bot/domain";
import { readPlainData } from "@polymarket-bot/risk/plain-data";
import { prototypeFreeParser } from "@polymarket-bot/risk/schema-arena";

/**
 * The event types the trader's core loop consumes, with the schema version it
 * consumes them at.
 *
 * Explicit rather than "every registered contract": a process that parsed
 * everything would be claiming to handle events its loop has no branch for.
 */
export const CONSUMED_EVENTS: readonly { readonly eventType: string; readonly schemaVersion: number }[] =
  Object.freeze([
    { eventType: "MarketOpened", schemaVersion: 1 },
    { eventType: "MarketClosing", schemaVersion: 1 },
    { eventType: "MarketResolved", schemaVersion: 1 },
    { eventType: "BookSnapshot", schemaVersion: 1 },
    { eventType: "BookLevelChanged", schemaVersion: 1 },
    { eventType: "PublicTradeObserved", schemaVersion: 1 },
    { eventType: "ReferenceTradeObserved", schemaVersion: 1 },
    { eventType: "DataQualityIncidentOpened", schemaVersion: 1 },
    { eventType: "DataQualityIncidentClosed", schemaVersion: 1 },
  ]);

function contractKey(eventType: string, schemaVersion: number): string {
  return `${eventType}@${String(schemaVersion)}`;
}

/**
 * **D2** — one warmed arena copy per consumed contract, built at module load.
 *
 * A contract the registry does not carry is a BUILD failure here, not a silent
 * omission: the door would otherwise refuse every event of that type at
 * runtime, which looks like a feed problem rather than a wiring one.
 */
const DOORS: ReadonlyMap<string, { safeParse(value: unknown): { success: boolean } }> = (() => {
  const doors = new Map<string, { safeParse(value: unknown): { success: boolean } }>();
  for (const consumed of CONSUMED_EVENTS) {
    const contract = DOMAIN_EVENT_REGISTRY.require(consumed.eventType, consumed.schemaVersion);
    doors.set(
      contractKey(consumed.eventType, consumed.schemaVersion),
      prototypeFreeParser(contract.envelopeSchema),
    );
  }
  return doors;
})();

export type EventDoorRefusalCode =
  /** D1: the value is not a finite tree of plain own data. */
  | "EVENT_NOT_DATA"
  /** The routing fields are missing or unreadable. */
  | "EVENT_UNROUTABLE"
  /** A well-formed event of a type this process does not consume. */
  | "EVENT_TYPE_NOT_CONSUMED"
  /** D2: the envelope failed its frozen §7.1 contract. */
  | "EVENT_INVALID";

export interface EventDoorRefusal {
  readonly code: EventDoorRefusalCode;
  readonly detail: string;
  readonly issues: readonly string[];
}

export type ReadEventResult =
  | { readonly ok: true; readonly envelope: EventEnvelope<unknown> }
  | { readonly ok: false; readonly refusal: EventDoorRefusal };

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return Object.freeze(value);
}

function ownString(record: unknown, key: string): string | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  if (!Object.hasOwn(record, key)) return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function ownNumber(record: unknown, key: string): number | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  if (!Object.hasOwn(record, key)) return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

/**
 * Reads one wire envelope through the door. TOTAL: never throws.
 *
 * The order is the point: materialize (D1), route from the MATERIALIZED tree,
 * parse the materialized tree through the warmed copy (D2), and return that
 * same tree (D3/D4). No step re-reads the caller's object.
 */
export function readEventEnvelope(input: unknown): ReadEventResult {
  try {
    return readEventEnvelopeInner(input);
  } catch (cause) {
    // The warmed arena protects the PARSE; it does not protect the library's
    // own ERROR CONSTRUCTION, which builds property descriptors from object
    // literals and throws under an inherited `Object.prototype.get`
    // (`docs/contracts/schema-boundary.md` §2's "Descriptor literals" class;
    // measured against the pinned `zod` and transcribed in `config.ts`'s
    // header). Without this guard a malformed event would raise a `TypeError`
    // out of the one function whose entire job is to answer "this event is
    // malformed".
    return {
      ok: false,
      refusal: {
        code: "EVENT_NOT_DATA",
        detail:
          "reading the event failed unexpectedly and was contained (fail closed); an event " +
          "this process cannot evaluate is not an event it may act on",
        issues: [cause instanceof Error ? cause.message : String(cause)],
      },
    };
  }
}

function readEventEnvelopeInner(input: unknown): ReadEventResult {
  const read = readPlainData(input, "event");
  if (!read.ok) {
    return {
      ok: false,
      refusal: {
        code: "EVENT_NOT_DATA",
        detail:
          "the event is not a data record: an event envelope is a finite tree of plain own " +
          "data, so hidden, inherited, computed or unreadable state is refused rather than " +
          "inspected (fail closed)",
        issues: read.problems.map((problem) => `${problem.path}: ${problem.problem}`),
      },
    };
  }
  const materialized = read.value;

  const eventType = ownString(materialized, "eventType");
  const schemaVersion = ownNumber(materialized, "schemaVersion");
  if (eventType === undefined || schemaVersion === undefined) {
    return {
      ok: false,
      refusal: {
        code: "EVENT_UNROUTABLE",
        detail:
          "the envelope carries no readable (eventType, schemaVersion) pair; §7.1 makes both " +
          "required and routing cannot be guessed",
        issues: [],
      },
    };
  }

  const door = DOORS.get(contractKey(eventType, schemaVersion));
  if (door === undefined) {
    return {
      ok: false,
      refusal: {
        code: "EVENT_TYPE_NOT_CONSUMED",
        detail:
          `${eventType}@${String(schemaVersion)} is not an event this trader consumes; it is ` +
          "REFUSED by name rather than ignored, so a gateway that begins publishing something " +
          "new produces a loud refusal instead of silent under-processing",
        issues: [],
      },
    };
  }

  const parsed = door.safeParse(materialized) as
    | { success: true }
    | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } };
  if (!parsed.success) {
    return {
      ok: false,
      refusal: {
        code: "EVENT_INVALID",
        detail: `${eventType}@${String(schemaVersion)} failed its frozen §7.1 envelope contract`,
        issues: parsed.error.issues.map(
          (issue) => `${issue.path.map(String).join(".")}: ${issue.message}`,
        ),
      },
    };
  }

  // D3/D4 — the materialized tree is the answer; the schema only judged it.
  return { ok: true, envelope: deepFreeze(materialized) as EventEnvelope<unknown> };
}
