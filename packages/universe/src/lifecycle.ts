/**
 * Market lifecycle projection — handoff §7.4, §9.2, §10.1.
 *
 * The projection folds the frozen §7.4 market events into "what do we know
 * about this market now". It is a pure fold: `apply` returns a NEW projection
 * and never edits the one it was given, so a replay produces the same states in
 * the same order (§8.4, §12.4).
 *
 * FOUR RULES SHAPE EVERY TRANSITION HERE.
 *
 * 1. **A terminal outcome enters only through `MarketResolved`.** The frozen
 *    contract restricts that event to the four terminal states
 *    (`docs/contracts/domain.md` §6.2), and no other input to this module may
 *    set one — see {@link recordObservedOutcomeState}, which refuses them.
 * 2. **`DISPUTED` is not terminal and has no event.** ADR-009 §4 rules that a
 *    dispute is an in-flight process; the register in
 *    `docs/contracts/protected-contracts.md` §8 records that no venue-observed
 *    dispute transition exists. WP-110's venue re-check (2026-08-28) confirmed
 *    the venue documents a dispute PROCESS (UMA proposal, a 2-hour challenge
 *    period, a DVM vote) but publishes no documented dispute event or status
 *    vocabulary this repository could parse. So a dispute reaches the
 *    projection as an operator-recorded observation, not as an invented event.
 * 3. **A clarification after open is a first-class transition.** Verified
 *    2026-08-28 (https://docs.polymarket.com/concepts/resolution): "In rare
 *    cases, unforeseen circumstances require clarification of the rules after
 *    trading begins. Polymarket may issue an 'Additional context' update that
 *    proposers and voters should consider during resolution", and such
 *    clarifications "Are published onchain via the bulletin board contract".
 *    The projection therefore records whether each clarification arrived after
 *    the market opened and moves an unresolved market to
 *    `PENDING_CLARIFICATION`, which the readiness check treats as a stop.
 * 4. **An open instant is a fact; a close instant is a schedule.** A second
 *    `MarketOpened` with a different instant is a contradiction and is refused;
 *    a `MarketClosing` that moves the close is a legitimate reschedule (§9.2
 *    versions `close_time`) and is applied.
 *
 * AND EVERY PAYLOAD ENTERS THROUGH `./lifecycle-door.ts`. Rule 1 is only worth
 * as much as the reading of the event that carries the terminal outcome, and
 * `docs/contracts/schema-boundary.md` §3 (probe O) measured that a `zod` parse
 * does not give it: at the pinned `zod@4.4.3` a declared key the payload does
 * NOT carry is read off `Object.prototype`, so a `MarketResolved` without an
 * `outcome` resolved the market anyway. The door materializes the payload
 * prototype-free before the parse and hands the arms below a null-prototype
 * record built from the event's OWN properties (ADR-020 §3 D1/D3/D4); nothing
 * in this module reads `zod`'s output.
 */

import {
  MarketOutcomeStateSchema,
  isTerminalMarketOutcomeState,
  type MarketClarificationObservedPayloadSchema,
  type MarketClosingPayloadSchema,
  type MarketDiscoveredPayloadSchema,
  type MarketMetadataChangedPayloadSchema,
  type MarketOpenedPayloadSchema,
  type MarketResolvedPayloadSchema,
  type MarketRulesChangedPayloadSchema,
  type TradingParametersChangedPayloadSchema,
  type IsoTimestamp,
  type MarketOutcomeState,
} from "@polymarket-bot/domain";
import { equalsDecimal } from "@polymarket-bot/decimal";
import type { z } from "zod";

import {
  universeFailure,
  universeOk,
  universeRefusal,
  type UniverseRefusal,
  type UniverseResult,
} from "./errors.js";
import type { MarketIdentity } from "./identity.js";
import { openLifecyclePayload, ownEmit } from "./lifecycle-door.js";
import {
  lifecycleRank,
  type EventDrivenLifecycleState,
  type MarketLifecycleState,
} from "./lifecycle-state.js";
import { parameterVersion, type MarketParameterHistory } from "./parameters.js";
import type { MarketSeriesBinding } from "./series.js";
import { instantMilliseconds, isSameInstant } from "./time.js";

/** A clarification observed for a market (`catalog.market_clarifications`). */
export interface MarketClarificationRecord {
  readonly clarificationId: string;
  readonly observedAt: IsoTimestamp;
  /** The rules version the clarification attaches to, when the event names one. */
  readonly rulesVersionId?: string;
  /** Whether the market had already opened. The venue's "after trading begins" case. */
  readonly afterOpen: boolean;
  /** Whether the market had already resolved when this arrived. */
  readonly afterResolution: boolean;
}

/** Where an event sat in the gateway's ordering (§7.1, ADR-002 §2). */
export interface EventOrder {
  readonly gatewayEpoch: string;
  /** Monotonic within the epoch; a canonical unsigned integer string. */
  readonly ingestSeq: string;
}

/** Everything the registry knows about one market. */
export interface MarketProjection {
  readonly identity: MarketIdentity;
  readonly seriesBinding: MarketSeriesBinding;
  /** Event-driven only; `CLOSED` is derived — see {@link effectiveLifecycleState}. */
  readonly lifecycleState: EventDrivenLifecycleState;
  readonly outcomeState: MarketOutcomeState;
  readonly metadataVersion: number;
  readonly rulesVersionId?: string;
  readonly openedAt?: IsoTimestamp;
  /** The close instant last announced by a `MarketClosing` event. */
  readonly closesAt?: IsoTimestamp;
  readonly resolvedAt?: IsoTimestamp;
  readonly clarifications: readonly MarketClarificationRecord[];
  readonly parameters: MarketParameterHistory;
  readonly lastEventOrder?: EventOrder;
}

/** The §7.4 event types this projection folds. */
export const MARKET_LIFECYCLE_EVENT_TYPES = [
  "MarketDiscovered",
  "MarketMetadataChanged",
  "MarketRulesChanged",
  "MarketOpened",
  "MarketClosing",
  "MarketResolved",
  "MarketClarificationObserved",
  "TradingParametersChanged",
] as const;

export type MarketLifecycleEventType = (typeof MARKET_LIFECYCLE_EVENT_TYPES)[number];

/**
 * One event to fold.
 *
 * The payload is `unknown` and is validated against the FROZEN domain schema
 * inside this module — through `./lifecycle-door.ts`, which materializes it
 * prototype-free first and takes every folded value from that materialized
 * tree (ADR-020 §3, D1/D3/D4). A caller cannot skip validation by handing over
 * a pre-shaped object, and this package never defines its own copy of a
 * payload.
 */
export interface MarketLifecycleInput {
  readonly eventType: MarketLifecycleEventType;
  readonly payload: unknown;
  readonly order?: EventOrder;
}

/** What a fold produced. `changed` is false for an idempotent re-application. */
export interface ProjectionApplied {
  readonly projection: MarketProjection;
  readonly changed: boolean;
  /** Set when the event was accepted as a repeat of one already folded. */
  readonly idempotent: boolean;
}

/**
 * The one refusal every door rejection carries.
 *
 * The issues arrive already rendered from `./lifecycle-door.ts`, because
 * `zod`'s issue rendering is itself a prototype-reading path that must run
 * inside the door's containment (ADR-020 amendment 2026-09-06). The message and
 * details are byte-identical to what the raw parse produced.
 */
function invalidPayload(
  eventType: MarketLifecycleEventType,
  issues: readonly string[],
): UniverseRefusal {
  return universeRefusal(
    "UNIVERSE_INPUT_INVALID",
    `${eventType} payload is invalid: ${issues.join("; ")}`,
    { eventType, issues },
  );
}

interface MarketReference {
  readonly internalMarketId: string;
  readonly conditionId: string;
}

function checkIdentity(
  projection: MarketProjection,
  payload: MarketReference,
  eventType: MarketLifecycleEventType,
): UniverseRefusal | undefined {
  if (
    payload.internalMarketId !== projection.identity.internalMarketId ||
    payload.conditionId !== projection.identity.conditionId
  ) {
    return universeRefusal(
      "UNIVERSE_MARKET_IDENTITY_CONFLICT",
      `${eventType} names a different market than the projection it was applied to`,
      {
        eventType,
        projectionMarketId: projection.identity.internalMarketId,
        projectionConditionId: projection.identity.conditionId,
        eventMarketId: payload.internalMarketId,
        eventConditionId: payload.conditionId,
      },
    );
  }
  return undefined;
}

/**
 * Whether this event has already been folded, or arrived behind one that was.
 *
 * Ordering is `gatewayEpoch + ingestSeq` (§7.1). A NEW epoch is a gateway
 * restart, not a regression: sequence numbers restart with it, so ordering is
 * only compared inside one epoch (ADR-002 §2).
 */
function checkOrder(
  projection: MarketProjection,
  order: EventOrder | undefined,
  eventType: MarketLifecycleEventType,
): UniverseRefusal | undefined {
  const last = projection.lastEventOrder;
  if (order === undefined || last === undefined || last.gatewayEpoch !== order.gatewayEpoch) {
    return undefined;
  }
  if (BigInt(order.ingestSeq) > BigInt(last.ingestSeq)) {
    return undefined;
  }
  return universeRefusal(
    "UNIVERSE_EVENT_REPLAYED",
    `${eventType} did not advance ingestSeq within gateway epoch ${order.gatewayEpoch}`,
    {
      eventType,
      gatewayEpoch: order.gatewayEpoch,
      lastIngestSeq: last.ingestSeq,
      ingestSeq: order.ingestSeq,
    },
  );
}

function withOrder(
  projection: MarketProjection,
  order: EventOrder | undefined,
): MarketProjection {
  return order === undefined ? projection : { ...projection, lastEventOrder: order };
}

function applied(
  projection: MarketProjection,
  changed: boolean,
  idempotent = false,
): UniverseResult<ProjectionApplied> {
  return universeOk({ projection: Object.freeze(projection), changed, idempotent });
}

function regression(
  eventType: MarketLifecycleEventType,
  from: MarketLifecycleState,
  to: MarketLifecycleState,
): UniverseRefusal {
  return universeRefusal(
    "UNIVERSE_LIFECYCLE_REGRESSION",
    `${eventType} would move the market from ${from} back to ${to}`,
    { eventType, from, to },
  );
}

/**
 * Folds one §7.4 event into a market projection.
 *
 * Refuses rather than guesses: an event that contradicts a recorded fact, names
 * a different market, or repeats one already folded produces a typed refusal and
 * leaves the projection untouched.
 *
 * THE PAYLOAD IS READ THROUGH THE DOOR (`./lifecycle-door.ts`), never from
 * `zod`'s output. The nine sites that used to consume `parsed.data` — the
 * identity check and the eight dispatch arms — consume `payload`, a
 * null-prototype record built from the caller's OWN properties, because a
 * declared key the payload does not carry is otherwise supplied by
 * `Object.prototype` (`docs/contracts/schema-boundary.md` §3, probe O:
 * `outcome`, `resolvedAt` and `conditionId` measured, all 32 required keys of
 * the eight arms measured by `UNIV-1`). The `payload as ...` casts below are
 * the door's statement that it read exactly the keys the frozen schema
 * declares, in the shapes it declares.
 */
export function applyMarketLifecycleEvent(
  projection: MarketProjection,
  input: MarketLifecycleInput,
): UniverseResult<ProjectionApplied> {
  const door = openLifecyclePayload(input.eventType, input.payload);
  if (!door.ok) {
    return universeFailure(invalidPayload(input.eventType, door.issues));
  }
  const payload = door.value;

  const identityRefusal = checkIdentity(projection, payload as MarketReference, input.eventType);
  if (identityRefusal !== undefined) {
    return universeFailure(identityRefusal);
  }

  const orderRefusal = checkOrder(projection, input.order, input.eventType);
  if (orderRefusal !== undefined) {
    return universeFailure(orderRefusal);
  }

  const next = withOrder(projection, input.order);

  switch (input.eventType) {
    case "MarketDiscovered":
      return applyDiscovered(next, payload as z.infer<typeof MarketDiscoveredPayloadSchema>);
    case "MarketMetadataChanged":
      return applyMetadataChanged(
        next,
        payload as z.infer<typeof MarketMetadataChangedPayloadSchema>,
      );
    case "MarketRulesChanged":
      return applyRulesChanged(next, payload as z.infer<typeof MarketRulesChangedPayloadSchema>);
    case "MarketOpened":
      return applyOpened(next, payload as z.infer<typeof MarketOpenedPayloadSchema>);
    case "MarketClosing":
      return applyClosing(next, payload as z.infer<typeof MarketClosingPayloadSchema>);
    case "MarketResolved":
      return applyResolved(next, payload as z.infer<typeof MarketResolvedPayloadSchema>);
    case "MarketClarificationObserved":
      return applyClarification(
        next,
        payload as z.infer<typeof MarketClarificationObservedPayloadSchema>,
      );
    case "TradingParametersChanged":
      return applyParametersChanged(
        next,
        payload as z.infer<typeof TradingParametersChangedPayloadSchema>,
      );
  }
}

function applyDiscovered(
  projection: MarketProjection,
  payload: z.infer<typeof MarketDiscoveredPayloadSchema>,
): UniverseResult<ProjectionApplied> {
  // Registration carries the parameter set the event does not (§9.2 lists tick
  // size, minimum size, negRisk, fees and delays), so a discovery event for an
  // already-registered market is an identity and version cross-check, not a
  // second registration.
  if (
    payload.yesTokenId !== projection.identity.yesTokenId ||
    payload.noTokenId !== projection.identity.noTokenId
  ) {
    return universeFailure(
      universeRefusal(
        "UNIVERSE_MARKET_IDENTITY_CONFLICT",
        "MarketDiscovered names different outcome tokens than the registered market",
        {
          registeredYes: projection.identity.yesTokenId,
          registeredNo: projection.identity.noTokenId,
          eventYes: payload.yesTokenId,
          eventNo: payload.noTokenId,
        },
      ),
    );
  }
  if (payload.metadataVersion < projection.metadataVersion) {
    return universeFailure(
      universeRefusal(
        "UNIVERSE_METADATA_VERSION_NOT_ADVANCING",
        "MarketDiscovered carries an older metadata version than the projection",
        {
          projectionMetadataVersion: projection.metadataVersion,
          eventMetadataVersion: payload.metadataVersion,
        },
      ),
    );
  }
  if (payload.metadataVersion === projection.metadataVersion) {
    return applied(projection, false, true);
  }
  return applied({ ...projection, metadataVersion: payload.metadataVersion }, true);
}

function applyMetadataChanged(
  projection: MarketProjection,
  payload: z.infer<typeof MarketMetadataChangedPayloadSchema>,
): UniverseResult<ProjectionApplied> {
  if (payload.metadataVersion === projection.metadataVersion) {
    return applied(projection, false, true);
  }
  if (payload.metadataVersion < projection.metadataVersion) {
    return universeFailure(
      universeRefusal(
        "UNIVERSE_METADATA_VERSION_NOT_ADVANCING",
        "MarketMetadataChanged carries an older metadata version than the projection",
        {
          projectionMetadataVersion: projection.metadataVersion,
          eventMetadataVersion: payload.metadataVersion,
        },
      ),
    );
  }
  if (
    payload.previousMetadataVersion !== undefined &&
    payload.previousMetadataVersion !== projection.metadataVersion
  ) {
    return universeFailure(
      universeRefusal(
        "UNIVERSE_METADATA_VERSION_NOT_ADVANCING",
        "MarketMetadataChanged follows a metadata version the projection does not hold; a version was missed",
        {
          projectionMetadataVersion: projection.metadataVersion,
          eventPreviousMetadataVersion: payload.previousMetadataVersion,
        },
      ),
    );
  }
  return applied({ ...projection, metadataVersion: payload.metadataVersion }, true);
}

function applyRulesChanged(
  projection: MarketProjection,
  payload: z.infer<typeof MarketRulesChangedPayloadSchema>,
): UniverseResult<ProjectionApplied> {
  if (
    payload.previousRulesVersionId !== undefined &&
    payload.previousRulesVersionId !== projection.rulesVersionId
  ) {
    // A rules change that follows a version we never saw means the projection
    // has a hole: settling under it would settle under rules we cannot show.
    return universeFailure(
      universeRefusal(
        "UNIVERSE_RULES_VERSION_MISMATCH",
        "MarketRulesChanged follows a rules version the projection does not hold",
        {
          projectionRulesVersionId: projection.rulesVersionId,
          eventPreviousRulesVersionId: payload.previousRulesVersionId,
        },
      ),
    );
  }
  if (payload.rulesVersionId === projection.rulesVersionId) {
    return applied(projection, false, true);
  }
  return applied({ ...projection, rulesVersionId: payload.rulesVersionId }, true);
}

function applyOpened(
  projection: MarketProjection,
  payload: z.infer<typeof MarketOpenedPayloadSchema>,
): UniverseResult<ProjectionApplied> {
  if (projection.openedAt !== undefined) {
    if (isSameInstant(projection.openedAt, payload.openedAt)) {
      return applied(projection, false, true);
    }
    // An open instant is a fact about the past: it happened once.
    return universeFailure(
      universeRefusal(
        "UNIVERSE_LIFECYCLE_CONFLICT",
        "MarketOpened states a different open instant than the one already recorded",
        { recordedOpenedAt: projection.openedAt, eventOpenedAt: payload.openedAt },
      ),
    );
  }
  if (lifecycleRank(projection.lifecycleState) > lifecycleRank("DISCOVERED")) {
    return universeFailure(regression("MarketOpened", projection.lifecycleState, "OPEN"));
  }
  return applied({ ...projection, lifecycleState: "OPEN", openedAt: payload.openedAt }, true);
}

function applyClosing(
  projection: MarketProjection,
  payload: z.infer<typeof MarketClosingPayloadSchema>,
): UniverseResult<ProjectionApplied> {
  if (projection.lifecycleState === "RESOLVED") {
    return universeFailure(regression("MarketClosing", "RESOLVED", "CLOSING"));
  }
  if (
    projection.lifecycleState === "CLOSING" &&
    projection.closesAt !== undefined &&
    isSameInstant(projection.closesAt, payload.closesAt)
  ) {
    return applied(projection, false, true);
  }
  // A close instant is a SCHEDULE, and §9.2 versions `close_time`: a
  // reschedule is applied rather than refused, and the new instant is what
  // every cutoff check reads from then on.
  return applied({ ...projection, lifecycleState: "CLOSING", closesAt: payload.closesAt }, true);
}

function applyResolved(
  projection: MarketProjection,
  payload: z.infer<typeof MarketResolvedPayloadSchema>,
): UniverseResult<ProjectionApplied> {
  if (projection.lifecycleState === "RESOLVED") {
    if (
      projection.outcomeState === payload.outcome &&
      projection.resolvedAt !== undefined &&
      isSameInstant(projection.resolvedAt, payload.resolvedAt)
    ) {
      return applied(projection, false, true);
    }
    return universeFailure(
      universeRefusal(
        "UNIVERSE_TERMINAL_OUTCOME_CONFLICT",
        "the market is already resolved with a different terminal outcome",
        {
          recordedOutcome: projection.outcomeState,
          recordedResolvedAt: projection.resolvedAt,
          eventOutcome: payload.outcome,
          eventResolvedAt: payload.resolvedAt,
        },
      ),
    );
  }
  return applied(
    {
      ...projection,
      lifecycleState: "RESOLVED",
      outcomeState: payload.outcome,
      resolvedAt: payload.resolvedAt,
      ...(payload.rulesVersionId === undefined
        ? {}
        : { rulesVersionId: payload.rulesVersionId }),
    },
    true,
  );
}

function applyClarification(
  projection: MarketProjection,
  payload: z.infer<typeof MarketClarificationObservedPayloadSchema>,
): UniverseResult<ProjectionApplied> {
  const existing = projection.clarifications.find(
    (record) => record.clarificationId === payload.clarificationId,
  );
  if (existing !== undefined) {
    if (isSameInstant(existing.observedAt, payload.observedAt)) {
      return applied(projection, false, true);
    }
    return universeFailure(
      universeRefusal(
        "UNIVERSE_LIFECYCLE_CONFLICT",
        "a clarification with this id was already observed at a different instant",
        {
          clarificationId: payload.clarificationId,
          recordedObservedAt: existing.observedAt,
          eventObservedAt: payload.observedAt,
        },
      ),
    );
  }

  const afterResolution = projection.lifecycleState === "RESOLVED";
  const openedMs =
    projection.openedAt === undefined ? undefined : instantMilliseconds(projection.openedAt);
  const observedMs = instantMilliseconds(payload.observedAt);
  // "After trading begins" is a question about the OBSERVATION instant, not
  // about when we happened to receive it: a clarification issued before the
  // open and delivered late is not a post-open clarification. The lifecycle
  // state is the fallback for a market whose open instant we never observed.
  const afterOpen =
    openedMs !== undefined && observedMs !== undefined
      ? observedMs >= openedMs
      : projection.lifecycleState === "OPEN" ||
        projection.lifecycleState === "CLOSING" ||
        afterResolution;

  // D4: the record this module EMITS is prototype-free. A consumer asking a
  // clarification for a `rulesVersionId` it does not carry must get
  // `undefined`, not whatever `Object.prototype` holds — the output-side half
  // of the same class the door closes on the input side.
  const record: MarketClarificationRecord = Object.freeze(
    ownEmit<MarketClarificationRecord>({
      clarificationId: payload.clarificationId,
      observedAt: payload.observedAt,
      ...(payload.rulesVersionId === undefined
        ? {}
        : { rulesVersionId: payload.rulesVersionId }),
      afterOpen,
      afterResolution,
    }),
  );

  // EVERY unresolved clarification moves the market to
  // `PENDING_CLARIFICATION`, including one observed before the open: a
  // clarification amends the rules a settlement spec was reviewed against, and
  // the reviewed spec's `clarification_policy` is what decides whether the
  // series resumes. Halting for a re-review is the conservative direction, and
  // `afterOpen` on the record preserves which kind it was.
  //
  // A clarification never un-resolves a market: the payoff is determined and
  // `MarketResolved` is the only authority over a terminal outcome. It IS
  // recorded, because a post-resolution clarification is exactly the evidence a
  // reconciliation needs.
  const outcomeState: MarketOutcomeState = afterResolution
    ? projection.outcomeState
    : "PENDING_CLARIFICATION";

  return applied(
    {
      ...projection,
      outcomeState,
      clarifications: Object.freeze([...projection.clarifications, record]),
    },
    true,
  );
}

function applyParametersChanged(
  projection: MarketProjection,
  payload: z.infer<typeof TradingParametersChangedPayloadSchema>,
): UniverseResult<ProjectionApplied> {
  // The authoritative parameter history is written by `recordMarketParameters`,
  // which holds the full snapshot; this event is a NOTIFICATION. Folding it is
  // therefore a consistency check: if the two disagree, something upstream is
  // versioning parameters differently than the catalog is.
  const version = parameterVersion(projection.parameters, payload.parametersVersion);
  if (version === undefined) {
    return universeFailure(
      universeRefusal(
        "UNIVERSE_PARAMETERS_VERSION_UNKNOWN",
        "TradingParametersChanged names a parameter version the registry has not recorded",
        {
          eventParametersVersion: payload.parametersVersion,
          recordedVersions: projection.parameters.versions.map(
            (entry) => entry.parametersVersion,
          ),
        },
      ),
    );
  }

  const disagreements: string[] = [];
  if (payload.parameterVersionRef !== version.parameterVersionRef) {
    disagreements.push(
      `parameterVersionRef ${payload.parameterVersionRef} != ${version.parameterVersionRef}`,
    );
  }
  if (
    payload.tickSize !== undefined &&
    !equalsDecimal(payload.tickSize, version.parameters.tickSize)
  ) {
    disagreements.push(`tickSize ${payload.tickSize} != ${version.parameters.tickSize}`);
  }
  if (
    payload.minimumOrderSize !== undefined &&
    !equalsDecimal(payload.minimumOrderSize, version.parameters.minimumOrderSize)
  ) {
    disagreements.push(
      `minimumOrderSize ${payload.minimumOrderSize} != ${version.parameters.minimumOrderSize}`,
    );
  }
  if (disagreements.length > 0) {
    return universeFailure(
      universeRefusal(
        "UNIVERSE_PARAMETERS_EVENT_DISAGREES",
        `TradingParametersChanged contradicts recorded version ${String(payload.parametersVersion)}: ${disagreements.join("; ")}`,
        { eventParametersVersion: payload.parametersVersion, disagreements },
      ),
    );
  }

  return applied(projection, false, true);
}

/** An outcome state observed outside the §7.4 event set. */
export interface ObservedOutcomeStateInput {
  readonly outcomeState: MarketOutcomeState;
  readonly observedAt: IsoTimestamp;
  /** Who or what observed it — an operator id, a reconciliation job. */
  readonly observedBy: string;
}

/**
 * Records a NON-TERMINAL settlement state that no §7.4 event carries.
 *
 * This is the only way `DISPUTED` enters the projection, and it exists because
 * the frozen contracts carry no dispute event and the venue publishes no
 * documented dispute transition (ADR-009 §4;
 * `docs/contracts/protected-contracts.md` §8, "No dedicated dispute event").
 * Inventing a `MarketDisputed` event here would be a contract change this
 * package may not make; recording an operator observation is not.
 *
 * A TERMINAL state is refused: `MarketResolved` is the sole authority over a
 * determined payoff, and a manual path into `YES_WIN` would let an operator
 * assert a resolution the venue never published.
 */
export function recordObservedOutcomeState(
  projection: MarketProjection,
  input: ObservedOutcomeStateInput,
): UniverseResult<ProjectionApplied> {
  const parsed = MarketOutcomeStateSchema.safeParse(input.outcomeState);
  if (!parsed.success) {
    return universeFailure(
      universeRefusal("UNIVERSE_INPUT_INVALID", "outcome state is not in the §9.3 vocabulary", {
        outcomeState: input.outcomeState,
      }),
    );
  }
  if (isTerminalMarketOutcomeState(parsed.data)) {
    return universeFailure(
      universeRefusal(
        "UNIVERSE_TERMINAL_OUTCOME_REQUIRES_EVENT",
        `${parsed.data} is a terminal outcome and may only enter the projection through MarketResolved`,
        { outcomeState: parsed.data, observedBy: input.observedBy },
      ),
    );
  }
  if (projection.lifecycleState === "RESOLVED") {
    return universeFailure(
      universeRefusal(
        "UNIVERSE_TERMINAL_OUTCOME_CONFLICT",
        "the market has already resolved; its outcome cannot be moved back to a non-terminal state",
        { recordedOutcome: projection.outcomeState, proposed: parsed.data },
      ),
    );
  }
  if (projection.outcomeState === parsed.data) {
    return applied(projection, false, true);
  }
  return applied({ ...projection, outcomeState: parsed.data }, true);
}

/**
 * The lifecycle state as of an instant, including the DERIVED `CLOSED`.
 *
 * `CLOSED` has no event (see `lifecycle-state.ts`), so it is computed from the
 * close instant the market announced — the `MarketClosing` instant when there
 * is one, otherwise the scheduled `closeTime` parameter — and the caller's "as
 * of" instant. Time enters as DATA: this function reads no clock.
 *
 * `CLOSED` HERE MEANS "THE SCHEDULED CLOSE HAS ELAPSED" AND NOTHING MORE
 * (round-1 review, M3). It is a statement about the schedule, not an observed
 * venue fact: the venue may close early (the schedule then overstates the
 * window) or keep trading past the announced instant (the schedule then
 * understates it), and no §7.4 event asserts either. Consumers must treat
 * derived `CLOSED` as "refuse NEW activation" — see `eligibility.ts`, which
 * keeps OBSERVING an opened, unresolved market past its scheduled close until
 * `MarketResolved` or reconciliation establishes closure.
 */
export function effectiveLifecycleState(
  projection: MarketProjection,
  asOf: IsoTimestamp,
): MarketLifecycleState {
  if (projection.lifecycleState === "RESOLVED") {
    return "RESOLVED";
  }
  const closeInstant = effectiveCloseInstant(projection);
  if (closeInstant === undefined) {
    return projection.lifecycleState;
  }
  const closeMs = instantMilliseconds(closeInstant);
  const asOfMs = instantMilliseconds(asOf);
  if (closeMs === undefined || asOfMs === undefined) {
    return projection.lifecycleState;
  }
  return asOfMs >= closeMs ? "CLOSED" : projection.lifecycleState;
}

/**
 * The close instant in force: the announced one, else the scheduled parameter.
 *
 * A `MarketClosing` event is an observation about this market; the `closeTime`
 * parameter is the schedule recorded in the catalog. The event wins when both
 * exist, because it is the later statement about the same fact.
 */
export function effectiveCloseInstant(projection: MarketProjection): IsoTimestamp | undefined {
  if (projection.closesAt !== undefined) {
    return projection.closesAt;
  }
  const current = projection.parameters.versions[projection.parameters.versions.length - 1];
  return current?.parameters.closeTime;
}

/** Clarifications that arrived after the market opened, in observation order. */
export function clarificationsAfterOpen(
  projection: MarketProjection,
): readonly MarketClarificationRecord[] {
  return projection.clarifications.filter((record) => record.afterOpen);
}
