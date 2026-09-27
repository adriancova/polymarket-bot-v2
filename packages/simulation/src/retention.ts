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
 * memory of order ids whose ORDERS the retention map has already forgotten.
 */
export class TombstoneSet {
  readonly maximumRetained: number;
  readonly #ids = new Set<string>();
  #evicted = 0;

  constructor(maximumRetained: number, what: string) {
    this.maximumRetained = requireRetentionBound(maximumRetained, what);
  }

  remember(id: string): void {
    if (this.#ids.has(id)) return;
    if (this.#ids.size >= this.maximumRetained) {
      const oldest = this.#ids.values().next();
      if (oldest.done !== true) {
        this.#ids.delete(oldest.value);
        this.#evicted += 1;
      }
    }
    this.#ids.add(id);
  }

  has(id: string): boolean {
    return this.#ids.has(id);
  }

  counters(): RetentionCounters {
    return { retained: this.#ids.size, maximumRetained: this.maximumRetained, evicted: this.#evicted };
  }
}
