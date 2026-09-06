/**
 * Where a trader health report comes from — the seam, and the honest statement
 * of what is and is not wired.
 *
 * ## THE COMPOSITION OBLIGATION, STATED BEFORE ANYTHING ELSE
 *
 * **`apps/trader` does not expose an HTTP health endpoint today.** Its health
 * state is an in-process value (`apps/trader/src/health.ts`, whose own header
 * says "What this module is NOT: a dashboard, an HTTP endpoint or a Prometheus
 * exporter"), and `apps/trader/**` is outside `WP-240`'s grant, so this package
 * could not add one and did not.
 *
 * What ships here is the CONSUMER half:
 *
 * - {@link InMemoryTraderHealthSource} — a source over a document a composition
 *   already holds. Used by the suites, and usable by any process that can hand
 *   one over;
 * - {@link HttpTraderHealthSource} — a loopback `GET` returning a JSON health
 *   document. **This is genuinely executed**, against a real in-process
 *   `node:http` server in `health-source.test.ts`: the request, the size bound,
 *   the timeout, the non-200 path and the malformed-body path are all exercised.
 *   No claim is made that a trader is on the other end of it.
 *
 * Wiring the second to a running trader requires the trader to serve that
 * document. That is a documented obligation on a future `apps/trader` grant.
 * `control_trader_health_available` reads `0` until it is discharged, and the
 * operations dashboard puts that stat above every `trader_*` panel so an
 * operator cannot read blank charts as a quiet market.
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

/** The seam. TOTAL: an implementation reports failure as data, never by throwing. */
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
 */
export class TraderHealthCache {
  readonly #source: TraderHealthSource;
  #last: TraderHealthReportInput | undefined;
  readonly #reads = new Map<HealthReadOutcome, number>();

  constructor(source: TraderHealthSource) {
    this.#source = source;
  }

  async refresh(): Promise<HealthReadResult> {
    const result = await this.#source.read();
    this.#reads.set(result.outcome, (this.#reads.get(result.outcome) ?? 0) + 1);
    if (result.outcome === "OK") this.#last = result.report;
    return result;
  }

  /** The last report that passed the door, if any. */
  last(): TraderHealthReportInput | undefined {
    return this.#last;
  }

  get available(): boolean {
    return this.#last !== undefined;
  }

  /** Reads by outcome, sorted, for the metrics surface. */
  readCounts(): Readonly<Record<string, number>> {
    const out: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const key of [...this.#reads.keys()].sort()) out[key] = this.#reads.get(key) ?? 0;
    return Object.freeze(out);
  }
}
