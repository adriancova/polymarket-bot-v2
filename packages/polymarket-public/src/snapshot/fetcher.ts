/**
 * Authoritative book snapshots over the public CLOB REST API.
 *
 * This is the capability §7.1 and §9.1 require after a gap: "a restart or
 * detected gap requires a new authoritative snapshot before affected markets
 * resume", and the gateway must "resubscribe and obtain authoritative snapshots
 * after gaps". The trigger belongs to the gateway (`WP-120`); the snapshot
 * belongs here.
 *
 * Endpoints, both public and unauthenticated (accessed 2026-08-27):
 *
 * - `GET /book?token_id=<TOKEN_ID>`
 * - `POST /books` with `[{"token_id":"…"}]`, "Maximum 500 items per request"
 *
 * ## Failure is loud, because a failed snapshot is not a recovery
 *
 * A transport failure, a non-2xx status, an unparsable body, or a body that
 * does not match the documented shape all throw. That is deliberate: a caller
 * that recovered from a gap by quietly continuing on a snapshot it never got
 * would be trading on a book it knows is incomplete. Per-book normalization
 * failures do NOT throw — they come back as problems alongside the books that
 * did normalize, so one bad market cannot block the recovery of the others.
 */

import {
  MAXIMUM_BOOKS_PER_BATCH_REQUEST,
  POLYMARKET_CLOB_REST_BASE_URL,
} from "../config.js";
import {
  PublicMarketConfigurationError,
  PublicMarketSnapshotInvalidError,
  PublicMarketSnapshotUnavailableError,
} from "../errors.js";
import { normalizeOrderBooks } from "../normalize/snapshot.js";
import type { PublicMarketNormalization } from "../normalize/result.js";
import type { PublicHttpClient, PublicMarketDirectory } from "../ports.js";
import {
  parseVenueOrderBook,
  parseVenueOrderBooks,
  type VenueOrderBook,
} from "../venue/order-book.js";

export interface BookSnapshotFetcherOptions {
  readonly http: PublicHttpClient;
  readonly directory: PublicMarketDirectory;
  /** Defaults to the public CLOB origin. Overridable for a staging host. */
  readonly baseUrl?: string;
  /**
   * Client-side batch bound.
   *
   * Defaults to the venue's own documented "Maximum 500 items per request".
   * Unlike the subscription asset cap (venue item U-3) this limit IS published,
   * so it is enforced rather than left open.
   */
  readonly maximumBooksPerRequest?: number;
}

export class PublicBookSnapshotFetcher {
  readonly #http: PublicHttpClient;
  readonly #directory: PublicMarketDirectory;
  readonly #baseUrl: string;
  readonly #batchSize: number;

  constructor(options: BookSnapshotFetcherOptions) {
    const baseUrl = (options.baseUrl ?? POLYMARKET_CLOB_REST_BASE_URL).replace(/\/+$/u, "");
    if (baseUrl === "") {
      throw new PublicMarketConfigurationError("the CLOB REST base url must not be empty");
    }
    const batchSize = options.maximumBooksPerRequest ?? MAXIMUM_BOOKS_PER_BATCH_REQUEST;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
      throw new PublicMarketConfigurationError(
        "maximumBooksPerRequest must be a positive integer",
        { maximumBooksPerRequest: batchSize },
      );
    }
    if (batchSize > MAXIMUM_BOOKS_PER_BATCH_REQUEST) {
      throw new PublicMarketConfigurationError(
        `maximumBooksPerRequest exceeds the documented venue maximum of ${String(
          MAXIMUM_BOOKS_PER_BATCH_REQUEST,
        )} items per request`,
        { maximumBooksPerRequest: batchSize },
      );
    }
    this.#http = options.http;
    this.#directory = options.directory;
    this.#baseUrl = baseUrl;
    this.#batchSize = batchSize;
  }

  /** Fetches one authoritative snapshot. */
  async fetchSnapshot(
    tokenId: string,
    context: { readonly subscriptionGeneration?: number; readonly signal?: AbortSignal } = {},
  ): Promise<PublicMarketNormalization> {
    const url = `${this.#baseUrl}/book?token_id=${encodeURIComponent(tokenId)}`;
    const body = await this.#read({
      url,
      method: "GET",
      ...(context.signal === undefined ? {} : { signal: context.signal }),
    });
    const parsed = parseVenueOrderBook(body);
    if (parsed.status === "invalid") {
      throw new PublicMarketSnapshotInvalidError(
        "the order-book response did not match the documented shape",
        { url, issues: parsed.issues },
      );
    }
    return this.#normalize([parsed.book], context.subscriptionGeneration);
  }

  /**
   * Fetches several authoritative snapshots.
   *
   * Requests are chunked at the documented batch maximum and issued
   * sequentially. Sequential rather than parallel because the venue publishes
   * per-endpoint rate limits as a configuration snapshot (`§8` of the venue
   * report) that this package does not model: firing an unbounded fan-out at a
   * recovery path is exactly how a gap turns into a throttled gap.
   */
  async fetchSnapshots(
    tokenIds: readonly string[],
    context: { readonly subscriptionGeneration?: number; readonly signal?: AbortSignal } = {},
  ): Promise<PublicMarketNormalization> {
    const unique = [...new Set(tokenIds)].filter((tokenId) => tokenId !== "");
    if (unique.length === 0) {
      return { events: [], problems: [] };
    }
    const books: VenueOrderBook[] = [];
    for (let index = 0; index < unique.length; index += this.#batchSize) {
      const chunk = unique.slice(index, index + this.#batchSize);
      const url = `${this.#baseUrl}/books`;
      const body = await this.#read({
        url,
        method: "POST",
        jsonBody: chunk.map((tokenId) => ({ token_id: tokenId })),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const parsed = parseVenueOrderBooks(body);
      if (parsed.status === "invalid") {
        throw new PublicMarketSnapshotInvalidError(
          "the batch order-book response did not match the documented shape",
          { url, requested: chunk.length, issues: parsed.issues },
        );
      }
      books.push(...parsed.books);
    }
    return this.#normalize(books, context.subscriptionGeneration);
  }

  #normalize(
    books: readonly VenueOrderBook[],
    subscriptionGeneration: number | undefined,
  ): PublicMarketNormalization {
    return normalizeOrderBooks(books, {
      directory: this.#directory,
      ...(subscriptionGeneration === undefined ? {} : { subscriptionGeneration }),
    });
  }

  async #read(request: Parameters<PublicHttpClient>[0]): Promise<unknown> {
    let response;
    try {
      response = await this.#http(request);
    } catch (error) {
      throw new PublicMarketSnapshotUnavailableError(
        "the order-book request failed at the transport level",
        { url: request.url, method: request.method },
        error,
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw new PublicMarketSnapshotUnavailableError(
        `the order-book request returned HTTP ${String(response.status)}`,
        { url: request.url, method: request.method, status: response.status },
      );
    }
    try {
      return JSON.parse(response.body);
    } catch (error) {
      throw new PublicMarketSnapshotInvalidError("the order-book response was not JSON", {
        url: request.url,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
