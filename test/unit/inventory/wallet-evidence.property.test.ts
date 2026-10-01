/**
 * WP-300 remediation round 6 (class fix): a seeded interleaving property over
 * a wallet operation's ONE identity set.
 *
 * Rounds 3-6 each found a new variant of one defect class: evidence keyed by
 * one identifier (a transaction hash or a relayer id) missed contradicting or
 * superseding evidence held under an associated identifier. This suite
 * generates random interleavings of SUBMITTED / MINED / CONFIRMED / FAILED /
 * UNKNOWN (and DROPPED) observations, executor answers (immediate, pending and
 * late), CLOB allowance syncs, reconciler outages and authoritative
 * resolutions — over mixed identifiers: a new hash, a new relayer id, both,
 * neither, multi-identifier answers, and late or stale answers (repeats,
 * answers after the conclusion, answers contradicting standing evidence) — for
 * value operations (SPLIT, WRAP_COLLATERAL) and for ERC20 / ERC1155 approvals.
 *
 * The oracle is independent of the implementation's evidence logic. It knows
 * only the history of CLAIMS (what each observation or executor answer said,
 * which identifiers it named, which of them were new, and the state the
 * operation was in) and of ACCEPTED authoritative answers. A claim creates
 * obligations that only a later accepted authoritative answer can discharge:
 * - a NEW identifier named outside flight (UNKNOWN, RECONCILING, CONFIRMED,
 *   FAILED), or a value conflicting with a known one, must itself be named by
 *   a later answer;
 * - a CONFIRMED or unrecognised claim outside flight on an operation that is
 *   not CONFIRMED, and a FAILED or unrecognised claim on a CONFIRMED one, must
 *   be answered later by an answer naming one of the identifiers it named (any
 *   answer, if it named none).
 * Asserted after every step:
 * P1  no reservation release while a claim's obligations are unmet: at the
 *     release itself (a FAILED conclusion: all obligations; a CONFIRMED one:
 *     every new identifier answered), and whenever the operation's lines are
 *     spendable (released and unblocked);
 * P2  readiness is never true without a valid unrefuted CONFIRMED approval: a
 *     validation (an accepted authoritative CONFIRMED answer, or a CONFIRMED
 *     conclusion in flight) more recent than every doubt (a FAILED or
 *     unrecognised claim), a CLOB allowance sync recorded after it, and every
 *     new identifier answered; never while the operation is quarantined;
 * P3  exact conservation: balances move only by the plan's exact amounts (or
 *     the observed credit), at most once; reservations are held in full or
 *     released, never re-held; `checkInvariants()` stays empty;
 * and that the identity set only grows and contains every identifier named by
 * an observation, an executor answer or an accepted answer. At the end of each
 * run, answering every unresolved identifier FAILED by name always concludes
 * the operation and lifts any quarantine (liveness).
 *
 * WP-300 remediation round 7 (WP300-R7-X3, WP300-R7-X1) extends the generator
 * and the oracle:
 * - request issuance, the reconciler's READ, and the answer's DELIVERY are
 *   separate events that interleave freely with everything else: a read
 *   captures what it says (state and identifiers) at read time, for a request
 *   already delivered (usually the latest, sometimes an older one); a pending
 *   answer is delivered later, in any order. Some answers name their request,
 *   some name none, and some are read and delivered at once;
 * - an ACCEPTED answer is stamped at its READ time, not its delivery time: it
 *   is only as fresh as the read it reports (it used to be stamped at
 *   delivery, which treated an old read as fresh);
 * - a REFUSED answer is a claim (delivered at its delivery time, like an
 *   observation), because the manager weighs it like one; the only exception
 *   is an authoritative answer repeating, for every identifier it names, the
 *   outcome of the latest accepted answer for it while it is still resolved
 *   (it carries no new fact);
 * - every identifier a refused answer names must be in the identity set.
 *
 * WP-300 remediation round 8 (WP300-R8-01, WP300-R8-02) extends both again:
 * - the generator reaches a superseded answer delivered IN FLIGHT (a seeded
 *   warm-up returns the operation to flight after a re-entry while a read made
 *   for the first request is still in transit) and answers naming a request
 *   not issued for the operation (a foreign request id);
 * - the oracle records a refused answer that was SUPERSEDED in flight as a
 *   claim made out of flight (the manager sends the operation back to
 *   reconciliation and weighs it there), so its new identifiers and its
 *   success claim create the same obligations as an observation out of flight;
 * - once a claim was WEIGHED under reconciliation (UNKNOWN or RECONCILING) —
 *   an observation-source claim other than a stale lifecycle report
 *   (SUBMITTED/MINED naming nothing new), or a late contradiction from the
 *   executor (NOT_SENT, an unrecognised answer, another transaction) — every
 *   identifier first named LATER, by anything, must be answered by name too,
 *   even if nothing had been named when that claim was made; and a release
 *   requires every identifier named up to that claim to have been named by
 *   an accepted answer (WP300-R8-02: no pairing is assumed after it);
 * - two seeded warm-ups reach those situations directly: a claim weighed while
 *   nothing is named followed by the executor's late answer naming two
 *   identifiers, and a late executor contradiction in simple mode, each then
 *   answered for one identifier only.
 *
 * fast-check is not a dependency (no new dependency may be added); the
 * generator is the suite's seeded PRNG, so every failure reproduces from its
 * seed, printed with the trace. Executors and reconcilers are in-memory mocks.
 * Nothing is signed or sent.
 */

import { describe, expect, it } from "vitest";

import {
  ApprovalTracker,
  WalletOperationManager,
  type ReconciliationRequest,
  type WalletOperationView,
} from "../../../packages/inventory/src/index.js";
import { ACCOUNT, CONDITION, CTF_EXCHANGE, NO, PUSD, USDC_E, YES, pick, prng, seededBook } from "./helpers.js";

const HASHES = [
  "0x00000000000000000000000000000000000000000000000000000000000000a1",
  "0x00000000000000000000000000000000000000000000000000000000000000b2",
  "0x00000000000000000000000000000000000000000000000000000000000000c3",
] as const;
const IDS = ["sanitized-relayer-id-r", "sanitized-relayer-id-s", "sanitized-relayer-id-t"] as const;

type OpKind = "SPLIT" | "WRAP_COLLATERAL" | "APPROVE_ERC20" | "APPROVE_ERC1155";
type ClaimKind = "SUBMITTED" | "MINED" | "CONFIRMED" | "FAILED" | "UNRECOGNISED" | "NOT_SENT";

interface Claim {
  readonly t: number;
  readonly source: "observation" | "executor";
  readonly kind: ClaimKind;
  readonly named: readonly string[];
  readonly fresh: readonly string[];
  readonly conflicting: boolean;
  readonly stateBefore: string;
}

interface AcceptedAnswer {
  /** The step at which the reconciler READ what the answer reports (not its delivery). */
  readonly t: number;
  readonly named: readonly string[];
}

/** A reconciler read awaiting delivery (WP300-R7-X3: issue, read and delivery are separate events). */
interface PendingAnswer {
  readonly readAt: number;
  readonly requestId: string | null;
  readonly state: string;
  readonly hash: string | null;
  readonly id: string | null;
  readonly source: string;
}

const IN_FLIGHT = new Set(["PLANNED", "SUBMITTED", "MINED"]);

const keysOf = (hash: string | null, id: string | null): string[] => [
  ...(hash === null ? [] : [`hash:${hash}`]),
  ...(id === null ? [] : [`id:${id}`]),
];

/** The documented observation shapes, classified here independently of the implementation. */
function classify(raw: Readonly<Record<string, unknown>>): ClaimKind {
  const hash = raw["transactionHash"];
  const id = raw["transactionId"];
  switch (raw["status"]) {
    case "SUBMITTED":
      return typeof hash === "string" || typeof id === "string" ? "SUBMITTED" : "UNRECOGNISED";
    case "MINED":
      return typeof hash === "string" ? "MINED" : "UNRECOGNISED";
    case "CONFIRMED":
      return typeof hash === "string" ? "CONFIRMED" : "UNRECOGNISED";
    case "FAILED":
      return "FAILED";
    case "NOT_SENT":
      return "NOT_SENT";
    default:
      return "UNRECOGNISED";
  }
}

class ClaimsOracle {
  readonly claims: Claim[] = [];
  readonly answers: AcceptedAnswer[] = [];
  /** Per identifier, the outcome of the latest accepted terminal answer naming it. */
  readonly lastAccepted = new Map<string, string>();
  readonly doubts: number[] = [];
  readonly validations: number[] = [];
  readonly syncs: number[] = [];
  /** The step of the first claim weighed under reconciliation (WP300-R8-02): later new identifiers are due by name. */
  everyKeyFrom: number | null = null;

  answeredAfter(t: number, key?: string): boolean {
    return this.answers.some((answer) => answer.t > t && (key === undefined || answer.named.includes(key)));
  }

  /** Obligations of every claim not yet discharged (see the header). */
  unmet(which: { readonly fresh: boolean; readonly success: boolean; readonly failureAfterConfirm: boolean }): string[] {
    const unmet: string[] = [];
    for (const claim of this.claims) {
      const outOfFlight = !IN_FLIGHT.has(claim.stateBefore);
      const afterWeighing = this.everyKeyFrom !== null && claim.t > this.everyKeyFrom;
      const freshDue =
        claim.fresh.length > 0 && (claim.conflicting || (claim.source === "observation" && outOfFlight) || afterWeighing);
      if (which.fresh && freshDue) {
        for (const key of claim.fresh) {
          if (!this.answeredAfter(claim.t, key)) unmet.push(`t${String(claim.t)} new ${key} never answered`);
        }
      }
      // WP300-R8-02: after the first claim weighed under reconciliation, no pairing is
      // assumed — every identifier named up to it must have been named by an accepted answer.
      if (which.fresh && this.everyKeyFrom !== null && claim.t <= this.everyKeyFrom) {
        for (const key of claim.named) {
          if (!this.answers.some((answer) => answer.named.includes(key)) && !unmet.includes(`${key} never named by an answer`)) {
            unmet.push(`${key} never named by an answer`);
          }
        }
      }
      if (claim.source !== "observation") continue;
      const answered =
        claim.named.length > 0
          ? claim.named.some((key) => this.answeredAfter(claim.t, key))
          : this.answeredAfter(claim.t);
      const success =
        (claim.kind === "CONFIRMED" || claim.kind === "UNRECOGNISED") && outOfFlight && claim.stateBefore !== "CONFIRMED";
      if (which.success && success && !answered) {
        unmet.push(`t${String(claim.t)} ${claim.kind}(${claim.named.join(",")}) in ${claim.stateBefore} never answered`);
      }
      const failure = (claim.kind === "FAILED" || claim.kind === "UNRECOGNISED") && claim.stateBefore === "CONFIRMED";
      if (which.failureAfterConfirm && failure && !answered) {
        unmet.push(`t${String(claim.t)} ${claim.kind}(${claim.named.join(",")}) after CONFIRMED never answered`);
      }
    }
    return unmet;
  }

  /** Why readiness may not be true now, or null (P2). */
  readinessViolation(): string | null {
    const lastDoubt = Math.max(-1, ...this.doubts);
    const valid = this.validations.filter((t) => t > lastDoubt);
    if (valid.length === 0) return `no validation after the last doubt (t${String(lastDoubt)})`;
    const latest = Math.max(...valid);
    if (!this.syncs.some((t) => t > latest)) return `no CLOB allowance sync after the validation at t${String(latest)}`;
    const unmet = this.unmet({ fresh: true, success: false, failureAfterConfirm: false });
    return unmet.length > 0 ? unmet.join("; ") : null;
  }
}

interface Coverage {
  failedReleasesAfterClaims: number;
  confirmedReleases: number;
  readyRuns: number;
  readinessWithdrawn: number;
  setAside: number;
  relayerIdsLearnedOutsideFlight: number;
  multiIdentifierAnswers: number;
  quarantinedValue: number;
  quarantinedApproval: number;
  refusedConflict: number;
  refusedAfterConclusion: number;
  lateExecutorAnswers: number;
  queuedRequests: number;
  supersededRefusals: number;
  refusedAnswersAsClaims: number;
  refusedAnswersInFlight: number;
  repeatsWithoutNewFact: number;
  delayedDeliveries: number;
  acceptedForOlderRequest: number;
  unboundAccepted: number;
  unboundRefused: number;
  supersededInFlight: number;
  supersededInFlightNamingNew: number;
  unknownRequestAnswers: number;
  unknownRequestInFlight: number;
  namedAfterEmptyWeighing: number;
  lateContradictionsWeighed: number;
}

function newCoverage(): Coverage {
  return {
    failedReleasesAfterClaims: 0,
    confirmedReleases: 0,
    readyRuns: 0,
    readinessWithdrawn: 0,
    setAside: 0,
    relayerIdsLearnedOutsideFlight: 0,
    multiIdentifierAnswers: 0,
    quarantinedValue: 0,
    quarantinedApproval: 0,
    refusedConflict: 0,
    refusedAfterConclusion: 0,
    lateExecutorAnswers: 0,
    queuedRequests: 0,
    supersededRefusals: 0,
    refusedAnswersAsClaims: 0,
    refusedAnswersInFlight: 0,
    repeatsWithoutNewFact: 0,
    delayedDeliveries: 0,
    acceptedForOlderRequest: 0,
    unboundAccepted: 0,
    unboundRefused: 0,
    supersededInFlight: 0,
    supersededInFlightNamingNew: 0,
    unknownRequestAnswers: 0,
    unknownRequestInFlight: 0,
    namedAfterEmptyWeighing: 0,
    lateContradictionsWeighed: 0,
  };
}

/** A request id never issued for the operation (WP300-R8-01: a foreign or pre-restart id). */
const FOREIGN_REQUEST = "wallet-op:foreign:reconciliation:1";

/** A member (70%), a value never named (when one is left), or nothing. */
function chooseValue(random: () => number, members: readonly string[], pool: readonly string[]): string | null {
  const roll = random();
  if (roll < 0.3) return null;
  const unused = pool.filter((value) => !members.includes(value));
  if (roll < 0.78 && members.length > 0) return pick(random, members);
  if (unused.length > 0) return pick(random, unused);
  return members.length > 0 ? pick(random, members) : null;
}

function plan(kind: OpKind): Record<string, unknown> {
  switch (kind) {
    case "SPLIT":
      return { type: "SPLIT", operationId: "op", accountRef: ACCOUNT, conditionId: CONDITION, amount: "10" };
    case "WRAP_COLLATERAL":
      return { type: "WRAP_COLLATERAL", operationId: "op", accountRef: ACCOUNT, amount: "10" };
    case "APPROVE_ERC20":
      return { type: "APPROVE_ERC20", operationId: "op", accountRef: ACCOUNT, assetId: PUSD, spender: CTF_EXCHANGE, allowance: "100" };
    case "APPROVE_ERC1155":
      return { type: "APPROVE_ERC1155", operationId: "op", accountRef: ACCOUNT, spender: CTF_EXCHANGE };
  }
}

const TOUCHED: Readonly<Record<OpKind, readonly string[]>> = {
  SPLIT: [PUSD, YES, NO],
  WRAP_COLLATERAL: [USDC_E, PUSD],
  APPROVE_ERC20: [],
  APPROVE_ERC1155: [],
};

async function run(seed: number, kind: OpKind, coverage: Coverage): Promise<void> {
  const random = prng(seed);
  const book = seededBook({ [PUSD]: "100", [USDC_E]: "50" });
  const approvals = new ApprovalTracker();
  let t = 0;
  const reconciler = {
    failing: false,
    requests: [] as ReconciliationRequest[],
    request(request: ReconciliationRequest): void {
      if (this.failing) throw new Error("reconciler unavailable");
      this.requests.push(request);
    },
  };
  /** Reads made and not yet delivered, in read order. */
  const pendingAnswers: PendingAnswer[] = [];
  const mode = pick(random, ["immediate", "immediate", "unrecognised", "pending", "pending"] as const);
  const firstHash = pick(random, HASHES);
  const firstId = random() < 0.5 ? pick(random, IDS) : null;
  let resolveExecutor: (value: unknown) => void = () => undefined;
  let rejectExecutor: (error: unknown) => void = () => undefined;
  const executorAnswer = new Promise<unknown>((resolve, reject) => {
    resolveExecutor = resolve;
    rejectExecutor = reject;
  });
  const manager = new WalletOperationManager({
    book,
    approvals,
    reconciler,
    executor: {
      submit: () =>
        mode === "immediate"
          ? Promise.resolve({ status: "SUBMITTED", transactionHash: firstHash, transactionId: firstId })
          : mode === "unrecognised"
            ? Promise.resolve({ status: "???" })
            : executorAnswer,
    },
  });
  const isApproval = kind === "APPROVE_ERC20" || kind === "APPROVE_ERC1155";
  const oracle = new ClaimsOracle();
  const trace: string[] = [`seed ${String(seed)} ${kind} executor ${mode}`];
  let wasReady = false;
  let wrapCredit: string | null = null;

  const current = (): WalletOperationView => {
    const view = manager.operation("op");
    if (view === undefined) throw new Error("operation missing");
    return view;
  };
  const fail = (why: string): never => {
    throw new Error(`${why}\n${trace.slice(-50).join("\n")}`);
  };
  const ready = (): boolean =>
    kind === "APPROVE_ERC20"
      ? approvals.collateralReadiness(ACCOUNT, PUSD, [CTF_EXCHANGE]).ready
      : kind === "APPROVE_ERC1155"
        ? approvals.conditionalSellReadiness(ACCOUNT, YES, [CTF_EXCHANGE]).ready
        : false;

  const planned = manager.plan(plan(kind));
  if (!planned.ok) fail(`plan refused: ${planned.refusal.code}`);
  const reservationIds = current().reservationIds;
  const released = (): boolean => reservationIds.every((id) => book.reservation(id)?.status !== "ACTIVE");
  const spendable = (): boolean => TOUCHED[kind].every((asset) => (book.line(ACCOUNT, asset)?.blocked ?? null) === null);
  const actual = (asset: string): string => book.line(ACCOUNT, asset)?.actual ?? "0";

  const submitting = manager.submit("op");
  let executorPending = mode === "pending";
  if (!executorPending) await submitting;

  /** The set was empty when the first claim was weighed under reconciliation (WP300-R8-02 coverage). */
  let everyKeyFromEmpty = false;

  function recordClaim(
    source: Claim["source"],
    claimKind: ClaimKind,
    hash: string | null,
    id: string | null,
    before: WalletOperationView,
    stateBefore: string = before.state,
    executorChoice: string | null = null,
  ): void {
    const fresh = [
      ...(hash !== null && !before.transactionHashes.includes(hash) ? [`hash:${hash}`] : []),
      ...(id !== null && !before.transactionIds.includes(id) ? [`id:${id}`] : []),
    ];
    const conflicting =
      (hash !== null && before.transactionHashes.length > 0 && !before.transactionHashes.includes(hash)) ||
      (id !== null && before.transactionIds.length > 0 && !before.transactionIds.includes(id));
    if (fresh.length > 0 && oracle.everyKeyFrom !== null && t > oracle.everyKeyFrom && everyKeyFromEmpty) {
      coverage.namedAfterEmptyWeighing += 1;
    }
    oracle.claims.push({ t, source, kind: claimKind, named: keysOf(hash, id), fresh, conflicting, stateBefore });
    // WP300-R8-02: the first claim weighed under reconciliation (anything but a stale lifecycle
    // report; from the executor, a late contradiction — a THROW carries no new fact).
    const staleReport = (claimKind === "SUBMITTED" || claimKind === "MINED") && fresh.length === 0;
    const weighed =
      source === "observation"
        ? !staleReport
        : executorChoice === "NOT_SENT" || executorChoice === "???" || (executorChoice === "SUBMITTED" && conflicting);
    if (source === "executor" && (stateBefore === "UNKNOWN" || stateBefore === "RECONCILING") && weighed) {
      coverage.lateContradictionsWeighed += 1;
    }
    if ((stateBefore === "UNKNOWN" || stateBefore === "RECONCILING") && weighed && oracle.everyKeyFrom === null) {
      oracle.everyKeyFrom = t;
      everyKeyFromEmpty = before.transactionHashes.length === 0 && before.transactionIds.length === 0;
    }
    if (claimKind === "FAILED" || claimKind === "UNRECOGNISED" || (source === "executor" && claimKind === "NOT_SENT")) {
      oracle.doubts.push(t);
    }
    if (id !== null && fresh.includes(`id:${id}`) && !IN_FLIGHT.has(before.state)) coverage.relayerIdsLearnedOutsideFlight += 1;
  }

  function observe(statusChoice: string, hash: string | null, id: string | null, credited: string | null): void {
    const before = current();
    const raw: Record<string, unknown> = { status: statusChoice };
    if (statusChoice === "SUBMITTED" || statusChoice === "CONFIRMED" || statusChoice === "FAILED") {
      raw["transactionHash"] = hash;
      raw["transactionId"] = id;
    } else {
      if (hash !== null) raw["transactionHash"] = hash;
      if (id !== null) raw["transactionId"] = id;
    }
    if (credited !== null) raw["credited"] = credited;
    const claimKind = classify(raw);
    recordClaim("observation", claimKind, hash, id, before);
    trace.push(`t${String(t)} [${before.state}] observe ${JSON.stringify(raw)} (${claimKind})`);
    manager.observe("op", raw);
    const after = current();
    for (const value of [hash, id]) {
      if (value !== null && !after.transactionHashes.includes(value) && !after.transactionIds.includes(value)) {
        fail(`identifier ${value} named by an observation is not in the identity set`);
      }
    }
  }

  /** The latest request the reconciler received, if any. */
  const latestRequestId = (): string | null => reconciler.requests.at(-1)?.requestId ?? null;

  /** The reconciler reads now, for `requestId`, what it will answer (WP300-R7-X3). */
  function read(state: string, hash: string | null, id: string | null, source: string, requestId: string | null): PendingAnswer {
    return { readAt: t, requestId, state, hash, id, source };
  }

  /** Deliver an answer. Accepted: stamped at its READ time. Refused: a claim at delivery (WP300-R7-X1). */
  function deliver(pending: PendingAnswer): boolean {
    const { state, hash, id, source, requestId, readAt } = pending;
    const before = current();
    const evidence: Record<string, unknown> = { source, state, transactionHash: hash, transactionId: id };
    if (requestId !== null) evidence["requestId"] = requestId;
    const result = manager.resolveByReconciliation("op", evidence);
    const olderRequest = requestId !== null && requestId !== latestRequestId();
    const foreign = requestId === FOREIGN_REQUEST;
    trace.push(
      `t${String(t)} [${before.state}${before.quarantined ? ",Q" : ""} U=${before.unresolvedTransactions.join("|")}] answer ${source === "AUTHORITATIVE_READ" ? "" : `${source} `}${state}(${String(hash)},${String(id)}) read t${String(readAt)} for ${requestId === null ? "no request" : foreign ? "a foreign request" : `${olderRequest ? "an older " : "the latest "}request`} → ${result.ok ? "ok" : result.refusal.code}`,
    );
    if (foreign) {
      coverage.unknownRequestAnswers += 1;
      if (before.state === "SUBMITTED" || before.state === "MINED") coverage.unknownRequestInFlight += 1;
    }
    if (readAt < t) coverage.delayedDeliveries += 1;
    const named = keysOf(hash, id);
    if (result.ok) {
      oracle.answers.push({ t: readAt, named });
      if (state === "CONFIRMED") oracle.validations.push(readAt);
      if (state === "CONFIRMED" || state === "FAILED") for (const key of named) oracle.lastAccepted.set(key, state);
      if (hash !== null && id !== null) coverage.multiIdentifierAnswers += 1;
      if (olderRequest) coverage.acceptedForOlderRequest += 1;
      if (requestId === null) coverage.unboundAccepted += 1;
      const after = current();
      for (const value of [hash, id]) {
        if (value !== null && !after.transactionHashes.includes(value) && !after.transactionIds.includes(value)) {
          fail(`identifier ${value} named by an accepted answer is not in the identity set`);
        }
      }
      return true;
    }
    const code = result.refusal.code;
    if (code === "WALLET_OP_EVIDENCE_CONFLICT") coverage.refusedConflict += 1;
    else if (code === "WALLET_OP_EVIDENCE_SUPERSEDED") coverage.supersededRefusals += 1;
    else if (code === "WALLET_OP_ILLEGAL_TRANSITION" && (before.state === "CONFIRMED" || before.state === "FAILED")) {
      coverage.refusedAfterConclusion += 1;
    }
    if (requestId === null) coverage.unboundRefused += 1;
    // A refused answer is weighed like an observation, so the oracle counts it as a
    // claim — unless it repeats, for every identifier it names, the latest accepted
    // outcome for an identifier that is still resolved (no new fact).
    const repeat =
      source === "AUTHORITATIVE_READ" &&
      (state === "FAILED" || (state === "CONFIRMED" && hash !== null)) &&
      named.length > 0 &&
      named.every(
        (key) =>
          oracle.lastAccepted.get(key) === state &&
          !before.unresolvedTransactions.includes(key) &&
          (before.transactionHashes.some((h) => `hash:${h}` === key) || before.transactionIds.some((i) => `id:${i}` === key)),
      );
    if (repeat) {
      coverage.repeatsWithoutNewFact += 1;
      return false;
    }
    coverage.refusedAnswersAsClaims += 1;
    if (IN_FLIGHT.has(before.state)) coverage.refusedAnswersInFlight += 1;
    // WP300-R8-01: a superseded answer delivered in flight sends the operation back to
    // reconciliation and is weighed there — a claim made out of flight.
    const supersededInFlight = code === "WALLET_OP_EVIDENCE_SUPERSEDED" && (before.state === "SUBMITTED" || before.state === "MINED");
    if (supersededInFlight) {
      coverage.supersededInFlight += 1;
      const known = [...before.transactionHashes.map((h) => `hash:${h}`), ...before.transactionIds.map((i) => `id:${i}`)];
      if (named.some((key) => !known.includes(key))) coverage.supersededInFlightNamingNew += 1;
    }
    recordClaim(
      "observation",
      classify({ status: state, transactionHash: hash, transactionId: id }),
      hash,
      id,
      before,
      supersededInFlight ? "UNKNOWN" : before.state,
    );
    const after = current();
    for (const value of [hash, id]) {
      if (value !== null && !after.transactionHashes.includes(value) && !after.transactionIds.includes(value)) {
        fail(`identifier ${value} named by a refused answer is not in the identity set`);
      }
    }
    return false;
  }

  /** Read and deliver at once, for the latest request. */
  function answer(state: string, hash: string | null, id: string | null, source = "AUTHORITATIVE_READ"): boolean {
    return deliver(read(state, hash, id, source, latestRequestId()));
  }

  async function executorAnswers(choice: "SUBMITTED" | "NOT_SENT" | "???" | "THROW", hash: string | null, id: string | null): Promise<void> {
    const before = current();
    const claimKind: ClaimKind =
      choice === "SUBMITTED" ? (hash !== null || id !== null ? "SUBMITTED" : "UNRECOGNISED") : choice === "NOT_SENT" ? "NOT_SENT" : "UNRECOGNISED";
    recordClaim("executor", claimKind, choice === "SUBMITTED" ? hash : null, choice === "SUBMITTED" ? id : null, before, before.state, choice);
    trace.push(`t${String(t)} [${before.state}] executor ${choice}(${String(hash)},${String(id)})`);
    if (before.state !== "PLANNED") coverage.lateExecutorAnswers += 1;
    if (choice === "THROW") rejectExecutor(new Error("socket closed"));
    else if (choice === "SUBMITTED") resolveExecutor({ status: "SUBMITTED", transactionHash: hash, transactionId: id });
    else resolveExecutor({ status: choice });
    executorPending = false;
    await submitting;
  }

  /** P1-P3 and the identity-set invariants after a step. */
  function check(before: WalletOperationView, releasedBefore: boolean, viaAnswer: boolean): void {
    const after = current();
    if (!viaAnswer && IN_FLIGHT.has(before.state) && after.state === "CONFIRMED") oracle.validations.push(t);
    // The identity set only grows.
    if (before.transactionHashes.some((h, i) => after.transactionHashes[i] !== h)) fail("the hash set shrank or reordered");
    if (before.transactionIds.some((h, i) => after.transactionIds[i] !== h)) fail("the relayer-id set shrank or reordered");
    if (after.reopenedTransactions.length > before.reopenedTransactions.length) coverage.setAside += 1;
    const invariants = book.checkInvariants();
    if (invariants.length > 0) fail(`book invariants: ${JSON.stringify(invariants)}`);
    if (!isApproval) {
      const nowReleased = released();
      if (releasedBefore && !nowReleased) fail("a released reservation is held again");
      // P1 at the release itself.
      if (nowReleased && !releasedBefore) {
        const failed = after.state === "FAILED";
        const unmet = oracle.unmet({ fresh: true, success: failed, failureAfterConfirm: false });
        if (unmet.length > 0) fail(`P1: released (${after.state}) with unmet obligations: ${unmet.join("; ")}`);
        if (failed && oracle.claims.some((c) => !IN_FLIGHT.has(c.stateBefore))) coverage.failedReleasesAfterClaims += 1;
        if (!failed) coverage.confirmedReleases += 1;
      }
      // P1 whenever the lines are spendable.
      if (nowReleased && spendable()) {
        const unmet = oracle.unmet({ fresh: true, success: true, failureAfterConfirm: true });
        if (unmet.length > 0) fail(`P1: lines spendable (${after.state}) with unmet obligations: ${unmet.join("; ")}`);
      }
      if (after.quarantined) coverage.quarantinedValue += 1;
      // P3: exact conservation.
      const reserved = book.line(ACCOUNT, kind === "SPLIT" ? PUSD : USDC_E)?.reserved ?? "0";
      if (reserved !== (nowReleased ? "0" : "10")) fail(`P3: reserved ${reserved} with the reservation ${nowReleased ? "released" : "held"}`);
      if (kind === "SPLIT") {
        const expected = after.effectsApplied ? ["90", "10", "10"] : ["100", "0", "0"];
        const seen = [actual(PUSD), actual(YES), actual(NO)];
        if (seen.join() !== expected.join()) fail(`P3: SPLIT balances ${seen.join()} (effects applied: ${String(after.effectsApplied)})`);
      } else {
        if (after.effectsApplied && wrapCredit === null) wrapCredit = actual(PUSD);
        const expectedUsdcE = after.effectsApplied ? "40" : "50";
        const expectedPusd = after.effectsApplied ? wrapCredit : "100";
        if (actual(USDC_E) !== expectedUsdcE || actual(PUSD) !== expectedPusd) {
          fail(`P3: WRAP balances USDC.e ${actual(USDC_E)} pUSD ${actual(PUSD)} (effects applied: ${String(after.effectsApplied)})`);
        }
        if (!["100", "110", "112"].includes(actual(PUSD))) fail(`P3: pUSD ${actual(PUSD)} is not 100 plus an observed credit`);
      }
    } else {
      if (actual(PUSD) !== "100" || (book.line(ACCOUNT, PUSD)?.reserved ?? "0") !== "0") fail("P3: an approval moved a balance");
      const isReady = ready();
      if (after.quarantined) coverage.quarantinedApproval += 1;
      if (isReady) {
        if (after.quarantined) fail("P2: ready while the approval's operation is quarantined");
        const violation = oracle.readinessViolation();
        if (violation !== null) fail(`P2: ready, but ${violation}`);
        if (!wasReady) coverage.readyRuns += 1;
      } else if (wasReady) {
        coverage.readinessWithdrawn += 1;
      }
      wasReady = isReady;
    }
  }

  /** One step. `action` returns true when an answer was ACCEPTED (its validation is stamped at read time). */
  async function step(action: () => unknown): Promise<void> {
    t += 1;
    const before = current();
    const releasedBefore = isApproval ? false : released();
    const accepted = (await action()) === true;
    check(before, releasedBefore, accepted);
  }

  function sync(): void {
    if (kind === "APPROVE_ERC20") approvals.recordClobAllowanceSync({ accountRef: ACCOUNT, assetType: "COLLATERAL" });
    else approvals.recordClobAllowanceSync({ accountRef: ACCOUNT, assetType: "CONDITIONAL", tokenAssetId: YES });
    oracle.syncs.push(t);
    trace.push(`t${String(t)} CLOB allowance sync`);
  }

  // Seeded warm-ups (then random noise): reach the situations the findings were about.
  const otherHash = HASHES.find((hash) => hash !== firstHash) ?? firstHash;
  const otherId = pick(random, IDS.filter((id) => id !== firstId));
  const warmUp = pick(random, ["none", "confirmed", "per-key", "per-key", "re-entry", "empty-weighing", "late-contradiction"] as const);
  if (warmUp === "empty-weighing" || warmUp === "late-contradiction") {
    // WP300-R8-02: evidence weighed under reconciliation ends simple mode, even while
    // nothing is named, and a late contradiction from the executor ends it too.
    if (executorPending) {
      const id = firstId ?? otherId;
      if (warmUp === "empty-weighing") {
        await step(() => observe("DROPPED", null, null, null));
        await step(() => observe(pick(random, ["FAILED", "UNKNOWN", "DROPPED"]), null, null, null));
        await step(async () => void (await executorAnswers("SUBMITTED", firstHash, id)));
      } else {
        await step(() => observe("DROPPED", firstHash, id, null));
        await step(async () => void (await executorAnswers(pick(random, ["NOT_SENT", "???"] as const), null, null)));
      }
      // One identifier answered by name, for the latest request.
      await step(() => (random() < 0.5 ? answer("FAILED", null, id) : answer("FAILED", firstHash, null)));
    }
  } else if (warmUp !== "none") {
    if (executorPending) await step(async () => void (await executorAnswers("SUBMITTED", firstHash, firstId)));
    if (current().state === "SUBMITTED" && warmUp === "re-entry") {
      // WP300-R8-01: a read made for the first request is still in transit when the
      // operation, back in flight after a re-entry, receives it (or the loop does later).
      await step(() => observe("DROPPED", firstHash, null, null));
      const first = latestRequestId();
      if (current().state === "RECONCILING" && first !== null) {
        const outcome = random() < 0.5 ? "CONFIRMED" : "FAILED";
        const hash = outcome === "CONFIRMED" ? pick(random, [firstHash, otherHash]) : pick(random, [firstHash, otherHash, null]);
        // Biased toward a relayer id the set has not seen (with no relayer id yet, it is not a conflict).
        const id = pick(random, [otherId, otherId, firstId, null]);
        await step(() => {
          pendingAnswers.push(read(outcome, hash, id, "AUTHORITATIVE_READ", first));
          trace.push(`t${String(t)} reconciler reads ${outcome}(${String(hash)},${String(id)}) for the first request`);
        });
        await step(() => answer("MINED", firstHash, firstId));
        await step(() => observe("UNKNOWN", null, null, null));
        await step(() => answer("MINED", firstHash, firstId));
        const view = current();
        const roll = random();
        if ((view.state === "SUBMITTED" || view.state === "MINED") && roll < 0.5) {
          const stale = pendingAnswers.pop() as PendingAnswer;
          await step(() => deliver(stale));
          // Then, usually, a current answer for the first identifier only.
          if (current().state === "RECONCILING" && random() < 0.7) await step(() => answer("FAILED", firstHash, null));
        } else if (view.state === "SUBMITTED" || view.state === "MINED") {
          // Or an answer naming a request never issued for this operation arrives in flight.
          const foreignOutcome = roll < 0.75 ? "CONFIRMED" : "FAILED";
          const foreignHash = foreignOutcome === "CONFIRMED" ? pick(random, [firstHash, otherHash]) : pick(random, [firstHash, otherHash, null]);
          const foreignId = pick(random, [firstId, otherId, null]);
          await step(() => deliver(read(foreignOutcome, foreignHash, foreignId, "AUTHORITATIVE_READ", FOREIGN_REQUEST)));
        }
      }
    } else if (current().state === "SUBMITTED" && warmUp === "confirmed") {
      await step(() => observe("CONFIRMED", firstHash, firstId, kind === "WRAP_COLLATERAL" ? "10" : null));
    } else if (current().state === "SUBMITTED") {
      // The verifier's setup: another transaction is named, so every identifier is resolved by name.
      await step(() => observe("MINED", otherHash, random() < 0.5 ? otherId : null, null));
      const first = random() < 0.5 ? "CONFIRMED" : "FAILED";
      await step(() => answer(first, firstHash, random() < 0.5 ? firstId : null));
    } else if (current().state === "RECONCILING" && warmUp === "confirmed") {
      await step(() => answer("CONFIRMED", firstHash, firstId));
    }
    if (isApproval) await step(sync);
  }

  /** What a read says, chosen from the operation as it is at read time. */
  function choose(): { state: string; hash: string | null; id: string | null; source: string } {
    const view = current();
    const state = pick(random, ["SUBMITTED", "MINED", "CONFIRMED", "CONFIRMED", "FAILED", "FAILED", "FAILED", "NOT_FOUND"]);
    let hash: string | null;
    let id: string | null;
    if (view.unresolvedTransactions.length > 0 && random() < 0.6) {
      // Answer unresolved identifiers by name: one, or two at once.
      const named = [pick(random, view.unresolvedTransactions), ...(random() < 0.4 ? [pick(random, view.unresolvedTransactions)] : [])];
      hash = named.find((key) => key.startsWith("hash:"))?.slice(5) ?? null;
      id = named.find((key) => key.startsWith("id:"))?.slice(3) ?? null;
    } else {
      hash = chooseValue(random, view.transactionHashes, HASHES);
      id = chooseValue(random, view.transactionIds, IDS);
    }
    return { state, hash, id, source: random() < 0.94 ? "AUTHORITATIVE_READ" : "HEARSAY" };
  }

  /** The request a read is made for: usually the latest delivered one, sometimes an older one, sometimes none named. */
  function requestFor(): string | null {
    const roll = random();
    if (roll < 0.035) return FOREIGN_REQUEST; // WP300-R8-01: a request not issued for this operation
    if (roll < 0.1 || reconciler.requests.length === 0) return null;
    if (roll < 0.25) return pick(random, reconciler.requests).requestId;
    return latestRequestId();
  }

  const steps = 12 + Math.floor(random() * 28);
  for (let i = 0; i < steps; i += 1) {
    const view = current();
    const roll = random();
    if (executorPending && roll < 0.14) {
      const choice = pick(random, ["SUBMITTED", "SUBMITTED", "SUBMITTED", "NOT_SENT", "???", "THROW"] as const);
      let hash = chooseValue(random, view.transactionHashes, HASHES);
      const id = chooseValue(random, view.transactionIds, IDS);
      if (choice === "SUBMITTED" && hash === null && id === null) hash = firstHash;
      await step(async () => void (await executorAnswers(choice, hash, id)));
    } else if (roll < 0.5) {
      const status = pick(random, ["SUBMITTED", "MINED", "MINED", "CONFIRMED", "CONFIRMED", "FAILED", "FAILED", "UNKNOWN", "DROPPED"]);
      const hash = chooseValue(random, view.transactionHashes, HASHES);
      const id = chooseValue(random, view.transactionIds, IDS);
      const credited = status === "CONFIRMED" && kind === "WRAP_COLLATERAL" ? pick(random, ["10", "10", "12"]) : null;
      await step(() => observe(status, hash, id, credited));
    } else if (roll < 0.66) {
      // Read and delivered at once.
      const { state, hash, id, source } = choose();
      const requestId = requestFor();
      await step(() => deliver(read(state, hash, id, source, requestId)));
    } else if (roll < 0.76 && reconciler.requests.length > 0) {
      // A read, delivered later (WP300-R7-X3).
      const { state, hash, id, source } = choose();
      const requestId = requestFor();
      await step(() => {
        pendingAnswers.push(read(state, hash, id, source, requestId));
        trace.push(`t${String(t)} reconciler reads ${state}(${String(hash)},${String(id)}) for ${requestId === null ? "no request" : "a request"}`);
      });
    } else if (roll < 0.86 && pendingAnswers.length > 0) {
      // A delivery, in any order.
      const index = Math.floor(random() * pendingAnswers.length);
      const [pending] = pendingAnswers.splice(index, 1);
      if (pending === undefined) fail("no pending answer");
      await step(() => deliver(pending as PendingAnswer));
    } else if (roll < 0.95 && isApproval) {
      await step(sync);
    } else {
      await step(() => {
        reconciler.failing = random() < 0.35;
        const delivered = manager.retryReconciliationRequests();
        if (manager.outstandingReconciliationRequests().length > 0) coverage.queuedRequests += 1;
        trace.push(`t${String(t)} reconciler ${reconciler.failing ? "down" : "up"}; retry delivered ${String(delivered)}`);
      });
    }
  }

  // Liveness: every read still in transit is delivered; then every unresolved
  // identifier is answered FAILED by name, for the latest request; the
  // operation concludes and no quarantine remains.
  if (executorPending) await step(async () => void (await executorAnswers("SUBMITTED", current().transactionHash ?? firstHash, null)));
  reconciler.failing = false;
  while (pendingAnswers.length > 0) {
    const pending = pendingAnswers.shift() as PendingAnswer;
    await step(() => deliver(pending));
  }
  for (let i = 0; i < 24; i += 1) {
    const view = current();
    if (view.state === "SUBMITTED" || view.state === "MINED") {
      await step(() => observe("FAILED", view.transactionHash, null, null));
      continue;
    }
    if (manager.outstandingReconciliationRequests().length > 0) {
      await step(() => void manager.retryReconciliationRequests());
      continue;
    }
    const open = view.unresolvedTransactions[0];
    if (view.state === "RECONCILING" || view.quarantined) {
      let hash: string | null = null;
      let id: string | null = null;
      if (open !== undefined) {
        if (open.startsWith("hash:")) hash = open.slice(5);
        else if (open.startsWith("id:")) id = open.slice(3);
      } else {
        hash = view.transactionHash;
        id = hash === null ? view.transactionId : null;
      }
      let accepted = false;
      await step(() => {
        accepted = answer("FAILED", hash, id);
        return accepted;
      });
      if (!accepted) fail(`liveness: the answer FAILED(${String(hash)},${String(id)}) for an unresolved identifier was refused`);
      continue;
    }
    break;
  }
  const final = current();
  if (final.state !== "CONFIRMED" && final.state !== "FAILED") fail(`liveness: the operation did not conclude (${final.state})`);
  if (final.quarantined || final.unresolvedTransactions.length > 0) fail("liveness: a quarantine remains after every identifier was answered");
}

describe("WP300-R6 class property: evidence about any identifier is weighed against the whole identity set", () => {
  const SEEDS_PER_KIND = 300;
  const coverage = newCoverage();

  for (const kind of ["SPLIT", "WRAP_COLLATERAL", "APPROVE_ERC20", "APPROVE_ERC1155"] as const) {
    it(`${kind}: ${String(SEEDS_PER_KIND)} seeded interleavings keep P1-P3 and liveness`, async () => {
      for (let seed = 1; seed <= SEEDS_PER_KIND; seed += 1) {
        await run(seed * 7919 + kind.length, kind, coverage);
      }
    });
  }

  it("is not vacuous: the generator reaches every situation the properties are about", () => {
    // Runs after the four property runs above (vitest runs a file's tests in order).
    for (const [situation, count] of Object.entries(coverage)) {
      expect(count, situation).toBeGreaterThan(0);
    }
  });
});
