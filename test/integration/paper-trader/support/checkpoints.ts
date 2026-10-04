/**
 * `CKPT-1` — an independent oracle for ADR-027 Decision 1 over persisted
 * decision rows, for the suites that used to pin "one checkpoint per decision".
 *
 * ADR-027 (the user's ruling A2): a checkpoint is written after a persisted
 * decision only when the state bytes, the status or the RNG differ from the
 * last checkpoint's, at the instance's first decision (START), at `onStop`
 * (STOP), or 60 s of event time after the last checkpoint (HEARTBEAT). This
 * module derives which decisions owe one from the decisions ALONE — their
 * `statePatch` fold (`rebuildStateFromPatches`, `WP-170` decision 8), their
 * attribution (a RUNTIME record is a containment, which PAUSES: STATUS), their
 * callback and their `evaluatedAt` — so a test can compare what the store holds
 * with what the rule says, without asking the runtime.
 *
 * PRECONDITION: the strategy draws NO randomness (Static Bracket draws none).
 * An RNG draw leaves no trace in a decision row, which is exactly why ADR-027
 * D3 is met by writing a decision and its checkpoint in ONE transaction rather
 * than by a restore that inspects the decisions.
 */

import { canonicalJsonStringify, rebuildStateFromPatches } from "@polymarket-bot/strategy-runtime";

/** One persisted decision as the oracle reads it. */
export interface OracleDecision {
  readonly instanceId: string;
  readonly evaluationSeq: number;
  readonly callback: string;
  readonly attribution: string;
  /** Strict-UTC or offset ISO-8601; compared as epoch milliseconds. */
  readonly evaluatedAt: string;
  readonly statePatch: Readonly<Record<string, unknown>> | undefined | null;
}

/** What one owed checkpoint holds: its key and the folded state bytes. */
export interface OwedCheckpoint {
  readonly instanceId: string;
  readonly checkpointSeq: number;
  readonly stateJson: string;
}

/**
 * The checkpoints ADR-027 Decision 1 owes for `decisions`, in evaluation order
 * per instance (the input's order is kept between instances).
 */
export function owedCheckpoints(decisions: readonly OracleDecision[]): OwedCheckpoint[] {
  const owed: OwedCheckpoint[] = [];
  const last = new Map<string, { readonly bytes: string; readonly atMs: number }>();
  const patches = new Map<string, (Readonly<Record<string, unknown>> | undefined)[]>();
  for (const decision of decisions) {
    const list = patches.get(decision.instanceId) ?? [];
    list.push(decision.statePatch ?? undefined);
    patches.set(decision.instanceId, list);
    const folded = rebuildStateFromPatches(list);
    if (!folded.ok) throw new Error(`the persisted patches do not fold: ${folded.problem}`);
    const bytes = canonicalJsonStringify(folded.state);
    const atMs = Date.parse(decision.evaluatedAt);
    const previous = last.get(decision.instanceId);
    const owes =
      previous === undefined ||
      bytes !== previous.bytes ||
      decision.attribution === "RUNTIME" ||
      decision.callback === "onStop" ||
      atMs - previous.atMs >= 60_000;
    if (!owes) continue;
    owed.push({ instanceId: decision.instanceId, checkpointSeq: decision.evaluationSeq, stateJson: bytes });
    last.set(decision.instanceId, { bytes, atMs });
  }
  return owed;
}

/** `instanceId|checkpointSeq` of every owed checkpoint, for a compact comparison. */
export function owedCheckpointKeys(decisions: readonly OracleDecision[]): string[] {
  return owedCheckpoints(decisions).map((entry) => `${entry.instanceId}|${String(entry.checkpointSeq)}`);
}

/** A persisted `DecisionRecord` (the in-memory stores' shape) as the oracle reads it. */
export function oracleDecisionOf(record: {
  readonly instanceId: string;
  readonly evaluationSeq: number;
  readonly callback: string;
  readonly attribution: string;
  readonly evaluatedAt: string;
  readonly decision: { readonly statePatch?: Readonly<Record<string, unknown>> | undefined };
}): OracleDecision {
  return {
    instanceId: record.instanceId,
    evaluationSeq: record.evaluationSeq,
    callback: record.callback,
    attribution: record.attribution,
    evaluatedAt: record.evaluatedAt,
    statePatch: record.decision.statePatch,
  };
}
