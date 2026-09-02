/**
 * Coinbase reference-feed driver: the gateway's ownership of the WP-090
 * connection manager.
 *
 * ## Raw before normalized, via the socket factory (acceptance 1)
 *
 * The manager owns its own socket, so the gateway cannot interpose between
 * the socket and the processor — EXCEPT at the factory boundary the manager
 * itself injects. `RecordingCoinbaseSocketFactory` wraps the real factory:
 * its `onFrame` records the exact frame to the WAL and only then forwards it
 * to the manager's own listener, so the WAL enqueue provably precedes
 * normalization and publication. Each wrapped listener closes over ITS OWN
 * socket's provenance, so a frame from a superseded socket is recorded under
 * the identity AND the generation of the socket that produced it — never
 * relabeled (the defect class all three 1B adapters guard against is not
 * reintroduced here; see the next section for how round 1 half-reintroduced
 * it anyway).
 *
 * ## Provenance is CAPTURED, not looked up (round-1 review M1)
 *
 * Round 1 captured the connection id by closure but read
 * `subscriptionGeneration` from the manager's CURRENT metrics at the instant
 * each frame arrived. A late frame from a superseded socket was therefore
 * recorded with the LIVE socket's generation: the raw WAL record described
 * `c1`'s bytes as belonging to `c2`'s generation — the precise relabelling
 * defect `subscriptionGeneration` exists to prevent, reintroduced at the
 * recording layer after all three 1B adapters guarded against it.
 *
 * Each wrapped socket now owns an immutable {@link CoinbaseSocketProvenance}
 * captured at ITS OWN `onOpen`, and every frame from that socket is recorded
 * under it, forever. The capture reads the manager's own `connectionId` and
 * `subscriptionGeneration` — not a guess — and it knows the read applies to
 * THIS socket because `counters.connectionsOpened` advanced by exactly one
 * across the forwarded `onOpen`. The manager never advances a generation
 * mid-connection (it reconnects instead of calling
 * `CoinbaseStreamProcessor.resubscribed()`), so the captured value stays true
 * for the socket's whole life.
 *
 * The `<feedId>-c<ordinal>` lockstep guess survives ONLY as the fallback for
 * a frame that arrives before the manager adopted the socket — a window in
 * which no generation has been established at all. Such frames are recorded
 * with generation `0` and COUNTED
 * (`framesWithoutEstablishedProvenance`), so "no generation was established"
 * is visible rather than mistaken for generation zero.
 *
 * A binary frame cannot enter the WAL (`payloadUtf8` cannot hold it,
 * ADR-004 §1); it is counted here and surfaces as the adapter's own
 * `COINBASE_FRAME_NOT_TEXT` PAGE anomaly — reported, never silently dropped.
 *
 * ## Every anomaly is routed (WP-090 rounds 1–2, follow-up 2)
 *
 * Every `CoinbaseAnomaly` — explicitly including `COINBASE_SNAPSHOT_NOT_APPLIED`
 * and `COINBASE_STALE_CONNECTION_ACTIVITY` — becomes a
 * `DataQualityIncidentOpened` with the adapter's own severity map and the raw
 * frame preserved in the detail path (the frame is already in the WAL via the
 * factory wrapper).
 *
 * ## Reconnect-loop escalation (WP-090 known risk 1; the gateway owns it)
 *
 * A channel whose snapshot persistently fails to apply produces a loud
 * reconnect loop: gap → reconnect → snapshot refused → gap. The driver
 * counts consecutive `COINBASE_SNAPSHOT_NOT_APPLIED` per channel, resets on
 * `FeedResynchronized`, and past the configured threshold opens a PAGE
 * incident (`COINBASE_SNAPSHOT_ESCALATION`). Consecutive failed connection
 * attempts (`manager.consecutiveFailures`, checked on the gateway tick) get
 * the same treatment under `COINBASE_RECONNECT_LOOP`.
 */

import type {
  CoinbaseAnomaly,
  CoinbaseConnectionManager,
  CoinbaseFeedOutput,
  CoinbaseRawFrame,
  CoinbaseSocket,
  CoinbaseSocketFactory,
  CoinbaseSocketListener,
} from "@polymarket-bot/coinbase-adapter";
import { COINBASE_CONNECTION_CHANNEL } from "@polymarket-bot/coinbase-adapter";

import type { GatewayDispatcher } from "../dispatcher.js";
import type { GatewayJournal } from "../journal.js";
import type { GatewayClock } from "../ports.js";
import { takeReceipt } from "../ports.js";

interface CurrentRawFrame {
  readonly ingestSeq: string;
  readonly recorded: boolean;
}

/**
 * One socket's immutable recording provenance.
 *
 * `established` distinguishes "the manager adopted this socket and told us its
 * identity and generation" from "this socket delivered a frame before it was
 * adopted, so no generation exists yet and `0` is a placeholder, not a claim".
 */
export interface CoinbaseSocketProvenance {
  connectionId: string;
  subscriptionGeneration: number;
  established: boolean;
}

/**
 * Wraps a socket factory so every text frame reaches the WAL before the
 * manager's own listener sees it. Created by the driver; handed to the
 * manager's constructor.
 */
export class RecordingCoinbaseSocketFactory implements CoinbaseSocketFactory {
  readonly #inner: CoinbaseSocketFactory;
  readonly #driver: CoinbaseFeedDriver;
  #connectOrdinal = 0;

  constructor(inner: CoinbaseSocketFactory, driver: CoinbaseFeedDriver) {
    this.#inner = inner;
    this.#driver = driver;
  }

  connect(endpoint: string, listener: CoinbaseSocketListener): CoinbaseSocket {
    this.#connectOrdinal += 1;
    // Provisional until this socket is adopted: the manager's own id format,
    // derived from the attempt ordinal. It labels ONLY frames that arrive in
    // the pre-adoption window, and those are counted.
    const provenance: CoinbaseSocketProvenance = {
      connectionId: `${this.#driver.feedId}-c${String(this.#connectOrdinal)}`,
      subscriptionGeneration: 0,
      established: false,
    };
    return this.#inner.connect(endpoint, {
      onOpen: () => {
        const openedBefore = this.#driver.managerConnectionsOpened();
        listener.onOpen();
        const adopted = this.#driver.managerProvenance();
        if (adopted !== undefined && adopted.connectionsOpened === openedBefore + 1) {
          // The manager ran `connectionOpened` for THIS socket, so its current
          // view describes this socket. Captured once; never re-read.
          provenance.connectionId = adopted.connectionId;
          provenance.subscriptionGeneration = adopted.subscriptionGeneration;
          provenance.established = true;
        }
      },
      onFrame: (frame: CoinbaseRawFrame) => {
        // WAL first; the provenance is THIS socket's, captured at its open and
        // immutable thereafter — a superseded socket's frame is never
        // relabelled with the live socket's generation.
        this.#driver.recordRawFrame(frame, provenance, endpoint);
        listener.onFrame(frame);
        this.#driver.clearCurrentRawFrame();
      },
      onClose: (info) => {
        listener.onClose(info);
      },
      onError: (error) => {
        listener.onError(error);
      },
    });
  }
}

export interface CoinbaseFeedDriverOptions {
  readonly feedId: string;
  readonly journal: GatewayJournal;
  readonly dispatcher: GatewayDispatcher;
  readonly clock: GatewayClock;
  readonly snapshotFailureEscalationThreshold: number;
  readonly reconnectLoopEscalationThreshold: number;
}

export interface CoinbaseFeedDriverMetrics {
  readonly framesRecorded: number;
  readonly framesRefusedByWal: number;
  readonly binaryFramesUnrecorded: number;
  /**
   * Frames recorded before the manager adopted their socket, so no
   * `subscriptionGeneration` had been established and `0` is a placeholder.
   */
  readonly framesWithoutEstablishedProvenance: number;
  readonly eventsDispatched: number;
  readonly eventsSuppressedUnrecorded: number;
  readonly anomaliesRouted: number;
  readonly snapshotEscalations: number;
  readonly reconnectLoopEscalations: number;
}

export class CoinbaseFeedDriver {
  readonly #options: CoinbaseFeedDriverOptions;
  #manager: CoinbaseConnectionManager | undefined;
  #currentRaw: CurrentRawFrame | undefined;
  readonly #snapshotFailuresByChannel = new Map<string, number>();

  #framesRecorded = 0;
  #framesRefusedByWal = 0;
  #binaryFramesUnrecorded = 0;
  #framesWithoutEstablishedProvenance = 0;
  #eventsDispatched = 0;
  #eventsSuppressed = 0;
  #anomaliesRouted = 0;
  #snapshotEscalations = 0;
  #reconnectLoopEscalations = 0;

  constructor(options: CoinbaseFeedDriverOptions) {
    this.#options = options;
  }

  get feedId(): string {
    return this.#options.feedId;
  }

  /** Binds the driver to its manager (constructed after the driver). */
  bind(manager: CoinbaseConnectionManager): void {
    this.#manager = manager;
  }

  /** Wraps the real socket factory for the manager's constructor. */
  wrapSocketFactory(inner: CoinbaseSocketFactory): CoinbaseSocketFactory {
    return new RecordingCoinbaseSocketFactory(inner, this);
  }

  /** `counters.connectionsOpened`, read by the factory across a forwarded open. */
  managerConnectionsOpened(): number {
    return this.#manager?.metrics().counters.connectionsOpened ?? -1;
  }

  /** The manager's own current connection identity and generation. */
  managerProvenance():
    | {
        readonly connectionId: string;
        readonly subscriptionGeneration: number;
        readonly connectionsOpened: number;
      }
    | undefined {
    const metrics = this.#manager?.metrics();
    if (metrics === undefined) return undefined;
    return {
      connectionId: metrics.connectionId,
      subscriptionGeneration: metrics.subscriptionGeneration,
      connectionsOpened: metrics.counters.connectionsOpened,
    };
  }

  /** Called by the recording factory, inside the frame callback, WAL-first. */
  recordRawFrame(
    frame: CoinbaseRawFrame,
    provenance: CoinbaseSocketProvenance,
    endpoint: string,
  ): void {
    if (typeof frame !== "string") {
      // `payloadUtf8` cannot hold binary (ADR-004 §1); decoding on a guess
      // would store an interpretation, not evidence. Counted here; the
      // adapter's own COINBASE_FRAME_NOT_TEXT anomaly (PAGE) reports it.
      this.#binaryFramesUnrecorded += 1;
      this.#currentRaw = undefined;
      return;
    }
    if (!provenance.established) {
      // No generation exists for this socket yet: `0` below is a placeholder,
      // not a claim about generation zero. Counted so it is never mistaken.
      this.#framesWithoutEstablishedProvenance += 1;
    }
    const receipt = takeReceipt(this.#options.clock);
    const outcome = this.#options.journal.record({
      source: "coinbase",
      endpoint,
      connectionId: provenance.connectionId,
      subscriptionGeneration: provenance.subscriptionGeneration,
      receipt,
      payloadUtf8: frame,
    });
    if (outcome.recorded) {
      this.#framesRecorded += 1;
      this.#currentRaw = { ingestSeq: outcome.ingestSeq, recorded: true };
      return;
    }
    this.#framesRefusedByWal += 1;
    this.#currentRaw = { ingestSeq: outcome.ingestSeq, recorded: false };
    this.#options.dispatcher.openIncident({
      scope: this.#options.feedId,
      reasonCode: "GATEWAY_WAL_FRAME_REFUSED",
      severity: "PAGE",
      detail: `the WAL refused a raw Coinbase frame (${outcome.reason}): ${outcome.detail}; derived reference data will not be published`,
      feedId: this.#options.feedId,
    });
  }

  /** Called by the recording factory once the frame's processing returned. */
  clearCurrentRawFrame(): void {
    this.#currentRaw = undefined;
  }

  /** The manager's `onOutput` sink. */
  onOutput(output: CoinbaseFeedOutput): void {
    const receipt = takeReceipt(this.#options.clock);
    const raw = this.#currentRaw;
    const suppress = raw !== undefined && !raw.recorded;

    for (const event of output.normalized) {
      if (suppress) {
        this.#eventsSuppressed += 1;
        continue;
      }
      this.#eventsDispatched += 1;
      void this.#options.dispatcher.dispatch(
        {
          eventType: event.eventType,
          schemaVersion: event.schemaVersion,
          source: event.envelope.source,
          sourceChannel: event.envelope.sourceChannel,
          venueTimestamp: event.envelope.venueTimestamp,
          connectionId: event.envelope.connectionId,
          subscriptionGeneration: event.envelope.subscriptionGeneration,
          payload: event.payload,
        },
        {
          receipt: {
            receivedAt: event.envelope.receivedAt,
            receivedMonotonicNs: event.envelope.receivedMonotonicNs,
            nowMs: receipt.nowMs,
          },
          ...(raw !== undefined && raw.recorded ? { rawFrameIngestSeq: raw.ingestSeq } : {}),
        },
      );
    }

    for (const event of output.feedEvents) {
      // Feed-health events flow even while raw recording is refused: the
      // outage must be visible in the stream.
      this.#eventsDispatched += 1;
      void this.#options.dispatcher.dispatch(
        {
          eventType: event.eventType,
          // Feed-status events carry no version on the adapter type; every
          // Feed* contract is at INITIAL_SCHEMA_VERSION (1) in the frozen
          // domain, and envelope validation pins it.
          schemaVersion: 1,
          source: event.envelope.source,
          sourceChannel: event.envelope.sourceChannel,
          venueTimestamp: event.envelope.venueTimestamp,
          connectionId: event.envelope.connectionId,
          subscriptionGeneration: event.envelope.subscriptionGeneration,
          payload: event.payload,
        },
        {
          receipt: {
            receivedAt: event.envelope.receivedAt,
            receivedMonotonicNs: event.envelope.receivedMonotonicNs,
            nowMs: receipt.nowMs,
          },
        },
      );
      if (event.eventType === "FeedResynchronized") {
        // A snapshot applied on every channel: the escalation counters reset.
        this.#snapshotFailuresByChannel.clear();
        this.#options.dispatcher.markIncidentClosed(
          this.#options.feedId,
          "COINBASE_SNAPSHOT_ESCALATION",
        );
        this.#options.dispatcher.markIncidentClosed(
          this.#options.feedId,
          "COINBASE_RECONNECT_LOOP",
        );
      }
    }

    for (const anomaly of output.anomalies) {
      this.#routeAnomaly(anomaly);
    }
  }

  /** Driven by the gateway tick: reconnect-loop surveillance. */
  tick(): void {
    const manager = this.#manager;
    if (manager === undefined) return;
    if (manager.consecutiveFailures >= this.#options.reconnectLoopEscalationThreshold) {
      this.#reconnectLoopEscalations += 1;
      this.#options.dispatcher.openIncident({
        scope: this.#options.feedId,
        reasonCode: "COINBASE_RECONNECT_LOOP",
        severity: "PAGE",
        detail: `${String(manager.consecutiveFailures)} consecutive failed connection attempts; the feed is looping without recovering`,
        feedId: this.#options.feedId,
      });
    }
  }

  #routeAnomaly(anomaly: CoinbaseAnomaly): void {
    this.#anomaliesRouted += 1;

    if (anomaly.code === "COINBASE_SNAPSHOT_NOT_APPLIED") {
      const channel = anomaly.channel ?? "(unknown)";
      const failures = (this.#snapshotFailuresByChannel.get(channel) ?? 0) + 1;
      this.#snapshotFailuresByChannel.set(channel, failures);
      if (failures >= this.#options.snapshotFailureEscalationThreshold) {
        this.#snapshotEscalations += 1;
        this.#options.dispatcher.openIncident({
          scope: this.#options.feedId,
          reasonCode: "COINBASE_SNAPSHOT_ESCALATION",
          severity: "PAGE",
          detail: `channel ${channel}: ${String(failures)} consecutive snapshots failed to apply; the gap cannot close and the feed is reconnect-looping`,
          feedId: this.#options.feedId,
        });
      }
    }

    // WP-090 obligation: EVERY anomaly code routes to an incident, with the
    // adapter's own severity and provenance. The dispatcher is the single
    // funnel — it dedups per (feed, code) and notifies the observer, which is
    // the delivery that survives a transport outage.
    this.#options.dispatcher.openIncident(
      {
        scope: this.#options.feedId,
        reasonCode: anomaly.code,
        severity: anomaly.severity,
        detail: anomaly.detail,
        feedId: this.#options.feedId,
      },
      (incidentId) => ({
        eventType: "DataQualityIncidentOpened",
        schemaVersion: 1,
        source: "coinbase",
        sourceChannel:
          anomaly.channel === undefined || anomaly.channel === ""
            ? COINBASE_CONNECTION_CHANNEL
            : anomaly.channel,
        connectionId: anomaly.connectionId === "" ? undefined : anomaly.connectionId,
        subscriptionGeneration: anomaly.subscriptionGeneration,
        payload: {
          incidentId,
          openedAt: anomaly.receivedAt,
          reasonCode: anomaly.code,
          severity: anomaly.severity,
          detail: anomaly.detail.slice(0, 2000),
          feedId: this.#options.feedId,
        },
      }),
    );
  }

  metrics(): CoinbaseFeedDriverMetrics {
    return {
      framesRecorded: this.#framesRecorded,
      framesRefusedByWal: this.#framesRefusedByWal,
      binaryFramesUnrecorded: this.#binaryFramesUnrecorded,
      framesWithoutEstablishedProvenance: this.#framesWithoutEstablishedProvenance,
      eventsDispatched: this.#eventsDispatched,
      eventsSuppressedUnrecorded: this.#eventsSuppressed,
      anomaliesRouted: this.#anomaliesRouted,
      snapshotEscalations: this.#snapshotEscalations,
      reconnectLoopEscalations: this.#reconnectLoopEscalations,
    };
  }
}
