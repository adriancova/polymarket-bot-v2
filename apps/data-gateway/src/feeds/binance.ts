/**
 * Binance reference-feed driver: the reconnect scheduler and transport owner
 * the WP-080 adapter deliberately does not contain.
 *
 * ## The connection-identity contract, both halves (WP-080 round-2/round-5)
 *
 * 1. **Uniqueness**: every attempt's id comes from `ConnectionIdFactory` —
 *    a per-feed ordinal, never reused.
 * 2. **Registration**: `feed.connecting(id)` is called BEFORE the transport is
 *    asked for the socket, and the SAME id rides on the `BinanceSocketRequest`
 *    so the transport stamps it on every event that socket produces.
 *
 * ## Rejected events are outcomes, with observable counters
 *
 * A `rejected` outcome from a superseded, retired, or unauthorized socket is
 * counted here and never relabeled as current-generation data — the adapter
 * already refused it; this driver's job is to not undo that at the assembly
 * layer. Two refusal shapes carry driver obligations:
 *
 * - A rejected `CLOSE` with `relation: "PENDING"` is the definitive "your
 *   replacement attempt failed" signal (WP-080 round-5 follow-up 1): the feed
 *   emits no `FeedDisconnected` for it because the feed is not disconnected.
 *   This driver counts it as a FAILED ATTEMPT in its own reconnect accounting
 *   and schedules the next attempt itself with the policy's own backoff.
 * - Unauthorized-identity events (`relation: "UNKNOWN"`/`"INVALID"`) are a
 *   stronger signal — something is calling into a feed it was never part of
 *   (WP-080 round-2 follow-up 2). Past the configured threshold the driver
 *   opens a PAGE incident naming the rate.
 *
 * ## `NONE` after `FeedDisconnected` means "wait for the attempt you started"
 *
 * (WP-080 round-4 follow-up 1, sharpened in round 5.) When the live socket
 * closes during a make-before-break, the feed keeps the registered
 * replacement, becomes `CONNECTING`, and directs NOTHING. This driver then
 * waits for the attempt it already opened instead of registering a third
 * identity. If it observes that combination while `feed.pendingConnectionId`
 * is `undefined` — an attempt the feed is not waiting for — that is a
 * transport bug by the round-5 wording, and it opens an incident rather than
 * stalling silently.
 *
 * ## Raw before normalized (acceptance 1)
 *
 * A `MESSAGE` is WAL-recorded before it is handed to `feed.onFrame`; the
 * emissions that come back are dispatched with the recorded frame's causation.
 * A WAL refusal suppresses the frame's normalized emissions (counted, PAGE
 * incident) exactly as on the other feeds.
 */

import type {
  AdapterEmission,
  BinanceReferenceFeed,
  BinanceSocket,
  BinanceSocketEvent,
  BinanceSocketFactory,
  ConnectionDirective,
  FeedOutcome,
  FrameOutcome,
  ReconnectPolicy,
  RejectedSocketEvent,
} from "@polymarket-bot/binance-adapter";
import { nextReconnectDelayMs } from "@polymarket-bot/binance-adapter";

import { ConnectionIdFactory } from "../connection-ids.js";
import type { GatewayDispatcher } from "../dispatcher.js";
import type { GatewayJournal } from "../journal.js";
import type { CancelScheduled, GatewayClock, GatewayReceipt, GatewayTimers } from "../ports.js";
import { takeReceipt } from "../ports.js";

/** How many `connectionId → generation` pairs the driver remembers. */
const MAX_REMEMBERED_GENERATIONS = 64;

export interface BinanceFeedDriverOptions {
  readonly feedId: string;
  readonly feed: BinanceReferenceFeed;
  readonly socketFactory: BinanceSocketFactory;
  readonly journal: GatewayJournal;
  readonly dispatcher: GatewayDispatcher;
  readonly clock: GatewayClock;
  readonly timers: GatewayTimers;
  readonly reconnectPolicy: ReconnectPolicy;
  /** Unauthorized-event incident threshold (WP-080 round-2 follow-up 2). */
  readonly unauthorizedEventEscalationThreshold: number;
}

export interface BinanceFeedDriverMetrics {
  readonly framesRecorded: number;
  readonly framesRefusedByWal: number;
  readonly emissionsDispatched: number;
  readonly emissionsSuppressedUnrecorded: number;
  readonly rejectedSocketEvents: number;
  readonly unauthorizedSocketEvents: number;
  readonly stallsObserved: number;
  readonly pendingCloseFailures: number;
  readonly reconnectsScheduled: number;
  readonly waitedOnOutstandingAttempt: number;
  readonly directiveStops: number;
  /** The in-flight attempt the feed is waiting on (dashboards read this). */
  readonly pendingConnectionId: string | undefined;
}

export class BinanceFeedDriver {
  readonly #options: BinanceFeedDriverOptions;
  readonly #ids: ConnectionIdFactory;
  readonly #generationByConnection = new Map<string, number>();
  #socket: BinanceSocket | undefined;
  #reconnectTimer: CancelScheduled | undefined;
  #driverFailedAttempts = 0;
  #stopped = false;

  #framesRecorded = 0;
  #framesRefusedByWal = 0;
  #emissionsDispatched = 0;
  #emissionsSuppressed = 0;
  #rejectedSocketEvents = 0;
  #unauthorizedSocketEvents = 0;
  #stallsObserved = 0;
  #pendingCloseFailures = 0;
  #reconnectsScheduled = 0;
  #waitedOnOutstandingAttempt = 0;
  #directiveStops = 0;

  constructor(options: BinanceFeedDriverOptions) {
    this.#options = options;
    this.#ids = new ConnectionIdFactory(options.feedId);
  }

  /** Opens the first connection. */
  start(): void {
    if (this.#stopped) return;
    this.#openAttempt();
  }

  /** Driven by the gateway tick: staleness surveillance. */
  tick(): void {
    if (this.#stopped) return;
    const receipt = takeReceipt(this.#options.clock);
    const outcome = this.#options.feed.checkStaleness(receipt);
    this.#applyOutcome(outcome, receipt, undefined);
  }

  stop(): void {
    this.#stopped = true;
    this.#reconnectTimer?.();
    this.#reconnectTimer = undefined;
    const receipt = takeReceipt(this.#options.clock);
    const outcome = this.#options.feed.close(receipt, "gateway shutdown");
    this.#applyOutcome(outcome, receipt, undefined);
    this.#socket?.close();
    this.#socket = undefined;
  }

  /**
   * Registers a fresh identity and asks the transport for the socket.
   *
   * Registration precedes the transport call, and the identity on the request
   * is the registered one — the two halves of the WP-080 contract.
   */
  #openAttempt(): void {
    if (this.#stopped) return;
    const connectionId = this.#ids.next();
    const registration = this.#options.feed.connecting(connectionId);
    this.#socket = this.#options.socketFactory({
      url: registration.url,
      connectionId,
      onEvent: (event) => {
        this.#handleSocketEvent(event);
      },
    });
  }

  #handleSocketEvent(event: BinanceSocketEvent): void {
    if (this.#stopped) return;
    const receipt = takeReceipt(this.#options.clock);

    let rawFrame: { readonly ingestSeq: string; readonly recorded: boolean } | undefined;
    if (event.type === "MESSAGE") {
      // Acceptance 1: the exact frame reaches the WAL queue before anything
      // derived from it can be published. The record carries the identity of
      // the socket that PRODUCED it, never the current one.
      const outcome = this.#options.journal.record({
        source: "binance",
        endpoint: this.#options.feed.endpointIdentifier,
        connectionId: event.connectionId,
        // The generation this connection opened under; 0 for a socket that
        // never opened here (its frame is preserved verbatim either way, and
        // the adapter classifies it rather than adopting it).
        subscriptionGeneration: this.#generationByConnection.get(event.connectionId) ?? 0,
        receipt,
        payloadUtf8: event.data,
      });
      if (outcome.recorded) {
        this.#framesRecorded += 1;
        rawFrame = { ingestSeq: outcome.ingestSeq, recorded: true };
      } else {
        this.#framesRefusedByWal += 1;
        rawFrame = { ingestSeq: outcome.ingestSeq, recorded: false };
        this.#options.dispatcher.openIncident({
          scope: this.#options.feedId,
          reasonCode: "GATEWAY_WAL_FRAME_REFUSED",
          severity: "PAGE",
          detail: `the WAL refused a raw Binance frame (${outcome.reason}): ${outcome.detail}; derived reference data will not be published`,
          feedId: this.#options.feedId,
        });
      }
    }

    const outcome = this.#options.feed.handleSocketEvent(event, receipt);

    if (event.type === "OPEN" && outcome.rejected === undefined) {
      this.#generationByConnection.set(
        event.connectionId,
        this.#options.feed.subscriptionGeneration,
      );
      if (this.#generationByConnection.size > MAX_REMEMBERED_GENERATIONS) {
        const oldest = this.#generationByConnection.keys().next();
        if (!oldest.done) this.#generationByConnection.delete(oldest.value);
      }
      this.#driverFailedAttempts = 0;
    }

    this.#applyOutcome(outcome, receipt, rawFrame, event);
  }

  #applyOutcome(
    outcome: FeedOutcome | FrameOutcome,
    receipt: GatewayReceipt,
    rawFrame: { readonly ingestSeq: string; readonly recorded: boolean } | undefined,
    event?: BinanceSocketEvent,
  ): void {
    if (rawFrame !== undefined && !rawFrame.recorded) {
      // The raw evidence was refused; the frame's normalized emissions do not
      // enter the stream (counted; the PAGE incident is already open).
      this.#emissionsSuppressed += outcome.emissions.length;
    } else {
      for (const emission of outcome.emissions) {
        this.#dispatchEmission(emission, receipt, rawFrame?.ingestSeq);
      }
    }

    if (outcome.rejected !== undefined) {
      this.#handleRejected(outcome.rejected);
    }

    if ("advisory" in outcome && outcome.advisory === "ESTABLISH_NEW_CONNECTION") {
      // The documented `serverShutdown` response: open a replacement WHILE the
      // current socket is still live (make-before-break). The adapter surfaces
      // the instruction rather than acting on it, because running two sockets
      // is a gateway decision — this is that decision.
      this.#openAttempt();
    }

    this.#applyDirective(outcome.directive, event, outcome.rejected);
  }

  #dispatchEmission(
    emission: AdapterEmission,
    receipt: GatewayReceipt,
    rawFrameIngestSeq: string | undefined,
  ): void {
    this.#emissionsDispatched += 1;
    if (emission.eventType === "FeedStale") {
      // A silent socket stall: the socket is open and Binance has published
      // nothing past the configured tolerance. The adapter reports it; the
      // gateway escalates it to a data-quality incident (§8.3, §9.9).
      this.#stallsObserved += 1;
      this.#options.dispatcher.openIncident({
        scope: this.#options.feedId,
        reasonCode: "GATEWAY_FEED_STALL",
        severity: "NOTIFY",
        detail: `the reference feed went silent past its staleness tolerance (${JSON.stringify(emission.payload)})`,
        feedId: this.#options.feedId,
      });
    }
    if (emission.eventType === "FeedConnected") {
      // A fresh connection ends the stall episode, so a later stall opens a
      // new incident instead of deduping against the previous one.
      this.#options.dispatcher.markIncidentClosed(this.#options.feedId, "GATEWAY_FEED_STALL");
    }
    void this.#options.dispatcher.dispatch(
      {
        eventType: emission.eventType,
        schemaVersion: emission.schemaVersion,
        source: emission.source,
        sourceChannel: emission.sourceChannel,
        venueTimestamp: emission.venueTimestamp,
        connectionId: emission.connectionId,
        subscriptionGeneration: emission.subscriptionGeneration,
        payload: emission.payload,
      },
      {
        // The emission's own receipt stamps are authoritative (they were taken
        // when the frame arrived); `nowMs` only feeds the eventId's time bits.
        receipt: {
          receivedAt: emission.receivedAt,
          receivedMonotonicNs: emission.receivedMonotonicNs,
          nowMs: receipt.nowMs,
        },
        ...(rawFrameIngestSeq === undefined ? {} : { rawFrameIngestSeq }),
      },
    );
  }

  #handleRejected(rejected: RejectedSocketEvent): void {
    this.#rejectedSocketEvents += 1;

    if (rejected.eventType === "CLOSE" && rejected.relation === "PENDING") {
      // WP-080 round-5 follow-up 1: the replacement attempt failed before it
      // opened, the feed emits no FeedDisconnected for it, and the driver owns
      // counting it as a failed attempt and retrying.
      this.#pendingCloseFailures += 1;
      this.#driverFailedAttempts += 1;
      const attempt = this.#driverFailedAttempts + 1;
      const policy = this.#options.reconnectPolicy;
      if (policy.maxAttempts !== undefined && attempt > policy.maxAttempts) {
        this.#options.dispatcher.openIncident({
          scope: this.#options.feedId,
          reasonCode: "BINANCE_RECONNECT_ATTEMPTS_EXHAUSTED",
          severity: "PAGE",
          detail: `replacement attempts exhausted after ${String(this.#driverFailedAttempts)} pre-open failures`,
          feedId: this.#options.feedId,
        });
        return;
      }
      this.#scheduleReconnect(nextReconnectDelayMs(attempt, policy));
      return;
    }

    if (rejected.relation === "UNKNOWN" || rejected.relation === "INVALID") {
      this.#unauthorizedSocketEvents += 1;
      if (this.#unauthorizedSocketEvents >= this.#options.unauthorizedEventEscalationThreshold) {
        this.#options.dispatcher.openIncident({
          scope: this.#options.feedId,
          reasonCode: "BINANCE_UNAUTHORIZED_EVENT_RATE",
          severity: "PAGE",
          detail: `${String(this.#unauthorizedSocketEvents)} socket events from identities this feed never authorized; something is calling into a feed it was never part of`,
          feedId: this.#options.feedId,
        });
      }
    }
  }

  #applyDirective(
    directive: ConnectionDirective,
    event: BinanceSocketEvent | undefined,
    rejected: RejectedSocketEvent | undefined,
  ): void {
    switch (directive.kind) {
      case "NONE": {
        if (event?.type === "CLOSE" && rejected === undefined) {
          // An APPLIED close with directive NONE: the feed is waiting for the
          // replacement attempt this driver already started.
          if (this.#options.feed.pendingConnectionId !== undefined) {
            this.#waitedOnOutstandingAttempt += 1;
          } else {
            // Round-5 wording: NONE with no unresolved attempt is a transport
            // bug. Loud, never a silent stall.
            this.#options.dispatcher.openIncident({
              scope: this.#options.feedId,
              reasonCode: "BINANCE_DRIVER_NO_OUTSTANDING_ATTEMPT",
              severity: "PAGE",
              detail:
                "the feed directed NONE after a disconnect while waiting on no attempt; transport bug — the driver would stall",
              feedId: this.#options.feedId,
            });
          }
        }
        return;
      }
      case "RECONNECT_AFTER": {
        this.#driverFailedAttempts = Math.max(this.#driverFailedAttempts, directive.attempt);
        this.#scheduleReconnect(directive.delayMs);
        return;
      }
      case "STOP": {
        this.#directiveStops += 1;
        if (directive.reason === "RECONNECT_ATTEMPTS_EXHAUSTED") {
          this.#options.dispatcher.openIncident({
            scope: this.#options.feedId,
            reasonCode: "BINANCE_RECONNECT_ATTEMPTS_EXHAUSTED",
            severity: "PAGE",
            detail: "the reconnect policy's attempt budget is exhausted; the feed stays down",
            feedId: this.#options.feedId,
          });
        }
        return;
      }
    }
  }

  #scheduleReconnect(delayMs: number): void {
    if (this.#stopped) return;
    this.#reconnectsScheduled += 1;
    this.#reconnectTimer?.();
    this.#reconnectTimer = this.#options.timers.setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#openAttempt();
    }, delayMs);
  }

  metrics(): BinanceFeedDriverMetrics {
    return {
      framesRecorded: this.#framesRecorded,
      framesRefusedByWal: this.#framesRefusedByWal,
      emissionsDispatched: this.#emissionsDispatched,
      emissionsSuppressedUnrecorded: this.#emissionsSuppressed,
      rejectedSocketEvents: this.#rejectedSocketEvents,
      unauthorizedSocketEvents: this.#unauthorizedSocketEvents,
      stallsObserved: this.#stallsObserved,
      pendingCloseFailures: this.#pendingCloseFailures,
      reconnectsScheduled: this.#reconnectsScheduled,
      waitedOnOutstandingAttempt: this.#waitedOnOutstandingAttempt,
      directiveStops: this.#directiveStops,
      pendingConnectionId: this.#options.feed.pendingConnectionId,
    };
  }
}
