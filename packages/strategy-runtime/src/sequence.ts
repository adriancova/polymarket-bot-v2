/**
 * The RUN-SCOPED evaluation sequence (`ROLLOVER-1`; ADR-030 Decision 4, the
 * user's ruling Q2 of 2026-10-04).
 *
 * ## Why it exists
 *
 * ADR-030 Decision 4.2: one run — one `strategy.runs` row — spans many windows
 * of a reviewed series. Each admitted window needs FRESH strategy state (the
 * Static Bracket's state is per market: `entriesExecuted` is "PER-MARKET, and
 * therefore CARRIED"), so each window gets its own runtime. But every runtime
 * numbered its decisions and checkpoints from its own counter, starting at 0,
 * and the store keys both by run:
 *
 * - `strategy.decisions` `decisions_evaluation_unique (run_id, evaluation_seq)`;
 * - `strategy.state_checkpoints` `state_checkpoints_seq_unique (run_id, checkpoint_seq)`
 *   (`db/migrations/0004_strategy.up.sql`).
 *
 * So the second window's first decision collided with the first window's —
 * measured by `ROLLOVER-1`'s first implementer (its stop report, B2, probe
 * `run-sequence.probe.ts`: two runtimes under one run identity both persisted
 * `run-1|0`). A store failure halts the trader.
 *
 * ## What it is
 *
 * ONE counter per run, handed to every runtime of that run
 * (`StrategyRuntimeDefinition.sequence`). A runtime takes its next number from
 * it at the moment it builds a record it is about to persist, so the
 * decisions of all the run's runtimes — and the checkpoints, which carry their
 * decision's sequence (`checkpointSeq` = `evaluationSeq`, `CKPT-1` D3) — are
 * numbered once, in the order they were made, with no number used twice.
 *
 * - **Seeded once per run.** A fresh run starts at 0
 *   ({@link createRunEvaluationSequence}). A restored run starts at its highest
 *   DURABLE evaluation sequence plus one ({@link runEvaluationSequenceAfter}),
 *   which is exactly what `restoreFromPoint` answers as `nextEvaluationSeq`
 *   (ADR-027 D2.2) — so a restored runtime and its run's counter agree, and a
 *   runtime is refused if its restore point is AHEAD of the counter it is
 *   handed (the counter would re-issue a durable number).
 * - **A number is spent when it is TAKEN**, not when its record is persisted.
 *   A runtime whose persist then fails is paused (`runtime.ts` `halt`), and
 *   the number it took is never handed out again — a gap, never a re-use. A
 *   runtime WITHOUT a run sequence keeps its own counter exactly as before:
 *   nothing about a single-market run changes.
 * - **The same exhaustion bound** as a runtime's own counter
 *   (`MAX_EVALUATION_SEQ`): the counter refuses to issue a number it could not
 *   represent exactly.
 *
 * ## What it is not
 *
 * Not a caller-implemented port. A runtime accepts only a counter this module
 * minted (a brand check, `isRunEvaluationSequence`), and it numbers a record
 * through this module's OWN operations ({@link takeRunEvaluationSequence},
 * {@link peekRunEvaluationSequence}), which read the counter's private state
 * directly: never a property of the counter object, so no caller code runs
 * inside `evaluate()` to number a record, and the runtime's "one snapshot per
 * boundary" rule (`runtime.ts` header) has nothing new to guard. It changes
 * neither ADR-027 Decision 1's transition rule (each runtime still judges its
 * own transitions; a window's first decision is its runtime's START) nor
 * Decision 3's pairing of a decision with its checkpoint.
 *
 * `ROLLOVER-1` r4 (R4-ASTRA-01). Until r4 the runtime called the counter's
 * public `take()` and `peek()` by property lookup, and the brand covered the
 * object's identity only: a holder that replaced `take` on the instance or its
 * prototype (an ordinary assignment, or a throwing accessor) made two windows
 * persist `[0, 0]`, made a counter restored after sequence 41 issue 0, and
 * made `evaluate()` throw after the callback had run. Now:
 *
 * - the runtime reads the counter ONLY through the two module-owned
 *   operations, imported bindings no caller can rebind; the public `peek()`
 *   and `take()` are conveniences over the same operations, and replacing
 *   them changes what THEY answer, never what a runtime records;
 * - a counter is constructed only by this module's factories, which hold a
 *   module-private mint token: `new` through the class (or through a minted
 *   counter's `constructor`) and a subclass are refused with a `TypeError` at
 *   the caller and are never branded, so no counter escapes the seed
 *   validation of {@link runEvaluationSequenceAfter}.
 *
 * PURE: no clock, no I/O, no randomness.
 */

import { MAX_EVALUATION_SEQ } from "./checkpoint.js";
import { describeCause } from "./describe.js";

/** Counters this module minted. A runtime refuses anything else. */
const MINTED = new WeakSet<object>();

/**
 * The construction capability (`ROLLOVER-1` r4, R4-ASTRA-01): held only by this
 * module, so only its factories — which validate the seed — construct a counter.
 */
const MINT_TOKEN: unique symbol = Symbol("RunEvaluationSequence.mint");

/**
 * The module-owned operations over a counter's private state — construction
 * included — bound once when the class is defined (its static block) and never
 * reachable from a counter object: what a runtime calls to number a record
 * (R4-ASTRA-01).
 */
let mintState: (next: number) => RunEvaluationSequence;
let peekState: (sequence: RunEvaluationSequence) => number;
let takeState: (sequence: RunEvaluationSequence) => number | undefined;

export interface RunEvaluationSequenceRefusal {
  readonly code: "RUN_SEQUENCE_SEED_INVALID";
  readonly detail: string;
}

export type CreateRunEvaluationSequenceResult =
  | { readonly ok: true; readonly sequence: RunEvaluationSequence }
  | { readonly ok: false; readonly refusal: RunEvaluationSequenceRefusal };

/**
 * One run's evaluation sequence. Obtained only from
 * {@link createRunEvaluationSequence} or {@link runEvaluationSequenceAfter}
 * (construction requires this module's mint token, and both factories
 * validate the seed).
 */
export class RunEvaluationSequence {
  #next: number;
  #issued = 0;

  static {
    mintState = (next) => new RunEvaluationSequence(MINT_TOKEN, next);
    peekState = (sequence) => sequence.#next;
    takeState = (sequence) => {
      if (sequence.#next > MAX_EVALUATION_SEQ) return undefined;
      const taken = sequence.#next;
      sequence.#next += 1;
      sequence.#issued += 1;
      return taken;
    };
  }

  private constructor(mint: typeof MINT_TOKEN, next: number) {
    // `ROLLOVER-1` r4 (R4-ASTRA-01): TypeScript's `private` is erased at
    // runtime, so the token is what refuses a caller's `new` (through the
    // class, a minted counter's `constructor`, or a subclass's `super`).
    if (mint !== MINT_TOKEN) {
      throw new TypeError(
        "a run evaluation sequence is obtained only from createRunEvaluationSequence or " +
          "runEvaluationSequenceAfter (@polymarket-bot/strategy-runtime); constructing one is refused",
      );
    }
    this.#next = next;
    MINTED.add(this);
  }

  /** A FRESH run's counter, starting at 0. */
  static fresh(): RunEvaluationSequence {
    return mintFresh();
  }

  /** A RESTORED run's counter, starting after its highest durable sequence. TOTAL. */
  static after(highestDurableEvaluationSeq: unknown): CreateRunEvaluationSequenceResult {
    return mintAfter(highestDurableEvaluationSeq);
  }

  /**
   * The sequence the run's next persisted decision will carry. A convenience:
   * a runtime reads {@link peekRunEvaluationSequence}, never this method.
   */
  peek(): number {
    return peekState(this);
  }

  /**
   * Takes the next sequence for one record about to be persisted, or
   * `undefined` when the run has consumed {@link MAX_EVALUATION_SEQ} (the last
   * number it can represent exactly). A taken number is never issued again.
   * A convenience: a runtime takes through {@link takeRunEvaluationSequence}.
   */
  take(): number | undefined {
    return takeState(this);
  }

  /** How many numbers this counter has issued (diagnostics). */
  get issued(): number {
    return this.#issued;
  }
}

function mintFresh(): RunEvaluationSequence {
  return mintState(0);
}

function mintAfter(highestDurableEvaluationSeq: unknown): CreateRunEvaluationSequenceResult {
  if (
    typeof highestDurableEvaluationSeq !== "number" ||
    !Number.isSafeInteger(highestDurableEvaluationSeq) ||
    highestDurableEvaluationSeq < 0
  ) {
    return {
      ok: false,
      refusal: {
        code: "RUN_SEQUENCE_SEED_INVALID",
        detail:
          "the run's highest durable evaluation sequence must be a non-negative safe integer; " +
          `received ${describeCause(highestDurableEvaluationSeq)}`,
      },
    };
  }
  if (highestDurableEvaluationSeq > MAX_EVALUATION_SEQ) {
    return {
      ok: false,
      refusal: {
        code: "RUN_SEQUENCE_SEED_INVALID",
        detail:
          `the run's highest durable evaluation sequence ${String(highestDurableEvaluationSeq)} is past ` +
          `the last sequence a run can consume (${String(MAX_EVALUATION_SEQ)}); the run is finished ` +
          "and a continuation is a new run (§9.6)",
      },
    };
  }
  return { ok: true, sequence: mintState(highestDurableEvaluationSeq + 1) };
}

/**
 * `ROLLOVER-1` r4 (R4-ASTRA-01): the sequence a MINTED counter will issue next,
 * read from its private state — never through a property of the counter, so
 * a replaced or throwing `peek` is never called. What a runtime reads.
 * Package-internal (not exported from the package index). Never throws for a
 * counter `isRunEvaluationSequence` accepts.
 */
export function peekRunEvaluationSequence(sequence: RunEvaluationSequence): number {
  return peekState(sequence);
}

/**
 * `ROLLOVER-1` r4 (R4-ASTRA-01): takes a MINTED counter's next sequence (or
 * `undefined` once exhausted) from its private state — never through a
 * property of the counter. What a runtime numbers a record with.
 * Package-internal (not exported from the package index). Never throws for a
 * counter `isRunEvaluationSequence` accepts.
 */
export function takeRunEvaluationSequence(sequence: RunEvaluationSequence): number | undefined {
  return takeState(sequence);
}

/** Whether `value` is a counter this module minted. Pure; never throws. */
export function isRunEvaluationSequence(value: unknown): value is RunEvaluationSequence {
  return typeof value === "object" && value !== null && MINTED.has(value);
}

/**
 * A FRESH run's counter: its first decision carries sequence 0, as a lone
 * runtime's always did.
 */
export function createRunEvaluationSequence(): RunEvaluationSequence {
  return mintFresh();
}

/**
 * A RESTORED run's counter: the highest DURABLE evaluation sequence of the
 * run plus one (ADR-027 D2.2 — the value `restoreFromPoint` answers as
 * `nextEvaluationSeq`). Refused unless `highestDurableEvaluationSeq` is a
 * non-negative safe integer no greater than {@link MAX_EVALUATION_SEQ}, the
 * same bound `restoreFromPoint` applies. TOTAL: never throws.
 */
export function runEvaluationSequenceAfter(
  highestDurableEvaluationSeq: unknown,
): CreateRunEvaluationSequenceResult {
  return mintAfter(highestDurableEvaluationSeq);
}
