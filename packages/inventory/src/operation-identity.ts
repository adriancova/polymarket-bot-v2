/**
 * One wallet operation's transaction identity set and the evidence standing
 * under it (WP300-R6: the class fix for rounds 3-6, in which evidence keyed by
 * one identifier missed contradicting or superseding evidence held under an
 * associated identifier), and the evidence generation that tells a current
 * reconciliation answer from a superseded one (WP300-R7-X3).
 *
 * VENUE FACTS. A position transaction's outcome carries `transactionHash:
 * TxHash` and `transactionId: TransactionId | null` (verified-2026-09-16 §10.2,
 * S-D29 lines 166–167, 361–362, 561–562; re-confirmed unchanged by
 * verified-2026-09-30 §10.2). No verified report documents how a relayer
 * transaction id relates to transaction hashes (whether one id can be
 * broadcast under several hashes, or which hash belongs to which id). So every
 * hash and every relayer id any evidence has ever named for the operation is a
 * member of ONE set, and evidence about any member OUTSIDE FLIGHT is weighed
 * against the whole set.
 *
 * WHERE A PAIRING IS STILL ASSUMED (WP300-R7-X4; the manager's header has the
 * detail). Two places treat identifiers as belonging together, by design:
 * - in flight (SUBMITTED/MINED), the first hash and the first relayer id are
 *   learned as the operation's own identity (the in-flight trust boundary);
 * - before the conclusion, while the set has at most one hash and one relayer
 *   id and nothing has been weighed under reconciliation, one terminal answer
 *   naming ANY member concludes the operation for the whole set (so
 *   `FAILED(null, R)` concludes an operation submitted as `(A, R)`).
 * Once anything is weighed under reconciliation, or the set is conflicted,
 * every member must be answered by name and no pairing is assumed.
 *
 * KEYS. `hash:<h>` and `id:<i>` per member, in order of arrival; `operation`
 * for an operation that concluded before any transaction was named.
 *
 * STANDING EVIDENCE. One map, key → the outcome (CONFIRMED or FAILED) that
 * currently stands for it and whether an authoritative answer named it. It is
 * written by an authoritative answer (for EVERY key the answer names) and by
 * the operation's conclusion (for every key with none). There is no second
 * map in which a stale answer could survive.
 *
 * WEIGHING NON-AUTHORITATIVE EVIDENCE ({@link OperationIdentity.weigh}), in
 * this order — contradictions first, then admission, so that no observation
 * can evade invalidation by naming another identifier:
 * 1. Contradictions: for each key the evidence names that is already a member
 *    (every member when it names none), the standing outcome is CONTESTED if
 *    the evidence is a different terminal outcome, a CONFIRMED with a
 *    different credited amount than the one applied, or unrecognised.
 * 2. A FAILED fact, an unrecognised one, or any contradiction under ANY
 *    member also contests every CONFIRMED standing under EVERY member: until
 *    an authoritative answer re-establishes it, no CONFIRMED evidence survives
 *    a doubt raised under an associated identifier.
 * 3. Contested standings are SET ASIDE (the key is unresolved again) and kept
 *    in the `reopened` history.
 * 4. Admission: members not seen before join the set, unresolved.
 *
 * EVIDENCE GENERATION (WP300-R7-X3). A reconciliation answer reports a read
 * the reconciler made AFTER receiving a request; the manager knows when it
 * issued that request, not when the read happened. So every request records
 * the generation current when it was issued, and every weighing that could
 * make an earlier read wrong advances the generation and MARKS what it
 * concerns:
 * - a DOUBT (a FAILED or unrecognised fact, or any contradiction) marks the
 *   whole operation: a CONFIRMED answer read for an earlier request is
 *   superseded (a doubt under any member doubts every CONFIRMED, rule 2);
 * - a SUCCESS CLAIM (a CONFIRMED or unrecognised fact) marks each key it
 *   names that does not already stand CONFIRMED (every member, and the
 *   `operation` key, when it names none): a FAILED answer read for an earlier
 *   request is superseded;
 * - a key that is SET ASIDE or ADMITTED is marked outright: any answer naming
 *   it read for an earlier request is superseded;
 * - re-entering reconciliation (UNKNOWN after a request was issued) marks
 *   everything ({@link OperationIdentity.supersedeEverything}).
 * An answer is SUPERSEDED when a mark that concerns it is newer than its
 * request ({@link OperationIdentity.supersededFor}); the `operation` key's
 * marks concern every answer (evidence naming no transaction concerns every
 * transaction, including those named later). A superseded answer is refused before it
 * changes standing evidence, and the manager then weighs it like an
 * observation. Agreeing evidence does not supersede an answer (a CONFIRMED
 * fact does not supersede a CONFIRMED answer), so a reconciler that keeps
 * answering the latest request with the truth converges.
 *
 * ANSWERS ({@link OperationIdentity.checkAnswer}). An authoritative terminal
 * answer names keys; it is refused if ANY named key stands under a different
 * outcome (an answer cannot overwrite standing evidence that nothing
 * contested), and if it names no unresolved (or new) key. Accepted, it stands
 * for EVERY key it names. An answer that repeats, for every key it names, an
 * outcome the authority already gave and that still stands carries no new
 * fact ({@link OperationIdentity.isAuthoritativeRepeat}).
 *
 * UNRESOLVED. After a terminal state, every member without standing evidence
 * (the operation is quarantined while any remain). Before it, the same once
 * the whole set must be answered by name — the operation named more than one
 * hash or relayer id, or evidence arrived while it was under reconciliation
 * (see the manager's header); otherwise one answer naming the operation's
 * transaction concludes it.
 */

import { compareDecimal, type DecimalString } from "@polymarket-bot/decimal";

export type TerminalOutcome = "CONFIRMED" | "FAILED";

/** The key standing for an operation that concluded before any transaction was named. */
export const OPERATION_KEY = "operation";

export const hashKey = (hash: string): string => `hash:${hash}`;
export const idKey = (id: string): string => `id:${id}`;

export interface IdentityValues {
  readonly transactionHash: string | null;
  readonly transactionId: string | null;
}

/** A non-authoritative piece of evidence, classified. */
export interface WeighedEvidence extends IdentityValues {
  readonly kind: "SUBMITTED" | "MINED" | "CONFIRMED" | "FAILED" | "UNRECOGNISED";
  /** A CONFIRMED observation's credited amount, if it carries one. */
  readonly credited: DecimalString | null;
}

export interface Standing {
  readonly outcome: TerminalOutcome;
  /** Named by an authoritative answer (rather than recorded from the conclusion). */
  readonly authoritative: boolean;
}

export interface Weighing {
  /** Keys whose standing evidence was set aside, in key order. */
  readonly setAside: readonly string[];
  /** Keys admitted to the set by this evidence. */
  readonly admitted: readonly string[];
  /** The evidence advanced the generation: answers read for earlier requests may be superseded. */
  readonly marked: boolean;
}

/** What an answer resolves: a terminal outcome, or "still in flight" (SUBMITTED/MINED). */
export type AnswerOutcome = TerminalOutcome | "IN_FLIGHT";

export type AnswerCheck =
  | { readonly ok: true; readonly keys: readonly string[] }
  | {
      readonly ok: false;
      readonly code: "WALLET_OP_EVIDENCE_REQUIRED" | "WALLET_OP_EVIDENCE_CONFLICT";
      readonly reason: string;
      readonly transaction: string | null;
      readonly previous: TerminalOutcome | null;
    };

/** The `hash:`/`id:` keys an identity names. */
export function identityKeys(identity: IdentityValues): string[] {
  const keys: string[] = [];
  if (identity.transactionHash !== null) keys.push(hashKey(identity.transactionHash));
  if (identity.transactionId !== null) keys.push(idKey(identity.transactionId));
  return keys;
}

export class OperationIdentity {
  readonly #hashes: string[] = [];
  readonly #ids: string[] = [];
  readonly #standing = new Map<string, Standing>();
  readonly #reopened: string[] = [];
  /** Concluded before any transaction was named: the `operation` key is a member. */
  #anonymous = false;
  /** Every member must be answered by name before a conclusion. */
  #everyKey = false;
  /** The evidence generation (see the header, "EVIDENCE GENERATION"). */
  #generation = 0;
  /** The generation of the latest doubt: supersedes CONFIRMED answers read for earlier requests. */
  #doubtMark = 0;
  /** The generation of the latest re-entry into reconciliation: supersedes every earlier answer. */
  #everythingMark = 0;
  /** Per key, the latest success claim: supersedes FAILED answers read for earlier requests. */
  readonly #successMarks = new Map<string, number>();
  /** Per key, the latest set-aside or admission: supersedes any answer read for an earlier request. */
  readonly #resetMarks = new Map<string, number>();

  /** The current evidence generation; a reconciliation request records it when issued. */
  get generation(): number {
    return this.#generation;
  }

  /** Every hash any evidence has named, in order of arrival. Never shrinks. */
  get hashes(): readonly string[] {
    return this.#hashes;
  }

  /** Every relayer transaction id any evidence has named, in order of arrival. Never shrinks. */
  get ids(): readonly string[] {
    return this.#ids;
  }

  /** Keys whose standing evidence was set aside, in order. Never shrinks. */
  get reopened(): readonly string[] {
    return this.#reopened;
  }

  /** Every member's key: `operation` (if anonymous), then hashes, then relayer ids. */
  keys(): string[] {
    return [...(this.#anonymous ? [OPERATION_KEY] : []), ...this.#hashes.map(hashKey), ...this.#ids.map(idKey)];
  }

  standing(key: string): Standing | undefined {
    return this.#standing.get(key);
  }

  /** More than one transaction hash, or more than one relayer id, has been named. */
  isConflicted(): boolean {
    return this.#hashes.length > 1 || this.#ids.length > 1;
  }

  /** Whether every member must be answered by name before the operation concludes. */
  requiresEveryKey(): boolean {
    return this.#everyKey || this.isConflicted();
  }

  /** From now on, every member must be answered by name. Irreversible. */
  requireEveryKey(): void {
    this.#everyKey = true;
  }

  /**
   * Which identity field the evidence contradicts, if any: it names a value
   * while other values of that field are members, none of them this one.
   */
  fieldConflict(identity: IdentityValues): "transaction hash" | "relayer transaction id" | null {
    if (identity.transactionHash !== null && this.#hashes.length > 0 && !this.#hashes.includes(identity.transactionHash)) {
      return "transaction hash";
    }
    if (identity.transactionId !== null && this.#ids.length > 0 && !this.#ids.includes(identity.transactionId)) {
      return "relayer transaction id";
    }
    return null;
  }

  /** Admit the values the evidence names (witnessed; never removed). Returns the new keys. */
  admit(identity: IdentityValues): string[] {
    const admitted: string[] = [];
    if (identity.transactionHash !== null && !this.#hashes.includes(identity.transactionHash)) {
      this.#hashes.push(identity.transactionHash);
      admitted.push(hashKey(identity.transactionHash));
    }
    if (identity.transactionId !== null && !this.#ids.includes(identity.transactionId)) {
      this.#ids.push(identity.transactionId);
      admitted.push(idKey(identity.transactionId));
    }
    return admitted;
  }

  /** Members still lacking standing evidence (see the header, "UNRESOLVED"). */
  unresolved(terminal: boolean): string[] {
    if (!terminal && !this.requiresEveryKey()) return [];
    return this.keys().filter((key) => !this.#standing.has(key));
  }

  /** Whether some member stands CONFIRMED. */
  anyConfirmed(): boolean {
    for (const standing of this.#standing.values()) if (standing.outcome === "CONFIRMED") return true;
    return false;
  }

  /**
   * The operation concluded: the outcome stands for every member without
   * standing evidence (non-authoritatively). An operation that never named a
   * transaction gets the `operation` key.
   */
  conclude(outcome: TerminalOutcome): void {
    if (this.#hashes.length === 0 && this.#ids.length === 0) this.#anonymous = true;
    for (const key of this.keys()) {
      if (!this.#standing.has(key)) this.#standing.set(key, Object.freeze({ outcome, authoritative: false }));
    }
  }

  /**
   * Weigh a non-authoritative piece of evidence against the WHOLE set:
   * contradictions first, then admission, then the marks (see the header).
   */
  weigh(evidence: WeighedEvidence, appliedCredit: DecimalString | null): Weighing {
    const members = this.keys();
    const named = identityKeys(evidence);
    const targets = named.length > 0 ? named.filter((key) => members.includes(key)) : members;
    const contested = new Set<string>();
    for (const key of targets) {
      const standing = this.#standing.get(key);
      if (standing === undefined) continue;
      if (evidence.kind === "UNRECOGNISED" || contradicts(standing, evidence, appliedCredit)) contested.add(key);
    }
    const doubt = contested.size > 0 || evidence.kind === "FAILED" || evidence.kind === "UNRECOGNISED";
    if (doubt) {
      for (const [key, standing] of this.#standing) if (standing.outcome === "CONFIRMED") contested.add(key);
    }
    const setAside = members.filter((key) => contested.has(key));
    for (const key of setAside) {
      this.#standing.delete(key);
      this.#reopened.push(key);
    }
    const admitted = this.admit(evidence);
    const successClaim = evidence.kind === "CONFIRMED" || evidence.kind === "UNRECOGNISED";
    const success = successClaim
      ? [
          ...targets.filter((key) => this.#standing.get(key)?.outcome !== "CONFIRMED"),
          ...admitted,
          ...(named.length === 0 ? [OPERATION_KEY] : []),
        ]
      : [];
    const marked = this.#mark(doubt, success, [...setAside, ...admitted]);
    return { setAside, admitted, marked };
  }

  /**
   * The operation re-enters reconciliation after a request was issued: every
   * answer read for an earlier request is superseded (the evidence that sent
   * it back is newer than any of those reads).
   */
  supersedeEverything(): void {
    this.#generation += 1;
    this.#everythingMark = this.#generation;
  }

  /**
   * Why an answer of `outcome` naming `identity`, read for a request issued
   * at generation `issuedAt`, is superseded — or null if it is current (see
   * the header, "EVIDENCE GENERATION"). Every answer also concerns the
   * `operation` key: evidence naming no transaction concerns every
   * transaction of the operation, including those named later.
   */
  supersededFor(outcome: AnswerOutcome, identity: IdentityValues, issuedAt: number): string | null {
    if (this.#everythingMark > issuedAt) return "the operation re-entered reconciliation after the request was issued";
    if (outcome !== "FAILED" && this.#doubtMark > issuedAt) {
      return "a FAILED or unrecognised fact, or a contradiction, was weighed after the request was issued";
    }
    for (const key of [...identityKeys(identity), OPERATION_KEY]) {
      if ((this.#resetMarks.get(key) ?? 0) > issuedAt) {
        return `${key} was set aside or first named after the request was issued`;
      }
      if (outcome !== "CONFIRMED" && (this.#successMarks.get(key) ?? 0) > issuedAt) {
        return `a CONFIRMED or unrecognised fact about ${key} was weighed after the request was issued`;
      }
    }
    return null;
  }

  /**
   * Whether an authoritative terminal answer repeats, for every key it names,
   * an outcome an authoritative answer already gave and that still stands (a
   * CONFIRMED with a credited amount must also match the applied one). Such
   * an answer carries no new fact. An answer naming nothing never is one.
   */
  isAuthoritativeRepeat(
    outcome: TerminalOutcome,
    identity: IdentityValues,
    credited: DecimalString | null,
    appliedCredit: DecimalString | null,
  ): boolean {
    const keys = identityKeys(identity);
    if (keys.length === 0) return false;
    if (outcome === "CONFIRMED" && credited !== null && appliedCredit !== null && compareDecimal(credited, appliedCredit) !== 0) {
      return false;
    }
    return keys.every((key) => {
      const standing = this.#standing.get(key);
      return standing !== undefined && standing.authoritative && standing.outcome === outcome;
    });
  }

  /** Advance the generation and mark what the evidence concerns. True if anything was marked. */
  #mark(doubt: boolean, success: readonly string[], reset: readonly string[]): boolean {
    if (!doubt && success.length === 0 && reset.length === 0) return false;
    this.#generation += 1;
    if (doubt) this.#doubtMark = this.#generation;
    for (const key of success) this.#successMarks.set(key, this.#generation);
    for (const key of reset) this.#resetMarks.set(key, this.#generation);
    return true;
  }

  /**
   * Check an authoritative terminal answer against every key it names (see
   * the header, "ANSWERS"). Mutates nothing. Every answer also names the
   * `operation` key while it is unresolved, so an unnamed answer can resolve
   * it; otherwise an unnamed answer names nothing and is refused. The caller
   * has already refused a value outside a non-empty field ({@link fieldConflict}).
   */
  checkAnswer(outcome: TerminalOutcome, identity: IdentityValues): AnswerCheck {
    const named = identityKeys(identity);
    if (this.#anonymous && !this.#standing.has(OPERATION_KEY)) named.unshift(OPERATION_KEY);
    if (named.length === 0) {
      return refusal("WALLET_OP_EVIDENCE_REQUIRED", "the evidence must name which transaction it resolves; each is resolved by name");
    }
    for (const key of named) {
      const standing = this.#standing.get(key);
      if (standing !== undefined && standing.outcome !== outcome) {
        return {
          ok: false,
          code: "WALLET_OP_EVIDENCE_CONFLICT",
          reason: "this transaction stands under a different outcome, and no evidence has contested it",
          transaction: key,
          previous: standing.outcome,
        };
      }
    }
    const members = this.keys();
    if (!named.some((key) => !members.includes(key) || !this.#standing.has(key))) {
      return refusal("WALLET_OP_EVIDENCE_REQUIRED", "the evidence names no unresolved transaction; each is resolved by name");
    }
    return { ok: true, keys: Object.freeze(named) };
  }

  /** Record an authoritative terminal answer {@link checkAnswer} accepted: it stands for every key it names. */
  recordAnswer(outcome: TerminalOutcome, identity: IdentityValues, keys: readonly string[]): void {
    this.admit(identity);
    for (const key of keys) this.#standing.set(key, Object.freeze({ outcome, authoritative: true }));
  }

  /**
   * Whether an approval operation's approval stands on the standing evidence
   * (every member has some once its quarantine lifts). Fail-closed: some
   * member stands CONFIRMED by an authoritative answer; or some member stands
   * CONFIRMED (from the conclusion) and no authoritative answer says FAILED.
   */
  approvalStands(): boolean {
    let confirmed = false;
    let authoritativeConfirmed = false;
    let authoritativeFailed = false;
    for (const standing of this.#standing.values()) {
      if (standing.outcome === "CONFIRMED") {
        confirmed = true;
        if (standing.authoritative) authoritativeConfirmed = true;
      } else if (standing.authoritative) {
        authoritativeFailed = true;
      }
    }
    return authoritativeConfirmed || (confirmed && !authoritativeFailed);
  }
}

function contradicts(standing: Standing, evidence: WeighedEvidence, appliedCredit: DecimalString | null): boolean {
  if (evidence.kind !== "CONFIRMED" && evidence.kind !== "FAILED") return false;
  if (standing.outcome !== evidence.kind) return true;
  return (
    evidence.kind === "CONFIRMED" &&
    evidence.credited !== null &&
    appliedCredit !== null &&
    compareDecimal(evidence.credited, appliedCredit) !== 0
  );
}

function refusal(code: "WALLET_OP_EVIDENCE_REQUIRED", reason: string): AnswerCheck {
  return { ok: false, code, reason, transaction: null, previous: null };
}
