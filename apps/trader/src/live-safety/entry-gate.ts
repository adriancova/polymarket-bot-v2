/**
 * The live gate (WP-320): may this process start a new live entry, or a
 * reduction, NOW? Every input is read at the moment of asking; nothing is
 * cached. Every reason that applies is reported, kill switches first ("Kill
 * switches outrank everything", ADR-008 §8).
 *
 * | Reason | NEW_ENTRY | REDUCTION |
 * | --- | --- | --- |
 * | kill-switch state unknown (never read, the latest read failed) | blocked | blocked |
 * | a GLOBAL / own-ACCOUNT switch | blocked | blocked if it ends trading (`kill-switch.ts`) |
 * | a MARKET / STRATEGY_INSTANCE switch on the request's market or instance | blocked | blocked if it ends trading there |
 * | the fence not held (`fencing-authority.ts`) | blocked | blocked |
 * | the health lease failed (`health-lease.ts`) | blocked | blocked |
 * | an explicit heartbeat stop (§9.9 "Stop heartbeat", `ops-cli stop-heartbeat`, a fencing conflict) | blocked | blocked |
 * | the heartbeat lapsed, or the D6 recovery has not lifted the block | blocked | — |
 * | venue eligibility not established (`eligibility.ts`) | blocked | — |
 * | a reconciliation halt routed from WP-290's coordinator (account, or the request's market) | blocked | — |
 *
 * The SAME question is asked twice for every order: at decision time, by the
 * composition, and again at the final placement boundary — before every
 * signing and before EVERY transmission, batch members one by one — by
 * `fenced-venue.ts`, with the order's market, instance and intent carried
 * from its decision (r1, finding I2). There is no unscoped "transmission"
 * question any more: it could not see a MARKET or STRATEGY_INSTANCE switch,
 * nor an entry-only GLOBAL/ACCOUNT one, so an order approved before such a
 * switch was observed was still sent after it, and rested under it.
 * Reductions are left to the OMS during a lapse: the coordinator pauses all
 * new submissions while it reconciles (D6 step 2).
 *
 * A MARKET or STRATEGY_INSTANCE switch's reference and the request's market
 * and instance are compared in one canonical form (`scopeIdKey`,
 * `kill-switch.ts`; r4, finding R4-L1): a switch engaged under another
 * spelling of an id (upper case, say) blocks that id's orders.
 */

import type { EligibilityVerdict } from "./eligibility.js";
import type { FenceCheck } from "./fencing-authority.js";
import type { HealthVerdict } from "./health-lease.js";
import { scopeIdKey, type KillSwitchSnapshot } from "./kill-switch.js";

export type GateRequest =
  | { readonly kind: "NEW_ENTRY"; readonly marketId: string; readonly instanceId: string }
  | { readonly kind: "REDUCTION"; readonly marketId: string; readonly instanceId: string };

export interface GateDecision {
  readonly permitted: boolean;
  readonly reasons: readonly string[];
}

/** What the gate reads, each at the moment of asking. */
export interface GateInputs {
  killSwitch(): KillSwitchSnapshot;
  fence(): FenceCheck;
  health(): HealthVerdict;
  /** The sources of every explicit heartbeat stop in force. */
  explicitStops(): readonly string[];
  heartbeatLapsed(): boolean;
  recoveryBlocksEntries(): boolean;
  eligibility(): EligibilityVerdict;
  reconciliationHalts(): { readonly account: boolean; readonly markets: ReadonlySet<string> };
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

/** Evaluate the gate. Never throws: an input that throws blocks, and names itself. */
export function evaluateLiveGate(inputs: GateInputs, request: GateRequest): GateDecision {
  const reasons: string[] = [];
  const read = <T>(name: string, reader: () => T): T | undefined => {
    try {
      return reader();
    } catch {
      reasons.push(`${name}_UNREADABLE`);
      return undefined;
    }
  };
  if (typeof request !== "object" || request === null) return Object.freeze({ permitted: false, reasons: Object.freeze(["REQUEST_UNREADABLE"]) });
  const kind: unknown = request.kind;
  if (kind !== "NEW_ENTRY" && kind !== "REDUCTION") return Object.freeze({ permitted: false, reasons: Object.freeze(["REQUEST_UNREADABLE"]) });
  const marketId: unknown = request.marketId;
  const instanceId: unknown = request.instanceId;
  if (!isIdentifier(marketId) || !isIdentifier(instanceId)) {
    return Object.freeze({ permitted: false, reasons: Object.freeze(["REQUEST_UNREADABLE"]) });
  }

  // 1. Kill switches outrank everything.
  const snapshot = read("KILL_SWITCH", () => inputs.killSwitch());
  if (snapshot !== undefined) {
    if (!snapshot.known) {
      reasons.push(`KILL_SWITCH_UNKNOWN_${snapshot.reason}`);
    } else {
      const effects = snapshot.effects;
      // r4 R4-L1: the switches' sets hold each id in its matching form (`kill-switch.ts`); the request's is read alike.
      const marketKey = scopeIdKey(marketId);
      const instanceKey = scopeIdKey(instanceId);
      if (kind === "NEW_ENTRY") {
        if (effects.blocksAllEntries) reasons.push("KILL_SWITCH_ACCOUNT_ENGAGED");
        if (effects.entryBlockedMarkets.has(marketKey)) reasons.push("KILL_SWITCH_MARKET_ENGAGED");
        if (effects.entryBlockedInstances.has(instanceKey)) reasons.push("KILL_SWITCH_INSTANCE_ENGAGED");
      } else {
        if (effects.blocksAllSubmissions) reasons.push("KILL_SWITCH_ACCOUNT_ENDS_TRADING");
        if (effects.submissionBlockedMarkets.has(marketKey)) reasons.push("KILL_SWITCH_MARKET_ENDS_TRADING");
        if (effects.submissionBlockedInstances.has(instanceKey)) reasons.push("KILL_SWITCH_INSTANCE_ENDS_TRADING");
      }
    }
  }

  // 2. The fence, the health lease and the explicit stops: nothing goes to the venue without them.
  const fence = read("FENCE", () => inputs.fence());
  if (fence !== undefined && !fence.held) reasons.push(`FENCE_${fence.reason}`);
  const health = read("HEALTH", () => inputs.health());
  if (health !== undefined && !health.healthy) reasons.push("HEALTH_LEASE_FAILED", ...health.reasons);
  const stops = read("STOPS", () => inputs.explicitStops());
  if (stops !== undefined) for (const source of stops) reasons.push(`STOPPED_${source}`);

  // 3. New entries only: the heartbeat (D6), venue eligibility (§6 invariant 18), reconciliation halts.
  if (kind === "NEW_ENTRY") {
    const lapsed = read("HEARTBEAT", () => inputs.heartbeatLapsed());
    if (lapsed !== false) reasons.push("HEARTBEAT_LAPSED");
    const latched = read("RECOVERY", () => inputs.recoveryBlocksEntries());
    if (latched !== false) reasons.push("HEARTBEAT_RECOVERY_PENDING");
    const eligibility = read("ELIGIBILITY", () => inputs.eligibility());
    if (eligibility !== undefined && !eligibility.newEntriesPermitted) reasons.push(...eligibility.reasons);
    const halts = read("HALTS", () => inputs.reconciliationHalts());
    if (halts !== undefined) {
      if (halts.account) reasons.push("RECONCILIATION_ACCOUNT_HALT");
      if (halts.markets.has(marketId)) reasons.push("RECONCILIATION_MARKET_HALT");
    }
  }

  return Object.freeze({ permitted: reasons.length === 0, reasons: Object.freeze(reasons) });
}
