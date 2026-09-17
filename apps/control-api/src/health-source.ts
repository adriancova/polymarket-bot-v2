/**
 * Where a trader health report comes from — the seam, and the honest statement
 * of what is and is not wired.
 *
 * ## THE COMPOSITION, STATED BEFORE ANYTHING ELSE
 *
 * This header used to open "**`apps/trader` does not expose an HTTP health
 * endpoint today**" and called wiring one "a documented obligation on a future
 * `apps/trader` grant". `TRDR-3` discharged both halves of that obligation:
 * `apps/trader/src/health-server.ts` serves `GET /health` on the loopback when
 * `TRADER_HEALTH_BIND`/`TRADER_HEALTH_PORT` are set, and this process READS it
 * — `TraderHealthCache.refresh()` was never called by the shipped process
 * before that round (`WP-240` r1 M-2; reproduced by
 * `test/integration/control-api/health-refresh-wiring.test.ts`: zero requests
 * over 1.5 s of serving). It is now called by `ControlApi` on every authorized
 * `GET /v1/health` and `GET /v1/metrics` when `main.ts` enables it for an
 * `http` source (`api.ts`, "Refresh-on-read"). A `none` source is never read.
 *
 * What ships here is the CONSUMER half:
 *
 * - {@link InMemoryTraderHealthSource} — a source over a document a composition
 *   already holds. Used by the suites, and usable by any process that can hand
 *   one over;
 * - {@link HttpTraderHealthSource} — a loopback `GET` returning a JSON health
 *   document. Executed against a real in-process `node:http` server in
 *   `health-source.test.ts` (the request, the size bound, the timeout, the
 *   non-200 path and the malformed-body path) and, since `TRDR-3`, against the
 *   trader's REAL health server in
 *   `test/integration/control-api/trader-health-http-source.test.ts`.
 *
 * `control_trader_health_available` reads `0` until a report has passed the
 * door; the operations dashboard puts that stat above every `trader_*` panel
 * so an operator cannot read blank charts as a quiet market.
 *
 * ## Every read is bounded
 *
 * A health source is an input, and an input with no bound is a denial of
 * service with extra steps. The HTTP source bounds the response body, aborts on
 * a timeout, and refuses a non-200 or a non-JSON body — each as DATA, so a
 * control API whose trader is unreachable keeps serving its own controls. §4.2:
 * "A control-API outage must not stop an already healthy trader"; the converse
 * holds here.
 */

import { get as httpGet } from "node:http";

import type { TraderHealthReportInput } from "@polymarket-bot/observability";

import { readTraderHealthReport } from "./health-door.js";

export type HealthReadOutcome =
  /** A document arrived and passed the door. */
  | "OK"
  /** A document arrived and the door refused it. */
  | "REFUSED"
  /** No document arrived: no source, an unreachable one, or a timeout. */
  | "UNAVAILABLE";

export type HealthReadResult =
  | { readonly outcome: "OK"; readonly report: TraderHealthReportInput }
  | { readonly outcome: "REFUSED"; readonly detail: string; readonly issues: readonly string[] }
  | { readonly outcome: "UNAVAILABLE"; readonly detail: string };

/**
 * The seam. TOTAL: an implementation reports failure as data, never by throwing.
 *
 * AN `OK` REPORT MUST BE THE DOOR'S OUTPUT (`SER-3` review round 1, the M2
 * sweep). `TraderHealthCache` retains the report and `ControlApi.#health()`
 * embeds it in a response body that is serialized from OWN DATA since `SER-3`,
 * which refuses a container whose prototype is neither the plain one nor
 * `null`. Every implementation here obtains its report from {@link parse} —
 * i.e. from `readTraderHealthReport`, whose `readPlainData` materialization
 * builds a FRESH plain tree — so no container the source document supplied
 * reaches a response body: a null-prototype one is materialized into an
 * ordinary container, and a foreign-prototype one (an `Array` subclass, a
 * class instance) is refused AT THE DOOR, counted as a `REFUSED` read with the
 * last good report retained. That refusal is pre-existing; `doors.ts` is
 * untouched by `SER-3`. A FOREIGN implementation that skipped the door and answered with
 * such a container would make the response encoder refuse a body
 * `JSON.stringify` would have written; the cache does not re-materialize,
 * because re-running a door over a value the source already vouched for would
 * turn that source's `OK` into this cache's `REFUSED` and change what the read
 * counters mean. `test/unit/control-api/response-encoder-bound.test.ts` pins
 * the documented route.
 */
export interface TraderHealthSource {
  read(): Promise<HealthReadResult>;
}

/**
 * The explicit "nothing is reporting" source.
 *
 * A configuration says `{"kind":"none"}` to select it, so a deployment states
 * the absence rather than omitting a field and discovering it later.
 */
export class AbsentTraderHealthSource implements TraderHealthSource {
  read(): Promise<HealthReadResult> {
    return Promise.resolve({
      outcome: "UNAVAILABLE",
      detail:
        "no trader health source is configured (traderHealth.kind = none); the trader_* panels " +
        "have no producer and control_trader_health_available reads 0",
    });
  }
}

/** A source over a document held in memory. Still goes through the door. */
export class InMemoryTraderHealthSource implements TraderHealthSource {
  #document: unknown;

  constructor(document?: unknown) {
    this.#document = document;
  }

  /** Replaces the held document. The next read parses the new one. */
  set(document: unknown): void {
    this.#document = document;
  }

  /** Removes the held document, so the next read is UNAVAILABLE. */
  clear(): void {
    this.#document = undefined;
  }

  read(): Promise<HealthReadResult> {
    if (this.#document === undefined) {
      return Promise.resolve({
        outcome: "UNAVAILABLE",
        detail: "no health document has been supplied to this source",
      });
    }
    return Promise.resolve(parse(this.#document));
  }
}

export interface HttpTraderHealthSourceOptions {
  readonly url: string;
  readonly timeoutMs: number;
  /** Response body bound. A health document is small; a stream is not one. */
  readonly maxBodyBytes: number;
}

/** A loopback `GET` of a JSON health document. */
export class HttpTraderHealthSource implements TraderHealthSource {
  readonly #options: HttpTraderHealthSourceOptions;

  constructor(options: HttpTraderHealthSourceOptions) {
    this.#options = options;
  }

  read(): Promise<HealthReadResult> {
    return new Promise<HealthReadResult>((resolve) => {
      let settled = false;
      const settle = (result: HealthReadResult): void => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const request = httpGet(this.#options.url, { timeout: this.#options.timeoutMs }, (response) => {
        const status = response.statusCode ?? 0;
        if (status !== 200) {
          response.resume();
          settle({
            outcome: "UNAVAILABLE",
            detail: `the health source answered HTTP ${String(status)}; only 200 is a report`,
          });
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > this.#options.maxBodyBytes) {
            response.destroy();
            settle({
              outcome: "UNAVAILABLE",
              detail:
                `the health source sent more than ${String(this.#options.maxBodyBytes)} bytes; a ` +
                "health document is bounded and an unbounded response is refused rather than read",
            });
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          let document: unknown;
          try {
            document = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch (cause) {
            settle({
              outcome: "REFUSED",
              detail: "the health source's body is not JSON",
              issues: [cause instanceof Error ? cause.message : String(cause)],
            });
            return;
          }
          settle(parse(document));
        });
        response.on("error", (cause) => {
          settle({ outcome: "UNAVAILABLE", detail: `reading the health response failed: ${cause.message}` });
        });
      });

      request.on("timeout", () => {
        request.destroy();
        settle({
          outcome: "UNAVAILABLE",
          detail: `the health source did not answer within ${String(this.#options.timeoutMs)}ms`,
        });
      });
      request.on("error", (cause) => {
        settle({ outcome: "UNAVAILABLE", detail: `the health source is unreachable: ${cause.message}` });
      });
    });
  }
}

function parse(document: unknown): HealthReadResult {
  const read = readTraderHealthReport(document);
  return read.ok
    ? { outcome: "OK", report: read.value }
    : {
        outcome: "REFUSED",
        detail: read.refusal.detail,
        issues: read.refusal.issues,
      };
}

/**
 * Holds the last report that passed the door, and counts every read by outcome.
 *
 * The LAST GOOD report is retained across a failed read, and the failure is
 * counted — so an operator sees "the last report I have is from 00:04:11 and
 * the last three reads failed" rather than an empty dashboard that looks like
 * a stopped market. `asOf` on the retained report is what says how old it is.
 *
 * Two booleans, deliberately (`TRDR-3`): {@link available} is "this cache
 * HOLDS a report that passed the door" and stays `true` across a failed read
 * — the retention semantics above, pinned by `health-source.test.ts` and
 * unchanged. {@link current} is "the MOST RECENT read passed the door" and
 * drops to `false` the moment the source goes away, so the operations gauge
 * (`control_trader_health_available`) keeps its meaning and a second gauge
 * (`control_trader_health_current`) says whether the retained report is the
 * trader's latest answer. Changing `available` to mean the second would have
 * broken the first's documented promise.
 */
export class TraderHealthCache {
  readonly #source: TraderHealthSource;
  #last: TraderHealthReportInput | undefined;
  #current = false;
  readonly #reads = new Map<HealthReadOutcome, number>();

  constructor(source: TraderHealthSource) {
    this.#source = source;
  }

  async refresh(): Promise<HealthReadResult> {
    const result = await this.#source.read();
    this.#reads.set(result.outcome, (this.#reads.get(result.outcome) ?? 0) + 1);
    this.#current = result.outcome === "OK";
    if (result.outcome === "OK") this.#last = result.report;
    return result;
  }

  /** The last report that passed the door, if any. */
  last(): TraderHealthReportInput | undefined {
    return this.#last;
  }

  /** A report that passed the door is held — possibly retained from an earlier read. */
  get available(): boolean {
    return this.#last !== undefined;
  }

  /** The most recent `refresh()` produced the held report; `false` before the first read and after a failed one. */
  get current(): boolean {
    return this.#current;
  }

  /** Reads by outcome, sorted, for the metrics surface. */
  readCounts(): Readonly<Record<string, number>> {
    const out: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const key of [...this.#reads.keys()].sort()) out[key] = this.#reads.get(key) ?? 0;
    return Object.freeze(out);
  }
}
