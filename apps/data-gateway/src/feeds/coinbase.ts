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
 * normalization and publication. Each wrapped listener closes over ITS
 * connection's identity, so a frame from a superseded socket is recorded
 * under the id of the socket that produced it — never relabeled (the defect
 * class all three 1B adapters guard against is not reintroduced here).
 *
 * The wrapper derives the same `<feedId>-c<ordinal>` identity the manager
 * mints, by counting `connect()` calls in lockstep (the manager calls the
 * factory exactly once per attempt, and mints exactly one id per attempt).
 * The integration suite pins that correspondence: the connectionId on a
 * normalized event equals the connectionId on its recorded raw frame.
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
    // In lockstep with the manager: one `connect()` per attempt, one id per
    // attempt, same shape (`<feedId>-c<ordinal>`). Pinned by a test.
    this.#connectOrdinal += 1;
    const connectionId = `${this.#driver.feedId}-c${String(this.#connectOrdinal)}`;
    return this.#inner.connect(endpoint, {
      onOpen: () => {
        listener.onOpen();
      },
      onFrame: (frame: CoinbaseRawFrame) => {
        // WAL first; the identity is THIS socket's, captured by closure.
        this.#driver.recordRawFrame(frame, connectionId, endpoint);
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

  /** Called by the recording factory, inside the frame callback, WAL-first. */
  recordRawFrame(frame: CoinbaseRawFrame, connectionId: string, endpoint: string): void {
    if (typeof frame !== "string") {
      // `payloadUtf8` cannot hold binary (ADR-004 §1); decoding on a guess
      // would store an interpretation, not evidence. Counted here; the
      // adapter's own COINBASE_FRAME_NOT_TEXT anomaly (PAGE) reports it.
      this.#binaryFramesUnrecorded += 1;
      this.#currentRaw = undefined;
      return;
    }
    const receipt = takeReceipt(this.#options.clock);
    const outcome = this.#options.journal.record({
      source: "coinbase",
      endpoint,
      connectionId,
      subscriptionGeneration: this.#manager?.metrics().subscriptionGeneration ?? 0,
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
      eventsDispatched: this.#eventsDispatched,
      eventsSuppressedUnrecorded: this.#eventsSuppressed,
      anomaliesRouted: this.#anomaliesRouted,
      snapshotEscalations: this.#snapshotEscalations,
      reconnectLoopEscalations: this.#reconnectLoopEscalations,
    };
  }
}
