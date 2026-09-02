/**
 * The gateway epoch and the per-epoch ingest sequence (§7.1, ADR-002 §2).
 *
 * `gatewayEpoch + ingestSeq` defines the exact order consumed during one
 * gateway epoch. This module is the ONLY place either is assigned:
 *
 * - the epoch is a UUID minted once, at gateway startup, from the injected id
 *   source — one process, one epoch (ADR-002 §2.1; two processes sharing an
 *   epoch is what no transport can order);
 * - `ingestSeq` is a strictly increasing `bigint` starting at 1, serialized as
 *   a canonical unsigned integer string. It is a `bigint` because ADR-001 §7 /
 *   ADR-002 §1 forbid holding it in a JavaScript `number`.
 *
 * EVERYTHING the gateway stamps draws from ONE counter: raw frames and
 * normalized envelopes share the total order, so a normalized event's
 * `causationId` can name the raw frame's own `(gatewayEpoch, ingestSeq)`
 * identity and §6 invariant 4's chain ends at a WAL record that provably
 * precedes it.
 *
 * DEDUPLICATION IDENTITY. `(gatewayEpoch, ingestSeq)` is the ordering AND
 * deduplication identity (WP-050 `known_risks` 3, WP-060 `known_risks` 3):
 * a sequence value, once assigned to a fact, is never reassigned, and a
 * replayed fact keeps the identity it was first assigned. `assigned()` exposes
 * the high-water mark so guards downstream (the publish-once guard, the WAL
 * re-enqueue path) can prove they never invent a second identity for one fact.
 */

import { GatewayStateError } from "./errors.js";

export class IngestSequencer {
  readonly #gatewayEpoch: string;
  #next = 1n;

  constructor(gatewayEpoch: string) {
    this.#gatewayEpoch = gatewayEpoch;
  }

  get gatewayEpoch(): string {
    return this.#gatewayEpoch;
  }

  /** The next `ingestSeq`, consumed. Strictly increasing, never reused. */
  next(): string {
    const value = this.#next;
    this.#next += 1n;
    return value.toString();
  }

  /** The highest sequence assigned so far, or `0n` when none has been. */
  assigned(): bigint {
    return this.#next - 1n;
  }

  /**
   * Asserts a sequence string was assigned by THIS sequencer's epoch.
   *
   * Used by paths that re-present an already-stamped fact (a WAL re-enqueue, a
   * publish retry): the identity must already exist, because assigning a fresh
   * one to an old fact would turn one fact into two.
   */
  assertAssigned(ingestSeq: string): void {
    let value: bigint;
    try {
      value = BigInt(ingestSeq);
    } catch {
      throw new GatewayStateError("ingestSeq is not an integer string", { ingestSeq });
    }
    if (value < 1n || value > this.assigned()) {
      throw new GatewayStateError(
        "ingestSeq was never assigned in this epoch; re-presenting it would mint a second identity for one fact",
        { ingestSeq, highWaterMark: this.assigned().toString() },
      );
    }
  }
}
