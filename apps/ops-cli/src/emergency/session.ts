/**
 * Opening a venue session, after WP-260's signer gate permitted the process:
 * the configuration, the rate-limit budget, the EMERGENCY credential (§15),
 * the scope check, and the venue. Each step that fails stops the command
 * before anything is sent, with its own exit code.
 *
 * Nothing here touches the trader, its process, its memory or its database
 * (§14.2; ADR-008 §6): the session is built from the operator's
 * configuration, the emergency credential and venue truth only.
 */

import type { AccountReadPort } from "@polymarket-bot/oms";
import type { SignerGateContext, VenueAccountIdentity } from "@polymarket-bot/polymarket-secure";

import { withinBound } from "./bounded.js";
import { EmergencyBudget } from "./budget.js";
import { parseOpsConfiguration, type OpsConfiguration } from "./configuration.js";
import type { ExitName } from "./exit-codes.js";
import type { ParsedCommand } from "./grammar.js";
import type { ConfigurationSource, EmergencyCredentialPort, EmergencyVenue, EmergencyVenueFactory, OpsClock } from "./ports.js";
import { budgetedReads, type ReadRecord } from "./venue-truth.js";

export interface VenueSession {
  readonly configuration: OpsConfiguration;
  readonly budget: EmergencyBudget;
  readonly venue: EmergencyVenue;
  /** The venue reads, each granted by the budget first. */
  readonly reads: AccountReadPort;
  readonly readLog: ReadRecord[];
  readonly identity: VenueAccountIdentity;
  close(): Promise<void>;
}

export type SessionOpen =
  | { readonly kind: "OPEN"; readonly session: VenueSession }
  | { readonly kind: "STOPPED"; readonly exit: ExitName; readonly problem: string };

export interface SessionDependencies {
  readonly configuration: ConfigurationSource;
  readonly credentials: EmergencyCredentialPort;
  readonly venues: EmergencyVenueFactory;
  readonly clock: OpsClock;
}

function ownText(source: unknown, key: string): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string" ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

const REASON_CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;

function reasonOf(value: unknown): string {
  return typeof value === "string" && REASON_CODE.test(value) ? value : "UNSPECIFIED";
}

export async function openVenueSession(parsed: ParsedCommand, gate: SignerGateContext, deps: SessionDependencies): Promise<SessionOpen> {
  // 1. The operator's configuration (read only now that the gate permitted the process).
  let document: unknown;
  try {
    const loaded = await deps.configuration.load();
    if (loaded.kind !== "LOADED") return { kind: "STOPPED", exit: "CONFIGURATION_REFUSED", problem: `no ops configuration: ${reasonOf(loaded.reason)}` };
    document = loaded.document;
  } catch {
    return { kind: "STOPPED", exit: "CONFIGURATION_REFUSED", problem: "the ops configuration could not be read" };
  }
  const configuration = parseOpsConfiguration(document);
  if (!configuration.ok) return { kind: "STOPPED", exit: "CONFIGURATION_REFUSED", problem: configuration.problem };
  const created = EmergencyBudget.create(configuration.value.rateLimitSnapshots, deps.clock, configuration.value.maxBudgetWaitMs);
  if (!created.ok) return { kind: "STOPPED", exit: "CONFIGURATION_REFUSED", problem: created.problem };
  const budget = created.value;

  // 2. The emergency credential (§15): the CLI's own port, never the trader's.
  const bound = configuration.value.venueAnswerBoundMs;
  let credential: { readonly accountRef: string };
  try {
    const answered = await withinBound(bound, () => deps.credentials.load({ accountRef: parsed.accountRef, gate }));
    if (answered.kind === "UNANSWERED") return { kind: "STOPPED", exit: "CREDENTIALS_UNAVAILABLE", problem: `the emergency credential source gave no answer within ${String(bound)} ms` };
    const loaded = answered.value;
    if (loaded.kind !== "LOADED") return { kind: "STOPPED", exit: "CREDENTIALS_UNAVAILABLE", problem: `no emergency credential: ${reasonOf(loaded.reason)}` };
    credential = loaded.credential;
  } catch {
    return { kind: "STOPPED", exit: "CREDENTIALS_UNAVAILABLE", problem: "the emergency credential source failed" };
  }

  // 3. The scope the operator named must be the account these credentials act for (E-16).
  const credentialAccount = ownText(credential, "accountRef");
  if (credentialAccount !== parsed.accountRef) {
    return {
      kind: "STOPPED",
      exit: "SCOPE_MISMATCH",
      problem: `the emergency credential acts for ${credentialAccount === undefined ? "an unreadable account" : `account ${credentialAccount}`}, not ${parsed.accountRef}: nothing was sent`,
    };
  }

  // 4. The venue, bound to that credential.
  let venue: EmergencyVenue;
  try {
    const answered = await withinBound(bound, () => deps.venues.open({ gate, credential, onRateLimitUpdate: (observation) => budget.observe(observation) }));
    if (answered.kind === "UNANSWERED") return { kind: "STOPPED", exit: "CREDENTIALS_UNAVAILABLE", problem: `the venue binding gave no answer within ${String(bound)} ms` };
    const opened = answered.value;
    if (opened.kind !== "OPEN") return { kind: "STOPPED", exit: "CREDENTIALS_UNAVAILABLE", problem: `no venue binding: ${reasonOf(opened.reason)}` };
    venue = opened.venue;
  } catch {
    return { kind: "STOPPED", exit: "CREDENTIALS_UNAVAILABLE", problem: "the venue binding failed to open" };
  }
  let identity: VenueAccountIdentity;
  try {
    identity = venue.cancels.identity;
    if (typeof identity.signerAddress !== "string" || typeof identity.walletAddress !== "string") throw new TypeError("identity");
  } catch {
    await venue.cancels.close().catch(() => undefined);
    return { kind: "STOPPED", exit: "CREDENTIALS_UNAVAILABLE", problem: "the venue binding reports no account identity" };
  }
  budget.signer = identity.signerAddress;
  const readLog: ReadRecord[] = [];
  return {
    kind: "OPEN",
    session: {
      configuration: configuration.value,
      budget,
      venue,
      reads: budgetedReads(venue.reads, budget, readLog, bound),
      readLog,
      identity,
      close: async () => {
        await venue.cancels.close().catch(() => undefined);
      },
    },
  };
}
