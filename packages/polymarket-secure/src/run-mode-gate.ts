/**
 * The run-mode gate of the signer boundary (ADR-010 §2–§3; handoff §0.2, §6
 * invariant 17, §11).
 *
 * "A real key cannot be loaded by a paper or backtest process." This gate is
 * the first thing every secure-client factory in this package runs, BEFORE it
 * looks at the signer handle and before any SDK code executes. It is
 * fail-closed: anything it cannot read, or does not recognise, refuses.
 *
 * It PERMITS only when all of these hold at once:
 *
 * - `runMode` is a §11 run mode that requires a live signer
 *   (`RUN_MODE_REQUIRES_LIVE_SIGNER`: EXECUTION_PROBE, LIVE_MICRO, LIVE).
 *   BACKTEST, PAPER and SHADOW refuse; so does anything that is not a §11
 *   mode at all, such as `REPLAY` or `paper`.
 * - `maximumRunMode` is a §11 run mode and `runMode` does not exceed it.
 * - `allowRealOrders` is the boolean `true` (not the string `"true"`).
 *
 * Under the repository's defaults (`MAX_RUN_MODE=PAPER`,
 * `ALLOW_REAL_ORDERS=false`, ADR-010 §1) no combination passes, so no process
 * built from this repository today can construct a secure venue client.
 *
 * TRUST BOUNDARY, stated plainly. The context is supplied by the process's
 * composition root, which owns configuration (as `packages/domain`'s
 * `assertRunModeWithinMaximum` is supplied its maximum). This gate cannot
 * detect a composition root that lies about its own mode; the startup
 * validator of that process is what makes the context true. What this gate
 * does guarantee is that no PAPER/BACKTEST/REPLAY value, no missing or
 * malformed value, and no getter trick reaches a signer.
 *
 * THIS MODULE READS NO ENVIRONMENT. {@link signerGateContextFromSafetyFlags}
 * reads the record it is GIVEN (as `packages/trading-core`'s safety module
 * does), and reads only the three run-mode flags: never a key or credential.
 */

import {
  RUN_MODES,
  RUN_MODE_REQUIRES_LIVE_SIGNER,
  runModeExceeds,
  type RunMode,
} from "@polymarket-bot/domain";

import { SignerBoundaryRefusal, type SignerRefusalReason } from "./errors.js";

/** A context the gate has permitted. */
export interface SignerGateContext {
  readonly runMode: RunMode;
  readonly maximumRunMode: RunMode;
  readonly allowRealOrders: true;
}

export type SignerGateVerdict =
  | { readonly permitted: true; readonly context: SignerGateContext }
  | { readonly permitted: false; readonly reasons: readonly SignerRefusalReason[] };

const CONTEXT_KEYS = ["allowRealOrders", "maximumRunMode", "runMode"] as const;

function isRunMode(value: unknown): value is RunMode {
  return typeof value === "string" && (RUN_MODES as readonly string[]).includes(value);
}

/**
 * Read the context as exactly three own data properties of a plain object.
 * A getter, a proxy trap result that is not a data descriptor, an inherited
 * field, an extra field or a non-plain prototype makes it unreadable.
 */
function readContext(input: unknown): Readonly<Record<(typeof CONTEXT_KEYS)[number], unknown>> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== CONTEXT_KEYS.length) return undefined;
  const values: Record<string, unknown> = {};
  for (const key of CONTEXT_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (descriptor === undefined || !("value" in descriptor)) return undefined;
    values[key] = descriptor.value;
  }
  return values as Readonly<Record<(typeof CONTEXT_KEYS)[number], unknown>>;
}

/** Evaluate the gate without throwing. Collects every reason that applies. */
export function evaluateSignerGate(input: unknown): SignerGateVerdict {
  const context = readContext(input);
  if (context === undefined) {
    return { permitted: false, reasons: Object.freeze(["CONTEXT_UNREADABLE"] as const) };
  }
  const reasons: SignerRefusalReason[] = [];
  const { runMode, maximumRunMode, allowRealOrders } = context;

  if (!isRunMode(runMode)) {
    reasons.push("RUN_MODE_UNKNOWN");
  } else if (!RUN_MODE_REQUIRES_LIVE_SIGNER[runMode]) {
    reasons.push("RUN_MODE_REQUIRES_NO_SIGNER");
  }
  if (!isRunMode(maximumRunMode)) {
    reasons.push("MAXIMUM_RUN_MODE_UNKNOWN");
  } else if (isRunMode(runMode) && runModeExceeds(runMode, maximumRunMode)) {
    reasons.push("RUN_MODE_ABOVE_MAXIMUM");
  }
  if (allowRealOrders !== true) {
    reasons.push("REAL_ORDERS_NOT_ALLOWED");
  }

  if (reasons.length > 0 || !isRunMode(runMode) || !isRunMode(maximumRunMode) || allowRealOrders !== true) {
    // The trailing conjuncts are unreachable when `reasons` is empty; they
    // keep the narrowing below honest if a branch above is ever edited.
    return { permitted: false, reasons: Object.freeze(reasons.length > 0 ? reasons : ["CONTEXT_UNREADABLE"]) };
  }
  return {
    permitted: true,
    context: Object.freeze({ runMode, maximumRunMode, allowRealOrders: true as const }),
  };
}

/**
 * Throwing form of {@link evaluateSignerGate}.
 *
 * @throws {SignerBoundaryRefusal} with every applicable reason.
 */
export function assertSignerGate(input: unknown): SignerGateContext {
  const verdict = evaluateSignerGate(input);
  if (!verdict.permitted) throw new SignerBoundaryRefusal(verdict.reasons);
  return verdict.context;
}

/** The repository ceiling when `MAX_RUN_MODE` is absent (ADR-010 §1). */
const DEFAULT_MAXIMUM_RUN_MODE: RunMode = "PAPER";

/**
 * Build a gate input from a flags record, such as the environment record a
 * composition root was started with. Reads ONLY `RUN_MODE`, `MAX_RUN_MODE`
 * and `ALLOW_REAL_ORDERS`:
 *
 * - `RUN_MODE` absent → `undefined`, which the gate refuses
 *   (`RUN_MODE_UNKNOWN`): a process that does not say what it is gets no
 *   signer.
 * - `MAX_RUN_MODE` absent → `PAPER`, the repository default.
 * - `ALLOW_REAL_ORDERS` is `true` only for the exact string `"true"`.
 *
 * The result is still just gate INPUT; pass it to {@link evaluateSignerGate}.
 */
export function signerGateContextFromSafetyFlags(flags: Readonly<Record<string, string | undefined>>): {
  readonly runMode: string | undefined;
  readonly maximumRunMode: string;
  readonly allowRealOrders: boolean;
} {
  const read = (name: string): string | undefined => {
    const descriptor = Object.getOwnPropertyDescriptor(flags, name);
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  };
  return {
    runMode: read("RUN_MODE"),
    maximumRunMode: read("MAX_RUN_MODE") ?? DEFAULT_MAXIMUM_RUN_MODE,
    allowRealOrders: read("ALLOW_REAL_ORDERS") === "true",
  };
}
