/**
 * The simulated venue's bounded, counted retention (SIM-2, LOOPMEM-SIM part 2).
 *
 * `SimulatedVenue` used to keep every order, every fill and every Tier-1 band it
 * ever produced — and, under Tier 0, every observed public trade — for the life
 * of the process, and the trader loop re-read and re-sorted that whole history
 * several times per event. SIM-2 separates LIVE state (what the venue still
 * works: resting, partly filled and DELAYED orders, their resting records and
 * bands) from HISTORY (terminal orders, produced fills, the bands of terminal
 * orders). Live state is bounded by the orders that can still change; history
 * lives in the three structures below, each with a HARD bound, oldest-first
 * eviction, and a counter for every entry it forgets.
 *
 * ## No silent drop
 *
 * The `TRDR-4` / `FillDeduplicator` precedent: "a run that evicts is a run
 * whose bound is too small, and `evicted > 0` says so". Every eviction here is
 * counted and published by `SimulatedVenue.retention()`. Two consumers turn a
 * count into a refusal, because for them a shorter history would be a WRONG
 * answer rather than a shorter one:
 *
 * - `runReplay` REFUSES to serialize a run whose venue evicted any order, fill
 *   or band (`SIMULATED_VENUE_HISTORY_EVICTED`): the §12.4 bytes of a
 *   truncated history would report a short run as a complete one;
 * - `SimulatedVenue.fillsSince` REFUSES a cursor older than the oldest
 *   retained fill: the fills in between are gone, and answering from the
 *   oldest one it still has would skip them (§6 invariant 7).
 *
 * A TERMINAL order does not enter its log the moment it ends (SIM-2 r1,
 * `SIM2-R1-1`): the venue HOLDS it — never evicted — until its consumer
 * acknowledges that it is done with it, and only then offers it to the
 * bounded {@link RetainedMap}. So a bound limits what the venue keeps AFTER
 * its consumer is finished, never what the consumer has yet to read.
 *
 * The duplicate guard's memory (§6 invariant 6) is the one structure whose
 * forgetting would not be a shorter answer but a WRONG one — a reused order
 * id executed twice. So it does not forget: after the exact
 * {@link TombstoneSet} it keeps a bounded {@link EvictedIdFilter}, which can
 * say "possibly seen" of an id it never saw but never "never seen" of an id it
 * did; the venue refuses every id it cannot prove new (SIM-2 r1,
 * `SIM2-R1-2`).
 *
 * Deterministic and clock-free: each structure's contents depend only on the
 * sequence of values offered to it.
 */

/** `retained / maximumRetained / evicted` — one bounded log's counters. */
export interface RetentionCounters {
  /** Entries currently held. */
  readonly retained: number;
  /** The bound. */
  readonly maximumRetained: number;
  /** Entries forgotten, oldest first, because the bound was reached. Never silent. */
  readonly evicted: number;
}

/** A bound must be a positive safe integer; anything else is refused at construction. */
export function requireRetentionBound(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(
      `${what} needs a positive safe-integer bound (received ${String(value)}): an unbounded history is the ` +
        "leak SIM-2 closes, and a bound of zero keeps nothing the venue's own lookups rely on",
    );
  }
  return value;
}

/**
 * An append-only log over an ABSOLUTE sequence, bounded, oldest-first eviction.
 *
 * Every appended value gets the next sequence number (0, 1, 2 …) for the life
 * of the log, whether or not it is still retained, so a reader's cursor keeps
 * its meaning across evictions: {@link since} answers exactly the values at or
 * after a sequence, or says the sequence is older than anything retained.
 *
 * A ring buffer, so an append at the bound is O(1) whatever the bound is.
 */
export class SequencedLog<T> {
  readonly maximumRetained: number;
  readonly #slots: T[] = [];
  /** Index of the OLDEST retained value once the ring is full. */
  #head = 0;
  /** The sequence the NEXT appended value will get (= values ever appended). */
  #next = 0;
  #evicted = 0;

  constructor(maximumRetained: number, what: string) {
    this.maximumRetained = requireRetentionBound(maximumRetained, what);
  }

  append(value: T): void {
    this.#next += 1;
    if (this.#slots.length < this.maximumRetained) {
      this.#slots.push(value);
      return;
    }
    this.#slots[this.#head] = value;
    this.#head = (this.#head + 1) % this.maximumRetained;
    this.#evicted += 1;
  }

  /** The sequence the next appended value will get. */
  get nextSequence(): number {
    return this.#next;
  }

  /** The sequence of the oldest retained value (= `nextSequence` when empty). */
  get firstRetainedSequence(): number {
    return this.#next - this.#slots.length;
  }

  /**
   * The retained values at or after `sequence`, oldest first, as a fresh array.
   *
   * O(values answered), never O(values retained): a reader that polls once per
   * event with a cursor near the end pays for what is new, not for the window.
   * The caller has checked `firstRetainedSequence <= sequence <= nextSequence`;
   * this is the arithmetic, not the door.
   */
  since(sequence: number): T[] {
    const size = this.#slots.length;
    const wanted = Math.min(size, Math.max(0, this.#next - sequence));
    const answered: T[] = [];
    // Logical position `size - wanted` is the value with sequence `sequence`;
    // physically the ring starts at `#head` (0 until the ring first fills).
    for (let logical = size - wanted; logical < size; logical += 1) {
      const value = this.#slots[(this.#head + logical) % size];
      /* c8 ignore next -- every logical position below `size` holds a value. */
      if (value === undefined) continue;
      answered.push(value);
    }
    return answered;
  }

  /** The retained window, oldest first, as a fresh array. */
  entries(): T[] {
    if (this.#head === 0) return this.#slots.slice();
    return [...this.#slots.slice(this.#head), ...this.#slots.slice(0, this.#head)];
  }

  counters(): RetentionCounters {
    return { retained: this.#slots.length, maximumRetained: this.maximumRetained, evicted: this.#evicted };
  }
}

/**
 * A keyed history, bounded, evicting the OLDEST INSERTED key first.
 *
 * `Map` keeps insertion order, so the oldest key is the first one. Re-setting a
 * key that is already held updates its value in place and does not refresh its
 * position (the venue never re-sets one: a terminal order is final). An
 * eviction answers the evicted key, so the caller can remember it elsewhere
 * (the duplicate guard's tombstones).
 */
export class RetainedMap<T> {
  readonly maximumRetained: number;
  readonly #entries = new Map<string, T>();
  #evicted = 0;

  constructor(maximumRetained: number, what: string) {
    this.maximumRetained = requireRetentionBound(maximumRetained, what);
  }

  /** Holds `value` under `key`; answers the key evicted to make room, if any. */
  set(key: string, value: T): string | undefined {
    if (this.#entries.has(key)) {
      this.#entries.set(key, value);
      return undefined;
    }
    let evictedKey: string | undefined;
    if (this.#entries.size >= this.maximumRetained) {
      const oldest = this.#entries.keys().next();
      if (oldest.done !== true) {
        evictedKey = oldest.value;
        this.#entries.delete(oldest.value);
        this.#evicted += 1;
      }
    }
    this.#entries.set(key, value);
    return evictedKey;
  }

  get(key: string): T | undefined {
    return this.#entries.get(key);
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  values(): IterableIterator<T> {
    return this.#entries.values();
  }

  counters(): RetentionCounters {
    return { retained: this.#entries.size, maximumRetained: this.maximumRetained, evicted: this.#evicted };
  }
}

/**
 * A bounded set of ids, oldest-first eviction, counted — the duplicate guard's
 * EXACT memory of order ids whose ORDERS the retention map has already
 * forgotten. An id it evicts is answered to the caller, which folds it into
 * the {@link EvictedIdFilter} (SIM-2 r1): the guard's memory shrinks from
 * exact to probabilistic, never to nothing.
 */
export class TombstoneSet {
  readonly maximumRetained: number;
  readonly #ids = new Set<string>();
  #evicted = 0;

  constructor(maximumRetained: number, what: string) {
    this.maximumRetained = requireRetentionBound(maximumRetained, what);
  }

  /** Remembers `id`; answers the id evicted to make room, if any. */
  remember(id: string): string | undefined {
    if (this.#ids.has(id)) return undefined;
    let evictedId: string | undefined;
    if (this.#ids.size >= this.maximumRetained) {
      const oldest = this.#ids.values().next();
      if (oldest.done !== true) {
        evictedId = oldest.value;
        this.#ids.delete(oldest.value);
        this.#evicted += 1;
      }
    }
    this.#ids.add(id);
    return evictedId;
  }

  has(id: string): boolean {
    return this.#ids.has(id);
  }

  counters(): RetentionCounters {
    return { retained: this.#ids.size, maximumRetained: this.maximumRetained, evicted: this.#evicted };
  }
}

/** The evicted-id filter's counters (SIM-2 r1). */
export interface EvictedIdFilterCounters {
  /** The filter's size in bits — its hard bound. */
  readonly bits: number;
  /** Hash positions set per id. */
  readonly hashes: number;
  /** Bits currently set: the filter's fill, from which its false-positive rate follows. */
  readonly bitsSet: number;
  /** Ids folded in (every id whose tombstone was evicted). */
  readonly folded: number;
}

/** The largest filter a composition root may ask for: 2^31 bits (256 MiB). */
export const MAXIMUM_EVICTED_ID_FILTER_BITS = 2 ** 31;

/** Hash positions per id: the optimum for a filter sized well above its expected fill. */
const EVICTED_ID_FILTER_HASHES = 7;

/**
 * A BOUNDED, deterministic memory of order ids the exact memory has forgotten
 * — a Bloom filter (SIM-2 r1, `SIM2-R1-2`).
 *
 * What it guarantees, and what it does not:
 * - it NEVER forgets an id folded into it: `mightContain` answers `true` for
 *   every such id for the life of the filter (no false negatives), so a reused
 *   order id is always caught, however many orders ended since;
 * - it may answer `true` for an id it never saw (a FALSE POSITIVE), with a
 *   probability that grows with its fill: about
 *   `(1 - e^(-7n/m))^7` after `n` ids in `m` bits — 1% at `n ≈ 0.1 m`. The
 *   venue refuses such an id loudly as not provably unique, and counts it; it
 *   never guesses that an id is new;
 * - its size is fixed at construction, so its memory is bounded whatever runs.
 *
 * Positions come from two 32-bit FNV-1a hashes of the id's UTF-16 code units
 * (Kirsch–Mitzenmacher double hashing): pure arithmetic, no `node:crypto`, the
 * same answer on every run.
 */
export class EvictedIdFilter {
  readonly bits: number;
  readonly hashes = EVICTED_ID_FILTER_HASHES;
  readonly #words: Uint8Array;
  #bitsSet = 0;
  #folded = 0;

  constructor(bits: number, what: string) {
    const bound = requireRetentionBound(bits, what);
    if (bound > MAXIMUM_EVICTED_ID_FILTER_BITS) {
      throw new RangeError(
        `${what} is at most ${String(MAXIMUM_EVICTED_ID_FILTER_BITS)} bits (received ${String(bits)})`,
      );
    }
    this.bits = bound;
    this.#words = new Uint8Array(Math.ceil(bound / 8));
  }

  /** Folds `id` in. */
  add(id: string): void {
    this.#folded += 1;
    const [first, step] = idHashes(id);
    for (let index = 0; index < this.hashes; index += 1) {
      const position = (first + index * step) % this.bits;
      const byte = position >>> 3;
      const mask = 1 << (position & 7);
      const current = this.#words[byte] ?? 0;
      if ((current & mask) === 0) {
        this.#words[byte] = current | mask;
        this.#bitsSet += 1;
      }
    }
  }

  /** `false`: `id` was certainly never folded in. `true`: it may have been. */
  mightContain(id: string): boolean {
    if (this.#folded === 0) return false;
    const [first, step] = idHashes(id);
    for (let index = 0; index < this.hashes; index += 1) {
      const position = (first + index * step) % this.bits;
      if (((this.#words[position >>> 3] ?? 0) & (1 << (position & 7))) === 0) return false;
    }
    return true;
  }

  counters(): EvictedIdFilterCounters {
    return { bits: this.bits, hashes: this.hashes, bitsSet: this.#bitsSet, folded: this.#folded };
  }
}

/** Two independent 32-bit FNV-1a hashes of `id` (the second forced odd, so it is a usable step). */
function idHashes(id: string): readonly [number, number] {
  let first = 0x811c9dc5;
  let second = 0x01000193 ^ 0x5bd1e995;
  for (let index = 0; index < id.length; index += 1) {
    const unit = id.charCodeAt(index);
    first = Math.imul(first ^ unit, 0x01000193) >>> 0;
    second = Math.imul(second ^ unit, 0x5bd1e995) >>> 0;
    second = (second ^ (second >>> 15)) >>> 0;
  }
  return [first, (second | 1) >>> 0];
}
